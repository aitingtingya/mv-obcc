// Tool-schema decoration and per-root parallel dispatch.

import { WorkspaceRuntimeProjection } from './runtime-workspace.js';

export const WORKSPACE_SELECTOR_DESCRIPTION = 'Select the workspace roots for this tool call. Omit this parameter to use the session\'s current workspace. Pass one workspace ID to run once in that workspace. Pass an array of workspace IDs to run the same native tool call independently and concurrently in every selected workspace. Pass "all" to run it independently and concurrently in the primary workspace and every configured subworkspace. Relative paths and the default shell working directory are resolved separately under each workspace; absolute paths are left unchanged. Multi-workspace results are reported separately for every workspace, and a failure in one workspace does not cancel or alter the others. This parameter affects only this call and does not change the session\'s current workspace. Use the workspace tool with action "list" to obtain valid workspace IDs.';

export const WORKSPACE_TOOL_NAME = 'workspace';

const SELECTOR_SCHEMA = Object.freeze({
  oneOf: [
    { type: 'string' },
    { type: 'array', minItems: 1, items: { type: 'string' } },
  ],
  description: WORKSPACE_SELECTOR_DESCRIPTION,
});

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function stripWorkspaceSelector(args) {
  if (!isObject(args) || !Object.hasOwn(args, '_workspace')) return args;
  const copy = { ...args };
  delete copy._workspace;
  return copy;
}

export function extendParameters(parameters) {
  if (!isObject(parameters) || parameters.type !== 'object') {
    throw new Error('workspace-aware tools require an object-root parameter schema');
  }
  return {
    ...parameters,
    properties: {
      ...(isObject(parameters.properties) ? parameters.properties : {}),
      _workspace: SELECTOR_SCHEMA,
    },
  };
}

function batchOutputSchema(nativeSchema) {
  return {
    oneOf: [
      nativeSchema,
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'workspace_batch' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                workspaceId: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                ok: { type: 'boolean' },
                value: nativeSchema,
                content: { type: 'array', items: {} },
                error: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    message: { type: 'string' },
                    code: { type: 'string' },
                  },
                  required: ['message'],
                },
              },
              required: ['workspaceId', 'path', 'label', 'ok', 'content'],
            },
          },
        },
        required: ['kind', 'results'],
      },
    ],
  };
}

function isBatchValue(value) {
  return isObject(value) && value.kind === 'workspace_batch' && Array.isArray(value.results);
}

function renderBatch(value) {
  const content = [];
  for (const result of value.results) {
    const status = result.ok ? 'ok' : 'error';
    content.push({
      type: 'text',
      text: `Workspace ${result.label} [${result.workspaceId}] (${result.path || 'unresolved'}) — ${status}`,
    });
    if (Array.isArray(result.content) && result.content.length > 0) content.push(...result.content);
  }
  return content;
}

function batchSelector(args) {
  const selector = isObject(args) ? args._workspace : undefined;
  return selector === 'all' || Array.isArray(selector);
}

export function decorateToolDefinition(original) {
  const output = {
    schema: batchOutputSchema(original.output.schema),
    render(args, value) {
      return isBatchValue(value)
        ? renderBatch(value)
        : original.output.render(stripWorkspaceSelector(args), value);
    },
  };
  if (typeof original.output.presentationMeta === 'function') {
    output.presentationMeta = (args, value) => isBatchValue(value)
      ? {
          kind: 'workspace_batch',
          workspaces: value.results.map((result) => ({
            workspaceId: result.workspaceId,
            path: result.path,
            ok: result.ok,
          })),
        }
      : original.output.presentationMeta(stripWorkspaceSelector(args), value);
  }
  const decorated = {
    ...original,
    parameters: extendParameters(original.parameters),
    output,
    // Delegate straight to the native implementation. The dispatcher strips
    // `_workspace` before nested dispatch, so by the time this execute runs
    // the args are already the native shape. Returning an Error here would
    // surface as a tool failure on every nested call routed back into the
    // agent scope (which happens whenever resolveExecution picks this
    // decorated copy through the agent's ScopedLayers).
    async execute(args, exec) {
      return original.execute(stripWorkspaceSelector(args), exec);
    },
  };
  if (typeof original.finalizeContent === 'function') {
    decorated.finalizeContent = (exec, result) => isBatchValue(result?.value)
      ? undefined
      : original.finalizeContent(exec, result);
  }
  if (typeof original.isConcurrencySafe === 'function') {
    decorated.isConcurrencySafe = (args) => original.isConcurrencySafe(stripWorkspaceSelector(args));
  }
  if (typeof original.presentCall === 'function') {
    decorated.presentCall = (args) => batchSelector(args)
      ? undefined
      : original.presentCall(stripWorkspaceSelector(args));
  }
  if (typeof original.presentResult === 'function') {
    decorated.presentResult = (args, result) => batchSelector(args)
      ? undefined
      : original.presentResult(stripWorkspaceSelector(args), result);
  }
  return decorated;
}

function errorResult(message, code) {
  return {
    isError: true,
    error: { message, ...(code ? { info: { name: 'Error', code } } : {}) },
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function errorEntry(root, message, code) {
  return {
    workspaceId: root.id,
    path: root.path ?? '',
    label: root.label ?? root.id,
    ok: false,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, ...(code ? { code } : {}) },
  };
}

function resultEntry(root, result) {
  if (result.isError) {
    return {
      workspaceId: root.id,
      path: root.path,
      label: root.label,
      ok: false,
      content: result.content,
      error: {
        message: result.error?.message ?? 'tool execution failed',
        ...(typeof result.error?.info?.code === 'string' ? { code: result.error.info.code } : {}),
      },
    };
  }
  return {
    workspaceId: root.id,
    path: root.path,
    label: root.label,
    ok: true,
    value: result.value,
    content: result.content,
  };
}

function callIdFor(exec, index, workspaceId) {
  return `${String(exec.callId)}:workspace:${index + 1}:${workspaceId}`;
}

async function dispatchOne(ctx, projection, exec, args, root, index) {
  if (!root.valid) return errorEntry(root, root.error ?? `workspace ${root.id} is unavailable`, 'WORKSPACE_UNAVAILABLE');
  try {
    // Keep the exact Agent identity and native arguments. The complete nested
    // DSH execution lifecycle reads the selected root through Agent.session's
    // AsyncLocalStorage-backed view, so tools remain opaque to this plugin.
    const result = await projection.run(exec.agent, root.path, () => ctx.tools.execute({
      callId: callIdFor(exec, index, root.id),
      rootCallId: exec.rootCallId ?? exec.callId,
      name: exec.name,
      arguments: args,
      signal: exec.signal,
      agent: exec.agent,
      parent: exec.token,
    }));
    return resultEntry(root, result);
  } catch (error) {
    return errorEntry(root, error instanceof Error ? error.message : String(error), 'WORKSPACE_DISPATCH_FAILED');
  }
}

function sessionIdOf(agent) {
  return typeof agent?.session?.id === 'string'
    ? agent.session.id
    : typeof agent?.id === 'string'
      ? agent.id
      : undefined;
}

function cwdOf(agent) {
  return typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : undefined;
}

// Session-with-disabled-primary cache. A disabled primary must leave the model
// with zero subworkspace surface, so schema decoration, the workspace tool,
// and the dispatch interceptors all consult the same per-session cache. The
// store's live settings feed it via `setDisabledRoots` below.
function sessionKeyOf(agent) {
  return sessionIdOf(agent) ?? cwdOf(agent);
}

export function createWorkspaceExecuteInterceptor(ctx, store, projection, batchExecutions = new WeakSet(), disabled = new Map()) {
  return async function workspaceExecute(exec, next) {
    if (!exec?.agent || exec.name === WORKSPACE_TOOL_NAME) return next();
    if (disabled.get(sessionKeyOf(exec.agent)) === true) return next();
    // A nested call issued BY THIS dispatcher carries parent=<outer exec.token>;
    // pass it straight through to the native tool. Without this guard, an
    // already-decorated agent would re-enter us for the same logical call.
    if (exec.parent !== undefined) return next();
    const rawArgs = isObject(exec.arguments) ? exec.arguments : {};
    const selector = rawArgs._workspace;
    // Intercept when the caller explicitly selected a workspace, OR when the
    // session has a non-default workspace active. We deliberately do NOT
    // depend on isDecorated here: decorated agent state races plugin load
    // order and teardown, and we want session switching (via the workspace
    // tool) to keep working even for agents that were never schema-decorated
    // (e.g. this session's agent existed before this plugin was loaded).
    let effectiveSelector = selector;
    if (effectiveSelector === undefined) {
      const lookaheadPrimary = cwdOf(exec.agent);
      if (!lookaheadPrimary) return next();
      const sessionId = sessionIdOf(exec.agent);
      const listed = await store.list(lookaheadPrimary, sessionId).catch(() => null);
      // Session selection unset or still pointing at the primary root →
      // behavior identical to no plugin. Forward along unchanged.
      if (!listed || listed.currentWorkspaceId === listed.roots[0]?.id) return next();
      effectiveSelector = listed.currentWorkspaceId;
    }
    const primary = cwdOf(exec.agent);
    if (!primary) return errorResult('workspace-aware tool calls require a session workspace cwd', 'WORKSPACE_REQUIRED');
    let selected;
    try {
      selected = await store.select(primary, sessionIdOf(exec.agent), effectiveSelector);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), 'WORKSPACE_SELECTION_FAILED');
    }
    const args = stripWorkspaceSelector(rawArgs);
    if (!selected.batch) {
      const root = selected.roots[0];
      if (!root?.valid) return errorResult(root?.error ?? 'workspace is unavailable', 'WORKSPACE_UNAVAILABLE');
      const entry = await dispatchOne(ctx, projection, exec, args, root, 0);
      if (!entry.ok) return errorResult(entry.error.message, entry.error.code);
      return {
        isError: false,
        value: entry.value,
        content: entry.content,
      };
    }
    const entries = await Promise.all(selected.roots.map((root, index) => dispatchOne(ctx, projection, exec, args, root, index)));
    const batchResult = {
      isError: false,
      value: { kind: 'workspace_batch', results: entries },
      // Around-dispatch middleware returns a complete result. DSH's public
      // normalizer then validates `value` against the agent-scoped decorated
      // tool definition and re-renders the same batch through its output
      // contract before the result reaches post-execute.
      content: renderBatch({ kind: 'workspace_batch', results: entries }),
    };
    batchExecutions.add(exec);
    return batchResult;
  };
}

export function createWorkspacePostExecuteInterceptor(batchExecutions = new WeakSet()) {
  return async function workspacePostExecute(exec, result, next) {
    if (!exec?.agent) return next();
    // Nested calls (those issued BY this dispatcher) shouldn't bypass the
    // native tool's own post-execute listeners — those listeners depend on
    // the nested result's value shape matching what the native tool produced.
    if (exec.parent !== undefined) return next();
    // An outer call we dispatched produced a batch envelope `{ kind:
    // 'workspace_batch', results }`. Native tool-owned post-execute listeners
    // (e.g. glob's result-spillage handler) do not know that shape; they assume
    // `result.value.paths` etc., and crash on ours. We must herd them: when we
    // produced a batch, accept the envelope ourselves without invoking the
    // downstream listeners.
    const value = result?.value;
    if (batchExecutions.has(exec)
      && value && typeof value === 'object' && !Array.isArray(value)
      && value.kind === 'workspace_batch') {
      return { kind: 'accept' };
    }
    return next();
  };
}

export function createWorkspacePreExecuteInterceptor(store, disabled = new Map()) {
  return async function workspacePreExecute(exec, next) {
    if (!exec?.agent || exec.name === WORKSPACE_TOOL_NAME) return next();
    if (disabled.get(sessionKeyOf(exec.agent)) === true) return next();
    // Mirror workspaceExecute: nested calls issued by this dispatcher carry
    // a parent token; native permission / sandbox listeners belong to them.
    if (exec.parent !== undefined) return next();
    const rawArgs = isObject(exec.arguments) ? exec.arguments : {};
    const selector = rawArgs._workspace;
    // Mirror the workspaceExecute gate: only "allow" (skip native permission
    // pipelines) when the call is one WE would actually intercept — i.e.
    // explicit selector, or session switched to a non-primary workspace.
    // Other calls flow through their normal pre-execute approvals so untagged
    // calls on the primary workspace are unaffected.
    if (selector === undefined) {
      const primary = cwdOf(exec.agent);
      if (!primary) return next();
      const sessionId = sessionIdOf(exec.agent);
      const listed = await store.list(primary, sessionId).catch(() => null);
      if (!listed || listed.currentWorkspaceId === listed.roots[0]?.id) return next();
    }
    // The outer call is only a composite envelope. Each selected native call
    // enters tools.execute again with its projected cwd, so permission and
    // sandbox listeners belong to those native calls, not to the envelope's
    // primary-workspace coordinates.
    return { kind: 'allow' };
  };
}

// The workspace tool definition, decoupled from where it is registered. The
// dispatcher registers this PER AGENT SCOPE (agent.ctx) rather than globally,
// so a disabled primary's session resolves no `workspace` tool at all — the
// model-facing schema never names it.
export function buildWorkspaceToolDefinition(store) {
  return {
    name: WORKSPACE_TOOL_NAME,
    description: [
      'List the primary workspace and its configured subworkspaces for this session, or change the current workspace used by native DSH tools. Use action "list" to obtain workspace IDs, "switch" with one workspaceId to make that workspace the session default, and "reset" to go back to the primary workspace.',
      'Native DSH tools receive an additional `_workspace` argument from this plugin:',
      '  - omit `_workspace` → use the session\'s current workspace (primary unless you switched);',
      '  - `_workspace: "<id>"` → run that call once in the workspace with that id;',
      '  - `_workspace: ["<id1>", "<id2>", …]` → run the same call independently in every listed workspace (results reported per workspace; a failure in one does not cancel the others);',
      '  - `_workspace: "all"` → equivalent to listing every workspace (primary + every subworkspace).',
      'The selected root becomes that call\'s native session workspace. Tool arguments are otherwise passed through unchanged, and `_workspace` redirects only that call without changing the session default.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'switch', 'reset'] },
        workspaceId: { type: 'string', description: 'A workspace ID returned by action "list". Required only for action "switch".' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          primaryPath: { type: 'string' },
          currentWorkspaceId: { type: 'string' },
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                path: { type: 'string' },
                label: { type: 'string' },
                primary: { type: 'boolean' },
                valid: { type: 'boolean' },
                error: { type: 'string' },
              },
              required: ['id', 'path', 'label', 'primary', 'valid'],
            },
          },
        },
        required: ['primaryPath', 'currentWorkspaceId', 'workspaces'],
      },
      render(_args, value) {
        const lines = [
          `Current workspace: ${value.currentWorkspaceId}`,
          ...value.workspaces.map((root) => `${root.id} ${root.valid ? 'available' : 'unavailable'} ${root.path}${root.error ? ` — ${root.error}` : ''}`),
          'Use _workspace with one ID, an array of IDs, or "all" on workspace-aware tools.',
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const primary = cwdOf(exec.agent);
      const sessionId = sessionIdOf(exec.agent);
      if (!primary || !sessionId) throw new Error('the workspace tool requires a live session workspace');
      if (!isObject(args) || !['list', 'switch', 'reset'].includes(args.action)) {
        throw new Error('action must be list, switch, or reset');
      }
      if (args.action === 'switch') {
        if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
          throw new Error('workspaceId is required for action "switch"');
        }
        await store.switch(primary, sessionId, args.workspaceId);
      } else if (args.action === 'reset') {
        await store.reset(primary, sessionId);
      }
      const listed = await store.list(primary, sessionId);
      return {
        primaryPath: listed.primaryPath,
        currentWorkspaceId: listed.currentWorkspaceId,
        workspaces: listed.roots.map((root) => ({
          id: root.id,
          path: root.path,
          label: root.label,
          primary: root.primary,
          valid: root.valid,
          ...(root.error ? { error: root.error } : {}),
        })),
      };
    },
  };
}

// Register the workspace tool on the global context. Kept for legacy wiring;
// installToolDispatcher registers the definition per agent scope instead so a
// disabled primary resolves no `workspace` tool.
export function registerWorkspaceTool(ctx, store) {
  return ctx.tools.register(buildWorkspaceToolDefinition(store));
}

export function installToolDispatcher(ctx, store, options = {}) {
  const excludedNames = new Set([WORKSPACE_TOOL_NAME, ...(options.excludeToolNames ?? [])]);
  const agentTools = new WeakMap();
  const decoratedAgents = new Set();
  const projection = options.projection ?? new WorkspaceRuntimeProjection();
  const batchExecutions = new WeakSet();
  // Session-key → boolean primary-disabled cache. Populated by refreshAgent via
  // the store (which holds the live settings value) so the three interceptors
  // read the same fact as schema decoration with no extra async work.
  const disabledRoots = new Map();
  let onDisabledChangePending = false;
  let refreshing = false;
  let refreshScheduled = false;

  const toolsFor = (agent) => agentTools.get(agent);

  function nativeDefinitions() {
    const definitions = new Map();
    for (const schema of ctx.tools.schemas?.() ?? []) {
      const name = schema?.name;
      if (typeof name !== 'string' || excludedNames.has(name)) continue;
      const original = ctx.tools.get(name);
      if (original) definitions.set(name, original);
    }
    return definitions;
  }

  // `store.isEnabled` is the source of truth for the effective on/off state:
  // it resolves legacy no-flag records to enabled for compatibility and lets
  // the schema-driven default handle genuinely new primaries. The fallback
  // default of `true` applies only when no store is wired in at all.
  const readEnabled = options.isEnabled ?? ((primary) => store?.isEnabled?.(primary) ?? true);

  function clearAgent(agent, current) {
    for (const record of current.values()) record.dispose?.();
    current.clear();
    decoratedAgents.delete(agent);
    projection.disposeAgent(agent);
  }

  function refreshAgent(agent) {
    if (!agent?.ctx) {
      ctx.logger?.warn?.('mv-dsh-subworkspace: refreshAgent skipped — agent.ctx is unavailable (agent likely created before the plugin loaded)');
      return;
    }
    const primary = cwdOf(agent);
    const enabled = primary ? readEnabled(primary) !== false : true;
    const key = sessionKeyOf(agent);
    const wasDisabled = disabledRoots.get(key) === true;
    if (key !== undefined) disabledRoots.set(key, !enabled);
    const current = toolsFor(agent) ?? new Map();
    if (!enabled) {
      // Disabled primary: remove every shadow (including `workspace`) so both
      // the schema and the dispatch plane carry no subworkspace surface.
      clearAgent(agent, current);
      agentTools.set(agent, current);
      if (!wasDisabled) queueDisabledChange();
      return;
    }
    try {
      projection.install(agent);
    } catch (error) {
      ctx.logger?.warn?.(`mv-dsh-subworkspace: cannot install workspace projection: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Resolve through the scoped context. Cordis returns a traceable service
    // receiver, so register() owns the shadow in this Agent's fiber even when
    // the Agent composition did not declare a direct `tools` property.
    const scopedTools = agent.ctx.get?.('tools');
    if (!scopedTools?.register) {
      ctx.logger?.warn?.('mv-dsh-subworkspace: refreshAgent skipped — tools service is not yet reachable from agent scope');
      return;
    }
    const native = nativeDefinitions();
    // The scope's own `workspace` registration, registered on the same
    // plane as the shadows so it turns on and off with them.
    if (!current.has(WORKSPACE_TOOL_NAME)) {
      try {
        const dispose = scopedTools.register(buildWorkspaceToolDefinition(store));
        current.set(WORKSPACE_TOOL_NAME, { original: null, dispose, managed: true });
      } catch (error) {
        ctx.logger?.warn?.(`mv-dsh-subworkspace: cannot register the workspace tool: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [name, original] of native) {
      const prior = current.get(name);
      if (original === prior?.original) continue;
      prior?.dispose?.();
      current.delete(name);
      if (!original) continue;
      try {
        const dispose = scopedTools.register(decorateToolDefinition(original));
        current.set(name, { original, dispose });
      } catch (error) {
        ctx.logger?.warn?.(`mv-dsh-subworkspace: cannot decorate tool ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [name, prior] of current) {
      if (name === WORKSPACE_TOOL_NAME || native.has(name)) continue;
      prior.dispose?.();
      current.delete(name);
    }
    agentTools.set(agent, current);
    const isNewlyEnabled = !decoratedAgents.has(agent);
    decoratedAgents.add(agent);
    if (wasDisabled || isNewlyEnabled) queueDisabledChange();
  }

  function queueDisabledChange() {
    if (onDisabledChangePending) return;
    onDisabledChangePending = true;
    queueMicrotask(() => {
      onDisabledChangePending = false;
      options.onDisabledChange?.(new Map(disabledRoots));
    });
  }

  function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      const known = new Set(decoratedAgents);
      for (const agent of options.enumerateAgents?.() ?? ctx.get?.('agents')?.list?.() ?? []) known.add(agent);
      for (const agent of known) refreshAgent(agent);
    } finally {
      refreshing = false;
    }
  }

  function scheduleRefresh() {
    if (refreshing || refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      refreshAll();
    });
  }

  const disposePreExecute = ctx.on(
    'tools/pre-execute',
    createWorkspacePreExecuteInterceptor(store, disabledRoots),
    { prepend: true },
  );
  const disposePostExecute = ctx.on(
    'tools/post-execute',
    createWorkspacePostExecuteInterceptor(batchExecutions),
    { prepend: true },
  );
  const disposeExecute = ctx.on(
    'tools/execute',
    createWorkspaceExecuteInterceptor(ctx, store, projection, batchExecutions, disabledRoots),
  );
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    refreshing = true;
    try { refreshAgent(agent); } finally { refreshing = false; }
  });
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    agentTools.delete(agent);
    decoratedAgents.delete(agent);
    disabledRoots.delete(sessionKeyOf(agent));
    projection.disposeAgent(agent);
    store.clearSession?.(sessionIdOf(agent));
  });
  const disposeChanged = ctx.on('tools/change', scheduleRefresh);
  const disposeEnabledChanged = typeof store?.subscribe === 'function'
    ? store.subscribe(() => scheduleRefresh())
    : null;
  refreshAll();

  return () => {
    disposeEnabledChanged?.();
    disposeChanged?.();
    disposeDisposed?.();
    disposeCreated?.();
    disposeExecute?.();
    disposePostExecute?.();
    disposePreExecute?.();
    for (const agent of decoratedAgents) {
      for (const record of toolsFor(agent)?.values() ?? []) record.dispose?.();
    }
    decoratedAgents.clear();
    disabledRoots.clear();
    projection.dispose();
  };
}
