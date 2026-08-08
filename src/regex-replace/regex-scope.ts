import { regexScopeFor, type RegexReplaceSettings, type RegexScope } from "./regex-replace-types";

/** 范围等级：off=0 < file=1 < folder=2 < vault=3，取 min 即"交集"。 */
const SCOPE_RANK: Record<RegexScope, number> = {
  off: 0,
  file: 1,
  folder: 2,
  vault: 3,
};

export function scopeRank(scope: RegexScope): number {
  return SCOPE_RANK[scope];
}

/** resolveScanFiles 只需要文件的这两样信息，TFile/测试桩都可传入。 */
export interface ScannableFile {
  path: string;
  extension: string;
}

export interface SkippedFile {
  path: string;
  reason: "type-off" | "scope-capped";
}

export interface ResolvedScanFiles {
  included: ScannableFile[];
  skipped: SkippedFile[];
}

function folderOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function inFolder(path: string, folder: string): boolean {
  if (folder === "") return true; // vault 根目录：全部文件都在其中
  return path === folder || path.startsWith(`${folder}/`);
}

function withinScope(
  file: ScannableFile,
  scope: RegexScope,
  activeFile: ScannableFile,
): boolean {
  switch (scope) {
    case "off":
      return false;
    case "file":
      return file.path === activeFile.path;
    case "folder":
      return inFolder(file.path, folderOf(activeFile.path));
    case "vault":
      return true;
  }
}

/**
 * 逐类型封顶过滤（交集语义）：每个文件按
 * min(其类型的范围上限, 用户请求范围) 决定是否参与扫描。
 * 类型为 "off" 的文件记 "type-off"；类型上限低于请求范围而被
 * 截掉的记 "scope-capped"，两者都进 skipped 供预览展示。
 */
export function resolveScanFiles(
  settings: RegexReplaceSettings,
  requestedScope: RegexScope,
  activeFile: ScannableFile,
  allFiles: ScannableFile[],
): ResolvedScanFiles {
  const included: ScannableFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of allFiles) {
    const typeScope = regexScopeFor(settings, file.extension);
    if (typeScope === "off") {
      skipped.push({ path: file.path, reason: "type-off" });
      continue;
    }
    const effective: RegexScope =
      scopeRank(typeScope) <= scopeRank(requestedScope)
        ? typeScope
        : requestedScope;
    if (withinScope(file, effective, activeFile)) {
      included.push(file);
    } else {
      skipped.push({ path: file.path, reason: "scope-capped" });
    }
  }
  return { included, skipped };
}
