// 纯类型 + 归一化：不 import obsidian，保持可独立单测。
/** 「指令注释前缀」设置行文档按钮的跳转地址，按界面语言选择手册版本。 */
export const MV_RUN_DOC_URL = {
  zh: "https://github.com/aitingtingya/mv-obcc/blob/main/docs/features.md#mv-run",
  en: "https://github.com/aitingtingya/mv-obcc/blob/main/docs/features-en.md#mv-run",
} as const;

export interface MvRunProfile {
  extension: string;
  /** 分号分隔的注释前缀，如 "#;#:"。 */
  prefixes: string;
}

export interface MvRunSettings {
  profiles: MvRunProfile[];
}

/** 归一化用户数据：按后缀去重、规整分号分隔的前缀串。 */
export function normalizeMvRunSettings(
  raw: Partial<MvRunSettings> | undefined,
): MvRunSettings {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const seen = new Set<string>();
  const out: MvRunProfile[] = [];
  for (const profile of profiles) {
    const extension =
      typeof profile?.extension === "string"
        ? profile.extension.trim().replace(/^\.+/, "").toLowerCase()
        : "";
    if (!extension || seen.has(extension)) continue;
    seen.add(extension);
    out.push({
      extension,
      prefixes: normalizePrefixesString(profile?.prefixes),
    });
  }
  return { profiles: out };
}

/** 取某文件类型的注释前缀数组（分号拆分、trim、过滤空项）。 */
export function mvRunPrefixesFor(
  settings: MvRunSettings,
  extension: string,
): string[] {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  const profile = settings.profiles.find(
    (entry) => entry.extension === normalized,
  );
  if (!profile) return [];
  return profile.prefixes
    .split(";")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
}

function normalizePrefixesString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(";")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0)
    .join(";");
}
