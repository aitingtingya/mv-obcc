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
  /** Obsidian 原生状态栏是否被用户隐藏（隐藏时编辑器内悬浮状态强制启用）。 */
  nativeStatusBarHidden: () => boolean;
  registerEditorExtension: (extension: Extension) => void;
  refreshEditorExtensions: () => void;
  notify: (message: string, timeout?: number) => void;
}

export interface VimFeatureHandle {
  enable(): Promise<void>;
  disable(): void;
  settingsChanged(): Promise<void>;
  reload(): Promise<void>;
  /** 原生状态栏显隐或「编辑器内状态」开关变化后重绘状态展示（状态栏 + 悬浮）。 */
  refreshStatusChrome(): void;
  status(): VimFeatureStatus;
  effectiveSelection(view: EditorView): VimEffectiveSelection | null;
  ensureVimrcFile(): Promise<void>;
  openVimrcFile(): Promise<void>;
  migrateLegacyVimrcFile(): Promise<boolean>;
  hasLegacyVimrcFile(): Promise<boolean>;
}
