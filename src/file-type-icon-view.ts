// Obsidian-internal file-type icons: per-extension extension-text badges in
// tab headers. File-explorer icons were dropped on purpose: Obsidian already
// shows the extension on the right side of each row, and the badge was
// illegible at that size. DOM wiring is kept thin; the decision helpers are
// pure and unit tested.

import { addIcon, setIcon, type App } from "obsidian";
import {
  labelForExtension,
  obsidianFileTypeIconSvg,
} from "./file-type-icons";

export const FILE_TYPE_ICON_ID_PREFIX = "mv-fti-";
// Gates the CSS override that un-hides Obsidian's markdown tab icon slot
// (Obsidian's own stylesheet sets it to display:none for notes).
const TABS_BODY_CLASS = "mv-fti-tabs";

/** Pure: lowercase extension of a vault path, or null when it has none. */
export function extensionOfPath(filePath: string): string | null {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Pure: registered icon id for an extension, null when unusable. */
export function fileTypeIconId(extension: string): string | null {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (!normalized || labelForExtension(normalized) === null) return null;
  return `${FILE_TYPE_ICON_ID_PREFIX}${normalized}`;
}

/** Pure: icon id when the extension is in the supported set, else null. */
export function supportedFileTypeIconId(
  extension: string,
  supportedExtensions: ReadonlySet<string>,
): string | null {
  const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (!supportedExtensions.has(normalized)) return null;
  return fileTypeIconId(normalized);
}

/** Pure: true when the leaf shows a file document (markdown view). */
export function isFileTabViewType(
  viewType: string | null | undefined,
): boolean {
  return viewType === "markdown";
}

/**
 * Pure: the tab's file path. A live view's `file.path` wins; restored
 * deferred leaves only carry the path in the saved view state (`state.file`)
 * until first activation, so that is the fallback.
 */
export function tabFilePath(
  viewPath: string | null | undefined,
  stateFile: unknown,
): string | null {
  if (typeof viewPath === "string" && viewPath) return viewPath;
  if (typeof stateFile === "string" && stateFile) return stateFile;
  return null;
}

interface TabbedLeafView {
  file?: { path?: string; extension?: string } | null;
  getIcon?: () => string;
  getViewType?: () => string;
}

export interface FileTypeIconViewOptions {
  app: App;
  getSupportedExtensions: () => string[];
  isEnabled: () => boolean;
}

export class FileTypeIconView {
  private readonly supportedExtensions = new Set<string>();
  private readonly badgedIconEls = new WeakSet<HTMLElement>();
  private started = false;

  constructor(private readonly options: FileTypeIconViewOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.syncFromSettings();
  }

  /** Re-reads enabled flag + extension set; called when settings change. */
  syncFromSettings(): void {
    this.supportedExtensions.clear();
    for (const extension of this.options.getSupportedExtensions()) {
      const normalized = extension.trim().replace(/^\.+/, "").toLowerCase();
      if (normalized) this.supportedExtensions.add(normalized);
    }
    const enabled = this.options.isEnabled();
    activeDocument.body.classList.toggle(TABS_BODY_CLASS, enabled);
    if (!enabled) {
      this.restoreTabIcons();
      return;
    }
    for (const extension of this.supportedExtensions) {
      const label = labelForExtension(extension);
      const iconId = fileTypeIconId(extension);
      if (label && iconId) {
        addIcon(iconId, obsidianFileTypeIconSvg(label));
      }
    }
    this.refresh();
  }

  refresh(): void {
    if (this.options.isEnabled()) this.refreshTabIcons();
  }

  dispose(): void {
    activeDocument.body.classList.remove(TABS_BODY_CLASS);
    this.restoreTabIcons();
    this.started = false;
  }

  refreshTabIcons(): void {
    this.options.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as TabbedLeafView;
      const iconEl = (leaf as unknown as {
        tabHeaderInnerIconEl?: HTMLElement;
      }).tabHeaderInnerIconEl;
      if (!iconEl) return;
      // Only file document tabs get extension badges; panel views (outline,
      // terminal, ...) expose `view.file` too but must keep their own icon.
      const viewType =
        typeof view?.getViewType === "function"
          ? view.getViewType()
          : (leaf.getViewState()?.type as string | undefined);
      const viewPath = view?.file?.path;
      // Deferred restored leaves have no `view.file` until first activation;
      // only then pay for getViewState(), which reads the saved state object
      // without instantiating the view.
      const stateFile =
        typeof viewPath === "string" && viewPath
          ? undefined
          : (leaf.getViewState()?.state as { file?: unknown } | undefined)
              ?.file;
      const path = tabFilePath(viewPath, stateFile) ?? "";
      const extension = path ? extensionOfPath(path) : null;
      const supportedId =
        this.options.isEnabled() && isFileTabViewType(viewType) && extension
          ? supportedFileTypeIconId(extension, this.supportedExtensions)
          : null;
      if (supportedId) {
        setIcon(iconEl, supportedId);
        this.badgedIconEls.add(iconEl);
      } else if (this.badgedIconEls.has(iconEl)) {
        // Only restore icon slots we badged ourselves. Every other tab —
        // web viewer favicons, panel icons — is left completely untouched;
        // setIcon would wipe their custom content (a favicon <img>) and
        // replace it with getIcon()'s default (the globe).
        this.badgedIconEls.delete(iconEl);
        if (typeof view?.getIcon === "function") {
          setIcon(iconEl, view.getIcon());
        }
      }
    });
  }

  private restoreTabIcons(): void {
    this.options.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as unknown as TabbedLeafView;
      const iconEl = (leaf as unknown as {
        tabHeaderInnerIconEl?: HTMLElement;
      }).tabHeaderInnerIconEl;
      // Same contract as refreshTabIcons: only icon slots we badged ourselves
      // get restored; all other tabs keep whatever icon they have.
      if (
        iconEl &&
        this.badgedIconEls.has(iconEl) &&
        typeof view?.getIcon === "function"
      ) {
        this.badgedIconEls.delete(iconEl);
        setIcon(iconEl, view.getIcon());
      }
    });
  }
}
