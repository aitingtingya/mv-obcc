import {
  DEFAULT_VIM_OPTIONS,
  type VimAbbreviation,
  type VimAutocmd,
  type VimMapping,
  type VimOptions,
  type VimRuntimeConfig,
} from "../core/types";
import type { VimrcDirective } from "./types";

export function compileVimRuntime(
  directives: readonly VimrcDirective[],
): VimRuntimeConfig {
  const options: VimOptions = { ...DEFAULT_VIM_OPTIONS };
  const mappings: VimMapping[] = [];
  const abbreviations: VimAbbreviation[] = [];
  const exCommands = new Map<string, string>();
  const autocmds: VimAutocmd[] = [];
  const seen = new Set<string>();
  let mapleader = "\\";

  for (const directive of directives) {
    if (seen.has(directive.canonical)) continue;
    seen.add(directive.canonical);
    if (directive.kind === "set") {
      for (const argument of directive.arguments) applyOption(options, argument);
    } else if (directive.kind === "mapleader") {
      mapleader = directive.value;
    } else if (directive.kind === "mapping") {
      const compiledMapping = expandLeader(directive.mapping, mapleader);
      for (const mode of directive.mapping.modes) {
        const index = mappings.findIndex((existing) =>
          existing.modes.includes(mode) && keysEqual(existing.lhs, compiledMapping.lhs));
        if (index >= 0) mappings.splice(index, 1);
      }
      mappings.push(compiledMapping);
    } else if (directive.kind === "unmap") {
      const lhs = expandLeaderKeys(directive.lhs, mapleader);
      for (let index = mappings.length - 1; index >= 0; index -= 1) {
        const mapping = mappings[index];
        if (keysEqual(mapping.lhs, lhs) && mapping.modes.some((mode) => directive.modes.includes(mode))) {
          mappings.splice(index, 1);
        }
      }
    } else if (directive.kind === "abbreviation") {
      const index = abbreviations.findIndex((entry) => entry.lhs === directive.abbreviation.lhs);
      if (index >= 0) abbreviations.splice(index, 1);
      abbreviations.push(directive.abbreviation);
    } else if (directive.kind === "unabbreviate") {
      const index = abbreviations.findIndex((entry) => entry.lhs === directive.lhs);
      if (index >= 0) abbreviations.splice(index, 1);
    } else if (directive.kind === "command") {
      exCommands.set(directive.name, directive.replacement);
    } else if (directive.kind === "delete-command") {
      exCommands.delete(directive.name);
    } else if (directive.kind === "autocmd-clear") {
      for (let index = autocmds.length - 1; index >= 0; index -= 1) {
        if (directive.group === null || autocmds[index]?.group === directive.group) autocmds.splice(index, 1);
      }
    } else if (directive.kind === "autocmd") {
      autocmds.push(directive.autocmd);
    }
  }
  return { options, mappings, abbreviations, exCommands, autocmds };
}

function applyOption(options: VimOptions, raw: string): void {
  const assignment = raw.match(/^([a-z]+)=(.*)$/u);
  if (assignment) {
    const name = normalizeOptionName(assignment[1]);
    if (!name) return;
    const current = options[name];
    if (typeof current === "number") {
      const parsed = Number.parseInt(assignment[2], 10);
      if (Number.isFinite(parsed) && parsed > 0) (options as unknown as Record<string, unknown>)[name] = parsed;
    } else if (name === "clipboard") {
      const value = assignment[2];
      options.clipboard = value === "unnamed" || value === "unnamedplus" ? value : "";
    }
    return;
  }
  const inverse = raw.startsWith("inv");
  const disabled = raw.startsWith("no");
  const name = normalizeOptionName(raw.slice(inverse ? 3 : disabled ? 2 : 0).replace(/[!?]$/u, ""));
  if (!name || typeof options[name] !== "boolean") return;
  (options as unknown as Record<string, unknown>)[name] = inverse ? !options[name] : !disabled;
}

function normalizeOptionName(raw: string): keyof VimOptions | null {
  const aliases: Record<string, keyof VimOptions> = {
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

function expandLeader(mapping: VimMapping, leader: string): VimMapping {
  return {
    ...mapping,
    lhs: expandLeaderKeys(mapping.lhs, leader),
    rhs: expandLeaderKeys(mapping.rhs, leader),
  };
}

function expandLeaderKeys(keys: readonly string[], leader: string): string[] {
  const leaderKeys = tokenizeLeader(leader);
  return keys.flatMap((key) => /^<leader>$/iu.test(key) ? leaderKeys : [key]);
}

function tokenizeLeader(value: string): string[] {
  return /^<[^>]+>$/u.test(value) ? [value] : [...value];
}

function keysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => right[index] === key);
}
