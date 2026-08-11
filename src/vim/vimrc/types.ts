import type {
  VimAbbreviation,
  VimAutocmd,
  VimMapping,
  VimMode,
} from "../core/types";

interface BaseDirective {
  source: string;
  line: number;
  canonical: string;
}

export type VimrcDirective =
  | (BaseDirective & { kind: "set"; arguments: string[] })
  | (BaseDirective & { kind: "mapleader"; value: string })
  | (BaseDirective & { kind: "mapping"; mapping: VimMapping })
  | (BaseDirective & { kind: "unmap"; modes: readonly VimMode[]; lhs: readonly string[] })
  | (BaseDirective & { kind: "abbreviation"; abbreviation: VimAbbreviation })
  | (BaseDirective & { kind: "unabbreviate"; lhs: string })
  | (BaseDirective & { kind: "source"; path: string })
  | (BaseDirective & { kind: "command"; name: string; replacement: string })
  | (BaseDirective & { kind: "delete-command"; name: string })
  | (BaseDirective & { kind: "autocmd"; autocmd: VimAutocmd })
  | (BaseDirective & { kind: "autocmd-clear"; group: string | null });

export interface VimrcDiagnostic {
  severity: "warning" | "error";
  source: string;
  line: number;
  message: string;
}

export interface ParsedVimrc {
  directives: VimrcDirective[];
  diagnostics: VimrcDiagnostic[];
}
