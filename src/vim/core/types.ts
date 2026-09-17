import type { VimDocumentSnapshot } from "./document";

export type VimMode =
  | "normal"
  | "insert"
  | "replace"
  | "virtual-replace"
  | "select"
  | "select-line"
  | "select-block"
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
  readonly readOnly?: boolean;
  updateOptions?(options: Readonly<VimOptions>): void;
  text(from?: number, to?: number): string;
  documentSnapshot?(): VimDocumentSnapshot;
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
  displayLineMotion?(position: number, direction: -1 | 1, count: number): number;
  viewportMotion?(position: number, command: string, count: number): number;
  reindent?(from: number, to: number): readonly VimEdit[];
  fold?(position: number, command: string): void;
  highlightSearch?(ranges: readonly { from: number; to: number }[]): void;
}

export interface VimRegister {
  text: string;
  kind: VimRegisterKind;
  blockWidth?: number;
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
  clipboard: "" | "unnamed" | "unnamedplus" | "unnamed,unnamedplus";
  softtabstop: number;
  autoindent: boolean;
  textwidth: number;
  wrapscan: boolean;
  hlsearch: boolean;
  incsearch: boolean;
  magic: boolean;
  scrolloff: number;
  maxmapdepth: number;
  iskeyword: string;
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
  softtabstop: 0,
  // Existing o/O commands inherited indentation before this option was exposed.
  autoindent: true,
  textwidth: 0,
  wrapscan: true,
  hlsearch: false,
  incsearch: false,
  magic: true,
  scrolloff: 0,
  maxmapdepth: 1000,
  iskeyword: "@,48-57,_,192-255",
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
  mapleader?: string;
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
  onWindowCommand?: (command: string, count: number) => void | Promise<void>;
  onBufferCommand?: (command: string, argument?: string) => void | Promise<void>;
  onJumpToFile?: (bufferId: string, position: number) => void | Promise<void>;
  onObsidianCommand?: (id: string) => boolean | Promise<boolean>;
  onExternalCommand?: (command: string) => void | Promise<void>;
  readClipboard?: (register?: "+" | "*") => string;
  writeClipboard?: (text: string, register?: "+" | "*") => void;
  clipboard?: VimClipboard;
  onError?: (message: string) => void;
}

/** Clipboard transport is owned by the desktop host, never by the text core. */
export interface VimClipboard {
  read(register: "+" | "*"): VimRegister | Promise<VimRegister>;
  write(register: "+" | "*", value: VimRegister): void | Promise<void>;
}

export interface VimHandleResult {
  handled: boolean;
  mode: VimMode;
}
