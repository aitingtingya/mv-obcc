import type { GitCommit, GitFile } from "./model";

export function parseStatus(raw: string): { files: GitFile[]; branch: string; head: string; upstream: string; ahead: number; behind: number } {
  const state = { files: [] as GitFile[], branch: "", head: "", upstream: "", ahead: 0, behind: 0 };
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith("# branch.head ")) state.branch = row.slice(14);
    else if (row.startsWith("# branch.oid ")) state.head = row.slice(13) === "(initial)" ? "" : row.slice(13);
    else if (row.startsWith("# branch.upstream ")) state.upstream = row.slice(18);
    else if (row.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(row); if (match) { state.ahead = +match[1]; state.behind = +match[2]; }
    } else if (/^[12u] /.test(row)) {
      const fields = row.split(" ");
      const offset = row[0] === "1" ? 8 : row[0] === "2" ? 9 : 10;
      state.files.push({ path: fields.slice(offset).join(" "), original: row[0] === "2" ? records[++i] : undefined,
        index: fields[1][0], worktree: fields[1][1], conflict: row[0] === "u", untracked: false, submodule: fields[2][0] === "S" });
    } else if (row.startsWith("? ")) state.files.push({ path: row.slice(2), index: "?", worktree: "?", conflict: false, untracked: true, submodule: false });
  }
  return state;
}
export function parseLog(raw: string): GitCommit[] {
  const fields = raw.split("\0"), result: GitCommit[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    const oid = fields[i].trim(); if (!oid) continue;
    result.push({ oid, parents: fields[i + 1].split(" ").filter(Boolean), author: fields[i + 2], date: fields[i + 3], message: fields[i + 4], refs: fields[i + 5] });
  }
  return result;
}
export interface PatchLine { text: string; oldLine: number; newLine: number; index: number; change: boolean }
export interface PatchHunk { header: string; lines: PatchLine[]; index: number }
export function patchHunks(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []; let oldLine = 0, newLine = 0, current: PatchHunk | undefined;
  patch.split("\n").forEach((text, index) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (m) { oldLine = +m[1]; newLine = +m[2]; current = { header: text, lines: [], index: hunks.length }; hunks.push(current); }
    else if (current && /^[ +\-\\]/.test(text)) {
      current.lines.push({ text, oldLine, newLine, index, change: /^[+-]/.test(text) });
      if (/^[ -]/.test(text)) oldLine++;
      if (/^[ +]/.test(text)) newLine++;
    }
  });
  return hunks;
}
/** Keep unselected removals as context, omit unselected additions. Git validates the result atomically. */
export function selectPatch(patch: string, selected: ReadonlySet<number>): string {
  const source = patch.split("\n"), start = source.findIndex(line => line.startsWith("@@ "));
  if (start < 0) throw new Error("No text hunks");
  const headers = source.slice(0, start).filter(line => !line.startsWith("index "));
  const result: string[] = []; let delta = 0;
  for (const hunk of patchHunks(patch)) {
    if (!hunk.lines.some(line => line.change && selected.has(line.index))) continue;
    const lines: string[] = []; let oldCount = 0, newCount = 0, included = false;
    for (const line of hunk.lines) {
      const kind = line.text[0];
      if (kind === "\\") { if (included) lines.push(line.text); continue; }
      included = true;
      if (kind === "+" && !selected.has(line.index)) { included = false; continue; }
      const value = kind === "-" && !selected.has(line.index) ? ` ${line.text.slice(1)}` : line.text;
      if (value[0] !== "+") oldCount++;
      if (value[0] !== "-") newCount++;
      lines.push(value);
    }
    const oldStart = Number(/^@@ -(\d+)/.exec(hunk.header)![1]);
    const newStart = oldStart + delta + (oldCount === 0 ? 1 : newCount === 0 ? -1 : 0);
    result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines);
    delta += newCount - oldCount;
  }
  if (!result.length) throw new Error("No changes selected");
  // Partial deletion is a modification, not deletion of the whole file.
  const deletion = headers.findIndex(line => line.startsWith("deleted file mode "));
  if (deletion >= 0) {
    headers.splice(deletion, 1);
    const oldPath = headers.find(line => line.startsWith("--- "))?.slice(4);
    const next = headers.findIndex(line => line === "+++ /dev/null");
    if (oldPath && next >= 0) headers[next] = `+++ ${oldPath.replace(/^a\//, "b/")}`;
  }
  return [...headers, ...result, ""].join("\n");
}
