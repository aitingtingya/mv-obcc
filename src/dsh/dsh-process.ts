import type { ChildProcess } from "node:child_process";
import { runProcess, spawnProcess } from "../process-runner";

/** dsh web prints a line like `dsh web: http://127.0.0.1:3080`. */
const DSH_WEB_URL_RE = /dsh\s+web:\s*(https?:\/\/\S+)/iu;

/** The dsh web SPA root HTML carries this stable marker. */
const DSH_WEB_MARKER = "__DSH_BOOT__";

export const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * Canonical root URL for a dsh web endpoint. Browser iframe URLs always gain
 * a trailing slash, so every producer and consumer must compare this form.
 */
export function normalizeDshWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function sameDshWebUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeDshWebUrl(left);
  const normalizedRight = normalizeDshWebUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

/** Extract the URL the dsh web app announced on stdout/stderr. */
export function parseDshWebUrl(output: string): string | null {
  const match = DSH_WEB_URL_RE.exec(output);
  return match ? normalizeDshWebUrl(match[1]) : null;
}

export function dshWebUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** Whether a fetched root document is the dsh web UI. */
export function isDshWebResponse(text: string): boolean {
  return text.includes(DSH_WEB_MARKER);
}

/** Whether a failed child process output reports an address-in-use conflict. */
export function containsEaddrInUse(output: string): boolean {
  return /EADDRINUSE/iu.test(output);
}

export type ProbeClass = "dsh" | "other" | "unreachable";

/** Pure classification of a root-document probe result. */
export function classifyProbe(text: string | null): ProbeClass {
  if (text === null) return "unreachable";
  return isDshWebResponse(text) ? "dsh" : "other";
}

/** Ports to try when the configured port is occupied by a foreign server. */
export function nextPortCandidates(port: number, count: number): number[] {
  const candidates: number[] = [];
  for (let offset = 1; offset <= count; offset += 1) {
    const candidate = port + offset;
    if (candidate > 0 && candidate < 65536) candidates.push(candidate);
  }
  return candidates;
}

export interface DshCommand {
  executable: string;
  argsPrefix: string[];
  env?: NodeJS.ProcessEnv;
}

export type DshCommandProvider = () => Promise<DshCommand | null>;

export interface DshWebProbe {
  reachable: boolean;
  isDsh: boolean;
}

export type DshWebProbeFn = (url: string, timeoutMs: number) => Promise<DshWebProbe>;

/** GET the root document and classify it, with a short abort timeout. */
export async function probeDshWeb(url: string, timeoutMs = 1500): Promise<DshWebProbe> {
  const normalized = normalizeDshWebUrl(url);
  if (!normalized) return { reachable: false, isDsh: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(normalized, {
      method: "GET",
      signal: controller.signal,
    });
    const text = await response.text().catch(() => null);
    const cls = classifyProbe(text);
    return { reachable: cls !== "unreachable", isDsh: cls === "dsh" };
  } catch {
    return { reachable: false, isDsh: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map known dsh boot failures to friendly messages; null when the output is
 * not a recognized failure.
 */
export function describeDshBootError(output: string): string | null {
  if (containsEaddrInUse(output)) {
    return "端口已被其他程序占用，请在设置中更换端口。";
  }
  if (/failed to parse overlay\s+\S*cordis\.patch\.yml/iu.test(output)) {
    return "dsh 的 cordis.patch.yml 配置损坏，请重新点击“注入 mv-agent 插件”自动修复。";
  }
  return null;
}

/**
 * Managed child process for the validated vault/global DSH command.
 *
 * Reuse-first: if the configured port already serves a dsh instance, it is
 * adopted without spawning (the injected mv-agent plugin hot-loads into it).
 * A foreign server occupying the port triggers an automatic switch to the
 * next free port; EADDRINUSE on spawn is retried the same way.
 */
export class DshProcessManager {
  private child: ChildProcess | null = null;
  private output = "";
  private announcedUrl: string | null = null;
  private launchedPort: number | null = null;
  private starting: Promise<string> | null = null;
  private disposed = false;

  constructor(
    private readonly vaultRoot: () => string,
    private readonly port: () => number,
    private readonly probe: DshWebProbeFn = probeDshWeb,
    private readonly commandProvider: DshCommandProvider = async () => null,
  ) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  currentUrl(): string | null {
    return this.announcedUrl;
  }

  private rememberEndpoint(url: string, fallbackPort?: number): string {
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) throw new Error(`Invalid dsh web URL: ${url}`);
    this.announcedUrl = normalized;
    try {
      const parsedPort = Number(new URL(normalized).port);
      this.launchedPort = parsedPort || fallbackPort || null;
    } catch {
      this.launchedPort = fallbackPort ?? null;
    }
    return normalized;
  }

  private clearUnmanagedEndpoint(): void {
    if (this.isRunning()) return;
    this.announcedUrl = null;
    this.launchedPort = null;
  }

  /** The port the managed/adopted instance actually runs on, or null. */
  currentPort(): number | null {
    if (this.announcedUrl) {
      try {
        const parsed = new URL(this.announcedUrl);
        if (parsed.port) return Number(parsed.port);
      } catch {
        /* malformed URL — fall through to the launched port */
      }
    }
    return this.launchedPort;
  }

  /** Confirm one exact endpoint and adopt it as the shared current state. */
  async confirmDshUrl(url: string, timeoutMs = 1500): Promise<string | null> {
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) return null;
    const probe = await this.probe(normalized, timeoutMs);
    if (probe.reachable && probe.isDsh) {
      return this.rememberEndpoint(normalized);
    }
    if (
      this.announcedUrl &&
      sameDshWebUrl(this.announcedUrl, normalized)
    ) {
      this.clearUnmanagedEndpoint();
    }
    return null;
  }

  /**
   * Probe the configured port plus fallback candidates for a live dsh web
   * instance (covers the case where dsh was started elsewhere, e.g. in a
   * terminal, on a different port). Returns the first URL that serves the
   * dsh SPA, or null when none does.
   */
  async findDshUrl(): Promise<string | null> {
    const preferred = this.port();
    const candidates = [preferred, ...nextPortCandidates(preferred, 20)];
    for (const candidate of candidates) {
      const url = dshWebUrl(candidate);
      const probe = await this.probe(url, 1500);
      if (probe.reachable && probe.isDsh) {
        return this.rememberEndpoint(url, candidate);
      }
    }
    this.clearUnmanagedEndpoint();
    return null;
  }

  async ensureStarted(timeoutMs = 120_000): Promise<string> {
    if (this.disposed) throw new Error("dsh process manager is disposed");
    if (this.announcedUrl) {
      if (this.isRunning()) return this.announcedUrl;
      const adopted = await this.confirmDshUrl(this.announcedUrl, 2000);
      if (adopted) return adopted;
    }
    if (this.starting) return this.starting;
    this.starting = this.startInternal(timeoutMs);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(timeoutMs: number): Promise<string> {
    const preferred = this.port();
    const probe = await this.probe(dshWebUrl(preferred), 2000);
    if (probe.reachable && probe.isDsh) {
      // Adopt the running instance: the injection is hot-load, so the plugin
      // is (or will shortly be) live in it.
      return this.rememberEndpoint(dshWebUrl(preferred), preferred);
    }
    if (probe.reachable && !probe.isDsh) {
      const free = await this.findFreePort(nextPortCandidates(preferred, 20));
      if (free === null) {
        throw new Error(
          `端口 ${preferred} 已被其他程序占用，且未找到空闲端口，请在设置中更换端口。`,
        );
      }
      return this.launch(free, timeoutMs, true);
    }
    return this.launch(preferred, timeoutMs, true);
  }

  private async findFreePort(candidates: number[]): Promise<number | null> {
    for (const candidate of candidates) {
      const probe = await this.probe(dshWebUrl(candidate), 1200);
      if (!probe.reachable) return candidate;
    }
    return null;
  }

  private async launch(port: number, timeoutMs: number, allowRetry: boolean): Promise<string> {
    const command = await this.commandProvider();
    if (!command) {
      throw new Error("DSH 尚未安装，请先在 mv-agent 设置中点击“安装”。");
    }
    return new Promise((resolve, reject) => {
      const args = [...command.argsPrefix, "web", "--port", String(port)];
      const child = spawnProcess(command.executable, args, {
        cwd: this.vaultRoot(),
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.output = "";
      this.announcedUrl = null;
      this.launchedPort = port;

      const fallbackUrl = dshWebUrl(port);
      const startedAt = Date.now();
      let settled = false;

      const onData = (chunk: Buffer) => {
        this.output += chunk.toString("utf8");
        if (!this.announcedUrl) {
          const parsed = parseDshWebUrl(this.output);
          if (parsed) this.rememberEndpoint(parsed, port);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const poll = async () => {
        if (settled) return;
        const target = this.announcedUrl ?? fallbackUrl;
        const probe = await this.probe(target, 1500);
        if (probe.reachable && probe.isDsh) {
          settled = true;
          resolve(this.rememberEndpoint(target, port));
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          settled = true;
          reject(
            new Error(
              this.output.trim() ||
                `dsh web 未在 ${timeoutMs / 1000}s 内启动（端口 ${port}）。`,
            ),
          );
          return;
        }
        setTimeout(poll, 400);
      };

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (this.child === child) this.child = null;
        this.clearUnmanagedEndpoint();
        reject(error);
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = null;
        this.clearUnmanagedEndpoint();
        if (settled) return;
        settled = true;
        if (containsEaddrInUse(this.output)) {
          if (allowRetry) {
            // The preferred port raced with another process: switch to a free port once.
            void this.findFreePort(nextPortCandidates(this.port(), 20)).then((free) => {
              if (free === null) {
                reject(
                  new Error(
                    `端口 ${port} 已被占用，且未找到空闲端口，请在设置中更换端口。`,
                  ),
                );
                return;
              }
              this.launch(free, timeoutMs, false).then(resolve, reject);
            });
            return;
          }
          reject(new Error(`端口 ${port} 已被其他程序占用，请在设置中更换端口。`));
          return;
        }
        const friendly = describeDshBootError(this.output);
        const tail = this.output.trim();
        reject(
          new Error(
            friendly ?? `dsh web 提前退出（code ${code ?? "?"}）：${tail || "无输出"}`,
          ),
        );
      });

      void poll();
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.announcedUrl = null;
    this.launchedPort = null;
    if (!child) return;
    if (child.exitCode !== null) return;
    try {
      if (process.platform === "win32" && child.pid) {
        await runProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          timeoutMs: 15_000,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Close the mv-agent dsh instance: the managed child when mv-AIDE started
   * it, otherwise the adopted listener on the configured port — but only
   * after confirming that port actually serves dsh, so a foreign service is
   * never touched.
   */
  async closeInstance(): Promise<string> {
    if (this.child) {
      const running = this.isRunning();
      await this.stop();
      return running
        ? "已关闭 mv-agent 启动的 dsh 实例。"
        : "mv-agent 未在运行。";
    }
    const preferred = this.port();
    const probe = await this.probe(dshWebUrl(preferred), 2000);
    if (!probe.reachable || !probe.isDsh) {
      return "mv-agent 未在运行。";
    }
    if (process.platform === "win32") {
      const result = await runProcess(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${preferred} -State Listen).OwningProcess -Force`,
        ],
        { timeoutMs: 15_000 },
      );
      return result.code === 0
        ? "已关闭 mv-agent（复用实例）。"
        : "关闭失败：无法结束该 dsh 进程。";
    }
    return "关闭失败：当前平台不支持结束复用实例，请手动关闭。";
  }

  /** Close then relaunch, for the 「重启 mv-agent」 command. */
  async restartInstance(): Promise<void> {
    await this.closeInstance();
    await this.ensureStarted();
  }

  dispose(): void {
    this.disposed = true;
    void this.stop();
  }
}
