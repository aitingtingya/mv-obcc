import {
  DEFAULT_VIM_OPTIONS,
  type VimAbbreviation,
  type VimAutocmd,
  type VimMapping,
  type VimOptions,
  type VimRuntimeConfig,
} from "../core/types";
import type { VimrcDirective } from "./types";
import type { VimrcDiagnostic } from "./types";
import { applyVimOptions } from "../core/options";

export function compileVimRuntime(
  directives: readonly VimrcDirective[],
  diagnostics: VimrcDiagnostic[] = [],
  initial?: VimRuntimeConfig,
): VimRuntimeConfig {
  const options: VimOptions = { ...DEFAULT_VIM_OPTIONS, ...initial?.options };
  const mappings: VimMapping[] = [...initial?.mappings ?? []];
  const abbreviations: VimAbbreviation[] = [...initial?.abbreviations ?? []];
  const exCommands = new Map<string, string>(initial?.exCommands);
  const autocmds: VimAutocmd[] = [...initial?.autocmds ?? []];
  let mapleader = initial?.mapleader ?? "\\";

  for (const directive of directives) {
    if (directive.kind === "set") {
      const result = applyVimOptions(options, directive.arguments);
      diagnostics.push(...result.errors.map((message) => ({
        severity: "error" as const, source: directive.source, line: directive.line, message,
      })));
    } else if (directive.kind === "mapleader") {
      mapleader = directive.value;
    } else if (directive.kind === "mapping") {
      const compiledMapping = expandLeader(directive.mapping, mapleader);
      removeMappingModes(mappings, compiledMapping.lhs, compiledMapping.modes);
      mappings.push(compiledMapping);
    } else if (directive.kind === "unmap") {
      const lhs = expandLeaderKeys(directive.lhs, mapleader);
      removeMappingModes(mappings, lhs, directive.modes);
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
  return { options, mappings, abbreviations, exCommands, autocmds, mapleader };
}

function expandLeader(mapping: VimMapping, leader: string): VimMapping {
  return {
    ...mapping,
    lhs: expandLeaderKeys(mapping.lhs, leader),
    rhs: expandLeaderKeys(mapping.rhs, leader),
  };
}

function removeMappingModes(mappings: VimMapping[], lhs: readonly string[], removed: VimMapping["modes"]): void {
  for (let index = mappings.length - 1; index >= 0; index -= 1) {
    const mapping = mappings[index];
    if (!keysEqual(mapping.lhs, lhs)) continue;
    const modes = mapping.modes.filter((mode) => !removed.includes(mode));
    if (modes.length) mappings[index] = { ...mapping, modes };
    else mappings.splice(index, 1);
  }
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
