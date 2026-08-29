import { Notice, type Workspace, type WorkspaceLeaf, getIcon } from "obsidian";
import { t } from "../i18n";
import type MvAideIdePlugin from "../../main";
import type { CustomWebPage } from "../types";

/**
 * 自定义网页按钮（未来规划#2）。
 *
 * 独立模块：仅在 main.ts onload/onunload 与设置保存时被插件主线调用，
 * 不触碰协议、桥接或其它既有功能。每条配置生成：
 *  - 一个 Ctrl+P 命令「打开 {名称}」（id: open-web-page-<entryId>）；
 *  - 可选的左侧 ribbon 图标按钮；
 *  - 可配置打开位置（左边栏 / 中间 / 右边栏），每次都新建标签页。
 *
 * 打开方式复用 Obsidian 内置 webviewer 视图（与 local-web-preview 相同），
 * 因此自动继承插件既有浏览器增强（划词助手、浏览历史、下载等）。
 */

export interface CustomWebPagesHandle {
  /** 按 settings.customWebPages 幂等重建命令与 ribbon 图标。 */
  sync(): void;
  unload(): void;
  openPage(page: CustomWebPage): Promise<void>;
}

const COMMAND_ID_PREFIX = "open-web-page-";
const DEFAULT_ICON = "globe";
const FALLBACK_VIEW_TYPE = "browser";

export function customWebPageCommandId(page: CustomWebPage): string {
  return `${COMMAND_ID_PREFIX}${page.id}`;
}

/** 只允许 http(s) 页面；保存与加载两侧共用的 URL 校验。 */
export function isValidCustomWebPageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** 规范化持久化数据：丢弃坏条目，为缺失字段补默认值。 */
export function normalizeCustomWebPages(value: unknown): CustomWebPage[] {
  if (!Array.isArray(value)) return [];
  const pages: CustomWebPage[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const url = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!name || !isValidCustomWebPageUrl(url)) continue;
    let id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : name;
    if (seenIds.has(id)) id = `${id}-${seenIds.size}`;
    seenIds.add(id);
    const position =
      raw.position === "left" || raw.position === "right"
        ? raw.position
        : "center";
    pages.push({
      id,
      name,
      url,
      icon:
        typeof raw.icon === "string" && raw.icon.trim()
          ? raw.icon.trim()
          : DEFAULT_ICON,
      ribbon: raw.ribbon === true,
      position,
    });
  }
  return pages;
}

/** Lucide 图标容错：精确命中优先，其次补 lucide- 前缀，最后回退 globe。 */
function resolveRibbonIcon(icon: string): string {
  const tryIcon = (name: string): string | null => {
    if (!name) return null;
    try {
      return getIcon(name) ? name : null;
    } catch {
      return null;
    }
  };
  return (
    tryIcon(icon) ?? tryIcon(`lucide-${icon}`) ?? DEFAULT_ICON
  );
}

/**
 * 打开位置对应的叶子（导出以便测试）。
 *
 * 全部走「新开标签页」语义，绝不因打开网页而分屏或新建侧栏标签栏：
 * - center：先把最近活动引导回主区叶子（侧边栏焦点下直接 getLeaf("tab")
 *   会在 root 分出新区域），再在主区标签组新开一个 tab；
 * - left/right：getXxxLeaf(false) 在侧栏现有标签组里新增 tab，
 *   侧栏为空时回退 true 创建首个标签组。
 */
export function openLeafForPosition(
  workspace: Workspace,
  position: CustomWebPage["position"],
): WorkspaceLeaf | null {
  switch (position) {
    case "center": {
      const mainRecent = workspace.getMostRecentLeaf(workspace.rootSplit);
      if (mainRecent) {
        workspace.setActiveLeaf(mainRecent, { focus: false });
      }
      return workspace.getLeaf("tab");
    }
    case "left":
      return workspace.getLeftLeaf(false) ?? workspace.getLeftLeaf(true);
    case "right":
      return workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true);
    default:
      return workspace.getLeaf("tab");
  }
}

class CustomWebPagesFeature implements CustomWebPagesHandle {
  private commandIds = new Set<string>();
  private ribbonEls = new Map<string, HTMLElement>();
  private unloaded = false;

  constructor(private readonly plugin: MvAideIdePlugin) {}

  sync(): void {
    if (this.unloaded) return;
    this.syncCommands();
    this.syncRibbonIcons();
  }

  unload(): void {
    if (this.unloaded) return;
    this.unloaded = true;
    // Commands are auto-removed by Obsidian; ribbon icons are not.
    for (const el of this.ribbonEls.values()) el.remove();
    this.ribbonEls.clear();
    this.commandIds.clear();
  }

  private syncCommands(): void {
    for (const id of this.commandIds) {
      this.plugin.removeCommand(id);
    }
    this.commandIds.clear();
    for (const page of this.pages()) {
      const commandId = customWebPageCommandId(page);
      this.plugin.addCommand({
        id: commandId,
        name: t("打开网页：{name}", { name: page.name }),
        callback: () => void this.openPage(page),
      });
      this.commandIds.add(commandId);
    }
  }

  private syncRibbonIcons(): void {
    const wanted = new Map<string, CustomWebPage>();
    for (const page of this.pages()) {
      if (page.ribbon) wanted.set(page.id, page);
    }
    for (const [id, el] of Array.from(this.ribbonEls.entries())) {
      const page = wanted.get(id);
      if (!page) {
        el.remove();
        this.ribbonEls.delete(id);
        continue;
      }
      const title = t("打开网页：{name}", { name: page.name });
      el.setAttribute("aria-label", title);
      el.setAttribute("data-tooltip", title);
      el.setAttribute("title", title);
      wanted.delete(id);
    }
    for (const page of wanted.values()) {
      const el = this.plugin.addRibbonIcon(
        resolveRibbonIcon(page.icon),
        t("打开网页：{name}", { name: page.name }),
        () => void this.openPage(page),
      );
      this.ribbonEls.set(page.id, el);
    }
  }

  private pages(): CustomWebPage[] {
    return (
      (this.plugin.settings as {
        customWebPages?: CustomWebPage[];
      }).customWebPages ?? []
    ).filter(
      (page) =>
        page &&
        typeof page.name === "string" &&
        isValidCustomWebPageUrl(page.url),
    );
  }

  async openPage(page: CustomWebPage): Promise<void> {
    const workspace = this.plugin.app.workspace;
    const leaf = openLeafForPosition(workspace, page.position);
    if (!leaf) {
      new Notice(
        t("无法在{position}区域打开网页。", {
          position:
            page.position === "left"
              ? t("左边栏")
              : page.position === "right"
                ? t("右边栏")
                : t("中间区域"),
        }),
        6000,
      );
      return;
    }
    let opened = false;
    try {
      await leaf.setViewState({
        type: "webviewer",
        active: true,
        state: {
          url: page.url,
          title: page.name,
          navigate: true,
        },
      });
      opened = true;
    } catch (error) {
      console.error("[mv-aide] Failed to open custom web page", error);
      // 极旧 Obsidian 的内置浏览器被称为 "browser"。
      try {
        await leaf.setViewState({
          type: FALLBACK_VIEW_TYPE,
          active: true,
          state: {
            url: page.url,
            title: page.name,
            navigate: true,
          },
        });
        opened = true;
      } catch (fallbackError) {
        console.error(
          "[mv-aide] Failed to open custom web page (browser fallback)",
          fallbackError,
        );
        new Notice(t("打开网页失败：{name}", { name: page.name }), 6000);
      }
    }
    if (!opened) return;
    try {
      await workspace.revealLeaf(leaf);
    } catch (revealError) {
      console.error("[mv-aide] Failed to reveal custom web page", revealError);
      new Notice(t("打开网页失败：{name}", { name: page.name }), 6000);
    }
  }
}

export function createCustomWebPages(
  plugin: MvAideIdePlugin,
): CustomWebPagesHandle {
  return new CustomWebPagesFeature(plugin);
}
