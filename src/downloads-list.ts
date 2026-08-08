// 纯函数：系统下载目录的解析与列表整理。不 import obsidian，保持可单测。

import path from "node:path";

/**
 * 系统下载目录。Electron Known Folder 优先，支持 Windows/macOS 的目录重定向；
 * 旧环境无法取得 Known Folder 时才回退到 ~/Downloads。
 */
export function downloadsDir(
  homedir: string,
  systemDownloadsPath?: string | null,
): string {
  return systemDownloadsPath?.trim() || path.join(homedir, "Downloads");
}

/** 字节数格式化成 B/KB/MB/GB（≥KB 保留一位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit: string = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** 按修改时间倒序（同时间按名称字典序，保证稳定）。 */
export function sortByMtimeDesc<T extends { mtimeMs: number; name: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
  );
}
