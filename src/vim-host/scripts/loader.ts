import fs from "node:fs/promises";
import path from "node:path";
import { VimScriptRuntime, globMatch } from "../../vim/script/runtime";
import type {
  ScriptEditor,
  ScriptSourceHost,
} from "../../vim/script/contracts";
import { stringValue, type VimValue } from "../../vim/script/value";
interface ScriptFile {
  path: string;
  text: string;
}
/** A runtime root is the existing Vault-owned Vim directory, never the user's HOME. */
export class VimScriptLoader implements ScriptSourceHost {
  readonly configurationFiles = new Set<string>();
  readonly directories = new Set<string>();
  private roots: string[];
  private readonly loadedPackages = new Set<string>();
  private configPhase = false;
  private initializing: VimScriptRuntime | null = null;
  private cancelled = false;
  private realRoot: string | null = null;
  private runtimeForDiagnostics: VimScriptRuntime | null = null;
  constructor(readonly root: string, private readonly vaultRoot: string) {
    this.roots = [root];
  }
  cancel(): void { this.cancelled = true; this.initializing?.dispose(); this.initializing = null; }
  async initialize(
    virtualSources: ReadonlyMap<string, string>,
  ): Promise<VimScriptRuntime> {
    const runtime = new VimScriptRuntime(this);
    this.initializing = runtime;
    this.runtimeForDiagnostics = runtime;
    for (const [extension, source] of virtualSources)
      runtime.virtualSources.set(extension, source);
    this.configurationFiles.add(path.join(this.root, ".vimrc"));
    if (!(await this.discover(this.root))) {
      this.initializing = null;
      return runtime;
    }
    this.directories.add(this.root);
    this.configPhase = true;
    try {
      const config = await this.optional(path.join(this.root, ".vimrc"));
      if (config) await runtime.load(config.text, config.path);
    } catch (error) {
      runtime.report(error);
    } finally {
      this.configPhase = false;
    }
    if (this.cancelled) return runtime;
    const start = await this.package(null, true);
    for (const source of [
      ...(await this.runtime("plugin/**/*.vim", true)),
      ...start,
    ]) {
      if (this.cancelled) return runtime;
      try {
        await runtime.load(source.text, source.path);
      } catch (error) {
        runtime.report(error);
      }
    }
    for (const directory of this.roots.slice(1))
      this.loadedPackages.add(directory);
    for (const source of await this.runtime("ftdetect/*.vim", true)) {
      if (this.cancelled) return runtime;
      try {
        await runtime.load(source.text, source.path);
      } catch (error) {
        runtime.report(error);
      }
    }
    await this.collectWatchDirectories();
    this.initializing = null;
    return runtime;
  }
  async reloadConfiguration(
    runtime: VimScriptRuntime,
    virtual: ReadonlyMap<string, string>,
  ): Promise<void> {
    const owned = new Set(this.configurationFiles);
    await runtime.reloadConfiguration(
      owned,
      async (load) => {
        this.configurationFiles.clear();
        this.configurationFiles.add(path.join(this.root, ".vimrc"));
        this.configPhase = true;
        try {
          const config = await this.optional(path.join(this.root, ".vimrc"));
          if (config) await load(config.text, config.path);
        } finally {
          this.configPhase = false;
        }
      },
      virtual,
    );
  }
  async source(request: string, from: string): Promise<ScriptFile> {
    const base = path.isAbsolute(from) ? path.dirname(from) : this.root;
    const candidate = path.resolve(
      base,
      request.startsWith("~/")
        ? path.join(this.root, request.slice(2))
        : request,
    );
    const source = await this.optional(candidate);
    if (!source) throw new Error(`E484: Can't open file: ${request}`);
    return source;
  }
  async runtime(pattern: string, all: boolean): Promise<ScriptFile[]> {
    const result: ScriptFile[] = [];
    for (const root of this.searchRoots()) {
      for (const file of await this.find(root, pattern)) {
        const source = await this.discoveredFile(file);
        if (source) result.push(source);
        if (!all && result.length) return result;
      }
    }
    return result;
  }
  async package(
    name: string | null,
    registerOnly: boolean,
  ): Promise<ScriptFile[]> {
    const selected: string[] = [];
    for (const group of await this.childDirectories(path.join(this.root, "pack"))) {
      for (const kind of name === null ? ["start"] : ["opt", "start"]) {
        for (const directory of await this.childDirectories(path.join(group, kind)))
          if (name === null || path.basename(directory) === name)
            selected.push(directory);
      }
    }
    if (name && !selected.length)
      throw new Error(`E919: Directory not found in 'packpath': ${name}`);
    for (const directory of selected)
      if (!this.roots.includes(directory)) this.roots.push(directory);
    const result: ScriptFile[] = [];
    if (!registerOnly)
      for (const directory of selected) {
        if (this.loadedPackages.has(directory)) continue;
        this.loadedPackages.add(directory);
        for (const root of [directory, path.join(directory, "after")])
          for (const file of [
            ...(await this.find(root, "plugin/**/*.vim")),
            ...(await this.find(root, "ftdetect/*.vim")),
          ]) {
            const source = await this.discoveredFile(file);
            if (source) result.push(source);
          }
      }
    await this.collectWatchDirectories();
    return result;
  }
  hasFiletype(): boolean {
    return [...this.directories].some(
      (directory) => path.basename(directory) === "ftplugin",
    );
  }
  async filetype(name: string): Promise<ScriptFile[]> {
    const result: ScriptFile[] = [];
    for (const type of name.split(".")) {
      if (!/^[\w+-]+$/u.test(type))
        throw new Error(`Invalid filetype: ${type}`);
      for (const root of this.searchRoots())
        for (const pattern of [
          `ftplugin/${type}.vim`,
          `ftplugin/${type}_*.vim`,
          `ftplugin/${type}/*.vim`,
        ]) {
          for (const file of await this.find(root, pattern)) {
            const source = await this.discoveredFile(file);
            if (source) result.push(source);
          }
        }
    }
    return result;
  }
  pathFunction(
    name: string,
    args: VimValue[],
    source: string,
    editor?: ScriptEditor,
  ): VimValue {
    let value = stringValue(args[0]),
      modifiers = name === "fnamemodify" ? stringValue(args[1]) : "";
    if (name === "expand") {
      const match = /^(%|<sfile>|<sdir>)(.*)$/u.exec(value);
      if (!match) return value;
      value =
        match[1] === "%"
          ? (editor?.path ?? "")
          : match[1] === "<sdir>"
            ? path.dirname(source) + path.sep
            : source;
      modifiers = match[2];
    }
    for (const modifier of modifiers.split(":").filter(Boolean)) {
      if (modifier === "p") value = path.resolve(this.root, value);
      else if (modifier === "h") value = path.dirname(value);
      else if (modifier === "t") value = path.basename(value);
      else if (modifier === "r")
        value = value.slice(0, value.length - path.extname(value).length);
      else if (modifier === "e") value = path.extname(value).slice(1);
      else if (modifier === ".")
        value = path.relative(this.root, path.resolve(this.root, value));
      else throw new Error(`Unsupported file-name modifier: :${modifier}`);
    }
    return value;
  }
  private searchRoots(): string[] {
    return [
      ...this.roots,
      ...this.roots.map((root) => path.join(root, "after")),
    ];
  }
  private async optional(file: string): Promise<ScriptFile | null> {
    try {
      const real = await this.resolvePath(file);
      const text = await fs.readFile(real, "utf8");
      if (this.configPhase) this.configurationFiles.add(file);
      this.directories.add(path.dirname(file));
      return { path: file, text };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  private async find(root: string, pattern: string): Promise<string[]> {
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]/u).includes(".."))
      throw new Error(
        `runtime path escapes the Vim configuration directory: ${pattern}`,
      );
    const parts = pattern.split("/");
    const result: string[] = [];
    const visit = async (directory: string, index: number): Promise<void> => {
      let entries;
      try {
        const real = await this.discover(directory);
        if (!real) return;
        entries = await fs.readdir(real, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      this.directories.add(directory);
      const part = parts[index];
      if (part === "**") {
        await visit(directory, index + 1);
        for (const entry of entries)
          if (entry.isDirectory() && !entry.name.startsWith("."))
            await visit(path.join(directory, entry.name), index);
        return;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!globMatch(part, entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (index === parts.length - 1) {
          if (entry.isFile() || entry.isSymbolicLink()) result.push(file);
        } else if (entry.isDirectory()) await visit(file, index + 1);
      }
    };
    await visit(root, 0);
    return result.sort();
  }
  private async collectWatchDirectories(): Promise<void> {
    const walk = async (directory: string) => {
      for (const child of await this.childDirectories(directory)) {
        this.directories.add(child);
        await walk(child);
      }
    };
    for (const root of this.searchRoots()) {
      for (const name of ["", "plugin", "autoload", "ftplugin", "ftdetect"]) {
        const directory = path.join(root, name);
        const real = await this.discover(directory);
        if (real && (await fs.stat(real)).isDirectory()) {
          this.directories.add(directory);
          if (name) await walk(directory);
        }
      }
    }
    for (const group of await this.childDirectories(path.join(this.root, "pack"))) {
      this.directories.add(path.dirname(group));
      this.directories.add(group);
      for (const kind of ["start", "opt"]) {
        const directory = path.join(group, kind);
        for (const child of await this.childDirectories(directory)) {
          this.directories.add(directory);
          this.directories.add(child);
        }
      }
    }
  }
  /** Watch canonical directories; retain the logical name for config dependency events. */
  async watchDirectories(install: (logical: string, canonical: string) => void): Promise<void> {
    for (const directory of this.directories) {
      const real = await this.discover(directory);
      if (real) install(directory, real);
    }
  }
  private async resolvePath(target: string): Promise<string> {
    if (!contained(this.root, target)) throw new BoundaryError(target);
    if (!this.realRoot) {
      const root = await fs.realpath(this.root);
      const vault = await fs.realpath(this.vaultRoot);
      if (!contained(vault, root) || path.relative(vault, root) === "")
        throw new BoundaryError(this.root);
      this.realRoot = root;
    }
    const real = await fs.realpath(target);
    if (!contained(this.realRoot, real)) throw new BoundaryError(target);
    return real;
  }
  private reportBoundary(error: unknown): boolean {
    if (!(error instanceof BoundaryError)) return false;
    if (!this.runtimeForDiagnostics?.errors.includes(error.message))
      this.runtimeForDiagnostics?.report(error);
    return true;
  }
  private async discover(target: string): Promise<string | null> {
    try { return await this.resolvePath(target); }
    catch (error) {
      if (missing(error) || this.reportBoundary(error)) return null;
      throw error;
    }
  }
  private async discoveredFile(file: string): Promise<ScriptFile | null> {
    try { return await this.optional(file); }
    catch (error) {
      if (this.reportBoundary(error)) return null;
      throw error;
    }
  }
  private async childDirectories(directory: string): Promise<string[]> {
    const real = await this.discover(directory);
    if (!real) return [];
    return (await fs.readdir(real, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  }
}
class BoundaryError extends Error {
  constructor(target: string) {
    super(`Vim script path escapes the Vault configuration directory: ${target}`);
  }
}
function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
export function contained(
  root: string,
  target: string,
  paths: Pick<
    typeof path,
    "relative" | "resolve" | "isAbsolute" | "sep"
  > = path,
): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(target));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative))
  );
}
