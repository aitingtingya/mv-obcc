import { DSH_POLICY_KEYS } from "./ide/outside-policy";

export type DshAutoOpenRegion = "left" | "right" | "bottom";
export type DshInstallTarget = "vault" | "global";

export interface DshSettings {
  /** Master switch rendered in the "已适配 agent" section (top entry). */
  enabled: boolean;
  /** Which pane/region the DSH webview opens in. */
  autoOpenRegion: DshAutoOpenRegion;
  /** Pinned port passed to `dsh web --port`; default 3080. */
  port: number;
  /** Explicit DeepSeek Harness source checkout; empty means automatic detection. */
  customDirectory: string;
  /** Legacy cache only; UI and operations always inspect the real DSH profile. */
  injected: boolean;
  /**
   * Review out-of-vault ("仓库外") diffs in Obsidian. When on, dsh writes to
   * files OUTSIDE this vault are reviewed as an Obsidian diff at the
   * permission-confirmation moment (accept = real disk write). When off,
   * out-of-vault writes keep dsh's default confirmation card. In-vault files
   * are always reviewable. Default off.
   */
  reviewOutsideVault: boolean;
  /** Use mv-agent's private native terminal control tools instead of getTerminalOutput. */
  terminalAwarenessEnhanced: boolean;
  /** Downscale DSH request images so their longest edge never exceeds 2000px. */
  autoFitImageSize: boolean;
  /** 状态栏「打开」勾选框：独立控制文件/页面位置信息的被动推送。 */
  pushLocation: boolean;
  /** 状态栏「选中」勾选框：独立控制选中文本的被动推送。 */
  pushSelection: boolean;
  /**
   * Per-channel opt-in for dsh sessions running OUTSIDE this vault:
   * `true` = the IDE tool / passive notification may operate for an agent
   * whose session cwd is outside the vault. In-vault agents are always
   * allowed. Missing/unknown keys count as false. Default: all off.
   */
  outsideToolPolicy: Record<string, boolean>;
}

export const DEFAULT_DSH_SETTINGS: DshSettings = {
  enabled: false,
  autoOpenRegion: "right",
  port: 3080,
  customDirectory: "",
  injected: false,
  reviewOutsideVault: false,
  terminalAwarenessEnhanced: false,
  autoFitImageSize: true,
  pushLocation: true,
  pushSelection: true,
  outsideToolPolicy: {},
};

const REGIONS: readonly DshAutoOpenRegion[] = ["left", "right", "bottom"];

function normalizeRegion(value: unknown): DshAutoOpenRegion {
  return REGIONS.includes(value as DshAutoOpenRegion)
    ? (value as DshAutoOpenRegion)
    : "right";
}

/** Keep only known channels, boolean-coerced; everything else is dropped. */
function normalizeOutsideToolPolicy(value: unknown): Record<string, boolean> {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const policy: Record<string, boolean> = {};
  for (const name of DSH_POLICY_KEYS) {
    if (raw[name] === true) policy[name] = true;
  }
  return policy;
}

function normalizePort(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value < 65536
    ? value
    : DEFAULT_DSH_SETTINGS.port;
}

/** Merge persisted (possibly partial/legacy) data with defaults and validate. */
export function normalizeDshSettings(raw: unknown): DshSettings {
  const value =
    raw && typeof raw === "object" ? (raw as Partial<DshSettings>) : {};
  return {
    enabled: value.enabled === true,
    autoOpenRegion: normalizeRegion(value.autoOpenRegion),
    port: normalizePort(value.port),
    customDirectory: typeof value.customDirectory === "string"
      ? value.customDirectory.trim()
      : "",
    injected: value.injected === true,
    reviewOutsideVault: value.reviewOutsideVault === true,
    terminalAwarenessEnhanced: value.terminalAwarenessEnhanced === true,
    autoFitImageSize: value.autoFitImageSize !== false,
    pushLocation: value.pushLocation !== false,
    pushSelection: value.pushSelection !== false,
    outsideToolPolicy: normalizeOutsideToolPolicy(value.outsideToolPolicy),
  };
}
