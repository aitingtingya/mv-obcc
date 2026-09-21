import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../process-runner";

export class GitFailure extends Error {
  constructor(readonly code: number | null, readonly detail: string) { super(detail || `Git exited with status ${code}`); }
}
export interface GitRunResult { code: number; stdout: Buffer; stderr: string }
/** Native Git only: no shell, no user credential persistence, no inherited repository override. */
export class GitProcess {
  private readonly children = new Set<ChildProcess>();
  private closed = false;
  constructor(readonly executable: string, readonly environment: NodeJS.ProcessEnv) {}
  async run(cwd: string, args: readonly string[], input?: string | Uint8Array, allowed = [0], literalPathspecs = true): Promise<GitRunResult> {
    if (this.closed) throw new Error("Git service is closed");
    const env = { ...this.environment, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
    for (const key of Object.keys(env)) {
      if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key as keyof typeof env];
    }
    // --literal-pathspecs protects filenames like "[a].md", but breaks `git stash push --include-untracked`
    // (its internal cleanup needs wildcard pathspecs), so stash calls opt out explicitly.
    const child = spawnProcess(this.executable, ["--no-pager", ...(literalPathspecs ? ["--literal-pathspecs"] : []), "-c", "color.ui=false", ...args], {
      cwd, env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error, code = -1): void => {
        if (settled) return;
        settled = true; this.children.delete(child);
        const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") };
        if (error) reject(error);
        else if (!allowed.includes(code)) reject(new GitFailure(code, result.stderr.trim()));
        else resolve(result);
      };
      child.stdout?.on("data", (data: Buffer) => stdout.push(data));
      child.stderr?.on("data", (data: Buffer) => stderr.push(data));
      child.on("error", (error) => finish(error));
      child.on("close", (code) => finish(undefined, code ?? -1));
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") finish(error); });
      child.stdin?.end(input);
    });
  }
  cancel(): void { for (const child of this.children) child.kill("SIGTERM"); }
  dispose(): void { this.closed = true; this.cancel(); }
}
