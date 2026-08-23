import type { App, WorkspaceLeaf } from "obsidian";
import { TERMINAL_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { TerminalView } from "../terminal/terminal-view";
import type { ReadDiagnostics } from "../terminal/terminal-read";
import { safeInteractiveShellCommand } from "../terminal/terminal-command";

export interface TerminalReadResult {
  terminalId: string;
  lines: string[];
  diagnostics?: ReadDiagnostics & { procAlive: boolean };
}

export interface TerminalInfo {
  id: string;
  name: string;
  active: boolean;
  recent: boolean;
  /** true = 叶子尚未加载（Obsidian 重启恢复后的休眠终端），还没有活 shell。 */
  deferred: boolean;
}

export interface TerminalRunOptions {
  terminalId?: string;
  newTerminal?: boolean;
}

type CreateTerminalLeaf = () => Promise<WorkspaceLeaf | null>;

interface RegistryTarget {
  id: string;
  leaf: WorkspaceLeaf;
  /** 尚未加载（休眠）的终端叶子此值为 null。 */
  view: TerminalView | null;
}

interface LoadedTarget {
  id: string;
  leaf: WorkspaceLeaf;
  view: TerminalView;
  wokeDeferred: boolean;
}

/**
 * 已加载的 TerminalView 直接命中；Obsidian ≥1.7.2 会把后台叶子延迟加载，
 * 此时 leaf.view 是 DeferredView 桩，只能靠持久化的 ViewState 认出终端类型。
 * 非休眠的非终端叶不付 getViewState() 的查询成本。
 */
function isTerminalLeaf(leaf: WorkspaceLeaf): boolean {
  if (leaf.view instanceof TerminalView) return true;
  if (!leaf.isDeferred) return false;
  return leaf.getViewState()?.type === TERMINAL_VIEW_TYPE;
}

/**
 * Runtime-only registry for mv-AIDE's own integrated TerminalView leaves.
 *
 * This module deliberately does not know anything about PTY processes, xterm
 * internals, shell wrappers, or system terminals. It only indexes leaves that
 * belong to this plugin — including dormant ones restored from a previous app
 * run (Obsidian defers background leaves, so their view is a DeferredView stub
 * until first shown) — and forwards the public read/send/focus operations
 * exposed by TerminalView, waking dormant leaves on demand.
 */
export class TerminalRegistry {
  private readonly ids = new WeakMap<WorkspaceLeaf, string>();
  private readonly leaves = new Map<string, WorkspaceLeaf>();
  private nextId = 1;
  private recentTerminalId: string | null = null;
  private activeTerminalLeaf: WorkspaceLeaf | null = null;

  constructor(
    private readonly app: App,
    private readonly createTerminalLeaf: CreateTerminalLeaf,
  ) {}

  refresh(): void {
    // iterateAllLeaves 覆盖主区/侧栏/浮动窗口，且不依赖 getLeavesOfType 对
    // DeferredView 桩的枚举行为；休眠的历史终端叶子由此进入索引。
    const currentLeaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (isTerminalLeaf(leaf)) currentLeaves.push(leaf);
    });
    const current = new Set(currentLeaves);

    for (const leaf of currentLeaves) this.ensureId(leaf);

    for (const [id, leaf] of this.leaves) {
      if (current.has(leaf)) continue;
      this.leaves.delete(id);
      if (this.recentTerminalId === id) this.recentTerminalId = null;
      if (this.activeTerminalLeaf === leaf) this.activeTerminalLeaf = null;
    }
  }

  markActiveLeaf(leaf: WorkspaceLeaf | null): void {
    this.activeTerminalLeaf = leaf && isTerminalLeaf(leaf) ? leaf : null;
    if (!this.activeTerminalLeaf) return;
    this.recentTerminalId = this.ensureId(this.activeTerminalLeaf);
  }

  list(): TerminalInfo[] {
    this.refresh();
    return [...this.leaves.entries()].map(([id, leaf]) => {
      const view = leaf.view instanceof TerminalView ? leaf.view : null;
      return {
        id,
        name: view ? view.getDisplayText() : t("系统终端"),
        active: leaf === this.activeTerminalLeaf,
        recent: id === this.recentTerminalId,
        deferred: !view,
      };
    });
  }

  read(
    terminalId?: string,
    lastN?: number,
    waitMs = 0,
  ): Promise<TerminalReadResult> {
    return this.readTail(terminalId, lastN, waitMs);
  }

  private async readTail(
    terminalId?: string,
    lastN?: number,
    waitMs = 0,
  ): Promise<TerminalReadResult> {
    const target = await this.resolveLoadedTarget(terminalId);
    if (target.wokeDeferred) await this.waitForDeferredReadable(target);
    // An empty result usually means the async PTY→xterm parse pipeline has
    // not flushed yet (or a fresh terminal's shell has not printed its first
    // prompt). Opt-in polling lets callers absorb that race while the default
    // (waitMs omitted / 0) stays exactly as fast as before.
    const deadline = Date.now() + clampWaitMs(waitMs);
    let lines = this.collectLines(target.view, lastN);
    while (lines.length === 0 && Date.now() < deadline) {
      await delay(READ_POLL_INTERVAL_MS);
      lines = this.collectLines(target.view, lastN);
    }
    // 远程诊断：调用方（agent）不用再猜"为什么是空的"。旧客户端多收一个
    // 字段不受影响。
    const diagnostics = target.view.describeReadState?.();
    return {
      terminalId: target.id,
      lines,
      ...(diagnostics ? { diagnostics } : {}),
    };
  }

  /**
   * lastN 省略 → 智能模式（已用区域，最多 50 行，空闲终端也能读到提示符）；
   * 显式数字 → 字面模式（末尾 N 个物理行），与历史行为逐字节一致。
   */
  private collectLines(view: TerminalView, lastN?: number): string[] {
    if (lastN === undefined) {
      return view.readUsedLines?.(50) ?? view.readTailLines(50);
    }
    const limit = Math.min(500, Math.max(1, Math.floor(lastN)));
    return view.readTailLines(limit);
  }

  async send(
    terminalId: string | undefined,
    input: string,
    submit = false,
  ): Promise<{ terminalId: string }> {
    const target = await this.ensureShellReady(
      await this.resolveLoadedTarget(terminalId),
    );
    if (!target.view) throw new Error(`mv-AIDE terminal ${target.id} closed before input was delivered`);
    this.deliverRawInput(target.view, input, submit);
    this.recentTerminalId = target.id;
    return { terminalId: target.id };
  }

  async run(
    command: string,
    options: TerminalRunOptions = {},
  ): Promise<{ terminalId: string }> {
    if (!command.trim()) throw new Error("Terminal command must not be empty");
    this.refresh();

    let target: LoadedTarget;
    if (options.newTerminal === true) {
      target = await this.createTarget();
    } else if (options.terminalId || this.recentTerminalId) {
      target = await this.resolveLoadedTarget(options.terminalId);
    } else {
      target = await this.createTarget();
    }

    const ready = await this.ensureShellReady(target);
    this.deliverShellCommand(ready.view, command);
    this.recentTerminalId = ready.id;
    return { terminalId: ready.id };
  }

  async focus(terminalId: string): Promise<{ terminalId: string }> {
    const target = await this.resolveLoadedTarget(terminalId);
    await this.app.workspace.revealLeaf(target.leaf);
    target.view.focusTerminal();
    this.recentTerminalId = target.id;
    return { terminalId: target.id };
  }

  async create(): Promise<{ terminalId: string }> {
    const target = await this.createTarget();
    await this.ensureShellReady(target);
    return { terminalId: target.id };
  }

  async close(terminalId: string): Promise<{ terminalId: string; closed: true }> {
    const target = this.locate(terminalId);
    target.leaf.detach();
    if (this.activeTerminalLeaf === target.leaf) this.activeTerminalLeaf = null;
    if (this.recentTerminalId === target.id) this.recentTerminalId = null;
    this.leaves.delete(target.id);
    this.refresh();
    void this.app.workspace.requestSaveLayout?.();
    return { terminalId: target.id, closed: true };
  }

  dispose(): void {
    this.leaves.clear();
    this.recentTerminalId = null;
    this.activeTerminalLeaf = null;
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

  /**
   * 按 id 解析目标叶；已加载时 view 非空，休眠的历史终端返回 view:null
   * （由 resolveLoadedTarget 负责唤醒）。id 不存在仍抛 Unknown。
   */
  private locate(terminalId?: string): RegistryTarget {
    this.refresh();
    const id = terminalId ?? this.recentTerminalId;
    if (!id) throw new Error("No active mv-AIDE terminal");
    const leaf = this.leaves.get(id);
    if (!leaf) {
      if (this.recentTerminalId === id) this.recentTerminalId = null;
      throw new Error(`Unknown mv-AIDE terminal: ${id}`);
    }
    return {
      id,
      leaf,
      view: leaf.view instanceof TerminalView ? leaf.view : null,
    };
  }

  /**
   * 解析可操作的目标：显式寻址到休眠的历史终端时先 loadIfDeferred 唤醒
   * （onOpen 重建视图并拉起全新 PTY），随后重新解析——加载期间叶子可能被
   * 关闭（此时按 Unknown 报错）或唤醒失败（明确报错而非静默空读）。
   */
  private async resolveLoadedTarget(terminalId?: string): Promise<LoadedTarget> {
    let target = this.locate(terminalId);
    if (target.view) {
      return { id: target.id, leaf: target.leaf, view: target.view, wokeDeferred: false };
    }
    await target.leaf.loadIfDeferred?.();
    this.refresh();
    const reloaded = this.locate(target.id);
    if (!reloaded.view) {
      throw new Error(`mv-AIDE terminal ${reloaded.id} did not finish loading`);
    }
    return { id: reloaded.id, leaf: reloaded.leaf, view: reloaded.view, wokeDeferred: true };
  }

  private async createTarget(): Promise<LoadedTarget> {
    const leaf = await this.createTerminalLeaf();
    if (!leaf || !(leaf.view instanceof TerminalView)) {
      throw new Error("Failed to create mv-AIDE terminal");
    }
    const id = this.ensureId(leaf);
    this.refresh();
    this.recentTerminalId = id;
    return { id, leaf, view: leaf.view, wokeDeferred: false };
  }

  /** Raw terminal input: never quote, eval, or reinterpret caller bytes. */
  private deliverRawInput(view: TerminalView, input: string, submit: boolean): void {
    const frames = submit ? [input, "\r"] : [input];
    if (!view.sendInputSequence(frames)) {
      throw new Error("Terminal input could not be delivered");
    }
  }

  /** Reliable shell-command input, isolated from the raw send contract. */
  private deliverShellCommand(view: TerminalView, command: string): void {
    if (command.includes("\0")) {
      throw new Error("Terminal command must not contain NUL bytes");
    }
    const payload = safeInteractiveShellCommand(command, view.shellKind());
    if (!view.sendInputSequence([payload, "\r"])) {
      throw new Error("Terminal command could not be delivered");
    }
  }

  /**
   * 等 PTY 就绪（已挂载且首批输出已由 xterm 提交）再写入：
   * 登录 shell 启动需要时间，在此之前到达的输入由有界队列按序保留。
   * 视图未实现 isShellReady（旧测试替身）视为已就绪，不等待。返回等待期间
   * 重解析到的最新目标——叶可能被关闭（抛错→由调用方放弃）或再度延迟
   * （view 为 null）。
   */
  private async ensureShellReady(
    target: LoadedTarget,
    timeoutMs = SHELL_READY_TIMEOUT_MS,
  ): Promise<LoadedTarget> {
    const deadline = Date.now() + timeoutMs;
    let current: RegistryTarget = target;
    while (current.view?.isShellReady?.() === false && Date.now() < deadline) {
      await delay(READ_POLL_INTERVAL_MS);
      current = this.locate(target.id);
    }
    if (!current.view) throw new Error(`mv-AIDE terminal ${target.id} closed while waiting for its shell`);
    if (current.view.isShellReady?.() === false && current.view.isShellAlive?.() === false) {
      throw new Error(`mv-AIDE terminal ${target.id} shell exited before it became ready`);
    }
    return {
      id: current.id,
      leaf: current.leaf,
      view: current.view,
      wokeDeferred: target.wokeDeferred,
    };
  }

  /**
   * A restored deferred leaf owns a brand-new shell. Wait for visible xterm
   * content and a short quiet period so startup banners do not win the race
   * against the final prompt. Old scrollback is intentionally never restored.
   */
  private async waitForDeferredReadable(
    target: LoadedTarget,
    timeoutMs = SHELL_READABLE_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let stableRevision: number | null = null;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const current = this.locate(target.id);
      if (!current.view) throw new Error(`mv-AIDE terminal ${target.id} closed while waiting for its prompt`);
      if (current.view.hasReadableContent?.() === true) {
        const revision = current.view.terminalOutputRevision?.() ?? 0;
        if (stableRevision !== revision) {
          stableRevision = revision;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= SHELL_OUTPUT_SETTLE_MS) {
          return;
        }
      }
      if (current.view.isShellAlive?.() === false) {
        throw new Error(`mv-AIDE terminal ${target.id} shell exited before its prompt became readable`);
      }
      await delay(READ_POLL_INTERVAL_MS);
    }
  }
}

const READ_POLL_INTERVAL_MS = 50;
const READ_MAX_WAIT_MS = 5000;
const SHELL_READY_TIMEOUT_MS = 3000;
const SHELL_READABLE_TIMEOUT_MS = 3000;
const SHELL_OUTPUT_SETTLE_MS = 150;

function clampWaitMs(waitMs: number): number {
  if (!Number.isFinite(waitMs)) return 0;
  return Math.min(READ_MAX_WAIT_MS, Math.max(0, Math.floor(waitMs)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
