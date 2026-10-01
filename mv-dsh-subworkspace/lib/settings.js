// Settings namespace owned by @mv-aide/mv-dsh-subworkspace.
//
// The associated-roots document is the one piece of mv-AIDE state that used to
// live *only* in DSH settings. On ≥0.1.7 there is no registration API any more,
// so the plugin-owned store (`~/.mv-aide/dsh/settings.json`) becomes the
// authority; a released ≤0.1.6 scope is still adopted as the live surface and
// mirrored into that store.

import { createSettingsScope } from '../../mv-dsh-settings/lib/store.js';
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

/**
 * The store keeps running on plugin-owned settings, and adopts a released DSH
 * scope (≤0.1.6) as the editing surface when one still exists. Either way the
 * effective document is mirrored into the plugin-owned file, so an upgrade to
 * ≥0.1.7 keeps the associated roots.
 * @param ctx - host plugin context.
 * @param store - subworkspace runtime store (`attach(scope)`).
 * @param options - `filePath`/`log`/`adoptDshSettings` overrides for tests.
 */
export async function installSubworkspaceSettings(ctx, store, options = {}) {
  const log = options.log ?? ((message) => ctx?.logger?.warn?.(message));
  const scope = createSettingsScope({
    namespace: SUBWORKSPACE_SETTINGS_NAMESPACE,
    defaults: EMPTY_STATE,
    log,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
  });
  await scope.load().catch((error) => {
    log?.(`mv-dsh-subworkspace settings store unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });

  const adopted = options.adoptDshSettings === false
    ? null
    : await adoptDshScope(ctx, scope, log);
  const detach = store.attach(adopted ?? scope);
  const unbridge = adopted ? bridgeAdoptedScope(scope, adopted, log) : () => undefined;
  const discovered = store.snapshot?.();
  if (adopted && discovered && Object.keys(discovered.workspaces ?? {}).length > 0) {
    await scope.replace(discovered).catch(() => undefined);
  }
  return () => {
    unbridge();
    detach();
  };
}

/**
 * The `{ version, workspaces }` section both scopes speak, in a canonical
 * shape: stable key order (so two equal sections compare equal however each
 * side built them), booleans for `enabled` (the released schema requires one,
 * and a record persisted before the toggle existed means "enabled"), and only
 * complete child records (the store drops the rest).
 */
function normalizeSection(value) {
  const workspaces = {};
  const source = value?.workspaces;
  for (const [primary, entry] of Object.entries(source && typeof source === 'object' && !Array.isArray(source) ? source : {})) {
    const children = Array.isArray(entry?.children)
      ? entry.children
        .filter((child) => child && typeof child === 'object'
          && typeof child.id === 'string' && typeof child.path === 'string' && typeof child.label === 'string')
        .map((child) => ({ id: child.id, path: child.path, label: child.label }))
      : [];
    workspaces[primary] = { enabled: entry?.enabled === false ? false : true, children };
  }
  return {
    version: Number.isFinite(value?.version) ? value.version : STORE_VERSION,
    workspaces,
  };
}

function sameSection(left, right) {
  return JSON.stringify(normalizeSection(left)) === JSON.stringify(normalizeSection(right));
}

/**
 * Seed the plugin-owned document from an adopted released scope at boot.
 *
 * Only a released section that actually owns associated roots is mirrored: a
 * section with none is the signature of a profile whose own settings document
 * never held them, and mirroring it would overwrite the plugin-owned document —
 * including a legacy import that seeded the associations before this plugin
 * mounted (the manager and this plugin activate in an order DSH does not fix).
 * "No primaries" cannot mean "the user removed them": the store drops a primary
 * only by keeping it with `enabled:false` and no children.
 * @param mirror - the plugin-owned scope to write.
 * @param section - the released scope's resolved value.
 * @returns whether the mirror was written.
 */
export async function mirrorReleasedSection(mirror, section) {
  if (Object.keys(section?.workspaces ?? {}).length === 0) return false;
  // Overlay onto the stored user layer rather than replacing the namespace:
  // `replace` drops every key this section does not speak for, and one of those
  // is the manager's one-time legacy-import marker. Losing it would let the
  // import run again and reseed associations the user has since changed.
  const stored = typeof mirror.user === 'function' ? mirror.user() : {};
  await mirror.replace({ ...stored, ...normalizeSection(section) });
  return true;
}

/**
 * Keep an adopted released scope and the plugin-owned document in step.
 *
 * Adopting a released scope makes it the surface the store reads and writes, so
 * a write that lands only in the plugin-owned document would otherwise never
 * reach the running store: the manager's one-time legacy import seeds exactly
 * that document, and without this bridge the seed sat on disk while the roots
 * route kept answering with the pre-migration snapshot (the file was right, the
 * live store was not). The reverse direction keeps the durable mirror current,
 * so moving to a DSH without `settings.register` finds the same associations
 * instead of the section as it stood at boot.
 *
 * Both directions compare before writing, so the two watchers settle instead of
 * echoing each other. Only the section's own keys travel: the plugin-owned
 * document's other keys (the manager's import marker) are neither sent to the
 * released scope nor dropped from the mirror.
 * @param scope - the plugin-owned mv-AIDE scope.
 * @param adopted - the released DSH scope the store is attached to.
 * @param log - diagnostic sink.
 * @returns an unsubscribe for both watchers.
 */
export function bridgeAdoptedScope(scope, adopted, log) {
  const report = (direction) => (error) => {
    log?.(`mv-dsh-subworkspace settings bridge (${direction}) skipped: ${error instanceof Error ? error.message : String(error)}`);
  };
  const unwatchOwn = scope.watch((next) => {
    if (typeof adopted.replace !== 'function' || sameSection(adopted.get?.(), next)) return;
    Promise.resolve(adopted.replace(normalizeSection(next))).catch(report('to DSH'));
  });
  const unwatchAdopted = adopted.watch?.((next) => {
    if (sameSection(scope.get(), next)) return;
    // Overlay onto the stored user layer so the plugin-owned document keeps the
    // keys this section does not speak for.
    Promise.resolve(scope.replace({ ...scope.user?.(), ...normalizeSection(next) })).catch(report('to store'));
  }) ?? null;
  return () => {
    unwatchOwn?.();
    unwatchAdopted?.();
  };
}

/** Register the released DSH settings scope, when the installed DSH has one. */
async function adoptDshScope(ctx, mirror, log) {
  if (typeof ctx?.inject !== 'function') return null;
  let resolved;
  await new Promise((resolve) => {
    ctx.inject(['settings'], async (settingsCtx) => {
      try {
        const settings = typeof settingsCtx.get === 'function'
          ? settingsCtx.get('settings')
          : settingsCtx.settings;
        if (!settings?.register) return;
        const schema = await createSubworkspaceSettingsSchema();
        resolved = settings.register(SUBWORKSPACE_SETTINGS_NAMESPACE, schema, {
          base: EMPTY_STATE,
          applies: 'live',
        });
        // Mirror once so the plugin-owned document holds the same roots.
        await mirrorReleasedSection(mirror, resolved?.get?.()).catch(() => undefined);
      } catch (error) {
        log?.(`mv-dsh-subworkspace settings migration skipped: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        resolve();
      }
    });
    // A DSH without the settings service never calls back; do not block boot.
    setTimeout(resolve, 1500).unref?.();
  });
  return resolved ?? null;
}
