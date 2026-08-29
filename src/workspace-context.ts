import path from "node:path";
import { t } from "./i18n";
import {
  FileView,
  MarkdownView,
  type App,
  type View,
  type WorkspaceLeaf,
} from "obsidian";
import { fileUrl } from "./path-utils";
import {
  editorSelectionState,
  getVaultRoot,
  type LogicalSelectionResolver,
} from "./selection";
import type { OpenEditorTab, SelectionState } from "./types";

/** 浏览器视图的 viewType 随 Obsidian 版本不同：新版（1.13.4 实测）为
 * "webviewer"，旧版（1.6.7 asar 实证）为 "browser"，两者都接受。 */
const BROWSER_VIEW_TYPES = new Set(["browser", "webviewer"]);

/** 读取 webview 页面选区的超时：页面加载中 executeJavaScript 可能挂起。 */
const WEB_SELECTION_TIMEOUT_MS = 1200;

/** 竞速超时：超时即 reject，原 promise 的结果被丢弃（不取消底层调用）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("web selection timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function isBrowserViewType(viewType: string): boolean {
  return BROWSER_VIEW_TYPES.has(viewType);
}

interface WebViewElement extends HTMLElement {
  executeJavaScript(script: string): Promise<unknown>;
  getURL?: () => string;
  getTitle?: () => string;
}

interface WebViewerView extends View {
  webview?: WebViewElement;
  url?: string;
  title?: string;
  mode?: string;
}

interface FileLikeView extends View {
  file?: { path: string; name: string; basename?: string; extension?: string } | null;
}

interface DimensionedWorkspaceItem {
  children?: DimensionedWorkspaceItem[];
  direction?: string;
  parent?: DimensionedWorkspaceItem | null;
  recomputeChildrenDimensions?: () => void;
  setDimension?: (dimension: number | null) => void;
}

interface SaveableWorkspace {
  requestSaveLayout?: () => unknown;
}

interface MainBottomWorkspace extends SaveableWorkspace {
  rootSplit: unknown;
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => void): void;
  getMostRecentLeaf(root: unknown): WorkspaceLeaf | null;
  getLeaf(kind: "tab"): WorkspaceLeaf;
  createLeafBySplit(
    leaf: WorkspaceLeaf,
    direction: "horizontal",
    before: boolean,
  ): WorkspaceLeaf;
}

function point(character = 0): { line: number; character: number } {
  return { line: 0, character };
}

function selectionState(
  base: Omit<SelectionState, "cursor" | "selection">,
  text: string,
): SelectionState {
  return {
    ...base,
    cursor: point(text.length),
    selection: {
      start: point(0),
      end: point(text.length),
      isEmpty: text.length === 0,
      text,
    },
  };
}

function viewSelection(view: View): string {
  const selection = view.containerEl.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (
    !view.containerEl.contains(range.startContainer) &&
    !view.containerEl.contains(range.endContainer)
  ) {
    return "";
  }
  return selection.toString();
}

export function activeWorkspaceLeaf(app: App): WorkspaceLeaf | null {
  // activeLeaf 已废弃（官方规范禁止直接使用），getMostRecentLeaf 为官方替代。
  return app.workspace.getMostRecentLeaf();
}

export function createMainBottomLeaf(
  workspace: MainBottomWorkspace,
  excludedLeaf?: WorkspaceLeaf,
): WorkspaceLeaf {
  const rootLeaves: WorkspaceLeaf[] = [];
  workspace.iterateAllLeaves((candidate) => {
    if (candidate !== excludedLeaf && candidate.getRoot() === workspace.rootSplit) {
      rootLeaves.push(candidate);
    }
  });

  const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
  const anchor = recent && recent !== excludedLeaf
    ? recent
    : rootLeaves[0] ?? workspace.getLeaf("tab");
  return workspace.createLeafBySplit(anchor, "horizontal", false);
}

export function applyBottomTerminalSplitRatio(
  leaf: WorkspaceLeaf,
  workspace: SaveableWorkspace,
  terminalDimension = 25,
): boolean {
  try {
    const terminalTabs = (leaf as unknown as DimensionedWorkspaceItem).parent;
    const parentSplit = terminalTabs?.parent;
    const children = parentSplit?.children;
    if (
      !terminalTabs ||
      !parentSplit ||
      parentSplit.direction !== "horizontal" ||
      !Array.isArray(children) ||
      !children.includes(terminalTabs) ||
      children.length < 2 ||
      typeof parentSplit.recomputeChildrenDimensions !== "function" ||
      children.some((child) => typeof child.setDimension !== "function")
    ) {
      return false;
    }

    const siblingDimension = (100 - terminalDimension) / (children.length - 1);
    for (const child of children) {
      child.setDimension?.(child === terminalTabs ? terminalDimension : siblingDimension);
    }
    parentSplit.recomputeChildrenDimensions();
    if (typeof workspace.requestSaveLayout === "function") {
      void workspace.requestSaveLayout();
    }
    return true;
  } catch {
    return false;
  }
}

function webViewState(view: WebViewerView): {
  url: string;
  title: string;
} {
  const state = view.getState() as { url?: unknown; title?: unknown };
  const url =
    (typeof view.url === "string" && view.url) ||
    (typeof state.url === "string" && state.url) ||
    view.webview?.getURL?.() ||
    "";
  const title =
    (typeof view.title === "string" && view.title) ||
    (typeof state.title === "string" && state.title) ||
    view.webview?.getTitle?.() ||
    view.getDisplayText();
  return { url, title };
}

export async function currentWorkspaceContext(
  app: App,
  requestedLeaf?: WorkspaceLeaf | null,
  resolveLogicalSelection?: LogicalSelectionResolver,
  webSelectionText?: string | null,
  pendingWebUrl?: string | null,
): Promise<SelectionState | null> {
  const leaf = requestedLeaf === undefined ? activeWorkspaceLeaf(app) : requestedLeaf;
  if (!leaf) return null;
  const view = leaf.view;
  const viewType = view.getViewType();

  if (view instanceof MarkdownView && view.file) {
    const editor = view.editor;
    const vaultRoot = getVaultRoot(app);
    // 阅读视图（preview）没有 CM 编辑器承载 DOM 选区：view.editor 只镜像
    // 上一次源码/实时预览编辑态，划词结果恒为空。此时按 DOM 选区读取。
    // 源码模式与实时预览模式（getMode() === "source"）保持原 editor 路径。
    const leafMode = (leaf.getViewState() as { state?: { mode?: unknown } })
      .state?.mode;
    const mode = view.getMode?.() ?? (typeof leafMode === "string" ? leafMode : null);
    const domSelection = mode === "preview" ? viewSelection(view) : "";
    if (domSelection.trim()) {
      return selectionState(
        {
          filePath: path.join(vaultRoot, view.file.path),
          relativePath: view.file.path,
          title: view.getDisplayText(),
          viewType,
          resourceType: "markdown",
        },
        domSelection,
      );
    }
    const selection = editorSelectionState(
      editor,
      resolveLogicalSelection?.(view) ?? null,
    );
    return {
      filePath: path.join(vaultRoot, view.file.path),
      relativePath: view.file.path,
      title: view.getDisplayText(),
      viewType,
      resourceType: "markdown",
      ...selection,
    };
  }

  if (isBrowserViewType(viewType)) {
    const webView = view as WebViewerView;
    // 导航中的目标 URL（did-start-navigation 缓存）优先：view.url 要等
    // dom-ready 才更新，加载期间用缓存保证「打开：」立即指向新页面。
    const { url: viewUrl, title } = webViewState(webView);
    const url = typeof pendingWebUrl === "string" && pendingWebUrl
      ? pendingWebUrl
      : viewUrl;
    let text = "";
    if (typeof webSelectionText === "string") {
      // 页内推送通道（console-message）已提供实时选区：加载期间也有效，
      // 直接使用，不再依赖 executeJavaScript。
      text = webSelectionText;
    } else {
      try {
        // 页面加载/导航期间 executeJavaScript 可能长时间挂起（而不是快速
        // reject），会拖住整个选区广播流水线，导致位置与选区等到页面加载
        // 完毕才更新。给它一个超时竞速：超时按"空选区"处理，底层调用不
        // 取消（迟到结果直接丢弃），500ms 轮询会继续带来更新。
        const selected = await withTimeout(
          webView.webview?.executeJavaScript(
            "window.getSelection ? window.getSelection().toString() : ''",
          ) ?? Promise.resolve(""),
          WEB_SELECTION_TIMEOUT_MS,
        );
        if (typeof selected === "string") text = selected;
      } catch {
        // Some pages temporarily reject script execution during navigation.
      }
    }
    return selectionState(
      {
        filePath: url || `obsidian-web://${encodeURIComponent(title)}`,
        relativePath: title,
        title,
        viewType,
        resourceType: "web",
        url,
      },
      text,
    );
  }

  if (viewType === "pdf" && view instanceof FileView && view.file) {
    const vaultRoot = getVaultRoot(app);
    const state = view.getState() as { page?: unknown };
    const pageElement = view.containerEl.ownerDocument
      .getSelection()
      ?.anchorNode?.parentElement?.closest<HTMLElement>(".page[data-page-number]");
    const domPage = Number(pageElement?.dataset.pageNumber);
    const statePage = typeof state.page === "number" ? state.page : undefined;
    return selectionState(
      {
        filePath: path.join(vaultRoot, view.file.path),
        relativePath: view.file.path,
        title: view.getDisplayText(),
        viewType,
        resourceType: "pdf",
        page: Number.isFinite(domPage) ? domPage : statePage,
      },
      viewSelection(view),
    );
  }

  if (view instanceof FileView && view.file) {
    const vaultRoot = getVaultRoot(app);
    return selectionState(
      {
        filePath: path.join(vaultRoot, view.file.path),
        relativePath: view.file.path,
        title: view.getDisplayText(),
        viewType,
        resourceType: "file",
      },
      viewSelection(view),
    );
  }

  const title = view.getDisplayText();
  return selectionState(
    {
      filePath: `obsidian-view://${encodeURIComponent(viewType)}/${encodeURIComponent(title)}`,
      relativePath: title,
      title,
      viewType,
      resourceType: "view",
    },
    viewSelection(view),
  );
}

export function getOpenWorkspaceTabs(app: App): { tabs: OpenEditorTab[] } {
  const vaultRoot = getVaultRoot(app);
  const active = activeWorkspaceLeaf(app);
  const tabs: OpenEditorTab[] = [];
  let index = 0;
  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view;
    const leafState = leaf.getViewState() as unknown as {
      type?: string;
      state?: { file?: unknown; url?: unknown; title?: unknown };
    };
    const viewType = leafState.type || view.getViewType();
    const label = leaf.getDisplayText() || view.getDisplayText() || viewType;
    const base = {
      isActive: leaf === active,
      label,
      viewType,
    };

    if (isBrowserViewType(viewType)) {
      const loaded = webViewState(view as WebViewerView);
      const url =
        loaded.url ||
        (typeof leafState.state?.url === "string" ? leafState.state.url : "");
      tabs.push({
        ...base,
        uri: url || `obsidian://view/${viewType}/${index}`,
        resourceType: "web",
        url,
      });
    } else {
      const file = (view as FileLikeView).file;
      const relativePath =
        file?.path ||
        (typeof leafState.state?.file === "string" ? leafState.state.file : "");
      if (relativePath) {
        const absolutePath = path.join(vaultRoot, relativePath);
        const extension =
          file?.extension?.toLowerCase() ??
          path.extname(relativePath).slice(1).toLowerCase();
        tabs.push({
          ...base,
          uri: fileUrl(absolutePath),
          resourceType:
            viewType === "markdown"
              ? "markdown"
              : viewType === "pdf"
                ? "pdf"
                : "file",
          filePath: absolutePath,
          relativePath,
          ...(extension ? { languageId: extension === "md" ? "markdown" : extension } : {}),
        });
      } else {
        tabs.push({
          ...base,
          uri: `obsidian://view/${encodeURIComponent(viewType)}/${index}`,
          resourceType: "view",
        });
      }
    }
    index += 1;
  });
  return { tabs };
}

function workspaceContainsLeaf(app: App, target: WorkspaceLeaf): boolean {
  let found = false;
  app.workspace.iterateAllLeaves((leaf) => {
    if (leaf === target) found = true;
  });
  return found;
}

export async function readCurrentWebPage(
  app: App,
  latestWebLeaf: WorkspaceLeaf | null,
  configuredMaxCharacters: number | null,
): Promise<Record<string, unknown>> {
  const activeLeaf = activeWorkspaceLeaf(app);
  const activeWebLeaf =
    activeLeaf &&
    isBrowserViewType(activeLeaf.view.getViewType()) &&
    workspaceContainsLeaf(app, activeLeaf)
      ? activeLeaf
      : null;
  const leaf =
    activeWebLeaf ??
    (latestWebLeaf &&
    isBrowserViewType(latestWebLeaf.view.getViewType()) &&
    workspaceContainsLeaf(app, latestWebLeaf)
      ? latestWebLeaf
      : null);

  if (!leaf) {
    return {
      success: false,
      message: latestWebLeaf
        ? t("最近追踪的 Obsidian Web Viewer 页面已经关闭，无法读取。")
        : t("尚未追踪到可读取的 Obsidian Web Viewer 页面。"),
    };
  }
  const view = leaf.view as WebViewerView;
  const fallback = webViewState(view);
  const maxCharacters =
    typeof configuredMaxCharacters === "number" &&
    Number.isFinite(configuredMaxCharacters) &&
    configuredMaxCharacters > 0
      ? Math.floor(configuredMaxCharacters)
      : null;

  try {
    const extracted = await view.webview?.executeJavaScript(`(() => ({
      title: document.title || "",
      url: location.href,
      text: document.body ? document.body.innerText : "",
      scrollHeight: Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      ),
      viewportHeight: window.innerHeight || (
        document.documentElement ? document.documentElement.clientHeight : 0
      )
    }))()`);
    const value =
      extracted && typeof extracted === "object"
        ? (extracted as {
            title?: unknown;
            url?: unknown;
            text?: unknown;
            scrollHeight?: unknown;
            viewportHeight?: unknown;
          })
        : {};
    const text = typeof value.text === "string" ? value.text.trim() : "";
    const title =
      typeof value.title === "string" && value.title
        ? value.title
        : fallback.title;
    const url =
      typeof value.url === "string" && value.url ? value.url : fallback.url;
    if (!text) {
      return {
        success: false,
        title,
        url,
        message:
          t("当前页面没有可提取文本，可能使用了 Canvas、图片、跨域 iframe 或封闭 Shadow DOM。"),
      };
    }
    const markdown = text.replace(/\n{3,}/g, "\n\n");
    const truncated =
      maxCharacters !== null && markdown.length > maxCharacters;
    return {
      success: true,
      title,
      url,
      markdown:
        maxCharacters === null ? markdown : markdown.slice(0, maxCharacters),
      extraction: "visible-dom",
      truncated,
      originalCharacters: markdown.length,
      maxCharacters,
      scrollHeight:
        typeof value.scrollHeight === "number" ? value.scrollHeight : null,
      viewportHeight:
        typeof value.viewportHeight === "number" ? value.viewportHeight : null,
    };
  } catch (error) {
    return {
      success: false,
      title: fallback.title,
      url: fallback.url,
      message:
        error instanceof Error
          ? t("无法读取当前网页：{v0}", { v0: error.message })
          : t("无法读取当前网页。"),
    };
  }
}
