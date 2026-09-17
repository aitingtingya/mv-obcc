import { DEFAULT_VIM_OPTIONS, type VimOptions } from "./types";
import { keywordSource } from "./keywords";

const aliases: Record<string, keyof VimOptions> = {
  ts: "tabstop", sw: "shiftwidth", sts: "softtabstop", et: "expandtab",
  ai: "autoindent", tw: "textwidth", ic: "ignorecase", scs: "smartcase",
  nu: "number", rnu: "relativenumber", tm: "timeoutlen", cb: "clipboard",
  ws: "wrapscan", hls: "hlsearch", is: "incsearch", so: "scrolloff",
  mmd: "maxmapdepth", isk: "iskeyword",
};

export interface VimOptionResult {
  output: string[];
  errors: string[];
}

export function optionName(raw: string): keyof VimOptions | null {
  const name = aliases[raw] ?? raw;
  return Object.hasOwn(DEFAULT_VIM_OPTIONS, name) ? name : null;
}

/** Parse :set once for both live commands and configuration files. */
export function applyVimOptions(options: VimOptions, arguments_: readonly string[]): VimOptionResult {
  const output: string[] = [];
  const errors: string[] = [];
  for (const raw of arguments_) {
    try {
      if (raw === "all&") {
        Object.assign(options, DEFAULT_VIM_OPTIONS);
        continue;
      }
      if (raw === "all") {
        output.push(...Object.keys(options).map((key) => displayOption(options, key as keyof VimOptions)));
        continue;
      }
      const match = /^(inv|no)?([a-z]+)(\+=|-=|\^=|=|:|\?|!|&(?:vim|vi)?)?(.*)$/u.exec(raw);
      if (!match) throw new Error(`E518: Unknown option: ${raw}`);
      // An exact name wins over prefixes (e.g. number).
      const exact = optionName(`${match[1] ?? ""}${match[2]}`);
      const name = exact ?? optionName(match[2]);
      const prefix = exact ? "" : match[1] ?? "";
      if (!name) throw new Error(`E518: Unknown option: ${raw}`);
      const operator = match[3] ?? "";
      const value = match[4];
      const current = options[name];
      if (operator === "?" || (!operator && !prefix && typeof current !== "boolean")) {
        if (value) throw new Error(`E474: Invalid argument: ${raw}`);
        output.push(displayOption(options, name));
      } else if (operator.startsWith("&")) {
        if (prefix || value) throw new Error(`E474: Invalid argument: ${raw}`);
        assign(options, name, DEFAULT_VIM_OPTIONS[name]);
      } else if (typeof current === "boolean") {
        if (value || !["", "!"].includes(operator)) throw new Error(`E474: Invalid argument: ${raw}`);
        assign(options, name, prefix === "inv" || operator === "!" ? !current : prefix !== "no");
      } else {
        if (prefix || !["=", ":", "+=", "-=", "^="].includes(operator)) throw new Error(`E474: Invalid argument: ${raw}`);
        if (typeof current === "number") {
          if (!/^-?\d+$/u.test(value)) throw new Error(`E521: Number required: ${raw}`);
          const operand = Number(value);
          const next = operator === "+=" ? current + operand : operator === "-=" ? current - operand
            : operator === "^=" ? current * operand : operand;
          const minimum = name === "softtabstop" ? -1 : ["tabstop", "maxmapdepth"].includes(name) ? 1 : 0;
          if (!Number.isSafeInteger(next) || next < minimum) throw new Error(`E487: Argument must be positive: ${raw}`);
          assign(options, name, next);
        } else {
          const parts = current ? current.split(",") : [];
          const incoming = value ? value.split(",") : [];
          const combined = operator === "+=" ? [...parts, ...incoming] : operator === "^=" ? [...incoming, ...parts]
            : operator === "-=" ? parts.filter((part) => !incoming.includes(part)) : incoming;
          if (name === "clipboard") {
            if (combined.some((part) => part !== "unnamed" && part !== "unnamedplus")) throw new Error(`E474: Invalid clipboard value: ${value}`);
            assign(options, name, ["unnamed", "unnamedplus"].filter((part) => combined.includes(part)).join(","));
          } else {
            const next = combined.join(",");
            if (name === "iskeyword") keywordSource(next);
            assign(options, name, next);
          }
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      break;
    }
  }
  return { output, errors };
}

function displayOption(options: VimOptions, name: keyof VimOptions): string {
  const value = options[name];
  return typeof value === "boolean" ? `${value ? "" : "no"}${name}` : `${name}=${String(value)}`;
}

function assign(options: VimOptions, name: keyof VimOptions, value: string | number | boolean): void {
  // The registry above validates the value against the existing option's type.
  Object.assign(options, { [name]: value });
}
