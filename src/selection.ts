import path from "node:path";
import { MarkdownView, type App, type Editor } from "obsidian";
import { fileUrl } from "./path-utils";
import type { SelectionState } from "./types";

export function getVaultRoot(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  if (!adapter.getBasePath) {
    throw new Error("MV AIDE IDE requires a desktop file-system vault.");
  }
  return adapter.getBasePath();
}

export interface LogicalEditorSelection {
  ranges: readonly { from: number; to: number }[];
  activePosition: number;
  text: string;
}

export type LogicalSelectionResolver = (
  view: MarkdownView,
) => LogicalEditorSelection | null;

export function currentSelection(
  app: App,
  resolveLogicalSelection?: LogicalSelectionResolver,
): SelectionState | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) return null;

  const editor = view.editor;
  const vaultRoot = getVaultRoot(app);
  const selection = editorSelectionState(
    editor,
    resolveLogicalSelection?.(view) ?? null,
  );

  return {
    filePath: path.join(vaultRoot, view.file.path),
    relativePath: view.file.path,
    ...selection,
  };
}

export function editorSelectionState(
  editor: Editor,
  logical: LogicalEditorSelection | null,
): Pick<SelectionState, "cursor" | "selection"> {
  if (logical) {
    const fromOffset = logical.ranges.reduce(
      (minimum, range) => Math.min(minimum, range.from),
      logical.activePosition,
    );
    const toOffset = logical.ranges.reduce(
      (maximum, range) => Math.max(maximum, range.to),
      logical.activePosition,
    );
    const cursor = editor.offsetToPos(logical.activePosition);
    const from = editor.offsetToPos(fromOffset);
    const to = editor.offsetToPos(toOffset);
    return {
      cursor: { line: cursor.line, character: cursor.ch },
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty: false,
        text: logical.text,
      },
    };
  }
  const cursor = editor.getCursor();
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const text = editor.getSelection();
  return {
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
    ...(state.headingBreadcrumb
      ? { headingBreadcrumb: state.headingBreadcrumb }
      : {}),
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
