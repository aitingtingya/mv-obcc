import { randomUUID } from "node:crypto";
import { TFolder, type App, type TFile } from "obsidian";
import { TERMINAL_PREVIEW_FOLDER } from "../storage/vault-paths";

const runId = randomUUID();
const stores = new WeakMap<App, PreviewFiles>();

/** Serializes this feature's file operations across terminal windows. */
export class PreviewFiles {
  private pending = Promise.resolve();
  private readonly folder = `${TERMINAL_PREVIEW_FOLDER}/${runId}`;

  constructor(private readonly app: App) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.pending.then(task);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  create(text: string): Promise<TFile> {
    return this.enqueue(async () => {
      const parts = this.folder.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!this.app.vault.getAbstractFileByPath(folder)) {
          await this.app.vault.createFolder(folder);
        }
      }
      return this.app.vault.create(`${this.folder}/${randomUUID()}.md`, text);
    });
  }

  remove(file: TFile): Promise<void> {
    return this.enqueue(async () => {
      // These are feature-owned scratch files, not deleted user notes: do not
      // keep discarded terminal text in the vault/system trash.
      // A file explicitly moved out through the native editor is no longer
      // in this temporary namespace.
      if (file.parent?.path === this.folder) await this.app.vault.delete(file);
      const folder = this.app.vault.getAbstractFileByPath(this.folder);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.vault.delete(folder, true);
      }
    });
  }

  createNote(text: string): Promise<TFile> {
    return this.enqueue(async () => {
      const parent = this.app.fileManager.getNewFileParent("");
      const prefix = parent.path === "/" ? "" : `${parent.path}/`;
      let index = 0;
      let path = `${prefix}Untitled.md`;
      while (this.app.vault.getAbstractFileByPath(path)) {
        index += 1;
        path = `${prefix}Untitled ${index}.md`;
      }
      return this.app.vault.create(path, text);
    });
  }
}

export function previewFiles(app: App): PreviewFiles {
  let files = stores.get(app);
  if (!files) {
    files = new PreviewFiles(app);
    stores.set(app, files);
  }
  return files;
}
