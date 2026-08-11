import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import type { VimSettings } from "../vim/settings";
import type { VimEffectiveSelection } from "../vim/core/types";

export type VimFeatureState = "disabled" | "enabling" | "enabled" | "error";

export interface VimFeatureStatus {
  state: VimFeatureState;
  message: string;
  editorCount: number;
  loadedFiles: readonly string[];
}

export interface VimLegacyConfigSource {
  filePath: string;
  removeAfterMigration: boolean;
}

export interface VimFeatureHost {
  app: App;
  pluginId: string;
  globalVimrcPath: string;
  legacyVimrcSources: readonly VimLegacyConfigSource[];
  vaultRoot: string;
  getSettings: () => VimSettings;
  sourceExtensions: () => readonly string[];
  latexSuiteRuntimeEnabled: (extension: string) => boolean;
  shouldYieldKey: (view: EditorView, event: KeyboardEvent) => boolean;
  onEnterVisual?: (view: EditorView) => void;
  createStatusBarItem: () => HTMLElement;
  registerEditorExtension: (extension: Extension) => void;
  refreshEditorExtensions: () => void;
  notify: (message: string, timeout?: number) => void;
}

export interface VimFeatureHandle {
  enable(): Promise<void>;
  disable(): void;
  settingsChanged(): Promise<void>;
  reload(): Promise<void>;
  status(): VimFeatureStatus;
  effectiveSelection(view: EditorView): VimEffectiveSelection | null;
  ensureVimrcFile(): Promise<void>;
  openVimrcFile(): Promise<void>;
  migrateLegacyVimrcFile(): Promise<boolean>;
  hasLegacyVimrcFile(): Promise<boolean>;
}
