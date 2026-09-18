import type { App, MarkdownView, TFile } from "obsidian";
import { message } from "./messages";

export interface BoundEditor { view: MarkdownView; file: TFile; path: string }
export function bindEditor(view: MarkdownView): BoundEditor {
  if (!view.file) throw new Error(message("fileChanged"));
  return { view, file: view.file, path: view.file.path };
}

export function boundText(bound: BoundEditor): string {
  if (bound.view.file !== bound.file || bound.file.path !== bound.path || bound.view.containerEl.ownerDocument.defaultView?.closed) {
    throw new Error(message("fileChanged"));
  }
  return bound.view.editor.getValue();
}

/** Preserve the existing event-turn barrier without rediscovering an active view. */
export async function flushEditorTurn(bound: BoundEditor, signal?: AbortSignal): Promise<string> {
  const hostWindow = bound.view.containerEl.ownerDocument.defaultView;
  if (!hostWindow || hostWindow.closed) throw new Error(message("fileChanged"));
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      hostWindow.clearTimeout(timer);
      hostWindow.removeEventListener("pagehide", cancel);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = (): void => { cleanup(); reject(new Error(message("fileChanged"))); };
    const timer = hostWindow.setTimeout(() => { cleanup(); resolve(); }, 0);
    hostWindow.addEventListener("pagehide", cancel, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
  });
  return boundText(bound);
}

export async function persistBoundSnapshot(app: App, bound: BoundEditor, text: string, signal?: AbortSignal): Promise<void> {
  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    if (boundText(bound) !== text) throw new Error(message("fileChanged"));
  };
  assertCurrent();
  const persisted = await app.vault.read(bound.file);
  assertCurrent();
  if (persisted !== text) await app.vault.modify(bound.file, text);
  assertCurrent();
}
