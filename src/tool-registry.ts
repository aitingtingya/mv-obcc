import path from "node:path";
import {
  MarkdownView,
  TFile,
  getAllTags,
  type App,
  type WorkspaceLeaf,
} from "obsidian";
import { randomUUID } from "node:crypto";
import { DIFF_VIEW_TYPE, TERMINAL_VIEW_TYPE } from "./constants";
import { resolveVaultPath } from "./path-utils";
import { getVaultRoot } from "./selection";
import { ObsidianDiffView } from "./diff-view";
import { TerminalView } from "./terminal/terminal-view";
import {
  isAbsolutePath,
  readOutsideFileForDiff,
  validateOutsideOriginal,
} from "./dsh/dsh-outside-diff";
import type { LintDiagnosticsFile } from "./lint/lint-feature";
import {
  getOpenWorkspaceTabs,
  readCurrentWebPage,
} from "./workspace-context";
import type {
  BridgeClientContext,
  DiffPayload,
  SelectionState,
  ToolResult,
} from "./types";

function result(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function findFile(app: App, requestedPath: string): TFile | null {
  const resolved = resolveVaultPath(getVaultRoot(app), requestedPath);
  if (!resolved) return null;
  const file = app.vault.getAbstractFileByPath(resolved.relativePath);
  return file instanceof TFile ? file : null;
}

export class ToolRegistry {
  constructor(
    private readonly app: App,
    private readonly getLatestSelection: (
      context?: BridgeClientContext,
    ) => SelectionState | null,
    private readonly getLatestWebLeaf: () => WorkspaceLeaf | null,
    private readonly getWebPageMaxCharacters: () => number | null,
    private readonly getDiagnosticsSnapshot: () => LintDiagnosticsFile[] = () => [],
    private readonly getReviewOutsideVault: () => boolean = () => false,
  ) {}

  async call(
    name: string,
    args: Record<string, unknown>,
    context?: BridgeClientContext,
  ): Promise<ToolResult | null> {
    switch (name) {
      case "getLatestSelection": {
        const state = this.getLatestSelection(context);
        return result(state ?? { error: "no selection tracked yet" }, !state);
      }
      case "getOpenEditors":
        return result(getOpenWorkspaceTabs(this.app));
      case "openFile":
        return result(await this.openFile(args));
      case "readCurrentWebPage":
        return result(
          await readCurrentWebPage(
            this.app,
            this.getLatestWebLeaf(),
            this.getWebPageMaxCharacters(),
          ),
        );
      case "openDiff":
        return this.openDiff(args);
      case "closeAllDiffTabs":
        return result(await this.closeAllDiffTabs());
      case "getDiagnostics":
        return result(this.collectDiagnostics(args));
      case "getTerminalOutput":
        return result(this.collectTerminalOutput(args));
      case "searchVaultSymbols":
        return result(this.searchVaultSymbols(args));
      case "getBacklinks":
        return result(this.collectLinks(args, "backlinks"));
      case "getOutgoingLinks":
        return result(this.collectLinks(args, "outgoing"));
      case "searchTags":
        return result(this.searchTags(args));
      case "listNotesByTag":
        return result(this.listNotesByTag(args));
      case "close_tab":
        return result(await this.closeDiffTab(asString(args.tab_name ?? args.tabName)));
      default:
        return null;
    }
  }

  private async openFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestedPath = asString(args.filePath);
    const file = findFile(this.app, requestedPath);
    if (!file) return { success: false, message: `File not found: ${requestedPath}` };

    const makeFrontmost = args.makeFrontmost !== false;
    // 打开文件只新开标签或复用已在显示该文件的标签，绝不导航当前活跃叶子：
    // 活跃标签可能是网页/终端等被导航后无法恢复的用户页面。
    let existing: WorkspaceLeaf | undefined;
    this.app.workspace.iterateAllLeaves((candidate) => {
      if (!existing && (candidate.view as { file?: TFile | null }).file?.path === file.path) {
        existing = candidate;
      }
    });
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    let line = typeof args.line === "number" ? Math.max(0, Math.floor(args.line)) : undefined;
    let startCharacter = 0;
    let endLine: number | undefined;
    let endCharacter: number | undefined;
    const startText = asString(args.startText);
    const endText = asString(args.endText);

    if (startText) {
      const contents = await this.app.vault.cachedRead(file);
      const startIndex = contents.indexOf(startText);
      if (startIndex >= 0) {
        const before = contents.slice(0, startIndex);
        line = before.split("\n").length - 1;
        const previousNewline = before.lastIndexOf("\n");
        startCharacter = previousNewline < 0 ? startIndex : startIndex - previousNewline - 1;

        if (endText) {
          const endIndex = contents.indexOf(endText, startIndex + startText.length);
          if (endIndex >= 0) {
            const throughEnd = contents.slice(0, endIndex + endText.length);
            endLine = throughEnd.split("\n").length - 1;
            const endNewline = throughEnd.lastIndexOf("\n");
            endCharacter =
              endNewline < 0 ? endIndex + endText.length : throughEnd.length - endNewline - 1;
          }
        } else if (args.selectToEndOfLine === true) {
          const lineEnd = contents.indexOf("\n", startIndex);
          const effectiveEnd = lineEnd < 0 ? contents.length : lineEnd;
          endLine = line;
          endCharacter = effectiveEnd - (previousNewline + 1);
        }
      }
    }

    const eState =
      line === undefined
        ? undefined
        : {
            line,
            ch: startCharacter,
            scroll: line,
          };
    await leaf.openFile(file, { active: makeFrontmost, eState });

    if (line !== undefined && leaf.view instanceof MarkdownView) {
      const editor = (leaf.view as MarkdownView).editor;
      const start = { line, ch: startCharacter };
      const end =
        endLine !== undefined && endCharacter !== undefined
          ? { line: endLine, ch: endCharacter }
          : start;
      if (endLine !== undefined && endCharacter !== undefined) {
        editor.setSelection(start, end);
      } else {
        editor.setCursor(start);
      }
      editor.scrollIntoView({ from: start, to: end }, true);
    }
    if (makeFrontmost) await this.app.workspace.revealLeaf(leaf);
    return { success: true, filePath: file.path, line: line ?? null };
  }

  private async openDiff(args: Record<string, unknown>): Promise<ToolResult> {
    const oldFilePath = asString(
      args.old_file_path ?? args.oldFilePath ?? args.new_file_path ?? args.newFilePath,
    );
    const newFilePath = asString(
      args.new_file_path ?? args.newFilePath ?? oldFilePath,
    );
    const newContents = asString(args.new_file_contents ?? args.newFileContents);
    const tabName =
      asString(args.tab_name ?? args.tabName) ||
      `Claude: ${path.basename(newFilePath || oldFilePath || "diff")}`;
    const vaultRoot = getVaultRoot(this.app);
    const resolvedOldPath = oldFilePath
      ? resolveVaultPath(vaultRoot, oldFilePath)
      : null;
    const resolvedNewPath = newFilePath
      ? resolveVaultPath(vaultRoot, newFilePath)
      : resolvedOldPath;
    // Out-of-vault review (the mv-agent "使用 Obsidian 审阅仓库外 diff"
    // setting): absolute paths outside the vault are reviewed read-only from
    // disk. Accepting still only REPORTS the approved contents — the caller
    // (the dsh plugin) is the one that persists them.
    const canReviewOutside = this.getReviewOutsideVault();
    const outsideOldPath =
      !resolvedOldPath && oldFilePath && canReviewOutside && isAbsolutePath(oldFilePath)
        ? oldFilePath
        : null;
    const outsideNewPath =
      !resolvedNewPath && newFilePath && canReviewOutside && isAbsolutePath(newFilePath)
        ? newFilePath
        : null;
    if (
      (!resolvedOldPath && !outsideOldPath && oldFilePath) ||
      (!resolvedNewPath && !outsideNewPath)
    ) {
      return result(
        {
          error:
            "Diff paths must resolve inside the current Obsidian vault. To review files outside the vault, enable “使用 Obsidian 审阅仓库外 diff” in the mv-agent settings and pass absolute paths.",
          oldFilePath,
          newFilePath,
        },
        true,
      );
    }
    const oldFile = oldFilePath && resolvedOldPath ? findFile(this.app, oldFilePath) : null;
    let oldContents = "";
    if (oldFile) {
      oldContents = await this.app.vault.cachedRead(oldFile);
    } else if (outsideOldPath) {
      const read = await readOutsideFileForDiff(outsideOldPath);
      if (!read.ok) return result({ error: read.error }, true);
      oldContents = read.contents;
    }
    const sessionId = randomUUID();
    const previousLeaf = this.app.workspace.getMostRecentLeaf();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });

    if (!(leaf.view instanceof ObsidianDiffView)) {
      leaf.detach();
      return result(["DIFF_REJECTED", tabName]);
    }
    const diffView = leaf.view;

    let settleDecision:
      | ((value: { decision: "accept" | "reject"; contents: string }) => void)
      | null = null;
    const decisionPromise = new Promise<{
      decision: "accept" | "reject";
      contents: string;
    }>((resolve) => {
      settleDecision = resolve;
    });
    let settled = false;
    const payload: DiffPayload = {
      sessionId,
      oldFilePath,
      newFilePath,
      oldContents,
      newContents,
      tabName,
      validateOriginal: async () => {
        if (outsideOldPath) {
          return validateOutsideOriginal(outsideOldPath, oldContents);
        }
        if (!oldFile) return true;
        const currentFile = findFile(this.app, oldFile.path);
        return !!currentFile && (await this.app.vault.cachedRead(currentFile)) === oldContents;
      },
      onResolve: async (nextDecision, contents) => {
        if (settled || !settleDecision) return;
        settled = true;
        settleDecision({ decision: nextDecision, contents });
      },
    };
    diffView.setPayload(payload);
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const decision = await decisionPromise;
    if (previousLeaf?.view?.getViewType() === TERMINAL_VIEW_TYPE) {
      this.app.workspace.setActiveLeaf(previousLeaf, { focus: true });
      await this.app.workspace.revealLeaf(previousLeaf);
    }

    return decision.decision === "accept"
      ? {
          content: [
            { type: "text", text: "FILE_SAVED" },
            { type: "text", text: decision.contents },
          ],
        }
      : {
          content: [
            { type: "text", text: "DIFF_REJECTED" },
            { type: "text", text: tabName },
          ],
        };
  }

  private async closeAllDiffTabs(): Promise<{ closed: number }> {
    const views: ObsidianDiffView[] = [];
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof ObsidianDiffView) {
        views.push(leaf.view);
        leaves.push(leaf);
      }
    });
    for (const view of views) await view.forceReject();
    for (const leaf of leaves) leaf.detach();
    return { closed: leaves.length };
  }

  private async closeDiffTab(tabName: string): Promise<{ closed: number }> {
    let closed = 0;
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof ObsidianDiffView &&
        (!tabName || leaf.view.matchesTabName(tabName))
      ) {
        leaves.push(leaf);
      }
    });
    for (const leaf of leaves) {
      await (leaf.view as ObsidianDiffView).forceReject();
      leaf.detach();
      closed += 1;
    }
    return { closed };
  }

  private collectDiagnostics(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const severityRaw = asString(args.severity);
    const severity = ["error", "warning", "all"].includes(severityRaw)
      ? severityRaw
      : "error";
    const pathFilter = asString(args.filePath);
    const files = this.getDiagnosticsSnapshot()
      .filter((file) => !pathFilter || file.filePath.endsWith(pathFilter))
      .map((file) => ({
        filePath: file.filePath,
        updatedAt: file.updatedAt,
        diagnostics:
          severity === "all"
            ? file.diagnostics
            : file.diagnostics.filter((d) => d.severity === severity),
      }))
      .filter((file) => file.diagnostics.length > 0);
    return { severity, files };
  }

  private collectTerminalOutput(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const rawLastN = typeof args.lastN === "number" ? args.lastN : 50;
    const lastN = Math.min(500, Math.max(1, Math.floor(rawLastN)));
    const tabNameFilter = asString(args.tabName);
    const terminals: Array<{
      tabName: string;
      displayName: string;
      lines: string[];
    }> = [];
    // getDisplayText() 对所有终端标签恒为同一名称，按遍历顺序给实例编号
    // （系统终端 #N）作为可过滤的稳定名；过滤同时接受编号名与显示名。
    let index = 0;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== TERMINAL_VIEW_TYPE) return;
      if (!(leaf.view instanceof TerminalView)) return;
      index += 1;
      const displayName = leaf.view.getDisplayText();
      const tabName = `${displayName} #${index}`;
      if (
        tabNameFilter &&
        tabNameFilter !== tabName &&
        tabNameFilter !== displayName
      ) {
        return;
      }
      terminals.push({
        tabName,
        displayName,
        lines: leaf.view.readTailLines(lastN),
      });
    });
    return { terminals };
  }

  private searchVaultSymbols(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const query = asString(args.query).toLowerCase();
    if (!query) return { symbols: [] };
    const rawMax = typeof args.maxResults === "number" ? args.maxResults : 50;
    const max = Math.min(200, Math.max(1, Math.floor(rawMax)));
    const symbols: Array<{
      filePath: string;
      line: number;
      level: number;
      heading: string;
    }> = [];
    for (const file of this.app.vault.getFiles()) {
      if (symbols.length >= max) break;
      const headings = this.app.metadataCache.getFileCache(file)?.headings;
      if (!headings) continue;
      for (const heading of headings) {
        if (symbols.length >= max) break;
        if (!heading.heading.toLowerCase().includes(query)) continue;
        symbols.push({
          filePath: file.path,
          line: heading.position.start.line,
          level: heading.level,
          heading: heading.heading,
        });
      }
    }
    return { symbols };
  }

  private collectLinks(
    args: Record<string, unknown>,
    direction: "backlinks" | "outgoing",
  ): Record<string, unknown> {
    const requestedPath = asString(args.filePath);
    const file = findFile(this.app, requestedPath);
    if (!file) return { error: `File not found: ${requestedPath}`, files: [] };
    const resolved = this.app.metadataCache.resolvedLinks;
    const files =
      direction === "outgoing"
        ? Object.keys(resolved[file.path] ?? {})
        : Object.entries(resolved)
            .filter(([, targets]) => targets[file.path])
            .map(([source]) => source);
    return { filePath: file.path, files };
  }

  private searchTags(args: Record<string, unknown>): Record<string, unknown> {
    const query = asString(args.query).toLowerCase();
    if (!query) return { tags: [] };
    const tags = new Set<string>();
    for (const file of this.app.vault.getFiles()) {
      if (tags.size >= 100) break;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      for (const tag of getAllTags(cache) ?? []) {
        if (tags.size >= 100) break;
        if (tag.toLowerCase().includes(query)) tags.add(tag);
      }
    }
    return { tags: [...tags].sort() };
  }

  private listNotesByTag(
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const raw = asString(args.tag);
    if (!raw) return { files: [] };
    const wanted = raw.startsWith("#") ? raw : `#${raw}`;
    const files: string[] = [];
    for (const file of this.app.vault.getFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      if ((getAllTags(cache) ?? []).includes(wanted)) files.push(file.path);
    }
    return { tag: wanted, files: files.sort() };
  }
}
