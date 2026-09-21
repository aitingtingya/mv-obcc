export type GitPosition = "left" | "right" | "tab" | "split";
export type GitDiffPlacement = "main" | "split" | "right" | "left";
export interface GitSettings {
  enabled: boolean;
  executable: string;
  position: GitPosition;
  diffPlacement: GitDiffPlacement;
  layout: "auto" | "split" | "inline";
  tree: boolean;
  autoRefresh: boolean;
  statusBar: boolean;
  editMarkers: boolean;
  lineBlame: boolean;
  notices: boolean;
  pull: "config" | "ff-only" | "merge" | "rebase";
  messageTemplate: string;
}
export const DEFAULT_GIT_SETTINGS: GitSettings = {
  enabled: true, executable: "", position: "left", diffPlacement: "main", layout: "auto", tree: true,
  autoRefresh: true, statusBar: true, editMarkers: false, lineBlame: false, notices: true,
  pull: "config", messageTemplate: "",
};
export function normalizeGitSettings(value?: Partial<GitSettings>): GitSettings {
  const v = value ?? {};
  return {
    enabled: v.enabled !== false,
    executable: typeof v.executable === "string" ? v.executable : "",
    position: ["left", "right", "tab", "split"].includes(v.position ?? "") ? v.position! : "left",
    diffPlacement: ["main", "split", "right", "left"].includes(v.diffPlacement ?? "") ? v.diffPlacement! : "main",
    layout: ["auto", "split", "inline"].includes(v.layout ?? "") ? v.layout! : "auto",
    tree: v.tree !== false, autoRefresh: v.autoRefresh !== false,
    statusBar: v.statusBar !== false,
    editMarkers: v.editMarkers === true, lineBlame: v.lineBlame === true,
    notices: v.notices !== false,
    pull: ["config", "ff-only", "merge", "rebase"].includes(v.pull ?? "") ? v.pull! : "config",
    messageTemplate: typeof v.messageTemplate === "string" ? v.messageTemplate : "",
  };
}
export interface GitFile {
  path: string; original?: string; index: string; worktree: string;
  conflict: boolean; untracked: boolean; submodule: boolean;
}
export interface GitRef { name: string; oid: string; kind: "branch" | "remote" | "tag"; upstream: string }
export interface GitCommit { oid: string; parents: string[]; author: string; date: string; message: string; refs: string }
export interface GitStash { name: string; oid: string; message: string }
export type GitInProgress = "merge" | "rebase" | "cherry-pick" | "revert" | null;
export interface GitSnapshot {
  root: string; version: string; head: string; branch: string; upstream: string;
  ahead: number; behind: number; files: GitFile[]; refs: GitRef[];
  remotes: string[]; stashes: GitStash[]; operation: GitInProgress; revision: number;
}
export type GitTarget = { kind: "file"; paths: string[]; staged?: boolean }
  | { kind: "commit"; oid: string; oids?: string[] }
  | { kind: "branch" | "tag" | "remote"; name: string }
  | { kind: "stash"; name: string; oid: string };
export interface GitDiffSpec { path: string; original?: string; kind: "working" | "staged" | "history"; from?: string; to?: string }
export interface GitDiffData {
  spec: GitDiffSpec; before: string; after: string; patch: string; binary: boolean;
  beforeBytes: Uint8Array; afterBytes: Uint8Array; head: string; indexOid: string;
}
