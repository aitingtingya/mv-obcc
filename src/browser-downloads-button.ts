import type { ItemView, View } from "obsidian";
import type MvSenceAiIdePlugin from "../main";
import { t } from "./i18n";
import { BrowserDownloadsModal } from "./browser-downloads-modal";

// 与 browser-history-button.ts 同一套 viewType 判定。
const BROWSER_VIEW_TYPES = new Set(["browser", "webviewer"]);
// 历史按钮的锚点 class（browser-history-button.ts 创建时打上）。
const HISTORY_ACTION_SELECTOR = ".mv-aide-history-action";

/**
 * 给 web viewer（浏览器）视图的工具栏注入「下载」按钮，点击打开
 * BrowserDownloadsModal（点击文件按默认应用打开 + 单独打开目录按钮）。
 * 位置：insertBefore 历史按钮（锚点 class 存在时）或容器末尾元素（⋮），
 * 落在历史按钮左侧，最终顺序为「下载 → 历史 → ⋮」。
 */
export class BrowserDownloadsButtonFeature {
  private readonly installedViews = new WeakSet<View>();
  private buttons: HTMLElement[] = [];

  constructor(private readonly plugin: MvSenceAiIdePlugin) {}

  register(): void {
    this.plugin.app.workspace.onLayoutReady(() => this.install());
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("layout-change", () => this.install()),
    );
    this.plugin.register(() => this.removeAll());
  }

  install(): void {
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ItemView;
      if (!BROWSER_VIEW_TYPES.has(view.getViewType())) return;
      if (this.installedViews.has(view)) return;
      if (typeof view.addAction !== "function") return;
      this.installedViews.add(view);
      const el = view.addAction("download", t("下载"), () => {
        new BrowserDownloadsModal(this.plugin.app).open();
      });
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
