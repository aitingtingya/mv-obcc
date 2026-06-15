import { type App, TFile } from "obsidian";

/**
 * Single reusable temp markdown file that backs the LLM result popover.
 *
 * `MarkdownView` requires a real `TFile`, so the embedded-editor popover opens
 * this file. We reuse one file per vault (`mv-obcc-llm-history/latest.md`) and
 * overwrite its contents each invocation — zero garbage accumulation, no
 * cleanup needed.
 *
 * Why not a `.`-prefixed (hidden) folder? Obsidian's vault does not index
 * dot-directories, so no `TFile` would exist and `leaf.openFile()` could not
 * open it. The plain folder works and stays out of the way because the plugin
 * registers it in `app.vault.userIgnoreFilters` (hidden from file tree /
 * search / quick switcher).
 */

export const TEMP_DIR = "mv-obcc-llm-history";
export const TEMP_FILE_PATH = `${TEMP_DIR}/latest.md`;
/** Glob pattern for `userIgnoreFilters`. */
export const TEMP_IGNORE_PATTERN = "mv-obcc-llm-history/**";

/**
 * Ensure the temp file exists (creating folder + file if needed) and return it.
 * Throws if the file cannot be created — the caller falls back to the textarea
 * modal.
 */
export async function ensureTempFile(app: App): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(TEMP_FILE_PATH);
  if (existing instanceof TFile) return existing;

  if (!app.vault.getAbstractFileByPath(TEMP_DIR)) {
    try {
      await app.vault.createFolder(TEMP_DIR);
    } catch {
      // Folder might have been created concurrently; ignore.
    }
  }
  return app.vault.create(TEMP_FILE_PATH, "");
}

/**
 * Hide the temp folder from Obsidian's file tree / search / quick switcher.
 * Idempotent: only adds the pattern if it is not already present.
 *
 * `userIgnoreFilters` is a real runtime field on `app.vault` but is not part
 * of the public `obsidian.d.ts`, so we cast through `VaultWithConfig`. This
 * only affects UI visibility — if it ever disappears, the temp file still
 * works; it just shows up in the file tree.
 */
interface VaultWithIgnoreFilters {
  userIgnoreFilters?: string[];
}
export function registerTempIgnoreFilter(app: App): void {
  const vault = app.vault as unknown as VaultWithIgnoreFilters;
  const filters = vault.userIgnoreFilters ?? [];
  if (!filters.includes(TEMP_IGNORE_PATTERN)) {
    vault.userIgnoreFilters = [...filters, TEMP_IGNORE_PATTERN];
  }
}
