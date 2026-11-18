import { scriptOptions } from "./options";
import type { ScriptFrame } from "./contracts";
import type { ExpressionContext, VimValue } from "./value";
export interface BuiltinContext extends ExpressionContext {
  frame: ScriptFrame;
  invoke(value: VimValue, args: VimValue[]): Promise<VimValue>;
  expression(text: string, specials?: Map<string, VimValue>): Promise<VimValue>;
}
export interface ScriptBuiltin {
  name: string;
  min: number;
  max: number;
  description: string;
  run(args: VimValue[], context: BuiltinContext): VimValue | Promise<VimValue>;
}
export interface ScriptExCapability {
  syntax: string;
  description: string;
  run(text: string, frame: ScriptFrame): Promise<void>;
}
export class ScriptRegistry {
  readonly commandHandlers = new Map<string, ScriptExCapability>();
  readonly options = scriptOptions();
  readonly functions = new Map<string, ScriptBuiltin>();
  readonly events = new Set([
    "BufEnter",
    "BufLeave",
    "BufRead",
    "BufReadPost",
    "BufAdd",
    "BufDelete",
    "BufWinEnter",
    "BufWinLeave",
    "FileType",
    "InsertEnter",
    "InsertLeave",
    "BufWritePre",
    "BufWritePost",
    "CursorMoved",
    "CursorMovedI",
    "TextChanged",
    "TextChangedI",
    "User",
    "SourcePre",
    "SourcePost",
    "VimEnter",
  ]);
  readonly commands = new Set([
    "let",
    "unlet",
    "call",
    "return",
    "finish",
    "break",
    "continue",
    "throw",
    "execute",
    "echo",
    "echomsg",
    "echoerr",
    "set",
    "setlocal",
    "setglobal",
    "source",
    "so",
    "runtime",
    "packadd",
    "packloadall",
    "scriptnames",
    "command",
    "com",
    "delcommand",
    "delc",
    "augroup",
    "autocmd",
    "au",
    "doautocmd",
    "doautoall",
    "setfiletype",
    "filetype",
    "function",
    "delfunction",
    "normal",
    "silent",
  ]);
  readonly features = new Set([
    "eval",
    "autocmd",
    "user_commands",
    "multi_byte",
    "float",
    "lambda",
    "packages",
    "mv_aide",
  ]);
  add(
    name: string,
    min: number,
    max: number,
    description: string,
    run: ScriptBuiltin["run"],
  ): void {
    if (this.functions.has(name))
      throw new Error(`Duplicate script builtin: ${name}`);
    this.functions.set(name, { name, min, max, description, run });
  }
  addCommand(name: string, capability: ScriptExCapability): void {
    if (this.commandHandlers.has(name)) throw new Error(`Duplicate Ex capability: ${name}`);
    this.commands.add(name); this.commandHandlers.set(name, capability);
  }
  async invoke(
    name: string,
    args: VimValue[],
    context: BuiltinContext,
  ): Promise<VimValue> {
    await context.step();
    const item = this.functions.get(name);
    if (!item) throw new Error(`E117: Unknown function: ${name}`);
    if (args.length < item.min)
      throw new Error(`E119: Not enough arguments for function: ${name}`);
    if (args.length > item.max)
      throw new Error(`E118: Too many arguments for function: ${name}`);
    return item.run(args, context);
  }
  describe(): {
    functions: {
      name: string;
      min: number;
      max: number;
      description: string;
    }[];
    events: string[];
    commands: string[];
    options: string[];
  } {
    return {
      functions: [...this.functions.values()].map(
        ({ name, min, max, description }) => ({ name, min, max, description }),
      ),
      events: [...this.events],
      commands: [...this.commands],
      options: [...this.options.keys()],
    };
  }
}
