import type { App } from "obsidian";

/**
 * Read the hotkey(s) bound to a given command id.
 *
 * Obsidian exposes no public API for reading user-bound hotkeys, so this module
 * reaches into the undocumented-but-stable `app.hotkeyManager` object (used by
 * community plugins such as Hotkey Helper for years). All access is null-guarded:
 * if Obsidian ever renames or removes the field, every call simply returns `[]`
 * and the feature degrades gracefully (no crash, no behavior change for other
 * features). This module is the single place that knows about the internal API,
 * so future changes are isolated here.
 */

export interface HotkeyBinding {
  /** Obsidian modifier tokens, e.g. ["Mod", "Shift"]. */
  modifiers: string[];
  /** The key, e.g. "T" (Obsidian uses uppercase). */
  key: string;
}

interface RawHotkeyBinding {
  modifiers?: string[] | string | null;
  key?: string;
}

interface HotkeyManagerLike {
  customKeys?: Record<string, RawHotkeyBinding[] | undefined>;
  defaultKeys?: Record<string, RawHotkeyBinding[] | undefined>;
  /** Some Obsidian builds store builtin hotkeys here instead. */
  builtinKeys?: Record<string, RawHotkeyBinding[] | undefined>;
  /** Compiled hotkeys and their parallel command-id array. */
  bakedHotkeys?: RawHotkeyBinding[];
  bakedIds?: string[];
  bake?(): void;
}

function manager(app: App): HotkeyManagerLike | null {
  const anyApp = app as unknown as { hotkeyManager?: HotkeyManagerLike };
  return anyApp.hotkeyManager ?? null;
}

/**
 * Look up one command id in a single map, honoring the "explicit disable"
 * convention: a key present with value `[]` means the user cleared all
 * bindings for this command, and that takes precedence over defaults.
 *
 * Returns `{ found: true, list: [] }` for an explicit disable,
 * `{ found: true, list: [...] }` for real bindings,
 * `{ found: false }` when the id is absent from this map.
 */
function lookupOne(
  map: Record<string, RawHotkeyBinding[] | undefined> | undefined,
  id: string,
): { found: true; list: RawHotkeyBinding[] } | { found: false } {
  if (!map || !(id in map)) return { found: false };
  const value = map[id];
  return { found: true, list: Array.isArray(value) ? value : [] };
}

/**
 * Returns every hotkey bound to `commandId`, merging user-customized bindings
 * (`customKeys`) with plugin defaults (`defaultKeys`). Duplicates removed.
 *
 * Semantics:
 *  - If `customKeys` has an entry for the id (even `[]`), it wins — an empty
 *    array means the user explicitly cleared all bindings, so the result is
 *    empty and defaults are NOT consulted.
 *  - Otherwise Obsidian's compiled `bakedHotkeys` + `bakedIds` arrays are used.
 *  - `defaultKeys` and `builtinKeys` are retained as defensive fallbacks.
 *
 * Obsidian stores command ids with the plugin id prefixed (e.g. it stores
 * `mv-obcc-ide:llm-translate`, not `llm-translate`), so when `pluginId` is
 * provided we look up both the prefixed and the bare form.
 */
export function getCommandHotkeys(
  app: App,
  commandId: string,
  pluginId?: string,
): HotkeyBinding[] {
  const mgr = manager(app);
  if (!mgr) return [];

  const ids = pluginId ? [`${pluginId}:${commandId}`, commandId] : [commandId];
  // A customized entry is definitive, including [] for an explicit disable.
  for (const id of ids) {
    const custom = lookupOne(mgr.customKeys, id);
    if (custom.found) {
      return deduplicate(custom.list);
    }
  }

  try {
    mgr.bake?.();
  } catch {
    // Fall through to whatever compiled/default state remains available.
  }

  const resolved: RawHotkeyBinding[] = [];
  if (Array.isArray(mgr.bakedHotkeys) && Array.isArray(mgr.bakedIds)) {
    for (let index = 0; index < mgr.bakedHotkeys.length; index += 1) {
      const hotkey = mgr.bakedHotkeys[index];
      if (hotkey && ids.includes(mgr.bakedIds[index] ?? "")) {
        resolved.push(hotkey);
      }
    }
  }
  if (resolved.length > 0) return deduplicate(resolved);

  for (const id of ids) {
    const def = lookupOne(mgr.defaultKeys, id);
    if (def.found) resolved.push(...def.list);
    const builtin = lookupOne(mgr.builtinKeys, id);
    if (builtin.found) resolved.push(...builtin.list);
  }
  return deduplicate(resolved);
}

function deduplicate(hotkeys: RawHotkeyBinding[]): HotkeyBinding[] {
  const seen = new Set<string>();
  const result: HotkeyBinding[] = [];
  for (const hotkey of hotkeys) {
    if (!hotkey || typeof hotkey.key !== "string") continue;
    const normalized = {
      modifiers: normalizeModifiers(hotkey.modifiers),
      key: hotkey.key,
    };
    const sig = signature(normalized);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(normalized);
  }
  return result;
}

function normalizeModifiers(modifiers: RawHotkeyBinding["modifiers"]): string[] {
  if (Array.isArray(modifiers)) {
    return modifiers.filter((modifier): modifier is string => typeof modifier === "string");
  }
  if (typeof modifiers === "string") {
    return modifiers
      .split(",")
      .map((modifier) => modifier.trim())
      .filter(Boolean);
  }
  return [];
}

/** Canonical comparable signature for de-duplication. */
function signature(hotkey: HotkeyBinding): string {
  return [...(hotkey.modifiers ?? [])].sort().join("+") + "+" + hotkey.key.toUpperCase();
}
