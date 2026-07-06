import type {
  SourceAssistSettings,
  SourceHighlightCustomTheme,
  SourceHighlightPalette,
  SourceHighlightPaletteKey,
  SourceHighlightThemeFormat,
  SourceHighlightTokenStyle,
} from "../types";

export const SOURCE_HIGHLIGHT_FOLLOW_GLOBAL = "follow-global";
export const SOURCE_HIGHLIGHT_OBSIDIAN = "builtin:obsidian";

const PALETTE_KEYS: SourceHighlightPaletteKey[] = [
  "comment",
  "keyword",
  "string",
  "number",
  "function",
  "property",
  "operator",
  "punctuation",
];

interface SourceHighlightThemeDefinition {
  id: string;
  name: string;
  format: SourceHighlightThemeFormat | "builtin";
  palette: SourceHighlightPalette;
}

export interface SourceHighlightThemeOption {
  id: string;
  name: string;
  source: "follow" | "builtin" | "custom";
}

export type SourceHighlightImportFormat =
  | "auto"
  | SourceHighlightThemeFormat;

export interface SourceHighlightImportResult {
  theme: SourceHighlightCustomTheme;
  warnings: string[];
}

const BUILT_IN_SOURCE_HIGHLIGHT_THEMES: SourceHighlightThemeDefinition[] = [
  {
    id: SOURCE_HIGHLIGHT_OBSIDIAN,
    name: "跟随 Obsidian",
    format: "builtin",
    palette: {},
  },
  {
    id: "builtin:prism-default",
    name: "Prism Default",
    format: "prism-css",
    palette: palette({
      comment: ["#708090", "italic"],
      keyword: "#07a",
      string: "#690",
      number: "#905",
      function: "#dd4a68",
      property: "#905",
      operator: "#9a6e3a",
      punctuation: "#999",
    }),
  },
  {
    id: "builtin:okaidia",
    name: "Okaidia",
    format: "prism-css",
    palette: palette({
      comment: ["#8292a2", "italic"],
      keyword: "#66d9ef",
      string: "#e6db74",
      number: "#ae81ff",
      function: "#a6e22e",
      property: "#f8f8f2",
      operator: "#f92672",
      punctuation: "#f8f8f2",
    }),
  },
  {
    id: "builtin:tomorrow",
    name: "Tomorrow",
    format: "prism-css",
    palette: palette({
      comment: ["#8e908c", "italic"],
      keyword: "#8959a8",
      string: "#718c00",
      number: "#f5871f",
      function: "#4271ae",
      property: "#c82829",
      operator: "#3e999f",
      punctuation: "#4d4d4c",
    }),
  },
  {
    id: "builtin:tomorrow-night",
    name: "Tomorrow Night",
    format: "prism-css",
    palette: palette({
      comment: ["#969896", "italic"],
      keyword: "#b294bb",
      string: "#b5bd68",
      number: "#de935f",
      function: "#81a2be",
      property: "#f0c674",
      operator: "#8abeb7",
      punctuation: "#c5c8c6",
    }),
  },
  {
    id: "builtin:solarized-light",
    name: "Solarized Light",
    format: "prism-css",
    palette: palette({
      comment: ["#93a1a1", "italic"],
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      function: "#268bd2",
      property: "#b58900",
      operator: "#6c71c4",
      punctuation: "#657b83",
    }),
  },
  {
    id: "builtin:solarized-dark",
    name: "Solarized Dark",
    format: "prism-css",
    palette: palette({
      comment: ["#839496", "italic"],
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      function: "#268bd2",
      property: "#b58900",
      operator: "#6c71c4",
      punctuation: "#93a1a1",
    }),
  },
  {
    id: "builtin:coy",
    name: "Coy",
    format: "prism-css",
    palette: palette({
      comment: ["#7d8b99", "italic"],
      keyword: "#07a",
      string: "#690",
      number: "#905",
      function: "#dd4a68",
      property: "#905",
      operator: "#9a6e3a",
      punctuation: "#999",
    }),
  },
  {
    id: "builtin:dark",
    name: "Dark",
    format: "prism-css",
    palette: palette({
      comment: ["#999", "italic"],
      keyword: "#cc99cd",
      string: "#7ec699",
      number: "#f08d49",
      function: "#f8c555",
      property: "#f8c555",
      operator: "#67cdcc",
      punctuation: "#ccc",
    }),
  },
  {
    id: "builtin:funky",
    name: "Funky",
    format: "prism-css",
    palette: palette({
      comment: ["#aaa", "italic"],
      keyword: "#00f",
      string: "#0a0",
      number: "#f60",
      function: "#ff1493",
      property: "#f00",
      operator: "#a67f59",
      punctuation: "#999",
    }),
  },
  {
    id: "builtin:twilight",
    name: "Twilight",
    format: "prism-css",
    palette: palette({
      comment: ["#5f5a60", "italic"],
      keyword: "#cda869",
      string: "#8f9d6a",
      number: "#cf6a4c",
      function: "#dad085",
      property: "#9b703f",
      operator: "#f9ee98",
      punctuation: "#f8f8f8",
    }),
  },
  {
    id: "builtin:ghcolors",
    name: "GHColors",
    format: "prism-css",
    palette: palette({
      comment: ["#999988", "italic"],
      keyword: "#000000",
      string: "#dd1144",
      number: "#009999",
      function: "#990000",
      property: "#008080",
      operator: "#000000",
      punctuation: "#333333",
    }),
  },
  {
    id: "builtin:dracula",
    name: "Dracula",
    format: "prism-css",
    palette: palette({
      comment: ["#6272a4", "italic"],
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      function: "#50fa7b",
      property: "#8be9fd",
      operator: "#ff79c6",
      punctuation: "#f8f8f2",
    }),
  },
  {
    id: "builtin:one-dark",
    name: "One Dark",
    format: "prism-css",
    palette: palette({
      comment: ["#5c6370", "italic"],
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      function: "#61afef",
      property: "#e06c75",
      operator: "#56b6c2",
      punctuation: "#abb2bf",
    }),
  },
  {
    id: "builtin:one-light",
    name: "One Light",
    format: "prism-css",
    palette: palette({
      comment: ["#a0a1a7", "italic"],
      keyword: "#a626a4",
      string: "#50a14f",
      number: "#986801",
      function: "#4078f2",
      property: "#e45649",
      operator: "#0184bc",
      punctuation: "#383a42",
    }),
  },
  {
    id: "builtin:material-dark",
    name: "Material Dark",
    format: "prism-css",
    palette: palette({
      comment: ["#546e7a", "italic"],
      keyword: "#c792ea",
      string: "#c3e88d",
      number: "#f78c6c",
      function: "#82aaff",
      property: "#ffcb6b",
      operator: "#89ddff",
      punctuation: "#eeffff",
    }),
  },
  {
    id: "builtin:material-light",
    name: "Material Light",
    format: "prism-css",
    palette: palette({
      comment: ["#90a4ae", "italic"],
      keyword: "#7c4dff",
      string: "#91b859",
      number: "#f76d47",
      function: "#39adb5",
      property: "#f6a434",
      operator: "#39adb5",
      punctuation: "#546e7a",
    }),
  },
  {
    id: "builtin:nord",
    name: "Nord",
    format: "prism-css",
    palette: palette({
      comment: ["#616e88", "italic"],
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      function: "#88c0d0",
      property: "#8fbcbb",
      operator: "#81a1c1",
      punctuation: "#d8dee9",
    }),
  },
  {
    id: "builtin:night-owl",
    name: "Night Owl",
    format: "prism-css",
    palette: palette({
      comment: ["#637777", "italic"],
      keyword: "#c792ea",
      string: "#ecc48d",
      number: "#f78c6c",
      function: "#82aaff",
      property: "#addb67",
      operator: "#7fdbca",
      punctuation: "#d6deeb",
    }),
  },
];

const BUILT_IN_BY_ID = new Map(
  BUILT_IN_SOURCE_HIGHLIGHT_THEMES.map((theme) => [theme.id, theme]),
);

const PRISM_SELECTOR_MAP: Array<[string, SourceHighlightPaletteKey]> = [
  [".token.comment", "comment"],
  [".token.prolog", "comment"],
  [".token.doctype", "comment"],
  [".token.cdata", "comment"],
  [".token.keyword", "keyword"],
  [".token.selector", "keyword"],
  [".token.important", "keyword"],
  [".token.string", "string"],
  [".token.char", "string"],
  [".token.attr-value", "string"],
  [".token.number", "number"],
  [".token.boolean", "number"],
  [".token.constant", "number"],
  [".token.function", "function"],
  [".token.class-name", "function"],
  [".token.property", "property"],
  [".token.attr-name", "property"],
  [".token.variable", "property"],
  [".token.operator", "operator"],
  [".token.punctuation", "punctuation"],
];

const HLJS_SELECTOR_MAP: Array<[string, SourceHighlightPaletteKey]> = [
  [".hljs-comment", "comment"],
  [".hljs-quote", "comment"],
  [".hljs-keyword", "keyword"],
  [".hljs-selector-tag", "keyword"],
  [".hljs-built_in", "keyword"],
  [".hljs-string", "string"],
  [".hljs-regexp", "string"],
  [".hljs-number", "number"],
  [".hljs-literal", "number"],
  [".hljs-function", "function"],
  [".hljs-title", "function"],
  [".hljs-property", "property"],
  [".hljs-attr", "property"],
  [".hljs-variable", "property"],
  [".hljs-operator", "operator"],
  [".hljs-punctuation", "punctuation"],
];

export function sourceHighlightBuiltInThemeOptions(): SourceHighlightThemeOption[] {
  return BUILT_IN_SOURCE_HIGHLIGHT_THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    source: "builtin",
  }));
}

export function sourceHighlightThemeOptions(
  customThemes: SourceHighlightCustomTheme[],
): SourceHighlightThemeOption[] {
  return [
    ...sourceHighlightBuiltInThemeOptions(),
    ...customThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      source: "custom" as const,
    })),
  ];
}

export function sourceHighlightProfileThemeOptions(
  customThemes: SourceHighlightCustomTheme[],
): SourceHighlightThemeOption[] {
  return sourceHighlightThemeOptions(customThemes);
}

export function normalizeSourceHighlightThemeId(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const trimmed = value.trim();
  return trimmed === SOURCE_HIGHLIGHT_FOLLOW_GLOBAL
    ? SOURCE_HIGHLIGHT_OBSIDIAN
    : trimmed;
}

export function normalizeSourceHighlightCustomTheme(
  raw: unknown,
): SourceHighlightCustomTheme | null {
  if (!isRecord(raw)) return null;
  const id = normalizeSourceHighlightThemeId(raw.id, "");
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const format = normalizeThemeFormat(raw.format);
  const importedAt = typeof raw.importedAt === "number" && Number.isFinite(raw.importedAt)
    ? raw.importedAt
    : Date.now();
  const paletteValue = isRecord(raw.palette) ? raw.palette : null;
  const parsedPalette = paletteValue ? parsePaletteObject(paletteValue) : {};
  if (!id || !name || !format || !paletteHasAnyStyle(parsedPalette)) return null;
  return { id, name, format, importedAt, palette: parsedPalette };
}

export function normalizeSourceHighlightCustomThemes(
  raw: unknown,
): SourceHighlightCustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const themes: SourceHighlightCustomTheme[] = [];
  for (const value of raw) {
    const theme = normalizeSourceHighlightCustomTheme(value);
    if (!theme || seen.has(theme.id) || BUILT_IN_BY_ID.has(theme.id)) continue;
    seen.add(theme.id);
    themes.push(theme);
  }
  return themes;
}

export function resolveSourceHighlightThemeId(
  settings: SourceAssistSettings,
  extension: string,
): string {
  const profile = settings.profiles.find(
    (candidate) => candidate.extension.toLowerCase() === extension.toLowerCase(),
  );
  return normalizeSourceHighlightThemeId(
    profile?.highlightThemeId,
    SOURCE_HIGHLIGHT_OBSIDIAN,
  );
}

export function resolveSourceHighlightTheme(
  settings: SourceAssistSettings,
  extension: string,
): SourceHighlightThemeDefinition {
  const themeId = resolveSourceHighlightThemeId(settings, extension);
  return (
    BUILT_IN_BY_ID.get(themeId) ??
    settings.customHighlightThemes.find((theme) => theme.id === themeId) ??
    BUILT_IN_BY_ID.get(settings.highlightThemeId) ??
    BUILT_IN_BY_ID.get(SOURCE_HIGHLIGHT_OBSIDIAN)!
  );
}

export function sourceHighlightThemeStyleAttribute(
  settings: SourceAssistSettings,
  registeredExtensions: Iterable<string>,
  rawExtension: string,
): string | null {
  const extension = rawExtension.replace(/^\.+/, "").toLowerCase();
  if (!extension || extension === "md") return null;
  if (!Array.from(registeredExtensions).some((value) => value.toLowerCase() === extension)) {
    return null;
  }
  const theme = resolveSourceHighlightTheme(settings, extension);
  const style = paletteToCssVariables(theme.palette);
  return style || null;
}

export function importSourceHighlightTheme(
  content: string,
  options: {
    fileName?: string;
    format?: SourceHighlightImportFormat;
    nameOverride?: string;
    now?: number;
  } = {},
): SourceHighlightImportResult {
  const format = options.format ?? "auto";
  const parsed = parseThemeContent(content, format, options.fileName);
  const name = (options.nameOverride?.trim() || parsed.name || themeNameFromFile(options.fileName) || "Custom Theme").slice(0, 80);
  const theme: SourceHighlightCustomTheme = {
    id: customThemeId(name, options.now ?? Date.now()),
    name,
    format: parsed.format,
    importedAt: options.now ?? Date.now(),
    palette: parsed.palette,
  };
  if (!paletteHasAnyStyle(theme.palette)) {
    throw new Error("未能从主题文件中提取可用的 token 配色。");
  }
  return { theme, warnings: parsed.warnings };
}

export function removeSourceHighlightThemeReferences(
  settings: SourceAssistSettings,
  themeId: string,
): void {
  if (settings.highlightThemeId === themeId) {
    settings.highlightThemeId = SOURCE_HIGHLIGHT_OBSIDIAN;
  }
  for (const profile of settings.profiles) {
    if (profile.highlightThemeId === themeId) {
      profile.highlightThemeId = SOURCE_HIGHLIGHT_OBSIDIAN;
    }
  }
  settings.customHighlightThemes = settings.customHighlightThemes.filter(
    (theme) => theme.id !== themeId,
  );
}

function parseThemeContent(
  content: string,
  format: SourceHighlightImportFormat,
  fileName: string | undefined,
): {
  name: string;
  format: SourceHighlightThemeFormat;
  palette: SourceHighlightPalette;
  warnings: string[];
} {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("主题文件为空。");
  const detected = format === "auto" ? detectThemeFormat(trimmed, fileName) : format;
  switch (detected) {
    case "mv-senceai-json":
      return parseMvSenceAiJsonTheme(trimmed);
    case "textmate-json":
      return parseTextmateJsonTheme(trimmed, fileName);
    case "highlight-js-css":
      return {
        name: themeNameFromFile(fileName),
        format: "highlight-js-css",
        palette: parseCssTheme(trimmed, HLJS_SELECTOR_MAP),
        warnings: ["highlight.js CSS 会转换为 Prism token 配色，效果为近似还原。"],
      };
    case "prism-css":
      return {
        name: themeNameFromFile(fileName),
        format: "prism-css",
        palette: parseCssTheme(trimmed, PRISM_SELECTOR_MAP),
        warnings: [],
      };
    default:
      throw new Error("不支持该主题格式。");
  }
}

function detectThemeFormat(
  content: string,
  fileName: string | undefined,
): SourceHighlightThemeFormat {
  const lowerName = fileName?.toLowerCase() ?? "";
  if (lowerName.endsWith(".tmtheme")) {
    throw new Error("第一版暂不支持 .tmTheme plist/XML 主题。请使用 Prism CSS、highlight.js CSS、VS Code/Shiki JSON 或 mv-SenceAI JSON。");
  }
  if (/^\s*\{/.test(content)) {
    const parsed = JSON.parse(content) as unknown;
    if (isRecord(parsed) && isRecord(parsed.palette)) return "mv-senceai-json";
    return "textmate-json";
  }
  if (content.includes(".hljs")) return "highlight-js-css";
  if (content.includes(".token")) return "prism-css";
  throw new Error("无法自动识别主题格式。请手动选择 Prism CSS、highlight.js CSS 或 VS Code/Shiki JSON。");
}

function parseMvSenceAiJsonTheme(content: string): {
  name: string;
  format: "mv-senceai-json";
  palette: SourceHighlightPalette;
  warnings: string[];
} {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.palette)) {
    throw new Error("mv-SenceAI JSON 需要包含 palette 对象。");
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name.trim() : "",
    format: "mv-senceai-json",
    palette: parsePaletteObject(parsed.palette),
    warnings: [],
  };
}

function parseTextmateJsonTheme(
  content: string,
  fileName: string | undefined,
): {
  name: string;
  format: "textmate-json";
  palette: SourceHighlightPalette;
  warnings: string[];
} {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("无效 JSON 主题。");
  const tokenColors = Array.isArray(parsed.tokenColors) ? parsed.tokenColors : [];
  const weighted = new Map<SourceHighlightPaletteKey, { score: number; style: SourceHighlightTokenStyle }>();

  for (const entry of tokenColors) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue;
    const style = parseTokenStyle(entry.settings);
    if (!style.color && !style.fontStyle && !style.fontWeight && !style.textDecoration) continue;
    const scopes = normalizeScopeList(entry.scope);
    for (const scope of scopes) {
      for (const key of PALETTE_KEYS) {
        const score = textmateScopeScore(scope, key);
        if (score <= 0) continue;
        const previous = weighted.get(key);
        if (!previous || score >= previous.score) {
          weighted.set(key, { score, style });
        }
      }
    }
  }

  const result: SourceHighlightPalette = {};
  for (const [key, value] of weighted.entries()) {
    result[key] = value.style;
  }
  return {
    name:
      typeof parsed.name === "string"
        ? parsed.name.trim()
        : themeNameFromFile(fileName),
    format: "textmate-json",
    palette: result,
    warnings: ["VS Code / TextMate / Shiki JSON 会提取主色并转换为 Prism token 配色，不能完全还原原主题。"],
  };
}

function parseCssTheme(
  content: string,
  mappings: Array<[string, SourceHighlightPaletteKey]>,
): SourceHighlightPalette {
  const paletteResult: SourceHighlightPalette = {};
  const rulePattern = /([^{}]+)\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(content)) !== null) {
    const selector = match[1] ?? "";
    const declaration = match[2] ?? "";
    const style = parseCssDeclarationStyle(declaration);
    if (!style.color && !style.fontStyle && !style.fontWeight && !style.textDecoration) continue;
    for (const [needle, key] of mappings) {
      if (selector.includes(needle)) {
        paletteResult[key] = { ...paletteResult[key], ...style };
      }
    }
  }
  return paletteResult;
}

function parseCssDeclarationStyle(declaration: string): SourceHighlightTokenStyle {
  const style: SourceHighlightTokenStyle = {};
  for (const part of declaration.split(";")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (name === "color") {
      const color = safeColor(value);
      if (color) style.color = color;
    } else if (name === "font-style") {
      const fontStyle = safeFontStyle(value);
      if (fontStyle) style.fontStyle = fontStyle;
    } else if (name === "font-weight") {
      const fontWeight = safeFontWeight(value);
      if (fontWeight) style.fontWeight = fontWeight;
    } else if (name === "text-decoration") {
      const textDecoration = safeTextDecoration(value);
      if (textDecoration) style.textDecoration = textDecoration;
    }
  }
  return style;
}

function parsePaletteObject(raw: Record<string, unknown>): SourceHighlightPalette {
  const result: SourceHighlightPalette = {};
  for (const key of PALETTE_KEYS) {
    const value = raw[key];
    const style =
      typeof value === "string"
        ? parseTokenStyle({ color: value })
        : isRecord(value)
          ? parseTokenStyle(value)
          : {};
    if (style.color || style.fontStyle || style.fontWeight || style.textDecoration) {
      result[key] = style;
    }
  }
  return result;
}

function parseTokenStyle(raw: Record<string, unknown>): SourceHighlightTokenStyle {
  const style: SourceHighlightTokenStyle = {};
  const foreground = typeof raw.foreground === "string" ? raw.foreground : raw.color;
  if (typeof foreground === "string") {
    const color = safeColor(foreground);
    if (color) style.color = color;
  }
  if (typeof raw.fontStyle === "string") {
    const fontStyle = safeFontStyle(raw.fontStyle);
    if (fontStyle) style.fontStyle = fontStyle;
    const fontWeight = safeFontWeight(raw.fontStyle);
    if (fontWeight) style.fontWeight = fontWeight;
    const textDecoration = safeTextDecoration(raw.fontStyle);
    if (textDecoration) style.textDecoration = textDecoration;
  }
  if (typeof raw.fontWeight === "string") {
    const fontWeight = safeFontWeight(raw.fontWeight);
    if (fontWeight) style.fontWeight = fontWeight;
  }
  if (typeof raw.textDecoration === "string") {
    const textDecoration = safeTextDecoration(raw.textDecoration);
    if (textDecoration) style.textDecoration = textDecoration;
  }
  return style;
}

function paletteToCssVariables(paletteValue: SourceHighlightPalette): string {
  const parts: string[] = [];
  for (const key of PALETTE_KEYS) {
    const style = paletteValue[key];
    if (!style) continue;
    if (style.color) parts.push(`--mv-source-${key}: ${style.color}`);
    if (style.fontStyle) {
      parts.push(`--mv-source-${key}-font-style: ${style.fontStyle}`);
    }
    if (style.fontWeight) {
      parts.push(`--mv-source-${key}-font-weight: ${style.fontWeight}`);
    }
    if (style.textDecoration) {
      parts.push(`--mv-source-${key}-text-decoration: ${style.textDecoration}`);
    }
  }
  return parts.length > 0 ? `${parts.join("; ")};` : "";
}

function palette(
  entries: Record<SourceHighlightPaletteKey, string | [string, "italic"]>,
): SourceHighlightPalette {
  const result: SourceHighlightPalette = {};
  for (const key of PALETTE_KEYS) {
    const value = entries[key];
    result[key] = Array.isArray(value)
      ? { color: value[0], fontStyle: value[1] }
      : { color: value };
  }
  return result;
}

function textmateScopeScore(
  rawScope: string,
  key: SourceHighlightPaletteKey,
): number {
  const scope = rawScope.trim().toLowerCase();
  if (!scope) return 0;
  const specificity = scope.split(".").length;
  const includes = (part: string) => scope.includes(part);
  switch (key) {
    case "comment":
      return scope.startsWith("comment") ? 40 + specificity : 0;
    case "keyword":
      return includes("keyword") || includes("storage") ? 30 + specificity : 0;
    case "string":
      return includes("string") ? 35 + specificity : 0;
    case "number":
      return includes("constant.numeric") || includes("constant.language") ? 35 + specificity : 0;
    case "function":
      return includes("entity.name.function") || includes("support.function") || includes("meta.function") ? 40 + specificity : 0;
    case "property":
      return includes("property") || includes("attribute-name") || includes("variable.other") ? 30 + specificity : 0;
    case "operator":
      return includes("keyword.operator") ? 40 + specificity : 0;
    case "punctuation":
      return includes("punctuation") ? 35 + specificity : 0;
    default:
      return 0;
  }
}

function normalizeScopeList(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(",").map((scope) => scope.trim());
  if (Array.isArray(raw)) {
    return raw.flatMap((value) =>
      typeof value === "string" ? value.split(",").map((scope) => scope.trim()) : [],
    );
  }
  return [];
}

function safeColor(raw: string): string | null {
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,]+\)$/.test(value)) return value;
  return null;
}

function safeFontStyle(raw: string): "normal" | "italic" | null {
  const value = raw.toLowerCase();
  if (/\bitalic\b/.test(value)) return "italic";
  if (/\bnormal\b/.test(value)) return "normal";
  return null;
}

function safeFontWeight(raw: string): "normal" | "bold" | null {
  const value = raw.toLowerCase();
  if (/\bbold\b/.test(value)) return "bold";
  if (/\bnormal\b/.test(value)) return "normal";
  return null;
}

function safeTextDecoration(raw: string): "none" | "underline" | null {
  const value = raw.toLowerCase();
  if (/\bunderline\b/.test(value)) return "underline";
  if (/\bnone\b/.test(value)) return "none";
  return null;
}

function paletteHasAnyStyle(paletteValue: SourceHighlightPalette): boolean {
  return PALETTE_KEYS.some((key) => {
    const style = paletteValue[key];
    return Boolean(style?.color || style?.fontStyle || style?.fontWeight || style?.textDecoration);
  });
}

function normalizeThemeFormat(value: unknown): SourceHighlightThemeFormat | null {
  return value === "mv-senceai-json" ||
    value === "prism-css" ||
    value === "highlight-js-css" ||
    value === "textmate-json"
    ? value
    : null;
}

function customThemeId(name: string, timestamp: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "theme";
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `custom:${timestamp.toString(36)}:${slug}:${randomPart}`;
}

function themeNameFromFile(fileName: string | undefined): string {
  if (!fileName) return "";
  return fileName.replace(/\.(css|json)$/i, "").replace(/[-_]+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
