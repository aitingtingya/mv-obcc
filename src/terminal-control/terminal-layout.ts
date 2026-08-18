import type { Workspace, WorkspaceLeaf } from "obsidian";
import { TERMINAL_VIEW_TYPE } from "../constants";
import type { TerminalOpenMode, TerminalOpenPosition } from "../types";
import { createMainBottomLeaf } from "../workspace-context";

interface LayoutItem {
  parent?: LayoutItem | null;
  children?: LayoutItem[];
  direction?: string;
}

type TerminalLayoutWorkspace = Workspace & {
  createLeafBySplit(
    leaf: WorkspaceLeaf,
    direction: "horizontal" | "vertical",
    before: boolean,
  ): WorkspaceLeaf;
};

export interface TerminalLeafResolution {
  leaf: WorkspaceLeaf | null;
  createdBottomSplit: boolean;
}

export function normalizeTerminalOpenPosition(value: unknown): TerminalOpenPosition {
  return value === "tab" || value === "left" || value === "right" || value === "bottom"
    ? value
    : "right";
}

export function normalizeTerminalOpenMode(value: unknown): TerminalOpenMode {
  return value === "new-tab" || value === "split" ? value : "split";
}

export function resolveTerminalLeaf(
  workspace: Workspace,
  options: {
    position: TerminalOpenPosition;
    mode: TerminalOpenMode;
  },
): TerminalLeafResolution {
  if (options.position === "left") {
    return {
      leaf: workspace.getLeftLeaf(options.mode === "split"),
      createdBottomSplit: false,
    };
  }

  if (options.position === "right") {
    return {
      leaf: workspace.getRightLeaf(options.mode === "split"),
      createdBottomSplit: false,
    };
  }

  const layoutWorkspace = workspace as TerminalLayoutWorkspace;

  if (options.position === "tab") {
    if (options.mode === "new-tab") {
      return { leaf: workspace.getLeaf(true), createdBottomSplit: false };
    }
    const anchor = findMainAreaAnchor(layoutWorkspace);
    return {
      leaf: layoutWorkspace.createLeafBySplit(anchor, "vertical", false),
      createdBottomSplit: false,
    };
  }

  const bottomAnchor = findBottomTerminalAnchor(layoutWorkspace);
  if (!bottomAnchor) {
    return {
      leaf: createMainBottomLeaf(layoutWorkspace),
      createdBottomSplit: true,
    };
  }

  if (options.mode === "new-tab") {
    workspace.setActiveLeaf(bottomAnchor, { focus: true });
    return { leaf: workspace.getLeaf("tab"), createdBottomSplit: false };
  }

  return {
    leaf: layoutWorkspace.createLeafBySplit(bottomAnchor, "vertical", false),
    createdBottomSplit: false,
  };
}

function findMainAreaAnchor(workspace: TerminalLayoutWorkspace): WorkspaceLeaf {
  const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
  if (
    recent?.getRoot() === workspace.rootSplit &&
    !isBottomLeaf(recent, workspace.rootSplit)
  ) {
    return recent;
  }

  let fallback: WorkspaceLeaf | null = null;
  workspace.iterateAllLeaves((candidate) => {
    if (
      !fallback &&
      candidate.getRoot() === workspace.rootSplit &&
      !isBottomLeaf(candidate, workspace.rootSplit)
    ) {
      fallback = candidate;
    }
  });
  return fallback ?? workspace.getLeaf("tab");
}

function findBottomTerminalAnchor(
  workspace: TerminalLayoutWorkspace,
): WorkspaceLeaf | null {
  return workspace
    .getLeavesOfType(TERMINAL_VIEW_TYPE)
    .find(
      (candidate) =>
        candidate.getRoot() === workspace.rootSplit &&
        isBottomLeaf(candidate, workspace.rootSplit),
    ) ?? null;
}

function isBottomLeaf(leaf: WorkspaceLeaf, rootSplit: unknown): boolean {
  if (leaf.getRoot() !== rootSplit) return false;

  let branch = (leaf as unknown as { parent?: LayoutItem }).parent;
  let parent = branch?.parent;
  while (branch && parent) {
    if (
      parent.direction === "horizontal" &&
      Array.isArray(parent.children) &&
      parent.children.indexOf(branch) > 0
    ) {
      return true;
    }
    branch = parent;
    parent = parent.parent;
  }
  return false;
}
