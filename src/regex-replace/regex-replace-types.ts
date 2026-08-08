import path from "node:path";
import { stablePortSeed } from "../path-utils";

/** 正则替换范围：每档只增不减，off < file < folder < vault。 */
export type RegexScope = "off" | "file" | "folder" | "vault";

export const REGEX_SCOPES: readonly RegexScope[] = [
  "off",
  "file",
  "folder",
  "vault",
];

export interface RegexReplaceProfile {
  extension: string;
  scope: RegexScope;
}

export interface RegexReplaceSettings {
  /** Markdown 文件的范围上限。 */
  mdScope: RegexScope;
  /** 非 md 源码类型的范围上限，按后缀匹配。 */
  profiles: RegexReplaceProfile[];
}

function normalizeScope(raw: unknown): RegexScope {
  return REGEX_SCOPES.includes(raw as RegexScope)
    ? (raw as RegexScope)
    : "off";
}

/** 归一化用户数据：按后缀去重、规整后缀、scope 兜底 "off"。 */
export function normalizeRegexReplaceSettings(
  raw: Partial<RegexReplaceSettings> | undefined,
): RegexReplaceSettings {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const seen = new Set<string>();
  const out: RegexReplaceProfile[] = [];
  for (const profile of profiles) {
    const extension =
      typeof profile?.extension === "string"
        ? profile.extension.trim().replace(/^\.+/, "").toLowerCase()
        : "";
    if (!extension || seen.has(extension)) continue;
    seen.add(extension);
    out.push({ extension, scope: normalizeScope(profile?.scope) });
  }
  return {
    mdScope: normalizeScope(raw?.mdScope ?? "file"),
    profiles: out,
  };
}

/** 某后缀文件的范围上限：md 走 mdScope，其余查 profiles，未配置即 "off"。 */
export function regexScopeFor(
  settings: RegexReplaceSettings,
  extension: string,
): RegexScope {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (normalized === "md") return settings.mdScope;
  return (
    settings.profiles.find((profile) => profile.extension === normalized)
      ?.scope ?? "off"
  );
}
