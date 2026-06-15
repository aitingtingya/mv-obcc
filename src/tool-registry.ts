import path from "node:path";
import { MarkdownView, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { randomUUID } from "node:crypto";
import { DIFF_VIEW_TYPE } from "./constants";
import { resolveVaultPath } from "./path-utils";
import { getVaultRoot } from "./selection";
import { ObsidianDiffView } from "./diff-view";
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
        return result([]);
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
    const leaf = this.app.workspace.getLeaf(false);
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
    if ((!resolvedOldPath && oldFilePath) || !resolvedNewPath) {
      return result(
        {
          error: "Diff paths must resolve inside the current Obsidian vault.",
          oldFilePath,
          newFilePath,
        },
        true,
      );
    }
    const oldFile = oldFilePath ? findFile(this.app, oldFilePath) : null;
    const oldContents = oldFile ? await this.app.vault.cachedRead(oldFile) : "";
    const sessionId = randomUUID();
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
    const decision = await decisionPromise;

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
}
