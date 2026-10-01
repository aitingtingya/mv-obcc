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

/**
 * Producer attribution for a message an mv-aide plugin injects into a session.
 *
 * The two released session formats disagree, with no overlapping shape:
 *   - v3 (≤0.1.6) demands the plugin *wrapper*: `kind` must be `'plugin'` and
 *     `plugin` must be a non-empty string, so `{kind:'plugin',plugin:id}`.
 *   - v4 (≥0.1.7) refuses `kind === 'plugin'` outright ("format v4 message
 *     requires a producer-owned source kind"); its released V3→V4 migration
 *     rewrites `{kind:'plugin',plugin:X}` into `{kind:'plugin:X'}` and drops
 *     `plugin`. A wrapped source created at runtime is therefore rejected at
 *     row admission, which fails the session's own checkpoint flush.
 *
 * The live session header carries its logical format version, and that is the
 * only fact consulted here — never a package version string.
 * @param agent - the exact receiving agent whose session owns the message.
 * @param pluginId - this plugin's own producer identity.
 * @returns the source record valid for that session's format version.
 */
export function pluginMessageSource(agent, pluginId) {
  const version = agent?.session?.header?.version;
  return typeof version === 'number' && version >= 4
    ? { kind: `plugin:${pluginId}` }
    : { kind: 'plugin', plugin: pluginId };
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
 * How to show one preset to the user, in released-seam order.
 *
 * ≤0.1.6: the settings controller opens the preset's own directory
 * (`openAgentPresetDirectory`). ≥0.1.7 dropped presets-as-directories and that
 * method with them, but the controller can still open an exact file
 * (`openTextFile(path, signal)`), which is what a preset author needs — the
 * caller resolves the document path from its own projection.
 *
 * The pre-0.1.2 `apiProxy.agentPresets.openDocument` seam and the
 * `sessionPersistence.inspect` shortcut are gone: the oldest supported release
 * is 0.1.2, and neither face exists in a released DSH.
 */
function alphaPresetOpener(ctx) {
  const controller = safeGet(ctx, 'settingsController');
  if (typeof controller?.openAgentPresetDirectory === 'function') {
    return Object.freeze({
      adapter: 'directory',
      async open(presetId) {
        return controller.openAgentPresetDirectory(presetId, new AbortController().signal);
      },
    });
  }
  if (typeof controller?.openTextFile === 'function') {
    return Object.freeze({
      adapter: 'document',
      async open(presetId, options = {}) {
        const target = typeof options?.path === 'string' && options.path.length > 0 ? options.path : null;
        if (target === null) {
          throw new Error(`preset "${presetId}" has no authoring document to open`);
        }
        await controller.openTextFile(target, new AbortController().signal);
        return { opened: true, path: target };
      },
    });
  }
  return null;
}

export function resolvePresetOpener(ctx) {
  // The released seam: every supported DSH (0.1.2+) exposes the settings
  // controller; the pre-0.1.2 `apiProxy` face no longer exists anywhere.
  return alphaPresetOpener(ctx);
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
