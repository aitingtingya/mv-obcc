import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveUserCommandEnvironment } from "../process-environment";
import { GitProcess } from "./process";
import { parseLog, parseStatus, selectPatch } from "./parse";
import type { GitCommit, GitDiffData, GitDiffSpec, GitInProgress, GitRef, GitSettings, GitSnapshot } from "./model";

export class GitRepository {
  private runner: GitProcess | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<GitSnapshot | null> | null = null;
  private generation = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private version = "";
  private configuredExecutable = "";
  snapshot: GitSnapshot | null = null;
  busy = 0;
  error = "";
  readonly output: string[] = [];
  constructor(readonly vaultRoot: string, private readonly settings: () => GitSettings, private readonly environment?: NodeJS.ProcessEnv) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private async process(): Promise<GitProcess> {
    if (this.disposed) throw new Error("Git service is closed");
    const executable = this.settings().executable.trim() || "git";
    if (!this.runner || executable !== this.configuredExecutable) {
      this.runner?.dispose(); this.configuredExecutable = executable;
      this.runner = new GitProcess(executable, this.environment ?? await resolveUserCommandEnvironment());
      this.version = (await this.runner.run(this.vaultRoot, ["--version"])).stdout.toString().trim();
    }
    return this.runner;
  }
  async bytes(args: readonly string[], input?: string | Uint8Array, allowed = [0], literalPathspecs = true): Promise<Buffer> {
    const process = await this.process();
    return (await process.run(this.snapshot?.root ?? this.vaultRoot, args, input, allowed, literalPathspecs)).stdout;
  }
  async text(args: readonly string[], input?: string | Uint8Array, allowed = [0]): Promise<string> { return (await this.bytes(args, input, allowed)).toString("utf8"); }
  /** Stash subcommands never take user pathspecs here; --literal-pathspecs would break --include-untracked cleanup. */
  async stash(args: readonly string[]): Promise<Buffer> { return this.bytes(args, undefined, [0], false); }
  private async existsGitPath(name: string): Promise<boolean> {
    const value = (await this.text(["rev-parse", "--git-path", name])).trim();
    try { await fs.access(path.resolve(this.snapshot?.root ?? this.vaultRoot, value)); return true; } catch { return false; }
  }
  async operation(): Promise<GitInProgress> {
    if (await this.existsGitPath("rebase-merge") || await this.existsGitPath("rebase-apply")) return "rebase";
    for (const [file, op] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) if (await this.existsGitPath(file)) return op;
    return null;
  }
  refresh(): Promise<GitSnapshot | null> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readSnapshot().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async readSnapshot(): Promise<GitSnapshot | null> {
    const generation = this.generation;
    try {
      const runner = await this.process();
      const probe = await runner.run(this.vaultRoot, ["rev-parse", "--show-toplevel"], undefined, [0, 128]);
      if (probe.code !== 0) {
        // A permission/ownership error is not an invitation to initialize a new repository.
        if (!probe.stderr.includes("not a git repository")) throw new Error(probe.stderr);
        this.snapshot = null; this.error = ""; this.notify(); return null;
      }
      const root = await fs.realpath(probe.stdout.toString().trim());
      const run = async (args: string[]) => (await runner.run(root, args)).stdout.toString();
      const [status, refsText, remotesText, stashText] = await Promise.all([
        run(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
        run(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads", "refs/remotes", "refs/tags"]),
        run(["remote"]), run(["stash", "list", "--format=%gd%x00%H%x00%gs", "-z"]),
      ]);
      const refs: GitRef[] = refsText.split("\n").filter(Boolean).map(line => {
        const [name, oid, upstream] = line.split("\0");
        return { name, oid, upstream, kind: name.startsWith("refs/heads/") ? "branch" : name.startsWith("refs/tags/") ? "tag" : "remote" };
      });
      const stashFields = stashText.split("\0"), stashes: GitSnapshot["stashes"] = [];
      for (let i = 0; i + 2 < stashFields.length; i += 3) if (stashFields[i]) stashes.push({ name: stashFields[i], oid: stashFields[i + 1], message: stashFields[i + 2] });
      const next: GitSnapshot = { ...parseStatus(status), root, version: this.version, refs, stashes,
        remotes: remotesText.trim().split("\n").filter(Boolean), operation: null, revision: (this.snapshot?.revision ?? 0) + 1 };
      if (generation !== this.generation || this.disposed) return this.snapshot;
      this.snapshot = next; next.operation = await this.operation(); this.error = ""; this.notify(); return next;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error); this.notify(); throw error;
    }
  }
  /** One queue for both UI surfaces; compound operations never interleave. */
  mutate<T>(label: string, run: () => Promise<T>, expectedHead?: string): Promise<T> {
    const generation = this.generation;
    this.busy++; this.notify();
    const task = this.pending.then(async () => {
      if (this.disposed || generation !== this.generation) throw new Error("Git operation cancelled");
      await this.refresh();
      if (expectedHead !== undefined && this.snapshot?.head !== expectedHead) throw new Error("HEAD changed; refresh and confirm again");
      this.output.push(`${new Date().toISOString()} ${label}`);
      try { const value = await run(); this.output.push("✓"); return value; }
      catch (error) { this.output.push(error instanceof Error ? error.message.replace(/(https?:\/\/)[^/@\s]+@/g, "$1***@") : "Git failed"); throw error; }
      finally { if (this.output.length > 200) this.output.splice(0, this.output.length - 200); }
    });
    const settled = task.finally(async () => {
      this.busy--;
      if (!this.disposed) { try { await this.refresh(); } catch { /* surfaced in error state */ } this.notify(); }
    });
    this.pending = settled.catch(() => undefined); return settled;
  }
  cancel(): void { this.generation++; this.runner?.cancel(); }
  dispose(): void { this.disposed = true; this.generation++; this.runner?.dispose(); this.listeners.clear(); }
  async initialize(branch = ""): Promise<void> {
    await this.mutate("Initialize repository", async () => {
      if (this.snapshot) throw new Error("This vault already belongs to a Git repository");
      if (branch) await this.checkName(branch);
      const args = ["init"]; if (branch) args.push(`--initial-branch=${branch}`);
      await this.bytes(args);
    });
  }
  async checkName(name: string): Promise<void> {
    if (!name || name.startsWith("-") || name.includes("\0")) throw new Error("Invalid Git name");
    await this.bytes(["check-ref-format", "--branch", name]);
  }
  async resolveCommit(ref: string): Promise<string> {
    const oid = (await this.text(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Invalid commit");
    return oid;
  }
  /** Topologically order commits oldest-first using real parent links; unrelated commits keep input order. */
  async sortOldestFirst(oids: string[]): Promise<string[]> {
    if (oids.length < 2) return [...oids];
    const out = await this.text(["rev-list", "--parents", "--no-walk=unsorted", ...oids]);
    const parents = new Map<string, string[]>();
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const [oid, ...rest] = line.split(" ");
      parents.set(oid, rest);
    }
    const inSet = new Set(oids), remaining = new Set(oids), result: string[] = [];
    const inputOrder = [...oids];
    while (remaining.size) {
      const next = inputOrder.find(oid => remaining.has(oid) && (parents.get(oid) ?? []).every(p => !inSet.has(p) || result.includes(p)));
      if (!next) { for (const oid of inputOrder) if (remaining.has(oid)) result.push(oid); break; }
      result.push(next); remaining.delete(next);
    }
    return result;
  }
  absolute(file: string): string {
    const root = this.snapshot?.root; if (!root) throw new Error("No repository");
    if (!file || file.includes("\0") || file.split(/[\\/]/).includes(".git")) throw new Error("Invalid repository path");
    const absolute = path.resolve(root, file), relative = path.relative(root, absolute);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Path is outside the repository");
    return absolute;
  }
  async history(skip = 0, ref = "", file?: string): Promise<GitCommit[]> {
    if (!this.snapshot?.head) return [];
    const args = ["log", "--date-order", "-z", "--format=%H%x00%P%x00%an%x00%aI%x00%B%x00%D", "--max-count=100", `--skip=${skip}`];
    if (ref && ref !== "--all") args.push(await this.resolveCommit(ref));
    else if (ref === "--all") args.push("--all");
    if (file) { this.absolute(file); args.push("--follow", "--", file); }
    return parseLog(await this.text(args));
  }
  async reflog(): Promise<GitCommit[]> { return parseLog(await this.text(["reflog", "-z", "--format=%H%x00%P%x00%an%x00%aI%x00%gs%x00%d", "--max-count=100"])); }
  async changedFiles(from: string, to: string): Promise<string[]> {
    const args = from ? ["diff", "--name-only", "-z", await this.resolveCommit(from), await this.resolveCommit(to), "--"]
      : ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", await this.resolveCommit(to), "--"];
    return (await this.text(args)).split("\0").filter(Boolean);
  }
  private async blob(ref: string, file: string): Promise<Buffer> {
    this.absolute(file);
    const names = ref === ":" ? ["ls-files", "--stage", "-z", "--", file] : ["ls-tree", "-z", ref, "--", file];
    const entry = await this.text(names);
    const match = /^(\d+) (?:blob )?([a-f0-9]+)(?: 0)?\t/.exec(entry);
    if (!match) return Buffer.alloc(0);
    if (match[1] === "160000") return Buffer.from(`Submodule ${match[2]}\n`);
    return this.bytes(["cat-file", "blob", match[2]]);
  }
  async worktreeBytes(file: string): Promise<Buffer> {
    const absolute = this.absolute(file);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) return Buffer.from(await fs.readlink(absolute));
      if (!stat.isFile()) return Buffer.from("Non-regular file\n");
      const parent = await fs.realpath(path.dirname(absolute));
      const relative = path.relative(this.snapshot!.root, parent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Symlink directory leaves repository");
      return await fs.readFile(absolute);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
  }
  async indexFingerprint(): Promise<string> { return createHash("sha256").update(await this.bytes(["ls-files", "--stage", "-z"])).digest("hex"); }
  /** Conflict stages with truthful source labels; rebase swaps the meaning of ours/theirs by design. */
  async conflictData(file: string): Promise<{ base: string; ours: string; theirs: string; worktree: Uint8Array; oursLabel: string; theirsLabel: string }> {
    this.absolute(file);
    const stages = (await this.text(["ls-files", "-u", "-z", "--", file])).split("\0").filter(Boolean);
    const blobs = new Map<number, Buffer>();
    for (const record of stages) {
      const [meta] = record.split("\t");
      const [mode, oid, stage] = meta.split(" ");
      if (mode === "160000") blobs.set(Number(stage), Buffer.from(`Submodule ${oid}\n`));
      else blobs.set(Number(stage), await this.bytes(["cat-file", "blob", oid]));
    }
    const operation = this.snapshot?.operation ?? await this.operation();
    const theirsRef = operation === "merge" ? "MERGE_HEAD" : operation === "revert" ? "REVERT_HEAD" : operation === "rebase" ? "REBASE_HEAD" : "CHERRY_PICK_HEAD";
    const describe = async (ref: string) => (await this.text(["log", "-1", "--format=%h %s", ref], undefined, [0, 128])).trim() || ref;
    const oursLabel = operation === "rebase" ? `HEAD（变基目标侧）· ${await describe("HEAD")}` : `HEAD · ${await describe("HEAD")}`;
    const theirsLabel = operation === "rebase" ? `${theirsRef}（正在回放的提交）· ${await describe(theirsRef)}` : `${theirsRef} · ${await describe(theirsRef)}`;
    return {
      base: (blobs.get(1) ?? Buffer.alloc(0)).toString("utf8"),
      ours: (blobs.get(2) ?? Buffer.alloc(0)).toString("utf8"),
      theirs: (blobs.get(3) ?? Buffer.alloc(0)).toString("utf8"),
      worktree: await this.worktreeBytes(file), oursLabel, theirsLabel,
    };
  }
  async diff(spec: GitDiffSpec, reverse = false): Promise<GitDiffData> {
    this.absolute(spec.path);
    const head = this.snapshot?.head ?? "", indexOid = await this.indexFingerprint();
    let beforeBytes: Buffer, afterBytes: Buffer, patch: string;
    const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "--unified=3", ...(reverse ? ["-R"] : [])];
    if (spec.kind === "working") {
      beforeBytes = await this.blob(":", spec.original ?? spec.path); afterBytes = await this.worktreeBytes(spec.path);
      const untracked = this.snapshot?.files.find(f => f.path === spec.path)?.untracked;
      patch = untracked
        ? await this.text(["diff", "--no-index", ...diffOptions, "--", process.platform === "win32" ? "NUL" : "/dev/null", spec.path], undefined, [0, 1])
        : await this.text(["diff", ...diffOptions, "--", spec.path, ...(spec.original ? [spec.original] : [])]);
    } else if (spec.kind === "staged") {
      beforeBytes = head ? await this.blob(head, spec.original ?? spec.path) : Buffer.alloc(0); afterBytes = await this.blob(":", spec.path);
      patch = await this.text(["diff", "--cached", ...diffOptions, "--", spec.path, ...(spec.original ? [spec.original] : [])]);
    } else {
      const to = await this.resolveCommit(spec.to!); const from = spec.from ? await this.resolveCommit(spec.from) : "";
      beforeBytes = from ? await this.blob(from, spec.original ?? spec.path) : Buffer.alloc(0); afterBytes = await this.blob(to, spec.path);
      patch = from ? await this.text(["diff", ...diffOptions, from, to, "--", spec.path])
        : await this.text(["show", "--format=", "--root", ...diffOptions, to, "--", spec.path]);
    }
    if (reverse) [beforeBytes, afterBytes] = [afterBytes, beforeBytes];
    const before = beforeBytes.toString("utf8"), after = afterBytes.toString("utf8");
    const binary = beforeBytes.includes(0) || afterBytes.includes(0) || !Buffer.from(before).equals(beforeBytes) || !Buffer.from(after).equals(afterBytes) || patch.includes("GIT binary patch") || patch.includes("Binary files ");
    return { spec, before, after, patch, binary, beforeBytes, afterBytes, head, indexOid };
  }
  async applySelection(data: GitDiffData, selected: Set<number>, reverse = false): Promise<void> {
    if (data.binary || data.spec.kind === "history") throw new Error("This diff cannot be partially staged");
    await this.mutate("Apply selected patch", async () => {
      const fresh = await this.diff(data.spec, reverse);
      if (fresh.patch !== data.patch || fresh.indexOid !== data.indexOid) throw new Error("Diff changed; refresh before applying");
      const patch = selectPatch(data.patch, selected);
      await this.bytes(["apply", "--cached", "--check", "--whitespace=nowarn", "-"], patch);
      await this.bytes(["apply", "--cached", "--whitespace=nowarn", "-"], patch);
    }, data.head);
  }
  async stage(files: string[]): Promise<void> { for (const f of files) this.absolute(f); await this.bytes(["add", "--", ...files]); }
  async unstage(files: string[]): Promise<void> {
    for (const f of files) this.absolute(f);
    await this.bytes(this.snapshot?.head ? ["restore", "--staged", "--", ...files] : ["rm", "--cached", "--", ...files]);
  }
  /** Per-line change markers relative to HEAD, derived from a machine diff (never from rendered rows). */
  async lineMarkers(file: string): Promise<{ added: Set<number>; modified: Set<number>; deletedAfter: Set<number> } | null> {
    this.absolute(file);
    if (!this.snapshot?.head || this.snapshot.files.find(f => f.path === file)?.untracked) return null;
    const out = await this.text(["diff", "--no-ext-diff", "--no-color", "--unified=0", "HEAD", "--", file], undefined, [0, 1]);
    const added = new Set<number>(), modified = new Set<number>(), deletedAfter = new Set<number>();
    for (const match of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
      const oldCount = +(match[2] ?? "1"), newStart = +match[3], newCount = +(match[4] ?? "1");
      if (newCount === 0) deletedAfter.add(Math.max(1, newStart));
      else for (let i = 0; i < newCount; i++) (oldCount > 0 ? modified : added).add(newStart + i);
    }
    return { added, modified, deletedAfter };
  }
  /** One-line blame summary for the current line; null for uncommitted/untracked lines. */
  async blameLine(file: string, line: number): Promise<string | null> {
    this.absolute(file);
    const out = await this.text(["blame", "--porcelain", "-L", `${line},${line}`, "--", file], undefined, [0, 128]);
    if (!out) return null;
    const sha = out.slice(0, 40);
    if (/^0{40}$/.test(sha)) return null;
    const author = /^author (.*)$/m.exec(out)?.[1] ?? "";
    const time = /^author-time (\d+)$/m.exec(out)?.[1];
    const summary = /^summary (.*)$/m.exec(out)?.[1] ?? "";
    const date = time ? new Date(+time * 1000).toISOString().slice(0, 10) : "";
    return `${author} · ${date} · ${summary} (${sha.slice(0, 7)})`;
  }
  async pull(): Promise<void> {
    const policy = this.settings().pull;
    const args = ["pull", "--no-edit"];
    if (policy === "ff-only") args.push("--ff-only");
    else if (policy === "rebase") args.push("--rebase");
    else if (policy === "merge") args.push("--no-rebase");
    else {
      const config = await this.text(["config", "--get", `branch.${this.snapshot?.branch}.rebase`], undefined, [0, 1]);
      const global = await this.text(["config", "--get", "pull.rebase"], undefined, [0, 1]);
      const ff = await this.text(["config", "--get", "pull.ff"], undefined, [0, 1]);
      if (!config.trim() && !global.trim() && !ff.trim()) args.push("--ff-only");
    }
    await this.bytes(args);
  }
}
