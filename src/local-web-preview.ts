// 本地网页预览功能：把 file:// / 本机绝对路径 / 文件列表中的 HTML 文件，
// 经 LocalPreviewServer 的本地 http 服务打开到 Obsidian 内置 web viewer。
//
// 侵入性约束：本模块只在 main.ts 中薄接线。设置关闭时 main.ts 不创建本类；
// setEnabled(false) 会撤销全部事件、还原全部地址栏包装、停止服务器并清空
// 会话表，之后没有任何监听器、端口或内存残留。

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventRef, Menu } from "obsidian";
import type MvAideIdePlugin from "../main";
import { t } from "./i18n";
import {
  LocalPreviewServer,
  LOCAL_PREVIEW_PORT_BASE,
  LOCAL_PREVIEW_PORT_SPAN,
  LOCAL_PREVIEW_SERVER_HOST,
  type LocalPreviewRoot,
} from "./local-web-preview-server";
import { fileUrl, stablePortSeed } from "./path-utils";

/** 文件列表右键「用网页浏览器打开」支持的后缀。 */
const WEB_PREVIEW_EXTENSIONS = new Set(["html", "htm", "xhtml"]);

interface AddressBarSuggestLike {
  getSuggestions?: (input: string) => unknown;
}

interface WebviewerViewLike {
  getViewType?: () => string;
  addressBar?: {
    suggest?: AddressBarSuggestLike;
  };
}

export interface LocalFilePreviewSuggestion {
  title: string;
  url: string;
  type: string;
  score: number;
  matches: null;
}

/**
 * 把地址栏输入解析成「已存在的本地文件绝对路径」。
 * 支持 file:// URL、Windows 盘符路径、POSIX 绝对路径与 ~ 展开；
 * 不命中（包括文件不存在）返回 null，调用方保持原有搜索行为。
 */
export function parseLocalFileInput(raw: string): string | null {
  let input = raw.trim();
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    input = input.slice(1, -1).trim();
  }
  if (!input) return null;

  if (/^file:/i.test(input)) {
    try {
      return existingFilePath(fileURLToPath(input));
    } catch {
      return null;
    }
  }

  if (/^~(?:\/|\\)/.test(input)) {
    try {
      input = path.join(os.homedir(), input.slice(2));
    } catch {
      return null;
    }
  }

  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(input);
  const isPosixAbsolute =
    input.startsWith("/") && !input.startsWith("//");
  if (!isWindowsDrive && !isPosixAbsolute) return null;
  return existingFilePath(input);
}

function existingFilePath(candidate: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return path.resolve(candidate);
}

export class LocalWebPreviewFeature {
  private enabled = false;
  private server: LocalPreviewServer | null = null;
  private token = "";
  private readonly sessions = new Map<string, LocalPreviewRoot>();
  private readonly sessionIdByRoot = new Map<string, string>();
  private readonly wrappedSuggestions = new Map<
    AddressBarSuggestLike,
    (input: string) => unknown
  >();
  private installedViews = new WeakSet<object>();
  private layoutChangeRef: EventRef | null = null;
  private fileMenuRef: EventRef | null = null;

  constructor(private readonly plugin: MvAideIdePlugin) {}

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      await this.enable();
    } else {
      await this.disable();
    }
  }

  dispose(): Promise<void> {
    return this.disable();
  }

  async openLocalFile(absolutePath: string): Promise<void> {
    const normalized = existingFilePath(absolutePath);
    if (!normalized) {
      this.openInSystemBrowser(absolutePath);
      return;
    }
    const url = this.previewUrlForFile(normalized);
    if (!url) {
      this.openInSystemBrowser(normalized);
      return;
    }
    try {
      const leaf = this.plugin.app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: "webviewer",
        active: true,
        state: {
          url,
          title: path.basename(normalized),
          navigate: true,
        },
      });
    } catch (error) {
      console.error("[mv-aide] Failed to open local web preview", error);
      this.openInSystemBrowser(normalized);
    }
  }

  private async enable(): Promise<void> {
    this.token = randomUUID();
    this.server = new LocalPreviewServer({
      token: this.token,
      resolveRoot: (sessionId) => this.sessions.get(sessionId) ?? null,
    });
    try {
      const preferred =
        LOCAL_PREVIEW_PORT_BASE +
        (stablePortSeed(this.vaultRoot()) % LOCAL_PREVIEW_PORT_SPAN);
      await this.server.start(preferred);
    } catch (error) {
      console.error(
        "[mv-aide] Local web preview server failed to start",
        error,
      );
      this.server = null;
    }

    const workspace = this.plugin.app.workspace;
    this.layoutChangeRef = workspace.on("layout-change", () =>
      this.install(),
    );
    this.fileMenuRef = workspace.on("file-menu", (menu, file) =>
      this.onFileMenu(menu, file),
    );
    workspace.onLayoutReady(() => this.install());
  }

  private async disable(): Promise<void> {
    this.restoreAllSuggestions();
    this.installedViews = new WeakSet();

    const workspace = this.plugin.app.workspace;
    if (this.layoutChangeRef) {
      workspace.offref(this.layoutChangeRef);
      this.layoutChangeRef = null;
    }
    if (this.fileMenuRef) {
      workspace.offref(this.fileMenuRef);
      this.fileMenuRef = null;
    }

    this.sessions.clear();
    this.sessionIdByRoot.clear();
    this.token = "";
    const server = this.server;
    this.server = null;
    await server?.stop();
  }

  private install(): void {
    if (!this.enabled) return;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as WebviewerViewLike | undefined;
      if (view?.getViewType?.() !== "webviewer") return;
      this.installForView(view);
    });
  }

  private installForView(view: WebviewerViewLike): void {
    if (this.installedViews.has(view)) return;
    this.installedViews.add(view);

    const suggest = view.addressBar?.suggest;
    if (!suggest || typeof suggest.getSuggestions !== "function") return;
    if (this.wrappedSuggestions.has(suggest)) return;

    const original = suggest.getSuggestions;
    this.wrappedSuggestions.set(suggest, original);
    suggest.getSuggestions = async (input: string) => {
      const results = await Promise.resolve(original.call(suggest, input));
      if (!Array.isArray(results)) return results;
      const item = this.suggestionForInput(input);
      if (item) results.unshift(item);
      return results;
    };
  }

  private restoreAllSuggestions(): void {
    for (const [suggest, original] of this.wrappedSuggestions) {
      suggest.getSuggestions = original;
    }
    this.wrappedSuggestions.clear();
  }

  private suggestionForInput(
    input: string,
  ): LocalFilePreviewSuggestion | null {
    const absolutePath = parseLocalFileInput(input);
    if (!absolutePath) return null;
    const url = this.previewUrlForFile(absolutePath);
    if (!url) return null;
    return {
      title: t("打开本地文件"),
      url,
      type: "typed",
      score: 1000,
      matches: null,
    };
  }

  private previewUrlForFile(absolutePath: string): string | null {
    if (!this.server || this.server.port === 0) return null;
    const root = this.rootForFile(absolutePath);
    if (!root) return null;
    const rootKey = `${root.rootReal}\u0000${root.entryName}`;
    let sessionId = this.sessionIdByRoot.get(rootKey);
    if (!sessionId) {
      sessionId = randomUUID();
      this.sessionIdByRoot.set(rootKey, sessionId);
      this.sessions.set(sessionId, root);
    }
    return `http://${LOCAL_PREVIEW_SERVER_HOST}:${this.server.port}/${this.token}/${sessionId}/`;
  }

  private rootForFile(absolutePath: string): LocalPreviewRoot | null {
    const normalized = existingFilePath(absolutePath);
    if (!normalized) return null;
    try {
      return {
        rootReal: fs.realpathSync(path.dirname(normalized)),
        entryName: path.basename(normalized),
      };
    } catch {
      return null;
    }
  }

  private onFileMenu(menu: Menu, file: unknown): void {
    if (!this.enabled) return;
    const candidate = file as
      | { extension?: string; path?: string }
      | null
      | undefined;
    const extension = candidate?.extension?.toLowerCase() ?? "";
    if (!WEB_PREVIEW_EXTENSIONS.has(extension)) return;
    if (typeof candidate?.path !== "string") return;

    const adapter = this.plugin.app.vault.adapter as {
      getFullPath?: (filePath: string) => string;
    };
    if (typeof adapter.getFullPath !== "function") return;
    const absolutePath = adapter.getFullPath(candidate.path);

    menu.addItem((item) =>
      item
        .setTitle(t("用网页浏览器打开"))
        .setIcon("globe-2")
        .setSection("open")
        .onClick(() => void this.openLocalFile(absolutePath)),
    );
  }

  private openInSystemBrowser(absolutePath: string): void {
    if (
      typeof window !== "undefined" &&
      typeof window.open === "function"
    ) {
      window.open(fileUrl(absolutePath), "_external");
    }
  }

  private vaultRoot(): string {
    const adapter = this.plugin.app.vault.adapter as {
      getBasePath?: () => string;
    };
    const root = adapter?.getBasePath?.();
    if (!root) {
      throw new Error(
        "MV AIDE local web preview requires a desktop file-system vault.",
      );
    }
    return root;
  }
}
