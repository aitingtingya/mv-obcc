// mv-AIDE bridge plugin for DeepSeek Harness (DSH).
//
// - Registers the `/mv-aide` slash command for status + direct bridge calls.
// - Discovers mv-AIDE's own IDE bridge (lock files under ~/.claude/ide) and
//   registers each IDE tool as a native tool under `mv_aide__<name>`, so the
//   model can use Obsidian context (selection, open editors, links, tags, …).
// - Passively delivers mv-AIDE bridge notifications: `selection_changed` is
//   injected into the agent's inbox as context (no wake-up), and the
//   user-triggered `at_mentioned` steering wakes the agent to act on it.
//
// This is a static Cordis plugin: `name`, `inject`, and `apply` are the only
// exports the loader consumes.

import { BridgeSupervisor } from './bridge-client.js';
import { createDiffHook, isInsideAny, normalizePath } from './diff-hook.js';
import {
  allowedForAgent,
  isDuplicateMention,
  mentionSignature,
  selectionAllowedForOutside,
  selectionChannels,
  selectionSignature,
  shouldDeliverSelection,
} from './passive-state.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';

export const name = 'mv-aide-dsh';
export const inject = ['commands', 'tools'];

const COMMAND_USAGE =
  'Usage: /mv-aide [status|tools|selection|call <name> [json]]';

const PLUGIN_SOURCE = 'mv-aide-dsh';
const MAX_SELECTION_CHARS = 6000;

/** Normalize a bridge tool name to the DSH function-name contract. */
function publicToolName(rawName) {
  const cleaned = String(rawName ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 48);
  return `mv_aide__${cleaned}`;
}

/** Join MCP-style text content blocks into one string. */
function extractText(content) {
  if (!Array.isArray(content)) return '(no output)';
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') {
      parts.push(String(block.text ?? ''));
    } else if (block && typeof block === 'object' && block.type === 'image') {
      parts.push('[image]');
    } else {
      parts.push('[unsupported content]');
    }
  }
  return parts.join('\n');
}

function normalizeArgs(args) {
  return typeof args === 'object' && args !== null ? args : {};
}

export function apply(ctx, config = {}) {
  const fixedWorkspace =
    typeof config?.workspace === 'string' && config.workspace.length > 0
      ? config.workspace
      : undefined;

  let toolDisposers = new Map();
  let generationSeq = 0;

  const log = (message) => {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(message);
    } else {
      console.warn(message);
    }
  };

  function disposeTools() {
    for (const dispose of toolDisposers.values()) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    toolDisposers = new Map();
  }

  function registerTools(tools) {
    disposeTools();
    const disposers = new Map();
    try {
      for (const tool of tools) {
        if (!tool?.name) continue;
        const publicName = publicToolName(tool.name);
        const rawName = tool.name;
        const definition = {
          name: publicName,
          description: tool.description || `mv-AIDE IDE tool: ${rawName}`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          output: {
            schema: {
              type: 'object',
              properties: { content: { type: 'array', items: {} } },
              required: ['content'],
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: 'text', text: extractText(value?.content) }];
            },
          },
          execute: async (args, exec) => {
            // Per-channel gate: agents running OUTSIDE the vault may only
            // call tools explicitly enabled in the mv-agent settings
            // ("库外项目工具策略"); in-vault agents are always allowed.
            const allowed = allowedForAgent(
              exec?.agent?.session?.header?.cwd,
              supervisor.workspaceFolders,
              supervisor.outsideToolPolicy,
              rawName,
            );
            if (!allowed) {
              throw new Error(
                `mv-AIDE 工具 ${rawName} 未对库外项目开放（可在 mv-agent 设置 → IDE 工具 中开启）`,
              );
            }
            const result = await supervisor.callTool(
              rawName,
              normalizeArgs(args),
              exec?.signal,
            );
            const content = Array.isArray(result?.content)
              ? result.content
              : [
                  {
                    type: 'text',
                    text:
                      typeof result === 'string'
                        ? result
                        : JSON.stringify(result ?? null),
                  },
                ];
            const text = extractText(content);
            if (result?.isError === true) throw new Error(text);
            return { content };
          },
        };
        disposers.set(publicName, ctx.tools.register(definition));
      }
      toolDisposers = disposers;
    } catch (error) {
      for (const dispose of disposers.values()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      toolDisposers = new Map();
      log(`mv-aide: tool registration failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Passive context delivery ─────────────────────────────────────────
  // Delivery modes (mv-agent setting `passiveDelivery`, carried by the
  // bridge):
  //   'live'    — every stable selection state is pushed as it happens
  //               (activity trail); deduplicated, debounced, and replaced
  //               in place while it is still pending.
  //   'on-send' — the selection is only BUFFERED; a single snapshot is
  //               injected at the moment the user sends a message (the
  //               agent's turn starts), and nothing else is pushed while
  //               the agent works. Explicit @mentions still steer.

  const SELECTION_DEBOUNCE_MS = 400;
  const MENTION_DEDUPE_WINDOW_MS = 5000;
  const MENTION_HISTORY = 3;

  let lastSelectionFile = null;
  let lastSelectionSignature = null;
  let pendingSelection = null; // { params, filePath, text, signature, at }
  let selectionTimer = null;
  // agent -> { messageId, signature } of the last injected (still maybe
  // pending) selection message; pending messages are REPLACED in place so a
  // growing selection never accumulates duplicated context.
  const pendingInjected = new WeakMap();
  // Latest snapshot for 'on-send' mode.
  let bufferedSelection = null;
  let bufferedAt = 0;
  const onSendInjectedAt = new WeakMap(); // agent -> injected snapshot time
  const recentMentions = []; // { signature, at }

  function renderSelectionContext(params, includeBreadcrumb = true, includeLocation = true, includeText = true) {
    const lines = [];
    if (includeLocation) {
      const where = params?.filePath ?? params?.fileUrl ?? '';
      lines.push(`Obsidian 选区：${where || '（未知文件）'}`);
    }
    if (includeBreadcrumb && params?.headingBreadcrumb) {
      lines.push(`位置：${params.headingBreadcrumb}`);
    }
    if (includeText) {
      const text = typeof params?.text === 'string' ? params.text.trim() : '';
      if (text.length > 0) {
        lines.push('选中文本：');
        lines.push(
          text.length > MAX_SELECTION_CHARS
            ? `${text.slice(0, MAX_SELECTION_CHARS)}…`
            : text,
        );
      } else if (typeof params?.selection?.start?.line === 'number') {
        lines.push(`光标位置：第 ${params.selection.start.line + 1} 行`);
      } else {
        lines.push('（无文本选区）');
      }
    }
    return lines.join('\n');
  }

  function renderMentionContext(params) {
    const filePath = params?.filePath ?? '';
    const start = typeof params?.lineStart === 'number' ? params.lineStart : undefined;
    const end = typeof params?.lineEnd === 'number' ? params.lineEnd : start;
    const range =
      start !== undefined ? `（第 ${start + 1}–${(end ?? start) + 1} 行）` : '';
    return `Obsidian @提及：${filePath || '（未知文件）'}${range}`;
  }

  function buildSelectionMessage(params, includeBreadcrumb = true, includeLocation = true, includeText = true) {
    return createUserMessage({
      content: [
        {
          type: 'text',
          text: renderSelectionContext(params, includeBreadcrumb, includeLocation, includeText),
        },
      ],
      source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
    });
  }

  /** Vault membership of one agent (folders-empty counts as vault). */
  function isVaultAgent(agent) {
    const folders = supervisor.workspaceFolders ?? [];
    if (folders.length === 0) return true;
    return isInsideAny(agent?.session?.header?.cwd, folders);
  }

  /**
   * Whether a selection/mention delivery may reach this agent: vault agents
   * always; outside-vault agents only when the mv-agent page-type tracking
   * opt-ins (trackMarkdown/trackPdf/trackWebview) enable it.
   */
  function selectionDeliveryAllowed(agent, viewType) {
    if (isVaultAgent(agent)) return true;
    return selectionAllowedForOutside(supervisor.outsideToolPolicy, viewType);
  }

  /**
   * Apply `applyToAgent` to each agent passing `isAllowed`. When no agent is
   * allowed the delivery is dropped (logged) — passive context must not leak
   * into unrelated sessions.
   */
  function deliverToMatches(reason, isAllowed, applyToAgent) {
    const agents = ctx.get('agents');
    if (!agents || typeof agents.list !== 'function') return;
    const folders = supervisor.workspaceFolders ?? [];
    const list = agents.list();
    const targets = list.filter((agent) => isAllowed(agent));
    if (targets.length === 0 && folders.length > 0) {
      log(`mv-aide: no agent allowed; dropping ${reason} delivery`);
      return;
    }
    for (const agent of targets) {
      try {
        applyToAgent(agent);
      } catch {
        /* per-agent containment */
      }
    }
  }

  /**
   * Deliver one selection snapshot to one agent. While the previous
   * snapshot is still PENDING in that agent's inbox it is replaced in
   * place (Inbox.replace), so a growing selection costs one message, not
   * one per intermediate state. Outside-vault agents get the breadcrumb
   * stripped unless "快照附 heading 面包屑" is opted in for them.
   */
  function pushSelectionToAgent(agent, snapshot) {
    const includeBreadcrumb = isVaultAgent(agent)
      ? true
      : supervisor.outsideToolPolicy?.includeHeadingBreadcrumb === true;
    const includeLocation = supervisor.pushLocation !== false;
    const includeText = supervisor.pushSelection !== false;
    const message = buildSelectionMessage(
      snapshot.params,
      includeBreadcrumb,
      includeLocation,
      includeText,
    );
    const previous = pendingInjected.get(agent);
    if (previous && typeof agent.inbox?.replace === 'function') {
      try {
        if (agent.inbox.replace(previous.messageId, message)) {
          pendingInjected.set(agent, { messageId: message.id, signature: snapshot.signature });
          return;
        }
      } catch {
        /* already claimed or invalid — fall through to append */
      }
    }
    if (typeof agent.inject !== 'function') return;
    agent.inject(message);
    pendingInjected.set(agent, { messageId: message.id, signature: snapshot.signature });
  }

  /** Debounced commit of the latest selection state. */
  function flushSelection() {
    selectionTimer = null;
    const pending = pendingSelection;
    pendingSelection = null;
    const decision = shouldDeliverSelection(
      pending,
      lastSelectionFile,
      lastSelectionSignature,
    );
    if (decision === 'drop') return;
    // 'clear' and 'deliver' both become the new latest state: a deselection
    // supersedes the last delivered/buffered snapshot so the stale selected
    // text can never be injected afterwards.
    lastSelectionFile = pending.filePath;
    lastSelectionSignature = pending.signature;
    if (decision === 'clear') {
      // Nothing to inject, but keep the empty page snapshot buffered so an
      // on-send push still carries "current page, no selection" instead of
      // the deselected text. (Live mode has no buffer — the page was already
      // announced when it was opened.)
      bufferedSelection = pending;
      bufferedAt = pending.at;
      return;
    }
    if (supervisor.passiveDelivery === 'on-send') {
      // Buffer only; the turn-start trigger below pushes it once.
      bufferedSelection = pending;
      bufferedAt = pending.at;
      return;
    }
    deliverToMatches(
      'selection',
      (agent) => selectionDeliveryAllowed(agent, pending.viewType),
      (agent) => pushSelectionToAgent(agent, pending),
    );
  }

  /** 'on-send' mode: push the buffered snapshot once, at the turn start. */
  function injectBufferedIfNewer(agent) {
    if (supervisor.passiveDelivery !== 'on-send') return;
    const buffered = bufferedSelection;
    if (!buffered) return;
    // Vault agents always; outside-vault agents only when the page-type
    // tracking opt-ins enable them (closes the leak where this path once
    // bypassed the vault filter entirely).
    if (!selectionDeliveryAllowed(agent, buffered.viewType)) return;
    const lastAt = onSendInjectedAt.get(agent) ?? 0;
    if (buffered.at <= lastAt) return;
    onSendInjectedAt.set(agent, buffered.at);
    pushSelectionToAgent(agent, buffered);
  }

  /**
   * 'on-send' backup trigger: a queued next-turn message means the user has
   * sent something; push the buffered snapshot then. (The primary trigger is
   * the agent/status listener registered below.)
   */
  function tryOnSendBackup() {
    if (supervisor.passiveDelivery !== 'on-send') return;
    const buffered = bufferedSelection;
    deliverToMatches(
      'on-send backup',
      (agent) => buffered && selectionDeliveryAllowed(agent, buffered.viewType),
      (agent) => {
        const nextTurn = agent?.inbox?.nextTurn;
        if (Array.isArray(nextTurn) && nextTurn.length > 0) injectBufferedIfNewer(agent);
      },
    );
  }

  function handleNotification(notification) {
    const method = notification?.method;
    if (method === 'selection_changed') {
      // 状态栏勾选框（pushLocation/pushSelection）：按开关过滤要推送的
      // 渠道；两者皆关则不推送任何内容。
      const channels = selectionChannels(
        supervisor.pushLocation,
        supervisor.pushSelection,
      );
      if (!channels.enabled) return;
      const rawParams = notification.params ?? {};
      const params = channels.includeLocation
        ? rawParams
        : { ...rawParams, filePath: undefined, fileUrl: undefined, title: undefined };
      const filePath =
        channels.includeLocation && typeof params.filePath === 'string'
          ? params.filePath
          : '';
      const text =
        channels.includeText && typeof params.text === 'string'
          ? params.text.trim()
          : '';
      const now = Date.now();
      pendingSelection = {
        params,
        filePath,
        text,
        viewType:
          typeof params.viewType === 'string' ? params.viewType : undefined,
        signature: selectionSignature(filePath, text),
        at: now,
      };
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(flushSelection, SELECTION_DEBOUNCE_MS);
      tryOnSendBackup();
    } else if (method === 'at_mentioned') {
      const params = notification.params ?? {};
      const signature = mentionSignature(params);
      const now = Date.now();
      if (isDuplicateMention(recentMentions, signature, now, MENTION_DEDUPE_WINDOW_MS, MENTION_HISTORY)) {
        return;
      }
      deliverToMatches(
        'mention',
        (agent) => selectionDeliveryAllowed(agent, undefined),
        (agent) => {
        if (typeof agent.steer !== 'function') return;
        agent.steer(
          createUserMessage({
            content: [{ type: 'text', text: renderMentionContext(params) }],
            source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
          }),
        );
      });
    }
  }

  const supervisor = new BridgeSupervisor({
    resolveWorkspace: async () => fixedWorkspace ?? process.cwd(),
    onLog: log,
    onNotification: handleNotification,
    onGeneration: (client, tools) => {
      generationSeq += 1;
      if (client) {
        registerTools(tools);
        void ensureVaultWorkspace();
      } else {
        disposeTools();
      }
    },
  });

  // ── Diff-as-permission hook ──────────────────────────────────────────
  // Intercepts write/edit/str_replace_editor at the permission moment and
  // reviews the change as an Obsidian diff instead of the web approval card.
  ctx.on('tools/execute', createDiffHook({ ctx, supervisor, log }));

  // ── Auto-enter the Obsidian vault workspace ───────────────────────────
  // On bridge connect, make the vault a dsh workspace; when it has no
  // session yet (fresh install or a brand-new vault), create one whose cwd
  // is the vault root so the sidebar can enter it. Idempotent: once entered,
  // reconnects (dsh restarts, Obsidian reloads) never mint duplicates.
  let enteredVaultKey = null;

  async function ensureVaultWorkspace() {
    const vaultRoot = supervisor.workspaceFolders?.[0];
    if (typeof vaultRoot !== 'string' || vaultRoot.length === 0) return;
    const key = normalizePath(vaultRoot);
    if (enteredVaultKey === key) return;
    try {
      const registry = ctx.get('workspaceRegistry');
      if (!registry || typeof registry.create !== 'function') {
        log('mv-aide: workspace registry unavailable; skipping vault auto-enter');
        return;
      }
      const workspace = await registry.create(vaultRoot);
      if (workspace.sessionIds.length === 0) {
        const agents = ctx.get('agents');
        if (!agents || typeof agents.create !== 'function') {
          log('mv-aide: agent service unavailable; vault workspace created without a session');
          return;
        }
        const presets = ctx.get('agentPresets');
        let presetId;
        if (presets && typeof presets.resolve === 'function') {
          try {
            presetId = (await presets.resolve(undefined))?.id;
          } catch {
            presetId = undefined;
          }
        }
        const meta =
          presetId === undefined
            ? { cwd: vaultRoot }
            : { cwd: vaultRoot, agentPreset: presetId };
        const handle = await agents.create({
          meta,
          ...(presetId !== undefined && presets && typeof presets.mount === 'function'
            ? {
                setup: async (agentCtx) => {
                  await presets.mount(agentCtx, presetId);
                },
              }
            : {}),
        });
        const sessionId = handle?.agent?.id ?? handle?.agent?.session?.id;
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          await workspace.attachSession(sessionId);
        }
      }
      enteredVaultKey = key;
      log(`mv-aide: vault workspace ready at ${vaultRoot}`);
    } catch (error) {
      log(
        `mv-aide: vault workspace auto-enter failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const command = ctx.commands.register({
    name: 'mv-aide',
    description: 'connect to the mv-AIDE Obsidian IDE bridge and query or call its tools',
    input: { hint: '[status|tools|selection|call <name> [json]]' },
    handler: (invocation) => runCommand(invocation.rawInput, invocation.signal),
  });

  async function runCommand(rawInput, signal) {
    const input = (rawInput ?? '').trim();
    const [verb, ...rest] = input.length === 0 ? ['status'] : input.split(/\s+/u);
    const tail = rest.join(' ');

    switch (verb) {
      case 'status': {
        const status = supervisor.status();
        return {
          kind: 'success',
          text: [
            'mv-AIDE bridge',
            `Connected: ${status.connected ? 'yes' : 'no'}`,
            `Tools: ${status.toolCount}`,
            '',
            COMMAND_USAGE,
          ].join('\n'),
        };
      }
      case 'tools': {
        if (!supervisor.client?.isOpen()) return notConnected();
        const tools = supervisor.client.tools;
        return {
          kind: 'success',
          text:
            tools.length === 0
              ? 'No tools advertised by mv-AIDE.'
              : tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'),
        };
      }
      case 'selection': {
        return callToolCommand('getLatestSelection', {}, signal);
      }
      case 'call': {
        if (rest.length === 0) {
          return { kind: 'error', text: `/mv-aide call requires a tool name.\n${COMMAND_USAGE}` };
        }
        const toolName = rest[0];
        let args = {};
        const jsonText = rest.slice(1).join(' ');
        if (jsonText.length > 0) {
          try {
            args = JSON.parse(jsonText);
          } catch {
            return { kind: 'error', text: `Invalid JSON arguments: ${jsonText}` };
          }
        }
        return callToolCommand(toolName, args, signal);
      }
      default:
        return { kind: 'error', text: `Unknown /mv-aide subcommand: ${verb}\n${COMMAND_USAGE}` };
    }
  }

  function notConnected() {
    return {
      kind: 'error',
      text: 'mv-AIDE bridge is not connected. Make sure Obsidian is running with the mv-AIDE plugin and its IDE bridge (or dsh integration) enabled.',
    };
  }

  async function callToolCommand(toolName, args, signal) {
    if (!supervisor.client?.isOpen()) return notConnected();
    try {
      const result = await supervisor.callTool(toolName, args, signal);
      const content = Array.isArray(result?.content)
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result ?? null) }];
      const text = extractText(content);
      if (result?.isError === true) return { kind: 'error', text };
      return { kind: 'success', text };
    } catch (error) {
      return {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      };
    }
  }

  supervisor.start();

  // 'on-send' primary trigger: the moment an agent's turn starts (the user
  // sent a message), push the buffered selection snapshot once. The payload
  // carries { agent, status }; a running status that is not a real turn
  // start (e.g. a steer wake) still counts as a send moment — acceptable.
  ctx.on('agent/status', (payload) => {
    if (payload && typeof payload === 'object' && payload.status === 'running') {
      injectBufferedIfNewer(payload.agent);
    }
  });

  ctx.effect(() => {
    return () => {
      command();
      supervisor.dispose();
      disposeTools();
      if (selectionTimer !== null) clearTimeout(selectionTimer);
    };
  });
}
