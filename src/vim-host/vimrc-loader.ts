import path from "node:path";
import { compileVimRuntime } from "../vim/vimrc/runtime";
import { parseVimrc } from "../vim/vimrc/parser";
import type { VimRuntimeConfig } from "../vim/core/types";
import type { VimrcDiagnostic, VimrcDirective } from "../vim/vimrc/types";

export interface VimrcLoaderOptions {
  globalPath: string;
  virtualSource?: string;
  virtualName?: string;
  readFile: (filePath: string) => Promise<string | null>;
}

export interface LoadedVimrc {
  runtime: VimRuntimeConfig;
  diagnostics: VimrcDiagnostic[];
  loadedFiles: string[];
}

export async function loadVimrc(options: VimrcLoaderOptions): Promise<LoadedVimrc> {
  const directives: VimrcDirective[] = [];
  const diagnostics: VimrcDiagnostic[] = [];
  const loadedFiles: string[] = [];
  const root = path.dirname(path.resolve(options.globalPath));
  const active = new Set<string>();

  const globalText = await options.readFile(options.globalPath);
  if (globalText !== null) {
    await expandSource(options.globalPath, globalText, 0);
  }
  if (options.virtualSource?.trim()) {
    await expandParsed(
      parseVimrc(options.virtualSource, options.virtualName ?? "virtual vimrc"),
      options.virtualName ?? "virtual vimrc",
      root,
      0,
    );
  }

  return {
    runtime: compileVimRuntime(directives),
    diagnostics,
    loadedFiles,
  };

  async function expandSource(filePath: string, text: string, depth: number): Promise<void> {
    const resolved = path.resolve(filePath);
    if (!insideRoot(root, resolved)) {
      diagnostics.push({ severity: "error", source: filePath, line: 1, message: "source must stay inside the mv-AIDE Vim configuration directory." });
      return;
    }
    if (depth > 20) {
      diagnostics.push({ severity: "error", source: filePath, line: 1, message: "source nesting exceeds 20 levels." });
      return;
    }
    if (active.has(resolved)) {
      diagnostics.push({ severity: "error", source: filePath, line: 1, message: "source cycle detected." });
      return;
    }
    active.add(resolved);
    loadedFiles.push(resolved);
    await expandParsed(parseVimrc(text, resolved), resolved, path.dirname(resolved), depth);
    active.delete(resolved);
  }

  async function expandParsed(
    parsed: ReturnType<typeof parseVimrc>,
    sourceName: string,
    baseDirectory: string,
    depth: number,
  ): Promise<void> {
    diagnostics.push(...parsed.diagnostics);
    for (const directive of parsed.directives) {
      if (directive.kind !== "source") {
        directives.push(directive);
        continue;
      }
      const resolved = resolveSourcePath(directive.path, baseDirectory, root);
      if (!resolved) {
        diagnostics.push({
          severity: "error",
          source: sourceName,
          line: directive.line,
          message: `source path escapes the Vim configuration directory: ${directive.path}`,
        });
        continue;
      }
      const child = await options.readFile(resolved);
      if (child === null) {
        diagnostics.push({ severity: "error", source: sourceName, line: directive.line, message: `source file not found: ${directive.path}` });
        continue;
      }
      await expandSource(resolved, child, depth + 1);
    }
  }
}

function resolveSourcePath(raw: string, baseDirectory: string, root: string): string | null {
  const expanded = raw.startsWith("~/") ? path.join(root, raw.slice(2)) : raw;
  const resolved = path.resolve(baseDirectory, expanded);
  return insideRoot(root, resolved) ? resolved : null;
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
