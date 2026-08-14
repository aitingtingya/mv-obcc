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
import { textObjectRange } from "./text-objects";
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
  private recordedMacro: string[] = [];
  private mappingBuffer: string[] = [];
  private insertMappingBuffer: string[] = [];
  private mappingDepth = 0;
  private desiredColumn: number | undefined;
  private visualAnchor = 0;
  private visualHead = 0;
  private commandPrefix: ":" | "/" | "?" = ":";
  private commandBuffer = "";
  private message = "";
  private searchPattern = "";
  private searchDirection: -1 | 1 = 1;
  private readonly marks = new Map<string, number>();
  private readonly jumps: JumpEntry[] = [];
  private jumpIndex = -1;
  private lastChange: string[] = [];
  private currentChange: string[] | null = null;
  private replayingChange = false;
  private lastInsertedText = "";
  private insertExitCursorOnEmpty: number | null = null;
  private externalCommandsAllowed = false;
  private insertMappingsAllowed = true;
  private autocmdTail: Promise<void> = Promise.resolve();
  private autocmdDepth = 0;
  private readonly queuedAutocmds = new Set<string>();
  private disposed = false;

  constructor(
    private readonly buffer: VimBuffer,
    private runtime: VimRuntimeConfig = EMPTY_RUNTIME,
    private readonly session = new VimSession(),
    private readonly hooks: VimEngineHooks = {},
  ) {
    this.runtime = cloneRuntime(runtime);
    this.emitStatus();
  }

  get mode(): VimMode {
    return this.modeValue;
  }

  get status(): VimStatus {
    return {
      mode: this.modeValue,
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
    if (!key) return this.result(false);
    if (this.modeValue !== "insert" || this.insertMappingsAllowed) {
      const mapped = this.resolveMapping(key);
      if (mapped !== null) return this.result(mapped);
    }
    return this.result(this.handleDirectKey(key));
  }

  get hasPendingMapping(): boolean {
    return this.mappingBuffer.length > 0 || this.insertMappingBuffer.length > 0;
  }

  get awaitingInsertKey(): boolean {
    return (this.modeValue === "insert" || this.modeValue === "replace") &&
      this.pendingRegister;
  }

  get textInputTarget(): VimTextInputTarget {
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
    if (this.modeValue === "replace") {
      if (this.recordingRegister) this.recordedMacro.push(...[...text]);
      this.replaceInput(text);
      return true;
    }
    if (this.modeValue !== "insert" || text.length === 0) return false;
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
    if (handled && this.recordingRegister) this.recordedMacro.push(...tokens);
    return handled;
  }

  /** Records text inserted by CodeMirror's native input path for dot-repeat. */
  noteNativeInsert(text: string): void {
    if (this.modeValue !== "insert" || !text) return;
    if (this.recordingRegister) this.recordedMacro.push(...graphemes(text));
    this.lastInsertedText += text;
    this.currentChange?.push(...graphemes(text));
  }

  /** Commits final IME text without passing it through mappings or abbreviations. */
  commitComposedText(text: string): boolean {
    if (!text) return false;
    if (this.modeValue === "insert") {
      this.noteNativeInsert(text);
      return true;
    }
    if (this.modeValue === "replace") {
      if (this.recordingRegister) this.recordedMacro.push(...graphemes(text));
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
    this.hooks.writeClipboard?.(text);
    return text;
  }

  cutVisualToClipboard(): string | null {
    const text = this.visualSelectionText();
    if (text === null) return null;
    this.hooks.writeClipboard?.(text);
    this.applyVisualOperator("delete", ["<C-x>"]);
    return text;
  }

  /** Keeps stored document positions valid across Vim and host transactions. */
  mapDocumentPositions(mapper: (position: number) => number): void {
    const map = (position: number) => clamp(mapper(position), 0, this.buffer.length);
    for (const [name, position] of this.marks) this.marks.set(name, map(position));
    for (const jump of this.jumps) jump.position = map(jump.position);
    this.visualAnchor = map(this.visualAnchor);
    this.visualHead = map(this.visualHead);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mappingBuffer = [];
    this.insertMappingBuffer = [];
    this.pendingOperator = null;
    this.queuedAutocmds.clear();
    this.currentChange = null;
  }

  private handleDirectKey(key: string): boolean {
    if (this.recordingRegister && key !== "q") this.recordedMacro.push(key);
    if (this.modeValue === "command-line") return this.handleCommandLineKey(key);
    if (this.modeValue === "insert" || this.modeValue === "replace") {
      return this.handleInsertKey(key);
    }
    if (this.isVisualMode()) return this.handleVisualKey(key);
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

    if (key === '"') {
      this.pendingRegister = true;
      this.emitStatus();
      return true;
    }
    if (key === "q") {
      if (this.recordingRegister) {
        this.session.setMacro(this.recordingRegister, this.recordedMacro);
        this.recordingRegister = null;
        this.recordedMacro = [];
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
        this.beginChange([key]);
        this.lastInsertedText = "";
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
        this.applyToLineEnd("delete", [key]);
        return true;
      case "C":
        this.applyToLineEnd("change", [key]);
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
      case "u":
        this.buffer.undo();
        this.setCursor(this.cursor());
        return true;
      case "<C-r>":
        this.buffer.redo();
        this.setCursor(this.cursor());
        return true;
      case ".":
        this.repeatLastChange(count.value);
        return true;
      case ":":
      case "/":
      case "?":
        this.enterCommandLine(key);
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
    if (this.pendingTextObject) {
      const motionCount = this.takeCountState();
      const object = textObjectRange(
        this.buffer,
        this.cursor(),
        key,
        this.pendingTextObject === "around",
        operator.count * motionCount.value,
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
    if (key === doubled || (operator.name === "lowercase" && key === "u") || (operator.name === "uppercase" && key === "U")) {
      this.applyLineOperator(operator.name, operator.count * this.takeCount(), operator.keys.concat(key));
      return true;
    }
    const followingCount = this.takeCountState();
    const motionCount = operator.count * followingCount.value;
    const motion = this.motionForKey(
      key,
      motionCount,
      operator.countExplicit || followingCount.explicit,
    );
    if (motion) {
      const range = this.rangeForMotion(this.cursor(), motion);
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
    if (key === "<Esc>") {
      this.exitVisual();
      return true;
    }
    if (key === "o") {
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
      if (this.lastInsertedText.length === 0 && this.insertExitCursorOnEmpty !== null) {
        this.setCursor(this.insertExitCursorOnEmpty);
      } else {
        const line = this.buffer.lineAt(this.cursor());
        this.setCursor(Math.max(line.from, this.cursor() - 1));
      }
      this.insertExitCursorOnEmpty = null;
      this.setMode("normal");
      this.finishChange();
      this.queueAutocmd("InsertLeave");
      return true;
    }
    if (key === "<C-w>") {
      const cursor = this.cursor();
      const motion = wordMotion(this.buffer, cursor, "backward", 1, false);
      this.apply([{ from: motion.target, to: cursor, insert: "" }], [{ anchor: motion.target, head: motion.target }]);
      this.currentChange?.push(key);
      return true;
    }
    if (key === "<C-u>") {
      const cursor = this.cursor();
      const from = this.buffer.lineAt(cursor).from;
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
      const value = this.readRegister(key);
      this.insertLiteral(value.text);
      return true;
    }
    return false;
  }

  private handleCommandLineKey(key: string): boolean {
    if (key === "<Esc>" || key === "<C-c>") {
      this.commandBuffer = "";
      this.setMode("normal");
      return true;
    }
    if (key === "<BS>") {
      if (this.commandBuffer.length === 0) {
        this.setMode("normal");
      } else {
        this.commandBuffer = removeLastGrapheme(this.commandBuffer);
        this.emitStatus();
      }
      return true;
    }
    if (key === "<CR>" || key === "Enter") {
      const command = this.commandBuffer;
      const prefix = this.commandPrefix;
      this.commandBuffer = "";
      this.setMode("normal");
      if (prefix === ":") {
        void this.executeEx(command).catch((error: unknown) => {
          this.reportError(errorMessage(error));
        });
      }
      else this.executeSearch(command, prefix === "/" ? 1 : -1);
      return true;
    }
    if (key.length === 1) {
      this.commandBuffer += key;
      this.emitStatus();
      return true;
    }
    return true;
  }

  private consumeAwaitingKey(key: string): boolean {
    if (this.pendingRegister) {
      this.activeRegister = key[0] ?? '"';
      this.pendingRegister = false;
      this.emitStatus();
      return true;
    }
    if (this.pendingMarkSet) {
      this.marks.set(key[0] ?? "", this.cursor());
      this.pendingMarkSet = false;
      this.emitStatus();
      return true;
    }
    if (this.pendingMarkJump) {
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
        this.recordedMacro = [];
      } else {
        const count = this.takeCount();
        const macro = this.session.readMacro(key);
        for (let iteration = 0; iteration < count; iteration += 1) {
          for (const macroKey of macro) this.replayMacroKey(macroKey);
        }
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
      this.replaceCharacters(key, count);
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
        const target = previousWordEnd(this.buffer.text(), this.isVisualMode() ? this.visualHead : this.cursor(), key === "E", count.value);
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
              : "format";
        if (this.isVisualMode()) this.applyVisualOperator(name, ["g", key]);
        else this.startOperator(name, count.value, count.explicit, ["g", key]);
        return true;
      }
      if (key === "j" || key === "k") {
        const motion = verticalMotion(this.buffer, this.cursor(), key === "j" ? 1 : -1, count.value, this.desiredColumn);
        this.desiredColumn = motion.desiredColumn;
        this.move(motion);
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
      case "h":
      case "<Left>":
        this.desiredColumn = undefined;
        return horizontalMotion(this.buffer, cursor, -1, count);
      case "l":
      case "<Right>":
      case " ":
        this.desiredColumn = undefined;
        return horizontalMotion(this.buffer, cursor, 1, count);
      case "j":
      case "<Down>": {
        const motion = verticalMotion(this.buffer, cursor, 1, count, this.desiredColumn);
        this.desiredColumn = motion.desiredColumn;
        return motion;
      }
      case "k":
      case "<Up>": {
        const motion = verticalMotion(this.buffer, cursor, -1, count, this.desiredColumn);
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
        return lineBoundaryMotion(this.buffer, cursor, "end");
      case "w":
        return wordMotion(this.buffer, cursor, "forward", count, false);
      case "W":
        return wordMotion(this.buffer, cursor, "forward", count, true);
      case "b":
        return wordMotion(this.buffer, cursor, "backward", count, false);
      case "B":
        return wordMotion(this.buffer, cursor, "backward", count, true);
      case "e":
        return wordMotion(this.buffer, cursor, "end", count, false);
      case "E":
        return wordMotion(this.buffer, cursor, "end", count, true);
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
        return matchingBracketMotion(this.buffer, cursor);
      case "|":
        return columnMotion(this.buffer, cursor, count);
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
      const text = this.buffer.text(from, to);
      this.writeRegister(text, linewise ? "line" : "character", false, true);
      this.setCursor(from);
      this.finishOperator();
      return;
    }
    if (name === "delete" || name === "change") {
      const text = this.buffer.text(from, to);
      this.beginChange(keys);
      this.writeRegister(text, linewise ? "line" : "character", true, false);
      this.apply([{ from, to, insert: "" }], [{ anchor: from, head: from }]);
      this.finishOperator();
      if (name === "change") this.enterInsert(from, keys, false);
      else {
        this.finishChange();
      }
      return;
    }
    if (name === "indent" || name === "outdent" || name === "format") {
      this.beginChange(keys);
      this.indentRange(from, to, name === "outdent" ? -1 : 1);
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

  private applyToLineEnd(name: OperatorName, keys: string[]): void {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    this.applyOperatorRange(name, cursor, line.to, false, keys);
  }

  private applyVisualOperator(name: OperatorName, keys: string[]): void {
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
      return;
    }
    if (name === "delete" || name === "change") {
      this.beginChange(keys);
      this.writeRegister(text, "block", true, false);
      const from = ordered[0]?.from ?? this.cursor();
      this.apply(
        ordered.map((range) => ({ ...range, insert: "" })),
        [{ anchor: from, head: from }],
      );
      if (name === "change") this.enterInsert(from, keys, false);
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
    const from = direction > 0 ? cursor : Math.max(line.from, cursor - count);
    const to = direction > 0 ? Math.min(line.to, cursor + count) : cursor;
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
    const to = Math.min(line.to, cursor + count);
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
    const to = Math.min(line.to, cursor + count);
    if (to <= cursor) return;
    const replacement = character === "<CR>" ? "\n" : character.repeat(to - cursor);
    this.apply([{ from: cursor, to, insert: replacement }], [{ anchor: cursor, head: cursor }]);
    this.currentChange?.push(character);
    this.finishChange();
  }

  private put(after: boolean, count: number, keys: string[]): void {
    const register = this.readRegister(this.activeRegister);
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
      this.putBlock(register.text, after, count);
    } else {
      const at = after ? this.afterCursor() : this.cursor();
      const text = register.text.repeat(count);
      this.apply([{ from: at, to: at, insert: text }], [{ anchor: Math.max(at, at + text.length - 1), head: Math.max(at, at + text.length - 1) }]);
      this.setCursor(Math.max(at, at + text.length - 1));
    }
    this.activeRegister = '"';
    this.finishChange();
  }

  private putBlock(text: string, after: boolean, count: number): void {
    const rows = text.split("\n");
    const sourceLine = this.buffer.lineAt(this.cursor());
    const column = this.cursor() - sourceLine.from + (after ? 1 : 0);
    const edits = [];
    for (let index = 0; index < rows.length; index += 1) {
      const lineNumber = sourceLine.number + index;
      if (lineNumber > this.buffer.lineCount) break;
      const line = this.buffer.line(lineNumber);
      const padding = Math.max(0, column - line.text.length);
      const at = line.from + Math.min(column, line.text.length);
      edits.push({ from: at, to: at, insert: `${" ".repeat(padding)}${rows[index].repeat(count)}` });
    }
    this.apply(edits, [{ anchor: this.cursor(), head: this.cursor() }]);
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
    const width = Math.max(1, this.runtime.options.shiftwidth);
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

  private openLine(direction: -1 | 1, keys: string[]): void {
    const line = this.buffer.lineAt(this.cursor());
    const indentation = line.text.match(/^\s*/)?.[0] ?? "";
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
    this.desiredColumn = undefined;
    this.visualAnchor = this.cursor();
    this.visualHead = this.cursor();
    this.modeValue = mode;
    this.updateVisualSelections();
  }

  private exitVisual(): void {
    const cursor = this.visualHead;
    this.modeValue = "normal";
    this.setCursor(cursor);
    this.emitStatus();
  }

  private enterVisualBlockInsert(after: boolean, keys: string[]): void {
    const ranges = this.visualRanges().map((range) => {
      const from = Math.min(range.anchor, range.head);
      const to = Math.max(range.anchor, range.head);
      const at = after ? to : from;
      return { anchor: at, head: at };
    });
    this.beginChange(keys);
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
      const anchorLine = this.buffer.lineAt(this.visualAnchor);
      const headLine = this.buffer.lineAt(this.visualHead);
      const firstLine = Math.min(anchorLine.number, headLine.number);
      const lastLine = Math.max(anchorLine.number, headLine.number);
      const anchorColumn = this.visualAnchor - anchorLine.from;
      const headColumn = this.visualHead - headLine.from;
      const left = Math.min(anchorColumn, headColumn);
      const right = Math.max(anchorColumn, headColumn) + 1;
      const ranges: VimSelection[] = [];
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        const line = this.buffer.line(lineNumber);
        const from = line.from + Math.min(left, line.text.length);
        const to = line.from + Math.min(right, line.text.length);
        ranges.push(headColumn < anchorColumn
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
    const register = this.readRegister(this.activeRegister);
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
    this.writeRegister(removed, this.modeValue === "visual-line" ? "line" : this.modeValue === "visual-block" ? "block" : "character", true, false);
    const cursor = edits[0]?.from ?? this.cursor();
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
    const mappings = this.runtime.mappings.filter((mapping) => mapping.modes.includes(this.modeValue));
    if (mappings.length === 0 || this.mappingDepth > 20) return null;
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
    if (mappings.length === 0 || this.mappingDepth > 20) return null;
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
    this.mappingDepth += 1;
    try {
      for (const key of mapping.rhs) {
        if (this.modeValue === "insert" && key.length === 1) {
          if (mapping.recursive) {
            const handled = this.resolveInsertMapping(key);
            if (handled === null) this.insertLiteral(key);
          } else {
            this.insertLiteral(key);
          }
        } else if (mapping.recursive) {
          this.handleKey(key);
        } else {
          this.handleDirectKey(key);
        }
      }
    } finally {
      this.mappingDepth -= 1;
    }
  }

  private replayMacroKey(key: string): void {
    if (
      (this.modeValue === "insert" || this.modeValue === "replace") &&
      isLiteralTextToken(key)
    ) {
      if (!this.handleInsertInput(key)) this.insertLiteral(key);
      return;
    }
    this.handleDirectKey(key);
  }

  private expandAbbreviation(delimiter: string): boolean {
    if (!/\s|[.,;:!?()[\]{}]/u.test(delimiter)) return false;
    const cursor = this.cursor();
    const prefix = this.buffer.text(0, cursor);
    const match = prefix.match(/[^\s.,;:!?()[\]{}]+$/u);
    if (!match || match.index === undefined) return false;
    const abbreviation = this.runtime.abbreviations.find((entry) => entry.lhs === match[0]);
    if (!abbreviation) return false;
    this.apply(
      [{ from: match.index, to: cursor, insert: abbreviation.rhs + delimiter }],
      [{ anchor: match.index + abbreviation.rhs.length + delimiter.length, head: match.index + abbreviation.rhs.length + delimiter.length }],
    );
    this.currentChange?.push(...[...abbreviation.rhs], delimiter);
    return true;
  }

  private insertLiteral(text: string): void {
    if (!text) return;
    const selections = this.buffer.selections();
    const edits = selections.map((selection) => ({
      from: Math.min(selection.anchor, selection.head),
      to: Math.max(selection.anchor, selection.head),
      insert: text,
    }));
    const nextSelections = edits.map((edit) => ({
      anchor: edit.from + text.length,
      head: edit.from + text.length,
    }));
    this.apply(edits, nextSelections);
    this.lastInsertedText += text;
    this.currentChange?.push(...graphemes(text));
  }

  private replaceInput(text: string): void {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    let to = cursor;
    for (let index = 0; index < graphemes(text).length && to < line.to; index += 1) {
      to = nextGraphemePosition(this.buffer.text(), to);
    }
    this.apply([{ from: cursor, to, insert: text }], [{ anchor: cursor + text.length, head: cursor + text.length }]);
    this.lastInsertedText += text;
    this.currentChange?.push(...graphemes(text));
  }

  private repeatLastChange(count: number): void {
    if (this.lastChange.length === 0 || this.replayingChange) return;
    this.replayingChange = true;
    this.buffer.beginHistoryGroup();
    try {
      for (let iteration = 0; iteration < count; iteration += 1) {
        for (const key of this.lastChange) {
          if (this.modeValue === "insert" && isLiteralTextToken(key)) {
            this.insertLiteral(key);
          } else if (this.modeValue === "replace" && isLiteralTextToken(key)) {
            this.replaceInput(key);
          }
          else this.handleDirectKey(key);
        }
        if (this.modeValue === "insert") this.handleDirectKey("<Esc>");
      }
    } finally {
      this.buffer.endHistoryGroup();
      this.replayingChange = false;
    }
  }

  private beginChange(keys: string[]): void {
    if (this.replayingChange) return;
    if (!this.currentChange) {
      this.currentChange = [...keys];
      this.buffer.beginHistoryGroup();
    }
  }

  private finishChange(record = true): void {
    if (this.replayingChange) return;
    if (record && this.currentChange && this.currentChange.length > 0) {
      this.lastChange = [...this.currentChange];
    }
    if (this.currentChange) this.buffer.endHistoryGroup();
    this.currentChange = null;
  }

  private enterCommandLine(prefix: ":" | "/" | "?"): void {
    this.commandPrefix = prefix;
    this.commandBuffer = "";
    this.setMode("command-line");
  }

  private executeSearch(pattern: string, direction: -1 | 1): void {
    if (!pattern) return;
    this.searchPattern = pattern;
    this.searchDirection = direction;
    this.repeatSearch(direction, 1);
  }

  private repeatSearch(direction: -1 | 1, count: number): void {
    if (!this.searchPattern) return;
    const regex = this.searchRegex(this.searchPattern);
    if (!regex) return;
    const text = this.buffer.text();
    let cursor = this.cursor();
    for (let iteration = 0; iteration < count; iteration += 1) {
      const matches = [...text.matchAll(regex)].map((match) => match.index ?? 0);
      if (matches.length === 0) return;
      const target = direction > 0
        ? matches.find((position) => position > cursor) ?? matches[0]
        : [...matches].reverse().find((position) => position < cursor) ?? matches[matches.length - 1];
      cursor = target;
    }
    this.recordJump(cursor);
    this.setCursor(cursor);
  }

  private searchRegex(pattern: string): RegExp | null {
    try {
      const smartSensitive = this.runtime.options.smartcase && /[A-Z]/.test(pattern);
      const flags = this.runtime.options.ignorecase && !smartSensitive ? "giu" : "gu";
      return new RegExp(pattern, flags);
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : String(error));
      return null;
    }
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
    let command = rawCommand.trim();
    if (!command) return;
    const firstWord = command.split(/\s+/, 1)[0] ?? "";
    const alias = this.runtime.exCommands.get(firstWord);
    if (alias) command = `${alias}${command.slice(firstWord.length)}`.trim();

    if (/^w(?:rite)?!?$/u.test(command)) {
      await this.writeCurrentBuffer();
      return;
    }
    if (/^q(?:uit)?!?$/u.test(command)) {
      await this.hooks.onQuit?.(command.endsWith("!"));
      return;
    }
    if (/^(?:wq|x)!?$/u.test(command)) {
      if (await this.writeCurrentBuffer()) {
        await this.hooks.onQuit?.(command.endsWith("!"));
      }
      return;
    }
    if (/^(?:noh|nohl|nohlsearch)$/u.test(command)) {
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
    const substitute = parseSubstitute(command);
    if (substitute) {
      this.executeSubstitute(
        substitute.pattern,
        substitute.replacement,
        substitute.allMatches,
        substitute.wholeBuffer,
      );
      return;
    }
    if (/^(?:%?sort)!?$/u.test(command)) {
      this.sortLines(command.endsWith("!"));
      return;
    }
    const normal = command.match(/^normal!?\s+(.+)$/u);
    if (normal) {
      for (const key of tokenizeVimKeys(normal[1])) this.handleDirectKey(key);
      return;
    }
    this.reportError(`Unsupported Vim command: ${command}`);
  }

  private executeSet(argument: string): void {
    if (!argument) {
      this.message = Object.entries(this.runtime.options).map(([key, value]) => `${key}=${String(value)}`).join("  ");
      this.emitStatus();
      return;
    }
    for (const token of argument.split(/\s+/)) {
      const assignment = token.match(/^([a-z]+)=(.+)$/u);
      if (assignment) {
        const name = optionName(assignment[1]);
        if (!name) continue;
        const current = this.runtime.options[name];
        (this.runtime.options as unknown as Record<string, unknown>)[name] = typeof current === "number"
          ? Math.max(1, Number.parseInt(assignment[2], 10) || current)
          : assignment[2];
        continue;
      }
      const disabled = token.startsWith("no");
      const toggled = token.startsWith("inv");
      const rawName = disabled ? token.slice(2) : toggled ? token.slice(3) : token;
      const name = optionName(rawName.replace(/[!?]$/u, ""));
      if (!name) continue;
      const current = this.runtime.options[name];
      if (typeof current === "boolean") {
        (this.runtime.options as unknown as Record<string, unknown>)[name] = toggled ? !current : !disabled;
      }
    }
    this.emitStatus();
  }

  private executeSubstitute(pattern: string, replacement: string, global: boolean, wholeBuffer: boolean): void {
    try {
      const line = this.buffer.lineAt(this.cursor());
      const from = wholeBuffer ? 0 : line.from;
      const to = wholeBuffer ? this.buffer.length : line.to;
      const flags = `${global ? "g" : ""}${this.runtime.options.ignorecase ? "i" : ""}u`;
      const regex = new RegExp(pattern, flags);
      const original = this.buffer.text(from, to);
      const next = original.replace(regex, replacement.replace(/\\([0-9])/g, "$$$1"));
      if (next === original) return;
      this.beginChange([":", "substitute"]);
      this.apply([{ from, to, insert: next }], [{ anchor: from, head: from }]);
      this.setCursor(from);
      this.finishChange();
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : String(error));
    }
  }

  private sortLines(reverse: boolean): void {
    const lines = this.buffer.text().split("\n").sort((left, right) => left.localeCompare(right));
    if (reverse) lines.reverse();
    this.beginChange([":", "sort"]);
    this.apply([{ from: 0, to: this.buffer.length, insert: lines.join("\n") }], [{ anchor: 0, head: 0 }]);
    this.finishChange();
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

  private readRegister(name: string) {
    const normalized = name || '"';
    if (normalized === "+" || normalized === "*") {
      return { text: this.hooks.readClipboard?.() ?? "", kind: "character" as const };
    }
    if (normalized === "=") return { text: "", kind: "character" as const };
    return this.session.readRegister(normalized);
  }

  private writeRegister(text: string, kind: VimRegisterKind, deleting: boolean, yank: boolean): void {
    if (this.activeRegister === "+" || this.activeRegister === "*") this.hooks.writeClipboard?.(text);
    if (yank) this.session.writeYank(this.activeRegister, text, kind);
    else if (deleting) this.session.writeDelete(this.activeRegister, text, kind, kind === "character" && !text.includes("\n"));
    else this.session.writeRegister(this.activeRegister, text, kind);
    if (this.runtime.options.clipboard) this.hooks.writeClipboard?.(text);
  }

  private afterCursor(): number {
    const cursor = this.cursor();
    const line = this.buffer.lineAt(cursor);
    return cursor < line.to ? nextCharacterPosition(this.buffer.text(), cursor) : line.to;
  }

  private cursor(): number {
    return this.buffer.selections()[0]?.head ?? 0;
  }

  private apply(edits: readonly VimEdit[], selections?: readonly VimSelection[]): void {
    if (edits.length === 0) {
      if (selections) this.buffer.setSelections(selections);
      return;
    }
    this.buffer.apply(edits, selections);
    this.mapDocumentPositions((position) => mapPositionThroughEdits(position, edits));
  }

  private setCursor(position: number, allowLineEnd = false): void {
    const safe = clamp(position, 0, this.buffer.length);
    const line = this.buffer.lineAt(safe);
    const maximum = allowLineEnd ? line.to : Math.max(line.from, line.to - 1);
    const cursor = clamp(safe, line.from, maximum);
    this.buffer.setSelections([{ anchor: cursor, head: cursor }]);
  }

  private setMode(mode: VimMode): void {
    this.modeValue = mode;
    this.emitStatus();
  }

  private takeCount(): number {
    return this.takeCountState().value;
  }

  private takeCountState(): VimCount {
    const explicit = this.countDigits.length > 0;
    const value = Math.max(1, Number.parseInt(this.countDigits || "1", 10));
    this.countDigits = "";
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
  }

  private reportError(message: string): void {
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
    if (!await this.runAutocmd("BufWritePre", this.buffer.id)) return false;
    try {
      await this.hooks.saveCurrentView?.();
    } catch (error) {
      this.reportError(errorMessage(error));
      return false;
    }
    return this.runAutocmd("BufWritePost", this.buffer.id);
  }

  private result(handled: boolean): VimHandleResult {
    return { handled, mode: this.modeValue };
  }

  private isVisualMode(): boolean {
    return this.modeValue === "visual" || this.modeValue === "visual-line" || this.modeValue === "visual-block";
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
  if (position >= text.length) return text.length;
  const code = text.codePointAt(position);
  return Math.min(text.length, position + (code !== undefined && code > 0xffff ? 2 : 1));
}

function previousCharacterPosition(text: string, position: number): number {
  if (position <= 0) return 0;
  const previous = position - 1;
  const code = text.charCodeAt(previous);
  if (code >= 0xdc00 && code <= 0xdfff && previous > 0) {
    const lead = text.charCodeAt(previous - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) return previous - 1;
  }
  return previous;
}

function nextGraphemePosition(text: string, position: number): number {
  if (position >= text.length) return text.length;
  const first = graphemes(text.slice(position))[0];
  return Math.min(text.length, position + (first?.length ?? 1));
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: "grapheme" },
    ) => { segment(value: string): Iterable<{ segment: string }> };
  }).Segmenter;
  if (!Segmenter) return [...text];
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .map((entry) => entry.segment);
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
    options: { ...runtime.options },
    mappings: runtime.mappings,
    abbreviations: runtime.abbreviations,
    exCommands: runtime.exCommands,
    autocmds: runtime.autocmds,
  };
}

function previousWordEnd(text: string, cursor: number, bigWord: boolean, count: number): number {
  let position = Math.max(0, cursor - 1);
  const classify = (character: string) => {
    if (/\s/u.test(character)) return "space";
    if (bigWord || /[\p{L}\p{N}_]/u.test(character)) return "word";
    return "punctuation";
  };
  for (let iteration = 0; iteration < count; iteration += 1) {
    while (position > 0 && classify(text[position] ?? "") === "space") position -= 1;
    const targetClass = classify(text[position] ?? "");
    while (position > 0 && classify(text[position - 1] ?? "") === targetClass) position -= 1;
    while (position < text.length - 1 && classify(text[position + 1] ?? "") === targetClass) position += 1;
    if (iteration + 1 < count) position = Math.max(0, position - 1);
  }
  return position;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSubstitute(command: string): {
  pattern: string;
  replacement: string;
  allMatches: boolean;
  wholeBuffer: boolean;
} | null {
  const wholeBuffer = command.startsWith("%");
  const source = wholeBuffer ? command.slice(1) : command;
  if (!source.startsWith("s") || source.length < 2) return null;
  const delimiter = source[1];
  const parts: string[] = [];
  let current = "";
  let escaped = false;
  for (let index = 2; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      current += character;
      escaped = true;
    } else if (character === delimiter) {
      parts.push(current);
      current = "";
      if (parts.length === 2) {
        parts.push(source.slice(index + 1));
        break;
      }
    } else current += character;
  }
  if (parts.length < 2) return null;
  return {
    pattern: parts[0],
    replacement: parts[1],
    allMatches: parts[2]?.includes("g") ?? false,
    wholeBuffer,
  };
}

function optionName(raw: string): keyof typeof DEFAULT_VIM_OPTIONS | null {
  const aliases: Record<string, keyof typeof DEFAULT_VIM_OPTIONS> = {
    ts: "tabstop",
    sw: "shiftwidth",
    et: "expandtab",
    ic: "ignorecase",
    scs: "smartcase",
    nu: "number",
    rnu: "relativenumber",
    tm: "timeoutlen",
  };
  const name = aliases[raw] ?? raw;
  return name in DEFAULT_VIM_OPTIONS ? name : null;
}

function tokenizeVimKeys(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /<[^>]+>|./gu;
  for (const match of value.matchAll(pattern)) tokens.push(normalizeSpecialKey(match[0]));
  return tokens;
}

function normalizeSpecialKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower === "<esc>") return "<Esc>";
  if (lower === "<cr>" || lower === "<enter>") return "<CR>";
  if (lower === "<space>") return " ";
  if (lower === "<tab>") return "<Tab>";
  if (lower === "<bs>") return "<BS>";
  return key;
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
