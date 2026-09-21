import type { GitRepository } from "./repository";
import type { GitCommit, GitDiffSpec, GitSnapshot, GitTarget } from "./model";

export type GitGroup = "repository" | "file" | "commit" | "branch" | "tag" | "remote" | "stash" | "operation";
export interface GitAction { id: string; zh: string; en: string; group: GitGroup; destructive?: boolean }
const definitions: [string, string, string, GitGroup, boolean?][] = [
  ["open", "打开工作区", "Open source control", "repository"], ["init", "初始化当前 Vault", "Initialize current vault", "repository"],
  ["refresh", "刷新", "Refresh", "repository"], ["output", "查看操作输出", "Show output", "repository"], ["cancel", "取消进行中的命令", "Cancel running command", "repository"],
  ["history", "查看历史图", "Show history", "repository"], ["reflog", "查看引用日志", "Show reflog", "repository"],
  ["ignore-edit", "编辑忽略规则", "Edit ignore rules", "repository"], ["identity", "设置本仓库作者信息", "Set repository identity", "repository"],
  ["stage", "暂存文件", "Stage files", "file"], ["unstage", "取消暂存文件", "Unstage files", "file"],
  ["stage-all", "暂存全部改动", "Stage all changes", "repository"], ["unstage-all", "取消全部暂存", "Unstage all changes", "repository"],
  ["diff", "查看文件差异", "Open file diff", "file"], ["file-open", "打开文件", "Open file", "file"],
  ["file-history", "查看文件历史", "Open file history", "file"], ["file-copy", "复制文件路径", "Copy file path", "file"],
  ["file-reveal", "在系统中显示文件", "Reveal file", "file"], ["ignore", "添加到忽略规则", "Add to ignore rules", "file"],
  ["discard", "丢弃文件修改", "Discard file changes", "file", true], ["discard-all", "丢弃全部工作区修改", "Discard all worktree changes", "repository", true],
  ["blame", "查询当前文件行归属", "Show file blame", "file"], ["restore-file", "从历史版本恢复文件", "Restore file from revision", "file", true],
  ["commit", "提交", "Commit", "repository"], ["commit-staged", "提交暂存内容", "Commit staged", "repository"],
  ["commit-all", "暂存全部并提交", "Stage all and commit", "repository"], ["commit-push", "提交并推送", "Commit and push", "repository"],
  ["commit-all-push", "暂存全部并提交推送", "Stage all, commit & push", "repository"],
  ["commit-sync", "提交并同步", "Commit and sync", "repository"], ["amend", "修改最新提交", "Amend latest commit", "repository", true],
  ["undo-commit", "撤销最新提交并保留暂存", "Undo latest commit (keep staged)", "repository", true],
  ["commit-details", "查看提交详情", "Show commit details", "commit"], ["commit-diff", "查看提交改动", "Show commit changes", "commit"],
  ["compare", "比较两个版本", "Compare revisions", "commit"], ["compare-head", "与 HEAD 比较", "Compare with HEAD", "commit"],
  ["compare-base", "与共同祖先比较", "Compare with merge base", "commit"], ["compare-upstream", "与上游比较", "Compare with upstream", "commit"],
  ["copy-sha", "复制提交 SHA", "Copy commit hash", "commit"], ["copy-message", "复制提交消息", "Copy commit message", "commit"],
  ["checkout-detached", "检出提交（分离 HEAD）", "Checkout commit (detached HEAD)", "commit", true],
  ["branch-from", "从此处创建分支", "Create branch from revision", "commit"], ["tag-from", "从此处创建标签", "Create tag from revision", "commit"],
  ["cherry-pick", "应用提交", "Cherry-pick commit", "commit"], ["revert", "创建反向提交", "Revert commit", "commit"],
  ["cherry-pick-batch", "批量应用多个提交", "Cherry-pick multiple commits", "commit"],
  ["revert-batch", "批量创建反向提交", "Revert multiple commits", "commit"],
  ["reset", "重置当前分支到此处", "Reset current branch here", "commit", true],
  ["reset-reload", "重置当前分支到此处并重载 Obsidian", "Reset current branch here and reload Obsidian", "commit", true],
  ["merge", "合并到当前分支", "Merge into current branch", "commit"], ["rebase", "将当前分支变基到此处", "Rebase current branch onto revision", "commit"],
  ["branch-new", "创建分支", "Create branch", "branch"], ["branch-switch", "切换分支", "Switch branch", "branch"],
  ["branch-rename", "重命名分支", "Rename branch", "branch"], ["branch-delete", "删除分支", "Delete branch", "branch", true],
  ["branch-upstream", "设置上游分支", "Set upstream branch", "branch"], ["publish", "发布当前分支", "Publish current branch", "branch"],
  ["tag-new", "创建标签", "Create tag", "tag"], ["tag-checkout", "检出标签", "Checkout tag", "tag"],
  ["tag-delete", "删除本地标签", "Delete local tag", "tag", true], ["tag-push", "推送标签", "Push tag", "tag"], ["tag-delete-remote", "删除远程标签", "Delete remote tag", "tag", true],
  ["fetch", "抓取", "Fetch", "remote"], ["fetch-all", "获取", "Fetch all remotes", "remote"],
  ["prune", "清理失效远程跟踪引用", "Prune stale remote-tracking refs", "remote", true],
  ["pull", "拉取", "Pull", "remote"], ["push", "推送", "Push", "remote"], ["sync", "同步（拉取后推送）", "Sync (pull then push)", "remote"],
  ["force-push", "带 lease 强制推送", "Force push with lease", "remote", true],
  ["remote-add", "添加远程", "Add remote", "remote"], ["remote-edit", "修改远程地址", "Edit remote URL", "remote"],
  ["remote-rename", "重命名远程", "Rename remote", "remote"], ["remote-remove", "删除远程配置", "Remove remote", "remote", true],
  ["remote-delete-branch", "删除远程分支", "Delete remote branch", "branch", true],
  ["stash-new", "暂存工作进度", "Stash changes", "stash"], ["stash-view", "查看 stash", "View stash", "stash"],
  ["stash-apply", "应用 stash", "Apply stash", "stash"], ["stash-pop", "弹出 stash", "Pop stash", "stash"],
  ["stash-drop", "删除 stash", "Drop stash", "stash", true], ["stash-branch", "从 stash 创建分支", "Create branch from stash", "stash"],
  ["conflicts", "解决冲突", "Resolve conflicts", "operation"], ["resolved", "标记文件已解决", "Mark file resolved", "file"],
  ["continue", "继续 Git 操作", "Continue Git operation", "operation"], ["abort", "中止 Git 操作", "Abort Git operation", "operation", true],
  ["skip", "跳过当前提交", "Skip current commit", "operation", true],
];
export const GIT_ACTIONS: readonly GitAction[] = definitions.map(([id, zh, en, group, destructive]) => ({ id, zh, en, group, destructive }));
export interface GitChoice { value: string; label: string; description?: string }
export interface GitActionContext { target?: GitTarget; message?: string }
export interface GitActionHost {
  english: boolean;
  prompt(title: string, initial?: string, multiline?: boolean): Promise<string | null>;
  choose(title: string, items: GitChoice[]): Promise<string | null>;
  confirm(title: string, detail: string): Promise<boolean>;
  flush(paths?: string[]): Promise<void>;
  open(): Promise<void>;
  file(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  copy(text: string): Promise<void>;
  editIgnore(add?: string[]): Promise<void>;
  trash(path: string): Promise<void>;
  history(commits?: GitCommit[], file?: string): Promise<void>;
  changes(from: string, to: string): Promise<void>;
  diff(spec: GitDiffSpec): Promise<void>;
  conflict(path: string): Promise<void>;
  show(title: string, body: string): Promise<void>;
  /** Reload the whole Obsidian app (used by actions whose effects span open views). */
  reloadApp(): Promise<void>;
}
class Cancelled extends Error {}
/** A completed mutating action; read-only/navigation actions resolve to void so callers never toast them. */
export type GitActionResult = { mutated: true; detail?: string };
/** Actions whose success notice should carry the resulting HEAD. */
const HEAD_DETAIL = new Set(["commit", "commit-all", "commit-push", "commit-sync", "commit-all-push", "amend", "undo-commit",
  "merge", "rebase", "cherry-pick", "revert", "cherry-pick-batch", "revert-batch", "continue", "abort", "skip", "reset"]);
/** Both entry surfaces call this exact executor, including prompts and confirmations. */
export class GitActions {
  constructor(readonly repository: GitRepository) {}
  async execute(id: string, host: GitActionHost, context: GitActionContext = {}): Promise<GitActionResult | void> {
    try { return await this.perform(id, host, context); } catch (error) { if (!(error instanceof Cancelled)) throw error; }
  }
  private async perform(id: string, h: GitActionHost, context: GitActionContext): Promise<GitActionResult | void> {
    const repo = this.repository, definition = GIT_ACTIONS.find(action => action.id === id);
    if (!definition) throw new Error(`Unknown Git action: ${id}`);
    const label = h.english ? definition.en : definition.zh;
    const prompt = async (title: string, initial = "", multiline = false) => { const value = await h.prompt(title, initial, multiline); if (value === null) throw new Cancelled(); return value; };
    const choose = async (title: string, choices: GitChoice[]) => { if (!choices.length) throw new Error("No matching Git objects"); const value = await h.choose(title, choices); if (value === null) throw new Cancelled(); return value; };
    if (id === "open") return h.open();
    if (id === "cancel") { repo.cancel(); return { mutated: true }; }
    if (id === "output") return h.show(label, repo.output.join("\n"));
    const state = await repo.refresh();
    if (id === "refresh") return;
    if (id === "init") {
      if (state) throw new Error(`Already a Git repository: ${state.root}`);
      const branch = await prompt(h.english ? "Initial branch (empty: Git default)" : "初始分支（留空遵循 Git 配置）");
      if (await h.confirm(label, repo.vaultRoot)) { await repo.initialize(branch); return { mutated: true }; }
      return;
    }
    if (!state) throw new Error(h.english ? "Initialize this vault first" : "请先初始化当前 Vault");
    const write = async (task: () => Promise<unknown>, files?: string[], altersWorktree = false): Promise<GitActionResult | undefined> => {
      if (definition.destructive && !await h.confirm(label, `${state.root}\n${files?.join("\n") ?? targetText(context.target)}`)) return;
      if (altersWorktree) await h.flush(files);
      await repo.mutate(label, task, state.head);
      const detail = HEAD_DETAIL.has(id) ? repo.snapshot?.head.slice(0, 7) : undefined;
      return detail ? { mutated: true, detail } : { mutated: true };
    };
    const selectFiles = async (staged = false): Promise<string[]> => {
      if (context.target?.kind === "file") return context.target.paths;
      const files = state.files.filter(f => staged ? ![".", "?"].includes(f.index) : true);
      return [await choose(label, files.map(f => ({ value: f.path, label: f.path, description: `${f.index}${f.worktree}` })))];
    };
    const remote = async () => context.target?.kind === "remote" ? context.target.name
      : choose(label, state.remotes.map(value => ({ value, label: value })));
    const selectRef = async (kind?: "branch" | "remote" | "tag") => {
      if (context.target && ["branch", "tag"].includes(context.target.kind)) return (context.target as { name: string }).name;
      return choose(label, state.refs.filter(ref => !kind || ref.kind === kind).map(ref => ({ value: ref.name, label: ref.name.replace(/^refs\/(heads|tags|remotes)\//, ""), description: ref.oid.slice(0, 8) })));
    };
    const commit = async (): Promise<string> => {
      if (context.target?.kind === "commit") return repo.resolveCommit(context.target.oid);
      if (context.target?.kind === "branch" || context.target?.kind === "tag") return repo.resolveCommit(context.target.name);
      const entries = await repo.history(0, "--all");
      const value = await prompt(h.english ? "Commit / branch / tag" : "提交 SHA／分支／标签", entries[0]?.oid ?? state.head);
      return repo.resolveCommit(value);
    };
    if (id === "history") return h.history();
    if (id === "reflog") return h.history(await repo.reflog());
    if (id === "ignore-edit") return h.editIgnore();
    if (id === "identity") {
      const name = await prompt("user.name", (await repo.text(["config", "--get", "user.name"], undefined, [0, 1])).trim());
      const email = await prompt("user.email", (await repo.text(["config", "--get", "user.email"], undefined, [0, 1])).trim());
      return write(async () => { await repo.bytes(["config", "--local", "user.name", name]); await repo.bytes(["config", "--local", "user.email", email]); });
    }
    if (definition.group === "file") {
      const files = await selectFiles(id === "unstage");
      for (const file of files) repo.absolute(file);
      if (id === "file-open") { for (const file of files) await h.file(file); return; }
      if (id === "file-reveal") return h.reveal(files[0]);
      if (id === "file-copy") return h.copy(files.map(file => repo.absolute(file)).join("\n"));
      if (id === "file-history") return h.history(undefined, files[0]);
      if (id === "ignore") return h.editIgnore(files);
      if (id === "blame") return h.show(label, await repo.text(["blame", "--date=short", "--", files[0]]));
      if (id === "diff") {
        for (const file of files) {
          const status = state.files.find(f => f.path === file);
          await h.diff({ path: file, original: status?.original, kind: context.target?.kind === "file" && context.target.staged ? "staged" : "working" });
        }
        return;
      }
      if (id === "stage" || id === "resolved") return write(() => repo.stage(files), files, true);
      if (id === "unstage") return write(() => repo.unstage(files));
      if (id === "restore-file") { const oid = await commit(); return write(() => repo.bytes(["restore", `--source=${oid}`, "--worktree", "--", ...files]), files, true); }
      if (id === "discard") return write(() => this.discard(state, files, h), files, true);
    }
    if (id === "stage-all") return write(() => repo.bytes(["add", "-A", "--", "."]), undefined, true);
    if (id === "unstage-all") {
      const files = state.files.filter(f => ![".", "?"].includes(f.index)).map(f => f.path);
      if (files.length) await write(() => repo.unstage(files)); return;
    }
    if (id === "discard-all") return write(() => this.discard(state, state.files.map(f => f.path), h), undefined, true);
    if (["commit", "commit-staged", "commit-all", "commit-push", "commit-sync", "commit-all-push", "amend"].includes(id)) {
      if (state.files.some(f => f.conflict)) throw new Error("Resolve conflicts first");
      let all = id === "commit-all" || id === "commit-all-push";
      const staged = state.files.some(f => ![".", "?"].includes(f.index));
      if (!staged && id !== "amend" && !all) {
        if (id === "commit-staged" || !state.files.length) throw new Error("Nothing staged");
        if (!await h.confirm(h.english ? "Stage all changes?" : "是否暂存全部改动？", state.files.map(f => f.path).join("\n"))) return;
        all = true;
      }
      const previous = id === "amend" ? await repo.text(["log", "-1", "--format=%B"]) : "";
      const message = context.message?.trim() || await prompt(h.english ? "Commit message" : "提交消息", previous, true);
      if (!message.trim()) throw new Error("Commit message is required");
      return write(async () => {
        if (all) await repo.bytes(["add", "-A", "--", "."]);
        await repo.bytes(["commit", ...(id === "amend" ? ["--amend"] : []), "-F", "-"], message);
        if (id === "commit-sync") await repo.pull();
        if (id === "commit-push" || id === "commit-sync" || id === "commit-all-push") {
          try { await repo.bytes(["push"]); } catch (error) { throw new Error(`Commit succeeded; push failed. Retry push, not commit.\n${String(error)}`); }
        }
      }, undefined, all);
    }
    if (id === "undo-commit") {
      const parent = await repo.resolveCommit("HEAD^"); return write(() => repo.bytes(["reset", "--soft", parent]));
    }
    if (id === "cherry-pick-batch" || id === "revert-batch") {
      const verb = id === "cherry-pick-batch" ? "cherry-pick" : "revert";
      let oids: string[];
      if (context.target?.kind === "commit" && context.target.oids?.length) oids = context.target.oids;
      else {
        const input = await prompt(h.english ? "Commits: a range a..b or space-separated SHAs (executed oldest first)" : "提交：范围 a..b 或空格分隔的 SHA（按旧→新顺序执行）");
        if (/^\S+\.\.\S+$/.test(input.trim())) oids = (await repo.text(["rev-list", "--reverse", input.trim()])).trim().split("\n").filter(Boolean);
        else oids = input.trim().split(/\s+/).filter(Boolean);
      }
      if (!oids.length) throw new Error(h.english ? "No commits selected" : "没有选中的提交");
      const resolved: string[] = [];
      for (const input of oids) resolved.push(await repo.resolveCommit(input));
      oids = await repo.sortOldestFirst(resolved);
      const steps: string[][] = [], preview: string[] = [];
      for (const oid of oids) {
        const parents = (await repo.text(["rev-list", "--parents", "-n", "1", oid])).trim().split(" ").slice(1);
        const mainline = parents.length > 1 ? ["-m", await choose(h.english ? `Mainline parent for merge ${oid.slice(0, 7)}` : `合并提交 ${oid.slice(0, 7)} 的主线父提交`, parents.map((value, i) => ({ value: String(i + 1), label: `${i + 1}: ${value}` })))] : [];
        steps.push([verb, "--no-edit", ...mainline, oid]);
        preview.push(`${oid.slice(0, 7)} ${(await repo.text(["log", "-1", "--format=%s", oid])).trim()}`);
      }
      if (!await h.confirm(label, `${state.root}\n${h.english ? "Execution order (oldest first):" : "执行顺序（旧→新）："}\n${preview.join("\n")}`)) return;
      return write(async () => {
        for (const [index, args] of steps.entries()) {
          try { await repo.bytes(args); }
          catch (error) {
            throw new Error(`${verb} ${h.english ? "stopped at" : "中止于"} ${index + 1}/${steps.length}: ${preview[index]}\n${h.english ? "Completed" : "已完成"}: ${index}，${h.english ? "remaining" : "剩余"}:\n${preview.slice(index + 1).join("\n")}\n${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }, undefined, true);
    }
    if (definition.group === "commit" || ["branch-new", "tag-new"].includes(id)) {
      const oid = ["branch-new", "tag-new"].includes(id) ? state.head : await commit();
      if (!oid) throw new Error("No commits yet");
      if (id === "copy-sha") return h.copy(oid);
      if (id === "copy-message") return h.copy(await repo.text(["log", "-1", "--format=%B", oid]));
      if (id === "commit-details") return h.show(label, await repo.text(["show", "--no-patch", "--format=fuller", oid]));
      const parents = (await repo.text(["rev-list", "--parents", "-n", "1", oid])).trim().split(" ").slice(1);
      if (id === "commit-diff") {
        const from = parents.length > 1 ? await choose("Parent", parents.map(value => ({ value, label: value }))) : parents[0] ?? "";
        return h.changes(from, oid);
      }
      if (id.startsWith("compare")) {
        let other = id === "compare-head" ? state.head : id === "compare-upstream" ? await repo.resolveCommit("@{upstream}") : await repo.resolveCommit(await prompt("Compare with", "HEAD"));
        if (id === "compare-base") other = (await repo.text(["merge-base", oid, other])).trim();
        return h.changes(other, oid);
      }
      if (id === "checkout-detached") return write(() => repo.bytes(["switch", "--detach", oid]), undefined, true);
      if (id === "branch-from" || id === "branch-new") {
        const name = await prompt("Branch name"); await repo.checkName(name); return write(() => repo.bytes(["branch", name, oid]));
      }
      if (id === "tag-from" || id === "tag-new") {
        const name = await prompt("Tag name"); await repo.checkName(name);
        const message = await prompt(h.english ? "Annotation (empty: lightweight tag)" : "附注（留空创建轻量标签）", "", true);
        return write(() => repo.bytes(["tag", ...(message ? ["-a", "-m", message] : []), name, oid]));
      }
      if (id === "reset") {
        const mode = await choose(label, ["soft", "mixed", "hard"].map(value => ({ value, label: value, description: value === "soft" ? "Keep index and files" : value === "mixed" ? "Reset index, keep files" : "Overwrite index and files" })));
        if (!await h.confirm(`${label}: ${mode}`, `${state.root}\nHEAD → ${oid}`)) return;
        await h.flush(); await repo.mutate(label, () => repo.bytes(["reset", `--${mode}`, oid]), state.head); return;
      }
      if (id === "reset-reload") {
        // Identical flow to "reset"; the reload happens only after the reset
        // fully succeeded, so a cancel/failure never reloads the app.
        const mode = await choose(label, ["soft", "mixed", "hard"].map(value => ({ value, label: value, description: value === "soft" ? "Keep index and files" : value === "mixed" ? "Reset index, keep files" : "Overwrite index and files" })));
        if (!await h.confirm(`${label}: ${mode}`, `${state.root}\nHEAD → ${oid}`)) return;
        await h.flush(); await repo.mutate(label, () => repo.bytes(["reset", `--${mode}`, oid]), state.head);
        await h.reloadApp(); return;
      }
      if (id === "merge" || id === "rebase") return write(() => repo.bytes(id === "merge" ? ["merge", "--no-edit", oid] : ["rebase", oid]), undefined, true);
      if (id === "cherry-pick" || id === "revert") {
        const mainline = parents.length > 1 ? ["-m", await choose("Mainline parent", parents.map((value, i) => ({ value: String(i + 1), label: `${i + 1}: ${value}` })))] : [];
        return write(() => repo.bytes([id, "--no-edit", ...mainline, oid]), undefined, true);
      }
    }
    if (definition.group === "branch") {
      if (id === "publish") { const r = await remote(); return write(() => repo.bytes(["push", "--set-upstream", r, "HEAD"])); }
      if (id === "branch-upstream") {
        const ref = await selectRef("remote"); return write(() => repo.bytes(["branch", `--set-upstream-to=${ref}`]));
      }
      const ref = await selectRef(id === "remote-delete-branch" ? "remote" : undefined);
      const name = ref.replace(/^refs\/heads\//, "");
      if (id === "branch-switch") {
        const args = ref.startsWith("refs/remotes/") ? ["switch", "--track", ref.replace(/^refs\/remotes\//, "")] : ["switch", name];
        return write(() => repo.bytes(args), undefined, true);
      }
      if (id === "branch-rename") { const next = await prompt("New branch name"); await repo.checkName(next); return write(() => repo.bytes(["branch", "-m", name, next])); }
      if (id === "branch-delete") {
        const force = await choose(label, [{ value: "-d", label: "Delete only if merged" }, { value: "-D", label: "Force delete (unmerged commits may become unreachable)" }]);
        return write(() => repo.bytes(["branch", force, name]));
      }
      if (id === "remote-delete-branch") {
        const short = ref.replace(/^refs\/remotes\//, ""), r = state.remotes.find(value => short.startsWith(`${value}/`));
        if (!r) throw new Error("No matching remote");
        return write(() => repo.bytes(["push", r, "--delete", short.slice(r.length + 1)]));
      }
    }
    if (definition.group === "tag") {
      const ref = await selectRef("tag"), name = ref.replace(/^refs\/tags\//, "");
      if (id === "tag-checkout") return write(() => repo.bytes(["switch", "--detach", ref]), undefined, true);
      if (id === "tag-delete") return write(() => repo.bytes(["tag", "-d", name]));
      const r = await remote();
      if (id === "tag-push") return write(() => repo.bytes(["push", r, `refs/tags/${name}`]));
      if (id === "tag-delete-remote") return write(() => repo.bytes(["push", r, `:refs/tags/${name}`]));
    }
    if (definition.group === "remote") {
      if (id === "pull" || id === "push" || id === "sync") return write(async () => {
        if (id !== "push") await repo.pull(); if (id !== "pull") await repo.bytes(["push"]);
      }, undefined, id !== "push");
      if (id === "fetch-all") return write(() => repo.bytes(["fetch", "--all"]));
      if (id === "remote-add") {
        const name = await prompt("Remote name", "origin"); await repo.checkName(name);
        const url = await prompt("Remote URL"); validateRemoteUrl(url);
        return write(() => repo.bytes(["remote", "add", name, url]));
      }
      const r = await remote();
      if (id === "fetch") return write(() => repo.bytes(["fetch", r]));
      if (id === "prune") return write(() => repo.bytes(["remote", "prune", r]));
      if (id === "remote-remove") return write(() => repo.bytes(["remote", "remove", r]));
      if (id === "remote-edit") {
        const url = await prompt("Remote URL", (await repo.text(["remote", "get-url", r])).trim()); validateRemoteUrl(url);
        return write(() => repo.bytes(["remote", "set-url", r, url]));
      }
      if (id === "remote-rename") { const name = await prompt("New remote name"); await repo.checkName(name); return write(() => repo.bytes(["remote", "rename", r, name])); }
      if (id === "force-push") {
        const name = await prompt("Destination branch", state.branch); await repo.checkName(name);
        const expected = await repo.resolveCommit(`refs/remotes/${r}/${name}`);
        return write(() => repo.bytes(["push", `--force-with-lease=refs/heads/${name}:${expected}`, r, `HEAD:refs/heads/${name}`]));
      }
    }
    if (definition.group === "stash") {
      if (id === "stash-new") {
        const mode = await choose(label, [{ value: "", label: "Tracked changes" }, { value: "--include-untracked", label: "Include untracked files" }, { value: "--staged", label: "Staged changes only" }]);
        const message = await prompt("Stash message"); return write(() => repo.stash(["stash", "push", ...(mode ? [mode] : []), ...(message ? ["-m", message] : [])]), undefined, true);
      }
      const oid = context.target?.kind === "stash" ? context.target.oid : await choose(label, state.stashes.map(s => ({ value: s.oid, label: s.message, description: s.name })));
      if (id === "stash-view") return h.changes(await repo.resolveCommit(`${oid}^`), oid);
      const branch = id === "stash-branch" ? await prompt("Branch name") : ""; if (branch) await repo.checkName(branch);
      const sub = ({ "stash-apply": "apply", "stash-pop": "pop", "stash-drop": "drop", "stash-branch": "branch" } as const)[id];
      if (!sub) throw new Error(`Git action has no implementation: ${id}`);
      return write(async () => {
        const stash = repo.snapshot?.stashes.find(s => s.oid === oid); if (!stash) throw new Error("Stash changed; select it again");
        await repo.stash(["stash", sub, ...(branch ? [branch] : []), stash.name]);
      }, undefined, id !== "stash-drop");
    }
    if (id === "conflicts") {
      const file = await choose(label, state.files.filter(f => f.conflict).map(f => ({ value: f.path, label: f.path })));
      return h.conflict(file);
    }
    if (["continue", "abort", "skip"].includes(id)) {
      if (!state.operation || (id === "skip" && state.operation === "merge")) throw new Error("No matching operation in progress");
      return write(() => repo.bytes(["-c", "core.editor=true", state.operation!, `--${id}`]), undefined, true);
    }
    throw new Error(`Git action has no implementation: ${id}`);
  }
  private async discard(state: GitSnapshot, files: string[], host: GitActionHost): Promise<void> {
    const tracked: string[] = [];
    for (const file of files) {
      if (state.files.find(f => f.path === file)?.untracked) await host.trash(file);
      else tracked.push(file);
    }
    if (tracked.length) await this.repository.bytes(["restore", "--worktree", "--", ...tracked]);
  }
}
export function targetText(target?: GitTarget): string {
  return !target ? "" : target.kind === "file" ? target.paths.join("\n") : target.kind === "commit" ? target.oid : target.name;
}
function validateRemoteUrl(value: string): void {
  if (!value.trim() || value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error("Invalid remote URL");
  if (/^https?:\/\//i.test(value)) { const url = new URL(value); if (url.username || url.password) throw new Error("Use a Git credential helper, not credentials in the remote URL"); }
}
