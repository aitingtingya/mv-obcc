// DSH settings namespace owned by @mv-aide/mv-dsh-subworkspace.

import { EMPTY_STATE, STORE_VERSION } from './store.js';

export const SUBWORKSPACE_SETTINGS_NAMESPACE = 'mv-dsh-subworkspace';

export function buildSubworkspaceSettingsSchema(z) {
  if (!z || typeof z.object !== 'function' || typeof z.dict !== 'function') {
    throw new Error('installed DSH Schemastery does not expose object()/dict()');
  }
  const child = z.object({
    id: z.string(),
    path: z.string(),
    label: z.string(),
  });
  const workspace = z.object({
    // Per-primary enable toggle. Explicitly true/false when persisted; a
    // missing flag means the entry predates the toggle (legacy) or belongs
    // to a never-configured row the settings card displays as off. `enabled`
    // deliberately carries NO schema default: schemastery's simplify() folds
    // any persisted value equal to the default into null, and DSH's settings
    // persistence runs simplify on mutate — with `default(false)` an explicit
    // "turn off" would be collapsed to null and the save rejected. Making the
    // flag defaultless lets an explicit false persist as a real value.
    enabled: z.boolean(),
    children: z.array(child).default([]),
  });
  return z.object({
    version: z.number().default(STORE_VERSION),
    workspaces: z.dict(workspace).default({}),
  });
}

export async function createSubworkspaceSettingsSchema() {
  const loaded = await import('@deepseek-ai/schemastery');
  const z = loaded.default ?? loaded;
  return buildSubworkspaceSettingsSchema(z);
}

export function installSubworkspaceSettings(ctx, store) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['settings'], async (settingsCtx) => {
    try {
      const settings = typeof settingsCtx.get === 'function'
        ? settingsCtx.get('settings')
        : settingsCtx.settings;
      if (!settings?.register) return;
      const schema = await createSubworkspaceSettingsSchema();
      const scope = settings.register(SUBWORKSPACE_SETTINGS_NAMESPACE, schema, {
        base: EMPTY_STATE,
        applies: 'live',
      });
      const detach = store.attach(scope);
      settingsCtx.effect?.(() => detach, 'mv-dsh-subworkspace: settings store');
    } catch (error) {
      ctx.logger?.warn?.(`mv-dsh-subworkspace settings unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
