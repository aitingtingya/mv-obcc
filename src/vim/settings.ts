export interface VimSourceSettings {
  enabled: boolean;
  virtualVimrc: string;
  allowInsertMappingsWithLatexSuite: boolean;
}

export interface VimCursorColorCustom {
  r: number;
  g: number;
  b: number;
}

export interface VimSettings {
  allowExternalCommands: boolean;
  statusDisplay: "text" | "color";
  // 非插入模式块光标配色："default"（跟随文本色）| 内置主题 id | "custom"
  cursorColorTheme: string;
  cursorColorCustom: VimCursorColorCustom;
  sources: Record<string, VimSourceSettings>;
}

export const DEFAULT_VIM_SETTINGS: VimSettings = {
  allowExternalCommands: false,
  statusDisplay: "text",
  cursorColorTheme: "default",
  cursorColorCustom: { r: 148, g: 103, b: 189 },
  sources: {},
};

export function normalizeVimSettings(value: unknown): VimSettings {
  const raw = isRecord(value) ? value : {};
  const sources: Record<string, VimSourceSettings> = {};
  const rawSources = isRecord(raw.sources) ? raw.sources : {};
  for (const [rawExtension, rawSource] of Object.entries(rawSources)) {
    const extension = normalizeExtension(rawExtension);
    if (!extension || !isRecord(rawSource)) continue;
    sources[extension] = {
      enabled: rawSource.enabled === true,
      virtualVimrc: typeof rawSource.virtualVimrc === "string"
        ? rawSource.virtualVimrc
        : "",
      allowInsertMappingsWithLatexSuite:
        rawSource.allowInsertMappingsWithLatexSuite === true,
    };
  }
  return {
    allowExternalCommands: raw.allowExternalCommands === true,
    statusDisplay: raw.statusDisplay === "color" ? "color" : "text",
    cursorColorTheme: typeof raw.cursorColorTheme === "string" &&
      raw.cursorColorTheme.length > 0
      ? raw.cursorColorTheme
      : "default",
    cursorColorCustom: normalizeCursorColorCustom(raw.cursorColorCustom),
    sources,
  };
}

function normalizeCursorColorCustom(value: unknown): VimCursorColorCustom {
  const raw = isRecord(value) ? value : {};
  return {
    r: normalizeColorChannel(raw.r, DEFAULT_VIM_SETTINGS.cursorColorCustom.r),
    g: normalizeColorChannel(raw.g, DEFAULT_VIM_SETTINGS.cursorColorCustom.g),
    b: normalizeColorChannel(raw.b, DEFAULT_VIM_SETTINGS.cursorColorCustom.b),
  };
}

function normalizeColorChannel(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? Math.round(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(255, Math.max(0, parsed)) : fallback;
}

export function vimSourceSettings(
  settings: VimSettings,
  rawExtension: string,
): VimSourceSettings {
  const extension = normalizeExtension(rawExtension) ?? "md";
  return settings.sources[extension] ?? {
    enabled: false,
    virtualVimrc: "",
    allowInsertMappingsWithLatexSuite: false,
  };
}

export function anyVimSourceEnabled(
  settings: VimSettings,
  extensions?: readonly string[],
): boolean {
  const allowed = extensions
    ? new Set(
      extensions
        .map((extension) => normalizeExtension(extension))
        .filter((extension): extension is string => extension !== null),
    )
    : null;
  return Object.entries(settings.sources).some(([extension, source]) =>
    source.enabled && (!allowed || allowed.has(extension)),
  );
}

function normalizeExtension(value: string): string | null {
  const extension = value.trim().replace(/^\.+/u, "").toLowerCase();
  return /^[a-z0-9][a-z0-9+_-]*$/u.test(extension) ? extension : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
