import path from "node:path";
import {
  FileView,
  MarkdownView,
  type App,
  type View,
  type WorkspaceLeaf,
} from "obsidian";
import { fileUrl } from "./path-utils";
import { getVaultRoot } from "./selection";
import type { OpenEditorTab, SelectionState } from "./types";

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
  return app.workspace.activeLeaf ?? app.workspace.getMostRecentLeaf();
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
): Promise<SelectionState | null> {
  const leaf = requestedLeaf === undefined ? activeWorkspaceLeaf(app) : requestedLeaf;
  if (!leaf) return null;
  const view = leaf.view;
  const viewType = view.getViewType();

  if (view instanceof MarkdownView && view.file) {
    const editor = view.editor;
    const vaultRoot = getVaultRoot(app);
    const cursor = editor.getCursor();
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const text = editor.getSelection();
    return {
      filePath: path.join(vaultRoot, view.file.path),
      relativePath: view.file.path,
      title: view.getDisplayText(),
      viewType,
      resourceType: "markdown",
      cursor: { line: cursor.line, character: cursor.ch },
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty: text.length === 0,
        text,
      },
    };
  }

  if (viewType === "webviewer") {
    const webView = view as WebViewerView;
    const { url, title } = webViewState(webView);
    let text = "";
    try {
      const selected = await webView.webview?.executeJavaScript(
        "window.getSelection ? window.getSelection().toString() : ''",
      );
      if (typeof selected === "string") text = selected;
    } catch {
      // Some pages temporarily reject script execution during navigation.
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

    if (viewType === "webviewer") {
      const loaded = webViewState(view as WebViewerView);
      const url =
        loaded.url ||
        (typeof leafState.state?.url === "string" ? leafState.state.url : "");
      tabs.push({
        ...base,
        uri: url || `obsidian://view/webviewer/${index}`,
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
    activeLeaf?.view.getViewType() === "webviewer" &&
    workspaceContainsLeaf(app, activeLeaf)
      ? activeLeaf
      : null;
  const leaf =
    activeWebLeaf ??
    (latestWebLeaf &&
    latestWebLeaf.view.getViewType() === "webviewer" &&
    workspaceContainsLeaf(app, latestWebLeaf)
      ? latestWebLeaf
      : null);

  if (!leaf) {
    return {
      success: false,
      message: latestWebLeaf
        ? "最近追踪的 Obsidian Web Viewer 页面已经关闭，无法读取。"
        : "尚未追踪到可读取的 Obsidian Web Viewer 页面。",
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
          "当前页面没有可提取文本，可能使用了 Canvas、图片、跨域 iframe 或封闭 Shadow DOM。",
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
          ? `无法读取当前网页：${error.message}`
          : "无法读取当前网页。",
    };
  }
}
