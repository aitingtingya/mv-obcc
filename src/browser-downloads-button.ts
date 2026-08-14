import type { ItemView, View } from "obsidian";
import type MvAideIdePlugin from "../main";
import { t } from "./i18n";
import { BrowserDownloadsModal } from "./browser-downloads-modal";

// 与 browser-history-button.ts 同一套 viewType 判定。
const BROWSER_VIEW_TYPES = new Set(["browser", "webviewer"]);
// 历史按钮的锚点 class（browser-history-button.ts 创建时打上）。
const HISTORY_ACTION_SELECTOR = ".mv-aide-history-action";
// 本按钮的锚点 class：DOM 级幂等判重用。
const DOWNLOADS_ACTION_SELECTOR = ".mv-aide-downloads-action";

/**
 * 给 web viewer（浏览器）视图的工具栏注入「下载」按钮，点击打开
 * BrowserDownloadsModal（点击文件按默认应用打开 + 单独打开目录按钮）。
 * 位置：insertBefore 历史按钮（锚点 class 存在时）或容器末尾元素（⋮），
 * 落在历史按钮左侧，最终顺序为「下载 → 历史 → ⋮」。
 */
export class BrowserDownloadsButtonFeature {
  private installedViews = new WeakSet<View>();
  private buttons: HTMLElement[] = [];
  private enabled = true;

  constructor(private readonly plugin: MvAideIdePlugin) {}

  register(): void {
    this.plugin.app.workspace.onLayoutReady(() => this.install());
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.install()),
    );
    this.plugin.register(() => this.removeAll());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.install();
    } else {
      this.removeAll();
      // WeakSet 重建只放在禁用分支，原因见 browser-history-button.ts：
      // 启用分支重建会让运行时启用插件时 onLayoutReady 的同步 install
      // 与 setEnabled(true) 的 install 重复注入。
      this.installedViews = new WeakSet();
    }
  }

  install(): void {
    if (!this.enabled) return;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ItemView;
      if (!BROWSER_VIEW_TYPES.has(view.getViewType())) return;
      if (this.installedViews.has(view)) return;
      if (typeof view.addAction !== "function") return;
      // DOM 级幂等：即使 WeakSet 失效（多实例/重建时序）也不重复注入
      const existing = view.containerEl.querySelector(DOWNLOADS_ACTION_SELECTOR);
      if (existing instanceof HTMLElement) {
        this.installedViews.add(view);
        if (!this.buttons.includes(existing)) this.buttons.push(existing);
        return;
      }
      this.installedViews.add(view);
      const el = view.addAction("download", t("下载"), () => {
        new BrowserDownloadsModal(this.plugin.app, {
          openFile: (absolutePath) =>
            this.plugin.openExternalListingFile(absolutePath),
          canOpenFile: (name) => this.plugin.canOpenWithObsidian(name),
          getShowAll: () => this.plugin.getExternalListingShowAllFiles(),
          setShowAll: (value) =>
            this.plugin.setExternalListingShowAllFiles(value),
        }).open();
      });
      el.addClass("mv-aide-downloads-action");
      const parent = el.parentElement;
      if (parent) {
        const anchor =
          parent.querySelector(HISTORY_ACTION_SELECTOR) ??
          parent.lastElementChild;
        if (anchor && anchor !== el) parent.insertBefore(el, anchor);
      }
      this.buttons.push(el);
    });
  }

  private removeAll(): void {
    for (const el of this.buttons) el.remove();
    this.buttons = [];
  }
}
