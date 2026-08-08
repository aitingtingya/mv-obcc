import type { ItemView, View } from "obsidian";
import type MvSenceAiIdePlugin from "../main";
import { t } from "./i18n";

// 浏览器视图的 viewType 与历史命令 id 随 Obsidian 版本不同：
// 旧版（1.6.7 安装包 asar 实证）viewType 为 "browser"、命令为 browser:open-history；
// 新版（1.13.4 运行时实测）viewType 为 "webviewer"、命令为 webviewer:open-history。
const BROWSER_VIEW_TYPES = new Set(["browser", "webviewer"]);
const OPEN_HISTORY_COMMANDS = ["webviewer:open-history", "browser:open-history"];

/**
 * 给 web viewer（浏览器）视图的工具栏注入「浏览历史」按钮，点击执行官方
 * open-history 命令（打开左侧 Browser History 视图；新旧版本 id 见
 * OPEN_HISTORY_COMMANDS）。不重复造历史功能，只加入口。
 *
 * 位置依据（obsidian.asar 实证）：ItemView.addAction 是 actionsEl.prepend，
 * 新按钮落在 action 区最左；⋮（more-options）是视图基类构造时第一个
 * addAction 的按钮，因 prepend 语义恒为容器最后一个元素。addAction 后再把
 * 按钮 insertBefore 到容器末尾元素前，即确定性落在「眼镜右、⋮ 左」。
 */
export class BrowserHistoryButtonFeature {
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
    const commands = (
      this.plugin.app as unknown as {
        commands?: {
          commands?: Record<string, unknown>;
          executeCommandById?: (id: string) => void;
        };
      }
    ).commands;
    // web viewer 核心插件未开启时没有任何候选命令，直接跳过
    const openHistoryCommand = OPEN_HISTORY_COMMANDS.find(
      (id) => commands?.commands?.[id],
    );
    const executeCommandById = commands?.executeCommandById?.bind(commands);
    if (!openHistoryCommand || !executeCommandById) return;

    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as ItemView;
      if (!BROWSER_VIEW_TYPES.has(view.getViewType())) return;
      if (this.installedViews.has(view)) return;
      if (typeof view.addAction !== "function") return;
      this.installedViews.add(view);
      const el = view.addAction("history", t("浏览历史"), () => {
        executeCommandById(openHistoryCommand);
      });
      // 锚点 class：下载按钮（browser-downloads-button.ts）靠它定位到历史左侧
      el.addClass("mv-aide-history-action");
      const parent = el.parentElement;
      if (parent && parent.lastElementChild && parent.lastElementChild !== el) {
        parent.insertBefore(el, parent.lastElementChild);
      }
      this.buttons.push(el);
    });
  }

  private removeAll(): void {
    for (const el of this.buttons) el.remove();
    this.buttons = [];
  }
}
