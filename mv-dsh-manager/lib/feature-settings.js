// DSH profile settings for @mv-aide/mv-dsh-manager.

export const MANAGER_SETTINGS_NAMESPACE = 'mv-dsh-manager';

export const DEFAULT_MANAGER_FEATURES = Object.freeze({
  pluginManagementUiEnabled: true,
  skillManagementUiEnabled: true,
  presetManagementUiEnabled: true,
  modelCapabilitiesUiEnabled: true,
  fileDropEnabled: true,
  recursiveCommandPickerEnabled: true,
  planReviewEnhancementEnabled: true,
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

async function createSchema() {
  const loaded = await import('@deepseek-ai/schemastery');
  const z = loaded.default ?? loaded;
  return z.object({
    pluginManagementUiEnabled: z.boolean().default(true),
    skillManagementUiEnabled: z.boolean().default(true),
    presetManagementUiEnabled: z.boolean().default(true),
    modelCapabilitiesUiEnabled: z.boolean().default(true),
    fileDropEnabled: z.boolean().default(true),
    recursiveCommandPickerEnabled: z.boolean().default(true),
    planReviewEnhancementEnabled: z.boolean().default(true),
    commandPickerMaxLeaves: z.number().default(50),
  });
}

export function installManagerFeatureSettings(ctx, options = {}) {
  let current = DEFAULT_MANAGER_FEATURES;
  const listeners = new Set();
  const log = options.log ?? ((message) => ctx?.logger?.warn?.(message));

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

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['settings'], async (settingsCtx) => {
      try {
        const schema = await createSchema();
        const settings = typeof settingsCtx?.get === 'function'
          ? settingsCtx.get('settings')
          : settingsCtx?.settings;
        if (!settings || typeof settings.register !== 'function') return;
        const scope = settings.register(MANAGER_SETTINGS_NAMESPACE, schema, {
          base: DEFAULT_MANAGER_FEATURES,
          applies: 'live',
          validate: validateManagerFeatures,
        });
        publish(scope.get());
        const unwatch = scope.watch((next) => { publish(next); });
        settingsCtx.effect?.(() => () => {
          unwatch?.();
          publish(DEFAULT_MANAGER_FEATURES);
        }, 'mv-dsh-manager: feature settings');
      } catch (error) {
        log?.(`mv-dsh-manager settings unavailable; keeping defaults: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
