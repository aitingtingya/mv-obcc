import type { App, WorkspaceLeaf } from "obsidian";
import { TERMINAL_VIEW_TYPE } from "../constants";
import { TerminalView } from "../terminal/terminal-view";

export interface TerminalInfo {
  id: string;
  name: string;
  active: boolean;
  recent: boolean;
}

export interface TerminalRunOptions {
  terminalId?: string;
  newTerminal?: boolean;
}

type CreateTerminalLeaf = () => Promise<WorkspaceLeaf | null>;

/**
 * Runtime-only registry for mv-AIDE's own integrated TerminalView leaves.
 *
 * This module deliberately does not know anything about PTY processes, xterm
 * internals, shell wrappers, or system terminals. It only indexes TerminalView
 * instances that already belong to this plugin and forwards the public
 * read/send/focus operations exposed by TerminalView.
 */
export class TerminalRegistry {
  private readonly ids = new WeakMap<WorkspaceLeaf, string>();
  private readonly leaves = new Map<string, WorkspaceLeaf>();
  private nextId = 1;
  private recentTerminalId: string | null = null;

  constructor(
    private readonly app: App,
    private readonly createTerminalLeaf: CreateTerminalLeaf,
  ) {}

  refresh(): void {
    const currentLeaves = this.app.workspace
      .getLeavesOfType(TERMINAL_VIEW_TYPE)
      .filter((leaf): leaf is WorkspaceLeaf => leaf.view instanceof TerminalView);
    const current = new Set(currentLeaves);

    for (const leaf of currentLeaves) this.ensureId(leaf);

    for (const [id, leaf] of this.leaves) {
      if (current.has(leaf)) continue;
      this.leaves.delete(id);
      if (this.recentTerminalId === id) this.recentTerminalId = null;
    }
  }

  markActiveLeaf(leaf: WorkspaceLeaf | null): void {
    if (!leaf || !(leaf.view instanceof TerminalView)) return;
    this.recentTerminalId = this.ensureId(leaf);
  }

  list(): TerminalInfo[] {
    this.refresh();
    const activeView = this.app.workspace.getActiveViewOfType(TerminalView);
    return [...this.leaves.entries()].map(([id, leaf]) => {
      const view = leaf.view as TerminalView;
      return {
        id,
        name: view.getDisplayText(),
        active: view === activeView,
        recent: id === this.recentTerminalId,
      };
    });
  }

  read(
    terminalId?: string,
    lastN = 50,
  ): { terminalId: string; lines: string[] } {
    const target = this.resolveTarget(terminalId);
    const limit = Math.min(500, Math.max(1, Math.floor(lastN)));
    return {
      terminalId: target.id,
      lines: target.view.readTailLines(limit),
    };
  }

  send(
    terminalId: string | undefined,
    input: string,
    submit = false,
  ): { terminalId: string } {
    const target = this.resolveTarget(terminalId);
    target.view.sendInput(submit ? `${input}\r` : input);
    this.recentTerminalId = target.id;
    return { terminalId: target.id };
  }

  async run(
    command: string,
    options: TerminalRunOptions = {},
  ): Promise<{ terminalId: string }> {
    if (!command.trim()) throw new Error("Terminal command must not be empty");
    this.refresh();

    let target: { id: string; leaf: WorkspaceLeaf; view: TerminalView };
    if (options.newTerminal === true) {
      target = await this.createTarget();
    } else if (options.terminalId) {
      target = this.resolveTarget(options.terminalId);
    } else if (this.recentTerminalId) {
      target = this.resolveTarget(this.recentTerminalId);
    } else {
      target = await this.createTarget();
    }

    target.view.sendInput(`${command}\r`);
    this.recentTerminalId = target.id;
    return { terminalId: target.id };
  }

  async focus(terminalId: string): Promise<{ terminalId: string }> {
    const target = this.resolveTarget(terminalId);
    await this.app.workspace.revealLeaf(target.leaf);
    target.view.focusTerminal();
    this.recentTerminalId = target.id;
    return { terminalId: target.id };
  }

  async create(): Promise<{ terminalId: string }> {
    const target = await this.createTarget();
    return { terminalId: target.id };
  }

  dispose(): void {
    this.leaves.clear();
    this.recentTerminalId = null;
  }

  private ensureId(leaf: WorkspaceLeaf): string {
    const existing = this.ids.get(leaf);
    if (existing) {
      this.leaves.set(existing, leaf);
      return existing;
    }
    const id = `terminal-${this.nextId++}`;
    this.ids.set(leaf, id);
    this.leaves.set(id, leaf);
    return id;
  }

  private resolveTarget(
    terminalId?: string,
  ): { id: string; leaf: WorkspaceLeaf; view: TerminalView } {
    this.refresh();
    const id = terminalId ?? this.recentTerminalId;
    if (!id) throw new Error("No active mv-AIDE terminal");
    const leaf = this.leaves.get(id);
    if (!leaf || !(leaf.view instanceof TerminalView)) {
      if (this.recentTerminalId === id) this.recentTerminalId = null;
      throw new Error(`Unknown mv-AIDE terminal: ${id}`);
    }
    return { id, leaf, view: leaf.view };
  }

  private async createTarget(): Promise<{
    id: string;
    leaf: WorkspaceLeaf;
    view: TerminalView;
  }> {
    const leaf = await this.createTerminalLeaf();
    if (!leaf || !(leaf.view instanceof TerminalView)) {
      throw new Error("Failed to create mv-AIDE terminal");
    }
    const id = this.ensureId(leaf);
    this.refresh();
    this.recentTerminalId = id;
    return { id, leaf, view: leaf.view };
  }
}
