/**
 * mv-agent 弹窗位置记忆与恢复。
 *
 * Windows 上 Obsidian 重载后会把恢复出的浮动窗口放在主窗口中央而不是其
 * workspace.json 里保存的位置（至少在本插件支撑的版本上如此），用户每次
 * 重载都要手动把 mv-agent 弹窗拖回去。本模块在会话内持续记录宿主着
 * mv-agent leaf 的弹窗几何（DOM screenX/screenY/outerWidth/outerHeight，
 * 按 vaultRoot 存进 localStorage），重载后的布局恢复完成时把窗口移回
 * 记录位置：先试 DOM moveTo/resizeTo，失败后退回 Electron 原生 setBounds
 * （chrome-autohide 式几何匹配）。任何一步失败都静默退化为现状。
 */

export interface PopoutGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** DOM Window 的最小结构切片（测试用 fake 只需这几个字段）。 */
export interface PopoutGeometrySource {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
}

export function readPopoutGeometry(
  win: PopoutGeometrySource | null | undefined,
): PopoutGeometry | null {
  if (!win) return null;
  const { screenX, screenY, outerWidth, outerHeight } = win;
  if (![screenX, screenY, outerWidth, outerHeight].every(Number.isFinite)) {
    return null;
  }
  if (outerWidth <= 0 || outerHeight <= 0) return null;
  return { x: screenX, y: screenY, width: outerWidth, height: outerHeight };
}

/** 位置恢复的比较容差：DIP/缩放换算允许 2px 以内的抖动。 */
export function samePopoutGeometry(
  a: PopoutGeometry | null,
  b: PopoutGeometry | null,
  tolerance = 2,
): boolean {
  if (!a || !b) return false;
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

export function popoutGeometryStorageKey(vaultRoot: string): string {
  return `mv-aide:popout-geometry|${vaultRoot}`;
}

/** localStorage 的最小结构切片。 */
export interface PopoutGeometryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPopoutGeometries(
  storage: PopoutGeometryStorage | null,
  vaultRoot: string,
): PopoutGeometry[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(popoutGeometryStorageKey(vaultRoot));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: PopoutGeometry[] = [];
    for (const entry of parsed) {
      const candidate = entry as Partial<PopoutGeometry> | null;
      if (
        candidate &&
        Number.isFinite(candidate.x) &&
        Number.isFinite(candidate.y) &&
        Number.isFinite(candidate.width) &&
        Number.isFinite(candidate.height) &&
        (candidate.width as number) > 0 &&
        (candidate.height as number) > 0
      ) {
        result.push({
          x: candidate.x as number,
          y: candidate.y as number,
          width: candidate.width as number,
          height: candidate.height as number,
        });
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function savePopoutGeometries(
  storage: PopoutGeometryStorage | null,
  vaultRoot: string,
  geometries: readonly PopoutGeometry[],
): void {
  if (!storage) return;
  try {
    storage.setItem(popoutGeometryStorageKey(vaultRoot), JSON.stringify(geometries));
  } catch {
    /* 存储不可用：退化为仅内存，重载后表现为现状（居中）。 */
  }
}

export interface PopoutScreenBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 目标矩形完全落在所有已知屏幕之外时返回 null（调用方跳过该条记录）。
 * 只要有任一屏幕与目标相交即放行——不做精确夹取，避免过度干预。
 */
export function clampPopoutGeometryToScreens(
  geometry: PopoutGeometry,
  screens: readonly PopoutScreenBounds[],
): PopoutGeometry | null {
  if (screens.length === 0) return geometry;
  const visible = screens.some(
    (screen) =>
      geometry.x < screen.x + screen.width &&
      geometry.x + geometry.width > screen.x &&
      geometry.y < screen.y + screen.height &&
      geometry.y + geometry.height > screen.y,
  );
  return visible ? geometry : null;
}

/** 原生窗口的最小结构切片（@electron/remote 代理对象）。 */
export interface PopoutNativeWindow {
  isDestroyed?: () => boolean;
  setBounds?: (bounds: PopoutGeometry) => void;
  getContentBounds?: () => PopoutGeometry;
  webContents?: {
    getZoomFactor?: () => number;
  };
}

export interface PopoutMatchMetrics {
  readonly screenX: number;
  readonly screenY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

/** remote 代理的最小结构切片：窗口枚举 + 屏幕列表（clamp 用）。 */
export interface PopoutGeometryRemote {
  BrowserWindow?: {
    getAllWindows?: () => PopoutNativeWindow[];
  };
  screen?: {
    getAllDisplays?: () => { bounds?: Partial<PopoutScreenBounds> }[];
  };
}

/**
 * chrome-autohide 式几何匹配：把 DOM 窗口指标（CSS px）投影到 DIP 后与
 * 原生窗口 content bounds 打分，取误差最小者；误差超过阈值返回 null。
 * 有意自持一份极简实现，不反向依赖稳定运行的 chrome-autohide 模块。
 */
export function matchNativeWindow(
  metrics: PopoutMatchMetrics,
  nativeWindows: readonly PopoutNativeWindow[],
): PopoutNativeWindow | null {
  let best: { candidate: PopoutNativeWindow; score: number } | null = null;
  for (const candidate of nativeWindows) {
    try {
      if (candidate.isDestroyed?.() === true) continue;
      if (typeof candidate.getContentBounds !== "function") continue;
      const bounds = candidate.getContentBounds();
      const zoom = candidate.webContents?.getZoomFactor?.() ?? 1;
      if (!Number.isFinite(zoom) || zoom <= 0) continue;
      const score =
        Math.abs(bounds.x - metrics.screenX) +
        Math.abs(bounds.y - metrics.screenY) +
        Math.abs(bounds.width - metrics.innerWidth * zoom) +
        Math.abs(bounds.height - metrics.innerHeight * zoom);
      if (!best || score < best.score) best = { candidate, score };
    } catch {
      continue;
    }
  }
  if (!best) return null;
  const threshold = Math.max(
    96,
    (metrics.innerWidth + metrics.innerHeight) * 0.08,
  );
  return best.score <= threshold ? best.candidate : null;
}
