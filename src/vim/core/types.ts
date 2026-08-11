export type VimMode =
  | "normal"
  | "insert"
  | "replace"
  | "visual"
  | "visual-line"
  | "visual-block"
  | "operator-pending"
  | "command-line";

export type VimTextInputTarget =
  | "insert"
  | "replace"
  | "command-line"
  | "discard";

export type VimRegisterKind = "character" | "line" | "block";

export interface VimSelection {
  anchor: number;
  head: number;
}

export type VimVisualMode = "visual" | "visual-line" | "visual-block";

/**
 * The complete logical Visual selection. CodeMirror keeps only a collapsed
 * caret at activePosition; consumers must use this snapshot for the range.
 */
export interface VimVisualSnapshot {
  mode: VimVisualMode;
  anchor: number;
  head: number;
  ranges: readonly VimSelection[];
  activePosition: number;
}

export interface VimEffectiveSelection {
  mode: VimVisualMode;
  ranges: readonly { from: number; to: number }[];
  activePosition: number;
  text: string;
}

export interface VimEdit {
  from: number;
  to: number;
  insert: string;
}

export interface VimLine {
  number: number;
  from: number;
  to: number;
  text: string;
}

/**
 * Minimal mutable text surface consumed by the independent Vim core.
 * Implementations are supplied by the in-memory tests and the CodeMirror layer.
 */
export interface VimBuffer {
  readonly id: string;
  readonly length: number;
  readonly lineCount: number;
  text(from?: number, to?: number): string;
  line(number: number): VimLine;
  lineAt(position: number): VimLine;
  selections(): readonly VimSelection[];
  setSelections(selections: readonly VimSelection[], primaryIndex?: number): void;
  presentVisual(snapshot: VimVisualSnapshot): void;
  clearVisual(): void;
  visualSnapshot(): VimVisualSnapshot | null;
  apply(edits: readonly VimEdit[], selections?: readonly VimSelection[]): void;
  beginHistoryGroup(): void;
  endHistoryGroup(): void;
  undo(): boolean;
  redo(): boolean;
}

export interface VimRegister {
  text: string;
  kind: VimRegisterKind;
}

export interface VimOptions {
  tabstop: number;
  shiftwidth: number;
  expandtab: boolean;
  ignorecase: boolean;
  smartcase: boolean;
  wrap: boolean;
  number: boolean;
  relativenumber: boolean;
  timeoutlen: number;
  clipboard: "" | "unnamed" | "unnamedplus";
}

export const DEFAULT_VIM_OPTIONS: VimOptions = {
  tabstop: 4,
  shiftwidth: 4,
  expandtab: true,
  ignorecase: false,
  smartcase: false,
  wrap: true,
  number: false,
  relativenumber: false,
  timeoutlen: 1000,
  clipboard: "",
};

export interface VimMapping {
  modes: readonly VimMode[];
  lhs: readonly string[];
  rhs: readonly string[];
  recursive: boolean;
  expression?: boolean;
}

export interface VimAbbreviation {
  lhs: string;
  rhs: string;
  recursive: boolean;
}

export interface VimRuntimeConfig {
  options: VimOptions;
  mappings: readonly VimMapping[];
  abbreviations: readonly VimAbbreviation[];
  exCommands: ReadonlyMap<string, string>;
  autocmds: readonly VimAutocmd[];
}

export type VimAutocmdEvent =
  | "BufEnter"
  | "BufLeave"
  | "BufWritePre"
  | "BufWritePost"
  | "InsertEnter"
  | "InsertLeave";

export interface VimAutocmd {
  group: string | null;
  event: VimAutocmdEvent;
  pattern: string;
  command: string;
}

export interface VimStatus {
  mode: VimMode;
  command: string;
  message: string;
  recordingRegister: string | null;
}

export interface VimEngineHooks {
  onStatus?: (status: VimStatus) => void;
  onOptionsChanged?: () => void;
  saveCurrentView?: () => void | Promise<void>;
  onQuit?: (force: boolean) => void | Promise<void>;
  onOpen?: (path: string) => void | Promise<void>;
  onSplit?: (vertical: boolean, path?: string) => void | Promise<void>;
  onObsidianCommand?: (id: string) => boolean | Promise<boolean>;
  onExternalCommand?: (command: string) => void | Promise<void>;
  readClipboard?: () => string;
  writeClipboard?: (text: string) => void;
  onError?: (message: string) => void;
}

export interface VimHandleResult {
  handled: boolean;
  mode: VimMode;
}
