// DSH profile settings for @mv-aide/mv-agent.
//
// The settings service is optional: older DSH builds and isolated package
// tests keep the exact pre-settings behavior through DEFAULT_AGENT_FEATURES.

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

async function createSchema() {
  const loaded = await import('@deepseek-ai/schemastery');
  const z = loaded.default ?? loaded;
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

/** Install an optional live settings source without making settings a hard dependency. */
export function installAgentFeatureSettings(ctx, options = {}) {
  let current = DEFAULT_AGENT_FEATURES;
  const listeners = new Set();
  const log = options.log ?? ((message) => ctx?.logger?.warn?.(message));

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

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['settings'], async (settingsCtx) => {
      try {
        const schema = await createSchema();
        const settings = typeof settingsCtx?.get === 'function'
          ? settingsCtx.get('settings')
          : settingsCtx?.settings;
        if (!settings || typeof settings.register !== 'function') return;
        const scope = settings.register(AGENT_SETTINGS_NAMESPACE, schema, {
          base: DEFAULT_AGENT_FEATURES,
          applies: 'live',
          validate: validateAgentFeatures,
        });
        publish(scope.get());
        const unwatch = scope.watch((next) => { publish(next); });
        settingsCtx.effect?.(() => () => {
          unwatch?.();
          publish(DEFAULT_AGENT_FEATURES);
        }, 'mv-agent: feature settings');
      } catch (error) {
        log?.(`mv-agent settings unavailable; keeping defaults: ${error instanceof Error ? error.message : String(error)}`);
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
