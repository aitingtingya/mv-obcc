// Diff-as-permission-hook for DSH file-write tools (rc.6).
//
// Intercepts the `tools/execute` waterfall for `write`, `edit`, and
// `str_replace_editor` write commands at the exact moment dsh would demand
// permission for the write:
//   - an escalation retry (`sandbox_permissions` + `justification`), or
//   - a write the standing sandbox policy would deny outright
//     (`read-only`, or `workspace-write` with a target outside the writable
//     roots — the case `str_replace_editor` hits, since that tool has no
//     escalation seam of its own).
//
// Instead of the default web approval card, the change is reviewed as an
// Obsidian diff through the mv-AIDE bridge (`openDiff`). Accepting writes the
// (possibly hand-edited) contents to disk from this plugin — that write IS
// the permission grant. Rejecting returns a synthesized failure. Every other
// case falls through to the original tool body untouched.
//
// Trigger gating (see `shouldReviewDiff`): the target must be inside the
// Obsidian vault, or the user must have enabled the mv-agent setting
// "使用 Obsidian 审阅仓库外 diff" (carried to this plugin through the bridge
// `initialize` result and `mv_aide_settings_changed` notifications).

import { promises as fs } from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIFF_TIMEOUT_MS = 5 * 60 * 1000;

/** File-writing tools covered by the hook. */
export const WRITE_TOOL_NAMES = ['write', 'edit', 'str_replace_editor'];

/** `str_replace_editor` commands that write; `view` stays untouched. */
export const STR_REPLACE_WRITE_COMMANDS = ['create', 'str_replace', 'insert'];

// ── Pure path helpers (exported for tests) ──────────────────────────────

/** Case-insensitive on win32, `..` collapsed. */
export function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Resolve symlinks like dsh's writable-root derivation; fall back verbatim. */
export function canonicalPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

/** True when `absPath` is one of `roots` or a descendant of one. */
export function isInsideAny(absPath, roots) {
  if (typeof absPath !== 'string' || absPath.length === 0) return false;
  const normalized = normalizePath(path.resolve(absPath));
  for (const root of roots ?? []) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const normalizedRoot = normalizePath(path.resolve(root));
    if (normalized === normalizedRoot) return true;
    if (normalized.startsWith(`${normalizedRoot}${path.sep}`)) return true;
  }
  return false;
}

/**
 * The writable roots of a `workspace-write` policy, mirroring dsh's own
 * derivation (workspace root + platform temp areas), canonicalized.
 */
export function writableRoots(policy) {
  if (!policy || policy.mode !== 'workspace-write') return [];
  return [...new Set([
    typeof policy.workspaceRoot === 'string' ? policy.workspaceRoot : undefined,
    '/tmp',
    os.tmpdir(),
  ].filter((root) => typeof root === 'string' && root.length > 0).map(canonicalPath))];
}

/** True when a write to `targetPath` would be denied under `policy`. */
export function wouldBeDenied(policy, targetPath) {
  if (!policy) return false;
  if (policy.mode === 'danger-full-access') return false;
  if (policy.mode === 'read-only') return true;
  if (policy.mode === 'workspace-write') {
    return !isInsideAny(targetPath, writableRoots(policy));
  }
  return false;
}

/** The escalation-retry marker: both fields must travel together. */
export function isEscalationRetry(args) {
  return (
    typeof args?.sandbox_permissions === 'string' &&
    typeof args?.justification === 'string'
  );
}

/**
 * Resolve the write target the same way the tools do: relative paths hang
 * off the policy workspace root (≈ session cwd), absolute paths as-is.
 */
export function resolveTargetPath(rawPath, policy, exec) {
  const base =
    typeof policy?.workspaceRoot === 'string' && policy.workspaceRoot.length > 0
      ? policy.workspaceRoot
      : typeof exec?.agent?.session?.header?.cwd === 'string'
        ? exec.agent.session.header.cwd
        : process.cwd();
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(base, rawPath);
}

// ── New-content computation (mirrors the real tools' write semantics) ───

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function replaceFirst(haystack, needle, replacement) {
  const index = haystack.indexOf(needle);
  return index < 0
    ? haystack
    : `${haystack.slice(0, index)}${replacement}${haystack.slice(index + needle.length)}`;
}

function computeWrite(args) {
  if (typeof args.content !== 'string') return { ok: false };
  return { ok: true, operation: 'create', before: null, after: args.content };
}

function computeEdit(args, current) {
  if (current === null) return { ok: false };
  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  if (oldString.length === 0 || oldString === newString) return { ok: false };
  const occurrences = countOccurrences(current, oldString);
  if (occurrences === 0) return { ok: false };
  if (occurrences > 1 && args.replace_all !== true) return { ok: false };
  const after =
    args.replace_all === true
      ? current.split(oldString).join(newString)
      : replaceFirst(current, oldString, newString);
  return { ok: true, operation: 'update', before: current, after };
}

function computeEditor(args, current) {
  switch (args.command) {
    case 'create': {
      if (current !== null) return { ok: false }; // real tool errors "already exists"
      if (typeof args.file_text !== 'string') return { ok: false };
      return { ok: true, operation: 'create', before: null, after: args.file_text };
    }
    case 'str_replace': {
      if (current === null) return { ok: false };
      const oldStr = args.old_str;
      if (typeof oldStr !== 'string' || oldStr.length === 0) return { ok: false };
      const newStr = typeof args.new_str === 'string' ? args.new_str : '';
      const occurrences = countOccurrences(current, oldStr);
      if (occurrences === 0 || occurrences > 1) return { ok: false };
      return { ok: true, operation: 'update', before: current, after: replaceFirst(current, oldStr, newStr) };
    }
    case 'insert': {
      if (current === null) return { ok: false };
      if (!Number.isInteger(args.insert_line)) return { ok: false };
      if (typeof args.new_str !== 'string') return { ok: false };
      const lines = current.split('\n');
      if (args.insert_line < 0 || args.insert_line > lines.length) return { ok: false };
      const after = [
        ...lines.slice(0, args.insert_line),
        ...args.new_str.split('\n'),
        ...lines.slice(args.insert_line),
      ].join('\n');
      return { ok: true, operation: 'update', before: current, after };
    }
    default:
      return { ok: false };
  }
}

/**
 * Compute `{ ok, operation, before, after }` for a write command, or
 * `{ ok: false }` when the real tool would reject the call with its own
 * (better) error — the hook then falls through instead of reviewing.
 * @param currentContents - current file text, or null when the file does not exist.
 */
export function computeNewContents(toolName, args, currentContents) {
  switch (toolName) {
    case 'write': {
      const result = computeWrite(args);
      if (!result.ok || currentContents === null) return result;
      return { ...result, operation: 'update', before: currentContents };
    }
    case 'edit':
      return computeEdit(args, currentContents);
    case 'str_replace_editor':
      return computeEditor(args, currentContents);
    default:
      return { ok: false };
  }
}

// ── Trigger decision ────────────────────────────────────────────────────

/**
 * Decide whether a tool call must be reviewed as an Obsidian diff.
 * @param toolName - executing tool.
 * @param args - frozen tool arguments.
 * @param policy - resolved standing sandbox policy `{ mode, workspaceRoot }`.
 * @param targetPath - absolute write target.
 * @param workspaceFolders - the bridge's vault roots.
 * @param reviewOutsideVault - the mv-agent setting (false = out-of-vault
 *   writes keep dsh's default confirmation flow).
 * @param bridgeConnected - whether the mv-AIDE bridge is live.
 */
export function shouldReviewDiff({
  toolName,
  args,
  policy,
  targetPath,
  workspaceFolders,
  reviewOutsideVault,
  bridgeConnected,
}) {
  if (!bridgeConnected) return false;
  if (!policy || policy.mode === 'danger-full-access') return false;
  const isWriteTool = WRITE_TOOL_NAMES.includes(toolName);
  if (!isWriteTool) return false;
  if (toolName === 'str_replace_editor') {
    if (!STR_REPLACE_WRITE_COMMANDS.includes(args?.command)) return false;
    if (!wouldBeDenied(policy, targetPath)) return false;
  } else if (!isEscalationRetry(args) && !wouldBeDenied(policy, targetPath)) {
    return false;
  }
  const inVault = isInsideAny(targetPath, workspaceFolders ?? []);
  if (!inVault && reviewOutsideVault !== true) return false;
  return true;
}

// ── Result synthesis ────────────────────────────────────────────────────

function rejectionResult(targetPath) {
  const message =
    `the user rejected the Obsidian diff review for "${targetPath}"; nothing was written`;
  return {
    isError: true,
    error: { message },
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

/**
 * Build the `value` the owning tool's output declaration expects:
 * `write`/`edit` want `{path, before, after[, operation]}`; the
 * `str_replace_editor` wants a plain string. The registry re-renders it
 * through the tool's own output contract (`normalizeDispatchResult`).
 */
export function synthesizeValue(toolName, targetPath, computed, approved) {
  if (toolName === 'write') {
    return {
      path: targetPath,
      operation: computed.operation,
      before: computed.before,
      after: approved,
    };
  }
  if (toolName === 'edit') {
    return { path: targetPath, before: computed.before, after: approved };
  }
  return computed.operation === 'create'
    ? `New file created successfully at: ${targetPath}`
    : `The file ${targetPath} has been edited successfully.`;
}

// ── Plumbing ────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`diff review timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function writeApprovedFile(targetPath, contents) {
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  } catch {
    /* the target directory already exists — nothing to ensure */
  }
  await fs.writeFile(targetPath, contents, 'utf8');
}

/**
 * Create the `tools/execute` interceptor.
 * @param {object} opts
 * @param {object} ctx - the plugin context (reads `fs`, `sandboxPolicy` lazily).
 * @param {object|((exec:any)=>object|null)} [opts.supervisor] - a bridge
 *   supervisor, or a resolver returning the supervisor for the executing
 *   agent's session. `resolveSupervisor` takes precedence when both are given.
 * @param {function} log - warning sink.
 * @returns the async waterfall handler `(exec, next) => Promise<result>`.
 */
export function createDiffHook({ ctx, supervisor, resolveSupervisor, log }) {
  return async function diffHook(exec, next) {
    const toolName = exec?.name;
    if (!WRITE_TOOL_NAMES.includes(toolName)) return next();
    const args =
      exec?.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
    if (
      toolName === 'str_replace_editor' &&
      !STR_REPLACE_WRITE_COMMANDS.includes(args.command)
    ) {
      return next();
    }
    // Without a confining filesystem there is no permission wall to replace.
    if (ctx.get('fs')?.sandboxMode === undefined) return next();

    const currentSupervisor =
      typeof resolveSupervisor === 'function'
        ? await resolveSupervisor(exec)
        : supervisor ?? null;
    if (!currentSupervisor) return next();

    let policy;
    try {
      const service = ctx.get('sandboxPolicy');
      policy =
        service && typeof service.resolve === 'function'
          ? service.resolve({ session: exec.agent?.session })
          : undefined;
    } catch {
      policy = undefined;
    }
    if (!policy || policy.mode === 'danger-full-access') return next();

    const rawPath =
      toolName === 'str_replace_editor' ? args.path : args.file_path;
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) return next();
    const targetPath = resolveTargetPath(rawPath, policy, exec);

    const review = shouldReviewDiff({
      toolName,
      args,
      policy,
      targetPath,
      workspaceFolders: currentSupervisor.workspaceFolders,
      reviewOutsideVault: currentSupervisor.reviewOutsideVault,
      bridgeConnected: currentSupervisor.isConnected(),
    });
    if (!review) {
      // A permission moment existed but the review was skipped: say WHY, so
      // a missed diff can be diagnosed from the dsh console instead of
      // silently degrading to the default approval card.
      const escalation = isEscalationRetry(args);
      if (escalation || wouldBeDenied(policy, targetPath)) {
        const reason = !currentSupervisor.isConnected()
          ? 'bridge not connected'
          : !isInsideAny(targetPath, currentSupervisor.workspaceFolders ?? []) &&
              currentSupervisor.reviewOutsideVault !== true
            ? 'outside vault with "reviewOutsideVault" disabled'
            : 'unknown (adapter rejected the call)';
        log(
          `mv-aide diff hook: skipped review for ${toolName} ${targetPath} — ${reason}`,
        );
      }
      return next();
    }

    let current = null;
    try {
      current = await fs.readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        log(`mv-aide diff hook: cannot read ${targetPath} — ${error?.message ?? String(error)}`);
        return next();
      }
    }
    const computed = computeNewContents(toolName, args, current);
    if (!computed.ok) return next();

    try {
      const result = await withTimeout(
        currentSupervisor.callTool(
          'openDiff',
          {
            old_file_path: targetPath,
            new_file_path: targetPath,
            new_file_contents: computed.after,
            tab_name: `${toolName} ${targetPath}`,
          },
          exec.signal,
        ),
        DIFF_TIMEOUT_MS,
      );
      const content = Array.isArray(result?.content) ? result.content : [];
      const first =
        content[0]?.type === 'text' ? String(content[0].text ?? '') : '';
      if (first.startsWith('FILE_SAVED')) {
        const approved =
          content[1]?.type === 'text' && typeof content[1].text === 'string'
            ? content[1].text
            : computed.after;
        await writeApprovedFile(targetPath, approved);
        return { value: synthesizeValue(toolName, targetPath, computed, approved) };
      }
      if (first.startsWith('DIFF_REJECTED')) {
        return rejectionResult(targetPath);
      }
      log(`mv-aide diff hook: unexpected openDiff outcome "${first.slice(0, 60)}"; falling back`);
      return next();
    } catch (error) {
      log(
        `mv-aide diff hook: review failed (${error instanceof Error ? error.message : String(error)}); falling back to the default confirmation`,
      );
      return next();
    }
  };
}
