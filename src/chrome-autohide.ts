import type MvAideIdePlugin from "../main";
import { isObsidianWorkspaceDragEvent } from "./workspace-drag";

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
const SENSOR_HEIGHT_PX = 20;
const GEOMETRY_STABLE_FRAMES = 2;
const GEOMETRY_STABILIZE_MAX_MS = 750;
const WORKSPACE_DRAG_WATCHDOG_MS = 30_000;
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
  BrowserWindow?: {
    getAllWindows?: () => ElectronBrowserWindowLike[];
  };
  getCurrentWindow?: () => ElectronBrowserWindowLike;
}

interface ElectronBrowserWindowLike {
  getContentBounds?: () => ElectronRectangle;
  isDestroyed?: () => boolean;
  webContents?: {
    getZoomFactor?: () => number;
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
  return createElectronChromeCursorRuntimeFactory(hostWindow)(hostWindow);
}

/**
 * Build one privileged Electron sampler and project it into every Obsidian
 * window. Popout renderers are sandboxed and intentionally do not need their
 * own `require`; their standard screen geometry is matched against the native
 * BrowserWindow list owned by the main renderer.
 */
export function createElectronChromeCursorRuntimeFactory(
  privilegedWindow: Window,
): ChromeCursorRuntimeFactory {
  const requireModule = (privilegedWindow as Window & {
    require?: RuntimeRequire;
  }).require;
  if (typeof requireModule !== "function") return () => null;

  try {
    const electron = requireModule("electron") as ElectronRendererLike;
    let remote = electron.remote;
    const hasWindowLookup = (candidate: ElectronRemoteLike | undefined): boolean =>
      typeof candidate?.BrowserWindow?.getAllWindows === "function" ||
      typeof candidate?.getCurrentWindow === "function";
    if (
      typeof remote?.screen?.getCursorScreenPoint !== "function" ||
      !hasWindowLookup(remote)
    ) {
      remote = requireModule("@electron/remote") as ElectronRemoteLike;
    }
    const screen = remote?.screen;
    const getAllWindows = remote?.BrowserWindow?.getAllWindows;
    const currentWindow = remote?.getCurrentWindow?.();
    if (
      typeof screen?.getCursorScreenPoint !== "function"
    ) {
      return () => null;
    }

    const nativeWindows = (): ElectronBrowserWindowLike[] => {
      if (typeof getAllWindows === "function") {
        try {
          const candidates = getAllWindows.call(remote?.BrowserWindow).filter((candidate) =>
            candidate.isDestroyed?.() !== true &&
            typeof candidate.getContentBounds === "function");
          if (candidates.length > 0) return candidates;
        } catch {
          // Fall through to the privileged current window when enumeration is
          // transiently unavailable during a native window lifecycle change.
        }
      }
      return typeof currentWindow?.getContentBounds === "function"
        ? [currentWindow]
        : [];
    };

    return (hostWindow): ChromeCursorRuntime | null => {
      if (hostWindow !== privilegedWindow && typeof getAllWindows !== "function") {
        return null;
      }
      let nativeWindow: ElectronBrowserWindowLike | null = null;

      const zoomFor = (
        candidate: ElectronBrowserWindowLike,
        bounds: ElectronRectangle,
      ): number => {
        const nativeZoom = candidate.webContents?.getZoomFactor?.();
        const privilegedZoom =
          hostWindow === privilegedWindow && candidate === currentWindow
            ? electron.webFrame?.getZoomFactor?.()
            : undefined;
        const reportedZoom = nativeZoom ?? privilegedZoom;
        const widthZoom = hostWindow.innerWidth > 0
          ? bounds.width / hostWindow.innerWidth
          : 1;
        return reportedZoom !== undefined && finite(reportedZoom) && reportedZoom > 0
          ? reportedZoom
          : widthZoom;
      };

      const nativeGeometry = (): {
        bounds: ElectronRectangle;
        zoomFactor: number;
      } | null => {
        const hostX = hostWindow.screenX;
        const hostY = hostWindow.screenY;
        const candidates = nativeWindows();
        let best: {
          candidate: ElectronBrowserWindowLike;
          bounds: ElectronRectangle;
          zoomFactor: number;
          score: number;
        } | null = null;
        for (const candidate of candidates) {
          let bounds: ElectronRectangle;
          try {
            bounds = candidate.getContentBounds!();
          } catch {
            continue;
          }
          const zoomFactor = zoomFor(candidate, bounds);
          if (!finite(zoomFactor) || zoomFactor <= 0) continue;
          const expectedWidth = hostWindow.innerWidth * zoomFactor;
          const expectedHeight = hostWindow.innerHeight * zoomFactor;
          const score =
            Math.abs(bounds.x - hostX) +
            Math.abs(bounds.y - hostY) +
            Math.abs(bounds.width - expectedWidth) +
            Math.abs(bounds.height - expectedHeight);
          if (!best || score < best.score) {
            best = { candidate, bounds, zoomFactor, score };
          }
        }
        if (!best) return null;
        const maximumMatchError = Math.max(
          96,
          (best.bounds.width + best.bounds.height) * 0.08,
        );
        if (best.score > maximumMatchError) return null;
        nativeWindow = best.candidate;
        return { bounds: best.bounds, zoomFactor: best.zoomFactor };
      };

      return {
        sample(): ChromeCursorSample | null {
          try {
            const cursor = screen.getCursorScreenPoint!();
            let geometry: {
              bounds: ElectronRectangle;
              zoomFactor: number;
            } | null = null;
            if (
              nativeWindow &&
              nativeWindow.isDestroyed?.() !== true &&
              typeof nativeWindow.getContentBounds === "function"
            ) {
              const bounds = nativeWindow.getContentBounds();
              const zoomFactor = zoomFor(nativeWindow, bounds);
              const moved =
                Math.abs(bounds.x - hostWindow.screenX) > 2 ||
                Math.abs(bounds.y - hostWindow.screenY) > 2;
              if (!moved && finite(zoomFactor) && zoomFactor > 0) {
                geometry = { bounds, zoomFactor };
              }
            }
            geometry ??= nativeGeometry();
            if (!geometry) return null;
            const { bounds, zoomFactor } = geometry;
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
    };
  } catch {
    return () => null;
  }
}

/**
 * 三类顶部 chrome 共用的自动隐藏控制器。
 *
 * sensor 只负责唤出。展开以后，唯一真值是 Electron 返回的系统指针位置：
 * 指针仍在该组完整标签栏、活动页工具栏或所属弹层内时永不收起；连续离开
 * 120ms 后才收起。标签栏空白的原生窗口 drag 区不需要派发任何 DOM 事件。
 */
interface DragCoordinator {
  isActive(): boolean;
  start(controller: ChromeAutoHideWindowController): void;
  touch(controller: ChromeAutoHideWindowController): void;
  finish(controller: ChromeAutoHideWindowController): void;
}

interface OwnedWindowTimer {
  readonly owner: Window;
  readonly id: number;
}

/** Coordinates independent auto-hide controllers for every Obsidian window. */
export class ChromeAutoHideFeature {
  private readonly controllers = new Map<Window, ChromeAutoHideWindowController>();
  private readonly enabled: Record<ChromeAutoHideKind, boolean> = {
    tabBar: false,
    fileHeader: false,
    webviewerHeader: false,
  };
  private registered = false;
  private workspaceDragActive = false;
  private workspaceDragGeneration = 0;
  private workspaceDragWatchdog: OwnedWindowTimer | null = null;
  private readonly cursorRuntimeFactory: ChromeCursorRuntimeFactory;

  constructor(
    private readonly plugin: MvAideIdePlugin,
    cursorRuntimeFactory?: ChromeCursorRuntimeFactory,
  ) {
    const privilegedWindow =
      plugin.app.workspace.containerEl?.ownerDocument.defaultView ??
      document.defaultView ??
      window;
    this.cursorRuntimeFactory = cursorRuntimeFactory ??
      createElectronChromeCursorRuntimeFactory(privilegedWindow);
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;
    this.syncWindows();
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => {
        this.syncWindows();
        for (const controller of this.controllers.values()) controller.layoutChanged();
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("resize", () => {
        this.syncWindows();
        for (const controller of this.controllers.values()) controller.viewportChanged();
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("active-leaf-change", () => {
        this.syncWindows();
        for (const controller of this.controllers.values()) controller.activeLeafChanged();
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-open", (_workspaceWindow, hostWindow) => {
        this.ensureController(hostWindow);
        hostWindow.queueMicrotask(() => this.controllers.get(hostWindow)?.layoutChanged());
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-close", (_workspaceWindow, hostWindow) => {
        this.removeController(hostWindow);
      }),
    );
    this.plugin.register(() => this.dispose());
  }

  setEnabled(kind: ChromeAutoHideKind, enabled: boolean): void {
    this.enabled[kind] = enabled;
    this.syncWindows();
    for (const controller of this.controllers.values()) {
      controller.setEnabled(kind, enabled);
    }
  }

  private readonly dragCoordinator: DragCoordinator = {
    isActive: () => this.workspaceDragActive,
    start: (controller) => this.startWorkspaceDrag(controller),
    touch: (controller) => this.touchWorkspaceDrag(controller),
    finish: (controller) => this.finishWorkspaceDrag(controller),
  };

  private syncWindows(): void {
    const workspace = this.plugin.app.workspace;
    const mainWindow = workspace.containerEl?.ownerDocument.defaultView ??
      document.defaultView ?? window;
    this.ensureController(mainWindow);
    workspace.iterateAllLeaves?.((leaf) => {
      const hostWindow = leaf.view?.containerEl?.ownerDocument.defaultView;
      if (hostWindow) this.ensureController(hostWindow);
    });
    for (const [hostWindow] of this.controllers) {
      if (hostWindow.closed) this.removeController(hostWindow);
    }
  }

  private ensureController(hostWindow: Window): ChromeAutoHideWindowController {
    let controller = this.controllers.get(hostWindow);
    if (controller) return controller;
    controller = new ChromeAutoHideWindowController(
      hostWindow,
      this.cursorRuntimeFactory,
      this.dragCoordinator,
    );
    this.controllers.set(hostWindow, controller);
    controller.register(this.enabled);
    if (this.workspaceDragActive) controller.setWorkspaceDrag(true);
    return controller;
  }

  private removeController(hostWindow: Window): void {
    const controller = this.controllers.get(hostWindow);
    if (!controller) return;
    controller.dispose();
    this.controllers.delete(hostWindow);
  }

  private startWorkspaceDrag(controller: ChromeAutoHideWindowController): void {
    this.workspaceDragGeneration += 1;
    this.workspaceDragActive = true;
    for (const candidate of this.controllers.values()) candidate.setWorkspaceDrag(true);
    this.renewWorkspaceDragWatchdog(controller.hostWindow);
  }

  private touchWorkspaceDrag(controller: ChromeAutoHideWindowController): void {
    if (!this.workspaceDragActive) {
      this.startWorkspaceDrag(controller);
      return;
    }
    controller.setWorkspaceDrag(true);
    this.renewWorkspaceDragWatchdog(controller.hostWindow);
  }

  private finishWorkspaceDrag(controller: ChromeAutoHideWindowController): void {
    if (!this.workspaceDragActive) return;
    const generation = this.workspaceDragGeneration;
    controller.hostWindow.queueMicrotask(() => {
      if (
        !this.workspaceDragActive ||
        generation !== this.workspaceDragGeneration
      ) return;
      this.workspaceDragActive = false;
      this.clearWorkspaceDragWatchdog();
      for (const candidate of this.controllers.values()) candidate.setWorkspaceDrag(false);
    });
  }

  private renewWorkspaceDragWatchdog(owner: Window): void {
    this.clearWorkspaceDragWatchdog();
    const id = owner.setTimeout(() => {
      this.workspaceDragWatchdog = null;
      if (!this.workspaceDragActive) return;
      this.workspaceDragActive = false;
      for (const controller of this.controllers.values()) controller.setWorkspaceDrag(false);
    }, WORKSPACE_DRAG_WATCHDOG_MS);
    this.workspaceDragWatchdog = { owner, id };
  }

  private clearWorkspaceDragWatchdog(): void {
    const timer = this.workspaceDragWatchdog;
    if (!timer) return;
    timer.owner.clearTimeout(timer.id);
    this.workspaceDragWatchdog = null;
  }

  private dispose(): void {
    this.registered = false;
    this.workspaceDragActive = false;
    this.workspaceDragGeneration += 1;
    this.clearWorkspaceDragWatchdog();
    for (const controller of this.controllers.values()) controller.dispose();
    this.controllers.clear();
  }
}

/** Existing single-window state machine, scoped to one concrete document. */
class ChromeAutoHideWindowController {
  private groups: HTMLElement[] = [];
  private sensors = new Map<HTMLElement, HTMLElement>();
  private outsideSince = new Map<HTMLElement, number>();
  private cursorRuntime: ChromeCursorRuntime | null = null;
  private cursorPollHandle: number | null = null;
  private overlayOwner: HTMLElement | null = null;
  private ownedOverlays = new Set<HTMLElement>();
  private overlayObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private geometryFrame: number | null = null;
  private geometryFrameUsesAnimationFrame = false;
  private geometryStartedAt = 0;
  private geometryStableFrames = 0;
  private geometrySignature = "";
  private workspaceDrag = false;
  private windowHoverActive = false;

  constructor(
    readonly hostWindow: Window,
    private readonly cursorRuntimeFactory: ChromeCursorRuntimeFactory,
    private readonly dragCoordinator: DragCoordinator,
  ) {}

  private get ownerDocument(): Document {
    return this.hostWindow.document;
  }

  register(enabled: Readonly<Record<ChromeAutoHideKind, boolean>>): void {
    this.cursorRuntime = this.cursorRuntimeFactory(this.hostWindow);
    for (const kind of Object.keys(enabled) as ChromeAutoHideKind[]) {
      this.ownerDocument.body.classList.toggle(
        CHROME_AUTOHIDE_KIND_CLASS[kind],
        enabled[kind] && this.cursorRuntime !== null,
      );
    }
    this.refreshGroups();
    this.ownerDocument.addEventListener("pointerdown", this.onPointerDown, {
      capture: true, passive: true,
    });
    this.ownerDocument.addEventListener("pointerover", this.onPointerOver, {
      capture: true, passive: true,
    });
    this.hostWindow.addEventListener("mouseenter", this.onWindowMouseEnter, {
      passive: true,
    });
    this.hostWindow.addEventListener("mouseleave", this.onWindowMouseLeave, {
      passive: true,
    });
    this.ownerDocument.addEventListener("dragstart", this.onDragStart, true);
    this.ownerDocument.addEventListener("dragover", this.onDragOver, true);
    this.ownerDocument.addEventListener("dragend", this.onDragFinished, true);
    this.ownerDocument.addEventListener("drop", this.onDragFinished, true);
    this.ownerDocument.addEventListener("keydown", this.onKeyDown, true);
    this.ownerDocument.addEventListener("transitionrun", this.onLayoutTransition, true);
    this.ownerDocument.addEventListener("transitionend", this.onLayoutTransition, true);
    this.ownerDocument.addEventListener("transitioncancel", this.onLayoutTransition, true);
    this.hostWindow.addEventListener("resize", this.onViewportChanged, { passive: true });
  }

  setEnabled(kind: ChromeAutoHideKind, enabled: boolean): void {
    const canEnable = enabled && this.cursorRuntime !== null;
    this.ownerDocument.body.classList.toggle(CHROME_AUTOHIDE_KIND_CLASS[kind], canEnable);
    for (const group of this.groups) {
      if (!this.groupHasArmedLayer(group)) this.collapseGroup(group);
      this.updateSensor(group);
    }
    if (this.windowHoverActive && this.hasArmedGroup()) this.startCursorPolling();
    else if (!this.hasExpandedGroup()) this.stopCursorPolling();
    this.startGeometryStabilization();
  }

  layoutChanged(): void {
    this.refreshGroups();
    this.startGeometryStabilization();
  }

  viewportChanged(): void {
    this.syncAllSensors();
    this.startGeometryStabilization();
  }

  activeLeafChanged(): void {
    for (const group of this.groups) {
      if (!this.groupHasArmedLayer(group)) this.collapseGroup(group);
      else if (this.workspaceDrag) this.expandGroup(group);
      this.updateSensor(group);
    }
    this.refreshResizeObserver();
    this.startGeometryStabilization();
  }

  setWorkspaceDrag(active: boolean): void {
    if (this.workspaceDrag === active) return;
    this.workspaceDrag = active;
    this.outsideSince.clear();
    if (active) {
      for (const group of this.groups) {
        if (this.groupHasArmedLayer(group)) this.expandGroup(group);
      }
      return;
    }
    if (this.hasExpandedGroup()) this.startCursorPolling();
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
    this.activateWindowHover();
    this.captureOwnedOverlay(event.target);
  };

  private readonly onWindowMouseEnter = (): void => {
    this.activateWindowHover();
  };

  private readonly onWindowMouseLeave = (): void => {
    this.windowHoverActive = false;
    if (!this.hasExpandedGroup()) this.stopCursorPolling();
  };

  private activateWindowHover(): void {
    this.windowHoverActive = true;
    if (this.hasArmedGroup()) this.startCursorPolling();
  }

  private onViewportChanged = (): void => {
    this.viewportChanged();
  };

  private readonly onLayoutTransition = (): void => {
    this.startGeometryStabilization();
  };

  private readonly onDragStart = (event: DragEvent): void => {
    if (!isObsidianWorkspaceDragEvent(this.ownerDocument, event)) return;
    this.dragCoordinator.start(this);
  };

  private readonly onDragOver = (event: DragEvent): void => {
    if (
      !this.dragCoordinator.isActive() &&
      !isObsidianWorkspaceDragEvent(this.ownerDocument, event)
    ) return;
    this.dragCoordinator.touch(this);
  };

  private readonly onDragFinished = (): void => {
    if (this.dragCoordinator.isActive()) this.dragCoordinator.finish(this);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.dragCoordinator.isActive()) {
      this.dragCoordinator.finish(this);
    }
  };

  private startCursorPolling(): void {
    if (this.cursorRuntime === null || this.cursorPollHandle !== null) return;
    this.pollCursor();
    this.cursorPollHandle = this.hostWindow.setInterval(
      this.pollCursor,
      CHROME_CURSOR_POLL_MS,
    );
  }

  private stopCursorPolling(): void {
    if (this.cursorPollHandle === null) return;
    this.hostWindow.clearInterval(this.cursorPollHandle);
    this.cursorPollHandle = null;
  }

  private pollCursor = (): void => {
    if (!this.windowHoverActive && !this.hasExpandedGroup()) {
      this.stopCursorPolling();
      return;
    }

    const sample = this.cursorRuntime?.sample() ?? null;
    if (!sample) {
      // 无系统坐标时不允许沿用旧位置收起，宁可保持展开也不能误判。
      for (const group of this.expandedGroups()) this.outsideSince.delete(group);
      return;
    }

    const point = this.cursorClientPoint(sample);
    if (this.windowHoverActive && point) {
      for (const group of this.groups) {
        if (
          !group.classList.contains(CHROME_EXPANDED_CLASS) &&
          this.pointInCollapsedTrigger(group, point)
        ) {
          this.expandGroup(group);
        }
      }
    }

    this.pruneOwnedOverlays();
    const now = Date.now();
    for (const group of this.expandedGroups()) {
      if (!group.isConnected || !this.groupHasArmedLayer(group)) {
        this.collapseGroup(group);
        continue;
      }
      if (this.workspaceDrag || this.cursorInRetainedRegion(group, sample)) {
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

    if (!this.hasExpandedGroup() && !this.windowHoverActive) this.stopCursorPolling();
  };

  private expandedGroups(): HTMLElement[] {
    return this.groups.filter((group) =>
      group.classList.contains(CHROME_EXPANDED_CLASS),
    );
  }

  private pointInCollapsedTrigger(group: HTMLElement, point: Point): boolean {
    if (!group.isConnected || !this.groupHasArmedLayer(group)) return false;
    const groupRect = group.getBoundingClientRect();
    const stripRect = group.querySelector<HTMLElement>(STRIP_SELECTOR)
      ?.getBoundingClientRect();
    const top =
      !this.hasArmedTabStrip(group) && stripRect && stripRect.height > 0
        ? stripRect.bottom
        : groupRect.top;
    return this.pointInRect(point, {
      left: groupRect.left,
      right: groupRect.right,
      top,
      bottom: top + SENSOR_HEIGHT_PX,
    });
  }

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
    if (!this.hasExpandedGroup() && !this.windowHoverActive) this.stopCursorPolling();
  }

  private hasExpandedGroup(): boolean {
    return this.groups.some((group) =>
      group.classList.contains(CHROME_EXPANDED_CLASS),
    );
  }

  private hasArmedGroup(): boolean {
    return this.groups.some((group) => this.groupHasArmedLayer(group));
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
        const style = this.hostWindow.getComputedStyle(leaf);
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
    return this.ownerDocument.body.classList.contains(CHROME_AUTOHIDE_KIND_CLASS[kind]);
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
    const element = this.elementFromTarget(target);
    if (!element) return null;
    const group = element.closest<HTMLElement>(GROUP_SELECTOR);
    if (!group || !this.groups.includes(group)) return null;
    return this.expandedChromeElements(group).some((element) =>
      element.contains(target as Node),
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
    const element = this.elementFromTarget(target);
    if (!this.overlayOwner || !element) return false;
    const overlay = element.closest<HTMLElement>(INTERACTIVE_OVERLAY_SELECTOR);
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
    if (this.overlayObserver || !this.ownerDocument.body) return;
    const MutationObserverCtor = (this.hostWindow as Window & {
      MutationObserver: typeof MutationObserver;
    }).MutationObserver;
    const observer = new MutationObserverCtor(() => this.pruneOwnedOverlays());
    this.overlayObserver = observer;
    observer.observe(this.ownerDocument.body, {
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
    const element = this.elementFromTarget(target);
    return element?.classList.contains(CHROME_SENSOR_CLASS)
      ? element as HTMLElement
      : null;
  }

  private elementFromTarget(target: EventTarget | null | undefined): Element | null {
    const element = target as Partial<Element> | null | undefined;
    return element?.ownerDocument === this.ownerDocument &&
      typeof element.closest === "function"
      ? element as Element
      : null;
  }

  private refreshGroups(): void {
    const nextGroups = Array.from(
      this.ownerDocument.querySelectorAll<HTMLElement>(GROUP_SELECTOR),
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
        const sensor = this.ownerDocument.body.createDiv({ cls: CHROME_SENSOR_CLASS });
        sensor.addEventListener("pointerenter", this.onSensorPointerEnter, {
          passive: true,
        });
        this.sensors.set(group, sensor);
      }
      this.updateSensor(group);
      if (this.workspaceDrag && this.groupHasArmedLayer(group)) this.expandGroup(group);
    }
    this.syncAllSensors();
    this.refreshResizeObserver();
    if (this.hasExpandedGroup()) this.startCursorPolling();
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

  private refreshResizeObserver(): void {
    this.resizeObserver?.disconnect();
    const ResizeObserverCtor = (this.hostWindow as Window & {
      ResizeObserver?: typeof ResizeObserver;
    }).ResizeObserver;
    if (typeof ResizeObserverCtor !== "function") {
      this.resizeObserver = null;
      return;
    }
    const observer = new ResizeObserverCtor(() => {
      this.syncAllSensors();
      this.startGeometryStabilization();
    });
    this.resizeObserver = observer;
    for (const group of this.groups) {
      observer.observe(group);
      const strip = group.querySelector<HTMLElement>(STRIP_SELECTOR);
      if (strip) observer.observe(strip);
    }
  }

  private startGeometryStabilization(): void {
    if (this.geometryFrame !== null) return;
    this.geometryStartedAt = Date.now();
    this.geometryStableFrames = 0;
    this.geometrySignature = this.currentGeometrySignature();
    this.scheduleGeometryFrame();
  }

  private scheduleGeometryFrame(): void {
    if (typeof this.hostWindow.requestAnimationFrame === "function") {
      this.geometryFrameUsesAnimationFrame = true;
      this.geometryFrame = this.hostWindow.requestAnimationFrame(this.stabilizeGeometry);
      return;
    }
    this.geometryFrameUsesAnimationFrame = false;
    this.geometryFrame = this.hostWindow.setTimeout(() => this.stabilizeGeometry(), 16);
  }

  private readonly stabilizeGeometry = (): void => {
    this.geometryFrame = null;
    this.syncAllSensors();
    const signature = this.currentGeometrySignature();
    if (signature === this.geometrySignature) this.geometryStableFrames += 1;
    else {
      this.geometrySignature = signature;
      this.geometryStableFrames = 0;
    }
    if (
      this.geometryStableFrames >= GEOMETRY_STABLE_FRAMES ||
      Date.now() - this.geometryStartedAt >= GEOMETRY_STABILIZE_MAX_MS
    ) return;
    this.scheduleGeometryFrame();
  };

  private currentGeometrySignature(): string {
    return this.groups.map((group) => {
      const groupRect = group.getBoundingClientRect();
      const stripRect = group.querySelector<HTMLElement>(STRIP_SELECTOR)
        ?.getBoundingClientRect();
      return [
        groupRect.left, groupRect.top, groupRect.width, groupRect.height,
        stripRect?.left, stripRect?.top, stripRect?.width, stripRect?.height,
      ].join(":");
    }).join("|");
  }

  private stopGeometryStabilization(): void {
    if (this.geometryFrame === null) return;
    if (this.geometryFrameUsesAnimationFrame) {
      this.hostWindow.cancelAnimationFrame(this.geometryFrame);
    } else {
      this.hostWindow.clearTimeout(this.geometryFrame);
    }
    this.geometryFrame = null;
  }

  dispose(): void {
    this.stopCursorPolling();
    this.stopGeometryStabilization();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cursorRuntime = null;
    this.windowHoverActive = false;
    this.outsideSince.clear();
    this.clearOverlayOwnership();
    for (const kind of Object.keys(CHROME_AUTOHIDE_KIND_CLASS) as ChromeAutoHideKind[]) {
      this.ownerDocument.body.classList.remove(CHROME_AUTOHIDE_KIND_CLASS[kind]);
    }
    for (const group of this.groups) group.classList.remove(CHROME_EXPANDED_CLASS);
    for (const sensor of this.sensors.values()) sensor.remove();
    this.sensors.clear();
    this.groups = [];
    this.ownerDocument.removeEventListener("pointerdown", this.onPointerDown, true);
    this.ownerDocument.removeEventListener("pointerover", this.onPointerOver, true);
    this.hostWindow.removeEventListener("mouseenter", this.onWindowMouseEnter);
    this.hostWindow.removeEventListener("mouseleave", this.onWindowMouseLeave);
    this.ownerDocument.removeEventListener("dragstart", this.onDragStart, true);
    this.ownerDocument.removeEventListener("dragover", this.onDragOver, true);
    this.ownerDocument.removeEventListener("dragend", this.onDragFinished, true);
    this.ownerDocument.removeEventListener("drop", this.onDragFinished, true);
    this.ownerDocument.removeEventListener("keydown", this.onKeyDown, true);
    this.ownerDocument.removeEventListener("transitionrun", this.onLayoutTransition, true);
    this.ownerDocument.removeEventListener("transitionend", this.onLayoutTransition, true);
    this.ownerDocument.removeEventListener("transitioncancel", this.onLayoutTransition, true);
    this.hostWindow.removeEventListener("resize", this.onViewportChanged);
  }
}
