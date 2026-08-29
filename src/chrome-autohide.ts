import type MvAideIdePlugin from "../main";

export type ChromeAutoHideKind = "tabBar" | "fileHeader" | "webviewerHeader";

export const CHROME_AUTOHIDE_KIND_CLASS: Record<ChromeAutoHideKind, string> = {
  tabBar: "mv-aide-chrome-autohide-tab",
  fileHeader: "mv-aide-chrome-autohide-file",
  webviewerHeader: "mv-aide-chrome-autohide-web",
};

/** 展开态只属于单个标签组，三个开关仅决定该组中显示哪些层。 */
export const CHROME_EXPANDED_CLASS = "mv-aide-chrome-expanded";
/** 收起状态下位于标签组顶部或紧贴可见标签栏下方的 8px 唤出面。 */
export const CHROME_SENSOR_CLASS = "mv-aide-chrome-sensor";
/** 系统指针真正离开展开区域后的宽限期。 */
export const CHROME_COLLAPSE_DELAY_MS = 120;
/** 仅在存在展开组时读取系统指针，避免常驻轮询。 */
export const CHROME_CURSOR_POLL_MS = 32;

const GROUP_SELECTOR = ".workspace-tabs";
const GROUP_EXCLUDED_SELECTOR = ".mod-stacked";
const STRIP_SELECTOR = ":scope > .workspace-tab-header-container";
const ACTIVE_LEAF_SELECTOR = ".workspace-leaf.mod-active";
const LEAF_CONTENT_SELECTOR = ".workspace-leaf-content";
const MARKDOWN_TYPE = "markdown";
const WEBVIEWER_TYPES = new Set(["webviewer", "browser"]);
const HEADER_SELECTOR = ".view-header";
const SENSOR_HEIGHT_PX = 8;
const INTERACTIVE_OVERLAY_SELECTOR = [
  ".menu",
  ".suggestion-container",
  ".popover",
  ".modal-container",
  ".prompt",
].join(", ");

interface Point {
  x: number;
  y: number;
}

export interface ChromeCursorSample {
  cursor: Point;
  contentOrigin: Point;
  zoomFactor: number;
}

export interface ChromeCursorRuntime {
  sample(): ChromeCursorSample | null;
}

export type ChromeCursorRuntimeFactory = (
  hostWindow: Window,
) => ChromeCursorRuntime | null;

interface ElectronRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElectronRemoteLike {
  screen?: {
    getCursorScreenPoint?: () => Point;
  };
  getCurrentWindow?: () => {
    getContentBounds?: () => ElectronRectangle;
  };
}

interface ElectronRendererLike {
  remote?: ElectronRemoteLike;
  webFrame?: {
    getZoomFactor?: () => number;
  };
}

type RuntimeRequire = (moduleName: string) => unknown;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * 使用 Obsidian 桌面端已启用的 Electron remote 读取系统指针。
 * screen 坐标、BrowserWindow content bounds 均为 DIP；DOM client 坐标乘以
 * webFrame zoom factor 后即可进入同一坐标系。原生 drag 区是否派发 DOM
 * 事件不会影响这个采样链。
 */
export function createElectronChromeCursorRuntime(
  hostWindow: Window,
): ChromeCursorRuntime | null {
  const requireModule = (hostWindow as Window & { require?: RuntimeRequire }).require;
  if (typeof requireModule !== "function") return null;

  try {
    const electron = requireModule("electron") as ElectronRendererLike;
    let remote = electron.remote;
    if (
      typeof remote?.screen?.getCursorScreenPoint !== "function" ||
      typeof remote.getCurrentWindow !== "function"
    ) {
      remote = requireModule("@electron/remote") as ElectronRemoteLike;
    }
    const screen = remote?.screen;
    const currentWindow = remote?.getCurrentWindow?.();
    if (
      typeof screen?.getCursorScreenPoint !== "function" ||
      typeof currentWindow?.getContentBounds !== "function"
    ) {
      return null;
    }

    return {
      sample(): ChromeCursorSample | null {
        try {
          const cursor = screen.getCursorScreenPoint!();
          const bounds = currentWindow.getContentBounds!();
          const reportedZoom = electron.webFrame?.getZoomFactor?.();
          const fallbackZoom =
            hostWindow.innerWidth > 0 ? bounds.width / hostWindow.innerWidth : 1;
          const zoomFactor =
            reportedZoom !== undefined && finite(reportedZoom) && reportedZoom > 0
              ? reportedZoom
              : fallbackZoom;
          if (
            !finite(cursor.x) ||
            !finite(cursor.y) ||
            !finite(bounds.x) ||
            !finite(bounds.y) ||
            !finite(zoomFactor) ||
            zoomFactor <= 0
          ) {
            return null;
          }
          return {
            cursor: { x: cursor.x, y: cursor.y },
            contentOrigin: { x: bounds.x, y: bounds.y },
            zoomFactor,
          };
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * 三类顶部 chrome 共用的自动隐藏控制器。
 *
 * sensor 只负责唤出。展开以后，唯一真值是 Electron 返回的系统指针位置：
 * 指针仍在该组完整标签栏、活动页工具栏或所属弹层内时永不收起；连续离开
 * 120ms 后才收起。标签栏空白的原生窗口 drag 区不需要派发任何 DOM 事件。
 */
export class ChromeAutoHideFeature {
  private groups: HTMLElement[] = [];
  private sensors = new Map<HTMLElement, HTMLElement>();
  private outsideSince = new Map<HTMLElement, number>();
  private cursorRuntime: ChromeCursorRuntime | null = null;
  private cursorPollHandle: number | null = null;
  private overlayOwner: HTMLElement | null = null;
  private ownedOverlays = new Set<HTMLElement>();
  private overlayObserver: MutationObserver | null = null;

  constructor(
    private readonly plugin: MvAideIdePlugin,
    private readonly cursorRuntimeFactory: ChromeCursorRuntimeFactory =
      createElectronChromeCursorRuntime,
  ) {}

  register(): void {
    const hostWindow = document.defaultView ?? window;
    this.cursorRuntime = this.cursorRuntimeFactory(hostWindow);
    this.refreshGroups();
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.refreshGroups()),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => this.activeLeafChanged()),
    );
    this.plugin.registerDomEvent(document, "pointerdown", this.onPointerDown, {
      capture: true,
      passive: true,
    });
    this.plugin.registerDomEvent(document, "pointerover", this.onPointerOver, {
      capture: true,
      passive: true,
    });
    this.plugin.registerDomEvent(window, "resize", this.onViewportChanged, {
      passive: true,
    });
    this.plugin.register(() => this.disposeDom());
  }

  setEnabled(kind: ChromeAutoHideKind, enabled: boolean): void {
    const canEnable = enabled && this.cursorRuntime !== null;
    document.body.classList.toggle(CHROME_AUTOHIDE_KIND_CLASS[kind], canEnable);
    for (const group of this.groups) {
      if (!this.groupHasArmedLayer(group)) this.collapseGroup(group);
      this.updateSensor(group);
    }
  }

  // ── 系统指针单一真值 ────────────────────────────────────────────────

  private onSensorPointerEnter = (event: PointerEvent): void => {
    const sensor = this.sensorFromTarget(event.currentTarget);
    const group = sensor ? this.groupForSensor(sensor) : null;
    if (group) this.expandGroup(group);
  };

  private onPointerDown = (event: PointerEvent): void => {
    const chromeGroup = this.groupFromChromeTarget(event.target);
    if (chromeGroup) {
      this.setOverlayOwner(chromeGroup);
    } else if (!this.captureOwnedOverlay(event.target)) {
      this.clearOverlayOwnership();
    }
  };

  private onPointerOver = (event: PointerEvent): void => {
    this.captureOwnedOverlay(event.target);
  };

  private onViewportChanged = (): void => {
    this.syncAllSensors();
  };

  private startCursorPolling(): void {
    if (this.cursorRuntime === null || this.cursorPollHandle !== null) return;
    this.pollCursor();
    this.cursorPollHandle = window.setInterval(
      this.pollCursor,
      CHROME_CURSOR_POLL_MS,
    );
  }

  private stopCursorPolling(): void {
    if (this.cursorPollHandle === null) return;
    window.clearInterval(this.cursorPollHandle);
    this.cursorPollHandle = null;
  }

  private pollCursor = (): void => {
    const expandedGroups = this.groups.filter((group) =>
      group.classList.contains(CHROME_EXPANDED_CLASS),
    );
    if (expandedGroups.length === 0) {
      this.stopCursorPolling();
      return;
    }

    const sample = this.cursorRuntime?.sample() ?? null;
    if (!sample) {
      // 无系统坐标时不允许沿用旧位置收起，宁可保持展开也不能误判。
      for (const group of expandedGroups) this.outsideSince.delete(group);
      return;
    }

    this.pruneOwnedOverlays();
    const now = Date.now();
    for (const group of expandedGroups) {
      if (!group.isConnected || !this.groupHasArmedLayer(group)) {
        this.collapseGroup(group);
        continue;
      }
      if (this.cursorInRetainedRegion(group, sample)) {
        this.outsideSince.delete(group);
        continue;
      }
      const since = this.outsideSince.get(group);
      if (since === undefined) {
        this.outsideSince.set(group, now);
      } else if (now - since >= CHROME_COLLAPSE_DELAY_MS) {
        this.collapseGroup(group);
      }
    }

    if (!this.hasExpandedGroup()) this.stopCursorPolling();
  };

  private cursorInRetainedRegion(
    group: HTMLElement,
    sample: ChromeCursorSample,
  ): boolean {
    const point = this.cursorClientPoint(sample);
    if (!point || !this.groupHasArmedLayer(group)) return false;
    const band = this.expandedChromeBand(group);
    if (band && this.pointInRect(point, band)) return true;
    return this.cursorInOwnedOverlay(group, point);
  }

  private cursorClientPoint(sample: ChromeCursorSample): Point | null {
    if (!finite(sample.zoomFactor) || sample.zoomFactor <= 0) return null;
    const point = {
      x: (sample.cursor.x - sample.contentOrigin.x) / sample.zoomFactor,
      y: (sample.cursor.y - sample.contentOrigin.y) / sample.zoomFactor,
    };
    return finite(point.x) && finite(point.y) ? point : null;
  }

  // ── 每组独立展开状态 ────────────────────────────────────────────────

  private expandGroup(group: HTMLElement): void {
    if (this.cursorRuntime === null || !this.groupHasArmedLayer(group)) return;
    this.outsideSince.delete(group);
    group.classList.add(CHROME_EXPANDED_CLASS);
    // 必须在 sensor 隐藏前启动系统指针采样，不留下依赖 DOM 事件的空窗。
    this.startCursorPolling();
    this.updateSensor(group);
  }

  private collapseGroup(group: HTMLElement): void {
    this.outsideSince.delete(group);
    group.classList.remove(CHROME_EXPANDED_CLASS);
    if (this.overlayOwner === group) this.clearOverlayOwnership();
    this.updateSensor(group);
    if (!this.hasExpandedGroup()) this.stopCursorPolling();
  }

  private hasExpandedGroup(): boolean {
    return this.groups.some((group) =>
      group.classList.contains(CHROME_EXPANDED_CLASS),
    );
  }

  // ── 当前真实 chrome 几何 ────────────────────────────────────────────

  private expandedChromeElements(group: HTMLElement): HTMLElement[] {
    const elements: HTMLElement[] = [];
    const strip = group.querySelector<HTMLElement>(STRIP_SELECTOR);
    if (strip) elements.push(strip);
    const header = this.activeArmedHeader(group);
    if (header) elements.push(header);
    return elements;
  }

  private activeArmedHeader(group: HTMLElement): HTMLElement | null {
    const content = this.activeLeafContent(group);
    if (!content) return null;
    const type = content.dataset.type ?? "";
    const armed =
      (type === MARKDOWN_TYPE && this.isKindArmed("fileHeader")) ||
      (WEBVIEWER_TYPES.has(type) && this.isKindArmed("webviewerHeader"));
    return armed ? content.querySelector<HTMLElement>(HEADER_SELECTOR) : null;
  }

  private activeLeafContent(group: HTMLElement): HTMLElement | null {
    const activeLeaf = group.querySelector<HTMLElement>(ACTIVE_LEAF_SELECTOR);
    if (activeLeaf) {
      return activeLeaf.querySelector<HTMLElement>(LEAF_CONTENT_SELECTOR);
    }

    const contents = Array.from(
      group.querySelectorAll<HTMLElement>(LEAF_CONTENT_SELECTOR),
    );
    if (contents.length === 1) return contents[0] ?? null;
    return (
      contents.find((content) => {
        const leaf = content.closest<HTMLElement>(".workspace-leaf");
        if (!leaf) return false;
        const style = window.getComputedStyle(leaf);
        return style.display !== "none" && style.visibility !== "hidden";
      }) ?? null
    );
  }

  private groupHasArmedLayer(group: HTMLElement): boolean {
    return this.hasArmedTabStrip(group) || this.activeArmedHeader(group) !== null;
  }

  private hasArmedTabStrip(group: HTMLElement): boolean {
    return (
      this.isKindArmed("tabBar") &&
      !group.matches(GROUP_EXCLUDED_SELECTOR) &&
      group.querySelector(STRIP_SELECTOR) !== null
    );
  }

  private isKindArmed(kind: ChromeAutoHideKind): boolean {
    return document.body.classList.contains(CHROME_AUTOHIDE_KIND_CLASS[kind]);
  }

  private expandedChromeBand(
    group: HTMLElement,
  ): Pick<DOMRect, "left" | "right" | "top" | "bottom"> | null {
    const rects = this.expandedChromeElements(group)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return null;
    const groupRect = group.getBoundingClientRect();
    return {
      left: groupRect.left,
      right: groupRect.right,
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
  }

  private pointInElement(point: Point, element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return this.pointInRect(point, rect);
  }

  private pointInRect(
    point: Point,
    rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  ): boolean {
    return (
      point.x >= rect.left &&
      point.x < rect.right &&
      point.y >= rect.top &&
      point.y < rect.bottom
    );
  }

  private groupFromChromeTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const group = target.closest<HTMLElement>(GROUP_SELECTOR);
    if (!group || !this.groups.includes(group)) return null;
    return this.expandedChromeElements(group).some((element) =>
      element.contains(target),
    )
      ? group
      : null;
  }

  private groupForSensor(sensor: HTMLElement): HTMLElement | null {
    for (const [group, candidate] of this.sensors) {
      if (candidate === sensor) return group;
    }
    return null;
  }

  // ── 工具栏弹出层归属 ────────────────────────────────────────────────

  private setOverlayOwner(group: HTMLElement): void {
    if (this.overlayOwner === group) return;
    this.clearOverlayOwnership();
    this.overlayOwner = group;
  }

  private captureOwnedOverlay(target: EventTarget | null | undefined): boolean {
    if (!this.overlayOwner || !(target instanceof Element)) return false;
    const overlay = target.closest<HTMLElement>(INTERACTIVE_OVERLAY_SELECTOR);
    if (!overlay || !this.isLiveOverlay(overlay)) return false;
    this.ownedOverlays.add(overlay);
    this.observeOwnedOverlays();
    this.outsideSince.delete(this.overlayOwner);
    return true;
  }

  private cursorInOwnedOverlay(group: HTMLElement, point: Point): boolean {
    if (this.overlayOwner !== group) return false;
    this.pruneOwnedOverlays();
    return [...this.ownedOverlays].some((overlay) =>
      this.pointInElement(point, overlay),
    );
  }

  private pruneOwnedOverlays(): void {
    for (const overlay of this.ownedOverlays) {
      if (!this.isLiveOverlay(overlay)) this.ownedOverlays.delete(overlay);
    }
    if (this.ownedOverlays.size === 0) this.stopObservingOwnedOverlays();
  }

  private isLiveOverlay(overlay: HTMLElement): boolean {
    return (
      overlay.isConnected &&
      !overlay.hidden &&
      overlay.getAttribute("aria-hidden") !== "true"
    );
  }

  private observeOwnedOverlays(): void {
    if (this.overlayObserver || !document.body) return;
    this.overlayObserver = new MutationObserver(() => this.pruneOwnedOverlays());
    this.overlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "hidden"],
    });
  }

  private stopObservingOwnedOverlays(): void {
    this.overlayObserver?.disconnect();
    this.overlayObserver = null;
  }

  private clearOverlayOwnership(): void {
    this.stopObservingOwnedOverlays();
    this.ownedOverlays.clear();
    this.overlayOwner = null;
  }

  // ── sensor 与生命周期 ───────────────────────────────────────────────

  private sensorFromTarget(
    target: EventTarget | null | undefined,
  ): HTMLElement | null {
    return target instanceof HTMLElement &&
      target.classList.contains(CHROME_SENSOR_CLASS)
      ? target
      : null;
  }

  private refreshGroups(): void {
    const nextGroups = Array.from(
      document.querySelectorAll<HTMLElement>(GROUP_SELECTOR),
    );
    const nextSet = new Set(nextGroups);
    for (const group of this.groups) {
      if (nextSet.has(group)) continue;
      this.outsideSince.delete(group);
      group.classList.remove(CHROME_EXPANDED_CLASS);
      if (this.overlayOwner === group) this.clearOverlayOwnership();
      this.sensors.get(group)?.remove();
      this.sensors.delete(group);
    }
    this.groups = nextGroups;
    for (const group of this.groups) {
      if (!this.sensors.has(group)) {
        const sensor = document.body.createDiv({ cls: CHROME_SENSOR_CLASS });
        sensor.addEventListener("pointerenter", this.onSensorPointerEnter, {
          passive: true,
        });
        this.sensors.set(group, sensor);
      }
      this.updateSensor(group);
    }
    this.syncAllSensors();
    if (this.hasExpandedGroup()) this.startCursorPolling();
  }

  private activeLeafChanged(): void {
    for (const group of this.groups) {
      if (!this.groupHasArmedLayer(group)) this.collapseGroup(group);
      this.updateSensor(group);
    }
  }

  private updateSensor(group: HTMLElement): void {
    const sensor = this.sensors.get(group);
    if (!sensor) return;
    const show =
      this.groupHasArmedLayer(group) &&
      !group.classList.contains(CHROME_EXPANDED_CLASS);
    sensor.style.display = show ? "block" : "none";
    if (show) this.syncSensorRect(group);
  }

  private syncAllSensors(): void {
    for (const group of this.groups) this.syncSensorRect(group);
  }

  private syncSensorRect(group: HTMLElement): void {
    const sensor = this.sensors.get(group);
    if (!sensor || sensor.style.display === "none" || !group.isConnected) return;
    const groupRect = group.getBoundingClientRect();
    const strip = group.querySelector<HTMLElement>(STRIP_SELECTOR);
    const stripRect = strip?.getBoundingClientRect();
    const sensorTop =
      !this.hasArmedTabStrip(group) && stripRect && stripRect.height > 0
        ? stripRect.bottom
        : groupRect.top;
    sensor.style.left = `${groupRect.left}px`;
    sensor.style.top = `${sensorTop}px`;
    sensor.style.width = `${groupRect.width}px`;
    sensor.style.height = `${SENSOR_HEIGHT_PX}px`;
  }

  private disposeDom(): void {
    this.stopCursorPolling();
    this.cursorRuntime = null;
    this.outsideSince.clear();
    this.clearOverlayOwnership();
    for (const kind of Object.keys(CHROME_AUTOHIDE_KIND_CLASS) as ChromeAutoHideKind[]) {
      document.body.classList.remove(CHROME_AUTOHIDE_KIND_CLASS[kind]);
    }
    for (const group of this.groups) group.classList.remove(CHROME_EXPANDED_CLASS);
    for (const sensor of this.sensors.values()) sensor.remove();
    this.sensors.clear();
    this.groups = [];
  }
}
