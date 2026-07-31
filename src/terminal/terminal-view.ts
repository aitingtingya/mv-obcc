import { ItemView, WorkspaceLeaf, TFile, Menu, Platform } from "obsidian";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { StringDecoder } from "string_decoder";
import { TERMINAL_VIEW_TYPE } from "../constants";
import {
  resolveTerminalTheme,
  terminalThemeSignature,
  type ResolvedTerminalTheme,
} from "./terminal-themes";
import { resolveTerminalKeyAction } from "./terminal-clipboard";
import { encodeTerminalKey } from "./terminal-keys";
import { TERMINAL_PTY_PY_BASE64, TERMINAL_WIN_PY_BASE64 } from "./terminal-scripts";
import MvSenceAiIdePlugin from "../../main";

export class TerminalView extends ItemView {
  private plugin: MvSenceAiIdePlugin;
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

  constructor(leaf: WorkspaceLeaf, plugin: MvSenceAiIdePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  focusTerminal(): void {
    this.term?.focus();
  }

  refreshTheme(): void {
    this.updateTheme(true);
  }

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "系统终端";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.initTerminal();
    this.startShell();
    
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
      macOptionIsMeta: false
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.termHost);

    this.term.parser?.registerCsiHandler({ final: "I" }, () => true);
    this.term.parser?.registerCsiHandler({ final: "O" }, () => true);

    // Single key pipeline on the window capture phase: it runs before both
    // Obsidian's hotkey system and xterm's own textarea handler, so a focused
    // terminal receives keys exactly like a real terminal would.
    this.registerDomEvent(
      activeWindow,
      "keydown",
      (event) => this.handleTerminalKeydown(event),
      { capture: true },
    );

    this.registerDomEvent(this.termHost, "contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      if (this.term?.hasSelection()) {
        menu.addItem((item) =>
          item.setTitle("复制").onClick(() => {
            const selection = this.term?.getSelection() ?? "";
            if (selection) void navigator.clipboard.writeText(selection);
            this.term?.clearSelection();
          }),
        );
      }
      menu.addItem((item) =>
        item.setTitle("粘贴").onClick(() => {
          void navigator.clipboard.readText().then((text) => {
            if (text) this.term?.paste(text);
          });
        }),
      );
      menu.addItem((item) =>
        item.setTitle("全选").onClick(() => this.term?.selectAll()),
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
      if (this.proc && this.proc.stdin && !this.proc.killed) {
        this.proc.stdin.write(data);
      }
    });

    this.term.onResize(({ cols: c, rows: r }) => {
      if (c < 10 || r < 3) return;
      if (this.proc && this.proc.stdin && !this.proc.killed) {
        this.proc.stdin.write(`\x1b]RESIZE;${c};${r}\x07`);
      }
    });
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
    if (encoded === null) return;
    // The encoded bytes go straight to the PTY; xterm must not see the key
    // a second time, and Obsidian must not trigger a hotkey for it.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.proc.stdin.write(encoded);
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

  private startShell() {
    const isWindows = process.platform === "win32";
    const settings = this.plugin.settings;

    const scriptB64 = isWindows ? TERMINAL_WIN_PY_BASE64 : TERMINAL_PTY_PY_BASE64;
    const scriptName = isWindows ? "mv_terminal_win.py" : "mv_terminal_pty.py";
    const scriptPath = path.join(os.tmpdir(), scriptName);
    const scriptContent = Buffer.from(scriptB64, "base64").toString("utf-8");
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    let pythonCmd = settings.terminalPythonPath || (isWindows ? "py" : "python3");
    if (isWindows && !settings.terminalPythonPath) {
      try {
        child_process.execSync("py --version", { stdio: "ignore", timeout: 2000 });
        pythonCmd = "py";
      } catch (e) {
        try {
          const whereOutput = child_process.execSync("where.exe python", { encoding: "utf8", timeout: 2000 });
          const pythonPaths = whereOutput.split(/\r?\n/).map(p => p.trim()).filter(p => p && !p.includes("WindowsApps"));
          const batShim = pythonPaths.find(p => p.toLowerCase().endsWith(".bat"));
          pythonCmd = batShim || pythonPaths[0] || "python";
        } catch (e2) {
          pythonCmd = "python";
        }
      }
    }

    const shellPath = isWindows 
      ? (settings.terminalWinShellPath || "cmd.exe") 
      : (settings.terminalMacShellPath || process.env.SHELL || "/bin/zsh");
    
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
      try {
        const shellOutput = child_process.execFileSync(
          shellPath,
          ["-lic", 'echo "__PATH__"; echo "$PATH"'],
          { encoding: "utf8", timeout: 3000 },
        );
        const shellPathEnv = shellOutput.split("__PATH__\n")[1]?.trim().split("\n")[0];
        if (shellPathEnv) {
          shellEnv.PATH = shellPathEnv;
        }
      } catch (e) {}
    }

    try {
      this.proc = child_process.spawn(pythonCmd, ptyArgs, {
        cwd,
        env: shellEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: !isWindows
      });

      this.stdoutDecoder = new StringDecoder("utf8");
      this.stderrDecoder = new StringDecoder("utf8");

      this.proc.stdout?.on("data", (data) => {
        if (this.term && this.stdoutDecoder) {
          this.term.write(this.stdoutDecoder.write(data));
        }
      });

      this.proc.stderr?.on("data", (data) => {
        if (this.term && this.stderrDecoder) {
          this.term.write(this.stderrDecoder.write(data));
        }
      });

      this.proc.on("exit", (code, signal) => {
        if (isWindows && code === 9009) {
          this.term?.writeln("\r\n[Python 解释器未找到]");
          this.term?.writeln("请在设置中配置 Python 可执行文件路径，或者安装 Python 到系统。");
        } else {
          this.term?.writeln(`\r\n[终端进程已退出: ${code ?? signal}]`);
        }
        this.proc = null;
      });

      this.proc.on("error", (err) => {
        if (isWindows && err.message.includes("ENOENT")) {
          this.term?.writeln("\r\n[Python 执行失败 - Python 未找到]");
          this.term?.writeln("请检查 Python 是否已安装且在 PATH 中，或在设置中手动指定。");
        } else {
          this.term?.writeln(`\r\n[错误: ${err.message}]`);
        }
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

    } catch (e) {
      this.term?.writeln(`\r\n[启动终端错误: ${(e as any).message}]`);
    }
  }

  stopShell() {
    if (this.proc && !this.proc.killed) {
      const pid = this.proc.pid;
      const isWin = process.platform === "win32";
      const killTree = (sig: NodeJS.Signals) => {
        if (!isWin && pid) {
          try {
            process.kill(-pid, sig);
            return;
          } catch (_) {}
        }
        try {
          this.proc?.kill(sig);
        } catch (_) {}
      };
      killTree("SIGTERM");
      const t = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          killTree("SIGKILL");
        }
      }, 1000);
      this.proc.once("exit", () => clearTimeout(t));
      this.proc = null;
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

  private fit() {
    if (!this.term || !this.fitAddon) return;
    if (this._fitInProgress) return;
    const width = this.containerEl.clientWidth;
    const height = this.containerEl.clientHeight;
    if (width <= 0 || height <= 0) return;

    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions || dimensions.cols < 10 || dimensions.rows < 3) return;

    this._fitInProgress = true;
    try {
      this.fitAddon.fit();
    } finally {
      this._fitInProgress = false;
    }
  }
}
