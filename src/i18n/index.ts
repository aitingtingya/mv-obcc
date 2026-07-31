import { en } from "./en";

export type Language = "zh" | "en";

const PLACEHOLDER_RE = /\{(\w+)\}/g;

let currentLanguage: Language = "zh";
const warnedMissing = new Set<string>();

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

/**
 * Translate a UI string. `text` is the Chinese source string; when the
 * current language is English, `en[text]` is used (falling back to the
 * Chinese original when no entry exists). `vars` replaces `{name}`
 * placeholders in both languages.
 *
 * In zh mode this returns `text` verbatim (placeholder-substituted only),
 * so the default behavior is byte-identical to the original hardcoded
 * strings and the English table is never touched.
 */
export function t(
  text: string,
  vars?: Record<string, string | number>,
): string {
  let out = text;
  if (currentLanguage === "en") {
    const translated = en[text];
    if (translated !== undefined) {
      out = translated;
    } else if (!warnedMissing.has(text)) {
      warnedMissing.add(text);
      console.warn(`[mv-aide/i18n] Missing English translation for: ${text}`);
    }
  }
  if (vars && out.indexOf("{") !== -1) {
    out = out.replace(PLACEHOLDER_RE, (match, key) =>
      vars[key] === undefined ? match : String(vars[key]),
    );
  }
  return out;
}
