// mv-AIDE bridge plugin for DeepSeek Harness (DSH).
//
// - Registers the `/mv-aide` slash command for status, bridge selection, and
//   direct bridge calls.
// - Discovers mv-AIDE's own IDE bridges exclusively from
//   `~/.mv-aide/ide` and registers each IDE tool as a native tool under
//   `mv_aide__<name>`, so the model can use Obsidian context (selection, open
//   editors, links, tags, …).
// - Successful IDE connections are remembered per DSH conversation and per
//   DSH workspace. Reopening a conversation prefers its own last connected
//   vault, then the workspace's last connected vault, then a live containing
//   vault. Every connection path has identical persistence consequences.
// - Maintains the latest mv-AIDE passive snapshot: `selection_changed` only
//   updates buffered context, which is injected once when the user starts the
//   next turn; user-triggered `at_mentioned` steering still wakes the agent.
//
// This is a static Cordis plugin: `name`, `inject`, and `apply` are the only
// exports the loader consumes.

import {
  BridgeSupervisor,
  bridgeMatchesSelection,
  clearBridgeConnection,
  discoverBridges,
  loadBridgeConnection,
  migrateBridgeSelectionStore,
  parseBridgeSelector,
  recordBridgeConnection,
  sessionKeyOf,
} from './bridge-client.js';
import {
  ActiveSessionRegistry,
  isSessionAuthorized,
  mountActiveSessionControl,
} from './active-session-control.js';
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
import { mountHoverSidebar } from './hover-sidebar.js';
import { installImageAdapter } from './image-adapter.js';
import { installAgentFeatureSettings } from './feature-settings.js';
import {
  callEnhancedTerminalTool,
  isEnhancedTerminalTool,
  terminalAwareToolDefinitions,
} from './terminal-tools.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';

export const name = 'mv-agent';
export const inject = ['commands', 'tools'];

const COMMAND_USAGE =
  'Usage: /mv-aide [status|tools|bridges|connect <序号|端口|路径|auto>|selection|call <name> [json]]';

const PLUGIN_SOURCE = 'mv-aide-dsh';
const SESSION_NOT_OPEN_MESSAGE =
  'mv-AIDE 仅服务当前打开或正在运行的 DSH 对话；该对话已关闭且不在运行。切回该对话页面即可自动恢复连接。';
/** How long an idle, unstaged supervisor lingers before cleanup (absorbs rapid idle↔running flaps). */
const IDLE_SUPERVISOR_GRACE_MS = 5000;

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
  const supervisors = new Map();
  const activeAgents = new Map();
  const activationGenerations = new Map();
  const enteredVaultKeys = new Set();
  /** sessionId → pending cleanup timer for idle, unstaged supervisors. */
  const idleDisposers = new Map();
  let directControlDisposer;
  let commandDisposer;
  const imagePolicyService = installImageAdapter(ctx);
  const featureSettings = installAgentFeatureSettings(ctx);

  const log = (message) => {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(message);
    } else {
      console.warn(message);
    }
  };

  const migrationPromise = migrateBridgeSelectionStore().catch((error) => {
    log(`mv-aide: failed to migrate bridge selections — ${error instanceof Error ? error.message : String(error)}`);
    return false;
  });

  const activeSessions = new ActiveSessionRegistry({
    onActivate: (report) => activateReportedSession(report),
    onDeactivate: ({ sessionId }) => deactivateReportedSession(sessionId),
    onLog: log,
  });

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        mountHoverSidebar(webCtx);
      } catch (err) {
        log(`[mv-aide-dsh] hover sidebar mount skipped: ${err?.message || err}`);
      }
      try {
        const dispose = mountActiveSessionControl(webCtx, { registry: activeSessions, onLog: log });
        if (dispose) webCtx.effect(() => dispose);
      } catch (err) {
        log(`[mv-aide-dsh] active session control mount skipped: ${err?.message || err}`);
      }
    });
  } else {
    try {
      mountHoverSidebar(ctx);
    } catch (err) {
      log(`[mv-aide-dsh] hover sidebar mount skipped: ${err?.message || err}`);
    }
    try {
      directControlDisposer = mountActiveSessionControl(ctx, { registry: activeSessions, onLog: log });
    } catch (err) {
      log(`[mv-aide-dsh] active session control mount skipped: ${err?.message || err}`);
    }
  }

  // ── Per-session supervisors ───────────────────────────────────────────
  function sessionIdOf(agent) {
    const sessionId = agent?.session?.id ?? agent?.id;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  }

  /** Live, authoritative activity check against the DSH agent registry (covers subagents too). */
  function isAgentRunning(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    try {
      return ctx.get('agents')?.get?.(sessionId)?.status === 'running';
    } catch {
      return false;
    }
  }

  /** Staged = reported by a live DSH frontend as the conversation on screen. */
  function isStagedSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.length > 0 && activeSessions.isActive(sessionId);
  }

  function requireOpenAgent(agent) {
    if (featureSettings.get().bridgeEnabled === false) {
      throw new Error('mv-AIDE IDE bridge is disabled in DSH plugin settings.');
    }
    const sessionId = sessionIdOf(agent);
    // Staged (frontend-reported) OR mid-turn running agents — including
    // background subagents — may use the bridge. Idle + unstaged sessions
    // still throw.
    if (!isSessionAuthorized(activeSessions, ctx.get('agents'), sessionId)) {
      throw new Error(SESSION_NOT_OPEN_MESSAGE);
    }
    return sessionId;
  }

  function workspaceOfAgent(agent) {
    const sessionId = sessionIdOf(agent);
    const live = sessionId ? ctx.get('agents')?.get?.(sessionId) : undefined;
    return fixedWorkspace ??
      live?.session?.header?.cwd ??
      (sessionId ? activeAgents.get(sessionId)?.session?.header?.cwd : undefined) ??
      agent?.session?.header?.cwd ??
      (sessionId ? activeSessions.reportFor(sessionId)?.cwd : undefined);
  }

  function syncImagePolicy(supervisor) {
    if (!imagePolicyService || typeof imagePolicyService.setSession !== 'function') return;
    if (typeof supervisor?.sessionId !== 'string' || supervisor.sessionId.length === 0) return;
    imagePolicyService.setSession(
      supervisor.sessionId,
      featureSettings.get().imageAutoFitEnabled !== false && supervisor.autoFitImageSize !== false,
    );
  }

  function clearImagePolicy(sessionId) {
    if (!imagePolicyService || typeof imagePolicyService.deleteSession !== 'function') return;
    imagePolicyService.deleteSession(sessionId);
  }

  function passiveStateFor(supervisor) {
    if (!supervisor.passiveState) {
      supervisor.passiveState = {
        lastSelectionFile: null,
        lastSelectionSignature: null,
        pendingSelection: null,
        selectionTimer: null,
        bufferedSelection: null,
        bufferedAt: 0,
        recentMentions: [],
      };
    }
    return supervisor.passiveState;
  }

  function supervisorForSync(agent, selection) {
    const sessionId = requireOpenAgent(agent);
    const key = sessionKeyOf(agent);
    let sv = supervisors.get(key);
    if (sv) return sv;
    sv = new BridgeSupervisor({
      selection: selection ?? null,
      resolveWorkspace: async () => workspaceOfAgent(agent),
      onConnected: async (connection) => {
        const workspace = workspaceOfAgent(agent);
        // Only staged (frontend-reported) sessions write connection history.
        // Lazily created supervisors for running-only sessions (e.g.
        // background subagents) must not pollute the workspace's remembered
        // bridge selection — today they can never connect at all.
        if (isStagedSession(sessionId)) {
          await recordBridgeConnection(key, connection, { workspace });
        }
        syncImagePolicy(sv);
      },
      onLog: log,
      onNotification: (notification) => handleNotification(sv, notification),
      onGeneration: (client, tools) => {
        generationSeq += 1;
        if (client) {
          refreshTools();
          void ensureVaultWorkspace(sv);
        } else {
          clearImagePolicy(sv.sessionId);
          refreshTools();
        }
      },
    });
    passiveStateFor(sv);
    sv.sessionKey = key;
    sv.sessionId = sessionId;
    supervisors.set(key, sv);
    sv.start();
    return sv;
  }

  async function resolveReportedAgent(report) {
    const sessionId = report.sessionId;
    const agents = ctx.get('agents');
    const live = agents?.get?.(sessionId) ?? agents?.list?.().find((agent) => sessionIdOf(agent) === sessionId);
    if (live) return live;

    let header;
    const persistence = ctx.get('sessionPersistence');
    if (persistence && typeof persistence.list === 'function') {
      const stored = await persistence.list().catch(() => []);
      header = stored.find((candidate) => candidate?.id === sessionId);
    }
    const cwd = fixedWorkspace ?? header?.cwd ?? report.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    return {
      id: sessionId,
      session: {
        id: sessionId,
        header: header ?? { id: sessionId, cwd },
      },
    };
  }

  async function ensureActiveSupervisor(agent, options = {}) {
    requireOpenAgent(agent);
    const key = sessionKeyOf(agent);
    const existing = supervisors.get(key);
    if (existing) return existing;
    await migrationPromise;
    const selection = options.ignoreSession === true
      ? null
      : await loadBridgeConnection(key).catch(() => null);
    requireOpenAgent(agent);
    // An opened conversation always owns a supervisor, even when no IDE is
    // currently discoverable. The supervisor keeps resolving/retrying so a
    // later Obsidian start, page refresh, or plugin restart self-heals.
    return supervisorForSync(agent, selection);
  }

  async function supervisorFor(agent) {
    requireOpenAgent(agent);
    return ensureActiveSupervisor(agent);
  }

  async function activateReportedSession(report) {
    cancelIdleSupervisorCleanup(report.sessionId);
    const generation = (activationGenerations.get(report.sessionId) ?? 0) + 1;
    activationGenerations.set(report.sessionId, generation);
    const agent = await resolveReportedAgent(report).catch((error) => {
      log(`mv-aide: failed to resolve opened session ${report.sessionId} — ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!agent || activationGenerations.get(report.sessionId) !== generation || !activeSessions.isActive(report.sessionId)) return;
    activeAgents.set(report.sessionId, agent);
    if (featureSettings.get().bridgeEnabled === false) return;
    await ensureActiveSupervisor(agent).catch((error) => {
      if (activeSessions.isActive(report.sessionId)) {
        log(`mv-aide: failed to activate opened session ${report.sessionId} — ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  function disposeSupervisor(sessionId, reason = SESSION_NOT_OPEN_MESSAGE) {
    cancelIdleSupervisorCleanup(sessionId);
    const key = `session:${sessionId}`;
    const supervisor = supervisors.get(key);
    if (!supervisor) return;
    supervisors.delete(key);
    const state = supervisor.passiveState;
    if (state?.selectionTimer !== null && state?.selectionTimer !== undefined) {
      clearTimeout(state.selectionTimer);
      state.selectionTimer = null;
    }
    clearImagePolicy(sessionId);
    supervisor.dispose(reason);
  }

  function deactivateReportedSession(sessionId) {
    activationGenerations.set(sessionId, (activationGenerations.get(sessionId) ?? 0) + 1);
    activeAgents.delete(sessionId);
    if (isAgentRunning(sessionId)) {
      // The conversation is mid-turn (or a background subagent is working):
      // keep its supervisor so in-flight and subsequent tool calls survive
      // the frontend switching away. Cleanup happens once it goes idle.
      scheduleIdleSupervisorCleanup(sessionId);
      return;
    }
    disposeSupervisor(sessionId);
  }

  /**
   * Lazily created supervisors for running-only sessions (and supervisors
   * kept alive across a mid-turn unstage) are cleaned up shortly after the
   * agent goes idle. Authorization never depends on this timer — tool calls
   * check the live agent status — so the grace only avoids churn between
   * rapid consecutive turns.
   */
  function scheduleIdleSupervisorCleanup(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (isStagedSession(sessionId)) return;
    if (idleDisposers.has(sessionId)) return;
    const timer = setTimeout(() => {
      idleDisposers.delete(sessionId);
      if (!isStagedSession(sessionId) && !isAgentRunning(sessionId)) {
        disposeSupervisor(sessionId, 'session went idle while unstaged');
      }
    }, IDLE_SUPERVISOR_GRACE_MS);
    idleDisposers.set(sessionId, timer);
  }

  function cancelIdleSupervisorCleanup(sessionId) {
    const timer = idleDisposers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    idleDisposers.delete(sessionId);
  }

  function disposeAllSupervisors() {
    for (const timer of idleDisposers.values()) clearTimeout(timer);
    idleDisposers.clear();
    for (const sv of supervisors.values()) {
      for (const state of [sv.passiveState]) {
        if (state?.selectionTimer !== null && state?.selectionTimer !== undefined) {
          clearTimeout(state.selectionTimer);
          state.selectionTimer = null;
        }
      }
      clearImagePolicy(sv.sessionId);
      sv.dispose();
    }
    supervisors.clear();
    activeAgents.clear();
  }

  // ── Tool registration (global once, routed per session) ───────────────
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

  function collectTools() {
    if (featureSettings.get().bridgeEnabled === false || featureSettings.get().ideToolsEnabled === false) {
      return [];
    }
    const byName = new Map();
    const connected = [...supervisors.values()].filter((sv) => sv.client?.isOpen());
    // Tool registration is global in DSH, so a mixed multi-vault session cannot
    // expose per-agent schemas. Enhanced mode wins globally to preserve the
    // strict invariant that getTerminalOutput and native terminal tools never
    // coexist in one registered tool set.
    const enhancedMode = featureSettings.get().terminalToolsEnabled !== false
      && connected.some((sv) => sv.terminalAwarenessEnhanced !== false);
    for (const sv of connected) {
      for (const tool of sv.client?.tools ?? []) {
        if (tool?.name) byName.set(tool.name, tool);
      }
    }
    return terminalAwareToolDefinitions([...byName.values()], enhancedMode);
  }

  function refreshTools() {
    registerTools(collectTools());
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
            if (featureSettings.get().bridgeEnabled === false || featureSettings.get().ideToolsEnabled === false) {
              throw new Error('mv-AIDE IDE tools are disabled in DSH plugin settings.');
            }
            const sv = await supervisorFor(exec?.agent);
            if (!sv?.isConnected()) {
              throw new Error(
                'mv-AIDE bridge is not connected for this session. Use /mv-aide connect to choose a bridge.',
              );
            }
            // Per-channel gate: agents running OUTSIDE the vault may only
            // call tools explicitly enabled in the mv-agent settings
            // ("库外项目工具策略"); in-vault agents are always allowed.
            const policyChannel = isEnhancedTerminalTool(rawName)
              ? 'getTerminalOutput'
              : rawName;
            const allowed = allowedForAgent(
              exec?.agent?.session?.header?.cwd,
              sv.workspaceFolders,
              sv.outsideToolPolicy,
              policyChannel,
            );
            if (!allowed) {
              throw new Error(
                `mv-AIDE 工具 ${rawName} 未对库外项目开放（可在 mv-agent 设置 → IDE 工具 → ${policyChannel} 中开启）`,
              );
            }
            const normalizedArgs = normalizeArgs(args);
            if (isEnhancedTerminalTool(rawName)
                && (featureSettings.get().terminalToolsEnabled === false
                  || sv.terminalAwarenessEnhanced === false)) {
              throw new Error('mv-AIDE enhanced terminal awareness is disabled for this session.');
            }
            const result = isEnhancedTerminalTool(rawName)
              ? await callEnhancedTerminalTool(
                  sv.client,
                  rawName,
                  normalizedArgs,
                  exec?.signal,
                )
              : await sv.callTool(rawName, normalizedArgs, exec?.signal);
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

  // ── Passive context delivery (per session) ────────────────────────────
  const MENTION_DEDUPE_WINDOW_MS = 5000;
  const MENTION_HISTORY = 3;

  // These WeakMaps are safe to keep global because each agent belongs to a
  // stable session; the per-session pending state lives on the supervisor.
  const pendingInjected = new WeakMap();
  const onSendInjectedAt = new WeakMap();

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
          text.length > featureSettings.get().selectionMaxChars
            ? `${text.slice(0, featureSettings.get().selectionMaxChars)}…`
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

  /** Vault membership of one agent against one session's bridge. */
  function isVaultAgent(agent, supervisor) {
    const folders = supervisor.workspaceFolders ?? [];
    if (folders.length === 0) return true;
    return isInsideAny(agent?.session?.header?.cwd, folders);
  }

  /**
   * Whether a selection/mention delivery may reach this agent: vault agents
   * always; outside-vault agents only when the mv-agent page-type tracking
   * opt-ins (trackMarkdown/trackPdf/trackWebview) enable it.
   */
  function selectionDeliveryAllowed(agent, viewType, supervisor) {
    if (isVaultAgent(agent, supervisor)) return true;
    return selectionAllowedForOutside(supervisor.outsideToolPolicy, viewType);
  }

  /**
   * Apply `applyToAgent` to each agent passing `isAllowed`. When no agent is
   * allowed the delivery is dropped (logged) — passive context must not leak
   * into unrelated sessions.
   */
  function deliverToMatches(supervisor, reason, isAllowed, applyToAgent) {
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
  function pushSelectionToAgent(agent, snapshot, supervisor) {
    const includeBreadcrumb = isVaultAgent(agent, supervisor)
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

  /** Debounced commit of the latest selection state for one session. */
  function flushSelection(supervisor) {
    const state = passiveStateFor(supervisor);
    state.selectionTimer = null;
    const pending = state.pendingSelection;
    state.pendingSelection = null;
    const decision = shouldDeliverSelection(
      pending,
      state.lastSelectionFile,
      state.lastSelectionSignature,
    );
    if (decision === 'drop') return;
    state.lastSelectionFile = pending.filePath;
    state.lastSelectionSignature = pending.signature;
    state.bufferedSelection = pending;
    state.bufferedAt = pending.at;
  }

  /** Push the buffered snapshot once at the next user turn start. */
  function injectBufferedIfNewer(agent, supervisor) {
    const state = passiveStateFor(supervisor);
    const buffered = state.bufferedSelection;
    if (!buffered) return;
    if (!selectionDeliveryAllowed(agent, buffered.viewType, supervisor)) return;
    const lastAt = onSendInjectedAt.get(agent) ?? 0;
    if (buffered.at <= lastAt) return;
    onSendInjectedAt.set(agent, buffered.at);
    pushSelectionToAgent(agent, buffered, supervisor);
  }

  /**
   * Backup trigger: a queued next-turn message means the user has sent
   * something; push the buffered snapshot then. (The primary trigger is the
   * agent/status listener registered below.)
   */
  function tryBufferedSendBackup(supervisor) {
    const state = passiveStateFor(supervisor);
    const buffered = state.bufferedSelection;
    deliverToMatches(
      supervisor,
      'buffered snapshot backup',
      (agent) =>
        buffered &&
        sessionKeyOf(agent) === supervisor.sessionKey &&
        // Passive context stays staged-only: running-only sessions (e.g.
        // background subagents) must not start receiving selection pushes.
        isStagedSession(sessionIdOf(agent)) &&
        selectionDeliveryAllowed(agent, buffered.viewType, supervisor),
      (agent) => {
        const nextTurn = agent?.inbox?.nextTurn;
        if (Array.isArray(nextTurn) && nextTurn.length > 0) injectBufferedIfNewer(agent, supervisor);
      },
    );
  }

  function handleNotification(supervisor, notification) {
    const state = passiveStateFor(supervisor);
    const method = notification?.method;
    if (method === 'mv_aide_settings_changed') {
      if (typeof notification?.params?.terminalAwarenessEnhanced === 'boolean') {
        refreshTools();
      }
      if (typeof notification?.params?.autoFitImageSize === 'boolean') {
        syncImagePolicy(supervisor);
      }
      return;
    }
    if (method === 'selection_changed') {
      if (featureSettings.get().bridgeEnabled === false
          || featureSettings.get().selectionContextEnabled === false) return;
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
      state.pendingSelection = {
        params,
        filePath,
        text,
        viewType:
          typeof params.viewType === 'string' ? params.viewType : undefined,
        signature: selectionSignature(filePath, text),
        at: now,
      };
      if (state.selectionTimer !== null) clearTimeout(state.selectionTimer);
      state.selectionTimer = setTimeout(
        () => flushSelection(supervisor),
        featureSettings.get().selectionDebounceMs,
      );
      tryBufferedSendBackup(supervisor);
    } else if (method === 'at_mentioned') {
      if (featureSettings.get().bridgeEnabled === false
          || featureSettings.get().mentionSteeringEnabled === false) return;
      const params = notification.params ?? {};
      const signature = mentionSignature(params);
      const now = Date.now();
      if (isDuplicateMention(state.recentMentions, signature, now, MENTION_DEDUPE_WINDOW_MS, MENTION_HISTORY)) {
        return;
      }
      deliverToMatches(
        supervisor,
        'mention',
        // Passive context stays staged-only (see tryBufferedSendBackup).
        (agent) =>
          sessionKeyOf(agent) === supervisor.sessionKey &&
          isStagedSession(sessionIdOf(agent)) &&
          selectionDeliveryAllowed(agent, undefined, supervisor),
        (agent) => {
          if (typeof agent.steer !== 'function') return;
          agent.steer(
            createUserMessage({
              content: [{ type: 'text', text: renderMentionContext(params) }],
              source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
            }),
          );
        },
      );
    }
  }

  // ── Diff-as-permission hook ──────────────────────────────────────────
  // Intercepts write/edit/str_replace_editor at the permission moment and
  // reviews the change as an Obsidian diff instead of the web approval card.
  // The supervisor is resolved per executing session so the correct bridge is
  // used.
  ctx.on('tools/execute', createDiffHook({
    ctx,
    resolveSupervisor: async (exec) => {
      if (featureSettings.get().bridgeEnabled === false
          || featureSettings.get().diffReviewEnabled === false) return null;
      const sessionId = sessionIdOf(exec?.agent);
      if (!sessionId || !activeSessions.isActive(sessionId)) return null;
      return ensureActiveSupervisor(exec?.agent).catch(() => null);
    },
    log,
  }));

  // ── Auto-enter the Obsidian vault workspace ───────────────────────────
  // On each session bridge connect, make that vault a dsh workspace; when it
  // has no session yet, create one whose cwd is the vault root. Idempotent
  // per vault root.
  async function ensureVaultWorkspace(supervisor) {
    if (featureSettings.get().bridgeEnabled === false
        || featureSettings.get().autoEnterVaultWorkspaceEnabled === false) return;
    const vaultRoot = supervisor.workspaceFolders?.[0];
    if (typeof vaultRoot !== 'string' || vaultRoot.length === 0) return;
    const key = normalizePath(vaultRoot);
    if (enteredVaultKeys.has(key)) return;
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
      enteredVaultKeys.add(key);
      log(`mv-aide: vault workspace ready at ${vaultRoot}`);
    } catch (error) {
      log(
        `mv-aide: vault workspace auto-enter failed — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ── Bridge listing / connecting for the current session ───────────────
  async function renderBridgeList(sv, agent) {
    const bridges = await discoverBridges().catch(() => []);
    if (bridges.length === 0) {
      return '未发现 mv-AIDE 桥接 lock 文件。请先在任一仓库开启 IDE 桥接（mv-agent / Claude Code）。';
    }
    const lines = ['IDE 桥接列表（* = 当前连接）：'];
    bridges.forEach((bridge, index) => {
      const current = sv?.client?.port === bridge.port;
      const selected = sv?.selection && bridgeMatchesSelection(bridge, sv.selection);
      const marker = current ? ' *' : selected ? ' (已选择)' : '';
      const folders = (bridge.workspaceFolders ?? []).join(' | ');
      lines.push(`${index + 1}. 端口 ${bridge.port}${marker} — ${folders || '（无 workspace）'}`);
    });
    lines.push('');
    lines.push('使用 /mv-aide connect <序号|端口|路径|auto> 切换本会话连接。');
    return lines.join('\n');
  }

  function syncCommandRegistration() {
    const enabled = featureSettings.get().slashCommandEnabled !== false;
    if (!enabled && commandDisposer) {
      commandDisposer();
      commandDisposer = undefined;
      return;
    }
    if (enabled && !commandDisposer) {
      commandDisposer = ctx.commands.register({
        name: 'mv-aide',
        description: 'connect to the mv-AIDE Obsidian IDE bridge and query or call its tools',
        input: { hint: '[status|tools|bridges|connect <序号|端口|路径|auto>|selection|call <name> [json]]' },
        handler: (invocation) => runCommand(invocation.rawInput, invocation.signal, invocation.agent),
      });
    }
  }

  syncCommandRegistration();

  async function runCommand(rawInput, signal, agent) {
    const input = (rawInput ?? '').trim();
    const [verb, ...rest] = input.length === 0 ? ['status'] : input.split(/\s+/u);
    const tail = rest.join(' ');
    const key = sessionKeyOf(agent);
    requireOpenAgent(agent);
    let sv = await supervisorFor(agent);

    switch (verb) {
      case 'status': {
        const status = sv?.status() ?? {
          connected: false,
          port: null,
          workspaceFolders: [],
          toolCount: 0,
          lastError: 'bridge supervisor is not available for this opened conversation',
        };
        const folder = status.workspaceFolders?.[0] ?? '';
        return {
          kind: 'success',
          text: [
            'mv-AIDE bridge',
            `Connected: ${status.connected ? 'yes' : 'no'}`,
            `Bridge: ${status.port ? `${status.port}${folder ? ` (${folder})` : ''}` : 'none'}`,
            `Tools: ${status.toolCount}`,
            status.lastError ? `Last error: ${status.lastError}` : '',
            '',
            COMMAND_USAGE,
          ].join('\n'),
        };
      }
      case 'tools': {
        if (!sv?.client?.isOpen()) return notConnected();
        const tools = sv.client.tools;
        return {
          kind: 'success',
          text:
            tools.length === 0
              ? 'No tools advertised by mv-AIDE.'
              : tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n'),
        };
      }
      case 'bridges':
      case 'list': {
        return { kind: 'success', text: await renderBridgeList(sv, agent) };
      }
      case 'connect': {
        if (tail.length === 0) {
          return { kind: 'success', text: await renderBridgeList(sv, agent) };
        }
        if (tail === 'auto') {
          requireOpenAgent(agent);
          await clearBridgeConnection(key).catch((error) => {
            log(`mv-aide: failed to clear conversation bridge history — ${error instanceof Error ? error.message : String(error)}`);
          });
          let switchResult;
          if (!sv) {
            sv = await ensureActiveSupervisor(agent, { ignoreSession: true });
            switchResult = sv?.isConnected()
              ? { ok: true, connection: { port: sv.client.port, workspaceFolders: sv.workspaceFolders } }
              : { ok: false, error: sv?.lastError ?? '当前没有可用 IDE' };
          } else {
            switchResult = await sv.setTarget(null);
          }
          return {
            kind: switchResult?.ok ? 'success' : 'error',
            text: switchResult?.ok
              ? `已清除本对话的历史目标，并连接 IDE 桥：端口 ${switchResult.connection.port}。`
              : `已清除本对话的历史目标；当前没有可连接的 IDE，将继续等待。${switchResult?.error ? `\n${switchResult.error}` : ''}`,
          };
        }
        const bridges = await discoverBridges().catch(() => []);
        const parsed = parseBridgeSelector(tail, bridges);
        if (!parsed.ok) {
          return { kind: 'error', text: `${parsed.message}\n${COMMAND_USAGE}` };
        }
        const workspace = workspaceOfAgent(agent);
        const selection = {
          port: parsed.bridge.port,
          workspaceFolders: parsed.bridge.workspaceFolders ?? [],
        };
        if (typeof workspace === 'string' && workspace.length > 0) {
          selection.workspace = workspace;
        }
        // Choosing a target is not connection history. Persistence happens only
        // after the same connect + initialize + tools/list success path used by
        // automatic discovery and reconnects.
        let switchResult;
        if (sv) {
          switchResult = await sv.setTarget(selection);
        } else {
          sv = supervisorForSync(agent, selection);
          await sv.connectOnce();
          switchResult = sv.isConnected()
            ? { ok: true, connection: { port: sv.client.port, workspaceFolders: sv.workspaceFolders } }
            : { ok: false, error: sv.lastError ?? '连接失败' };
        }
        const folders = (selection.workspaceFolders ?? []).join(' | ');
        return {
          kind: switchResult?.ok ? 'success' : 'error',
          text: switchResult?.ok
            ? `已连接 IDE 桥：端口 ${switchResult.connection.port}${folders ? `（${folders}）` : ''}。`
            : `IDE 桥连接失败：端口 ${selection.port}${folders ? `（${folders}）` : ''}。原连接保持不变。\n${switchResult?.error ?? '未知错误'}`,
        };
      }
      case 'selection': {
        return callToolCommand(sv, 'getLatestSelection', {}, signal);
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
        return callToolCommand(sv, toolName, args, signal);
      }
      default:
        return { kind: 'error', text: `Unknown /mv-aide subcommand: ${verb}\n${COMMAND_USAGE}` };
    }
  }

  function notConnected() {
    return {
      kind: 'error',
      text: 'mv-AIDE bridge is not connected for this session. Use /mv-aide bridges and /mv-aide connect to choose a bridge.',
    };
  }

  async function callToolCommand(sv, toolName, args, signal) {
    if (!sv?.client?.isOpen()) return notConnected();
    try {
      const result = await sv.callTool(toolName, args, signal);
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

  // Primary buffered-snapshot trigger: when an agent turn starts after the
  // user sends a message, push the latest selection snapshot once. The payload
  // carries { agent, status }; a running status that is not a real turn
  // start (e.g. a steer wake) still counts as a send moment — acceptable.
  // Delivery stays staged-only so running-only sessions (background
  // subagents included) never receive passive selection pushes.
  ctx.on('agent/status', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const sessionId = sessionIdOf(payload.agent);
    if (payload.status === 'running') {
      cancelIdleSupervisorCleanup(sessionId);
      if (isStagedSession(sessionId)) {
        const sv = supervisors.get(sessionKeyOf(payload.agent));
        if (sv) injectBufferedIfNewer(payload.agent, sv);
      }
    } else if (payload.status === 'idle') {
      scheduleIdleSupervisorCleanup(sessionId);
    }
  });

  const unsubscribeFeatureSettings = featureSettings.subscribe((next, previous) => {
    syncCommandRegistration();
    if (previous.bridgeEnabled !== false && next.bridgeEnabled === false) {
      const opened = [...activeAgents.entries()];
      disposeAllSupervisors();
      for (const [sessionId, agent] of opened) activeAgents.set(sessionId, agent);
    } else if (previous.bridgeEnabled === false && next.bridgeEnabled !== false) {
      for (const agent of activeAgents.values()) {
        void ensureActiveSupervisor(agent).catch((error) => {
          log(`mv-aide: failed to resume bridge after settings change — ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
    if (next.selectionContextEnabled === false) {
      for (const supervisor of supervisors.values()) {
        const state = passiveStateFor(supervisor);
        if (state.selectionTimer !== null) clearTimeout(state.selectionTimer);
        state.selectionTimer = null;
        state.pendingSelection = null;
        state.bufferedSelection = null;
      }
    }
    for (const supervisor of supervisors.values()) syncImagePolicy(supervisor);
    refreshTools();
  });

  ctx.effect(() => {
    return () => {
      unsubscribeFeatureSettings();
      commandDisposer?.();
      commandDisposer = undefined;
      directControlDisposer?.();
      directControlDisposer = undefined;
      activeSessions.clear();
      disposeAllSupervisors();
      disposeTools();
    };
  });
}
