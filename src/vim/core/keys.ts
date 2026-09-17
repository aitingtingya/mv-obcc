import { characters } from "./characters";

export function tokenizeVimKeys(value: string): string[] {
  return [...value.matchAll(/<[^>]+>|[^<]+|</gu)].flatMap((match) => match[0].startsWith("<") && match[0].endsWith(">")
    ? [normalizeSpecialKey(match[0])] : characters(match[0]));
}

function normalizeSpecialKey(key: string): string {
  const lower = key.toLowerCase();
  const aliases: Record<string, string> = { "<enter>": "<CR>", "<space>": " ", "<lt>": "<", "<nop>": "<Nop>", "<return>": "<CR>" };
  if (aliases[lower]) return aliases[lower];
  for (const named of ["Esc", "CR", "Tab", "BS", "Del", "Left", "Right", "Up", "Down", "Home", "End", "PageUp", "PageDown", "Insert"]) {
    if (lower === `<${named.toLowerCase()}>`) return `<${named}>`;
  }
  if (/^<c-.$/u.test(lower.slice(0, -1))) return `<C-${lower[3]}>`;
  return key;
}
