/**
 * mv-agent 弹窗僵尸回收。
 *
 * 背景：Windows 上 Obsidian 重载（不是退出）不会销毁上一会话的浮动
 * BrowserWindow，但 workspace.json 里只记录一个浮动窗口，于是每次重载都会
 * 在恢复出一个新弹窗的同时留下一个旧弹窗僵尸，无限累积；只有真实退出才会
 * 清掉。僵尸 realm 是旧会话的存活 browsing context，本会话无法通过
 * workspace 模型看到它，只能借助 Electron 主进程的窗口枚举找到它。
 *
 * 安全性：本模块只销毁能被插件自己写下的标记证明属于「本 vault 的旧会话」
 * 的窗口。标记由 feature 在每个宿主着 mv-agent leaf 的窗口上写入
 * `globalThis.__mvAidePopoutTag = "mv-aide-popout|<vaultRoot>|<session>"`；
 * 回收方只销毁 vaultRoot 相同且 session 不同的窗口——其它 vault 的窗口、
 * 当前会话的存活窗口、从未被打标的窗口一律不动。
 */

export const POPOUT_TAG_PROPERTY = "__mvAidePopoutTag";

const POPOUT_TAG_PREFIX = "mv-aide-popout|";

export interface PopoutTag {
  readonly vaultRoot: string;
  readonly session: string;
}

export function formatPopoutTag(vaultRoot: string, session: string): string {
  return `${POPOUT_TAG_PREFIX}${vaultRoot}|${session}`;
}

/**
 * Parse a tag written by an earlier plugin session. The vault path may itself
 * contain "|" (we never generate a session containing one), so split on the
 * LAST separator.
 */
export function parsePopoutTag(value: unknown): PopoutTag | null {
  if (typeof value !== "string" || !value.startsWith(POPOUT_TAG_PREFIX)) {
    return null;
  }
  const rest = value.slice(POPOUT_TAG_PREFIX.length);
  const separator = rest.lastIndexOf("|");
  if (separator <= 0 || separator >= rest.length - 1) return null;
  return { vaultRoot: rest.slice(0, separator), session: rest.slice(separator + 1) };
}

export type PopoutTagClass = "current" | "stale" | "foreign" | "untagged";

export function classifyPopoutTag(
  value: unknown,
  vaultRoot: string,
  session: string,
): PopoutTagClass {
  const tag = parsePopoutTag(value);
  if (!tag) return "untagged";
  if (tag.vaultRoot !== vaultRoot) return "foreign";
  return tag.session === session ? "current" : "stale";
}

/** Minimal structural slice of a remote-proxied Electron BrowserWindow. */
export interface ZombieNativeWindow {
  isDestroyed?: () => boolean;
  destroy?: () => void;
  webContents?: {
    executeJavaScript?: (code: string) => Promise<unknown>;
  };
}

/** Minimal structural slice of `electron.remote` / `@electron/remote`. */
export interface ZombieWindowRemote {
  BrowserWindow?: {
    getAllWindows?: () => ZombieNativeWindow[];
  };
}

export interface ReapPopoutZombiesOptions {
  readonly vaultRoot: string;
  readonly session: string;
}

/**
 * Destroy every native window provably tagged by an earlier session of THIS
 * vault's plugin. Returns the number of destroyed windows. Never throws:
 * enumeration/probe/destroy failures skip the offending window (a missed
 * zombie degrades to the pre-fix status quo; a wrong destroy would be a real
 * regression, so every doubt resolves to "keep").
 */
export async function reapStaleTaggedWindows(
  remote: ZombieWindowRemote | null,
  options: ReapPopoutZombiesOptions,
): Promise<number> {
  const getAllWindows = remote?.BrowserWindow?.getAllWindows;
  if (typeof getAllWindows !== "function") return 0;
  let windows: ZombieNativeWindow[];
  try {
    windows = getAllWindows.call(remote?.BrowserWindow);
  } catch {
    return 0;
  }
  const probe = `globalThis[${JSON.stringify(POPOUT_TAG_PROPERTY)}] ?? null`;
  let reaped = 0;
  for (const candidate of windows) {
    try {
      if (candidate.isDestroyed?.() === true) continue;
      const execute = candidate.webContents?.executeJavaScript;
      if (typeof execute !== "function") continue;
      if (typeof candidate.destroy !== "function") continue;
      const value = await execute.call(candidate.webContents, probe);
      if (classifyPopoutTag(value, options.vaultRoot, options.session) !== "stale") {
        continue;
      }
      candidate.destroy();
      reaped += 1;
    } catch {
      /* per-window containment: one failing window must not block the rest */
    }
  }
  return reaped;
}
