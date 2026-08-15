import type { ChildProcess } from "node:child_process";
import {
  createDefaultDshProcessDiscoveryAdapter,
  discoverDshProcesses,
  isObsidianChildProcess,
  type DshProcessDiscoveryAdapter,
  type DshProcessInfo,
} from "./dsh-process-discovery";
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

export class DshStartCancelledError extends Error {
  constructor() {
    super("dsh start cancelled");
    this.name = "DshStartCancelledError";
  }
}

export function isDshStartCancelled(error: unknown): boolean {
  return error instanceof DshStartCancelledError;
}

/** Sentinel: this candidate port was occupied when dsh tried to bind it. */
export class DshPortOccupiedError extends Error {
  constructor(readonly port: number, output: string) {
    super(`端口 ${port} 已被其他程序占用。${output ? ` ${output.trim()}` : ""}`.trim());
    this.name = "DshPortOccupiedError";
  }
}

export function isDshPortOccupiedError(error: unknown): error is DshPortOccupiedError {
  return error instanceof DshPortOccupiedError;
}

export interface DshStopSummary {
  stoppedPids: number[];
  failedPids: number[];
  stoppedPorts: number[];
  notRunning: boolean;
}

export type DshStopResult =
  | "managed-stopped"
  | "not-running"
  | "adopted-stopped"
  | "adopted-stop-failed"
  | "adopted-stop-unsupported";

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
  private startGeneration = 0;
  private cancelPendingLaunch: (() => void) | null = null;
  private disposed = false;

  constructor(
    private readonly vaultRoot: () => string,
    private readonly port: () => number,
    private readonly probe: DshWebProbeFn = probeDshWeb,
    private readonly commandProvider: DshCommandProvider = async () => null,
    private readonly spawn: typeof spawnProcess = spawnProcess,
    private readonly discovery: DshProcessDiscoveryAdapter =
      createDefaultDshProcessDiscoveryAdapter(),
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
    const generation = this.startGeneration;
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) return null;
    const probe = await this.probe(normalized, timeoutMs);
    if (generation !== this.startGeneration) return null;
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
    const generation = this.startGeneration;
    const existing = await this.findBestExistingDsh([]);
    if (generation !== this.startGeneration) return null;
    if (existing) {
      return this.rememberEndpoint(existing.url, existing.port);
    }
    this.clearUnmanagedEndpoint();
    return null;
  }

  async ensureStarted(timeoutMs = 120_000): Promise<string> {
    if (this.disposed) throw new Error("dsh process manager is disposed");
    const generation = this.startGeneration;
    if (this.announcedUrl) {
      if (this.isRunning()) return this.announcedUrl;
      const adopted = await this.confirmDshUrl(this.announcedUrl, 2000);
      this.assertStartActive(generation);
      if (adopted) return adopted;
    }
    if (this.starting) return this.starting;
    return this.startManaged(timeoutMs, this.port(), true);
  }

  /** Open policy: prefer an existing DSH, Obsidian children first. */
  async ensureStartedForOpen(
    connectedUrls: readonly string[] = [],
  ): Promise<string> {
    if (this.disposed) throw new Error("dsh process manager is disposed");
    const generation = this.startGeneration;
    const existing = await this.findBestExistingDsh(connectedUrls);
    this.assertStartActive(generation);
    if (existing) {
      return this.rememberEndpoint(existing.url, existing.port);
    }
    if (this.starting) return this.starting;
    return this.startManaged(120_000, this.port(), true);
  }

  /** Restart policy: never reuse an existing DSH; always spawn one. */
  async ensureStartedNew(timeoutMs = 120_000): Promise<string> {
    if (this.disposed) throw new Error("dsh process manager is disposed");
    if (this.starting) return this.starting;
    return this.startManaged(timeoutMs, this.port(), false);
  }

  private startManaged(
    timeoutMs: number,
    preferredPort: number,
    allowAdopt: boolean,
  ): Promise<string> {
    const generation = this.startGeneration;
    const starting = this.startInternal(
      timeoutMs,
      generation,
      preferredPort,
      allowAdopt,
    );
    this.starting = starting;
    return starting.finally(() => {
      if (this.starting === starting) this.starting = null;
    });
  }

  private assertStartActive(generation: number): void {
    if (generation !== this.startGeneration || this.disposed) {
      throw new DshStartCancelledError();
    }
  }

  /**
   * Walk every port from the preferred one up to 65535. Existing DSH
   * instances are adopted only when `allowAdopt` is true; restart passes
   * false so a fresh process is always spawned.
   */
  private async startInternal(
    timeoutMs: number,
    generation: number,
    preferredPort: number,
    allowAdopt: boolean,
  ): Promise<string> {
    this.assertStartActive(generation);
    const firstPort = Math.max(1, Math.min(preferredPort, 65535));
    for (let candidate = firstPort; candidate <= 65535; candidate += 1) {
      this.assertStartActive(generation);
      const url = dshWebUrl(candidate);
      const probe = await this.probe(url, 1500);
      this.assertStartActive(generation);
      if (probe.reachable) {
        if (allowAdopt && probe.isDsh) {
          return this.rememberEndpoint(url, candidate);
        }
        continue;
      }
      try {
        return await this.launch(candidate, timeoutMs, generation);
      } catch (error) {
        if (isDshPortOccupiedError(error)) continue;
        throw error;
      }
    }
    throw new Error(
      `端口 ${firstPort}–65535 均不可用，请在设置中更换端口。`,
    );
  }

  private async launch(
    port: number,
    timeoutMs: number,
    generation: number,
  ): Promise<string> {
    this.assertStartActive(generation);
    const command = await this.commandProvider();
    this.assertStartActive(generation);
    if (!command) {
      throw new Error("DSH 尚未安装，请先在 mv-agent 设置中点击“安装”。");
    }
    return new Promise((resolve, reject) => {
      const args = [...command.argsPrefix, "web", "--port", String(port)];
      const child = this.spawn(command.executable, args, {
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
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      const clearPending = (): void => {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        if (this.cancelPendingLaunch === cancel) this.cancelPendingLaunch = null;
      };
      const resolveLaunch = (url: string): void => {
        if (settled) return;
        settled = true;
        clearPending();
        resolve(url);
      };
      const rejectLaunch = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearPending();
        reject(error);
      };
      const cancel = (): void => rejectLaunch(new DshStartCancelledError());
      this.cancelPendingLaunch = cancel;

      const onData = (chunk: Buffer) => {
        if (generation !== this.startGeneration || this.disposed) return;
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
        if (settled) return;
        if (generation !== this.startGeneration || this.disposed) {
          cancel();
          return;
        }
        if (probe.reachable && probe.isDsh) {
          resolveLaunch(this.rememberEndpoint(target, port));
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          rejectLaunch(
            new Error(
              this.output.trim() ||
                `dsh web 未在 ${timeoutMs / 1000}s 内启动（端口 ${port}）。`,
            ),
          );
          return;
        }
        pollTimer = setTimeout(() => void poll(), 400);
      };

      child.once("error", (error) => {
        const owned = this.child === child;
        if (owned) this.child = null;
        if (owned) this.clearUnmanagedEndpoint();
        if (!settled) {
          rejectLaunch(error);
        }
      });
      child.once("exit", (code) => {
        const owned = this.child === child;
        if (owned) this.child = null;
        if (owned) this.clearUnmanagedEndpoint();
        if (settled) return;
        if (generation !== this.startGeneration || this.disposed) {
          cancel();
          return;
        }
        if (containsEaddrInUse(this.output)) {
          rejectLaunch(new DshPortOccupiedError(port, this.output));
          return;
        }
        const friendly = describeDshBootError(this.output);
        const tail = this.output.trim();
        rejectLaunch(
          new Error(
            friendly ?? `dsh web 提前退出（code ${code ?? "?"}）：${tail || "无输出"}`,
          ),
        );
      });

      void poll();
    });
  }

  private async findBestExistingDsh(
    connectedUrls: readonly string[],
  ): Promise<{ url: string; port: number; isObsidianChild: boolean } | null> {
    interface Candidate {
      url: string;
      port: number;
      isObsidianChild: boolean;
      connected: boolean;
    }
    const candidates = new Map<string, Candidate>();

    const addUrl = (
      rawUrl: string,
      isObsidianChild: boolean,
      connected: boolean,
    ): void => {
      const normalized = normalizeDshWebUrl(rawUrl);
      if (!normalized) return;
      const port = Number(new URL(normalized).port);
      if (!Number.isInteger(port) || port <= 0) return;
      const existing = candidates.get(normalized);
      if (existing) {
        existing.isObsidianChild ||= isObsidianChild;
        existing.connected ||= connected;
        return;
      }
      candidates.set(normalized, { url: normalized, port, isObsidianChild, connected });
    };

    if (this.announcedUrl) addUrl(this.announcedUrl, false, false);
    for (const url of connectedUrls) addUrl(url, false, true);
    for (const candidate of [
      this.port(),
      ...nextPortCandidates(this.port(), 20),
    ]) {
      addUrl(dshWebUrl(candidate), false, false);
    }

    let discovered: Awaited<ReturnType<typeof discoverDshProcesses>> = [];
    try {
      discovered = await discoverDshProcesses(this.discovery);
    } catch {
      discovered = [];
    }
    for (const process of discovered) {
      if (process.port === null) continue;
      addUrl(dshWebUrl(process.port), process.isObsidianChild, false);
    }

    const preferred = this.port();
    const ranked = (
      await Promise.all(
        Array.from(candidates.values()).map(async (candidate) => {
          const probe = await this.probe(candidate.url, 1500);
          return probe.reachable && probe.isDsh ? candidate : null;
        }),
      )
    ).filter((candidate): candidate is Candidate => candidate !== null);
    ranked.sort((left, right) => {
      if (left.isObsidianChild !== right.isObsidianChild) {
        return left.isObsidianChild ? -1 : 1;
      }
      const leftPreferred = left.port === preferred ? 0 : 1;
      const rightPreferred = right.port === preferred ? 0 : 1;
      if (left.isObsidianChild) {
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
        if (left.connected !== right.connected) return left.connected ? -1 : 1;
      } else {
        if (left.connected !== right.connected) return left.connected ? -1 : 1;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      }
      return left.port - right.port;
    });
    return ranked[0] ?? null;
  }

  private invalidatePendingStart(): void {
    this.startGeneration += 1;
    this.starting = null;
    this.cancelPendingLaunch?.();
    this.cancelPendingLaunch = null;
  }

  async stop(): Promise<void> {
    this.invalidatePendingStart();
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
   * Stop every DSH process in the union of:
   *   1. all DSH processes whose ancestry belongs to Obsidian, and
   *   2. all DSH endpoints currently connected to an active mv-agent tab.
   * The union is deduplicated by PID; unrelated external DSH processes are
   * never touched.
   */
  async stopAllTargetDshInstances(
    connectedUrls: readonly string[] = [],
  ): Promise<DshStopSummary> {
    this.invalidatePendingStart();
    const targets = new Map<number, { pid: number; port: number | null }>();
    const stoppedPids: number[] = [];
    const failedPids: number[] = [];
    const stoppedPorts: number[] = [];

    let discovered: Awaited<ReturnType<typeof discoverDshProcesses>> = [];
    try {
      discovered = await discoverDshProcesses(this.discovery);
    } catch {
      discovered = [];
    }
    const byPort = new Map<number, (typeof discovered)[number]>();
    for (const process of discovered) {
      if (process.port !== null) byPort.set(process.port, process);
      if (process.isObsidianChild) {
        targets.set(process.pid, { pid: process.pid, port: process.port });
      }
    }

    for (const rawUrl of connectedUrls) {
      const normalized = normalizeDshWebUrl(rawUrl);
      if (!normalized) continue;
      const port = Number(new URL(normalized).port);
      if (!Number.isInteger(port) || port <= 0) continue;
      const probe = await this.probe(normalized, 2000);
      if (!probe.reachable || !probe.isDsh) continue;
      const discoveredOnPort = byPort.get(port);
      if (discoveredOnPort) {
        targets.set(discoveredOnPort.pid, {
          pid: discoveredOnPort.pid,
          port: discoveredOnPort.port,
        });
        continue;
      }
      let pid: number | null = null;
      try {
        pid = await this.discovery.listenerPid(port);
      } catch {
        pid = null;
      }
      if (pid !== null) {
        targets.set(pid, { pid, port });
      }
    }

    const child = this.child;
    if (child?.pid && this.isRunning()) {
      targets.set(child.pid, {
        pid: child.pid,
        port: this.launchedPort ?? this.currentPort(),
      });
    }

    for (const target of targets.values()) {
      let killed = false;
      try {
        killed = await this.discovery.killProcessTree(target.pid);
      } catch {
        killed = false;
      }
      if (!killed && child?.pid === target.pid) {
        try {
          child.kill("SIGKILL");
          killed = true;
        } catch {
          killed = false;
        }
      }
      (killed ? stoppedPids : failedPids).push(target.pid);
      if (killed && target.port !== null) stoppedPorts.push(target.port);
    }

    this.child = null;
    this.announcedUrl = null;
    this.launchedPort = null;
    return {
      stoppedPids,
      failedPids,
      stoppedPorts,
      notRunning: targets.size === 0,
    };
  }

  /** Stop the target set, then always spawn one fresh DSH process. */
  async restartForObsidian(
    connectedUrls: readonly string[] = [],
  ): Promise<string> {
    await this.stopAllTargetDshInstances(connectedUrls);
    return this.ensureStartedNew();
  }

  /**
   * Legacy stop entry retained for the existing lifecycle/unit-test surface:
   * managed child first, then the adopted listener on the configured port.
   */
  async stopInstance(): Promise<DshStopResult> {
    if (this.child || this.starting) {
      const running = this.isRunning() || this.starting !== null;
      await this.stop();
      return running ? "managed-stopped" : "not-running";
    }
    this.invalidatePendingStart();
    const endpoint = this.announcedUrl ?? dshWebUrl(this.port());
    const actualPort = (() => {
      try {
        return Number(new URL(endpoint).port) || this.port();
      } catch {
        return this.port();
      }
    })();
    const probe = await this.probe(endpoint, 2000);
    if (!probe.reachable || !probe.isDsh) {
      this.announcedUrl = null;
      this.launchedPort = null;
      return "not-running";
    }
    if (process.platform === "win32") {
      const result = await runProcess(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${actualPort} -State Listen).OwningProcess -Force`,
        ],
        { timeoutMs: 15_000 },
      );
      if (result.code === 0) {
        this.announcedUrl = null;
        this.launchedPort = null;
        return "adopted-stopped";
      }
      return "adopted-stop-failed";
    }
    return "adopted-stop-unsupported";
  }

  /** Stop then relaunch, for the 「重启 mv-agent」 command. */
  async restartInstance(): Promise<void> {
    await this.stopInstance();
    await this.ensureStarted();
  }

  dispose(): void {
    this.disposed = true;
    void this.stop();
  }
}
