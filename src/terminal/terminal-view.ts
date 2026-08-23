import { ItemView, WorkspaceLeaf, TFile, Menu, Platform } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { StringDecoder } from "string_decoder";
import { TERMINAL_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { mvAideRuntimeDirectory } from "../storage/temp-paths";
import { ensureCodexExecutablePath } from "../agent-integrations/codex/executable-wrapper";
import {
  resolveTerminalTheme,
  terminalThemeSignature,
  type ResolvedTerminalTheme,
} from "./terminal-themes";
import { resolveTerminalKeyAction } from "./terminal-clipboard";
import { encodeTerminalKey } from "./terminal-keys";
import { TERMINAL_PTY_PY_BASE64, TERMINAL_WIN_PY_BASE64 } from "./terminal-scripts";
import { loginShellPath, resolvePythonCommand } from "./terminal-process";
import {
  collectTailLines,
  collectUsedLines,
  describeBuffer,
  type ReadDiagnostics,
} from "./terminal-read";
import { TerminalInputQueue } from "./terminal-input-queue";
import {
  terminalShellKind,
  type TerminalShellKind,
} from "./terminal-command";
import type MvAideIdePlugin from "../../main";

// stdin 帧协议：[type: 1B][length: 4B LE][payload]。前端按消息打帧、后端
// 按帧拆分，不再从无边界字节流里猜转义序列边界（旧方案下 Windows 裸 ESC
// 会被解析器当作"可能的序列开头"无限期扣押）。scripts/terminal/*.py 实现
// 同一协议，改动必须两端同步并重新生成 terminal-scripts.ts。
const TERMINAL_FRAME_INPUT = 0;
const TERMINAL_FRAME_RESIZE = 1;

export class TerminalView extends ItemView {
  private plugin: MvAideIdePlugin;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private termHost: HTMLDivElement | null = null;
  private proc: child_process.ChildProcess | null = null;
  private stdoutDecoder: StringDecoder | null = null;
  private stderrDecoder: StringDecoder | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private _fitInProgress = false;
  private debounceFitTimer: NodeJS.Timeout | null = null;
  private appliedThemeSignature = "";
  // 用户是否把视图钉在底部。xterm 内部的跟随状态会被 reflow/转义序列带歪
  // 且不自愈（表现为输出时视图瞬移到顶部），所以由我们自己跟踪：只在用户
  // 通过滚轮/触控板/Shift+PageUp/Down 主动滚动后重新采样。
  private followPinned = true;
  private shellStartGeneration = 0;
  // PTY 就绪前的输入帧队列（含人工键入与 agent 写入），stdin 挂上后按序冲刷。
  private inputQueue = new TerminalInputQueue();
  /** 首批 PTY 输出是否已经由 xterm 解析并提交到缓冲区。 */
  private firstParsedOutput = false;
  private outputRevision = 0;
  private currentShellKind: TerminalShellKind = process.platform === "win32" ? "cmd" : "posix";

  constructor(leaf: WorkspaceLeaf, plugin: MvAideIdePlugin) {
    super(leaf);
    this.plugin = plugin;
    // The terminal can live in either sidebar or the main workspace. Marking
    // it navigable lets Obsidian expose its native pane movement semantics.
    this.navigation = true;
  }

  focusTerminal(): void {
    this.term?.focus();
  }

  refreshTheme(): void {
    this.updateTheme(true);
  }

  /** 读取终端缓冲区末尾若干物理行（字面模式，供 getTerminalOutput 与显式 lastN）。 */
  readTailLines(maxLines: number): string[] {
    const buffer = this.term?.buffer.active;
    if (!buffer) return [];
    return collectTailLines(buffer, maxLines);
  }

  /**
   * 智能模式：读取"已用区域"（光标 / 最后非空行向上）最多 maxLines 行。
   * 空闲 shell 的提示符在缓冲区顶部、其下全是空白视口行，字面尾窗会读成
   * 全空——此模式跳过空白填充，让默认调用总能看到实际内容。
   */
  readUsedLines(maxLines = 50): string[] {
    const buffer = this.term?.buffer.active;
    if (!buffer) return [];
    return collectUsedLines(buffer, maxLines);
  }

  /** 缓冲区诊断信息，随 read 响应返回以便远程定位问题。 */
  describeReadState(): ReadDiagnostics & { procAlive: boolean } {
    const buffer = this.term?.buffer.active;
    const base = buffer
      ? describeBuffer(buffer)
      : { bufLen: 0, cursorRow: null, lastContentRow: null };
    return { ...base, procAlive: !!this.proc && !this.proc.killed };
  }

  /** PTY 是否已挂载且产出过字节（shell 大致就绪的信号）。 */
  isShellReady(): boolean {
    return this.isShellAlive() && this.firstParsedOutput;
  }

  isShellAlive(): boolean {
    return !!this.proc && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  hasReadableContent(): boolean {
    return this.readUsedLines(1).length > 0;
  }

  terminalOutputRevision(): number {
    return this.outputRevision;
  }

  shellKind(): TerminalShellKind {
    return this.currentShellKind;
  }

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("系统终端");
  }

  getIcon(): string {
    return "terminal";
  }

  /** 标签页右键菜单：追加「刷新终端」（重启 shell 会话）。 */
  onPaneMenu(menu: Menu, source: string): void {
    // 不按 source 过滤：主区标签为 "tab-header"，侧边栏标签为
    // "sidebar-context-menu"，⋮ 菜单为 "more-options"，都要带上。
    menu.addItem((item) =>
      item
        .setTitle(t("刷新终端"))
        .setIcon("refresh-ccw")
        .onClick(() => void this.refreshShell()),
    );
  }

  /** 刷新终端：杀掉当前 PTY、复位 xterm（清屏）、重新启动 shell 会话。 */
  private async refreshShell(): Promise<void> {
    if (!this.term) return;
    this.stopShell();
    this.term.reset();
    this.followPinned = true;
    await this.startShell();
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.initTerminal();
    await this.startShell();
    
    this.resizeObserver = new ResizeObserver(() => this.debouncedFit());
    this.resizeObserver.observe(this.containerEl);

    this.themeObserver = new MutationObserver(() => this.updateTheme());
    this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    if (this.debounceFitTimer) {
      clearTimeout(this.debounceFitTimer);
      this.debounceFitTimer = null;
    }
    this.stopShell();
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
  }

  private buildUI() {
    const container = this.containerEl;
    container.empty();
    container.addClass("vault-terminal");
    this.termHost = container.createDiv({ cls: "vault-terminal-host" });
  }

  private getThemeColors(): ResolvedTerminalTheme {
    const styles = getComputedStyle(document.body);
    return resolveTerminalTheme(this.plugin.settings, {
      isLightMode: document.body.classList.contains("theme-light"),
      getCssVar: (name) => styles.getPropertyValue(name).trim(),
    });
  }

  private updateTheme(force = false) {
    if (!this.term) return;
    const resolvedTheme = this.getThemeColors();
    const signature = terminalThemeSignature(resolvedTheme);
    if (force || signature !== this.appliedThemeSignature) {
      this.term.options.theme = resolvedTheme.palette;
      this.term.options.minimumContrastRatio = resolvedTheme.minimumContrastRatio;
      this.appliedThemeSignature = signature;
      this.containerEl.style.setProperty("--mv-terminal-background", resolvedTheme.palette.background);
      this.termHost?.style.setProperty("--mv-terminal-background", resolvedTheme.palette.background);
    }
  }

  private initTerminal() {
    if (!this.termHost) return;

    const settings = this.plugin.settings;
    const fontFamily = settings.terminalFontFamily || "Menlo, Monaco, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', 'Microsoft YaHei', monospace";
    const fontSize = Number(settings.terminalFontSize) || 13;

    const resolvedTheme = this.getThemeColors();
    this.appliedThemeSignature = terminalThemeSignature(resolvedTheme);
    this.containerEl.style.setProperty("--mv-terminal-background", resolvedTheme.palette.background);
    this.termHost.style.setProperty("--mv-terminal-background", resolvedTheme.palette.background);

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: fontFamily,
      theme: resolvedTheme.palette,
      minimumContrastRatio: resolvedTheme.minimumContrastRatio,
      scrollback: 10000,
      macOptionIsMeta: false,
      // CJK glyphs come from a fallback font whose metrics don't match the
      // measured monospace cell; without rescaling they overflow and paint
      // over the following characters.
      rescaleOverlappingGlyphs: true
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.termHost);

    this.term.parser?.registerCsiHandler({ final: "I" }, () => true);
    this.term.parser?.registerCsiHandler({ final: "O" }, () => true);

    // 视口位置是钉住状态的唯一真相（stick-to-bottom）：任何来源的滚动
    // （wheel/触控板/刻度轮/滚动条拖拽/键盘翻页）都实时重判——滚离底部
    // 立即停止一切程序化滚动，滚回底部当场恢复跟随。我们自己的
    // scrollToBottom 只在已钉住时执行且落点必为底部，其触发的 onScroll
    // 只是把 true 再确认一遍，因此无需区分程序化滚动与用户滚动。
    // 监听器随 onClose 的 term.dispose() 一并销毁，无需额外清理。
    this.term.onScroll(() => {
      this.followPinned = this.isAtBottom();
    });

    // Single key pipeline on the window capture phase: it runs before both
    // Obsidian's hotkey system and xterm's own textarea handler, so a focused
    // terminal receives keys exactly like a real terminal would.
    this.registerDomEvent(
      activeWindow,
      "keydown",
      (event) => this.handleTerminalKeydown(event),
      { capture: true },
    );

    // 滚轮/触控板滚动是用户翻历史的主要途径。输入事件先于 xterm 应用
    // 滚动、更先于异步的 scroll 事件：在此同步解钉，封死手势期间 write
    // 回调唯一可能拉底的窗口。不看方向——钉住状态由 onScroll 按视口
    // 实际位置实时重判（见上方注册处）。
    this.registerDomEvent(this.termHost, "wheel", () => {
      this.followPinned = false;
    }, {
      passive: true,
    });

    this.registerDomEvent(this.termHost, "contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      if (this.term?.hasSelection()) {
        menu.addItem((item) =>
          item.setTitle(t("复制")).onClick(() => {
            const selection = this.term?.getSelection() ?? "";
            if (selection) void navigator.clipboard.writeText(selection);
            this.term?.clearSelection();
          }),
        );
      }
      menu.addItem((item) =>
        item.setTitle(t("粘贴")).onClick(() => {
          void navigator.clipboard.readText().then((text) => {
            if (text) this.term?.paste(text);
          });
        }),
      );
      menu.addItem((item) =>
        item.setTitle(t("全选")).onClick(() => this.term?.selectAll()),
      );
      menu.showAtMouseEvent(event);
    });

    this.term.registerLinkProvider?.({
      provideLinks: (y, callback) => {
        const line = this.term?.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(true);
        const links: any[] = [];
        const seen = new Set();

        const pushLink = (candidate: string, startIdx0: number) => {
          const file = this.resolveVaultPath(candidate);
          if (!file) return false;
          const start = startIdx0 + 1;
          const end = startIdx0 + candidate.length;
          if (seen.has(start)) return true;
          seen.add(start);
          links.push({
            text: candidate,
            range: { start: { x: start, y }, end: { x: end, y } },
            activate: () => this.openVaultFile(file)
          });
          return true;
        };

        const reBacktick = /`([^`\r\n]*?\.\w+)`/g;
        let b;
        while ((b = reBacktick.exec(text)) !== null) {
          if (b[1]) {
            pushLink(b[1], b.index + 1);
          }
        }

        const rePlain = /(?:[\w.\- ]+\/)*[\w.\- ]+\.\w+/g;
        let m;
        while ((m = rePlain.exec(text)) !== null) {
          let candidate = m[0];
          let offset = m.index;
          if (seen.has(offset + 1)) continue;
          while (candidate) {
            if (pushLink(candidate, offset)) break;
            const sp = candidate.indexOf(" ");
            if (sp === -1) break;
            offset += sp + 1;
            candidate = candidate.slice(sp + 1);
          }
        }
        callback(links.length ? links : undefined);
      }
    });

    this.term.onData((data) => {
      this.writeTerminalFrame(TERMINAL_FRAME_INPUT, data);
    });

    this.term.onResize(({ cols: c, rows: r }) => {
      if (c < 10 || r < 3) return;
      this.writeTerminalFrame(TERMINAL_FRAME_RESIZE, `${c};${r}`);
    });
  }

  /** 向 PTY 发送原始输入（文件底部指令等外部触发用）。PTY 未就绪时入队。 */
  sendInput(text: string): boolean {
    return this.writeTerminalFrame(TERMINAL_FRAME_INPUT, text);
  }

  /** Atomically queue a sequence of raw input payloads before PTY startup. */
  sendInputSequence(payloads: string[]): boolean {
    return this.inputQueue.enqueueManyOrWrite(
      payloads.map((payload) => ({ type: TERMINAL_FRAME_INPUT, payload })),
      this.frameSink(),
    );
  }

  private writeTerminalFrame(type: number, payload: string): boolean {
    // PTY 尚未挂载时不再静默丢帧：入队等待 startShell 完成后按序冲刷。
    return this.inputQueue.enqueueOrWrite(type, payload, this.frameSink());
  }

  private frameSink() {
    return {
      canWrite: () => !!this.proc?.stdin && this.isShellAlive(),
      write: (frame: Buffer) => {
        const proc = this.proc;
        if (!proc?.stdin || !this.isShellAlive()) {
          throw new Error("Terminal process closed before input delivery");
        }
        proc.stdin.write(frame);
      },
    };
  }

  private handleTerminalKeydown(event: KeyboardEvent): void {
    const term = this.term;
    // Only when the terminal itself has focus; everywhere else Obsidian
    // hotkeys and editor behavior stay untouched.
    if (!term || term.textarea !== activeDocument.activeElement) return;

    const action = resolveTerminalKeyAction(event, {
      isMac: Platform.isMacOS,
      hasSelection: term.hasSelection(),
    });
    if (action === "copy") {
      const selection = term.getSelection();
      if (selection) void navigator.clipboard.writeText(selection);
      term.clearSelection();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (action === "paste") {
      // term.paste() applies bracketed-paste wrapping, so pasting multiple
      // lines into a TUI does not execute them line by line. preventDefault
      // keeps xterm's own paste-event handler from pasting a second copy.
      event.preventDefault();
      event.stopImmediatePropagation();
      void navigator.clipboard.readText().then((text) => {
        if (text) this.term?.paste(text);
      });
      return;
    }

    if (this.plugin.settings.terminalKeyPassthrough === false) return;
    if (!this.proc?.stdin || this.proc.killed) return;

    const encoded = encodeTerminalKey(event, {
      applicationCursorKeys: term.modes.applicationCursorKeysMode,
    });
    if (encoded === null) {
      // Shift+PageUp/Down 走 xterm 默认的滚动缓冲翻页（见 terminal-keys.ts）。
      // 与 wheel 同理：同步解钉，钉住状态交给 onScroll 按视口位置实时重判。
      if (event.shiftKey && !event.ctrlKey && !event.altKey &&
          (event.key === "PageUp" || event.key === "PageDown")) {
        this.followPinned = false;
      }
      return;
    }
    // The encoded bytes go straight to the PTY; xterm must not see the key
    // a second time, and Obsidian must not trigger a hotkey for it.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.writeTerminalFrame(TERMINAL_FRAME_INPUT, encoded);
  }

  private resolveVaultPath(candidate: string): TFile | null {
    if (!candidate) return null;
    if (candidate.startsWith("/") || candidate.startsWith("~") || candidate.includes("://")) return null;
    const direct = this.app.vault.getAbstractFileByPath(candidate);
    if (direct instanceof TFile) return direct;
    const dest = this.app.metadataCache.getFirstLinkpathDest(candidate, "");
    if (dest instanceof TFile) return dest;
    return null;
  }

  private async openVaultFile(file: TFile) {
    const mdLeaves = this.app.workspace.getLeavesOfType("markdown");
    const already = mdLeaves.find((l) => (l.view as any)?.file?.path === file.path);
    if (already) {
      this.app.workspace.setActiveLeaf(already, { focus: true });
      return;
    }
    const target = mdLeaves.filter((l) => !(l as any).pinned)[0] || mdLeaves[0];
    if (target) {
      await target.openFile(file);
      this.app.workspace.setActiveLeaf(target, { focus: true });
    } else {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }

  private async startShell(): Promise<void> {
    const generation = ++this.shellStartGeneration;
    this.firstParsedOutput = false;
    this.outputRevision = 0;
    const isWindows = process.platform === "win32";
    const settings = this.plugin.settings;

    const scriptB64 = isWindows ? TERMINAL_WIN_PY_BASE64 : TERMINAL_PTY_PY_BASE64;
    const scriptName = isWindows ? "mv_terminal_win.py" : "mv_terminal_pty.py";
    const runtimeDirectory = mvAideRuntimeDirectory("terminal");
    await fs.promises.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    const scriptPath = path.join(runtimeDirectory, scriptName);
    const scriptContent = Buffer.from(scriptB64, "base64").toString("utf-8");
    await fs.promises.writeFile(scriptPath, scriptContent, { mode: 0o755 });

    const pythonCmd = resolvePythonCommand(settings.terminalPythonPath);
    if (!pythonCmd) {
      this.term?.writeln(t("未检测到 Python，请在插件设置中配置 Python 可执行文件路径。"));
      return;
    }
    if (generation !== this.shellStartGeneration) return;

    const shellPath = isWindows 
      ? (settings.terminalWinShellPath || "cmd.exe") 
      : (settings.terminalMacShellPath || process.env.SHELL || "/bin/zsh");
    this.currentShellKind = terminalShellKind(shellPath, process.platform);
    
    const shellArgsStr = isWindows 
      ? settings.terminalWinShellArgs 
      : settings.terminalMacShellArgs;
    
    let shellArgs = shellArgsStr ? shellArgsStr.split(/\s+/).filter(Boolean) : [];
    if (!isWindows && !shellArgsStr) {
      shellArgs = ["-l"];
    }

    let cols = 80;
    let rows = 24;
    if (this.fitAddon) {
      const propose = this.fitAddon.proposeDimensions();
      if (propose && propose.cols >= 30 && propose.rows >= 5) {
        cols = propose.cols;
        rows = propose.rows;
      }
    }

    const cwd = (this.app.vault.adapter as any).getBasePath?.() || process.cwd();
    const ptyArgs = [scriptPath, String(cols), String(rows), shellPath, ...shellArgs];
    
    const shellEnv: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    if (!isWindows) {
      const resolvedPath = await loginShellPath(shellPath);
      if (generation !== this.shellStartGeneration) return;
      if (resolvedPath) shellEnv.PATH = resolvedPath;
    }
    try {
      const codexBinDirectory = await ensureCodexExecutablePath(settings.codexExecutable);
      if (generation !== this.shellStartGeneration) return;
      if (codexBinDirectory) {
        shellEnv.PATH = [codexBinDirectory, shellEnv.PATH].filter(Boolean).join(path.delimiter);
      }
    } catch (error) {
      console.warn("[mv-aide] Failed to prepare the managed Codex executable wrapper.", error);
    }

    try {
      const child = child_process.spawn(pythonCmd, ptyArgs, {
        cwd,
        env: shellEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: !isWindows
      });
      this.proc = child;

      this.stdoutDecoder = new StringDecoder("utf8");
      this.stderrDecoder = new StringDecoder("utf8");

      child.stdout?.on("data", (data: Buffer) => {
        if (generation !== this.shellStartGeneration || this.proc !== child) return;
        if (this.term && this.stdoutDecoder) {
          const decoded = this.stdoutDecoder.write(data);
          this.term.write(decoded, () => {
            if (generation !== this.shellStartGeneration || this.proc !== child) return;
            this.firstParsedOutput = true;
            this.outputRevision += 1;
            // 写完每个输出块后若用户钉在底部则强制回底：无论 xterm 内部跟随
            // 状态被 reflow/转义序列带歪成什么样，下一个输出块都会扶正。
            if (this.followPinned) this.term?.scrollToBottom();
          });
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        if (generation !== this.shellStartGeneration || this.proc !== child) return;
        if (this.term && this.stderrDecoder) {
          const decoded = this.stderrDecoder.write(data);
          this.term.write(decoded, () => {
            if (generation !== this.shellStartGeneration || this.proc !== child) return;
            this.firstParsedOutput = true;
            this.outputRevision += 1;
            if (this.followPinned) this.term?.scrollToBottom();
          });
        }
      });

      child.on("exit", (code, signal) => {
        if (generation !== this.shellStartGeneration || this.proc !== child) return;
        if (isWindows && code === 9009) {
          this.term?.writeln(t("\r\n[Python 解释器未找到]"));
          this.term?.writeln(t("请在设置中配置 Python 可执行文件路径，或者安装 Python 到系统。"));
        } else {
          this.term?.writeln(t("\r\n[终端进程已退出: {code}]", { code: String(code ?? signal ?? "") }));
        }
        this.proc = null;
      });

      child.on("error", (err) => {
        if (generation !== this.shellStartGeneration || this.proc !== child) return;
        if (isWindows && err.message.includes("ENOENT")) {
          this.term?.writeln(t("\r\n[Python 执行失败 - Python 未找到]"));
          this.term?.writeln(t("请检查 Python 是否已安装且在 PATH 中，或在设置中手动指定。"));
        } else {
          this.term?.writeln(t("\r\n[错误: {message}]", { message: err.message }));
        }
        this.proc = null;
      });

      // Fit/focus immediately when the container already has a real size
      // instead of always waiting a fixed delay; keep one delayed refit as
      // a fallback for late-finishing layouts.
      if (this.containerEl.clientWidth > 0 && this.containerEl.clientHeight > 0) {
        this.fit();
        this.term?.focus();
      }
      setTimeout(() => {
        if (this.term && this.fitAddon) {
          this.fit();
          this.term.focus();
        }
      }, 300);

      // PTY 已挂载：冲刷就绪前积压的输入帧（保持到达顺序）。
      this.inputQueue.flush({
        canWrite: () => this.proc === child && !!child.stdin && child.exitCode === null,
        write: (frame) => {
          if (this.proc !== child || !child.stdin || child.exitCode !== null) return;
          child.stdin.write(frame);
        },
      });

    } catch (e) {
      this.term?.writeln(t("\r\n[启动终端错误: {message}]", { message: (e as any).message }));
    }
  }

  /** 停止 PTY（插件卸载清扫与「刷新终端」共用）。 */
  stopShell() {
    this.shellStartGeneration += 1;
    // 进程被终止，未冲刷的输入帧随之作废，避免串到下一个 shell 会话。
    this.inputQueue.clear();
    this.firstParsedOutput = false;
    this.outputRevision = 0;
    const child = this.proc;
    this.proc = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const pid = child.pid;
      const isWin = process.platform === "win32";
      const killTree = (sig: NodeJS.Signals) => {
        if (!isWin && pid) {
          try {
            process.kill(-pid, sig);
            return;
          } catch (_) {}
        }
        try {
          child.kill(sig);
        } catch (_) {}
      };
      killTree("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killTree("SIGKILL");
        }
      }, 1000);
      child.once("exit", () => clearTimeout(killTimer));
    }
    if (this.stdoutDecoder) {
      const rem = this.stdoutDecoder.end();
      if (rem) this.term?.write(rem);
      this.stdoutDecoder = null;
    }
    if (this.stderrDecoder) {
      const rem = this.stderrDecoder.end();
      if (rem) this.term?.write(rem);
      this.stderrDecoder = null;
    }
  }

  private debouncedFit() {
    if (this.debounceFitTimer) {
      clearTimeout(this.debounceFitTimer);
    }
    this.debounceFitTimer = setTimeout(() => {
      this.debounceFitTimer = null;
      this.fit();
    }, 100);
  }

  private isAtBottom(): boolean {
    const buffer = this.term?.buffer.active;
    // 1 行容差吸收平滑滚动带来的小数位置。
    return !!buffer && buffer.viewportY >= buffer.baseY - 1;
  }

  private fit() {
    if (!this.term || !this.fitAddon) return;
    if (this._fitInProgress) return;
    const width = this.containerEl.clientWidth;
    const height = this.containerEl.clientHeight;
    if (width <= 0 || height <= 0) return;

    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions || dimensions.cols < 10 || dimensions.rows < 3) return;
    // 尺寸没变就不 resize：避免无谓的 PTY SIGWINCH 引发 TUI 全屏重绘和
    // buffer reflow（滚动瞬移的主要诱因之一）。
    if (dimensions.cols === this.term.cols && dimensions.rows === this.term.rows) return;

    this._fitInProgress = true;
    try {
      this.fitAddon.fit();
      // 无输出期间发生的 reflow 跳转也要自愈。
      if (this.followPinned) this.term.scrollToBottom();
    } finally {
      this._fitInProgress = false;
    }
  }
}
