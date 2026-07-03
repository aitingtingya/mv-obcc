/**
 * Pure hotkey-matching logic, shared by the unit tests and (as an inlined
 * twin) the script injected into webviewer pages. The webview runs in an
 * isolated world and cannot import this module, so `llm-web-menu-script.ts`
 * duplicates these rules verbatim — keep them in sync.
 *
 * Why this exists: on macOS, `Option+T` produces `event.key = "†"` (Option is
 * a dead-key modifier that inserts special characters). Comparing the stored
 * key "T" against `event.key` therefore never matches. We instead match
 * letters/digits via `event.code` (the physical key, identical on mac/win and
 * unaffected by modifiers), and fall back to `event.key` for function/arrow
 * keys whose code is layout-dependent.
 */

export interface ObsidianHotkey {
  /** Obsidian modifier tokens, e.g. ["Mod", "Shift"]. */
  modifiers: string[];
  /** The stored key, e.g. "T" (Obsidian uses uppercase for letters). */
  key: string;
}

/** Minimal shape of a KeyboardEvent that the matcher inspects. */
export interface KeyboardEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export type NormalizedKey =
  | { kind: "code"; code: string }
  | { kind: "key"; key: string };

/**
 * Normalize a stored key into a match strategy.
 * - Single ASCII letter → match `event.code` as `KeyX` (mac Option-safe).
 * - Single ASCII digit → match `event.code` as `DigitN`.
 * - F1–F24, arrows, navigation, named keys → match normalized `event.key`.
 * - Anything else (symbols) → best-effort `event.key` match.
 */
export function normalizeObsidianKey(raw: string): NormalizedKey | null {
  if (!raw) return null;
  const key = raw.toUpperCase();
  if (key.length === 1 && key >= "A" && key <= "Z") {
    return { kind: "code", code: `Key${key}` };
  }
  if (key.length === 1 && key >= "0" && key <= "9") {
    return { kind: "code", code: `Digit${key}` };
  }
  // F1..F24
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) {
    return { kind: "key", key };
  }
  return { kind: "key", key };
}

/** Returns true if the event matches the binding exactly. */
export function matchBinding(
  binding: ObsidianHotkey,
  ev: KeyboardEventLike,
  isMac: boolean,
): boolean {
  // Ignore auto-repeat and IME composition — never act on these.
  if (ev.repeat || ev.isComposing) return false;

  // Main key.
  const normalized = normalizeObsidianKey(binding.key);
  if (!normalized) return false;
  if (normalized.kind === "code") {
    if (ev.code !== normalized.code) return false;
  } else {
    if (ev.key.toUpperCase() !== normalized.key) return false;
  }

  // Modifiers — exact match. Build the required set of *event* modifier
  // flags from the binding tokens: `Mod` resolves to the platform primary
  // key (metaKey on mac, ctrlKey on win) and is folded into that flag rather
  // than tracked separately, so `Mod` and an explicit `Ctrl`/`Meta` on the
  // right platform don't double-count the same physical key.
  const mods = binding.modifiers ?? [];
  const needMod = mods.includes("Mod");
  const needCtrl = mods.includes("Ctrl");
  const needMeta = mods.includes("Meta");
  const needAlt = mods.includes("Alt");
  const needShift = mods.includes("Shift");
  const wantMeta = needMeta || (needMod && isMac);
  const wantCtrl = needCtrl || (needMod && !isMac);
  if (wantMeta !== ev.metaKey) return false;
  if (wantCtrl !== ev.ctrlKey) return false;
  if (needAlt !== ev.altKey) return false;
  if (needShift !== ev.shiftKey) return false;
  return true;
}
