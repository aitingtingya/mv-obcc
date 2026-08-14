import { DSH_POLICY_KEYS } from "./dsh-outside-policy";

export type DshAutoOpenRegion = "left" | "right" | "bottom";
export type DshInstallTarget = "vault" | "global";

/**
 * Passive context delivery mode:
 *  - "live": every stable selection state is pushed as it happens (activity
 *    trail), deduplicated/replaced in place by the dsh plugin.
 *  - "on-send": the selection is buffered and pushed exactly once, at the
 *    moment the user sends a message in dsh; nothing is pushed while the
 *    agent works. Explicit @mentions still steer in both modes.
 */
export type DshPassiveDelivery = "live" | "on-send";

export interface DshSettings {
  /** Master switch rendered in the "已适配 agent" section (top entry). */
  enabled: boolean;
  /** Which pane/region the DSH webview opens in. */
  autoOpenRegion: DshAutoOpenRegion;
  /** Pinned port passed to `dsh web --port`; default 3080. */
  port: number;
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
  /** Passive delivery mode; default "live". */
  passiveDelivery: DshPassiveDelivery;
  /**
   * 状态栏「打开」勾选框：推送位置信息（文件/页面地址）。轨迹跟踪开时
   * 强制生效；关时按此开关决定（默认 true，可取消勾选不再推送）。
   */
  pushLocation: boolean;
  /**
   * 状态栏「选中」勾选框：推送选中文本。轨迹跟踪开时强制生效；关时按
   * 此开关决定（默认 true，可取消勾选不再推送）。
   */
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
  injected: false,
  reviewOutsideVault: false,
  passiveDelivery: "live",
  pushLocation: true,
  pushSelection: true,
  outsideToolPolicy: {},
};

const REGIONS: readonly DshAutoOpenRegion[] = ["left", "right", "bottom"];
const PASSIVE_DELIVERY_MODES: readonly DshPassiveDelivery[] = ["live", "on-send"];

function normalizeRegion(value: unknown): DshAutoOpenRegion {
  return REGIONS.includes(value as DshAutoOpenRegion)
    ? (value as DshAutoOpenRegion)
    : "right";
}

function normalizePassiveDelivery(value: unknown): DshPassiveDelivery {
  return PASSIVE_DELIVERY_MODES.includes(value as DshPassiveDelivery)
    ? (value as DshPassiveDelivery)
    : DEFAULT_DSH_SETTINGS.passiveDelivery;
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
    injected: value.injected === true,
    reviewOutsideVault: value.reviewOutsideVault === true,
    passiveDelivery: normalizePassiveDelivery(value.passiveDelivery),
    pushLocation: value.pushLocation !== false,
    pushSelection: value.pushSelection !== false,
    outsideToolPolicy: normalizeOutsideToolPolicy(value.outsideToolPolicy),
  };
}
