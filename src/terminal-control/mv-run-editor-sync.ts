import type { App, MarkdownView, TFile } from "obsidian";

export interface MvRunEditorSnapshot {
  file: TFile;
  text: string;
}

export async function capturePersistedMvRunSnapshot(
  app: App,
  view: MarkdownView,
): Promise<MvRunEditorSnapshot | null> {
  const hostWindow = view.containerEl.ownerDocument.defaultView ?? activeWindow;
  await new Promise<void>((resolve) => hostWindow.setTimeout(resolve, 0));

  const file = view.file;
  if (!file) return null;

  const text = view.editor.getValue();
  const persisted = await app.vault.read(file);
  if (persisted !== text) {
    await app.vault.modify(file, text);
  }
  return { file, text };
}
