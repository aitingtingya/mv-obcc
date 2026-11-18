import { configurationEditor, ConfigurationEffectError } from "./configuration-editor";
import { scriptOptionName } from "./options";
import { DEFAULT_VIM_OPTIONS, type VimRuntimeConfig } from "../core/types";
import { applyVimOptions, optionName } from "../core/options";
import { evaluate, parseExpression, type Expression } from "./expression";
import {
  parseScript,
  VimScriptError,
  type ScriptProgram,
  type Statement,
} from "./syntax";
import { ScriptRegistry, type BuiltinContext } from "./registry";
import {
  indexValue,
  integer,
  isFunction,
  numberValue,
  stringValue,
  truth,
  type VimFunction,
  type VimValue,
} from "./value";
import type {
  ExecutionState,
  ScriptAutocmd,
  ScriptCommand,
  ScriptEditor,
  ScriptFrame,
  ScriptMapping,
  ScriptSourceHost,
} from "./contracts";
import { registerContainers } from "./builtins/containers";
import { registerStrings } from "./builtins/strings";
import { registerEditorFunctions } from "./builtins/editor";
import { executeScriptCommand, registerScriptCommands } from "./commands";
import { scriptPattern } from "./pattern";
export class ScriptControl extends Error {
  constructor(
    readonly kind: "return" | "finish" | "break" | "continue" | "cancel",
    readonly value: VimValue = 0n,
  ) {
    super(`Vim script ${kind}`);
  }
}
interface BufferScope {
  variables: Map<string, VimValue>;
  options: Map<string, VimValue>;
  owners: number;
  ready: Promise<void>;
}
export interface ScriptRuntimeStatus {
  loadedFiles: string[];
  errors: string[];
  functions: number;
  mappings: number;
  commands: number;
}
/** A Vault owns one runtime. The host provides I/O; editors retain their own text/history. */
export class VimScriptRuntime {
  readonly registry = new ScriptRegistry();
  readonly globals = new Map<string, VimValue>();
  readonly globalOptions = new Map<string, VimValue>();
  readonly functions = new Map<string, VimFunction>();
  private readonly functionSources = new Map<string, string>();
  private readonly optionWrites = new Map<string, Map<string, VimValue>>();
  private readonly defaultOptions = new Map<string, VimValue>();
  private readonly virtualOptionUndo = new Map<
    string,
    Map<string, VimValue | undefined>
  >();
  private entered = false;
  readonly mappings: ScriptMapping[] = [];
  readonly commands: ScriptCommand[] = [];
  readonly autocmds: ScriptAutocmd[] = [];
  readonly groups = new Set<string>();
  readonly editors = new Map<string, ScriptEditor>();
  readonly errors: string[] = [];
  readonly loadedFiles: string[] = [];
  readonly abbreviations = new Map<
    string,
    {
      lhs: string;
      expression: boolean;
      rhs: string;
      source: string;
      scriptId: number;
      bufferId?: string;
    }
  >();
  readonly localOptions = new Map<string, Map<string, VimValue>>();
  readonly virtualSources = new Map<string, string>();
  filetypePlugins = true;
  filetypeDetection = true;
  private readonly windows = new Map<string, Map<string, VimValue>>();
  private readonly viewGenerations = new Map<string, number>();
  private readonly windowOptions = new Map<string, Map<string, VimValue>>();
  private readonly editorConfigurations = new Map<string, string>();
  private readonly buffers = new Map<string, BufferScope>();
  private readonly scripts = new Map<
    string,
    {
      id: number;
      variables: Map<string, VimValue>;
    }
  >();
  private readonly programs = new Map<
    string,
    {
      text: string;
      program: ScriptProgram;
    }
  >();
  private readonly eventDepth = new Map<string, number>();
  private readonly bufferNumbers = new Map<string, number>();
  private nextBufferNumber = 1;
  private generation = 0;
  private disposed = false;
  private nextScriptId = 1;
  private nextEventId = 1;
  private group = "";
  constructor(readonly host?: ScriptSourceHost) {
    for (const [name, option] of this.registry.options)
      this.globalOptions.set(name, option.initial);
    for (const [key, value] of this.globalOptions)
      this.defaultOptions.set(key, value);
    registerContainers(this.registry);
    registerStrings(this.registry);
    registerEditorFunctions(this.registry, this);
    registerScriptCommands(this);
    this.registry.add(
      "eval",
      1,
      1,
      "Evaluate a Vim expression with the script interpreter",
      ([text], context) => context.expression(stringValue(text)),
    );
    this.registry.add(
      "exists",
      1,
      1,
      "Implemented variable, function, command or event",
      ([v], ctx) => {
        const name = stringValue(v);
        if (name.startsWith("*"))
          return BigInt(this.hasFunction(name.slice(1), ctx.frame));
        if (name.startsWith(":"))
          return (
            BigInt(
              this.registry.commands.has(name.slice(1)) ||
                this.commands.some((c) => c.name === name.slice(1)),
            ) * 2n
          );
        if (name.startsWith("##"))
          return BigInt(this.registry.events.has(name.slice(2)));
        if (name.startsWith("#")) {
          const parts = name.slice(1).split("#"),
            group = this.registry.events.has(parts[0])
              ? undefined
              : parts.shift(),
            event = parts.shift(),
            pattern = parts.shift();
          return BigInt(
            this.autocmds.some(
              (a) =>
                (group === undefined || a.group === group) &&
                (!event || a.events.includes(event)) &&
                (!pattern || a.patterns.includes(pattern)),
            ),
          );
        }
        if (name.startsWith("&") || name.startsWith("+"))
          return BigInt(this.hasOption(name.slice(1)));
        try {
          ctx.variable(name);
          return 1n;
        } catch {
          return 0n;
        }
      },
    );
    this.registry.add(
      "has",
      1,
      2,
      "Declared implemented capability",
      ([name]) => BigInt(this.registry.features.has(stringValue(name))),
    );
    this.registry.add(
      "function",
      1,
      3,
      "Create a function reference",
      ([name, bound = [], self], ctx) => {
        const target = stringValue(name),
          qualified = this.qualify(target, ctx.frame.scriptId);
        if (!this.hasFunction(target, ctx.frame) && !target.includes("#"))
          throw new Error(`E700: Unknown function: ${target}`);
        if (!Array.isArray(bound))
          throw new Error("E923: Second argument must be a List");
        const boundArgs = bound;
        if (self !== undefined && !(self instanceof Map))
          throw new Error("E715: Dictionary required");
        return {
          kind: "function",
          name: qualified,
          invoke: (args, caller, receiver) =>
            this.callFunction(
              qualified,
              [...boundArgs, ...args],
              (caller as BuiltinContext).frame,
              self ?? receiver,
            ),
        };
      },
    );
    this.registry.add(
      "call",
      2,
      3,
      "Invoke a function reference",
      ([fn, args, self], ctx) => {
        if (!Array.isArray(args)) throw new Error("E714: List required");
        if (self !== undefined && !(self instanceof Map))
          throw new Error("E715: Dictionary required");
        return typeof fn === "string"
          ? this.callFunction(fn, args, ctx.frame, self)
          : isFunction(fn)
            ? fn.invoke(args, ctx, self)
            : Promise.reject(new Error("E695: Funcref required"));
      },
    );
  }
  status(): ScriptRuntimeStatus {
    return {
      loadedFiles: [...this.loadedFiles],
      errors: [...this.errors],
      functions: this.functions.size,
      mappings: this.mappings.length,
      commands: this.commands.length,
    };
  }
  describe() {
    return this.registry.describe();
  }
  async reloadConfiguration(
    sources: ReadonlySet<string>,
    read: (load: (text: string, source: string) => Promise<void>) => Promise<void>,
    virtual: ReadonlyMap<string, string>,
  ): Promise<void> {
    this.cancel();
    for (const list of [this.mappings, this.commands, this.autocmds])
      for (let i = list.length - 1; i >= 0; i--)
        if (
          sources.has(list[i].source) ||
          list[i].source.endsWith(" virtual vimrc")
        )
          list.splice(i, 1);
    for (const [name, source] of this.functionSources)
      if (sources.has(source)) {
        this.functions.delete(name);
        this.functionSources.delete(name);
      }
    for (const [key, value] of this.abbreviations)
      if (sources.has(value.source) || value.source.endsWith(" virtual vimrc"))
        this.abbreviations.delete(key);
    for (const source of sources) {
      this.optionWrites.delete(source);
      this.programs.delete(source);
    }
    this.globalOptions.clear();
    for (const [key, value] of this.defaultOptions)
      this.globalOptions.set(key, value);
    for (const writes of this.optionWrites.values())
      for (const [key, value] of writes) this.globalOptions.set(key, value);
    this.virtualSources.clear();
    for (const [key, value] of virtual) this.virtualSources.set(key, value);
    for (const [id, undo] of this.virtualOptionUndo) {
      const options = this.localOptions.get(id);
      for (const [key, value] of undo) {
        if (value === undefined) options?.delete(key);
        else options?.set(key, value);
      }
    }
    this.virtualOptionUndo.clear();
    const load = async (text: string, source: string, editor?: ScriptEditor) => {
      const parent = this.frame(source, editor);
      parent.execution.configurationOnly = true;
      await this.load(text, source, editor, parent);
    };
    await read(load);
    const visited = new Set<string>();
    for (const editor of this.editors.values()) {
      if (visited.has(editor.id)) continue;
      visited.add(editor.id);
      const extension = editor.path.split(".").at(-1)?.toLowerCase() ?? "md",
        text = virtual.get(extension);
      if (text) await load(text, `${extension} virtual vimrc`, editor);
    }
    this.refreshEditors();
  }
  cancel(editor?: ScriptEditor): void {
    if (editor)
      this.viewGenerations.set(
        editor.viewId,
        (this.viewGenerations.get(editor.viewId) ?? 0) + 1,
      );
    else this.generation++;
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
    for (const map of [
      this.editors,
      this.buffers,
      this.windows,
      this.windowOptions,
      this.editorConfigurations,
      this.viewGenerations,
      this.localOptions,
      this.programs,
      this.functions,
      this.functionSources,
      this.optionWrites,
      this.virtualOptionUndo,
      this.virtualSources,
      this.abbreviations,
      this.scripts,
      this.eventDepth,
      this.bufferNumbers,
      this.globals,
      this.globalOptions,
    ])
      map.clear();
    this.groups.clear();
    this.mappings.length = 0;
    this.commands.length = 0;
    this.autocmds.length = 0;
  }
  compile(text: string, source: string): ScriptProgram {
    const found = this.programs.get(source);
    if (found?.text === text) return found.program;
    const program = parseScript(text, source);
    this.programs.set(source, { text, program });
    return program;
  }
  frame(
    source: string,
    editor?: ScriptEditor,
    execution?: ExecutionState,
  ): ScriptFrame {
    let script = this.scripts.get(source);
    if (!script) {
      script = { id: this.nextScriptId++, variables: new Map() };
      this.scripts.set(source, script);
    }
    return {
      source,
      scriptId: script.id,
      locals: null,
      arguments: new Map(),
      specials: new Map(),
      editor: execution?.configurationOnly && editor ? configurationEditor(editor) : editor,
      execution: execution ?? {
        generation: this.generation,
        steps: 0,
        started: Date.now(),
        depth: 0,
        cancelled: false,
        viewId: editor?.viewId,
        viewGeneration: editor
          ? (this.viewGenerations.get(editor.viewId) ?? 0)
          : 0,
        sources: new Set(),
      },
      location: { source, line: 1, column: 1 },
    };
  }
  async load(
    text: string,
    source: string,
    editor?: ScriptEditor,
    parent?: ScriptFrame,
  ): Promise<void> {
    const program = this.compile(text, source);
    const frame = this.frame(source, editor, parent?.execution);
    if (frame.execution.sources.has(source))
      throw new Error(`E169: Source cycle: ${source}`);
    frame.execution.sources.add(source);
    if (!this.loadedFiles.includes(source)) this.loadedFiles.push(source);
    try {
      await this.emit("SourcePre", editor, source, frame);
      await this.execute(program.statements, frame);
    } catch (error) {
      if (!(error instanceof ScriptControl && error.kind === "finish"))
        throw error;
    } finally {
      frame.execution.sources.delete(source);
    }
    await this.emit("SourcePost", editor, source, frame);
  }
  async run(
    text: string,
    editor?: ScriptEditor,
    source = ":command",
  ): Promise<void> {
    editor?.beginEdit();
    try {
      await this.execute(
        this.compile(text, source).statements,
        this.frame(source, editor),
      );
    } finally {
      editor?.endEdit();
      this.refreshEditors();
    }
  }
  async evaluateExpression(
    text: string,
    editor?: ScriptEditor,
  ): Promise<VimValue> {
    return evaluate(
      parseExpression(text),
      this.context(this.frame(":expression", editor)),
    );
  }
  attach(editor: ScriptEditor): Promise<void> | undefined {
    this.editors.set(editor.viewId, editor);
    this.windows.set(editor.viewId, new Map());
    this.viewGenerations.set(editor.viewId, 0);
    this.windowOptions.set(editor.viewId, new Map());
    let scope = this.buffers.get(editor.id);
    if (!this.bufferNumbers.has(editor.id))
      this.bufferNumbers.set(editor.id, this.nextBufferNumber++);
    if (!scope) {
      scope = {
        variables: new Map(),
        options: new Map(),
        owners: 0,
        ready: Promise.resolve(),
      };
      this.buffers.set(editor.id, scope);
      this.localOptions.set(editor.id, scope.options);
      const filetype = detectFiletype(editor.path);
      scope.options.set("filetype", "");
      const owner = scope;
      const extension = editor.path.split(".").at(-1)?.toLowerCase() ?? "md";
      const virtual = this.virtualSources.get(extension);
      const needsInitialization =
        this.host?.hasFiletype() ||
        this.autocmds.some((event) =>
          event.events.some((name) =>
            [
              "BufAdd",
              "BufRead",
              "BufReadPost",
              "FileType",
              "BufWinEnter",
              "VimEnter",
            ].includes(name),
          ),
        ) ||
        !!virtual;
      if (needsInitialization)
        scope.ready = (async () => {
          await this.emit("BufAdd", editor);
          if (this.filetypeDetection) {
            await this.emit("BufRead", editor);
            await this.emit("BufReadPost", editor);
          }
          if (this.filetypeDetection && !owner.options.get("filetype")) {
            owner.options.set("filetype", filetype);
            await this.loadFiletype(filetype, editor);
          }
          if (virtual)
            await this.load(virtual, `${extension} virtual vimrc`, editor);
          await this.emit("BufWinEnter", editor);
          if (!this.entered) {
            this.entered = true;
            await this.emit("VimEnter", editor);
          }
          if (this.buffers.get(editor.id) === owner) this.refreshEditors();
        })();
      scope.owners++;
      if (!needsInitialization) {
        scope.options.set("filetype", this.filetypeDetection ? filetype : "");
        this.refreshEditors();
        return;
      }
      return scope.ready;
    }
    scope.owners++;
    return scope.ready.then(() => this.emit("BufWinEnter", editor));
  }
  detach(editor: ScriptEditor): void {
    this.cancel(editor);
    const scope = this.buffers.get(editor.id);
    const release = () => {
      this.editors.delete(editor.viewId);
      this.windows.delete(editor.viewId);
      this.windowOptions.delete(editor.viewId);
      this.editorConfigurations.delete(editor.viewId);
      this.viewGenerations.delete(editor.viewId);
      if (
        scope &&
        --scope.owners === 0 &&
        this.buffers.get(editor.id) === scope
      ) {
        this.buffers.delete(editor.id);
        this.bufferNumbers.delete(editor.id);
        this.localOptions.delete(editor.id);
        this.virtualOptionUndo.delete(editor.id);
        for (const list of [this.mappings, this.commands, this.autocmds])
          for (let i = list.length - 1; i >= 0; i--)
            if (list[i].bufferId === editor.id) list.splice(i, 1);
      }
    };
    if (
      !this.disposed &&
      (this.observes("BufWinLeave", editor) ||
        (scope?.owners === 1 && this.observes("BufDelete", editor)))
    ) {
      void (async () => {
        await this.emit("BufWinLeave", editor);
        if (scope?.owners === 1) await this.emit("BufDelete", editor);
      })()
        .catch((error: unknown) => this.report(error))
        .finally(release);
    } else release();
  }
  private async loadFiletype(
    type: string,
    editor: ScriptEditor,
    parent?: ScriptFrame,
  ): Promise<void> {
    if (this.host && this.filetypePlugins)
      for (const source of await this.host.filetype(type))
        await this.load(source.text, source.path, editor, parent);
    await this.emit("FileType", editor, type, parent);
  }
  async setFiletype(
    type: string,
    frame: ScriptFrame,
    onlyUnset = false,
  ): Promise<void> {
    const editor = requireEditor(frame);
    if (onlyUnset && stringValue(this.getOption("filetype", frame))) return;
    const old = stringValue(this.getOption("filetype", frame));
    if (old === type) return;
    const undo = this.buffers.get(editor.id)?.variables.get("undo_ftplugin");
    if (typeof undo === "string") {
      if (frame.execution.configurationOnly)
        await this.execute(this.compile(undo, ":undo_ftplugin").statements, frame);
      else await this.run(undo, editor);
    }
    this.buffers.get(editor.id)?.variables.delete("did_ftplugin");
    this.setOption("l:filetype", type, frame);
    await this.loadFiletype(type, editor, frame.execution.configurationOnly ? frame : undefined);
  }
  configuration(editor?: ScriptEditor): VimRuntimeConfig {
    const options = { ...DEFAULT_VIM_OPTIONS };
    for (const key of Object.keys(options)) {
      const value = editor
        ? (this.windowOptions.get(editor.viewId)?.get(key) ??
          this.localOptions.get(editor.id)?.get(key) ??
          this.globalOptions.get(key))
        : this.globalOptions.get(key);
      Object.assign(options, {
        [key]:
          typeof options[key as keyof typeof options] === "number"
            ? numberValue(value!)
            : value,
      });
    }
    return {
      options,
      mappings: this.effectiveMappings(editor),
      abbreviations: this.effectiveAbbreviations(editor).map((a) => ({
        lhs: a.lhs,
        rhs: a.rhs,
        expression: a.expression,
        recursive: false,
      })),
      exCommands: new Map(),
      autocmds: [],
      script: this,
    };
  }
  effectiveMappings(editor?: ScriptEditor): ScriptMapping[] {
    const local = this.mappings.filter(
      (m) => m.bufferId === editor?.id && m.bufferId !== undefined,
    );
    const global = this.mappings
      .filter((m) => !m.bufferId)
      .map((m) => ({
        ...m,
        modes: m.modes.filter(
          (mode) =>
            !local.some(
              (l) =>
                l.lhs.join("") === m.lhs.join("") && l.modes.includes(mode),
            ),
        ),
      }))
      .filter((m) => m.modes.length);
    return [...global, ...local];
  }
  effectiveAbbreviations(editor?: ScriptEditor) {
    const entries = new Map<
      string,
      typeof this.abbreviations extends Map<string, infer V> ? V : never
    >();
    for (const entry of this.abbreviations.values())
      if (!entry.bufferId) entries.set(entry.lhs, entry);
    for (const entry of this.abbreviations.values())
      if (entry.bufferId === editor?.id && entry.bufferId)
        entries.set(entry.lhs, entry);
    return [...entries.values()];
  }
  async abbreviationValue(lhs: string, editor: ScriptEditor): Promise<string> {
    const value = this.effectiveAbbreviations(editor).find(
      (item) => item.lhs === lhs,
    )!;
    return value.expression
      ? stringValue(
          await evaluate(
            parseExpression(value.rhs),
            this.context(this.frame(value.source, editor)),
          ),
        )
      : value.rhs;
  }
  bufferNumber(editor: ScriptEditor): number {
    return this.bufferNumbers.get(editor.id)!;
  }
  bufferEditor(number: number): ScriptEditor | undefined {
    return [...this.editors.values()].find(
      (editor) => this.bufferNumber(editor) === number,
    );
  }
  observes(event: string, editor?: ScriptEditor): boolean {
    return this.autocmds.some(
      (entry) =>
        entry.events.includes(event) &&
        (!entry.bufferId || entry.bufferId === editor?.id),
    );
  }
  inEvent(editor: ScriptEditor): boolean {
    return (this.eventDepth.get(editor.viewId) ?? 0) > 0;
  }
  refreshEditors(): void {
    for (const editor of this.editors.values()) {
      const config = this.configuration(editor);
      const signature = JSON.stringify([config.options, config.abbreviations, config.mappings.map((value) => {
        const mapping = value as ScriptMapping;
        return [mapping.source, mapping.scriptId, mapping.modes, mapping.lhs, mapping.rhsText, mapping.recursive, mapping.expression, mapping.nowait, mapping.silent];
      })]);
      if (this.editorConfigurations.get(editor.viewId) === signature) continue;
      this.editorConfigurations.set(editor.viewId, signature);
      editor.configure(config);
    }
  }
  hasOption(name: string): boolean {
    return this.globalOptions.has(scriptOptionName(name));
  }
  defaultOption(name: string): VimValue {
    return this.defaultOptions.get(scriptOptionName(name))!;
  }
  inheritOption(name: string, frame: ScriptFrame): void {
    const editor = requireEditor(frame),
      key = scriptOptionName(name);
    this.windowOptions.get(editor.viewId)?.delete(key);
    this.localOptions.get(editor.id)?.delete(key);
    this.refreshEditors();
  }
  getOption(raw: string, frame: ScriptFrame): VimValue {
    const key = scriptOptionName(raw);
    if (!this.globalOptions.has(key))
      throw new Error(`E113: Unknown option: ${raw}`);
    return !raw.startsWith("g:") && frame.editor
      ? (this.windowOptions.get(frame.editor.viewId)?.get(key) ??
          this.localOptions.get(frame.editor.id)?.get(key) ??
          this.globalOptions.get(key)!)
      : this.globalOptions.get(key)!;
  }
  setOption(
    raw: string,
    value: VimValue,
    frame: ScriptFrame,
    local = false,
  ): void {
    const key = scriptOptionName(raw);
    if (!this.globalOptions.has(key))
      throw new Error(`E113: Unknown option: ${raw}`);
    const existing = this.globalOptions.get(key)!;
    if (key === "operatorfunc" && typeof value === "string") value = this.qualify(value, frame.scriptId);
    if (typeof existing === "boolean")
      value = typeof value === "boolean" ? value : truth(value);
    if (optionName(key)) {
      const options = { ...this.configuration(frame.editor).options };
      const result = applyVimOptions(options, [
        typeof existing === "boolean"
          ? `${value ? "" : "no"}${key}`
          : `${key}=${stringValue(value)}`,
      ]);
      if (result.errors.length) throw new Error(result.errors[0]);
    }
    const target = frame.editor
      ? this.registry.options.get(key)?.scope === "window" &&
        !this.isVirtual(frame)
        ? this.windowOptions.get(frame.editor.viewId)!
        : this.localOptions.get(frame.editor.id)!
      : null;
    if (target && frame.editor && this.isVirtual(frame)) {
      let undo = this.virtualOptionUndo.get(frame.editor.id);
      if (!undo) {
        undo = new Map();
        this.virtualOptionUndo.set(frame.editor.id, undo);
      }
      if (!undo.has(key)) undo.set(key, target.get(key));
    }
    if (target && (local || raw.startsWith("l:") || this.isVirtual(frame)))
      target.set(key, value);
    else {
      let writes = this.optionWrites.get(frame.source);
      if (!writes) {
        writes = new Map();
        this.optionWrites.set(frame.source, writes);
      }
      writes.set(key, value);
      this.globalOptions.set(key, value);
      if (target && !raw.startsWith("g:")) target.set(key, value);
    }
    this.refreshEditors();
  }
  qualify(name: string, id: number): string {
    return name.replace(/^(?:s:|<SID>)/iu, `<SNR>${id}_`);
  }
  isVirtual(frame: ScriptFrame): boolean {
    return frame.source.endsWith(" virtual vimrc");
  }
  hasFunction(name: string, frame: ScriptFrame): boolean {
    return (
      this.registry.functions.has(name) ||
      this.functions.has(this.qualify(name, frame.scriptId))
    );
  }
  async callFunction(
    name: string,
    args: VimValue[],
    frame: ScriptFrame,
    self?: Map<string, VimValue>,
  ): Promise<VimValue> {
    const qualified = this.qualify(name, frame.scriptId);
    if (this.registry.functions.has(name))
      return this.registry.invoke(name, args, this.context(frame));
    let target = this.functions.get(qualified);
    if (!target && name.includes("#") && this.host) {
      const request = `autoload/${name.split("#").slice(0, -1).join("/")}.vim`;
      const sources = await this.host.runtime(request, false);
      for (const source of sources)
        if (!this.loadedFiles.includes(source.path))
          await this.load(source.text, source.path, frame.editor, frame);
      target = this.functions.get(qualified);
    }
    if (!target) {
      try {
        const value = this.variable(name, frame);
        if (isFunction(value)) target = value;
      } catch {
        /* Report the function error below. */
      }
    }
    if (!target) throw new Error(`E117: Unknown function: ${name}`);
    return target.invoke(args, this.context(frame), self);
  }
  variable(name: string, frame: ScriptFrame): VimValue {
    if (name.startsWith("v:")) {
      const key = name.slice(2);
      if (!key) return new Map([...this.specials(frame), ...frame.specials]);
      if (frame.specials.has(key)) return frame.specials.get(key)!;
      const special = this.specials(frame);
      if (special.has(key)) return special.get(key)!;
      throw new Error(`E121: Undefined variable: ${name}`);
    }
    const [scope, key] = this.scope(name, frame);
    if (!key) return scope;
    if (!scope.has(key)) throw new Error(`E121: Undefined variable: ${name}`);
    return scope.get(key)!;
  }
  private specials(frame: ScriptFrame): Map<string, VimValue> {
    return new Map<string, VimValue>([
      ["true", true],
      ["false", false],
      ["null", null],
      ["version", 901n],
      ["numbersize", 64n],
      ["t_number", 0n],
      ["t_string", 1n],
      ["t_func", 2n],
      ["t_list", 3n],
      ["t_dict", 4n],
      ["t_float", 5n],
      ["t_bool", 6n],
      ["t_none", 7n],
      ["count", 0n],
      ["count1", 1n],
      ["register", '"'],
      ["operator", ""],
      ["exception", ""],
      ["throwpoint", ""],
      ["errmsg", ""],
      ["lnum", integer(frame.editor?.cursor()[0] ?? 1)],
    ]);
  }
  private scope(
    name: string,
    frame: ScriptFrame,
  ): [Map<string, VimValue>, string] {
    const prefix = /^[gsbwla]:/u.exec(name)?.[0];
    const key = prefix ? name.slice(2) : name;
    if (prefix === "s:")
      return [this.scripts.get(frame.source)!.variables, key];
    if (prefix === "a:") return [frame.arguments, key];
    if (prefix === "l:") {
      if (!frame.locals) throw new Error("E461: Illegal variable scope: l:");
      return [frame.locals, key];
    }
    if (prefix === "b:")
      return [this.buffers.get(requireEditor(frame).id)!.variables, key];
    if (prefix === "w:")
      return [this.windows.get(requireEditor(frame).viewId)!, key];
    if (!prefix && frame.locals && !frame.locals.has(key)) {
      for (let outer = frame.outer; outer; outer = outer.outer)
        if (outer.locals?.has(key)) return [outer.locals, key];
    }
    return [
      prefix === "g:" ? this.globals : (frame.locals ?? this.globals),
      key,
    ];
  }
  assign(name: string, value: VimValue, frame: ScriptFrame): void {
    if (name.startsWith("a:") || name.startsWith("v:"))
      throw new Error(`E46: Cannot change read-only variable: ${name}`);
    const [scope, key] = this.scope(name, frame);
    if (!key) throw new Error("E461: Cannot replace a scope Dictionary");
    scope.set(key, value);
  }
  unlet(name: string, frame: ScriptFrame, force: boolean): void {
    const [scope, key] = this.scope(name, frame);
    if (!scope.delete(key) && !force)
      throw new Error(`E108: No such variable: ${name}`);
  }
  async removeTarget(
    target: Expression,
    frame: ScriptFrame,
    force: boolean,
  ): Promise<void> {
    if (target.kind === "variable") {
      this.unlet(target.name, frame, force);
      return;
    }
    if (target.kind !== "index" && target.kind !== "member")
      throw new Error("E461: Invalid unlet target");
    const value = await evaluate(target.target, this.context(frame)),
      key =
        target.kind === "member"
          ? target.name
          : await evaluate(target.index, this.context(frame));
    if (value instanceof Map) {
      if (!value.delete(stringValue(key)) && !force)
        throw new Error("E716: Dictionary key does not exist");
    } else if (Array.isArray(value)) {
      const n = numberValue(key),
        index = n < 0 ? value.length + n : n;
      if (index < 0 || index >= value.length)
        throw new Error("E684: List index out of range");
      value.splice(index, 1);
    } else throw new Error("E689: List or Dictionary required");
  }
  context(frame: ScriptFrame): BuiltinContext {
    return {
      frame,
      forCaller: (caller) => {
        const invocation = (caller as BuiltinContext).frame;
        return this.context({ ...frame, editor: invocation.editor, execution: invocation.execution });
      },
      variable: (name) => this.variable(name, frame),
      assign: (name, value) => this.assign(name, value, frame),
      option: (name) => this.getOption(name, frame),
      register: async (name) =>
        (await requireEditor(frame).readRegister(name)).text,
      call: (name, args) => this.callFunction(name, args, frame),
      match: (text, pattern, ignoreCase) =>
        scriptPattern(
          pattern,
          ignoreCase ?? truth(this.getOption("ignorecase", frame)),
        ).test(text),
      step: () => this.step(frame.execution),
      invoke: (value, args) =>
        typeof value === "string"
          ? this.callFunction(value, args, frame)
          : isFunction(value)
            ? value.invoke(args, this.context(frame))
            : Promise.reject(new Error("E695: Funcref required")),
      expression: (text, specials) =>
        evaluate(
          parseExpression(text),
          this.context({
            ...frame,
            specials: specials
              ? new Map([...frame.specials, ...specials])
              : frame.specials,
          }),
        ),
    };
  }
  async step(state: ExecutionState): Promise<void> {
    const cancelled = () =>
      this.disposed ||
      state.generation !== this.generation ||
      state.cancelled ||
      (state.viewId !== undefined &&
        (state.viewGeneration !== this.viewGenerations.get(state.viewId) ||
          !this.editors.has(state.viewId)));
    if (cancelled()) throw new ScriptControl("cancel");
    if (++state.steps % 64 === 0 && Date.now() - state.started >= 8) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          channel.port2.close();
          resolve();
        };
        channel.port2.postMessage(null);
      });
      state.started = Date.now();
      if (cancelled()) throw new ScriptControl("cancel");
    }
  }
  async assignTarget(
    target: Expression,
    value: VimValue,
    frame: ScriptFrame,
  ): Promise<void> {
    if (target.kind === "variable") {
      this.assign(target.name, value, frame);
      return;
    }
    if (target.kind === "option") {
      this.setOption(target.name, value, frame);
      return;
    }
    if (target.kind === "register") {
      requireEditor(frame).writeRegister(target.name, {
        text: stringValue(value),
        kind: "character",
      });
      return;
    }
    if (target.kind === "list") {
      if (
        !Array.isArray(value) ||
        value.length < target.items.length ||
        (!target.rest && value.length !== target.items.length)
      )
        throw new Error("E687: Assignment target count does not match List");
      for (let i = 0; i < target.items.length; i++)
        await this.assignTarget(target.items[i], value[i], frame);
      if (target.rest)
        await this.assignTarget(
          target.rest,
          value.slice(target.items.length),
          frame,
        );
      return;
    }
    if (target.kind === "slice") {
      const list = await evaluate(target.target, this.context(frame));
      if (!Array.isArray(list) || !Array.isArray(value))
        throw new Error("E714: List required");
      const index = async (expr: Expression | null, fallback: number) => {
        const n = expr
          ? numberValue(await evaluate(expr, this.context(frame)))
          : fallback;
        return n < 0 ? list.length + n : n;
      };
      const first = await index(target.from, 0),
        last = await index(target.to, list.length - 1);
      if (first < 0 || last >= list.length || first > last)
        throw new Error("E684: List index out of range");
      if (value.length !== last - first + 1)
        throw new Error("E710: List value count differs from slice");
      for (let i = first; i <= last; i++) list[i] = value[i - first];
      return;
    }
    if (
      target.kind === "index" ||
      target.kind === "member" ||
      (target.kind === "binary" && target.operator === ".")
    ) {
      const object = await evaluate(
        target.kind === "index" || target.kind === "member"
          ? target.target
          : target.left,
        this.context(frame),
      );
      const key =
        target.kind === "member"
          ? target.name
          : target.kind === "index"
            ? await evaluate(target.index, this.context(frame))
            : target.right.kind === "variable"
              ? target.right.name
              : await evaluate(target.right, this.context(frame));
      if (object instanceof Map) object.set(stringValue(key), value);
      else if (Array.isArray(object)) {
        const raw = numberValue(key),
          at = raw < 0 ? object.length + raw : raw;
        indexValue(object, key);
        object[at] = value;
      } else throw new Error("E689: Can only assign a List or Dictionary item");
      return;
    }
    throw new Error("E461: Invalid assignment target");
  }
  async execute(
    statements: readonly Statement[],
    frame: ScriptFrame,
  ): Promise<void> {
    for (const node of statements) {
      await this.step(frame.execution);
      frame.location = node.location;
      try {
        if (node.kind === "command")
          await executeScriptCommand(this, node.text, frame);
        else if (node.kind === "if") {
          for (const branch of node.branches)
            if (
              branch.condition === null ||
              truth(await evaluate(branch.condition, this.context(frame)))
            ) {
              await this.execute(branch.body, frame);
              break;
            }
        } else if (node.kind === "function") {
          const name = this.qualify(node.name, frame.scriptId);
          if (this.functions.has(name) && !node.replace)
            throw new Error(`E122: Function already exists: ${name}`);
          const closure = { ...frame };
          const fn: VimFunction = {
            kind: "function",
            name,
            invoke: async (args, caller, self) => {
              if (args.length < node.parameters.length)
                throw new Error(`E119: Not enough arguments: ${name}`);
              if (!node.variadic && args.length > node.parameters.length)
                throw new Error(`E118: Too many arguments: ${name}`);
              const callingFrame = (caller as BuiltinContext).frame ?? closure;
              if (
                ++callingFrame.execution.depth >
                numberValue(this.globalOptions.get("maxfuncdepth")!)
              ) {
                callingFrame.execution.depth--;
                throw new Error(
                  "E132: Function call depth is higher than 'maxfuncdepth'",
                );
              }
              const arguments_ = new Map(
                node.parameters.map((p, i) => [p, args[i]]),
              );
              const rest = args.slice(node.parameters.length);
              arguments_.set("0", integer(rest.length));
              arguments_.set("000", rest);
              rest.forEach((v, i) => arguments_.set(String(i + 1), v));
              arguments_.set(
                "firstline",
                callingFrame.specials.get("firstline") ??
                  integer(callingFrame.editor?.cursor()[0] ?? 1),
              );
              arguments_.set(
                "lastline",
                callingFrame.specials.get("lastline") ??
                  integer(callingFrame.editor?.cursor()[0] ?? 1),
              );
              if (node.flags.includes("dict") && !self) {
                callingFrame.execution.depth--;
                throw new Error(
                  `E725: Calling dict function without Dictionary: ${name}`,
                );
              }
              const fnFrame: ScriptFrame = {
                ...closure,
                locals: new Map(),
                outer: node.flags.includes("closure") ? closure : undefined,
                arguments: arguments_,
                specials: new Map(callingFrame.specials),
                editor: callingFrame.editor,
                execution: callingFrame.execution,
              };
              if (self) fnFrame.locals!.set("self", self);
              fnFrame.specials.set(
                "sfile",
                `${closure.source}..function ${name}`,
              );
              try {
                await this.execute(node.body, fnFrame);
                return 0n;
              } catch (error) {
                if (error instanceof ScriptControl && error.kind === "return")
                  return error.value;
                throw error;
              } finally {
                callingFrame.execution.depth--;
              }
            },
          };
          if (node.name.includes("."))
            await this.assignTarget(parseExpression(node.name), fn, frame);
          else {
            this.functions.set(name, fn);
            this.functionSources.set(name, frame.source);
          }
        } else if (node.kind === "while" || node.kind === "for") {
          const iterable =
            node.kind === "for"
              ? await evaluate(node.iterable, this.context(frame))
              : null;
          if (node.kind === "for" && !Array.isArray(iterable))
            throw new Error("E714: List required");
          let index = 0;
          while (
            node.kind === "while"
              ? truth(await evaluate(node.condition, this.context(frame)))
              : index < (iterable as VimValue[]).length
          ) {
            await this.step(frame.execution);
            if (node.kind === "for")
              await this.assignTarget(
                node.target,
                (iterable as VimValue[])[index++],
                frame,
              );
            try {
              await this.execute(node.body, frame);
            } catch (error) {
              if (error instanceof ScriptControl && error.kind === "break")
                break;
              if (
                !(error instanceof ScriptControl && error.kind === "continue")
              )
                throw error;
            }
          }
        } else if (node.kind === "try") {
          try {
            await this.execute(node.body, frame);
          } catch (error) {
            if (error instanceof ScriptControl) throw error;
            const message =
              error instanceof Error ? error.message : String(error);
            const branch = node.catches.find(
              (c) => !c.pattern || scriptPattern(c.pattern).test(message),
            );
            if (!branch) throw error;
            frame.specials.set("exception", message);
            frame.specials.set(
              "throwpoint",
              `${frame.location.source}, line ${frame.location.line}`,
            );
            await this.execute(branch.body, frame);
          } finally {
            await this.execute(node.finally, frame);
          }
        }
      } catch (error) {
        if (error instanceof ScriptControl) throw error;
        if (error instanceof ConfigurationEffectError) {
          this.report(new VimScriptError(error.message).at(node.location));
          continue;
        }
        throw (
          error instanceof VimScriptError
            ? error
            : new VimScriptError(
                error instanceof Error ? error.message : String(error),
              )
        ).at(node.location);
      }
    }
  }
  setGroup(group: string): void {
    this.group = group === "END" ? "" : group;
    if (this.group) this.groups.add(this.group);
  }
  currentGroup(): string {
    return this.group;
  }
  addAutocmd(value: Omit<ScriptAutocmd, "id">): void {
    this.autocmds.push({ ...value, id: this.nextEventId++ });
  }
  async emit(
    event: string,
    editor?: ScriptEditor,
    match = editor?.path ?? "",
    caller?: ScriptFrame,
    group?: string,
  ): Promise<void> {
    const owner = editor?.viewId ?? ":runtime",
      depth = this.eventDepth.get(owner) ?? 0;
    if (depth && !caller?.specials.get("eventNested")) return;
    if (depth >= 10) throw new Error("E218: Autocommand nesting too deep");
    const matches = this.autocmds.filter(
      (a) =>
        a.events.includes(event) &&
        (group === undefined || a.group === group) &&
        (!a.bufferId || a.bufferId === editor?.id) &&
        a.patterns.some((p) => p === "<buffer>" || globMatch(p, match)),
    );
    if (!matches.length) return;
    this.eventDepth.set(owner, depth + 1);
    try {
      for (const entry of matches) {
        if (entry.once) this.autocmds.splice(this.autocmds.indexOf(entry), 1);
        const frame = this.frame(entry.source, editor, caller?.execution);
        frame.specials.set("eventNested", entry.nested);
        frame.specials.set("amatch", match);
        frame.specials.set(
          "afile",
          event.startsWith("Source") ? match : (editor?.path ?? match),
        );
        await this.execute(entry.command.statements, frame);
      }
    } finally {
      if (depth) this.eventDepth.set(owner, depth);
      else this.eventDepth.delete(owner);
      this.refreshEditors();
    }
  }
  async mappingValue(
    mapping: ScriptMapping,
    editor: ScriptEditor,
    specials?: Map<string, VimValue>,
  ): Promise<string> {
    if (!mapping.expressionSource) return mapping.rhs.join("");
    const frame = this.frame(mapping.source, editor);
    if (specials) frame.specials = specials;
    return stringValue(
      await evaluate(mapping.expressionSource, this.context(frame)),
    );
  }
  report(error: unknown, editor?: ScriptEditor): void {
    if (error instanceof ScriptControl && error.kind === "cancel") return;
    const message =
      error instanceof VimScriptError
        ? error.diagnostic()
        : error instanceof Error
          ? error.message
          : String(error);
    this.errors.push(message);
    editor?.message(message, true);
  }
}
export function requireEditor(frame: ScriptFrame): ScriptEditor {
  if (!frame.editor && frame.execution.configurationOnly)
    throw new ConfigurationEffectError("Automatic vimrc reload has no current editor; use an explicit command or Reload scripts.");
  if (!frame.editor)
    throw new Error("E86: No editor is attached to this script invocation");
  return frame.editor;
}
export function globMatch(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return (
    new RegExp(`^${expression}$`, "u").test(value) ||
    (!pattern.includes("/") &&
      new RegExp(`^${expression}$`, "u").test(value.split(/[\\/]/u).at(-1)!))
  );
}
export function detectFiletype(file: string): string {
  const extension = file.split(".").at(-1)?.toLowerCase() ?? "md";
  return (
    (
      {
        md: "markdown",
        markdown: "markdown",
        tex: "tex",
        bib: "bib",
        py: "python",
        js: "javascript",
        jsx: "javascriptreact",
        ts: "typescript",
        tsx: "typescriptreact",
        yml: "yaml",
        sh: "sh",
        rb: "ruby",
        rs: "rust",
      } as Record<string, string>
    )[extension] ?? extension
  );
}
