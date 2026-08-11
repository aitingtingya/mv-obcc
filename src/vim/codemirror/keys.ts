export function vimKeyFromEvent(event: KeyboardEvent): string | null {
  if (
    isVimImeKeyboardEvent(event)
  ) return null;
  const special: Record<string, string> = {
    Escape: "Esc",
    Enter: "CR",
    Backspace: "BS",
    Delete: "Del",
    Tab: "Tab",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
  };
  const named = special[event.key] ?? (/^F\d{1,2}$/u.test(event.key) ? event.key : null);
  let base = named ?? event.key;
  if (base === " ") base = "Space";
  if (!base || (base.length > 1 && !named && base !== "Space")) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("C");
  if (event.altKey) modifiers.push("A");
  if (event.metaKey) modifiers.push("D");
  if (event.shiftKey && (named || event.ctrlKey || event.altKey || event.metaKey)) modifiers.push("S");

  if (modifiers.length === 0 && !named && base !== "Space") return base;
  if (modifiers.length === 0 && base === "Space") return " ";
  const normalizedBase = base.length === 1 && modifiers.length > 0 ? base.toLowerCase() : base;
  return `<${[...modifiers, normalizedBase].join("-")}>`;
}

export function isVimImeKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isComposing ||
    Reflect.get(event, "keyCode") === 229 ||
    event.key === "Process" ||
    event.key === "Dead";
}
