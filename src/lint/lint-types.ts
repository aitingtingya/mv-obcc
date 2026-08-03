export interface LintProfile {
  extension: string;
  command: string;
  /** 类型级 lint 常驻：该类型文件默认常驻（除非文件级手动关闭）。 */
  persistent: boolean;
}

export interface LintSettings {
  profiles: LintProfile[];
  /** 文件级常驻覆盖：vault 相对路径 → true=常驻 / false=手动关闭（覆盖类型级）。 */
  fileOverrides: Record<string, boolean>;
}

/** 归一化用户数据：按后缀去重、规整后缀、命令与常驻兜底。 */
export function normalizeLintSettings(
  raw: Partial<LintSettings> | undefined,
): LintSettings {
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const seen = new Set<string>();
  const out: LintProfile[] = [];
  for (const profile of profiles) {
    const extension =
      typeof profile?.extension === "string"
        ? profile.extension.trim().replace(/^\.+/, "").toLowerCase()
        : "";
    if (!extension || seen.has(extension)) continue;
    seen.add(extension);
    out.push({
      extension,
      command: typeof profile?.command === "string" ? profile.command : "",
      persistent: profile?.persistent === true,
    });
  }

  const fileOverrides: Record<string, boolean> = {};
  if (raw?.fileOverrides && typeof raw.fileOverrides === "object") {
    for (const [key, value] of Object.entries(raw.fileOverrides)) {
      if (typeof value === "boolean") fileOverrides[key] = value;
    }
  }
  return { profiles: out, fileOverrides };
}

export function lintCommandFor(
  settings: LintSettings,
  extension: string,
): string {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  return (
    settings.profiles.find((profile) => profile.extension === normalized)
      ?.command ?? ""
  );
}

/** 判定某文件是否处于 lint 常驻：文件级覆盖优先，否则回退到类型级。 */
export function lintPersistentFor(
  settings: LintSettings,
  extension: string,
  filePath: string,
): boolean {
  if (filePath in settings.fileOverrides) {
    return !!settings.fileOverrides[filePath];
  }
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  return (
    settings.profiles.find((profile) => profile.extension === normalized)
      ?.persistent ?? false
  );
}
