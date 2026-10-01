// Plugin-owned settings for @mv-aide/mv-dsh-manager.
//
// See mv-agent/lib/feature-settings.js: the mv-AIDE store is authoritative on
// ≥0.1.7 (whose DSH replaced `settings.register` with configuration forms),
// while a released ≤0.1.6 scope stays the editing surface and is mirrored into
// the store.

import { createSettingsScope, subscribeSettingsNamespace } from '../../mv-dsh-settings/lib/store.js';

export const MANAGER_SETTINGS_NAMESPACE = 'mv-dsh-manager';

export const DEFAULT_MANAGER_FEATURES = Object.freeze({
  pluginManagementUiEnabled: true,
  skillManagementUiEnabled: true,
  presetManagementUiEnabled: true,
  modelCapabilitiesUiEnabled: true,
  fileDropEnabled: true,
  recursiveCommandPickerEnabled: true,
  planReviewEnhancementEnabled: true,
  historyRecallEnabled: true,
  commandPickerMaxLeaves: 50,
});

export function normalizeManagerFeatures(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = { ...DEFAULT_MANAGER_FEATURES };
  for (const key of Object.keys(DEFAULT_MANAGER_FEATURES)) {
    const fallback = DEFAULT_MANAGER_FEATURES[key];
    if (typeof fallback === 'boolean' && typeof source[key] === 'boolean') {
      normalized[key] = source[key];
    } else if (typeof fallback === 'number' && Number.isFinite(source[key])) {
      normalized[key] = Math.trunc(source[key]);
    }
  }
  return Object.freeze(normalized);
}

export function validateManagerFeatures(value) {
  const normalized = normalizeManagerFeatures(value);
  if (normalized.commandPickerMaxLeaves < 10 || normalized.commandPickerMaxLeaves > 200) {
    throw new Error('commandPickerMaxLeaves must be between 10 and 200');
  }
  return normalized;
}

async function loadSettingsSchema() {
  const loaded = await import('@deepseek-ai/schemastery');
  return buildManagerSettingsSchema(loaded.default ?? loaded);
}

/**
 * The released-settings schema, built from an injected Schemastery instance.
 *
 * Exported and parameterized the same way the subworkspace package builds its
 * schema: that instance can only be resolved inside a DSH profile, so a test
 * that wants to exercise the adoption path supplies it rather than skipping.
 */
export function buildManagerSettingsSchema(z) {
  return z.object({
    pluginManagementUiEnabled: z.boolean().default(true),
    skillManagementUiEnabled: z.boolean().default(true),
    presetManagementUiEnabled: z.boolean().default(true),
    modelCapabilitiesUiEnabled: z.boolean().default(true),
    fileDropEnabled: z.boolean().default(true),
    recursiveCommandPickerEnabled: z.boolean().default(true),
    planReviewEnhancementEnabled: z.boolean().default(true),
    historyRecallEnabled: z.boolean().default(true),
    commandPickerMaxLeaves: z.number().default(50),
  });
}

/**
 * Adopt a released DSH settings scope when the installed DSH still has one
 * (≤0.1.6); its card stays the editing surface there, and its values are
 * mirrored into the plugin-owned store.
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
        const dshScope = settings.register(MANAGER_SETTINGS_NAMESPACE, schema, {
          base: DEFAULT_MANAGER_FEATURES,
          applies: 'live',
          validate: validateManagerFeatures,
        });
        if (!dshScope || typeof dshScope.get !== 'function') return;
        adopted = true;
        publish(dshScope.get());
        dshScope.watch?.((next) => publish(next));
        const patch = {};
        for (const [key, value] of Object.entries(dshScope.get() ?? {})) {
          if (value !== DEFAULT_MANAGER_FEATURES[key]) patch[key] = value;
        }
        if (Object.keys(patch).length > 0) await scope.apply({ set: patch });
      } catch (error) {
        options.log?.(`mv-dsh-manager settings migration skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        resolve();
      }
    });
    setTimeout(resolve, ADOPT_SETTINGS_TIMEOUT_MS).unref?.();
  });
  return adopted;
}

export function installManagerFeatureSettings(ctx, options = {}) {
  let current = DEFAULT_MANAGER_FEATURES;
  const listeners = new Set();
  const log = options.log ?? ((message) => ctx?.logger?.warn?.(message));
  const state = { dshAdopted: false };

  const publish = (value) => {
    let next;
    try {
      next = validateManagerFeatures(value);
    } catch (error) {
      log?.(`mv-dsh-manager settings rejected: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const previous = current;
    current = next;
    for (const listener of listeners) listener(next, previous);
  };

  const scope = createSettingsScope({
    namespace: MANAGER_SETTINGS_NAMESPACE,
    defaults: DEFAULT_MANAGER_FEATURES,
    validate: validateManagerFeatures,
    log,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
  });
  scope.subscribe((next) => publish(next));
  const unsubscribeScope = subscribeSettingsNamespace(MANAGER_SETTINGS_NAMESPACE, (next) => publish(next));

  void (async () => {
    await scope.load();
    if (!state.dshAdopted) publish(scope.get());
    if (await adoptDshSettingsScope(ctx, scope, publish, { ...options, log })) {
      state.dshAdopted = true;
      scope.setManage('dsh');
    }
  })().catch((error) => {
    log?.(`mv-dsh-manager settings store unavailable; keeping defaults: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      unsubscribeScope();
      scope.release();
      publish(DEFAULT_MANAGER_FEATURES);
    }, 'mv-dsh-manager: feature settings');
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The live scope, so the settings route can read/write it. */
    scope,
    /** `'dsh'` while a released DSH settings card owns editing, else `'panel'`. */
    manage: () => scope.manage(),
  };
}
