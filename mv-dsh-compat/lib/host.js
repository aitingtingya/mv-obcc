// Narrow Host-realm projections. Every lookup is structural and fail-closed;
// version strings never authorize a call.

export function safeGet(ctx, name) {
  try {
    const value = ctx?.get?.(name);
    if (value !== undefined) return value;
  } catch {
    // Try the older reflected service face.
  }
  try {
    const value = ctx?.reflect?.get?.(name);
    if (value !== undefined) return value;
  } catch {
    // No compatible service face.
  }
  try {
    return ctx?.[name];
  } catch {
    // Reflect proxies may reject undeclared property reads.
  }
  return undefined;
}

export function resolveHostSettings(ctx) {
  const settings = safeGet(ctx, 'settings');
  return typeof settings?.register === 'function'
    ? Object.freeze({ adapter: 'preview', settings })
    : null;
}

export function resolveHostTools(ctx) {
  const tools = safeGet(ctx, 'tools');
  const agents = safeGet(ctx, 'agents');
  if (!tools || typeof tools.execute !== 'function' || typeof tools.register !== 'function'
      || typeof tools.schemas !== 'function' || typeof tools.get !== 'function'
      || typeof ctx?.on !== 'function') return null;
  return Object.freeze({
    adapter: 'preview',
    tools,
    agents: typeof agents?.list === 'function' ? agents : undefined,
    on: typeof ctx?.on === 'function' ? ctx.on.bind(ctx) : undefined,
  });
}

/**
 * Read one complete replay-validated session log without touching the live
 * client's paginated conversation window. Both the frozen preview baseline
 * and current Alpha expose this structural contract through sessionQuery.
 */
export function resolveSessionLogReader(ctx) {
  const sessionQuery = safeGet(ctx, 'sessionQuery');
  if (typeof sessionQuery?.readSession !== 'function') return null;
  return Object.freeze({
    adapter: 'structural',
    readSession: sessionQuery.readSession.bind(sessionQuery),
  });
}

/**
 * Borrow a session's immutable view without the replay-validated full read.
 * The persistence coordinator returns a frozen snapshot whose events are the
 * live session's own cached frozen log (zero structuredClone, zero replay
 * validation), so reading history for a very large live session stays a
 * linear filter instead of freezing the host event loop for tens of seconds.
 * Callers must treat the borrowed events as read-only. Fail-closed: an absent
 * service or a missing inspect face yields null and callers fall back to
 * resolveSessionLogReader.
 */
export function resolveSessionInspector(ctx) {
  const persistence = safeGet(ctx, 'sessionPersistence');
  if (typeof persistence?.inspect !== 'function') return null;
  return Object.freeze({
    adapter: 'structural',
    inspect: persistence.inspect.bind(persistence),
  });
}

function previewPresetOpener(ctx) {
  const apiProxy = safeGet(ctx, 'apiProxy');
  const openDocument = apiProxy?.agentPresets?.openDocument;
  if (typeof openDocument !== 'function') return null;
  return Object.freeze({
    adapter: 'preview',
    async open(presetId) {
      const response = await openDocument({
        rpcId: `mv-dsh-manager:${Date.now()}:${Math.random().toString(16).slice(2)}`,
        payload: { agentPreset: presetId },
      });
      if (!response?.result?.ok) {
        throw new Error(response?.result?.error?.message || `DSH refused to open preset "${presetId}"`);
      }
      return response.result.value;
    },
  });
}

function alphaPresetOpener(ctx) {
  const controller = safeGet(ctx, 'settingsController');
  if (typeof controller?.openAgentPresetDirectory !== 'function') return null;
  return Object.freeze({
    adapter: 'alpha',
    async open(presetId) {
      return controller.openAgentPresetDirectory(presetId, new AbortController().signal);
    },
  });
}

export function resolvePresetOpener(ctx) {
  // Preserve the proven preview seam whenever both are present.
  return previewPresetOpener(ctx) ?? alphaPresetOpener(ctx);
}

export function resolveAgentPresets(ctx) {
  const service = safeGet(ctx, 'agentPresets');
  return service && typeof service.list === 'function' ? service : null;
}

export function resolveModelSettings(ctx) {
  const settings = safeGet(ctx, 'settings');
  const llm = safeGet(ctx, 'llm');
  return Object.freeze({ adapter: 'preview', settings, llm });
}
