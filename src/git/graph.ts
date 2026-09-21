import type { GitCommit } from "./model";
export interface GitGraphRow { commit: GitCommit; column: number; lanes: number; edges: { from: number; to: number }[] }
/** Graph lanes are commit identities, not branch labels. Preserve all parents at merge nodes. */
export function graphRows(commits: readonly GitCommit[]): GitGraphRow[] {
  const lanes: string[] = [], result: GitGraphRow[] = [];
  for (const commit of commits) {
    let column = lanes.indexOf(commit.oid);
    if (column < 0) { column = lanes.length; lanes.push(commit.oid); }
    const before = [...lanes]; lanes.splice(column, 1);
    commit.parents.forEach((parent, i) => { if (!lanes.includes(parent)) lanes.splice(Math.min(column + i, lanes.length), 0, parent); });
    const edges: GitGraphRow["edges"] = [];
    before.forEach((oid, i) => {
      if (oid !== commit.oid) edges.push({ from: i, to: lanes.indexOf(oid) });
      else for (const parent of commit.parents) edges.push({ from: i, to: lanes.indexOf(parent) });
    });
    result.push({ commit, column, lanes: Math.max(before.length, lanes.length), edges });
  }
  return result;
}
