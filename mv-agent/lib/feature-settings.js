// Plugin-owned settings for @mv-aide/mv-agent.
//
// The released DSH settings plane is not a dependency any more: ≤0.1.6 exposed
// `settings.register` and ≥0.1.7 replaced it with plugin configuration forms.
// The mv-AIDE store (`~/.mv-aide/dsh/settings.json`) is authoritative here; a
// released DSH scope is read exactly once, as a migration seed, and never
// written.

import { createSettingsScope, subscribeSettingsNamespace } from '../../mv-dsh-settings/lib/store.js';

export const AGENT_SETTINGS_NAMESPACE = 'mv-agent';

export const DEFAULT_AGENT_FEATURES = Object.freeze({
  bridgeEnabled: true,
  ideToolsEnabled: true,
  terminalToolsEnabled: true,
  diffReviewEnabled: true,
  slashCommandEnabled: true,
  autoEnterVaultWorkspaceEnabled: true,
  selectionContextEnabled: true,
  mentionSteeringEnabled: true,
  selectionMaxChars: 6000,
  selectionDebounceMs: 400,
  hoverSidebarEnabled: true,
  imageAutoFitEnabled: true,
});

const NUMBER_RANGES = Object.freeze({
  selectionMaxChars: [256, 50000],
  selectionDebounceMs: [50, 3000],
});

export function normalizeAgentFeatures(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = { ...DEFAULT_AGENT_FEATURES };
  for (const key of Object.keys(DEFAULT_AGENT_FEATURES)) {
    const fallback = DEFAULT_AGENT_FEATURES[key];
    if (typeof fallback === 'boolean' && typeof source[key] === 'boolean') {
      normalized[key] = source[key];
    } else if (typeof fallback === 'number' && Number.isFinite(source[key])) {
      normalized[key] = Math.trunc(source[key]);
    }
  }
  return Object.freeze(normalized);
}

export function validateAgentFeatures(value) {
  const normalized = normalizeAgentFeatures(value);
  for (const [field, [minimum, maximum]] of Object.entries(NUMBER_RANGES)) {
    const current = normalized[field];
    if (current < minimum || current > maximum) {
      throw new Error(`${field} must be between ${minimum} and ${maximum}`);
    }
  }
  return normalized;
}

/**
 * The released-settings schema, built from an injected Schemastery instance.
 *
 * Exported and parameterized the same way the subworkspace package builds its
 * schema: that instance can only be resolved inside a DSH profile, so a test
 * that wants to exercise the adoption path supplies it rather than skipping.
 */
export function buildAgentSettingsSchema(z) {
  return z.object({
    bridgeEnabled: z.boolean().default(true),
    ideToolsEnabled: z.boolean().default(true),
    terminalToolsEnabled: z.boolean().default(true),
    diffReviewEnabled: z.boolean().default(true),
    slashCommandEnabled: z.boolean().default(true),
    autoEnterVaultWorkspaceEnabled: z.boolean().default(true),
    selectionContextEnabled: z.boolean().default(true),
    mentionSteeringEnabled: z.boolean().default(true),
    selectionMaxChars: z.number().default(6000),
    selectionDebounceMs: z.number().default(400),
    hoverSidebarEnabled: z.boolean().default(true),
    imageAutoFitEnabled: z.boolean().default(true),
  });
}

async function loadSettingsSchema() {
  const loaded = await import('@deepseek-ai/schemastery');
  return buildAgentSettingsSchema(loaded.default ?? loaded);
}

/**
 * Adopt a released DSH settings scope when the installed DSH still has one
 * (≤0.1.6). That scope stays the editing surface on those versions — its card
 * is the one users already know — and its values are mirrored into the mv-AIDE
 * store so an upgrade to ≥0.1.7 keeps them.
 * @returns true when a released scope owns editing.
 */
/**
 * How long activation waits for a released settings scope to appear.
 *
 * `ctx.inject` resolves its callback from the fiber once the declared service
 * is ready, which is *after* the caller returns — so the callback cannot report
 * its outcome by assigning a captured variable and letting the caller read it
 * back. Awaiting the promise is what makes the answer real; the timer is the
 * floor for a DSH that has no settings service at all and therefore never calls
 * back. It is unref'd, so a runtime that never answers cannot hold the process
 * open.
 */
const ADOPT_SETTINGS_TIMEOUT_MS = 1500;

async function adoptDshSettingsScope(ctx, scope, publish, options) {
  if (typeof ctx?.inject !== 'function') return false;
  if (options.adoptDshSettings === false) return false;
  let adopted = false;
  await new Promise((resolve) => {
    ctx.inject(['settings'], async (settingsCtx) => {
      try {
        const settings = typeof settingsCtx?.get === 'function'
          ? settingsCtx.get('settings')
          : settingsCtx?.settings;
        if (!settings || typeof settings.register !== 'function') return;
        const schema = await (options.createSchema ?? loadSettingsSchema)();
        const dshScope = settings.register(AGENT_SETTINGS_NAMESPACE, schema, {
          base: DEFAULT_AGENT_FEATURES,
          applies: 'live',
          validate: validateAgentFeatures,
        });
        if (!dshScope || typeof dshScope.get !== 'function') return;
        adopted = true;
        publish(dshScope.get());
        dshScope.watch?.((next) => publish(next));
        // Mirror into the plugin-owned store once, so the panel and a later
        // 0.1.7 runtime show the same switches.
        const patch = {};
        for (const [key, value] of Object.entries(dshScope.get() ?? {})) {
          if (value !== DEFAULT_AGENT_FEATURES[key]) patch[key] = value;
        }
        if (Object.keys(patch).length > 0) await scope.apply({ set: patch });
      } catch (error) {
        options.log?.(`mv-agent settings migration skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        resolve();
      }
    });
    setTimeout(resolve, ADOPT_SETTINGS_TIMEOUT_MS).unref?.();
  });
  return adopted;
}

/** Install the plugin-owned settings scope as the live feature policy. */
export function installAgentFeatureSettings(ctx, options = {}) {
  let current = DEFAULT_AGENT_FEATURES;
  const listeners = new Set();
  const log = options.log ?? ((message) => ctx?.logger?.warn?.(message));
  const state = { dshAdopted: false };

  const publish = (value) => {
    let next;
    try {
      next = validateAgentFeatures(value);
    } catch (error) {
      log?.(`mv-agent settings rejected: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const previous = current;
    current = next;
    for (const listener of listeners) listener(next, previous);
  };

  const scope = createSettingsScope({
    namespace: AGENT_SETTINGS_NAMESPACE,
    defaults: DEFAULT_AGENT_FEATURES,
    validate: validateAgentFeatures,
    log,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
  });
  scope.subscribe((next) => publish(next));
  const unsubscribeScope = subscribeSettingsNamespace(AGENT_SETTINGS_NAMESPACE, (next) => publish(next));

  void (async () => {
    await scope.load();
    if (!state.dshAdopted) publish(scope.get());
    if (await adoptDshSettingsScope(ctx, scope, publish, { ...options, log })) {
      state.dshAdopted = true;
      scope.setManage('dsh');
    }
  })().catch((error) => {
    log?.(`mv-agent settings store unavailable; keeping defaults: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      unsubscribeScope();
      scope.release();
      publish(DEFAULT_AGENT_FEATURES);
    }, 'mv-agent: feature settings');
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The live scope, so the manager's settings route can read/write it. */
    scope,
    /** `'dsh'` while a released DSH settings card owns editing, else `'panel'`. */
    manage: () => scope.manage(),
  };
}
