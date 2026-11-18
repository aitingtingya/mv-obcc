import type {
  VimMapping,
  VimMode,
  VimOptions,
  VimRegister,
  VimRuntimeConfig,
} from "../core/types";
import type { Expression } from "./expression";
import type { ScriptLocation, ScriptProgram } from "./syntax";
import type { VimValue } from "./value";
export interface ScriptEditor {
  readonly id: string;
  readonly viewId: string;
  readonly path: string;
  lines(): string[];
  lineCount(): number;
  line(number: number): string;
  cursor(): [number, number];
  setCursor(line: number, byteColumn: number): void;
  replaceLines(start: number, remove: number, lines: string[]): void;
  mark(name: string): [number, number];
  setMark(name: string, line: number, byteColumn: number): void;
  mode(): VimMode;
  options(): VimOptions;
  readRegister(name: string): VimRegister | Promise<VimRegister>;
  writeRegister(name: string, value: VimRegister): void;
  normal(keys: string, remap: boolean): Promise<void>;
  ex(command: string): Promise<void>;
  configure(config: VimRuntimeConfig): void;
  message(text: string, error: boolean): void;
  saveView(): Map<string, VimValue>;
  restoreView(value: Map<string, VimValue>): void;
  beginEdit(): void;
  endEdit(): void;
}
export interface ScriptSourceHost {
  source(
    request: string,
    from: string,
  ): Promise<{
    path: string;
    text: string;
  }>;
  runtime(
    pattern: string,
    all: boolean,
  ): Promise<
    {
      path: string;
      text: string;
    }[]
  >;
  package(
    name: string | null,
    registerOnly: boolean,
  ): Promise<
    {
      path: string;
      text: string;
    }[]
  >;
  filetype(name: string): Promise<
    {
      path: string;
      text: string;
    }[]
  >;
  hasFiletype(): boolean;
  pathFunction(
    name: string,
    args: VimValue[],
    source: string,
    editor?: ScriptEditor,
  ): VimValue;
}
export interface ExecutionState {
  configurationOnly?: boolean;
  generation: number;
  steps: number;
  started: number;
  depth: number;
  cancelled: boolean;
  viewId?: string;
  viewGeneration: number;
  sources: Set<string>;
}
export interface ScriptFrame {
  source: string;
  scriptId: number;
  locals: Map<string, VimValue> | null;
  arguments: Map<string, VimValue>;
  specials: Map<string, VimValue>;
  editor?: ScriptEditor;
  execution: ExecutionState;
  location: ScriptLocation;
  outer?: ScriptFrame;
}
export interface ScriptMapping extends VimMapping {
  scriptId: number;
  source: string;
  bufferId?: string;
  expressionSource?: Expression;
  silent: boolean;
  nowait: boolean;
  rhsText: string;
}
export interface ScriptCommand {
  name: string;
  body: ScriptProgram;
  replacement: string;
  scriptId: number;
  source: string;
  bufferId?: string;
  nargs: string;
  range: string | null;
  count: number | null;
  bang: boolean;
  bar: boolean;
  register: boolean;
}
export interface ScriptAutocmd {
  id: number;
  group: string;
  events: string[];
  patterns: string[];
  command: ScriptProgram;
  source: string;
  scriptId: number;
  once: boolean;
  nested: boolean;
  bufferId?: string;
}
