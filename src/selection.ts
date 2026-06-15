import path from "node:path";
import { MarkdownView, type App } from "obsidian";
import { fileUrl } from "./path-utils";
import type { SelectionState } from "./types";

export function getVaultRoot(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  if (!adapter.getBasePath) {
    throw new Error("MV OBCC IDE requires a desktop file-system vault.");
  }
  return adapter.getBasePath();
}

export function currentSelection(app: App): SelectionState | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) return null;

  const editor = view.editor;
  const vaultRoot = getVaultRoot(app);
  const cursor = editor.getCursor();
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const text = editor.getSelection();

  return {
    filePath: path.join(vaultRoot, view.file.path),
    relativePath: view.file.path,
    cursor: { line: cursor.line, character: cursor.ch },
    selection: {
      start: { line: from.line, character: from.ch },
      end: { line: to.line, character: to.ch },
      isEmpty: text.length === 0,
      text,
    },
  };
}

export function selectionChangedParams(state: SelectionState): Record<string, unknown> {
  return {
    filePath: state.filePath,
    fileUrl:
      state.resourceType === "web" || state.resourceType === "view"
        ? state.filePath
        : fileUrl(state.filePath),
    ...(state.title ? { title: state.title } : {}),
    ...(state.viewType ? { viewType: state.viewType } : {}),
    ...(state.resourceType ? { resourceType: state.resourceType } : {}),
    ...(state.url ? { url: state.url } : {}),
    ...(state.page !== undefined ? { page: state.page } : {}),
    selection: {
      start: state.selection.start,
      end: state.selection.isEmpty
        ? {
            line: state.selection.start.line,
            character: state.selection.start.character + 1,
          }
        : state.selection.end,
    },
    ...(state.selection.isEmpty ? {} : { text: state.selection.text }),
  };
}

export function atMentionedParams(state: SelectionState): Record<string, unknown> {
  const filePath = state.relativePath.includes(" ")
    ? `"${state.relativePath}"`
    : state.relativePath;
  return state.selection.isEmpty
    ? { filePath }
    : {
        filePath,
        lineStart: state.selection.start.line,
        lineEnd: state.selection.end.line,
      };
}
