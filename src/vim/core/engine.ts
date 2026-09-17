import {
  columnMotion,
  findCharacterMotion,
  horizontalMotion,
  lineBoundaryMotion,
  lineNumberMotion,
  matchingBracketMotion,
  paragraphMotion,
  sentenceMotion,
  verticalMotion,
  wordMotion,
  type VimMotion,
} from "./motions";
import { VimSession } from "./session";
import { applyVimOptions } from "./options";
import { clipboardFromHooks, clipboardWriteTargets, readVimRegister } from "./registers";
import { characterAt, characterStart, characters, countCharacters, iterateCharacters, displayWidth, moveCharacters, nextCharacter, offsetAtColumn, previousCharacter } from "./characters";
import { VimKeyTape, overrideRecordedCount } from "./key-tape";
import { snapshotVimDocument, StringVimDocument, type VimDocumentSnapshot } from "./document";
import { wordClass } from "./keywords";
import { blockGeometry } from "./block";
import { planLineTransfer } from "./lines";
import { sortVimLines } from "./sort";
import { compileVimPattern, escapeVimLiteral, findVimMatches, vimReplacement } from "./search";
import { delimited, parseExCommand, parseVimSubstitute, type ExRange, type SubstituteSpec } from "./ex";
import { textObjectRange } from "./text-objects";
import { VimExecutionQueue } from "./execution";
import { tokenizeVimKeys } from "./keys";
import { parseVimrc } from "../vimrc/parser";
import { compileVimRuntime } from "../vimrc/runtime";
import {
  DEFAULT_VIM_OPTIONS,
  type VimAutocmdEvent,
  type VimBuffer,
  type VimEngineHooks,
  type VimEdit,
  type VimHandleResult,
  type VimMapping,
  type VimMode,
  type VimRegisterKind,
  type VimRegister,
  type VimClipboard,
  type VimRuntimeConfig,
  type VimSelection,
  type VimStatus,
  type VimTextInputTarget,
  type VimVisualSnapshot,
} from "./types";

type OperatorName =
  | "delete"
  | "change"
  | "yank"
  | "indent"
  | "outdent"
  | "format"
  | "reflow"
  | "swapcase"
  | "lowercase"
  | "uppercase";

interface PendingOperator {
  name: OperatorName;
  count: number;
  countExplicit: boolean;
  keys: string[];
}

interface VimCount {
  value: number;
  explicit: boolean;
}

interface PendingFind {
  direction: -1 | 1;
  till: boolean;
}

interface LastFind extends PendingFind {
  character: string;
}

interface JumpEntry {
  position: number;
}

const EMPTY_RUNTIME: VimRuntimeConfig = {
  options: { ...DEFAULT_VIM_OPTIONS },
  mappings: [],
  abbreviations: [],
  exCommands: new Map(),
  autocmds: [],
};

/**
 * Independently authored Vim state machine. It knows only the VimBuffer port;
 * CodeMirror and Obsidian behavior live in separate adapters.
 */
export class VimEngine {
  private modeValue: VimMode = "normal";
  private countDigits = "";
  private activeRegister = '"';
  private pendingOperator: PendingOperator | null = null;
  private pendingPrefix = "";
  private pendingFind: PendingFind | null = null;
  private lastFind: LastFind | null = null;
  private pendingTextObject: "inside" | "around" | null = null;
  private pendingReplace = false;
  private pendingRegister = false;
  private pendingMarkSet = false;
  private pendingMarkJump: "line" | "exact" | null = null;
  private pendingMacro: "record" | "play" | null = null;
  private recordingRegister: string | null = null;
  private recordedMacro = new VimKeyTape();
  private mappingBuffer: string[] = [];
  private insertMappingBuffer: string[] = [];
  private mappingDepth = 0;
  private desiredColumn: number | undefined;
  private visualAnchor = 0;
  private visualHead = 0;
  private commandPrefix: ":" | "/" | "?" = ":";
  private commandBuffer = "";
  private message = "";
  private get searchPattern(): string { return this.session.searchPattern; }
  private set searchPattern(value: string) { this.session.searchPattern = value; }
  private get searchDirection(): -1 | 1 { return this.session.searchDirection; }
  private set searchDirection(value: -1 | 1) { this.session.searchDirection = value; }
  private get marks(): Map<string, number> { return this.session.marksFor(this.buffer.id); }
  private readonly jumps: JumpEntry[] = [];
  private jumpIndex = -1;
  private lastChange = new VimKeyTape();
  private currentChange: VimKeyTape | null = null;
  private replayingChange = false;
  private lastInsertedText = "";
  private insertExitCursorOnEmpty: number | null = null;
  private externalCommandsAllowed = false;
  private insertMappingsAllowed = true;
  private autocmdTail: Promise<void> = Promise.resolve();
  private autocmdDepth = 0;
  private readonly queuedAutocmds = new Set<string>();
  private disposed = false;
  private readonly clipboard: VimClipboard | undefined;
  private pendingRead: Promise<void> | null = null;
  private readonly pendingWrites = new Set<Promise<void>>();
  private operationGeneration = 0;
  private readonly queuedKeys: string[] = [];
  private commandKeys: string[] = [];
  private insertCount = 1;
  private insertCommand = "i";
  private temporaryNormal: { mode: "insert" | "replace"; virtual: boolean } | null = null;
  private replaceUndo: Array<{ at: number; after: number; inserted: string; removed: string }> = [];
  private searchStart = 0;
  private searchCount = 1;
  private historyIndex = -1;
  private lastSubstitute: SubstituteSpec | null = null;
  private confirmation: { edits: VimEdit[]; index: number; offset: number; expected: string } | null = null;
  private previousVisual: VimVisualSnapshot | null = null;
  private readonly changes: number[] = [];
  private readonly exLineAnchors = new Set<{ position: number | null }>();
  private exBatchCount = 0;
  private changeIndex = -1;
  private readonly playback: VimExecutionQueue;
  private playbackInput = false;
  private revision = 0;
  private observedDocument: VimDocumentSnapshot | null;
  private readonly observedBufferId: string;
  private readonly abbreviations = new Map<string, string>();
  private longestAbbreviation = 0;
  private errorSequence = 0;
  private readonly subscribers = new Set<(status: VimStatus) => void>();
  private selectMode = false;
  private virtualReplace = false;
  private blockInsertion = false;
  private blockInsertionOrigin: number | null = null;

  constructor(
    private readonly buffer: VimBuffer,
    private runtime: VimRuntimeConfig = EMPTY_RUNTIME,
    private readonly session = new VimSession(),
    private readonly hooks: VimEngineHooks = {},
  ) {
    this.runtime = cloneRuntime(runtime);
    this.rebuildAbbreviations();
    this.buffer.updateOptions?.(this.runtime.options);
    this.observedBufferId = this.buffer.id;
    this.observedDocument = snapshotVimDocument(this.buffer);
    this.session.retainBuffer(this.observedBufferId, this.observedDocument);
    this.clipboard = clipboardFromHooks(hooks);
    this.playback = new VimExecutionQueue((entry) => {
      const depth = this.mappingDepth;
      this.mappingDepth = entry.mappingDepth;
      try { this.replayMacroKey(entry.key, entry.remap); return this.pendingRead ?? undefined; }
      finally { this.mappingDepth = depth; }
    }, (message) => { this.reportError(message); this.finishChange(false); this.pendingOperator = null; this.resetCommandState(); });
    this.emitStatus();
  }

  get mode(): VimMode {
    if (this.selectMode && this.isVisualMode()) return this.modeValue === "visual-block" ? "select-block" : this.modeValue === "visual-line" ? "select-line" : "select";
    if (this.virtualReplace && this.modeValue === "replace") return "virtual-replace";
    return this.modeValue;
  }

  get status(): VimStatus {
    return {
      mode: this.mode,
      command: this.modeValue === "command-line"
        ? `${this.commandPrefix}${this.commandBuffer}`
        : this.pendingDisplay(),
      message: this.message,
      recordingRegister: this.recordingRegister,
    };
  }

  get options() {
    return { ...this.runtime.options };
  }

  setRuntime(runtime: VimRuntimeConfig): void {
    this.runtime = cloneRuntime(runtime);
    this.rebuildAbbreviations();
    this.buffer.updateOptions?.(this.runtime.options);
    this.mappingBuffer = [];
    this.insertMappingBuffer = [];
    this.emitStatus();
  }

  setExternalCommandsAllowed(allowed: boolean): void {
    this.externalCommandsAllowed = allowed;
  }

  setInsertMappingsAllowed(allowed: boolean): void {
    this.insertMappingsAllowed = allowed;
    if (!allowed) this.insertMappingBuffer = [];
  }

  handleKey(key: string): VimHandleResult {
    if (!key || this.disposed) return this.result(false);
    if (this.recordingRegister && (key !== "q" || this.modeValue !== "normal")) this.recordedMacro.push(key);
    if (this.pendingRead || this.playback.busy) {
      if (key === "<Esc>" || key === "<C-c>") {
        this.operationGeneration += 1;
        this.queuedKeys.length = 0;
        this.pendingRead = null;
        this.playback.cancel();
        this.resetCommandState();
        if (this.modeValue === "insert" || this.modeValue === "replace") this.handleInsertKey("<Esc>");
        else if (this.isVisualMode()) this.exitVisual();
      } else this.queuedKeys.push(key);
      return this.result(true);
    }
    try {
      if (this.modeValue !== "insert" || this.insertMappingsAllowed) {
        const mapped = this.resolveMapping(key);
        if (mapped !== null) return this.result(mapped);
      }
      return this.result(this.handleDirectKey(key));
    } catch (error) {
      this.reportError(errorMessage(error));
      this.finishChange(false);
      this.pendingOperator = null;
      this.resetCommandState();
      return this.result(true);
    }
  }

  get hasPendingMapping(): boolean {
    return this.mappingBuffer.length > 0 || this.insertMappingBuffer.length > 0;
  }

  get busy(): boolean { return this.pendingRead !== null || this.playback.busy; }

  async settled(): Promise<void> {
    do { await this.pendingRead; await this.playback.idle(); await Promise.all(this.pendingWrites); }
    while (!this.disposed && (this.busy || this.pendingWrites.size));
  }

  /** Programmatic commands use the same Ex parser and host hooks as keyboard input. */
  async executeCommand(command: string): Promise<{ ok: boolean; message: string }> {
    const errors = this.errorSequence;
    try {
      await this.executeEx(command);
      await this.settled();
      return { ok: errors === this.errorSequence, message: this.message };
    } catch (error) {
      this.reportError(errorMessage(error));
      return { ok: false, message: this.message };
    }
  }

  /** Detached snapshots and CAS edits are the internal entry points for future API adapters. */
  snapshot() {
    return { bufferId: this.buffer.id, revision: this.revision, text: this.buffer.text(), selections: this.buffer.selections(), status: this.status, options: this.options };
  }

  subscribe(listener: (status: VimStatus) => void): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  readRegister(name = '"'): VimRegister | Promise<VimRegister> {
    if (name === "=") throw new Error("Expression registers require a Vimscript evaluator.");
    if (["/", ".", ":", "%"].includes(name)) {
      return { text: name === "/" ? this.searchPattern : name === "." ? this.session.readRegister(".").text : name === ":" ? this.session.commandHistory[0] ?? "" : this.buffer.id, kind: "character" };
    }
    return readVimRegister(name, this.session, this.runtime.options, this.clipboard);
  }

  updateText(edits: readonly VimEdit[], expectedRevision: number): { ok: boolean; revision: number; message?: string } {
    if (expectedRevision !== this.revision || this.disposed || this.busy) return { ok: false, revision: this.revision, message: "Buffer revision changed, editor is busy, or editor was disposed." };
    const ordered = [...edits].sort((a, b) => a.from - b.from);
    if (ordered.some((edit, index) => !Number.isInteger(edit.from) || !Number.isInteger(edit.to) || edit.from < 0 || edit.from > edit.to || edit.to > this.buffer.length || index > 0 && ordered[index - 1].to > edit.from)) {
      return { ok: false, revision: this.revision, message: "Invalid edit range." };
    }
    if (ordered.some((edit) => characterStart(this.buffer.text(), edit.from) !== edit.from || characterStart(this.buffer.text(), edit.to) !== edit.to)) {
      return { ok: false, revision: this.revision, message: "Edit range splits a character." };
    }
    try { this.beginChange([]); this.apply(ordered); this.finishChange(false); return { ok: true, revision: this.revision }; }
    catch (error) { this.finishChange(false); return { ok: false, revision: this.revision, message: errorMessage(error) }; }
  }

  get awaitingInsertKey(): boolean {
    return (this.modeValue === "insert" || this.modeValue === "replace") &&
      this.pendingRegister;
  }

  get textInputTarget(): VimTextInputTarget {
    if (this.selectMode && this.isVisualMode()) return "replace";
    if (this.modeValue === "insert") return "insert";
    if (this.modeValue === "replace") return "replace";
    if (this.modeValue === "command-line") return "command-line";
    return "discard";
  }

  flushPendingMapping(): void {
    if (this.mappingBuffer.length > 0) {
      const pending = [...this.mappingBuffer];
      this.mappingBuffer = [];
      const exact = this.runtime.mappings.find((mapping) =>
        mapping.modes.includes(this.modeValue) && arraysEqual(mapping.lhs, pending),
      );
      if (exact) this.executeMapping(exact);
      else for (const key of pending) this.handleDirectKey(key);
    }
    if (this.insertMappingBuffer.length > 0) {
      const pending = [...this.insertMappingBuffer];
      this.insertMappingBuffer = [];
      const exact = this.runtime.mappings.find((mapping) =>
        mapping.modes.includes("insert") && arraysEqual(mapping.lhs, pending),
      );
      if (exact) this.executeMapping(exact);
      else this.insertLiteral(pending.join(""));
    }
  }

  /** Called by the CodeMirror input handler after Latex Suite declined input. */
  handleInsertInput(text: string): boolean {
    if (this.disposed) return false;
    if (this.busy && !this.playbackInput) {
      for (const token of iterateCharacters(text)) this.queuedKeys.push(token);
      if (this.recordingRegister) this.recordedMacro.appendText(text);
      return true;
    }
    if (this.selectMode && this.isVisualMode()) { this.replaceSelect(text); return true; }
    if (this.modeValue === "replace") {
      if (this.recordingRegister && !this.playbackInput) this.recordedMacro.appendText(text);
      this.replaceInput(text);
      return true;
    }
    if (this.modeValue !== "insert" || text.length === 0) return false;
    if (this.blockInsertion) {
      this.insertLiteral(text);
      if (this.recordingRegister && !this.playbackInput) this.recordedMacro.appendText(text);
      return true;
    }
    if (!this.insertMappingsAllowed) return false;

    const tokens = [...text];
    let handled = false;
    for (const token of tokens) {
      const mappingResult = this.resolveInsertMapping(token);
      if (mappingResult !== null) {
        handled = mappingResult || handled;
        continue;
      }
      const abbreviation = this.expandAbbreviation(token);
      handled = abbreviation || handled;
      if (abbreviation) continue;
      if (handled || this.insertMappingBuffer.length > 0) {
        this.insertLiteral(token);
        handled = true;
      }
    }
    if (handled && this.recordingRegister && !this.playbackInput) this.recordedMacro.append(tokens);
    return handled;
  }

  /** Records text inserted by CodeMirror's native input path for dot-repeat. */
  noteNativeInsert(text: string): void {
    if (this.modeValue !== "insert" || !text) return;
    if (this.recordingRegister) this.recordedMacro.appendText(text);
    this.lastInsertedText += text;
    this.currentChange?.appendText(text);
  }

  /** Record actual host edits, including deletion and caret movement, for repeat and macros. */
  noteNativeEdit(before: string | VimDocumentSnapshot, from: number, to: number, inserted: string, cursorBefore: number, cursorAfter: number): void {
    if (this.modeValue !== "insert") return;
    if (from === to && from === cursorBefore) { this.noteNativeInsert(inserted); return; }
    const document = typeof before === "string" ? new StringVimDocument(before) : before;
    const keys = new VimKeyTape();
    const removed = document.text(from, to);
    const movement = countCharacters(document.text(Math.min(from, cursorBefore), Math.max(from, cursorBefore)));
    keys.repeat(from < cursorBefore ? "<Left>" : "<Right>", movement);
    keys.repeat("<Del>", countCharacters(removed));
    keys.appendText(inserted);
    const at = from + inserted.length;
    const tail = countCharacters(this.buffer.text(Math.min(at, cursorAfter), Math.max(at, cursorAfter)));
    keys.repeat(cursorAfter < at ? "<Left>" : "<Right>", tail);
    this.currentChange?.append(keys);
    if (this.recordingRegister) this.recordedMacro.append(keys);
    if (to === cursorBefore && this.lastInsertedText.endsWith(removed)) {
      this.lastInsertedText = this.lastInsertedText.slice(0, this.lastInsertedText.length - (to - from)) + inserted;
    } else this.insertCount = 1;
  }

  /** Commits final IME text without passing it through mappings or abbreviations. */
  commitComposedText(text: string): boolean {
    if (!text) return false;
    if (this.selectMode && this.isVisualMode()) { this.replaceSelect(text); return true; }
    if (this.modeValue === "insert") {
      this.noteNativeInsert(text);
      return true;
    }
    if (this.modeValue === "replace") {
      if (this.recordingRegister) this.recordedMacro.appendText(text);
      this.replaceInput(text);
      return true;
    }
    if (this.modeValue === "command-line") {
      this.commandBuffer += text;
      this.emitStatus();
      return true;
    }
    return false;
  }

  runAutocmd(event: VimAutocmdEvent, fileName: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const eventKey = `${event}\0${fileName}`;
    if (this.queuedAutocmds.has(eventKey)) return Promise.resolve(false);
    this.queuedAutocmds.add(eventKey);
    const run = async (): Promise<void> => {
      if (this.disposed) return;
      this.autocmdDepth += 1;
      try {
        for (const autocmd of this.runtime.autocmds) {
          if (autocmd.event !== event || !globMatches(autocmd.pattern, fileName)) continue;
          await this.executeEx(autocmd.command);
        }
      } finally {
        this.autocmdDepth -= 1;
        this.queuedAutocmds.delete(eventKey);
      }
    };
    const result = this.autocmdTail.then(run, run).then(
      () => true,
      (error: unknown) => {
        this.reportError(errorMessage(error));
        return false;
      },
    );
    this.autocmdTail = result.then(() => undefined);
    return result;
  }

  /** Converts a completed pointer range into the engine-owned Visual snapshot. */
  syncExternalSelection(): void {
    const selection = this.buffer.selections()[0];
    this.pendingOperator = null;
    this.pendingTextObject = null;
    if (selection && selection.anchor !== selection.head) {
      const text = this.buffer.text();
      if (selection.anchor < selection.head) {
        this.visualAnchor = selection.anchor;
        this.visualHead = previousCharacterPosition(text, selection.head);
      } else {
        this.visualAnchor = previousCharacterPosition(text, selection.anchor);
        this.visualHead = selection.head;
      }
      this.modeValue = "visual";
      this.resetCommandState();
      this.updateVisualSelections();
    } else {
      this.modeValue = "normal";
      this.resetCommandState();
      this.buffer.clearVisual();
      this.emitStatus();
    }
  }

  /** Gives a host-driven caret jump explicit ownership and leaves Visual mode. */
  adoptExternalCaret(position: number): void {
    this.pendingOperator = null;
    this.pendingTextObject = null;
    this.visualAnchor = position;
    this.visualHead = position;
    this.modeValue = "normal";
    this.resetCommandState();
    this.buffer.clearVisual();
    this.emitStatus();
  }

  visualSnapshot(): VimVisualSnapshot | null {
    return this.isVisualMode() ? this.createVisualSnapshot() : null;
  }

  visualSelectionText(): string | null {
    const snapshot = this.visualSnapshot();
    if (!snapshot) return null;
    return snapshot.ranges.map((range) => this.buffer.text(
      Math.min(range.anchor, range.head),
      Math.max(range.anchor, range.head),
    )).join(snapshot.mode === "visual-block" ? "\n" : "");
  }

  copyVisualToClipboard(): string | null {
    const text = this.visualSelectionText();
    if (text === null) return null;
    this.writeSystemClipboard("+", this.visualRegister(text));
    return text;
  }

  cutVisualToClipboard(): string | null {
    const text = this.visualSelectionText();
    if (text === null) return null;
    this.writeSystemClipboard("+", this.visualRegister(text));
    this.applyVisualOperator("delete", ["<C-x>"]);
    return text;
  }

  /** Keeps stored document positions valid across Vim and host transactions. */
  mapDocumentPositions(mapper: (position: number) => number): void {
    if (this.disposed || !this.observedDocument) return;
    this.revision += 1;
    const map = (position: number) => clamp(mapper(position), 0, this.buffer.length);
    for (const anchor of this.exLineAnchors) if (anchor.position !== null) anchor.position = map(anchor.position);
    const document = snapshotVimDocument(this.buffer);
    this.session.mapBufferMarks(this.observedBufferId, this.observedDocument, document, map);
    this.observedDocument = document;
    if (this.previousVisual) {
      this.previousVisual = { ...this.previousVisual, anchor: map(this.previousVisual.anchor), head: map(this.previousVisual.head), activePosition: map(this.previousVisual.activePosition),
        ranges: this.previousVisual.ranges.map((range) => ({ anchor: map(range.anchor), head: map(range.head) })) };
    }
    for (const jump of this.jumps) jump.position = map(jump.position);
    for (let index = 0; index < this.changes.length; index += 1) this.changes[index] = map(this.changes[index]);
    this.visualAnchor = map(this.visualAnchor);
    this.visualHead = map(this.visualHead);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.releaseBuffer(this.observedBufferId);
    this.observedDocument = null;
    this.playback.cancel();
    this.subscribers.clear();
    this.operationGeneration += 1;
    this.queuedKeys.length = 0;
    this.mappingBuffer = [];
    this.insertMappingBuffer = [];
    this.pendingOperator = null;
    this.queuedAutocmds.clear();
    if (this.confirmation) { this.confirmation = null; this.buffer.endHistoryGroup(); }
    this.finishChange(false);
  }

  private handleDirectKey(key: string): boolean {
    const temporary = this.temporaryNormal;
    if (!this.replayingChange && this.modeValue !== "insert" && this.modeValue !== "replace" && this.modeValue !== "command-line") this.commandKeys.push(key);
    const handled = this.dispatchKey(key);
    if (this.modeValue === "normal" && !this.pendingPrefix && !this.pendingFind && !this.pendingRegister
      && !this.pendingMarkJump && !this.pendingMarkSet && !this.pendingMacro && !this.pendingReplace && !this.countDigits) {
      this.commandKeys = [];
      if (temporary && this.temporaryNormal === temporary) {
        this.temporaryNormal = null;
        this.virtualReplace = temporary.virtual;
        this.setMode(temporary.mode);
      }
    }
    return handled;
  }

  private dispatchKey(key: string): boolean {
    if (key === "<Nop>") return true;
    if (this.modeValue === "command-line") return this.handleCommandLineKey(key);
    if (this.modeValue === "insert" || this.modeValue === "replace") {
      return this.handleInsertKey(key);
    }
    if (this.isVisualMode()) {
      if (key === "<C-g>") { this.selectMode = !this.selectMode; this.emitStatus(); return true; }
      if (this.selectMode && (isLiteralTextToken(key) || key === "<CR>" || key === "<BS>" || key === "<Del>")) {
        this.replaceSelect(key === "<CR>" ? "\n" : key.startsWith("<") ? "" : key); return true;
      }
      return this.handleVisualKey(key);
    }
    if (this.modeValue === "operator-pending") return this.handleOperatorKey(key);
    return this.handleNormalKey(key);
  }

  private handleNormalKey(key: string): boolean {
    if (this.consumeAwaitingKey(key)) return true;
    if (/^[1-9]$/.test(key) || (key === "0" && this.countDigits.length > 0)) {
      this.countDigits += key;
      this.emitStatus();
      return true;
    }
    const count = this.takeCountState();
    if (["i", "a", "I", "A", "o", "O", "R"].includes(key)) {
      this.insertCount = count.value;
      this.insertCommand = key;
    }
    if (key === "z" || key === "<C-w>") {
      this.pendingPrefix = key;
      this.restoreCount(count);
      return true;
    }
    if (["<C-f>", "<C-b>", "<C-d>", "<C-u>", "<C-e>", "<C-y>", "<PageDown>", "<PageUp>"].includes(key)) {
      const target = this.buffer.viewportMotion?.(this.cursor(), key, count.value);
      if (target !== undefined && target !== this.cursor()) this.setCursor(target);
      return true;
    }
    if (key === "<C-a>" || key === "<C-x>") { this.changeNumber((key === "<C-a>" ? 1 : -1) * count.value); return true; }

    if (key === '"') {
      this.pendingRegister = true;
      this.emitStatus();
      return true;
    }
    if (key === "q") {
      if (this.recordingRegister) {
        this.session.setMacro(this.recordingRegister, this.recordedMacro);
        this.recordingRegister = null;
        this.recordedMacro = new VimKeyTape();
      } else {
        this.pendingMacro = "record";
      }
      this.emitStatus();
      return true;
    }
    if (key === "@") {
      this.pendingMacro = "play";
      this.restoreCount(count);
      this.emitStatus();
      return true;
    }
    if (key === "m") {
      this.pendingMarkSet = true;
      this.emitStatus();
      return true;
    }
    if (key === "'" || key === "`") {
      this.pendingMarkJump = key === "'" ? "line" : "exact";
      this.emitStatus();
      return true;
    }
    if (key === "g") {
      this.pendingPrefix = "g";
      this.restoreCount(count);
      this.emitStatus();
      return true;
    }
    if ("fFtT".includes(key)) {
      this.pendingFind = {
        direction: key === "f" || key === "t" ? 1 : -1,
        till: key === "t" || key === "T",
      };
      this.restoreCount(count);
      this.emitStatus();
      return true;
    }
    if (key === "r") {
      this.pendingReplace = true;
      this.restoreCount(count);
      this.beginChange([key]);
      this.emitStatus();
      return true;
    }

    const motion = this.motionForKey(key, count.value, count.explicit);
    if (motion) {
      this.move(motion);
      this.resetCommandState();
      return true;
    }

    switch (key) {
      case "i":
        this.enterInsert(this.cursor(), [key]);
        return true;
      case "a":
        this.enterInsert(this.afterCursor(), [key]);
        return true;
      case "I": {
        const target = lineBoundaryMotion(this.buffer, this.cursor(), "first-nonblank").target;
        this.enterInsert(target, [key], true, target);
        return true;
      }
      case "A": {
        const line = this.buffer.lineAt(this.cursor());
        this.enterInsert(line.to, [key], true, Math.max(line.from, line.to - 1));
        return true;
      }
      case "o":
        this.openLine(1, [key]);
        return true;
      case "O":
        this.openLine(-1, [key]);
        return true;
      case "R":
        this.virtualReplace = false;
        this.beginChange([key]);
        this.lastInsertedText = "";
        this.replaceUndo = [];
        this.insertExitCursorOnEmpty = this.cursor();
        this.setMode("replace");
        return true;
      case "v":
        this.enterVisual("visual");
        return true;
      case "V":
        this.enterVisual("visual-line");
        return true;
      case "<C-v>":
      case "<C-q>":
        this.enterVisual("visual-block");
        return true;
      case "d":
        this.startOperator("delete", count.value, count.explicit, [key]);
        return true;
      case "c":
        this.startOperator("change", count.value, count.explicit, [key]);
        return true;
      case "y":
        this.startOperator("yank", count.value, count.explicit, [key]);
        return true;
      case ">":
        this.startOperator("indent", count.value, count.explicit, [key]);
        return true;
      case "<":
        this.startOperator("outdent", count.value, count.explicit, [key]);
        return true;
      case "=":
        this.startOperator("format", count.value, count.explicit, [key]);
        return true;
      case "x":
      case "<Del>":
        this.deleteCharacters(count.value, 1, [key]);
        return true;
      case "X":
        this.deleteCharacters(count.value, -1, [key]);
        return true;
      case "s":
        this.deleteCharacters(count.value, 1, [key], true);
        return true;
      case "S":
        this.applyLineOperator("change", count.value, [key]);
        return true;
      case "D":
        this.applyToLineEnd("delete", [key], count.value);
        return true;
      case "C":
        this.applyToLineEnd("change", [key], count.value);
        return true;
      case "Y":
        this.applyLineOperator("yank", count.value, [key]);
        return true;
      case "p":
      case "P":
        this.put(key === "p", count.value, [key]);
        return true;
      case "J":
        this.joinLines(count.value, [key]);
        return true;
      case "~":
        this.transformCharacters("swapcase", count.value, [key]);
        return true;
      case "&":
        this.runHostAction(this.executeEx("s"));
        return true;
      case "u":
        for (let index = 0; index < count.value; index += 1) if (!this.buffer.undo()) break;
        this.setCursor(this.cursor());
        return true;
      case "<C-r>":
        for (let index = 0; index < count.value; index += 1) if (!this.buffer.redo()) break;
        this.setCursor(this.cursor());
        return true;
      case ".":
        this.repeatLastChange(count.value, count.explicit);
        return true;
      case ":":
      case "/":
      case "?":
        this.searchCount = count.value;
        this.enterCommandLine(key);
        return true;
      case "*":
      case "#":
        this.searchWord(key === "*" ? 1 : -1, count.value, true);
        return true;
      case "n":
      case "N":
        this.repeatSearch(key === "n" ? this.searchDirection : opposite(this.searchDirection), count.value);
        return true;
      case ";":
      case ",":
        this.repeatFind(key === ";" ? 1 : -1, count.value);
        return true;
      case "<C-o>":
        this.navigateJump(-1, count.value);
        return true;
      case "<C-i>":
        this.navigateJump(1, count.value);
        return true;
      case "<Esc>":
        this.resetCommandState();
        return true;
      default:
        this.resetCommandState();
        return false;
    }
  }

  private handleOperatorKey(key: string): boolean {
    const operator = this.pendingOperator;
    if (!operator) {
      this.setMode("normal");
      return false;
    }
    if (this.consumeAwaitingKey(key)) return true;
    if (/^[1-9]$/.test(key) || (key === "0" && this.countDigits.length > 0)) {
      this.countDigits += key;
      this.emitStatus();
      return true;
    }
    if (key === "<Esc>") {
      this.cancelOperator();
      return true;
    }
    if (key === "/" || key === "?") {
      this.searchCount = operator.count * this.takeCount();
      this.enterCommandLine(key);
      return true;
    }
    if (this.pendingTextObject) {
      const motionCount = this.takeCountState();
      const object = textObjectRange(
        this.buffer,
        this.cursor(),
        key,
        this.pendingTextObject === "around",
        operator.count * motionCount.value,
        this.runtime.options.iskeyword,
      );
      if (object) {
        this.applyOperatorRange(
          operator.name,
          object.from,
          object.to,
          object.linewise,
          operator.keys.concat(key),
        );
      } else this.cancelOperator();
      return true;
    }
    if (key === '"') {
      this.pendingRegister = true;
      return true;
    }
    if (key === "i" || key === "a") {
      this.pendingTextObject = key === "i" ? "inside" : "around";
      this.emitStatus();
      return true;
    }
    if (key === "g") {
      this.pendingPrefix = "g";
      this.emitStatus();
      return true;
    }
    if ("fFtT".includes(key)) {
      this.pendingFind = {
        direction: key === "f" || key === "t" ? 1 : -1,
        till: key === "t" || key === "T",
      };
      this.pendingPrefix = key;
      this.emitStatus();
      return true;
    }
    const doubled = operatorKey(operator.name);
    if (key === doubled || (operator.name === "reflow" && key === "q") || (operator.name === "lowercase" && key === "u") || (operator.name === "uppercase" && key === "U")) {
      this.applyLineOperator(operator.name, operator.count * this.takeCount(), operator.keys.concat(key));
      return true;
    }
    const followingCount = this.takeCountState();
    const motionCount = operator.count * followingCount.value;
    const changeWord = operator.name === "change" && (key === "w" || key === "W") && /\S/u.test(this.buffer.text(this.cursor(), nextCharacter(this.buffer.text(), this.cursor())));
    const motion = changeWord ? wordMotion(this.buffer, this.cursor(), "end", motionCount, key === "W", this.runtime.options.iskeyword, true) : this.motionForKey(
      key,
      motionCount,
      operator.countExplicit || followingCount.explicit,
    );
    if (motion) {
      const range = this.rangeForMotion(this.cursor(), motion);
      // w/W stop at the preceding line's end when the final word motion crosses
      // an end-of-line. The line break belongs to neither that word nor its put.
      if (!changeWord && (key === "w" || key === "W") && motion.target > this.cursor()) {
        const targetLine = this.buffer.lineAt(motion.target);
        if (targetLine.number > this.buffer.lineAt(this.cursor()).number && motion.target === targetLine.from) range.to = this.buffer.line(targetLine.number - 1).to;
      }
      this.applyOperatorRange(operator.name, range.from, range.to, motion.linewise, operator.keys.concat(key));
      return true;
    }
    this.cancelOperator();
    return false;
  }

  private handleVisualKey(key: string): boolean {
    if (this.consumeAwaitingKey(key)) return true;
    if (/^[1-9]$/.test(key) || (key === "0" && this.countDigits.length > 0)) {
      this.countDigits += key;
      this.emitStatus();
      return true;
    }
    const count = this.takeCountState();
    if (key === ":") {
      this.rememberVisual(); this.enterCommandLine(":"); this.commandBuffer = "'<,'>"; this.emitStatus(); return true;
    }
    if (key === '"') { this.pendingRegister = true; return true; }
    if (key === "<Esc>") {
      this.exitVisual();
      return true;
    }
    if (key === "o" || key === "O") {
      [this.visualAnchor, this.visualHead] = [this.visualHead, this.visualAnchor];
      this.updateVisualSelections();
      return true;
    }
    if (key === "v" || key === "V" || key === "<C-v>" || key === "<C-q>") {
      const targetMode: VimMode = key === "V"
        ? "visual-line"
        : key === "v"
          ? "visual"
          : "visual-block";
      if (targetMode === this.modeValue) this.exitVisual();
      else {
        this.modeValue = targetMode;
        this.updateVisualSelections();
      }
      return true;
    }
    if (key === "g") {
      this.pendingPrefix = "g";
      this.restoreCount(count);
      this.emitStatus();
      return true;
    }
    if (key === "i" || key === "a") {
      this.pendingTextObject = key === "i" ? "inside" : "around";
      this.emitStatus();
      return true;
    }
    if (this.pendingTextObject) {
      const object = textObjectRange(
        this.buffer,
        this.visualHead,
        key,
        this.pendingTextObject === "around",
        count.value,
        this.runtime.options.iskeyword,
      );
      this.pendingTextObject = null;
      if (object) {
        this.visualAnchor = object.from;
        this.visualHead = previousCharacterPosition(this.buffer.text(), object.to);
        this.updateVisualSelections();
      } else {
        this.emitStatus();
      }
      return true;
    }
    if ("fFtT".includes(key)) {
      this.pendingFind = {
        direction: key === "f" || key === "t" ? 1 : -1,
        till: key === "t" || key === "T",
      };
      this.restoreCount(count);
      this.emitStatus();
      return true;
    }
    const motion = this.motionForKey(key, count.value, count.explicit);
    if (motion) {
      this.visualHead = motion.target;
      this.updateVisualSelections();
      return true;
    }
    if (key === "I" && this.modeValue === "visual-block") {
      this.enterVisualBlockInsert(false, [key]);
      return true;
    }
    if (key === "r") { this.pendingReplace = true; this.beginChange([key]); return true; }
    if (key === "A" && this.modeValue === "visual-block") {
      this.enterVisualBlockInsert(true, [key]);
      return true;
    }
    if (["d", "x", "c", "y", ">", "<", "=", "~", "u", "U"].includes(key)) {
      const operation: OperatorName = key === "d" || key === "x"
        ? "delete"
        : key === "c"
          ? "change"
          : key === "y"
            ? "yank"
            : key === ">"
              ? "indent"
              : key === "<"
                ? "outdent"
                : key === "="
                  ? "format"
                  : key === "~"
                    ? "swapcase"
                    : key === "u"
                      ? "lowercase"
                      : "uppercase";
      this.applyVisualOperator(operation, [key]);
      return true;
    }
    if (key === "p" || key === "P") {
      this.replaceVisualWithRegister([key]);
      return true;
    }
    return false;
  }

  private handleInsertKey(key: string): boolean {
    if (key === "<Esc>" || key === "<C-[>") {
      const blockExit = this.blockInsertion ? this.blockInsertionOrigin : null;
      this.blockInsertion = false;
      this.blockInsertionOrigin = null;
      if (this.insertCount > 1 && this.lastInsertedText) {
        const text = this.lastInsertedText;
        const saved = this.currentChange?.clone() ?? null;
        for (let index = 1; index < this.insertCount; index += 1) {
          if (this.insertCommand === "o" || this.insertCommand === "O") this.insertLineBreak();
          if (this.modeValue === "replace") this.replaceInput(text);
          else for (const character of characters(text)) { if (character === "\n") this.insertLineBreak(); else this.insertLiteral(character); }
        }
        this.currentChange = saved;
      }
      this.insertCount = 1;
      if (blockExit !== null) {
        this.setCursor(blockExit);
      } else if (this.lastInsertedText.length === 0 && this.insertExitCursorOnEmpty !== null) {
        this.setCursor(this.insertExitCursorOnEmpty);
      } else {
        const line = this.buffer.lineAt(this.cursor());
        this.setCursor(Math.max(line.from, previousCharacter(this.buffer.text(), this.cursor())));
      }
      this.insertExitCursorOnEmpty = null;
      if (this.lastInsertedText) this.session.setRegister(".", { text: this.lastInsertedText, kind: "character" });
      this.setMode("normal");
      this.finishChange();
      this.queueAutocmd("InsertLeave");
      return true;
    }
    if (key === "<C-o>") {
      this.temporaryNormal = { mode: this.modeValue === "replace" ? "replace" : "insert", virtual: this.virtualReplace };
      this.setMode("normal");
      return true;
    }
    if (key === "<BS>" || key === "<C-h>") {
      const previous = this.replaceUndo.at(-1);
      if (this.modeValue === "replace" && previous && previous.after === this.cursor()) {
        this.replaceUndo.pop();
        this.apply([{ from: previous.at, to: previous.at + previous.inserted.length, insert: previous.removed }], [{ anchor: previous.at, head: previous.at }]);
      } else {
        const text = this.buffer.text();
        const edits = this.buffer.selections().map(({ head }) => ({
          from: this.blockInsertion ? Math.max(this.buffer.lineAt(head).from, previousCharacter(text, head)) : previousCharacter(text, head),
          to: head, insert: "",
        }));
        this.apply(edits, edits.map(({ from }) => { const at = mapPositionThroughEdits(from, edits); return { anchor: at, head: at }; }));
      }
      this.lastInsertedText = removeLastGrapheme(this.lastInsertedText);
      this.currentChange?.push("<BS>");
      return true;
    }
    if (key === "<Del>") {
      const cursor = this.cursor();
      this.apply([{ from: cursor, to: nextCharacter(this.buffer.text(), cursor), insert: "" }]);
      this.currentChange?.push(key);
      return true;
    }
    if (key === "<CR>") { this.insertLineBreak(); return true; }
    if (key === "<Tab>") {
      const width = this.runtime.options.softtabstop || this.runtime.options.tabstop;
      const resolved = width < 0 ? this.runtime.options.shiftwidth || this.runtime.options.tabstop : width;
      const column = displayWidth(this.buffer.text(this.buffer.lineAt(this.cursor()).from, this.cursor()), this.runtime.options.tabstop);
      this.insertLiteral(this.runtime.options.expandtab ? " ".repeat(resolved - column % resolved) : "\t");
      return true;
    }
    if (["<Left>", "<Right>", "<Up>", "<Down>", "<Home>", "<End>"].includes(key)) {
      const cursor = this.cursor();
      const target = key === "<Left>" ? previousCharacter(this.buffer.text(), cursor)
        : key === "<Right>" ? nextCharacter(this.buffer.text(), cursor)
          : key === "<Home>" ? this.buffer.lineAt(cursor).from : key === "<End>" ? this.buffer.lineAt(cursor).to
            : verticalMotion(this.buffer, cursor, key === "<Up>" ? -1 : 1, 1).target;
      this.setCursor(target, true);
      this.currentChange?.push(key);
      this.insertCount = 1;
      return true;
    }
    if (key === "<C-w>") {
      const cursor = this.cursor();
      const motion = wordMotion(this.buffer, cursor, "backward", 1, false, this.runtime.options.iskeyword);
      this.removeInsertedSuffix(this.buffer.text(motion.target, cursor));
      this.apply([{ from: motion.target, to: cursor, insert: "" }], [{ anchor: motion.target, head: motion.target }]);
      this.currentChange?.push(key);
      return true;
    }
    if (key === "<C-u>") {
      const cursor = this.cursor();
      const from = this.buffer.lineAt(cursor).from;
      this.removeInsertedSuffix(this.buffer.text(from, cursor));
      this.apply([{ from, to: cursor, insert: "" }], [{ anchor: from, head: from }]);
      this.currentChange?.push(key);
      return true;
    }
    if (key === "<C-r>") {
      this.pendingRegister = true;
      return true;
    }
    if (this.pendingRegister) {
      this.pendingRegister = false;
      this.withRegister(key, (value) => this.insertLiteral(value.text));
      return true;
    }
    return false;
  }

  private handleCommandLineKey(key: string): boolean {
    if (this.confirmation) return this.confirmSubstitute(key);
    if (key === "<Esc>" || key === "<C-c>") {
      this.commandBuffer = "";
      if (this.commandPrefix !== ":") { this.setCursor(this.searchStart); this.restoreSearchHighlight(); }
      this.pendingOperator = null;
      this.setMode("normal");
      return true;
    }
    if (key === "<Up>" || key === "<Down>") {
      const history = this.commandPrefix === ":" ? this.session.commandHistory : this.session.searchHistory;
      this.historyIndex = clamp(this.historyIndex + (key === "<Up>" ? 1 : -1), -1, history.length - 1);
      this.commandBuffer = history[this.historyIndex] ?? "";
      this.previewSearch();
      this.emitStatus();
      return true;
    }
    if (key === "<BS>") {
      if (this.commandBuffer.length === 0) {
        if (this.commandPrefix !== ":") { this.setCursor(this.searchStart); this.restoreSearchHighlight(); }
        this.setMode("normal");
      } else {
        this.commandBuffer = removeLastGrapheme(this.commandBuffer);
        this.previewSearch();
        this.emitStatus();
      }
      return true;
    }
    if (key === "<CR>" || key === "Enter") {
      const command = this.commandBuffer;
      const prefix = this.commandPrefix;
      this.commandBuffer = "";
      this.setMode("normal");
      if (command) {
        const history = prefix === ":" ? this.session.commandHistory : this.session.searchHistory;
        if (history[0] !== command) history.unshift(command);
        history.length = Math.min(history.length, 100);
      }
      if (prefix === ":") {
        void this.executeEx(command).catch((error: unknown) => {
          this.reportError(errorMessage(error));
        });
      }
      else this.executeSearch(command, prefix === "/" ? 1 : -1);
      return true;
    }
    if (isLiteralTextToken(key)) {
      this.commandBuffer += key;
      this.previewSearch();
      this.emitStatus();
      return true;
    }
    return true;
  }

  private consumeAwaitingKey(key: string): boolean {
    if (this.pendingPrefix === "z") {
      this.pendingPrefix = "";
      const command = `z${key}`;
      if (["zt", "zz", "zb"].includes(command)) this.buffer.viewportMotion?.(this.cursor(), command, this.takeCount());
      else if (["za", "zo", "zO", "zc", "zC", "zM", "zR"].includes(command)) this.buffer.fold?.(this.cursor(), command);
      else this.reportError(`Unsupported fold/scroll command: ${command}`);
      return true;
    }
    if (this.pendingPrefix === "<C-w>") {
      this.pendingPrefix = "";
      this.runHostAction(this.hooks.onWindowCommand?.(key, this.takeCount()));
      return true;
    }
    if (this.pendingRegister) {
      this.activeRegister = key[0] ?? '"';
      this.pendingRegister = false;
      this.emitStatus();
      return true;
    }
    if (this.pendingMarkSet) {
      this.marks.set(key[0] ?? "", this.cursor());
      if (/^[A-Z]$/u.test(key)) this.session.fileMarks.set(key, { bufferId: this.buffer.id, position: this.cursor() });
      this.pendingMarkSet = false;
      this.emitStatus();
      return true;
    }
    if (this.pendingMarkJump) {
      const fileMark = this.session.fileMarks.get(key);
      if (fileMark && fileMark.bufferId !== this.buffer.id) {
        this.pendingMarkJump = null;
        this.runHostAction(this.hooks.onJumpToFile?.(fileMark.bufferId, fileMark.position));
        return true;
      }
      const position = this.marks.get(key[0] ?? "");
      const kind = this.pendingMarkJump;
      this.pendingMarkJump = null;
      if (position !== undefined) {
        const target = kind === "line"
          ? lineBoundaryMotion(this.buffer, position, "first-nonblank").target
          : position;
        this.recordJump(target);
        this.setCursor(target);
      }
      return true;
    }
    if (this.pendingMacro) {
      const operation = this.pendingMacro;
      this.pendingMacro = null;
      if (operation === "record") {
        this.recordingRegister = key[0] ?? "q";
        this.recordedMacro = new VimKeyTape();
      } else {
        const count = this.takeCount();
        const macro = this.session.readMacroSequence(key);
        this.commandKeys = [];
        this.playback.enqueue(macro, count);
        if (this.playback.busy) void this.playback.idle().then(() => this.flushQueuedKeys());
      }
      this.emitStatus();
      return true;
    }
    if (this.pendingReplace) {
      const count = this.takeCount();
      this.pendingReplace = false;
      if (key === "<Esc>") {
        this.finishChange(false);
        return true;
      }
      if (this.isVisualMode()) this.replaceVisualCharacters(key);
      else this.replaceCharacters(key, count);
      return true;
    }
    if (this.pendingFind) {
      const pending = this.pendingFind;
      this.pendingFind = null;
      const count = this.takeCount();
      const motion = findCharacterMotion(
        this.buffer,
        this.isVisualMode() ? this.visualHead : this.cursor(),
        key,
        pending.direction,
        count,
        pending.till,
      );
      if (motion) {
        this.lastFind = { ...pending, character: key };
        if (this.modeValue === "operator-pending" && this.pendingOperator) {
          const range = this.rangeForMotion(this.cursor(), motion);
          this.applyOperatorRange(
            this.pendingOperator.name,
            range.from,
            range.to,
            false,
            this.pendingOperator.keys.concat(this.pendingPrefix, key),
          );
        } else if (this.isVisualMode()) {
          this.visualHead = motion.target;
          this.updateVisualSelections();
        } else {
          this.move(motion);
        }
      } else if (this.modeValue === "operator-pending") {
        this.cancelOperator();
      }
      this.pendingPrefix = "";
      return true;
    }
    if (this.pendingPrefix === "g") {
      const count = this.takeCountState();
      this.pendingPrefix = "";
      if (key === "*" || key === "#") { this.searchWord(key === "*" ? 1 : -1, count.value, false); return true; }
      if (key === "h" || key === "H" || key === "<C-h>") {
        this.enterVisual(key === "H" ? "visual-line" : key === "<C-h>" ? "visual-block" : "visual");
        this.selectMode = true; this.emitStatus(); return true;
      }
      if (key === "R") {
        this.insertCount = count.value;
        this.insertCommand = "gR";
        this.virtualReplace = true; this.beginChange(["g", "R"]); this.lastInsertedText = "";
        this.replaceUndo = []; this.insertExitCursorOnEmpty = this.cursor(); this.setMode("replace"); return true;
      }
      if (key === ";" || key === ",") {
        this.changeIndex = clamp(this.changeIndex + (key === ";" ? -1 : 1) * count.value, 0, this.changes.length - 1);
        const position = this.changes[this.changeIndex];
        if (position !== undefined) this.setCursor(position);
        return true;
      }
      if (key === "v" && this.previousVisual) {
        const snapshot = this.previousVisual;
        this.modeValue = snapshot.mode;
        this.visualAnchor = snapshot.anchor;
        this.visualHead = snapshot.head;
        this.updateVisualSelections();
        return true;
      }
      if (key === "n" || key === "N") {
        if (!this.searchPattern) throw new Error("E35: No previous regular expression");
        const matches = findVimMatches(this.buffer.text(), this.searchPattern, this.runtime.options);
        if (!matches.length) throw new Error(`E486: Pattern not found: ${this.searchPattern}`);
        const extending = this.isVisualMode();
        const direction = key === "n" ? 1 : -1;
        const cursor = extending ? this.visualHead : this.cursor();
        const position = extending ? moveCharacters(this.buffer.text(), cursor, direction) : cursor;
        let index = direction > 0 ? matches.findIndex((entry) => entry.to > position || entry.from === position && entry.to === position)
          : matches.findLastIndex((entry) => entry.from <= position);
        const repetitions = count.value * (this.pendingOperator?.count ?? 1);
        if (index < 0) index = direction > 0 ? matches.length : -1;
        index += direction * (repetitions - 1);
        if (!this.runtime.options.wrapscan && (index < 0 || index >= matches.length)) throw new Error("Search reached the end of the buffer.");
        index = ((index % matches.length) + matches.length) % matches.length;
        const match = matches[index];
        if (match) {
          const end = match.to > match.from ? previousCharacter(this.buffer.text(), match.to) : match.from;
          if (this.pendingOperator) this.applyOperatorRange(this.pendingOperator.name, match.from, nextCharacter(this.buffer.text(), end), false, ["g", key]);
          else {
            this.modeValue = "visual";
            if (!extending) this.visualAnchor = direction > 0 ? match.from : end;
            this.visualHead = direction > 0 ? end : match.from;
            this.updateVisualSelections();
          }
        }
        return true;
      }
      if (key === "p" || key === "P") { this.put(key === "p", count.value, ["g", key], true); return true; }
      if (key === "g") {
        const motion = lineNumberMotion(this.buffer, count.explicit ? count.value : 1);
        if (this.isVisualMode()) {
          this.visualHead = motion.target;
          this.updateVisualSelections();
        } else if (this.modeValue === "operator-pending" && this.pendingOperator) {
          const range = this.rangeForMotion(this.cursor(), motion);
          this.applyOperatorRange(this.pendingOperator.name, range.from, range.to, true, this.pendingOperator.keys.concat("g", "g"));
        } else this.move(motion);
        return true;
      }
      if (key === "e" || key === "E") {
        const target = previousWordEnd(this.buffer.text(), this.isVisualMode() ? this.visualHead : this.cursor(), key === "E", count.value, this.runtime.options.iskeyword);
        const motion: VimMotion = { target, inclusive: true, linewise: false };
        if (this.isVisualMode()) {
          this.visualHead = target;
          this.updateVisualSelections();
        } else if (this.modeValue === "operator-pending" && this.pendingOperator) {
          const range = this.rangeForMotion(this.cursor(), motion);
          this.applyOperatorRange(this.pendingOperator.name, range.from, range.to, false, this.pendingOperator.keys.concat("g", key));
        } else this.move(motion);
        return true;
      }
      if (key === "_") {
        const motion = lineBoundaryMotion(this.buffer, this.cursor(), "last-nonblank");
        if (this.isVisualMode()) {
          this.visualHead = motion.target;
          this.updateVisualSelections();
        } else if (this.modeValue === "operator-pending" && this.pendingOperator) {
          const range = this.rangeForMotion(this.cursor(), motion);
          this.applyOperatorRange(
            this.pendingOperator.name,
            range.from,
            range.to,
            false,
            this.pendingOperator.keys.concat("g", "_"),
          );
        } else this.move(motion);
        return true;
      }
      if (key === "~" || key === "u" || key === "U" || key === "q") {
        const name: OperatorName = key === "~"
          ? "swapcase"
          : key === "u"
            ? "lowercase"
            : key === "U"
              ? "uppercase"
              : "reflow";
        if (this.isVisualMode()) this.applyVisualOperator(name, ["g", key]);
        else this.startOperator(name, count.value, count.explicit, ["g", key]);
        return true;
      }
      if (key === "j" || key === "k") {
        const direction = key === "j" ? 1 : -1;
        const cursor = this.isVisualMode() ? this.visualHead : this.cursor();
        const target = this.buffer.displayLineMotion?.(cursor, direction, count.value);
        const motion = verticalMotion(this.buffer, cursor, direction, count.value, this.desiredColumn, this.runtime.options.tabstop);
        if (target !== undefined) { motion.target = target; motion.linewise = false; }
        this.desiredColumn = motion.desiredColumn;
        if (this.isVisualMode()) { this.visualHead = motion.target; this.updateVisualSelections(); }
        else if (this.pendingOperator) { const range = this.rangeForMotion(cursor, motion); this.applyOperatorRange(this.pendingOperator.name, range.from, range.to, motion.linewise, ["g", key]); }
        else this.move(motion);
        return true;
      }
      if (this.modeValue === "operator-pending") this.cancelOperator();
      else this.resetCommandState();
      return true;
    }
    return false;
  }

  private motionForKey(key: string, count: number, countExplicit = false): VimMotion | null {
    const cursor = this.isVisualMode() ? this.visualHead : this.cursor();
    switch (key) {
      case "H": case "M": case "L":
        return { target: this.buffer.viewportMotion?.(cursor, key, count) ?? cursor, inclusive: false, linewise: true };
      case "+": case "<CR>": case "-": case "_": {
        const line = this.buffer.lineAt(cursor).number + (key === "_" ? count - 1 : (key === "-" ? -count : count));
        return lineNumberMotion(this.buffer, line);
      }
      case "h":
      case "<Left>":
        this.desiredColumn = undefined;
        return horizontalMotion(this.buffer, cursor, -1, count, this.modeValue === "operator-pending" || this.modeValue === "visual-block");
      case "l":
      case "<Right>":
      case " ":
        this.desiredColumn = undefined;
        return horizontalMotion(this.buffer, cursor, 1, count, this.modeValue === "operator-pending" || this.modeValue === "visual-block");
      case "j":
      case "<Down>": {
        const motion = verticalMotion(this.buffer, cursor, 1, count, this.desiredColumn, this.runtime.options.tabstop);
        this.desiredColumn = motion.desiredColumn;
        return motion;
      }
      case "k":
      case "<Up>": {
        const motion = verticalMotion(this.buffer, cursor, -1, count, this.desiredColumn, this.runtime.options.tabstop);
        this.desiredColumn = motion.desiredColumn;
        return motion;
      }
      case "0":
      case "<Home>":
        return lineBoundaryMotion(this.buffer, cursor, "start");
      case "^":
        return lineBoundaryMotion(this.buffer, cursor, "first-nonblank");
      case "$":
      case "<End>":
        return lineBoundaryMotion(this.buffer, this.buffer.line(this.buffer.lineAt(cursor).number + count - 1).from, "end");
      case "w":
        return wordMotion(this.buffer, cursor, "forward", count, false, this.runtime.options.iskeyword);
      case "W":
        return wordMotion(this.buffer, cursor, "forward", count, true, this.runtime.options.iskeyword);
      case "b":
        return wordMotion(this.buffer, cursor, "backward", count, false, this.runtime.options.iskeyword);
      case "B":
        return wordMotion(this.buffer, cursor, "backward", count, true, this.runtime.options.iskeyword);
      case "e":
        return wordMotion(this.buffer, cursor, "end", count, false, this.runtime.options.iskeyword);
      case "E":
        return wordMotion(this.buffer, cursor, "end", count, true, this.runtime.options.iskeyword);
      case "G":
        return lineNumberMotion(this.buffer, countExplicit ? count : this.buffer.lineCount);
      case "{":
        return paragraphMotion(this.buffer, cursor, -1, count);
      case "}":
        return paragraphMotion(this.buffer, cursor, 1, count);
      case "(":
        return sentenceMotion(this.buffer, cursor, -1, count);
      case ")":
        return sentenceMotion(this.buffer, cursor, 1, count);
      case "%":
        return countExplicit ? lineNumberMotion(this.buffer, Math.ceil(this.buffer.lineCount * Math.min(100, count) / 100)) : matchingBracketMotion(this.buffer, cursor);
      case "|":
        return columnMotion(this.buffer, cursor, count, this.runtime.options.tabstop);
      default:
        return null;
    }
  }

  private startOperator(
    name: OperatorName,
    count: number,
    countExplicit: boolean,
    keys: string[],
  ): void {
    this.pendingOperator = { name, count, countExplicit, keys };
    this.setMode("operator-pending");
  }

  private cancelOperator(): void {
    this.pendingOperator = null;
    this.pendingTextObject = null;
    this.setMode("normal");
    this.resetCommandState();
  }

  private applyOperatorRange(
    name: OperatorName,
    rawFrom: number,
    rawTo: number,
    linewise: boolean,
    keys: string[],
  ): void {
    let from = Math.min(rawFrom, rawTo);
    let to = Math.max(rawFrom, rawTo);
    if (linewise) {
      const first = this.buffer.lineAt(from);
      const last = this.buffer.lineAt(Math.max(from, to - 1));
      from = first.from;
      to = last.number < this.buffer.lineCount ? last.to + 1 : last.to;
    }
    if (to <= from && name !== "indent" && name !== "outdent" && name !== "format") {
      this.cancelOperator();
      return;
    }
    if (name === "yank") {
      const originalCursor = linewise && this.pendingOperator ? this.cursor() : from;
      const text = this.buffer.text(from, to);
      this.writeRegister(text, linewise ? "line" : "character", false, true);
      this.setCursor(originalCursor);
      this.finishOperator();
      return;
    }
    if (name === "delete" || name === "change") {
      const text = this.buffer.text(from, to);
      this.beginChange(keys);
      this.writeRegister(text, linewise ? "line" : "character", true, false);
      const trimPreviousNewline = linewise && name === "delete" && to === this.buffer.length && from > 0;
      const editFrom = trimPreviousNewline ? from - 1 : from;
      const indentation = name === "change" && linewise && this.runtime.options.autoindent ? this.buffer.lineAt(from).text.match(/^[\t ]*/u)?.[0] ?? "" : "";
      const replacement = name === "change" && linewise ? indentation + (to < this.buffer.length ? "\n" : "") : "";
      this.apply([{ from: editFrom, to, insert: replacement }], [{ anchor: editFrom, head: editFrom }]);
      if (trimPreviousNewline) this.setCursor(lineBoundaryMotion(this.buffer, editFrom, "first-nonblank").target);
      this.finishOperator();
      if (name === "change") this.enterInsert(from + indentation.length, keys, false);
      else {
        this.setCursor(this.cursor());
        this.finishChange();
      }
      return;
    }
    if (name === "indent" || name === "outdent" || name === "format" || name === "reflow") {
      this.beginChange(keys);
      if (name === "format") this.reindentRange(from, to);
      else if (name === "reflow") this.reflowRange(from, to);
      else this.indentRange(from, to, name === "outdent" ? -1 : 1);
      this.finishOperator();
      this.finishChange();
      return;
    }
    this.beginChange(keys);
    const text = this.buffer.text(from, to);
    const replacement = transformCase(text, name);
    this.apply([{ from, to, insert: replacement }], [{ anchor: from, head: from }]);
    this.finishOperator();
    this.finishChange();
  }

  private applyLineOperator(name: OperatorName, count: number, keys: string[]): void {
    const first = this.buffer.lineAt(this.cursor());
    const last = this.buffer.line(first.number + count - 1);
    const to = last.number < this.buffer.lineCount ? last.to + 1 : last.to;
    this.applyOperatorRange(name, first.from, to, true, keys);
  }

  private applyToLineEnd(name: OperatorName, keys: string[], count = 1): void {
    const cursor = this.cursor();
    const line = this.buffer.line(this.buffer.lineAt(cursor).number + count - 1);
    this.applyOperatorRange(name, cursor, line.to, false, keys);
  }

  private applyVisualOperator(name: OperatorName, keys: string[]): void {
    this.rememberVisual();
    if (this.modeValue === "visual-block") {
      this.applyVisualBlockOperator(name, keys);
      return;
    }
    const ranges = this.visualRanges();
    const range = ranges[0];
    if (!range) return;
    const linewise = this.modeValue === "visual-line";
    this.applyOperatorRange(name, range.anchor, range.head, linewise, keys);
  }

  private applyVisualBlockOperator(name: OperatorName, keys: string[]): void {
    const ranges = this.visualRanges();
    const ordered = ranges.map((range) => ({
      from: Math.min(range.anchor, range.head),
      to: Math.max(range.anchor, range.head),
    }));
    const text = ordered.map((range) => this.buffer.text(range.from, range.to)).join("\n");
    if (name === "yank") {
      this.writeRegister(text, "block", false, true);
      this.exitVisual();
      this.setCursor(ordered[0]?.from ?? this.cursor());
      return;
    }
    if (name === "delete" || name === "change") {
      this.beginChange(keys);
      this.writeRegister(text, "block", true, false);
      const from = ordered[0]?.from ?? this.cursor();
      const edits = ordered.map((range) => ({ ...range, insert: "" }));
      this.apply(
        edits,
        [{ anchor: from, head: from }],
      );
      if (name === "change") {
        this.enterInsert(from, keys, false);
        this.blockInsertion = true;
        // Block change ends at the last inserted character; I/A return to the block origin.
        this.blockInsertionOrigin = null;
        this.buffer.setSelections(ordered.map((range) => { const at = mapPositionThroughEdits(range.from, edits); return { anchor: at, head: at }; }));
      }
      else {
        this.setMode("normal");
        this.finishChange();
      }
      return;
    }
    const edits = ordered.map((range) => {
      const original = this.buffer.text(range.from, range.to);
      return {
        from: range.from,
        to: range.to,
        insert: name === "indent" || name === "outdent" || name === "format"
          ? original
          : transformCase(original, name),
      };
    });
    this.beginChange(keys);
    this.apply(edits, [{ anchor: ordered[0]?.from ?? 0, head: ordered[0]?.from ?? 0 }]);
    this.setMode("normal");
    this.finishChange();
  }

  private finishOperator(): void {
    this.pendingOperator = null;
    this.pendingTextObject = null;
    this.modeValue = "normal";
    this.activeRegister = '"';
    this.emitStatus();
  }

  private deleteCharacters(count: number, direction: -1 | 1, keys: string[], enterInsert = false): void {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    const from = direction > 0 ? cursor : Math.max(line.from, moveCharacters(this.buffer.text(), cursor, -count));
    const to = direction > 0 ? Math.min(line.to, moveCharacters(this.buffer.text(), cursor, count)) : cursor;
    if (to <= from) return;
    this.beginChange(keys);
    this.writeRegister(this.buffer.text(from, to), "character", true, false);
    this.apply([{ from, to, insert: "" }], [{ anchor: from, head: from }]);
    if (enterInsert) this.enterInsert(from, keys, false);
    else {
      this.setCursor(from);
      this.finishChange();
    }
  }

  private transformCharacters(name: OperatorName, count: number, keys: string[]): void {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    const to = Math.min(line.to, moveCharacters(this.buffer.text(), cursor, count));
    if (to <= cursor) return;
    this.beginChange(keys);
    const replacement = transformCase(this.buffer.text(cursor, to), name);
    this.apply([{ from: cursor, to, insert: replacement }], [{ anchor: Math.min(to, line.to - 1), head: Math.min(to, line.to - 1) }]);
    this.finishChange();
  }

  private replaceCharacters(character: string, count: number): void {
    if (character === "<Esc>") {
      this.currentChange = null;
      return;
    }
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    const to = Math.min(line.to, moveCharacters(this.buffer.text(), cursor, count));
    if (to <= cursor) return;
    const replacement = character === "<CR>" ? "\n" : character.repeat(characters(this.buffer.text(cursor, to)).length);
    if (characters(this.buffer.text(cursor, to)).length < count) { this.finishChange(false); return; }
    this.apply([{ from: cursor, to, insert: replacement }], [{ anchor: cursor, head: cursor }]);
    this.currentChange?.push(character);
    this.finishChange();
  }

  private replaceVisualCharacters(character: string): void {
    if (!isLiteralTextToken(character) && character !== "<CR>") { this.finishChange(false); return; }
    const replacement = character === "<CR>" ? "\n" : character;
    this.rememberVisual();
    const edits = this.visualRanges().map((range) => {
      const from = Math.min(range.anchor, range.head); const to = Math.max(range.anchor, range.head);
      const text = this.buffer.text(from, to);
      const column = displayWidth(this.buffer.text(this.buffer.lineAt(from).from, from), this.runtime.options.tabstop);
      const insert = this.modeValue === "visual-block"
        ? replacement.repeat(Math.floor(displayWidth(text, this.runtime.options.tabstop, column) / Math.max(1, displayWidth(replacement, this.runtime.options.tabstop, column))))
        : characters(text).map((value) => value === "\n" ? value : replacement).join("");
      return { from, to, insert };
    });
    const at = edits[0]?.from ?? this.cursor();
    this.apply(edits, [{ anchor: at, head: at }]);
    this.currentChange?.push(character);
    this.setMode("normal"); this.finishChange();
  }

  private put(after: boolean, count: number, keys: string[], cursorAfter = false): void {
    const recorded = this.commandKeys.length ? [...this.commandKeys] : keys;
    this.withRegister(this.activeRegister, (register) => {
      const length = this.buffer.length;
      const start = this.cursor();
      const insertion = after ? this.afterCursor() : start;
      const sourceLine = this.buffer.lineAt(start);
      const blockColumn = displayWidth(this.buffer.text(sourceLine.from, insertion), this.runtime.options.tabstop);
      this.putRegister(register, after, count, recorded);
      if (cursorAfter && this.buffer.length > length) {
        if (register.kind === "block") {
          const rows = register.text.split("\n");
          const last = rows.at(-1)!;
          const width = register.blockWidth ?? Math.max(...rows.map((row) => displayWidth(row, this.runtime.options.tabstop)));
          const row = this.buffer.line(sourceLine.number + rows.length - 1);
          this.setCursor(row.from + offsetAtColumn(row.text, blockColumn + width * (count - 1) + displayWidth(last, this.runtime.options.tabstop, blockColumn), this.runtime.options.tabstop));
          return;
        }
        const target = register.kind === "line" ? this.buffer.lineAt(this.cursor()).number + register.text.replace(/\n$/u, "").split("\n").length * count : null;
        this.setCursor(target === null ? insertion + this.buffer.length - length : this.buffer.line(target).from);
      }
    });
  }

  private putRegister(register: VimRegister, after: boolean, count: number, keys: string[]): void {
    if (!register.text) return;
    this.beginChange(keys);
    if (register.kind === "line") {
      const line = this.buffer.lineAt(this.cursor());
      const text = register.text.endsWith("\n") ? register.text : `${register.text}\n`;
      const appendToUnterminatedLastLine = after && line.number === this.buffer.lineCount;
      const at = after
        ? (appendToUnterminatedLastLine ? line.to : line.to + 1)
        : line.from;
      const repeated = appendToUnterminatedLastLine
        ? `\n${Array.from({ length: count }, () => text.replace(/\n$/u, "")).join("\n")}`
        : text.repeat(count);
      const cursor = at + (appendToUnterminatedLastLine ? 1 : 0);
      this.apply([{ from: at, to: at, insert: repeated }], [{ anchor: cursor, head: cursor }]);
      this.setCursor(cursor);
    } else if (register.kind === "block") {
      this.putBlock(register.text, after, count, register.blockWidth);
    } else {
      const at = after ? this.afterCursor() : this.cursor();
      const text = register.text.repeat(count);
      this.apply([{ from: at, to: at, insert: text }], [{ anchor: Math.max(at, at + text.length - 1), head: Math.max(at, at + text.length - 1) }]);
      this.setCursor(Math.max(at, at + text.length - 1));
    }
    this.activeRegister = '"';
    this.finishChange();
  }

  private putBlock(text: string, after: boolean, count: number, blockWidth?: number): void {
    const rows = text.split("\n");
    const sourceLine = this.buffer.lineAt(this.cursor());
    const column = displayWidth(this.buffer.text(sourceLine.from, after ? this.afterCursor() : this.cursor()), this.runtime.options.tabstop);
    const edits = [];
    const extra: string[] = [];
    const width = blockWidth ?? Math.max(...rows.map((row) => displayWidth(row, this.runtime.options.tabstop)));
    const repeat = (row: string) => (row + " ".repeat(Math.max(0, width - displayWidth(row, this.runtime.options.tabstop, column)))).repeat(count - 1) + row;
    for (let index = 0; index < rows.length; index += 1) {
      const lineNumber = sourceLine.number + index;
      if (lineNumber > this.buffer.lineCount) { extra.push(`${" ".repeat(column)}${repeat(rows[index])}`); continue; }
      const line = this.buffer.line(lineNumber);
      const padding = Math.max(0, column - displayWidth(line.text, this.runtime.options.tabstop));
      const at = line.from + offsetAtColumn(line.text, column, this.runtime.options.tabstop);
      edits.push({ from: at, to: at, insert: `${" ".repeat(padding)}${repeat(rows[index])}` });
    }
    if (extra.length) {
      const tail = `\n${extra.join("\n")}`;
      const last = edits.find((edit) => edit.from === this.buffer.length);
      if (last) last.insert += tail;
      else edits.push({ from: this.buffer.length, to: this.buffer.length, insert: tail });
    }
    const cursor = edits[0]?.from ?? this.cursor();
    this.apply(edits, [{ anchor: cursor, head: cursor }]);
  }

  private joinLines(count: number, keys: string[]): void {
    const start = this.buffer.lineAt(this.cursor());
    const last = this.buffer.line(Math.min(this.buffer.lineCount, start.number + Math.max(1, count) - 1));
    if (last.number === start.number && start.number === this.buffer.lineCount) return;
    const toLine = last.number === start.number ? this.buffer.line(start.number + 1) : last;
    const original = this.buffer.text(start.from, toLine.to);
    const joined = original.replace(/\s*\n\s*/g, " ");
    this.beginChange(keys);
    this.apply([{ from: start.from, to: toLine.to, insert: joined }], [{ anchor: start.to, head: start.to }]);
    this.setCursor(start.to);
    this.finishChange();
  }

  private indentRange(from: number, to: number, direction: -1 | 1): void {
    const first = this.buffer.lineAt(from).number;
    const last = this.buffer.lineAt(Math.max(from, to - 1)).number;
    const width = this.runtime.options.shiftwidth || this.runtime.options.tabstop;
    const indentation = this.runtime.options.expandtab ? " ".repeat(width) : "\t";
    const edits = [];
    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
      const line = this.buffer.line(lineNumber);
      if (direction > 0) {
        edits.push({ from: line.from, to: line.from, insert: indentation });
      } else {
        const match = line.text.match(/^\t|^ {1,}/);
        if (!match) continue;
        const remove = match[0].startsWith("\t") ? 1 : Math.min(width, match[0].length);
        edits.push({ from: line.from, to: line.from + remove, insert: "" });
      }
    }
    this.apply(edits, [{ anchor: this.buffer.line(first).from, head: this.buffer.line(first).from }]);
    this.setCursor(this.buffer.line(first).from);
  }

  private reindentRange(from: number, to: number): void {
    const edits = this.buffer.reindent?.(from, to);
    if (edits) { this.apply(edits); return; }
    const first = this.buffer.lineAt(from).number;
    const last = this.buffer.lineAt(Math.max(from, to - 1)).number;
    const indentation = first > 1 && this.runtime.options.autoindent ? this.buffer.line(first - 1).text.match(/^[\t ]*/u)?.[0] ?? "" : "";
    this.apply(Array.from({ length: last - first + 1 }, (_, index) => {
      const line = this.buffer.line(first + index);
      return { from: line.from, to: line.from + (line.text.match(/^[\t ]*/u)?.[0].length ?? 0), insert: line.text.trim() ? indentation : "" };
    }));
  }

  private reflowRange(from: number, to: number): void {
    const start = this.buffer.lineAt(from).from;
    const end = this.buffer.lineAt(Math.max(from, to - 1)).to;
    const width = this.runtime.options.textwidth || 79;
    const paragraphs = this.buffer.text(start, end).split(/\n\s*\n/u);
    const formatted = paragraphs.map((paragraph) => {
      const indent = paragraph.match(/^[\t ]*/u)?.[0] ?? "";
      const lines: string[] = [];
      let current = indent;
      for (const word of paragraph.trim().split(/\s+/u)) {
        if (current !== indent && displayWidth(`${current} ${word}`, this.runtime.options.tabstop) > width) { lines.push(current); current = indent; }
        current += `${current === indent ? "" : " "}${word}`;
      }
      lines.push(current);
      return lines.join("\n");
    }).join("\n\n");
    this.apply([{ from: start, to: end, insert: formatted }]);
    this.setCursor(lineBoundaryMotion(this.buffer, start + formatted.length, "first-nonblank").target);
  }

  private rememberVisual(): void {
    this.previousVisual = this.createVisualSnapshot();
    this.marks.set("<", Math.min(this.visualAnchor, this.visualHead));
    this.marks.set(">", Math.max(this.visualAnchor, this.visualHead));
  }

  private openLine(direction: -1 | 1, keys: string[]): void {
    const line = this.buffer.lineAt(this.cursor());
    const indentation = this.runtime.options.autoindent ? line.text.match(/^[\t ]*/u)?.[0] ?? "" : "";
    const at = direction > 0 ? line.to : line.from;
    const insert = direction > 0 ? `\n${indentation}` : `${indentation}\n`;
    const cursor = direction > 0 ? at + insert.length : at + indentation.length;
    this.beginChange(keys);
    this.apply([{ from: at, to: at, insert }], [{ anchor: cursor, head: cursor }]);
    this.enterInsert(cursor, keys, false);
  }

  private enterInsert(
    position: number,
    keys: string[],
    startChange = true,
    exitCursorOnEmpty = this.cursor(),
  ): void {
    if (startChange) this.beginChange(keys);
    this.setCursor(position, true);
    this.lastInsertedText = "";
    this.insertExitCursorOnEmpty = exitCursorOnEmpty;
    this.setMode("insert");
    this.queueAutocmd("InsertEnter");
  }

  private enterVisual(mode: "visual" | "visual-line" | "visual-block"): void {
    this.selectMode = false;
    this.desiredColumn = undefined;
    this.visualAnchor = this.cursor();
    this.visualHead = this.cursor();
    this.modeValue = mode;
    this.updateVisualSelections();
  }

  private exitVisual(): void {
    this.rememberVisual();
    const cursor = this.visualHead;
    this.modeValue = "normal";
    this.setCursor(cursor);
    this.emitStatus();
  }

  private enterVisualBlockInsert(after: boolean, keys: string[]): void {
    const original = this.visualRanges()[0];
    this.blockInsertionOrigin = original ? Math.min(original.anchor, original.head) : this.cursor();
    const ranges = this.visualRanges().map((range) => {
      const from = Math.min(range.anchor, range.head);
      const to = Math.max(range.anchor, range.head);
      const at = after ? to : from;
      return { anchor: at, head: at };
    });
    this.beginChange(keys);
    this.blockInsertion = true;
    this.buffer.setSelections(ranges);
    this.lastInsertedText = "";
    this.insertExitCursorOnEmpty = ranges[0]?.head ?? this.cursor();
    this.modeValue = "insert";
    this.queueAutocmd("InsertEnter");
    this.emitStatus();
  }

  private updateVisualSelections(): void {
    const snapshot = this.createVisualSnapshot();
    if (!visualSnapshotsEqual(this.buffer.visualSnapshot(), snapshot)) {
      this.buffer.presentVisual(snapshot);
    }
    this.emitStatus();
  }

  private createVisualSnapshot(): VimVisualSnapshot {
    const mode = this.modeValue === "visual-line" || this.modeValue === "visual-block"
      ? this.modeValue
      : "visual";
    return {
      mode,
      anchor: this.visualAnchor,
      head: this.visualHead,
      activePosition: this.visualHead,
      ranges: this.visualRanges().map((range) => ({
        anchor: Math.min(range.anchor, range.head),
        head: Math.max(range.anchor, range.head),
      })),
    };
  }

  private visualRanges(): VimSelection[] {
    if (this.modeValue === "visual-line") {
      const anchorLine = this.buffer.lineAt(this.visualAnchor);
      const headLine = this.buffer.lineAt(this.visualHead);
      const first = this.buffer.lineAt(Math.min(this.visualAnchor, this.visualHead));
      const last = this.buffer.lineAt(Math.max(this.visualAnchor, this.visualHead));
      const end = last.number < this.buffer.lineCount ? last.to + 1 : last.to;
      return [{
        anchor: headLine.number < anchorLine.number ? end : first.from,
        head: headLine.number < anchorLine.number ? first.from : end,
      }];
    }
    if (this.modeValue === "visual-block") {
      const { firstLine, lastLine, left, right, reversed } = blockGeometry(this.buffer, this.visualAnchor, this.visualHead, this.runtime.options.tabstop);
      const ranges: VimSelection[] = [];
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        const line = this.buffer.line(lineNumber);
        const from = line.from + offsetAtColumn(line.text, left, this.runtime.options.tabstop);
        const to = line.from + offsetAtColumn(line.text, right, this.runtime.options.tabstop);
        ranges.push(reversed
          ? { anchor: Math.max(from, to), head: from }
          : { anchor: from, head: Math.max(from, to) });
      }
      return ranges;
    }
    const text = this.buffer.text();
    if (this.visualHead < this.visualAnchor) {
      return [{
        anchor: nextCharacterPosition(text, this.visualAnchor),
        head: this.visualHead,
      }];
    }
    return [{
      anchor: this.visualAnchor,
      head: nextCharacterPosition(text, this.visualHead),
    }];
  }

  private replaceVisualWithRegister(keys: string[]): void {
    this.withRegister(this.activeRegister, (register) => this.replaceVisualRegister(register, keys));
  }

  private replaceVisualRegister(register: VimRegister, keys: string[]): void {
    this.rememberVisual();
    const selectedKind = this.modeValue;
    const ranges = this.visualRanges();
    const edits = ranges.map((range) => ({
      from: Math.min(range.anchor, range.head),
      to: Math.max(range.anchor, range.head),
      insert: register.text,
    }));
    const removed = ranges.map((range) => this.buffer.text(
      Math.min(range.anchor, range.head),
      Math.max(range.anchor, range.head),
    )).join("\n");
    this.beginChange(keys);
    if (keys.at(-1) !== "P") {
      const selected = this.activeRegister;
      this.activeRegister = '"';
      this.writeRegister(removed, this.modeValue === "visual-line" ? "line" : this.modeValue === "visual-block" ? "block" : "character", true, false);
      this.activeRegister = selected;
    }
    let cursor = edits[0]?.from ?? this.cursor();
    if (selectedKind === "visual-block" && register.kind === "line") {
      this.apply(edits.map((edit) => ({ ...edit, insert: "" })), [{ anchor: cursor, head: cursor }]);
      this.setMode("normal");
      this.putRegister(register, keys.at(-1) !== "P", 1, keys);
      return;
    }
    if (selectedKind === "visual-line") {
      for (const edit of edits) {
        edit.insert = register.text.replace(/\n$/u, "") + (this.buffer.text(edit.from, edit.to).endsWith("\n") ? "\n" : "");
      }
    } else if (register.kind === "line") {
      for (const edit of edits) edit.insert = `\n${register.text.endsWith("\n") ? register.text : register.text + "\n"}`;
      cursor += 1;
    }
    this.apply(edits, [{ anchor: cursor, head: cursor }]);
    this.setMode("normal");
    this.finishChange();
  }

  private move(motion: VimMotion): void {
    if (motion.jump) this.recordJump(motion.target);
    this.setCursor(motion.target);
  }

  private rangeForMotion(cursor: number, motion: VimMotion): { from: number; to: number } {
    if (motion.linewise) {
      const first = this.buffer.lineAt(Math.min(cursor, motion.target));
      const last = this.buffer.lineAt(Math.max(cursor, motion.target));
      return {
        from: first.from,
        to: last.number < this.buffer.lineCount ? last.to + 1 : last.to,
      };
    }
    if (motion.target >= cursor) {
      return {
        from: cursor,
        to: motion.inclusive
          ? nextCharacterPosition(this.buffer.text(), motion.target)
          : motion.target,
      };
    }
    return {
      from: motion.target,
      to: motion.inclusive
        ? nextCharacterPosition(this.buffer.text(), cursor)
        : cursor,
    };
  }

  private resolveMapping(key: string): boolean | null {
    const mappingMode = this.modeValue === "replace" ? "insert" : this.mode;
    const mappings = this.runtime.mappings.filter((mapping) => mapping.modes.includes(mappingMode));
    if (mappings.length === 0) return null;
    const candidate = [...this.mappingBuffer, key];
    const matching = mappings.filter((mapping) => startsWith(mapping.lhs, candidate));
    if (matching.length === 0) {
      if (this.mappingBuffer.length === 0) return null;
      const buffered = [...this.mappingBuffer, key];
      this.mappingBuffer = [];
      for (const bufferedKey of buffered) this.handleDirectKey(bufferedKey);
      return true;
    }
    this.mappingBuffer = candidate;
    const exact = matching.find((mapping) => arraysEqual(mapping.lhs, candidate));
    if (!exact || matching.some((mapping) => mapping.lhs.length > candidate.length)) return true;
    this.mappingBuffer = [];
    this.executeMapping(exact);
    return true;
  }

  private resolveInsertMapping(key: string): boolean | null {
    const mappings = this.runtime.mappings.filter((mapping) => mapping.modes.includes("insert"));
    if (mappings.length === 0) return null;
    const candidate = [...this.insertMappingBuffer, key];
    const matching = mappings.filter((mapping) => startsWith(mapping.lhs, candidate));
    if (matching.length === 0) {
      if (this.insertMappingBuffer.length === 0) return null;
      const literal = [...this.insertMappingBuffer, key].join("");
      this.insertMappingBuffer = [];
      this.insertLiteral(literal);
      return true;
    }
    this.insertMappingBuffer = candidate;
    const exact = matching.find((mapping) => arraysEqual(mapping.lhs, candidate));
    if (!exact || matching.some((mapping) => mapping.lhs.length > candidate.length)) return true;
    this.insertMappingBuffer = [];
    this.executeMapping(exact);
    return true;
  }

  private executeMapping(mapping: VimMapping): void {
    if (this.mappingDepth >= this.runtime.options.maxmapdepth) throw new Error("E223: Recursive mapping exceeded maxmapdepth");
    this.playback.enqueue(mapping.rhs.map((key) => ({ key, remap: mapping.recursive, mappingDepth: this.mappingDepth + 1 })));
    if (this.playback.busy) void this.playback.idle().then(() => this.flushQueuedKeys());
  }

  private replayMacroKey(key: string, remap = true): void {
    const outer = this.playbackInput;
    this.playbackInput = true;
    try {
      if (
        (this.modeValue === "insert" || this.modeValue === "replace") &&
        isLiteralTextToken(key)
      ) {
        if (!remap || !this.handleInsertInput(key)) {
          if (this.modeValue === "replace") this.replaceInput(key); else this.insertLiteral(key);
        }
        return;
      }
      if (!remap || this.resolveMapping(key) === null) this.handleDirectKey(key);
    } finally { this.playbackInput = outer; }
  }

  private expandAbbreviation(delimiter: string): boolean {
    if (this.abbreviations.size === 0) return false;
    if (!/\s|[.,;:!?()[\]{}]/u.test(delimiter)) return false;
    const cursor = this.cursor();
    const start = Math.max(0, cursor - this.longestAbbreviation - 1);
    const prefix = this.buffer.text(start, cursor);
    let index = prefix.length;
    while (index > 0 && !/[\s.,;:!?()[\]{}]/u.test(prefix[index - 1])) index--;
    if (index === prefix.length || (index === 0 && start > 0)) return false;
    const replacement = this.abbreviations.get(prefix.slice(index));
    if (replacement === undefined) return false;
    const from = start + index;
    this.apply(
      [{ from, to: cursor, insert: replacement + delimiter }],
      [{ anchor: from + replacement.length + delimiter.length, head: from + replacement.length + delimiter.length }],
    );
    this.currentChange?.appendText(replacement, true);
    this.currentChange?.push(delimiter);
    return true;
  }

  private rebuildAbbreviations(): void {
    this.abbreviations.clear(); this.longestAbbreviation = 0;
    for (const entry of this.runtime.abbreviations) {
      if (!entry.lhs || /[\s.,;:!?()[\]{}]/u.test(entry.lhs) || this.abbreviations.has(entry.lhs)) continue;
      this.abbreviations.set(entry.lhs, entry.rhs);
      this.longestAbbreviation = Math.max(this.longestAbbreviation, entry.lhs.length);
    }
  }

  private removeInsertedSuffix(text: string): void {
    let remaining = text;
    while (remaining && this.lastInsertedText) {
      const character = characters(remaining).at(-1)!;
      if (!this.lastInsertedText.endsWith(character)) break;
      this.lastInsertedText = this.lastInsertedText.slice(0, -character.length);
      remaining = remaining.slice(0, -character.length);
    }
  }

  private insertLiteral(text: string): void {
    if (!text) return;
    const selections = this.buffer.selections();
    const edits = selections.map((selection) => ({
      from: Math.min(selection.anchor, selection.head),
      to: Math.max(selection.anchor, selection.head),
      insert: text,
    }));
    const nextSelections = edits.map((edit) => {
      const at = mapPositionThroughEdits(edit.from, edits);
      return { anchor: at, head: at };
    });
    this.apply(edits, nextSelections);
    this.lastInsertedText += text;
    this.currentChange?.appendText(text);
  }

  private replaceInput(text: string): void {
    if (text.includes("\n")) {
      for (const character of characters(text)) { if (character === "\n") this.insertLineBreak(); else this.replaceInput(character); }
      return;
    }
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    let to = cursor;
    let padding = "";
    if (this.virtualReplace) {
      const column = displayWidth(this.buffer.text(line.from, cursor), this.runtime.options.tabstop);
      const width = displayWidth(text, this.runtime.options.tabstop, column);
      while (to < line.to && displayWidth(this.buffer.text(cursor, to), this.runtime.options.tabstop, column) < width) to = nextCharacter(this.buffer.text(), to);
      const excess = Math.max(0, displayWidth(this.buffer.text(cursor, to), this.runtime.options.tabstop, column) - width);
      padding = excess && this.buffer.text(cursor, to).endsWith("\t") ? "\t" : " ".repeat(excess);
    } else for (let index = 0; index < graphemes(text).length && to < line.to; index += 1) to = nextGraphemePosition(this.buffer.text(), to);
    this.replaceUndo.push({ at: cursor, after: cursor + text.length, inserted: text + padding, removed: this.buffer.text(cursor, to) });
    this.apply([{ from: cursor, to, insert: text + padding }], [{ anchor: cursor + text.length, head: cursor + text.length }]);
    this.lastInsertedText += text;
    this.currentChange?.appendText(text);
  }

  private insertLineBreak(): void {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    const indentation = this.runtime.options.autoindent ? line.text.match(/^[\t ]*/u)?.[0] ?? "" : "";
    const text = `\n${indentation}`;
    const recorded = this.currentChange?.clone() ?? null;
    const input = this.lastInsertedText;
    if (this.virtualReplace) {
      const to = line.number < this.buffer.lineCount ? line.to + 1 : line.to;
      this.replaceUndo.push({ at: cursor, after: cursor + text.length, inserted: text, removed: this.buffer.text(cursor, to) });
      this.apply([{ from: cursor, to, insert: text }], [{ anchor: cursor + text.length, head: cursor + text.length }]);
    } else this.insertLiteral(text);
    this.currentChange = recorded;
    this.currentChange?.push("<CR>");
    this.lastInsertedText = input + "\n";
  }

  private repeatLastChange(count: number, explicit = false): void {
    if (this.lastChange.length === 0 || this.replayingChange) return;
    this.replayingChange = true;
    this.buffer.beginHistoryGroup();
    try {
      const keys = explicit ? overrideRecordedCount(this.lastChange, count) : this.lastChange;
        for (const key of keys) {
          if (this.modeValue === "insert" && isLiteralTextToken(key)) {
            this.insertLiteral(key);
          } else if (this.modeValue === "replace" && isLiteralTextToken(key)) {
            this.replaceInput(key);
          }
          else this.handleDirectKey(key);
        }
        if (this.modeValue === "insert" || this.modeValue === "replace") this.handleDirectKey("<Esc>");
    } finally {
      this.buffer.endHistoryGroup();
      this.replayingChange = false;
    }
  }

  private beginChange(keys: string[]): void {
    if (this.buffer.readOnly) throw new Error("E21: Cannot make changes, buffer is read-only");
    if (this.replayingChange) return;
    if (!this.currentChange) {
      if (this.changes.at(-1) !== this.cursor()) this.changes.push(this.cursor());
      if (this.changes.length > 100) this.changes.shift();
      this.changeIndex = this.changes.length;
      this.currentChange = VimKeyTape.from(this.commandKeys.length ? this.commandKeys : keys);
      this.buffer.beginHistoryGroup();
    }
  }

  private finishChange(record = true): void {
    if (this.replayingChange) return;
    if (record && this.currentChange && this.currentChange.length > 0) {
      this.lastChange = this.currentChange.clone();
    }
    if (this.currentChange) this.buffer.endHistoryGroup();
    this.currentChange = null;
    this.activeRegister = '"';
  }

  private enterCommandLine(prefix: ":" | "/" | "?"): void {
    this.searchStart = this.cursor();
    this.historyIndex = -1;
    this.commandPrefix = prefix;
    this.commandBuffer = "";
    this.setMode("command-line");
  }

  private executeSearch(pattern: string, direction: -1 | 1): void {
    if (pattern) this.searchPattern = pattern;
    if (!this.searchPattern) { this.reportError("E35: No previous regular expression"); return; }
    this.searchDirection = direction;
    this.setCursor(this.searchStart);
    const origin = this.cursor();
    const errors = this.errorSequence;
    this.repeatSearch(direction, this.searchCount);
    if (this.errorSequence !== errors) { this.cancelOperator(); this.searchCount = 1; return; }
    if (this.pendingOperator) {
      const operator = this.pendingOperator;
      const target = this.cursor();
      this.setCursor(origin);
      this.applyOperatorRange(operator.name, Math.min(origin, target), Math.max(origin, target), false, [...operator.keys, direction > 0 ? "/" : "?", ...this.searchPattern, "<CR>"]);
    }
    this.searchCount = 1;
  }

  private restoreSearchHighlight(): void {
    let ranges: readonly { from: number; to: number }[] = [];
    if (this.runtime.options.hlsearch && this.searchPattern) {
      try { ranges = findVimMatches(this.buffer.text(), this.searchPattern, this.runtime.options); } catch { /* Keep an invalid historical pattern from breaking cancellation. */ }
    }
    this.buffer.highlightSearch?.(ranges);
  }

  private previewSearch(): void {
    if (this.commandPrefix === ":" || !this.runtime.options.incsearch) return;
    this.setCursor(this.searchStart);
    if (!this.commandBuffer) { this.restoreSearchHighlight(); return; }
    try {
      const matches = findVimMatches(this.buffer.text(), this.commandBuffer, this.runtime.options);
      this.buffer.highlightSearch?.(matches);
      const positions = matches.map(({ from }) => from);
      if (this.commandPrefix === "?") positions.reverse();
      const start = positions.findIndex((position) => this.commandPrefix === "/" ? position > this.searchStart : position < this.searchStart);
      const index = (start < 0 ? positions.length : start) + this.searchCount - 1;
      const target = this.runtime.options.wrapscan ? positions[index % positions.length] : positions[index];
      if (target !== undefined) this.setCursor(target);
    } catch {
      // Incomplete input is editable; it must not mutate the previous search or operate text.
      this.buffer.highlightSearch?.([]);
    }
  }

  private repeatSearch(direction: -1 | 1, count: number): void {
    if (!this.searchPattern) return;
    const regex = this.searchRegex(this.searchPattern);
    if (!regex) return;
    const text = this.buffer.text();
    const matches = [...text.matchAll(regex)].map((match) => match.index);
    if (this.runtime.options.hlsearch) this.buffer.highlightSearch?.(findVimMatches(text, this.searchPattern, this.runtime.options));
    if (matches.length === 0) { this.reportError(`E486: Pattern not found: ${this.searchPattern}`); return; }
    let cursor = this.cursor();
    for (let iteration = 0; iteration < count; iteration += 1) {
      const target = direction > 0
        ? matches.find((position) => position > cursor) ?? (this.runtime.options.wrapscan ? matches[0] : undefined)
        : [...matches].reverse().find((position) => position < cursor) ?? (this.runtime.options.wrapscan ? matches[matches.length - 1] : undefined);
      if (target === undefined) { this.reportError("Search reached the end of the buffer."); return; }
      cursor = target;
    }
    this.recordJump(cursor);
    this.setCursor(cursor);
  }

  private searchRegex(pattern: string): RegExp | null {
    try {
      return compileVimPattern(pattern, this.runtime.options);
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private searchWord(direction: -1 | 1, count: number, whole: boolean): void {
    const range = textObjectRange(this.buffer, this.cursor(), "w", false, 1, this.runtime.options.iskeyword);
    if (!range) return;
    const text = this.buffer.text(range.from, range.to);
    this.searchPattern = whole ? `\\<${escapeVimLiteral(text)}\\>` : escapeVimLiteral(text);
    this.searchDirection = direction;
    this.repeatSearch(direction, count);
  }

  private repeatFind(directionMultiplier: -1 | 1, count: number): void {
    if (!this.lastFind) return;
    const direction = (this.lastFind.direction * directionMultiplier) as -1 | 1;
    const motion = findCharacterMotion(
      this.buffer,
      this.cursor(),
      this.lastFind.character,
      direction,
      count,
      this.lastFind.till,
    );
    if (motion) this.move(motion);
  }

  private async executeEx(rawCommand: string): Promise<void> {
    if (this.disposed) return;
    let command = rawCommand.trim();
    if (!command) return;
    const firstWord = command.split(/\s+/, 1)[0] ?? "";
    const alias = this.runtime.exCommands.get(firstWord);
    if (alias) command = `${alias}${command.slice(firstWord.length)}`.trim();
    if (/^(?:[nvxsoci]?(?:noremap|map|unmap)|i?(?:noreabbrev|abbrev(?:iate)?|unabbrev(?:iate)?)|command!?|delcommand|autocmd!?|let)\s/u.test(command)) {
      const config = parseVimrc(command, ":command");
      if (config.diagnostics.length) throw new Error(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      const next = compileVimRuntime(config.directives, config.diagnostics, this.runtime);
      if (config.diagnostics.length) throw new Error(config.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
      this.setRuntime(next);
      return;
    }
    const parsed = parseExCommand(command, this.buffer, this.buffer.lineAt(this.cursor()).number,
      (name) => this.marks.get(name), (pattern, direction, line) => {
        const matches = findVimMatches(this.buffer.text(), pattern || this.searchPattern, this.runtime.options);
        const lines = matches.map((match) => this.buffer.lineAt(match.from).number);
        const found = direction > 0 ? lines.find((value) => value > line) ?? lines[0]
          : [...lines].reverse().find((value) => value < line) ?? lines.at(-1);
        if (found === undefined) throw new Error("E486: Pattern not found");
        return found;
      });
    const editing = this.executeEditingEx(parsed.range, parsed.name, parsed.argument, parsed.bang);
    if (editing !== false) { if (editing instanceof Promise) await editing; return; }

    if (/^w(?:rite)?!?$/u.test(command)) {
      await this.writeCurrentBuffer();
      return;
    }
    if (/^q(?:uit)?!?$/u.test(command)) {
      await this.hooks.onQuit?.(command.endsWith("!"));
      return;
    }
    if (/^(?:wq|x)!?$/u.test(command)) {
      if (await this.writeCurrentBuffer() && !this.disposed) {
        await this.hooks.onQuit?.(command.endsWith("!"));
      }
      return;
    }
    if (/^(?:noh|nohl|nohlsearch)$/u.test(command)) {
      this.buffer.highlightSearch?.([]);
      this.message = "";
      this.emitStatus();
      return;
    }
    const open = command.match(/^e(?:dit)?!?(?:\s+(.+))?$/u);
    if (open) {
      if (open[1]) await this.hooks.onOpen?.(open[1].trim());
      return;
    }
    const split = command.match(/^(v?sp(?:lit)?)(?:\s+(.+))?$/u);
    if (split) {
      await this.hooks.onSplit?.(split[1]?.startsWith("v") ?? false, split[2]?.trim());
      return;
    }
    const bufferCommand = command.match(/^(b(?:uffer)?|bn(?:ext)?|bp(?:revious)?|bd(?:elete)?)(?:\s+(.+))?$/u);
    if (bufferCommand) {
      if (!this.hooks.onBufferCommand) throw new Error("Buffer navigation is unavailable in this host.");
      await this.hooks.onBufferCommand(bufferCommand[1], bufferCommand[2]);
      return;
    }
    const obsidian = command.match(/^(?:obcommand|ob)\s+(.+)$/u);
    if (obsidian) {
      const handled = await this.hooks.onObsidianCommand?.(obsidian[1].trim());
      if (!handled) this.reportError(`Unknown Obsidian command: ${obsidian[1].trim()}`);
      return;
    }
    if (command.startsWith("!")) {
      if (!this.externalCommandsAllowed) {
        this.reportError("External Vim commands are disabled in mv-AIDE settings.");
        return;
      }
      await this.hooks.onExternalCommand?.(command.slice(1).trim());
      return;
    }
    if (command === "registers" || command === "reg") {
      this.message = this.session.registerEntries()
        .map(([name, value]) => `"${name} ${value.text.replace(/\n/g, "^J")}`)
        .join("  ");
      this.emitStatus();
      return;
    }
    if (command === "marks") {
      this.message = [...this.marks.entries()].map(([name, position]) => `${name}:${position}`).join("  ");
      this.emitStatus();
      return;
    }
    if (command === "jumps") {
      this.message = this.jumps.map((jump, index) => `${index === this.jumpIndex ? ">" : " "}${jump.position}`).join("  ");
      this.emitStatus();
      return;
    }
    const setCommand = command.match(/^set(?:local)?(?:\s+(.*))?$/u);
    if (setCommand) {
      this.executeSet(setCommand[1]?.trim() ?? "");
      this.hooks.onOptionsChanged?.();
      return;
    }
    this.reportError(`Unsupported Vim command: ${command}`);
  }

  private executeEditingEx(range: ExRange, name: string, argument: string, bang: boolean): boolean | Promise<void> {
    if (!name && range.explicit) { this.setCursor(this.buffer.line(range.last).from); return true; }
    if (["s", "substitute", "&", "~"].includes(name)) {
      const spec = argument ? parseVimSubstitute(argument) : this.lastSubstitute ? { ...this.lastSubstitute, flags: "", count: undefined } : null;
      if (!spec) throw new Error("E33: No previous substitute regular expression");
      const pattern = name === "~" ? this.searchPattern : spec.pattern || this.searchPattern;
      if (!pattern) throw new Error("E35: No previous regular expression");
      this.lastSubstitute = { ...spec, pattern };
      this.searchPattern = pattern;
      const options = { ...this.runtime.options };
      if (spec.flags.includes("i") || spec.flags.includes("I")) { options.ignorecase = spec.flags.includes("i"); options.smartcase = false; }
      const edits: VimEdit[] = [];
      const first = spec.count === undefined ? range.first : range.last;
      const lastLine = spec.count === undefined ? range.last : Math.min(this.buffer.lineCount, range.last + spec.count - 1);
      for (let number = first; number <= lastLine; number += 1) {
        const line = this.buffer.line(number);
        const matches = findVimMatches(line.text, pattern, options);
        for (const match of spec.flags.includes("g") ? matches : matches.slice(0, 1)) {
          edits.push({ from: line.from + match.from, to: line.from + match.to, insert: vimReplacement(spec.replacement, match) });
        }
      }
      if (!edits.length && !spec.flags.includes("e")) throw new Error(`E486: Pattern not found: ${pattern}`);
      if (spec.flags.includes("n")) { this.message = `${edits.length} matches`; this.emitStatus(); return true; }
      if (spec.flags.includes("c") && edits.length) {
        this.confirmation = { edits, index: 0, offset: 0, expected: this.buffer.text() };
        this.buffer.beginHistoryGroup();
        this.setMode("command-line");
        this.showSubstituteConfirmation();
      } else if (edits.length) {
        this.beginChange([]);
        const last = edits[edits.length - 1];
        const lastStart = last.from + edits.slice(0, -1).reduce((offset, edit) => offset + edit.insert.length - (edit.to - edit.from), 0);
        this.apply(edits);
        this.setCursor(lineBoundaryMotion(this.buffer, lastStart, "first-nonblank").target);
        this.finishChange(false);
      }
      return true;
    }
    if (["d", "delete", "y", "yank"].includes(name)) {
      const parameters = /^"?([A-Za-z"+*_-])?(?:\s*(\d+))?\s*$/u.exec(argument);
      if (!parameters) throw new Error("E488: Trailing characters");
      if (parameters[1]) this.activeRegister = parameters[1];
      const count = parameters[2] ? Number(parameters[2]) : range.last - range.first + 1;
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("E939: Positive count required");
      this.setCursor(this.buffer.line(parameters[2] ? range.last : range.first).from);
      this.applyLineOperator(name === "d" || name === "delete" ? "delete" : "yank", count, []);
      return true;
    }
    if (name === "pu" || name === "put") {
      if (argument) this.activeRegister = argument.replace(/^"/u, "")[0] ?? '"';
      this.setCursor(this.buffer.line(range.last).from);
      this.withRegister(this.activeRegister, (value) => this.putRegister({ ...value, kind: "line" }, !bang && range.last > 0, 1, []));
      return true;
    }
    if (["co", "copy", "t", "m", "move"].includes(name)) {
      const destination = parseExCommand(argument, this.buffer, this.buffer.lineAt(this.cursor()).number, (mark) => this.marks.get(mark), () => { throw new Error("Unsupported destination search"); }).range.last;
      if (name === "m" || name === "move") {
        if (destination >= range.first && destination <= range.last) throw new Error("E134: Cannot move a range of lines into itself");
      }
      const moving = name === "m" || name === "move";
      const plan = planLineTransfer(this.buffer, range.first, range.last, destination, moving);
      const localMarks = [...this.marks.entries()];
      const fileMarks = [...this.session.fileMarks.entries()].filter(([, mark]) => mark.bufferId === this.buffer.id).map(([key, mark]) => [key, { ...mark }] as const);
      this.beginChange([]); this.apply(plan.edits, undefined, plan.map);
      // Another view may have received the shared edit during dispatch; publish
      // the same identity-preserving mapping for all buffer-local marks once.
      for (const [key, offset] of localMarks) this.marks.set(key, plan.map(offset));
      for (const [key, mark] of fileMarks) this.session.fileMarks.set(key, { ...mark, position: plan.map(mark.position) });
      this.setCursor(this.buffer.line(plan.cursorLine).from); this.finishChange(false);
      return true;
    }
    if (name === "sort") {
      const first = range.explicit ? range.first : 1;
      const last = range.explicit ? range.last : this.buffer.lineCount;
      const start = this.buffer.line(first).from;
      const end = this.buffer.line(last).to;
      const lines = sortVimLines(this.buffer.text(start, end).split("\n"), argument, bang, this.runtime.options, this.searchPattern);
      this.beginChange([]); this.apply([{ from: start, to: end, insert: lines.join("\n") }]); this.setCursor(start); this.finishChange(false);
      return true;
    }
    if (["g", "global", "v", "vglobal"].includes(name)) {
      const delimiter = argument[0];
      if (!delimiter) throw new Error("E148: Regular expression missing");
      const parsed = delimited(argument, 1, delimiter);
      const regex = compileVimPattern(parsed.value || this.searchPattern, this.runtime.options, "");
      const selected: number[] = [];
      for (let number = range.explicit ? range.first : 1; number <= (range.explicit ? range.last : this.buffer.lineCount); number += 1) {
        if (regex.test(this.buffer.line(number).text) !== (name === "v" || name === "vglobal" || bang)) selected.push(number);
      }
      this.runExLines(selected, argument.slice(parsed.end).trim() || "print");
      return true;
    }
    if (name === "norm" || name === "normal") {
      if (range.explicit) {
        this.runExLines(Array.from({ length: range.last - range.first + 1 }, (_, index) => range.first + index), `normal${bang ? "!" : ""} ${argument}`);
      } else {
        this.playback.enqueue([...tokenizeVimKeys(argument), "<Esc>"].map((key) => ({ key, remap: !bang, mappingDepth: 0 })));
      }
      return true;
    }
    if (name === "p" || name === "print") { this.message = this.buffer.text(this.buffer.line(range.first).from, this.buffer.line(range.last).to); this.emitStatus(); return true; }
    return false;
  }

  private runExLines(lines: number[], command: string): void {
    if (this.exBatchCount >= 100) throw new Error("E147: Too many nested Ex batches");
    this.exBatchCount += 1;
    const anchors: Array<{ position: number | null }> = lines.map((line) => ({ position: this.buffer.line(line).from }));
    for (const anchor of anchors) this.exLineAnchors.add(anchor);
    this.buffer.beginHistoryGroup();
    this.playback.enqueue(anchors.map((anchor) => ({ run: () => {
      if (this.disposed || anchor.position === null) return;
      this.setCursor(anchor.position);
      return this.executeEx(command);
    } })));
    this.playback.onIdle(() => {
      this.exBatchCount -= 1;
      for (const anchor of anchors) this.exLineAnchors.delete(anchor);
      this.buffer.endHistoryGroup();
      this.flushQueuedKeys();
    });
  }

  private showSubstituteConfirmation(): void {
    const pending = this.confirmation;
    if (!pending) return;
    const edit = pending.edits[pending.index];
    this.setCursor(edit.from + pending.offset);
    this.message = `Replace with ${edit.insert}? (y/n/a/q/l)`;
    this.commandBuffer = this.message;
    this.emitStatus();
  }

  private confirmSubstitute(key: string): boolean {
    const pending = this.confirmation;
    if (!pending) return false;
    if (pending.expected !== this.buffer.text()) key = "q";
    if (!["y", "n", "a", "q", "l", "<Esc>", "<C-c>"].includes(key)) return true;
    if (["y", "a", "l"].includes(key)) {
      do {
        const edit = pending.edits[pending.index++];
        this.apply([{ from: edit.from + pending.offset, to: edit.to + pending.offset, insert: edit.insert }]);
        pending.offset += edit.insert.length - (edit.to - edit.from);
      } while (key === "a" && pending.index < pending.edits.length);
      pending.expected = this.buffer.text();
    } else if (key === "n") pending.index += 1;
    if (["q", "l", "<Esc>", "<C-c>"].includes(key) || pending.index >= pending.edits.length) {
      this.confirmation = null; this.commandBuffer = ""; this.buffer.endHistoryGroup(); this.setMode("normal");
    } else this.showSubstituteConfirmation();
    return true;
  }

  private runHostAction(result: void | Promise<void>): void {
    if (result instanceof Promise) void result.catch((error: unknown) => { if (!this.disposed) this.reportError(errorMessage(error)); });
  }

  private changeNumber(delta: number): void {
    const line = this.buffer.lineAt(this.cursor());
    const start = this.cursor() - line.from;
    const match = [...line.text.matchAll(/-?0[xX][\da-fA-F]+|-?0[bB][01]+|-?\d+/gu)]
      .find((value) => value.index + value[0].length > start);
    if (!match) return;
    const raw = match[0];
    const negative = raw.startsWith("-");
    const unsigned = negative ? raw.slice(1) : raw;
    const base = /^0x/iu.test(unsigned) ? 16 : /^0b/iu.test(unsigned) ? 2 : 10;
    const prefix = base === 10 ? "" : unsigned.slice(0, 2);
    const digits = unsigned.slice(prefix.length);
    const number = BigInt(base === 10 ? unsigned : `${prefix}${digits}`) * (negative ? -1n : 1n) + BigInt(delta);
    let value = (number < 0n ? -number : number).toString(base);
    if (base !== 10) value = value.padStart(digits.length, "0");
    if (/[A-F]/u.test(digits)) value = value.toUpperCase();
    const replacement = `${number < 0n ? "-" : ""}${prefix}${value}`;
    const from = line.from + match.index;
    this.beginChange([]);
    this.apply([{ from, to: from + raw.length, insert: replacement }]);
    this.setCursor(from + replacement.length - 1); this.finishChange();
  }

  private executeSet(argument: string): void {
    if (!argument) {
      this.message = Object.entries(this.runtime.options).map(([key, value]) => `${key}=${String(value)}`).join("  ");
      this.emitStatus();
      return;
    }
    const result = applyVimOptions(this.runtime.options, argument.split(/\s+/u));
    this.buffer.updateOptions?.(this.runtime.options);
    if (result.output.length) this.message = result.output.join("  ");
    if (result.errors.length) this.reportError(result.errors.join("\n"));
    this.emitStatus();
  }

  private recordJump(target: number): void {
    const current = this.cursor();
    if (this.jumpIndex >= 0 && this.jumpIndex < this.jumps.length - 1) {
      this.jumps.splice(this.jumpIndex + 1);
    }
    if (this.jumps.at(-1)?.position !== current) this.jumps.push({ position: current });
    if (this.jumps.at(-1)?.position !== target) this.jumps.push({ position: target });
    while (this.jumps.length > 100) this.jumps.shift();
    this.jumpIndex = this.jumps.length - 1;
  }

  private navigateJump(direction: -1 | 1, count: number): void {
    if (this.jumps.length === 0) return;
    const start = this.jumpIndex < 0 ? this.jumps.length - 1 : this.jumpIndex;
    this.jumpIndex = clamp(start + direction * count, 0, this.jumps.length - 1);
    const jump = this.jumps[this.jumpIndex];
    if (jump) this.setCursor(jump.position);
  }

  private withRegister(name: string, apply: (value: VimRegister) => void): void {
    try {
      const value = this.readRegister(name);
      if (!("then" in value)) { apply(value); return; }
      const generation = ++this.operationGeneration;
      const text = this.buffer.text();
      const cursor = this.cursor();
      const mode = this.modeValue;
      const visual = this.visualSnapshot();
      this.pendingRead = Promise.resolve(value).then((register) => {
        if (this.disposed || generation !== this.operationGeneration) return;
        const currentVisual = this.visualSnapshot();
        if (this.buffer.text() !== text || this.cursor() !== cursor || this.modeValue !== mode
          || visual?.anchor !== currentVisual?.anchor || visual?.head !== currentVisual?.head) throw new Error("Clipboard operation cancelled because the editor changed.");
        apply(register);
      }).catch((error: unknown) => {
        if (!this.disposed && generation === this.operationGeneration) this.reportError(errorMessage(error));
      }).finally(() => {
        if (generation !== this.operationGeneration) return;
        this.pendingRead = null;
        if (!this.playback.busy) this.flushQueuedKeys();
      });
    } catch (error) { this.reportError(errorMessage(error)); }
  }

  private writeRegister(text: string, kind: VimRegisterKind, deleting: boolean, yank: boolean): void {
    if (this.activeRegister === "_") return;
    if (["/", ".", ":", "%", "="].includes(this.activeRegister)) throw new Error("E354: Invalid register for this operation");
    if (kind === "line" && !text.endsWith("\n")) text += "\n";
    const blockWidth = kind === "block" ? this.visualRegister(text).blockWidth : undefined;
    if (yank) this.session.writeYank(this.activeRegister, text, kind, blockWidth);
    else if (deleting) this.session.writeDelete(this.activeRegister, text, kind, kind !== "line" && !text.includes("\n"), blockWidth);
    else this.session.writeRegister(this.activeRegister, text, kind, blockWidth);
    for (const target of clipboardWriteTargets(this.activeRegister, this.runtime.options, yank)) {
      this.writeSystemClipboard(target, { text, kind, ...(blockWidth === undefined ? {} : { blockWidth }) });
    }
  }

  private visualRegister(text: string): VimRegister {
    const kind = this.modeValue === "visual-block" ? "block" : this.modeValue === "visual-line" ? "line" : "character";
    const geometry = kind === "block" ? blockGeometry(this.buffer, this.visualAnchor, this.visualHead, this.runtime.options.tabstop) : null;
    return { text: kind === "line" && !text.endsWith("\n") ? text + "\n" : text, kind,
      ...(geometry ? { blockWidth: geometry.right - geometry.left } : {}) };
  }

  private writeSystemClipboard(target: "+" | "*", value: VimRegister): void {
    try {
      if (!this.clipboard) throw new Error("System clipboard is unavailable.");
      const result = this.clipboard.write(target, value);
      if (result) {
        const pending = Promise.resolve(result).catch((error: unknown) => { if (!this.disposed) this.reportError(errorMessage(error)); })
          .finally(() => { this.pendingWrites.delete(pending); });
        this.pendingWrites.add(pending);
      }
    } catch (error) { this.reportError(errorMessage(error)); }
  }

  private flushQueuedKeys(): void {
    if (this.disposed) return;
    while (this.queuedKeys.length && !this.busy) {
      const key = this.queuedKeys.shift()!;
      try { this.replayMacroKey(key); }
      catch (error) { this.reportError(errorMessage(error)); this.queuedKeys.length = 0; this.finishChange(false); }
    }
  }

  private afterCursor(): number {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    return cursor < line.to ? nextCharacterPosition(this.buffer.text(), cursor) : line.to;
  }

  private cursor(): number {
    return this.buffer.selections()[0]?.head ?? 0;
  }

  private apply(edits: readonly VimEdit[], selections?: readonly VimSelection[], positionMap?: (position: number) => number): void {
    if (this.buffer.readOnly) throw new Error("E21: Cannot make changes, buffer is read-only");
    if (edits.length === 0) {
      if (selections) this.buffer.setSelections(selections);
      return;
    }
    for (const anchor of positionMap ? [] : this.exLineAnchors) {
      if (anchor.position !== null && edits.some((edit) => edit.from <= anchor.position! && edit.to > anchor.position!)) anchor.position = null;
    }
    this.buffer.apply(edits, selections);
    this.mapDocumentPositions(positionMap ?? ((position) => mapPositionThroughEdits(position, edits)));
  }

  private setCursor(position: number, allowLineEnd = false): void {
    const safe = characterStart(this.buffer.text(), clamp(position, 0, this.buffer.length));
    const line = this.buffer.lineAt(safe);
    const maximum = allowLineEnd ? line.to : Math.max(line.from, previousCharacterPosition(this.buffer.text(), line.to));
    const cursor = clamp(safe, line.from, maximum);
    this.buffer.setSelections([{ anchor: cursor, head: cursor }]);
  }

  private setMode(mode: VimMode): void {
    this.modeValue = mode;
    if (mode === "normal" || mode === "insert") { this.selectMode = false; this.virtualReplace = false; }
    this.emitStatus();
  }

  private takeCount(): number {
    return this.takeCountState().value;
  }

  private takeCountState(): VimCount {
    const explicit = this.countDigits.length > 0;
    const value = Math.max(1, Number.parseInt(this.countDigits || "1", 10));
    this.countDigits = "";
    if (!Number.isSafeInteger(value)) throw new Error("E521: Vim count exceeds the safe integer range");
    return { value, explicit };
  }

  private restoreCount(count: VimCount): void {
    this.countDigits = count.explicit ? String(count.value) : "";
  }

  private resetCommandState(): void {
    this.countDigits = "";
    this.pendingPrefix = "";
    this.pendingFind = null;
    this.pendingTextObject = null;
    this.pendingReplace = false;
    this.mappingBuffer = [];
    this.emitStatus();
  }

  private pendingDisplay(): string {
    const operator = this.pendingOperator ? operatorKey(this.pendingOperator.name) : "";
    return `${this.activeRegister === '"' ? "" : `"${this.activeRegister}`}${this.countDigits}${operator}${this.pendingPrefix}${this.pendingTextObject === "inside" ? "i" : this.pendingTextObject === "around" ? "a" : ""}`;
  }

  private emitStatus(): void {
    this.hooks.onStatus?.(this.status);
    for (const listener of this.subscribers) listener(this.status);
  }

  private reportError(message: string): void {
    this.errorSequence += 1;
    this.message = message;
    this.hooks.onError?.(message);
    this.emitStatus();
  }

  private queueAutocmd(event: VimAutocmdEvent): void {
    void this.runAutocmd(event, this.buffer.id);
  }

  private async writeCurrentBuffer(): Promise<boolean> {
    if (this.autocmdDepth > 0) {
      throw new Error("Nested :write from an autocmd is not supported.");
    }
    const bufferId = this.buffer.id;
    if (!await this.runAutocmd("BufWritePre", bufferId) || this.disposed || this.buffer.id !== bufferId) return false;
    try {
      await this.hooks.saveCurrentView?.();
    } catch (error) {
      this.reportError(errorMessage(error));
      return false;
    }
    if (this.disposed || this.buffer.id !== bufferId) return false;
    const completed = await this.runAutocmd("BufWritePost", bufferId);
    return completed && !this.disposed && this.buffer.id === bufferId;
  }

  private result(handled: boolean): VimHandleResult {
    return { handled, mode: this.mode };
  }

  private isVisualMode(): boolean {
    return this.modeValue === "visual" || this.modeValue === "visual-line" || this.modeValue === "visual-block";
  }

  private replaceSelect(text: string): void {
    this.selectMode = false;
    if (this.modeValue === "visual-line") {
      const range = this.visualRanges()[0];
      this.applyOperatorRange("change", range.anchor, range.head, false, ["c"]);
    } else this.applyVisualOperator("change", ["c"]);
    this.insertLiteral(text);
  }
}

function visualSnapshotsEqual(
  left: VimVisualSnapshot | null,
  right: VimVisualSnapshot,
): boolean {
  return left !== null &&
    left.mode === right.mode &&
    left.anchor === right.anchor &&
    left.head === right.head &&
    left.activePosition === right.activePosition &&
    left.ranges.length === right.ranges.length &&
    left.ranges.every((range, index) => {
      const candidate = right.ranges[index];
      return candidate?.anchor === range.anchor && candidate.head === range.head;
    });
}

function operatorKey(name: OperatorName): string {
  if (name === "delete") return "d";
  if (name === "change") return "c";
  if (name === "yank") return "y";
  if (name === "indent") return ">";
  if (name === "outdent") return "<";
  if (name === "format") return "=";
  if (name === "reflow") return "gq";
  if (name === "swapcase") return "g~";
  if (name === "lowercase") return "gu";
  return "gU";
}

function transformCase(text: string, name: OperatorName): string {
  if (name === "lowercase") return text.toLocaleLowerCase();
  if (name === "uppercase") return text.toLocaleUpperCase();
  if (name !== "swapcase") return text;
  return [...text].map((character) => {
    const upper = character.toLocaleUpperCase();
    const lower = character.toLocaleLowerCase();
    return character === upper ? lower : upper;
  }).join("");
}

function nextCharacterPosition(text: string, position: number): number {
  return nextCharacter(text, position);
}

function previousCharacterPosition(text: string, position: number): number {
  return previousCharacter(text, position);
}

function nextGraphemePosition(text: string, position: number): number {
  if (position >= text.length) return text.length;
  const next = iterateCharacters(text.slice(position)).next();
  const first = next.done ? undefined : next.value;
  return Math.min(text.length, position + (first?.length ?? 1));
}

function graphemes(text: string): string[] {
  return characters(text);
}

function removeLastGrapheme(text: string): string {
  const parts = graphemes(text);
  parts.pop();
  return parts.join("");
}

function isLiteralTextToken(key: string): boolean {
  return !key.startsWith("<") && graphemes(key).length === 1;
}

function cloneRuntime(runtime: VimRuntimeConfig): VimRuntimeConfig {
  return {
    mapleader: runtime.mapleader,
    options: { ...runtime.options },
    mappings: runtime.mappings,
    abbreviations: runtime.abbreviations,
    exCommands: runtime.exCommands,
    autocmds: runtime.autocmds,
  };
}

function previousWordEnd(text: string, cursor: number, bigWord: boolean, count: number, iskeyword: string): number {
  let position = cursor;
  const classify = (at: number) => wordClass(characterAt(text, at), bigWord, iskeyword);
  for (let iteration = 0; iteration < count; iteration += 1) {
    const currentClass = classify(position);
    position = previousCharacter(text, position);
    if (currentClass !== "space") while (position > 0 && classify(position) === currentClass) position = previousCharacter(text, position);
    while (position > 0 && classify(position) === "space") position = previousCharacter(text, position);
  }
  return position;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startsWith(values: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= values.length && prefix.every((value, index) => values[index] === value);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function opposite(direction: -1 | 1): -1 | 1 {
  return direction === 1 ? -1 : 1;
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function mapPositionThroughEdits(position: number, edits: readonly VimEdit[]): number {
  let delta = 0;
  const ordered = [...edits].sort((left, right) => left.from - right.from);
  for (const edit of ordered) {
    const from = Math.min(edit.from, edit.to);
    const to = Math.max(edit.from, edit.to);
    if (position < from) break;
    if (position >= to) {
      delta += edit.insert.length - (to - from);
      continue;
    }
    return from + delta + edit.insert.length;
  }
  return position + delta;
}

export { tokenizeVimKeys };
