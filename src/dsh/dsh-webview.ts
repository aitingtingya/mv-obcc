import {
  ItemView,
  Menu,
  Notice,
  setIcon,
  type ViewStateResult,
  type Workspace,
  type WorkspaceLeaf,
} from "obsidian";
import {
  applyBottomTerminalSplitRatio,
  createMainBottomLeaf,
} from "../workspace-context";
import type MvAideIdePlugin from "../../main";
import { t } from "../i18n";
import type { DshAutoOpenRegion } from "./dsh-settings";
import type { SelectionState } from "../types";
import { normalizeDshWebUrl, sameDshWebUrl } from "./dsh-process";

export const DSH_VIEW_TITLE = "mv-agent";
/**
 * mv-agent 自有的自定义视图类型：`<iframe>` + 底部状态栏，没有 Obsidian
 * 内置 Web Viewer 的工具栏（前进/后退/刷新/网页框/阅读视图/下载/历史/更多选项
 * 全部不存在），标签页右键菜单由 `onPaneMenu` 提供「刷新界面」。
 *
 * 用 iframe 而不是 Electron `<webview>`：实测动态创建的 webview 标签在本
 * 版本 Obsidian 中不渲染（灰屏）；dsh 页面不发送 X-Frame-Options / CSP
 * frame-ancestors，iframe 可正常加载，且无需任何特殊宿主支持。
 */
export const DSH_WEB_VIEW_TYPE = "mv-aide-dsh";

/** iframe 加载看门狗：navigation 后若在此时长内未确认可达则自动恢复。 */
const FRAME_LOAD_TIMEOUT_MS = 10_000;
/** 自动恢复失败后的静默重试间隔。 */
const AUTO_REFRESH_RETRY_MS = 15_000;
/** 「打开：」内容的截断长度。 */
const OPEN_MAX_CHARS = 20;

export function isDshWebviewLeaf(leaf: WorkspaceLeaf): boolean {
  return leaf.view?.getViewType?.() === DSH_WEB_VIEW_TYPE;
}

/**
 * Resolve the workspace leaf for a region. Pure enough to unit-test the
 * mapping by mocking `Workspace`.
 */
export function resolveDshLeaf(
  workspace: Workspace,
  region: DshAutoOpenRegion,
): WorkspaceLeaf | null {
  switch (region) {
    case "left":
      return workspace.getLeftLeaf(false);
    case "right":
      return workspace.getRightLeaf(false);
    case "bottom":
      // Reuse an existing mv-agent leaf anchored in the main area, so a
      // repeated command focuses it instead of stacking more splits.
      const existing = workspace
        .getLeavesOfType(DSH_WEB_VIEW_TYPE)
        .find((leaf) => leaf.getRoot() === workspace.rootSplit);
      if (existing) return existing;
      return createMainBottomLeaf(workspace);
  }
}

/** Open (or reveal) the mv-agent view in the requested region. */
export async function openDshWebview(
  workspace: Workspace,
  region: DshAutoOpenRegion,
  url: string,
): Promise<WorkspaceLeaf> {
  const leaf = resolveDshLeaf(workspace, region);
  if (!leaf) throw new Error("无法在所选分区打开 mv-agent 视图。");
  await leaf.setViewState({
    type: DSH_WEB_VIEW_TYPE,
    active: true,
    state: { url, title: DSH_VIEW_TITLE, navigate: true },
  });
  await workspace.revealLeaf(leaf);
  if (region === "bottom") {
    // Size the new bottom split for a comfortable reading area (40%).
    applyBottomTerminalSplitRatio(leaf, workspace, 40);
  }
  return leaf;
}

/** 「打开」位置原文：web 页用 URL（标题只在加载完才更新），md 用相对路径。 */
export function webSnapshotWhere(snapshot: SelectionState): string {
  const web = snapshot.resourceType === "web";
  if (web) {
    return (
      snapshot.url ||
      snapshot.title ||
      snapshot.relativePath ||
      snapshot.filePath ||
      "?"
    );
  }
  return snapshot.relativePath || snapshot.filePath || snapshot.title || "?";
}

/** 折叠行「打开：」内容截断为前 20 字符 + 「…」。 */
export function truncateOpenWhere(where: string): string {
  return where.length > OPEN_MAX_CHARS
    ? `${where.slice(0, OPEN_MAX_CHARS)}…`
    : where;
}

export interface DshStatusParts {
  /** 「打开：{截断位置}」段。 */
  open: string;
  /** 「打开：{完整位置}」段（展开明细用）。 */
  openFull: string;
  /** 「选中：{行范围/字数/光标/无}」段。 */
  selection: string;
}

/**
 * 状态栏「打开」「选中」两段的纯函数（带标签），供折叠行与展开明细共用。
 */
export function buildDshStatusParts(
  snapshot: SelectionState | null,
): DshStatusParts {
  if (!snapshot) {
    return {
      open: `${t("打开")}：—`,
      openFull: `${t("打开")}：—`,
      selection: `${t("选中")}：—`,
    };
  }
  const where = webSnapshotWhere(snapshot);
  const web = snapshot.resourceType === "web";
  const selection = snapshot.selection;
  let selectionText: string;
  if (!selection.isEmpty && selection.text.length > 0) {
    const count = selection.text.length;
    const start = selection.start.line + 1;
    const end = selection.end.line + 1;
    selectionText = web
      ? t("选中 {count} 字", { count })
      : start === end
        ? t("选中第 {start} 行", { start })
        : t("选中第 {start}–{end} 行", { start, end });
  } else if (web) {
    selectionText = t("无");
  } else {
    selectionText = t("光标第 {line} 行", { line: snapshot.cursor.line + 1 });
  }
  return {
    open: `${t("打开")}：${truncateOpenWhere(where)}`,
    openFull: `${t("打开")}：${where}`,
    selection: `${t("选中")}：${selectionText}`,
  };
}

function setTextIfChanged(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) element.setText(text);
}

/**
 * mv-agent 视图：iframe（无任何浏览器工具栏）+ 底部 Obsidian 侧状态栏。
 * 折叠行五段、段间竖线分隔：●（连接小球）│ [☑]打开：xxx │ [☑]选中：… │
 * 轨迹跟踪 开 │ 端口 3080（打开/选中前有方形勾选框：轨迹跟踪开时锁定勾选，
 * 关时默认勾选、可取消勾选以停止推送该信息）；点击整栏展开明细。
 */
export class DshWebView extends ItemView {
  private frameEl: HTMLIFrameElement | null = null;
  private currentUrl = "";
  private statusPortEl: HTMLSpanElement | null = null;
  private statusDotEl: HTMLSpanElement | null = null;
  private statusTrackingEl: HTMLSpanElement | null = null;
  private statusOpenEl: HTMLSpanElement | null = null;
  private statusLocationCheckEl: HTMLSpanElement | null = null;
  private statusOpenLabelEl: HTMLSpanElement | null = null;
  private statusSelectionEl: HTMLSpanElement | null = null;
  private statusSelectionCheckEl: HTMLSpanElement | null = null;
  private statusSelectionLabelEl: HTMLSpanElement | null = null;
  private statusCopyEl: HTMLButtonElement | null = null;
  private statusFailEl: HTMLSpanElement | null = null;
  private statusFailDividerEl: HTMLSpanElement | null = null;
  private statusDetailEl: HTMLDivElement | null = null;
  private detailPortEl: HTMLDivElement | null = null;
  private detailUrlEl: HTMLDivElement | null = null;
  private detailConnectionEl: HTMLDivElement | null = null;
  private detailTrackingEl: HTMLDivElement | null = null;
  private detailOpenEl: HTMLDivElement | null = null;
  private detailSelectionEl: HTMLDivElement | null = null;
  private detailSelectionTextEl: HTMLDivElement | null = null;
  private detailFailureEl: HTMLDivElement | null = null;
  private expanded = false;
  private loadFailed = false;
  private loadWatchdog: number | null = null;
  private autoRefreshTimer: number | null = null;
  private navigationGeneration = 0;
  private closed = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MvAideIdePlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return DSH_WEB_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("mv-agent");
  }

  getIcon(): string {
    return "bot";
  }

  /** The embedded iframe element. */
  get frame(): HTMLIFrameElement | null {
    return this.frameEl;
  }

  private viewWindow(): Window {
    return this.containerEl.ownerDocument.defaultView ?? activeWindow;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.buildUI();
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      url:
        normalizeDshWebUrl(this.currentUrl || this.frameEl?.src || "") ?? "",
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const generation = this.navigationGeneration;
    const stateObj = state as { url?: unknown } | undefined;
    let url = typeof stateObj?.url === "string" && stateObj.url ? stateObj.url : "";
    if (!url && this.plugin.dshFeature) {
      try {
        url = await this.plugin.dshFeature.resolveDshViewUrl();
      } catch {
        /* fallback handled by watchdog */
      }
    }
    if (this.closed || generation !== this.navigationGeneration) return;
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) return;
    this.currentUrl = normalized;
    if (this.frameEl && !sameDshWebUrl(this.frameEl.src, normalized)) {
      this.navigate(normalized);
    }
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.navigationGeneration += 1;
    this.clearLoadWatchdog();
    this.clearAutoRefreshTimer();
    this.frameEl?.remove();
    this.frameEl = null;
    this.statusPortEl = null;
    this.statusDotEl = null;
    this.statusTrackingEl = null;
    this.statusOpenEl = null;
    this.statusLocationCheckEl = null;
    this.statusOpenLabelEl = null;
    this.statusSelectionEl = null;
    this.statusSelectionCheckEl = null;
    this.statusSelectionLabelEl = null;
    this.statusCopyEl = null;
    this.statusFailEl = null;
    this.statusFailDividerEl = null;
    this.statusDetailEl = null;
    this.detailPortEl = null;
    this.detailUrlEl = null;
    this.detailConnectionEl = null;
    this.detailTrackingEl = null;
    this.detailOpenEl = null;
    this.detailSelectionEl = null;
    this.detailSelectionTextEl = null;
    this.detailFailureEl = null;
  }

  /** 标签页右键菜单：追加「刷新界面」。 */
  onPaneMenu(menu: Menu, source: string): void {
    // 不按 source 过滤：主区标签为 "tab-header"，侧边栏标签为
    // "sidebar-context-menu"，⋮ 菜单为 "more-options"，都要带上。
    menu.addItem((item) =>
      item
        .setTitle(t("刷新界面"))
        .setIcon("refresh-ccw")
        .onClick(() => void this.refresh()),
    );
  }

  /**
   * 刷新界面：当前 URL 可达则重载；否则在电脑上寻找已打开的 dsh 端口
   * （findDshUrl），找不到再拉起一个实例（ensureStarted）。
   */
  async refresh(): Promise<void> {
    const feature = this.plugin.dshFeature;
    const frame = this.frameEl;
    if (!feature || !frame) return;
    const generation = this.navigationGeneration;
    try {
      const url = await feature.resolveDshViewUrl();
      if (
        this.closed ||
        generation !== this.navigationGeneration ||
        frame !== this.frameEl
      ) {
        return;
      }
      const current = frame.src || "";
      if (sameDshWebUrl(url, current)) {
        this.reload();
      } else {
        this.navigate(url);
      }
    } catch (error) {
      new Notice(
        t("刷新失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  navigate(url: string): void {
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) {
      this.loadFailed = true;
      this.renderStatus();
      return;
    }
    const frame = this.frameEl;
    if (!frame) return;
    this.currentUrl = normalized;
    if (sameDshWebUrl(frame.src, normalized)) return;
    this.beginNavigation(normalized, () => {
      frame.src = normalized;
    });
  }

  reload(): void {
    const frame = this.frameEl;
    if (!frame) return;
    const target = normalizeDshWebUrl(this.currentUrl || frame.src);
    if (!target) return;
    this.beginNavigation(target, () => {
      try {
        const contentWindow = frame.contentWindow;
        if (contentWindow) contentWindow.location.reload();
        else frame.src = target;
      } catch {
        frame.src = target;
      }
    });
  }

  private beginNavigation(url: string, apply: () => void): void {
    this.currentUrl = url;
    this.navigationGeneration += 1;
    const generation = this.navigationGeneration;
    this.clearLoadWatchdog();
    this.clearAutoRefreshTimer();
    this.loadFailed = false;
    this.renderStatus();
    apply();
    this.armLoadWatchdog(generation);
  }

  private clearLoadWatchdog(): void {
    if (this.loadWatchdog === null) return;
    this.viewWindow().clearTimeout(this.loadWatchdog);
    this.loadWatchdog = null;
  }

  private clearAutoRefreshTimer(): void {
    if (this.autoRefreshTimer === null) return;
    this.viewWindow().clearTimeout(this.autoRefreshTimer);
    this.autoRefreshTimer = null;
  }

  /** navigation 后 10s 看门狗：只允许当前导航进入恢复流程。 */
  private armLoadWatchdog(generation: number): void {
    this.loadWatchdog = this.viewWindow().setTimeout(() => {
      this.loadWatchdog = null;
      if (this.closed || generation !== this.navigationGeneration) return;
      this.loadFailed = true;
      this.renderStatus();
      void this.verifyOrRecover(generation);
    }, FRAME_LOAD_TIMEOUT_MS);
  }

  private async handleFrameLoad(): Promise<void> {
    const feature = this.plugin.dshFeature;
    const frame = this.frameEl;
    if (!feature || !frame) return;
    const generation = this.navigationGeneration;
    const target = normalizeDshWebUrl(this.currentUrl || frame.src);
    if (!target) return;
    let confirmed: string | null;
    try {
      confirmed = await feature.confirmDshViewUrl(target);
    } catch {
      return;
    }
    if (
      this.closed ||
      generation !== this.navigationGeneration ||
      !confirmed ||
      !sameDshWebUrl(confirmed, target)
    ) {
      return;
    }
    this.currentUrl = confirmed;
    this.clearLoadWatchdog();
    this.clearAutoRefreshTimer();
    this.loadFailed = false;
    this.renderStatus();
  }

  /**
   * 静默自动恢复（重启 Obsidian 后视图恢复、dsh 尚未启动的场景）：
   * 探测已开的 dsh 端口，找不到就拉起（等待启动 ≤120s），成功即导航；
   * 失败每 15s 静默重试，直到成功或视图关闭。不弹通知。
   */
  private async verifyOrRecover(generation: number): Promise<void> {
    const feature = this.plugin.dshFeature;
    const frame = this.frameEl;
    if (
      !feature ||
      !frame ||
      this.closed ||
      generation !== this.navigationGeneration
    ) {
      return;
    }
    try {
      const url = await feature.resolveDshViewUrl();
      if (this.closed || generation !== this.navigationGeneration) return;
      if (!sameDshWebUrl(frame.src, url)) {
        this.navigate(url);
      } else {
        this.reload();
      }
    } catch {
      if (this.closed || generation !== this.navigationGeneration) return;
      this.loadFailed = true;
      this.renderStatus();
      this.autoRefreshTimer = this.viewWindow().setTimeout(() => {
        this.autoRefreshTimer = null;
        if (
          !this.frameEl ||
          !this.loadFailed ||
          this.closed ||
          generation !== this.navigationGeneration
        ) {
          return;
        }
        void this.verifyOrRecover(generation);
      }, AUTO_REFRESH_RETRY_MS);
    }
  }

  private buildUI(): void {
    const container = this.containerEl;
    container.empty();
    container.addClass("mv-aide-dsh-view");
    const state = this.leaf.getViewState().state as { url?: unknown } | undefined;
    const url = typeof state?.url === "string" ? state.url : "";
    const frame = container.createEl("iframe", {
      cls: "mv-aide-dsh-frame",
    });
    this.frameEl = frame;
    frame.addEventListener("load", () => {
      void this.handleFrameLoad();
    });
    if (url) {
      this.navigate(url);
    }

    const bar = container.createDiv({ cls: "mv-aide-dsh-statusbar" });
    bar.addEventListener("click", () => this.toggleExpanded());
    const addDivider = (): HTMLSpanElement =>
      bar.createSpan({ cls: "mv-aide-dsh-status-divider" });
    // 顺序：小球 │ 打开 │ 选中 │ 轨迹跟踪 │ 端口
    this.statusDotEl = bar.createSpan({
      cls: "mv-aide-dsh-dot is-disconnected",
    });
    addDivider();
    this.statusOpenEl = bar.createSpan({
      cls: "mv-aide-dsh-status-segment mv-aide-dsh-status-open",
    });
    this.statusLocationCheckEl = this.statusOpenEl.createSpan({
      cls: "mv-aide-dsh-channel-check",
    });
    this.statusOpenLabelEl = this.statusOpenEl.createSpan({
      cls: "mv-aide-dsh-status-label",
    });
    addDivider();
    this.statusSelectionEl = bar.createSpan({ cls: "mv-aide-dsh-status-segment" });
    this.statusSelectionCheckEl = this.statusSelectionEl.createSpan({
      cls: "mv-aide-dsh-channel-check",
    });
    this.statusSelectionLabelEl = this.statusSelectionEl.createSpan({
      cls: "mv-aide-dsh-status-label",
    });
    addDivider();
    this.statusTrackingEl = bar.createSpan({ cls: "mv-aide-dsh-status-segment" });
    addDivider();
    this.statusCopyEl = bar.createEl("button", {
      cls: "clickable-icon mv-aide-dsh-copy-address",
      attr: {
        type: "button",
        "aria-label": t("复制 DSH 地址"),
        title: t("复制 DSH 地址"),
      },
    });
    setIcon(this.statusCopyEl, "copy");
    this.statusCopyEl.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.copyDshAddress();
    });
    this.statusPortEl = bar.createSpan({ cls: "mv-aide-dsh-status-segment" });
    this.statusFailDividerEl = addDivider();
    this.statusFailEl = bar.createSpan({ cls: "mv-aide-dsh-status-segment" });
    this.statusFailEl.hide();
    this.statusFailDividerEl.hide();
    this.statusDetailEl = container.createDiv({
      cls: "mv-aide-dsh-status-detail",
    });
    this.statusDetailEl.hidden = true;
    this.detailPortEl = this.statusDetailEl.createDiv();
    this.detailUrlEl = this.statusDetailEl.createDiv();
    this.detailConnectionEl = this.statusDetailEl.createDiv();
    this.detailTrackingEl = this.statusDetailEl.createDiv();
    this.detailOpenEl = this.statusDetailEl.createDiv();
    this.detailSelectionEl = this.statusDetailEl.createDiv();
    this.detailSelectionTextEl = this.statusDetailEl.createDiv();
    this.detailFailureEl = this.statusDetailEl.createDiv();
    this.detailSelectionTextEl.hide();
    this.detailFailureEl.hide();

    const bindCheck = (
      el: HTMLSpanElement | null,
      key: "pushLocation" | "pushSelection",
    ): void => {
      el?.addEventListener("click", (event) => {
        event.stopPropagation();
        // 轨迹跟踪开时锁定，不可操作。
        if (this.plugin.settings.activityTracking.supportAllActivePages) return;
        this.plugin.settings.dsh[key] = !this.plugin.settings.dsh[key];
        void this.plugin.saveAndApplySettings();
        this.renderStatus();
      });
    };
    bindCheck(this.statusLocationCheckEl, "pushLocation");
    bindCheck(this.statusSelectionCheckEl, "pushSelection");

    this.renderStatus();
    this.registerInterval(
      this.viewWindow().setInterval(() => this.renderStatus(), 1000),
    );
  }

  private async copyDshAddress(): Promise<void> {
    const url = this.plugin.dshFeature?.currentDshUrl();
    if (!url) return;
    try {
      const clipboard = this.viewWindow().navigator.clipboard;
      if (!clipboard) throw new Error(t("剪贴板不可用"));
      await clipboard.writeText(url);
      new Notice(t("已复制 DSH 地址：{url}", { url }));
    } catch (error) {
      new Notice(
        t("复制 DSH 地址失败：{message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        8000,
      );
    }
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    if (this.statusDetailEl) this.statusDetailEl.hidden = !this.expanded;
    this.renderStatus();
  }

  private renderStatus(): void {
    const plugin = this.plugin;
    const settings = plugin.settings;
    const dshFeature = plugin.dshFeature;
    const actualPort = dshFeature?.currentDshPort() ?? null;
    const actualUrl = dshFeature?.currentDshUrl() ?? null;
    const connected = plugin.ideBridgeClientCount() > 0;
    const tracking = settings.activityTracking.supportAllActivePages;
    const snapshot = plugin.latestSelectionSnapshot();
    const parts = buildDshStatusParts(snapshot);
    const port = actualPort ?? settings.dsh.port;

    setTextIfChanged(this.statusPortEl, `${t("端口")} ${port}`);
    if (this.statusCopyEl) {
      this.statusCopyEl.disabled = actualUrl === null;
      this.statusCopyEl.setAttr(
        "aria-label",
        actualUrl ? t("复制 DSH 地址") : t("mv-agent 未运行"),
      );
      this.statusCopyEl.setAttr(
        "title",
        actualUrl ? t("复制 DSH 地址") : t("mv-agent 未运行"),
      );
    }
    if (this.statusDotEl) {
      this.statusDotEl.toggleClass("is-connected", connected);
      this.statusDotEl.toggleClass("is-disconnected", !connected);
      this.statusDotEl.setAttr("title", connected ? t("已连接") : t("未连接"));
    }
    if (this.statusTrackingEl) {
      setTextIfChanged(
        this.statusTrackingEl,
        `${t("轨迹跟踪")} ${tracking ? t("开") : t("关")}`,
      );
    }
    const applyCheck = (
      el: HTMLSpanElement | null,
      checked: boolean,
      locked: boolean,
    ): void => {
      if (!el) return;
      setTextIfChanged(el, checked ? "✓" : "");
      el.toggleClass("is-checked", checked);
      el.toggleClass("is-locked", locked);
    };
    applyCheck(
      this.statusLocationCheckEl,
      tracking || settings.dsh.pushLocation,
      tracking,
    );
    applyCheck(
      this.statusSelectionCheckEl,
      tracking || settings.dsh.pushSelection,
      tracking,
    );
    setTextIfChanged(this.statusOpenLabelEl, parts.open);
    setTextIfChanged(this.statusSelectionLabelEl, parts.selection);
    if (this.statusFailEl) {
      if (this.loadFailed) {
        setTextIfChanged(this.statusFailEl, t("加载失败"));
        this.statusFailEl.show();
        this.statusFailDividerEl?.show();
      } else {
        this.statusFailEl.hide();
        this.statusFailDividerEl?.hide();
      }
    }

    setTextIfChanged(
      this.detailPortEl,
      `${t("端口")} ${settings.dsh.port}${
        actualPort !== null && actualPort !== settings.dsh.port
          ? `（${t("实际 {port}", { port: actualPort })}）`
          : actualPort === null
            ? `（${t("未运行")}）`
            : ""
      }`,
    );
    setTextIfChanged(
      this.detailUrlEl,
      `${t("DSH 地址")}：${actualUrl ?? t("未运行")}`,
    );
    setTextIfChanged(
      this.detailConnectionEl,
      `mv-aide ${connected ? t("已连接") : t("未连接")}`,
    );
    setTextIfChanged(
      this.detailTrackingEl,
      `${t("轨迹跟踪")} ${tracking ? t("开") : t("关")}`,
    );
    setTextIfChanged(this.detailOpenEl, parts.openFull);
    setTextIfChanged(this.detailSelectionEl, parts.selection);

    if (this.detailSelectionTextEl) {
      if (
        snapshot &&
        !snapshot.selection.isEmpty &&
        snapshot.selection.text.length > 0
      ) {
        const snippet = snapshot.selection.text.replace(/[\r\n]+/g, " ");
        setTextIfChanged(
          this.detailSelectionTextEl,
          `${t("选中文本")} ${snippet.length > 200 ? `${snippet.slice(0, 200)}…` : snippet}`,
        );
        this.detailSelectionTextEl.show();
      } else {
        this.detailSelectionTextEl.hide();
      }
    }
    if (this.detailFailureEl) {
      if (this.loadFailed) {
        setTextIfChanged(
          this.detailFailureEl,
          t("加载失败（右键标签 → 刷新界面）"),
        );
        this.detailFailureEl.show();
      } else {
        this.detailFailureEl.hide();
      }
    }
  }
}
