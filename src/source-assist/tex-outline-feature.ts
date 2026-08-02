import type { Extension } from "@codemirror/state";
import {
  type App,
  type CachedMetadata,
  type Events,
  type HeadingCache,
  type TFile,
} from "obsidian";
import {
  texOutlineFoldService,
  texOutlineHeadingPreview,
} from "./tex-outline-editor";
import {
  isTexExtension,
  parseTexSections,
  texSectionsToHeadings,
} from "./tex-outline";

const PATCHED = Symbol.for("mv-aide-tex-outline-patched");

interface HeadingCacheEntry {
  mtime: number;
  headings: HeadingCache[];
}

interface Listener {
  emitter: Events;
  name: string;
  handler: (...args: unknown[]) => unknown;
}

/**
 * Makes `.tex` LaTeX section commands appear in the core Outline panel and
 * keep them in sync, while never touching files the core Outline plugin would
 * not show (md behavior is untouched and tex disappears when Outline is off).
 *
 * Obsidian hard-codes `"md"` in two places: OutlineView.getHeadings() returns
 * [] for non-md files, and metadataCache.getCache() returns {} for non-md
 * extensions. We therefore (a) hook getFileCache to inject tex headings and
 * (b) relax the OutlineView prototype check so tex goes through getFileCache.
 * Since Obsidian never indexes tex files, we pre-read contents ourselves and
 * actively refresh the outline view on edits.
 */
export class TexOutlineFeature {
  private readonly app: App;
  private readonly isEnabled: () => boolean;

  private readonly headingCache = new Map<string, HeadingCacheEntry>();
  private readonly listeners: Listener[] = [];

  private origGetFileCache: ((file: TFile) => CachedMetadata | null) | null =
    null;
  private patchedProto: object | null = null;
  private origGetHeadings: ((...args: unknown[]) => unknown) | null = null;

  constructor(app: App, isEnabled: () => boolean) {
    this.app = app;
    this.isEnabled = isEnabled;
  }

  /** CodeMirror fold + heading decoration extensions for tex section lines. */
  editorExtension(): Extension {
    return [
      texOutlineFoldService(this.isEnabled),
      texOutlineHeadingPreview(this.isEnabled),
    ];
  }

  /** Install hooks, patch the Outline prototype and seed the current file. */
  activate(): void {
    this.installGetFileCacheHook();
    this.patchOutlineGetHeadings();
    this.registerListeners();
    const active = this.app.workspace.getActiveFile();
    if (active && isTexExtension(active.extension)) {
      void this.preload(active).then(() => this.refreshOutline(active));
    }
  }

  /** Called after settings change: re-seed current file and refresh outline. */
  async settingsChanged(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (active && isTexExtension(active.extension)) {
      await this.preload(active);
    }
    this.refreshOutline();
  }

  dispose(): void {
    if (this.origGetFileCache) {
      (this.app.metadataCache as unknown as {
        getFileCache: (file: TFile) => CachedMetadata | null;
      }).getFileCache = this.origGetFileCache;
      this.origGetFileCache = null;
    }
    if (this.patchedProto && this.origGetHeadings) {
      try {
        delete (this.patchedProto as any)[PATCHED];
      } catch {
        // ignore
      }
      (this.patchedProto as { getHeadings: (...args: unknown[]) => unknown })
        .getHeadings = this.origGetHeadings;
      this.patchedProto = null;
      this.origGetHeadings = null;
    }
    for (const { emitter, name, handler } of this.listeners) {
      try {
        (emitter as any).off(name, handler);
      } catch {
        // ignore
      }
    }
    this.listeners.length = 0;
    this.headingCache.clear();
  }

  // ── getFileCache hook ────────────────────────────────────────────────

  private installGetFileCacheHook(): void {
    const metadataCache = this.app.metadataCache as unknown as {
      getFileCache: (file: TFile) => CachedMetadata | null;
    };
    if (this.origGetFileCache) return;
    this.origGetFileCache = metadataCache.getFileCache.bind(metadataCache);
    const self = this;
    metadataCache.getFileCache = (file: TFile): CachedMetadata | null => {
      const cache = self.origGetFileCache!(file);
      if (self.shouldInject(file)) {
        const headings = self.headingsFor(file);
        if (cache) {
          cache.headings = headings;
          return cache;
        }
        return { headings };
      }
      return cache;
    };
  }

  private shouldInject(file: TFile): boolean {
    return (
      isTexExtension(file.extension) &&
      this.isEnabled() &&
      this.isOutlineEnabled()
    );
  }

  private isOutlineEnabled(): boolean {
    const internal = (this.app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => { enabled: boolean } | null;
      };
    }).internalPlugins;
    return internal?.getPluginById?.("outline")?.enabled === true;
  }

  private headingsFor(file: TFile): HeadingCache[] {
    const entry = this.headingCache.get(file.path);
    if (entry && entry.mtime === file.stat.mtime) return entry.headings;
    return [];
  }

  private async preload(file: TFile): Promise<void> {
    if (!isTexExtension(file.extension)) return;
    try {
      const content = await this.app.vault.cachedRead(file);
      const sections = parseTexSections(content);
      this.headingCache.set(file.path, {
        mtime: file.stat.mtime,
        headings: texSectionsToHeadings(sections),
      });
    } catch {
      this.headingCache.delete(file.path);
    }
  }

  // ── Outline prototype patch ──────────────────────────────────────────

  private patchOutlineGetHeadings(): boolean {
    const leaf = this.app.workspace.getLeavesOfType("outline")[0];
    if (!leaf) return false;
    let proto = Object.getPrototypeOf(leaf.view) as any;
    while (proto && proto !== Object.prototype) {
      if (
        typeof proto.getHeadings === "function" &&
        !proto[PATCHED] &&
        proto !== this.patchedProto
      ) {
        const orig = proto.getHeadings;
        this.patchedProto = proto;
        this.origGetHeadings = orig;
        proto.getHeadings = function (this: unknown) {
          const view = this as {
            file?: TFile;
            app?: App;
          };
          if (!view.file) return orig.call(this);
          if (isTexExtension(view.file.extension)) {
            const cache = view.app?.metadataCache?.getFileCache?.(view.file);
            return cache?.headings ?? [];
          }
          return orig.call(this);
        };
        proto[PATCHED] = true;
        return true;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  }

  private refreshOutline(file?: TFile): void {
    for (const leaf of this.app.workspace.getLeavesOfType("outline")) {
      const view = leaf.view as { file?: TFile; requestUpdate?: (immediate?: boolean) => void };
      if (!file || view?.file === file) {
        try {
          view?.requestUpdate?.(true);
        } catch {
          // ignore
        }
      }
    }
  }

  // ── events ───────────────────────────────────────────────────────────

  private registerListeners(): void {
    this.on(this.app.vault, "modify", this.handleVaultModify);
    this.on(this.app.vault, "create", this.handleVaultCreate);
    this.on(this.app.vault, "delete", this.handleVaultDelete);
    this.on(this.app.vault, "rename", this.handleVaultRename);
    this.on(this.app.workspace, "file-open", this.handleFileOpen);
    this.on(this.app.workspace, "layout-change", this.handleLayoutChange);
    this.on(
      this.app.workspace,
      "active-leaf-change",
      this.handleActiveLeafChange,
    );
    const internal = (this.app as unknown as {
      internalPlugins?: Events;
    }).internalPlugins;
    if (internal) {
      this.on(internal, "change", this.handleInternalPluginChange);
    }
  }

  private on(
    emitter: Events,
    name: string,
    handler: (...args: unknown[]) => unknown,
  ): void {
    (emitter as any).on(name, handler);
    this.listeners.push({ emitter, name, handler });
  }

  private readonly handleVaultModify = (file: TFile): void => {
    if (isTexExtension(file.extension)) {
      void this.preload(file).then(() => this.refreshOutline(file));
    }
  };

  private readonly handleVaultCreate = (file: TFile): void => {
    this.patchOutlineGetHeadings();
    if (isTexExtension(file.extension)) void this.preload(file);
  };

  private readonly handleVaultDelete = (file: TFile): void => {
    this.headingCache.delete(file.path);
  };

  private readonly handleVaultRename = (
    file: TFile,
    oldPath: string,
  ): void => {
    this.headingCache.delete(oldPath);
    if (isTexExtension(file.extension)) void this.preload(file);
  };

  private readonly handleFileOpen = (file: TFile): void => {
    this.patchOutlineGetHeadings();
    if (isTexExtension(file.extension)) {
      void this.preload(file).then(() => this.refreshOutline(file));
    }
  };

  private readonly handleLayoutChange = (): void => {
    this.patchOutlineGetHeadings();
  };

  private readonly handleActiveLeafChange = (): void => {
    this.patchOutlineGetHeadings();
    const active = this.app.workspace.getActiveFile();
    if (active && isTexExtension(active.extension)) {
      void this.preload(active).then(() => this.refreshOutline(active));
    }
  };

  private readonly handleInternalPluginChange = (id: unknown): void => {
    if (id === "outline") {
      this.patchOutlineGetHeadings();
      this.refreshOutline();
    }
  };
}
