import type {
  BridgeSettings,
  TerminalThemeMode,
  TerminalThemePalette,
  TerminalThemePreset,
} from "../types";

export const TERMINAL_THEME_OBSIDIAN = "obsidian";
export const TERMINAL_THEME_LIGHT = "light";
export const TERMINAL_THEME_DARK = "dark";
export const TERMINAL_THEME_CUSTOM = "custom";

export const TERMINAL_THEME_PALETTE_KEYS = [
  "foreground",
  "background",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionForeground",
  "selectionInactiveBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof TerminalThemePalette)[];

export type TerminalThemePaletteKey = (typeof TERMINAL_THEME_PALETTE_KEYS)[number];

export const TERMINAL_THEME_FIELD_LABELS: Record<TerminalThemePaletteKey, string> = {
  foreground: "默认文字",
  background: "背景",
  cursor: "光标",
  cursorAccent: "块状光标文字",
  selectionBackground: "选区背景",
  selectionForeground: "选区文字",
  selectionInactiveBackground: "失焦选区背景",
  black: "ANSI 黑",
  red: "ANSI 红",
  green: "ANSI 绿",
  yellow: "ANSI 黄",
  blue: "ANSI 蓝",
  magenta: "ANSI 紫",
  cyan: "ANSI 青",
  white: "ANSI 白",
  brightBlack: "ANSI 亮黑",
  brightRed: "ANSI 亮红",
  brightGreen: "ANSI 亮绿",
  brightYellow: "ANSI 亮黄",
  brightBlue: "ANSI 亮蓝",
  brightMagenta: "ANSI 亮紫",
  brightCyan: "ANSI 亮青",
  brightWhite: "ANSI 亮白",
};

export const TERMINAL_LIGHT_PALETTE: TerminalThemePalette = {
  foreground: "#1f2328",
  background: "#ffffff",
  cursor: "#1f2328",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(0, 95, 175, 0.28)",
  selectionForeground: "#111827",
  selectionInactiveBackground: "rgba(0, 95, 175, 0.16)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#f6f8fa",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#9a6700",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#3192aa",
  brightWhite: "#ffffff",
};

export const TERMINAL_DARK_PALETTE: TerminalThemePalette = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  cursor: "#ffffff",
  cursorAccent: "#1e1e1e",
  selectionBackground: "rgba(96, 165, 250, 0.35)",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "rgba(96, 165, 250, 0.22)",
  black: "#000000",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#f5f543",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f48771",
  brightGreen: "#6a9955",
  brightYellow: "#f5f543",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#4ec9b0",
  brightWhite: "#ffffff",
};

const TERMINAL_THEME_MODES = new Set<TerminalThemeMode>([
  TERMINAL_THEME_OBSIDIAN,
  TERMINAL_THEME_LIGHT,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_CUSTOM,
]);

const SAFE_NAMED_COLORS = new Set(["black", "white", "transparent"]);

export interface TerminalThemeEnvironment {
  isLightMode: boolean;
  getCssVar?: (name: string) => string;
}

export interface ResolvedTerminalTheme {
  mode: TerminalThemeMode;
  palette: TerminalThemePalette;
  minimumContrastRatio: number;
}

export function normalizeTerminalThemeMode(value: unknown): TerminalThemeMode {
  return TERMINAL_THEME_MODES.has(value as TerminalThemeMode)
    ? (value as TerminalThemeMode)
    : TERMINAL_THEME_OBSIDIAN;
}

export function isSafeTerminalColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const color = value.trim();
  if (!color || color.length > 80) return false;
  if (/url\s*\(|expression\s*\(|;|{|}/i.test(color)) return false;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return true;
  if (
    /^rgba?\(\s*(\d{1,3}%?|\d*\.\d+%?)\s*,\s*(\d{1,3}%?|\d*\.\d+%?)\s*,\s*(\d{1,3}%?|\d*\.\d+%?)(?:\s*,\s*(0|1|0?\.\d+|\d{1,3}%))?\s*\)$/i.test(
      color,
    )
  ) {
    return true;
  }
  if (
    /^hsla?\(\s*(\d{1,3}|\d*\.\d+)(deg|rad|turn)?\s*,\s*(\d{1,3}%|\d*\.\d+%)\s*,\s*(\d{1,3}%|\d*\.\d+%)(?:\s*,\s*(0|1|0?\.\d+|\d{1,3}%))?\s*\)$/i.test(
      color,
    )
  ) {
    return true;
  }
  return SAFE_NAMED_COLORS.has(color.toLowerCase());
}

export function normalizeTerminalPalette(
  value: unknown,
  fallback: TerminalThemePalette = TERMINAL_DARK_PALETTE,
): TerminalThemePalette {
  const source = isRecord(value) ? value : {};
  const normalized = { ...fallback };
  for (const key of TERMINAL_THEME_PALETTE_KEYS) {
    const raw = source[key];
    normalized[key] = isSafeTerminalColor(raw) ? raw.trim() : fallback[key];
  }
  return normalized;
}

export function normalizeTerminalCustomThemes(value: unknown): TerminalThemePreset[] {
  if (!Array.isArray(value)) return [];
  const themes: TerminalThemePreset[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = normalizeThemeId(raw.id);
    if (!id || seen.has(id)) continue;
    const name = typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 80)
      : "自定义终端主题";
    const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();
    themes.push({
      id,
      name,
      createdAt,
      palette: normalizeTerminalPalette(raw.palette),
    });
    seen.add(id);
  }
  return themes;
}

export function normalizeTerminalThemeSettings<T extends Partial<BridgeSettings>>(
  settings: T,
): T & Pick<
  BridgeSettings,
  "terminalThemeMode" | "terminalCustomThemeId" | "terminalCustomThemes"
> {
  const customThemes = normalizeTerminalCustomThemes(settings.terminalCustomThemes);
  const customIds = new Set(customThemes.map((theme) => theme.id));
  const customThemeId = customIds.has(settings.terminalCustomThemeId ?? "")
    ? settings.terminalCustomThemeId ?? ""
    : "";
  const mode = customThemeId
    ? normalizeTerminalThemeMode(settings.terminalThemeMode)
    : normalizeTerminalThemeMode(
        settings.terminalThemeMode === TERMINAL_THEME_CUSTOM
          ? TERMINAL_THEME_OBSIDIAN
          : settings.terminalThemeMode,
      );
  return {
    ...settings,
    terminalThemeMode: mode,
    terminalCustomThemeId: customThemeId,
    terminalCustomThemes: customThemes,
  };
}

export function createTerminalCustomTheme(
  source: TerminalThemePalette = TERMINAL_DARK_PALETTE,
  name = "自定义终端主题",
): TerminalThemePreset {
  const createdAt = Date.now();
  return {
    id: `terminal-theme-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt,
    palette: normalizeTerminalPalette(source, TERMINAL_DARK_PALETTE),
  };
}

export function resolveTerminalTheme(
  settings: Pick<BridgeSettings, "terminalThemeMode" | "terminalCustomThemeId" | "terminalCustomThemes">,
  environment: TerminalThemeEnvironment,
): ResolvedTerminalTheme {
  const normalized = normalizeTerminalThemeSettings(settings);
  if (normalized.terminalThemeMode === TERMINAL_THEME_LIGHT) {
    return resolved(TERMINAL_THEME_LIGHT, TERMINAL_LIGHT_PALETTE);
  }
  if (normalized.terminalThemeMode === TERMINAL_THEME_DARK) {
    return resolved(TERMINAL_THEME_DARK, TERMINAL_DARK_PALETTE);
  }
  if (normalized.terminalThemeMode === TERMINAL_THEME_CUSTOM) {
    const customTheme = normalized.terminalCustomThemes.find(
      (theme) => theme.id === normalized.terminalCustomThemeId,
    );
    if (customTheme) {
      return resolved(TERMINAL_THEME_CUSTOM, customTheme.palette);
    }
  }
  const base = environment.isLightMode ? TERMINAL_LIGHT_PALETTE : TERMINAL_DARK_PALETTE;
  const css = environment.getCssVar;
  const palette: TerminalThemePalette = {
    ...base,
    background: safeCssColor(css?.("--background-secondary"), base.background),
    foreground: safeCssColor(css?.("--text-normal"), base.foreground),
    cursor: safeCssColor(css?.("--text-accent"), base.cursor),
  };
  return resolved(TERMINAL_THEME_OBSIDIAN, palette);
}

export function terminalThemeSignature(theme: ResolvedTerminalTheme): string {
  return JSON.stringify(theme);
}

function resolved(mode: TerminalThemeMode, palette: TerminalThemePalette): ResolvedTerminalTheme {
  return {
    mode,
    palette: normalizeTerminalPalette(palette, mode === TERMINAL_THEME_LIGHT ? TERMINAL_LIGHT_PALETTE : TERMINAL_DARK_PALETTE),
    minimumContrastRatio: 4.5,
  };
}

function safeCssColor(value: string | undefined, fallback: string): string {
  return isSafeTerminalColor(value) ? value.trim() : fallback;
}

function normalizeThemeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[a-zA-Z0-9_-]{3,80}$/.test(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
