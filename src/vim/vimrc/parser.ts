import { tokenizeVimKeys } from "../core/engine";
import type {
  VimAutocmdEvent,
  VimMapping,
  VimMode,
} from "../core/types";
import type {
  ParsedVimrc,
  VimrcDiagnostic,
  VimrcDirective,
} from "./types";

const AUTOCMD_EVENTS = new Set<VimAutocmdEvent>([
  "BufEnter",
  "BufLeave",
  "BufWritePre",
  "BufWritePost",
  "InsertEnter",
  "InsertLeave",
]);

export function parseVimrc(text: string, source = ".vimrc"): ParsedVimrc {
  const directives: VimrcDirective[] = [];
  const diagnostics: VimrcDiagnostic[] = [];
  const logicalLines = joinContinuationLines(text);
  let autocmdGroup: string | null = null;

  for (const entry of logicalLines) {
    const trimmed = entry.text.trim();
    if (!trimmed || trimmed.startsWith('"')) continue;
    const group = trimmed.match(/^augroup(?:\s+(.+))?$/u);
    if (group) {
      const name = group[1]?.trim();
      if (!name) {
        diagnostics.push(error(source, entry.line, "augroup requires a name or END."));
      } else {
        autocmdGroup = name.toUpperCase() === "END" ? null : name;
      }
      continue;
    }

    const parsed = parseDirective(trimmed, source, entry.line, autocmdGroup);
    if ("diagnostic" in parsed) diagnostics.push(parsed.diagnostic);
    else directives.push(parsed.directive);
  }

  if (autocmdGroup !== null) {
    diagnostics.push(error(source, logicalLines.at(-1)?.line ?? 1, `augroup ${autocmdGroup} is missing augroup END.`));
  }
  return { directives, diagnostics };
}

function parseDirective(
  line: string,
  source: string,
  lineNumber: number,
  autocmdGroup: string | null,
): { directive: VimrcDirective } | { diagnostic: VimrcDiagnostic } {
  const [rawCommand = "", ...restTokens] = line.split(/\s+/u);
  const command = rawCommand.replace(/!$/u, "");
  const rest = line.slice(rawCommand.length).trimStart();

  if (command === "set" || command === "setlocal") {
    const arguments_ = restTokens.filter(Boolean);
    if (arguments_.length === 0) return failure(source, lineNumber, `${command} requires at least one option.`);
    return success({
      kind: "set",
      source,
      line: lineNumber,
      arguments: arguments_,
      canonical: `set ${arguments_.join(" ")}`,
    });
  }

  if (command === "let") {
    const leader = rest.match(/^(?:g:)?mapleader\s*=\s*(.+)$/u);
    if (!leader) {
      return failure(source, lineNumber, "Only let mapleader is supported; Vimscript expressions are not available.");
    }
    const value = parseLeaderValue(leader[1] ?? "");
    if (value === null || value.length === 0) {
      return failure(source, lineNumber, "mapleader must be a non-empty quoted string or key token.");
    }
    return success({
      kind: "mapleader",
      source,
      line: lineNumber,
      value,
      canonical: `let mapleader=${value}`,
    });
  }

  const mappingModes = modesForMapCommand(command);
  if (mappingModes) {
    if (/(?:^|\s)<expr>(?:\s|$)/iu.test(rest)) {
      return failure(source, lineNumber, `${command} <expr> mappings require Vimscript evaluation and are not supported.`);
    }
    const mapping = parseMapping(rest, mappingModes, command.includes("nore"));
    if (!mapping) return failure(source, lineNumber, `${command} requires a left- and right-hand side.`);
    return success({
      kind: "mapping",
      source,
      line: lineNumber,
      mapping,
      canonical: `${command} ${mapping.lhs.join("")} ${mapping.rhs.join("")}`,
    });
  }

  const unmapModes = modesForUnmapCommand(command);
  if (unmapModes) {
    const lhs = stripMapOptions(rest).trim();
    if (!lhs) return failure(source, lineNumber, `${command} requires a left-hand side.`);
    const keys = tokenizeVimKeys(lhs.split(/\s+/u)[0] ?? "");
    return success({
      kind: "unmap",
      source,
      line: lineNumber,
      modes: unmapModes,
      lhs: keys,
      canonical: `${command} ${keys.join("")}`,
    });
  }

  if (["abbrev", "abbreviate", "iabbrev", "iabbreviate", "inoreabbrev"].includes(command)) {
    const split = splitFirstArgument(stripMapOptions(rest));
    if (!split || !split.rest) return failure(source, lineNumber, `${command} requires a left- and right-hand side.`);
    return success({
      kind: "abbreviation",
      source,
      line: lineNumber,
      abbreviation: {
        lhs: split.first,
        rhs: split.rest,
        recursive: !command.includes("nore"),
      },
      canonical: `${command} ${split.first} ${split.rest}`,
    });
  }

  if (["unabbrev", "unabbreviate", "iunabbrev", "iunabbreviate"].includes(command)) {
    const lhs = stripMapOptions(rest).trim();
    if (!lhs) return failure(source, lineNumber, `${command} requires a left-hand side.`);
    return success({
      kind: "unabbreviate",
      source,
      line: lineNumber,
      lhs,
      canonical: `iunabbrev ${lhs}`,
    });
  }

  if (command === "source" || command === "so") {
    if (!rest) return failure(source, lineNumber, "source requires a relative file path.");
    return success({
      kind: "source",
      source,
      line: lineNumber,
      path: unquote(rest),
      canonical: `source ${unquote(rest)}`,
    });
  }

  if (command === "command" || command === "com") {
    const withoutOptions = rest.replace(/^(?:-[A-Za-z]+(?:=\S+)?\s+)*/u, "");
    const split = splitFirstArgument(withoutOptions);
    if (!split || !split.rest) return failure(source, lineNumber, "command requires a name and replacement.");
    return success({
      kind: "command",
      source,
      line: lineNumber,
      name: split.first,
      replacement: split.rest,
      canonical: `command ${split.first} ${split.rest}`,
    });
  }

  if (command === "delcommand" || command === "delc") {
    if (!rest) return failure(source, lineNumber, "delcommand requires a name.");
    return success({
      kind: "delete-command",
      source,
      line: lineNumber,
      name: rest,
      canonical: `delcommand ${rest}`,
    });
  }

  if (command === "autocmd" || command === "au") {
    if (!rest || rawCommand.endsWith("!") && rest.split(/\s+/u).length < 2) {
      return success({
        kind: "autocmd-clear",
        source,
        line: lineNumber,
        group: autocmdGroup,
        canonical: `autocmd! ${autocmdGroup ?? ""}`.trimEnd(),
      });
    }
    const parts = rest.split(/\s+/u);
    const event = parts.shift() as VimAutocmdEvent | undefined;
    const pattern = parts.shift();
    const body = parts.join(" ");
    if (!event || !AUTOCMD_EVENTS.has(event) || !pattern || !body) {
      return failure(source, lineNumber, "autocmd requires a supported event, pattern and Ex command.");
    }
    return success({
      kind: "autocmd",
      source,
      line: lineNumber,
      autocmd: { group: autocmdGroup, event, pattern, command: body },
      canonical: `autocmd ${autocmdGroup ?? ""} ${event} ${pattern} ${body}`.replace(/\s+/g, " ").trim(),
    });
  }

  return failure(source, lineNumber, `Unsupported vimrc directive: ${rawCommand}`);
}

function parseMapping(
  rest: string,
  modes: readonly VimMode[],
  nonRecursive: boolean,
): VimMapping | null {
  const split = splitFirstArgument(stripMapOptions(rest));
  if (!split || !split.rest) return null;
  return {
    modes,
    lhs: tokenizeVimKeys(split.first),
    rhs: tokenizeVimKeys(split.rest),
    recursive: !nonRecursive,
  };
}

function parseLeaderValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replace(/\\\\/gu, "\\")
      .replace(/\\"/gu, '"')
      .replace(/\\n/gu, "\n")
      .replace(/\\t/gu, "\t");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return /^<[^>]+>$/u.test(value) || [...value].length === 1 ? value : null;
}

function stripMapOptions(value: string): string {
  return value.replace(/^(?:<(?:buffer|silent|special|script|expr|unique|nowait)>\s*)+/iu, "");
}

function splitFirstArgument(value: string): { first: string; rest: string } | null {
  const match = value.trim().match(/^(\S+)(?:\s+(.*))?$/u);
  return match ? { first: match[1], rest: match[2] ?? "" } : null;
}

function modesForMapCommand(command: string): readonly VimMode[] | null {
  const modes: Record<string, readonly VimMode[]> = {
    map: ["normal", "visual", "visual-line", "visual-block", "operator-pending"],
    noremap: ["normal", "visual", "visual-line", "visual-block", "operator-pending"],
    nmap: ["normal"],
    nnoremap: ["normal"],
    vmap: ["visual", "visual-line", "visual-block"],
    vnoremap: ["visual", "visual-line", "visual-block"],
    xmap: ["visual", "visual-line", "visual-block"],
    xnoremap: ["visual", "visual-line", "visual-block"],
    omap: ["operator-pending"],
    onoremap: ["operator-pending"],
    imap: ["insert"],
    inoremap: ["insert"],
    cmap: ["command-line"],
    cnoremap: ["command-line"],
  };
  return modes[command] ?? null;
}

function modesForUnmapCommand(command: string): readonly VimMode[] | null {
  const modes: Record<string, readonly VimMode[]> = {
    unmap: ["normal", "visual", "visual-line", "visual-block", "operator-pending"],
    nunmap: ["normal"],
    vunmap: ["visual", "visual-line", "visual-block"],
    xunmap: ["visual", "visual-line", "visual-block"],
    ounmap: ["operator-pending"],
    iunmap: ["insert"],
    cunmap: ["command-line"],
  };
  return modes[command] ?? null;
}

function joinContinuationLines(text: string): Array<{ line: number; text: string }> {
  const result: Array<{ line: number; text: string }> = [];
  for (const [index, raw] of text.replace(/\r\n?/g, "\n").split("\n").entries()) {
    const continuation = raw.match(/^\s*\\(.*)$/u);
    if (continuation && result.length > 0) {
      result[result.length - 1].text += continuation[1] ?? "";
    } else {
      result.push({ line: index + 1, text: raw });
    }
  }
  return result;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function success(directive: VimrcDirective): { directive: VimrcDirective } {
  return { directive };
}

function failure(source: string, line: number, message: string): { diagnostic: VimrcDiagnostic } {
  return { diagnostic: error(source, line, message) };
}

function error(source: string, line: number, message: string): VimrcDiagnostic {
  return { severity: "error", source, line, message };
}
