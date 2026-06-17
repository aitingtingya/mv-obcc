const PURE_MODIFIER_KEYS = new Set([
  "Alt",
  "Control",
  "Meta",
  "Shift",
  "OS",
]);

const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  Backspace: "Backspace",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Escape: "Escape",
  Home: "Home",
  Insert: "Insert",
  PageDown: "PageDown",
  PageUp: "PageUp",
  Spacebar: "Space",
  Tab: "Tab",
};

function normalizeBaseKey(key: string): string | null {
  if (!key || PURE_MODIFIER_KEYS.has(key)) return null;
  const named = NAMED_KEYS[key];
  if (named) return named;
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) {
    return key.toLowerCase();
  }
  return key;
}

export function eventToCodeMirrorKey(
  event: KeyboardEvent,
  isMacLike: boolean,
): string | null {
  const baseKey = normalizeBaseKey(event.key);
  if (!baseKey) return null;

  const modifiers: string[] = [];
  const hasMod = isMacLike ? event.metaKey : event.ctrlKey;
  if (hasMod) {
    modifiers.push(isMacLike ? "Cmd" : "Ctrl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if ((isMacLike && event.ctrlKey) || (!isMacLike && event.metaKey)) {
    modifiers.push(isMacLike ? "Ctrl" : "Meta");
  }

  return [...modifiers, baseKey].join("-");
}

export function formatInlineHotkeyLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed || "未绑定";
}
