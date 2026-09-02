import type { ChildProcess } from "node:child_process";
import {
  createDefaultDshProcessDiscoveryAdapter,
  discoverDshProcesses,
  type DshProcessDiscoveryAdapter,
  type DshProcessInfo,
} from "./process-discovery";
import { runProcess, spawnProcess } from "../../../process-runner";
import {
  classifyDshWebProbe,
  dshWebIdentityUrl,
  dshWebLaunchUrl,
  parseDshWebAnnouncement,
  redactDshWebSecrets,
} from "../../../../mv-dsh-compat/lib/obsidian.js";
import {
  dshRuntimeIdentityKey,
  readMatchingDshRuntimeOwner,
  removeDshRuntimeOwner,
  writeDshRuntimeOwner,
} from "./runtime-owner";
import { resolveDshHomeDirectory } from "../paths";
import {
  DshWebProxy,
  type DshWebProxyDeps,
  type DshWebProxyLike,
} from "./web-proxy";

/** The dsh web SPA root HTML carries this stable marker. */
const DSH_WEB_MARKER = "__DSH_BOOT__";

export const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * Canonical root URL for a dsh web endpoint. Browser iframe URLs always gain
 * a trailing slash, so every producer and consumer must compare this form.
 */
export function normalizeDshWebUrl(raw: string): string | null {
  return dshWebIdentityUrl(raw);
}

/** Preserve an in-memory Alpha launch token while rejecting non-HTTP URLs. */
export function normalizeDshLaunchUrl(raw: string): string | null {
  return dshWebLaunchUrl(raw);
}

export function sameDshWebUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeDshWebUrl(left);
  const normalizedRight = normalizeDshWebUrl(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

/** Extract the URL the dsh web app announced on stdout/stderr. */
export function parseDshWebUrl(output: string): string | null {
  return parseDshWebAnnouncement(output)?.identityUrl ?? null;
}

/** Parse both stable endpoint identity and one-shot Alpha launch authority. */
export function parseDshWebEndpoint(output: string): {
  identityUrl: string;
  launchUrl: string;
  authMode: "none" | "launch-token";
} | null {
  return parseDshWebAnnouncement(output);
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
  cwd?: string;
  /** Absolute DSH data root used by this exact command. */
  homeDirectory?: string;
  /** Fail closed when an existing endpoint has no matching mv-AIDE owner record. */
  requireRuntimeOwner?: boolean;
  origin?: "vault" | "global" | "custom-manual" | "custom-discovered";
  sourceRoot?: string;
}

export type DshCommandProvider = () => Promise<DshCommand | null>;

/**
 * Factory seam for the loopback web proxy. Production uses {@link DshWebProxy};
 * tests substitute a fake to assert lifecycle without sockets.
 */
export type DshWebProxyFactory = (upstream: string, deps: DshWebProxyDeps) => DshWebProxyLike;

function portablePath(value: string): string {
  const portable = value.replace(/\\/gu, "/");
  return process.platform === "win32" ? portable.toLowerCase() : portable;
}

/** Prove that one native process invokes the selected DSH entry. */
export function dshProcessMatchesCommand(
  info: Pick<DshProcessInfo, "command" | "executable">,
  expected: DshCommand,
): boolean {
  const commandLine = portablePath(info.command);
  const identityEntry = expected.argsPrefix.find((argument) => argument.length > 0)
    ?? expected.executable;
  const expectedEntry = portablePath(identityEntry);
  if (commandLine.includes(expectedEntry)) return true;
  const nativeExecutable = info.executable ? portablePath(info.executable) : "";
  return expected.argsPrefix.length === 0
    && nativeExecutable.length > 0
    && nativeExecutable === portablePath(expected.executable);
}

export interface DshWebProbe {
  reachable: boolean;
  isDsh: boolean;
  authenticationRequired?: boolean;
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

export class DshAuthorizationRequiredError extends Error {
  constructor(readonly identityUrl: string) {
    super("DSH Alpha 要求浏览器授权，但当前进程没有可恢复的启动授权 URL。请重新启动该 DSH 实例以获取新的授权 URL。");
    this.name = "DshAuthorizationRequiredError";
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

export interface DshWindowsPackageMutationDrainResult {
  stoppedPids: number[];
  remainingPids: number[];
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
    const classified = classifyDshWebProbe(response.status, text);
    return {
      reachable: classified.reachable,
      isDsh: classified.isDsh,
      authenticationRequired: classified.authenticationRequired,
    };
  } catch {
    return { reachable: false, isDsh: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal subset of Obsidian's `requestUrl` (with `throw: false`) that the
 * probe needs: an eventual response carrying the HTTP status and body text.
 */
export type DshWebRequestUrlFn = (
  request: { url: string; method?: string; throw?: boolean },
) => Promise<{ status: number; text: string }>;

/**
 * Build the Obsidian-side probe over any `requestUrl` implementation. The
 * classifier must see the HTTP status: Alpha's unauthenticated root answers
 * 401 with the auth-required body and no boot marker.
 */
export function createRequestUrlDshProbe(
  requestUrl: DshWebRequestUrlFn,
): (url: string, timeoutMs: number) => Promise<DshWebProbe> {
  return async (url, timeoutMs) => {
    try {
      const response = await Promise.race([
        requestUrl({ url, method: "GET", throw: false }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("probe timeout")), timeoutMs),
        ),
      ]);
      const text = typeof response.text === "string" ? response.text : null;
      const classified = classifyDshWebProbe(response.status, text);
      return {
        reachable: classified.reachable,
        isDsh: classified.isDsh,
        authenticationRequired: classified.authenticationRequired,
      };
    } catch {
      return { reachable: false, isDsh: false };
    }
  };
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
  /** One-shot Alpha authorization URL; memory-only and never persisted. */
  private launchUrl: string | null = null;
  private authorizationRequiredEndpoint: string | null = null;
  private launchedPort: number | null = null;
  private managedCommand: DshCommand | null = null;
  private managedOwnerReady: Promise<Error | null> | null = null;
  private starting: Promise<string> | null = null;
  private startGeneration = 0;
  private cancelPendingLaunch: (() => void) | null = null;
  private disposed = false;
  /** Loopback proxy for the current auth-gated endpoint; null when unneeded. */
  private webProxy: DshWebProxyLike | null = null;
  private webProxyBusy: Promise<void> | null = null;

  constructor(
    private readonly vaultRoot: () => string,
    private readonly port: () => number,
    private readonly probe: DshWebProbeFn = probeDshWeb,
    private readonly commandProvider: DshCommandProvider = async () => null,
    private readonly spawn: typeof spawnProcess = spawnProcess,
    private readonly discovery: DshProcessDiscoveryAdapter =
      createDefaultDshProcessDiscoveryAdapter(),
    private readonly proxyFactory: DshWebProxyFactory =
      (upstream, deps) => new DshWebProxy(upstream, deps),
  ) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  currentUrl(): string | null {
    return this.announcedUrl;
  }

  /**
   * The URL an mv-agent iframe should load: the plugin-owned loopback proxy
   * for auth-gated (Alpha) endpoints, the real endpoint otherwise. Never
   * carries the launch token. Returns null while no endpoint is known.
   */
  async webViewUrl(): Promise<string | null> {
    const proxy = await this.ensureWebProxy();
    if (proxy?.url) return proxy.url;
    return normalizeDshWebUrl(this.announcedUrl ?? "");
  }

  /**
   * Map a frame URL back to the semantic DSH endpoint URL. Proxy-origin URLs
   * map to the fronted endpoint; real endpoint URLs pass through unchanged.
   */
  semanticUrlOf(frameUrl: string): string | null {
    const proxy = this.webProxy;
    const normalized = normalizeDshWebUrl(frameUrl);
    if (normalized && proxy?.url && sameDshWebUrl(normalized, proxy.url)) {
      return normalizeDshWebUrl(proxy.upstream);
    }
    return normalized;
  }

  /**
   * The URL for external browsers: the launch URL when token authority is
   * held (a top-level navigation's 303 lands its cookie normally), else the
   * identity URL. Never the proxy — external browsers have no plugin session.
   */
  externalLaunchUrl(): string | null {
    return this.launchUrl ?? this.announcedUrl;
  }

  authorizationRequiredUrl(): string | null {
    return this.authorizationRequiredEndpoint;
  }

  private navigationUrl(): string | null {
    return this.launchUrl ?? this.announcedUrl;
  }

  private rememberEndpoint(url: string, fallbackPort?: number): string {
    const normalized = normalizeDshWebUrl(url);
    const launch = dshWebLaunchUrl(url);
    if (!normalized) throw new Error(`Invalid dsh web URL: ${url}`);
    const sameEndpoint = this.announcedUrl !== null && sameDshWebUrl(this.announcedUrl, normalized);
    this.announcedUrl = normalized;
    if (launch && launch !== normalized) this.launchUrl = launch;
    else if (!sameEndpoint) {
      this.launchUrl = null;
      this.stopWebProxy();
    }
    if (this.launchUrl && sameDshWebUrl(this.launchUrl, normalized)) {
      this.authorizationRequiredEndpoint = null;
    }
    try {
      const parsedPort = Number(new URL(normalized).port);
      this.launchedPort = parsedPort || fallbackPort || null;
    } catch {
      this.launchedPort = fallbackPort ?? null;
    }
    return this.navigationUrl() ?? normalized;
  }

  private clearUnmanagedEndpoint(): void {
    if (this.isRunning()) return;
    this.announcedUrl = null;
    this.launchUrl = null;
    this.authorizationRequiredEndpoint = null;
    this.launchedPort = null;
    this.stopWebProxy();
  }

  /** Tear down the loopback proxy, if any. Safe to call repeatedly. */
  private stopWebProxy(): void {
    const proxy = this.webProxy;
    this.webProxy = null;
    this.webProxyBusy = null;
    if (proxy) proxy.stop();
  }

  /**
   * Obtain the loopback proxy for the current endpoint when its launch URL
   * carries Alpha token authority. No-auth endpoints (preview) return null
   * and keep direct iframe URLs. Concurrent callers share one setup; token
   * rotation on the same endpoint re-exchanges in place.
   */
  private async ensureWebProxy(): Promise<DshWebProxyLike | null> {
    const identity = normalizeDshWebUrl(this.announcedUrl ?? "");
    const launch = this.launchUrl;
    // No launch authority → the endpoint is not auth-gated → direct URL.
    if (!launch || !identity || launch === identity) {
      this.stopWebProxy();
      return null;
    }
    // Endpoint changed → the old proxy fronts a dead origin; rebuild.
    if (this.webProxy && !sameDshWebUrl(this.webProxy.upstream, identity)) {
      this.stopWebProxy();
    }
    if (this.webProxyBusy) return this.webProxyBusy.then(() => this.webProxy);
    this.webProxyBusy = (async () => {
      const proxy = this.webProxy ?? this.proxyFactory(identity, {
        onUnauthorized: () => {
          // The held cookie stopped authenticating (upstream restarted).
          // Drop it so the next webViewUrl() re-exchanges the live token.
          this.webProxy?.invalidateExchange();
        },
      });
      this.webProxy = proxy;
      try {
        if (!proxy.url) await proxy.start();
        // No-op for an already-redeemed launch URL; re-exchanges after token
        // rotation (upstream restart) or an invalidated session.
        await proxy.ensureExchanged(launch);
      } catch (error) {
        if (this.webProxy === proxy) this.stopWebProxy();
        throw error;
      }
    })().finally(() => {
      this.webProxyBusy = null;
    });
    return this.webProxyBusy.then(() => this.webProxy);
  }

  private async selectedCommand(): Promise<DshCommand | null> {
    const command = await this.commandProvider();
    if (!command) return null;
    const homeDirectory = resolveDshHomeDirectory(command.homeDirectory, command.env);
    return {
      ...command,
      ...(homeDirectory ? { homeDirectory } : {}),
    };
  }

  private async endpointMatchesCommand(url: string, expected: DshCommand | null): Promise<boolean> {
    if (!expected) return true;
    const normalized = normalizeDshWebUrl(url);
    if (!normalized) return false;
    const port = Number(new URL(normalized).port);
    if (!Number.isInteger(port) || port <= 0) return false;
    let pid: number | null = null;
    try {
      pid = await this.discovery.listenerPid(port);
    } catch {
      pid = null;
    }
    if (!pid) return false;

    if (
      this.child?.pid === pid
      && this.managedCommand
      && dshRuntimeIdentityKey(this.managedCommand) === dshRuntimeIdentityKey(expected)
    ) return true;

    let info: DshProcessInfo | null = null;
    try {
      info = await this.discovery.processInfo(pid);
    } catch {
      info = null;
    }
    const owner = await readMatchingDshRuntimeOwner(expected, port);
    if (owner?.pid === pid) return info ? dshProcessMatchesCommand(info, expected) : false;
    if (expected.requireRuntimeOwner) return false;
    return info ? dshProcessMatchesCommand(info, expected) : false;
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
    const [probe, expected] = await Promise.all([
      this.probe(normalized, timeoutMs),
      this.selectedCommand(),
    ]);
    if (generation !== this.startGeneration) return null;
    if (probe.reachable && probe.isDsh && await this.endpointMatchesCommand(normalized, expected)) {
      const suppliedLaunch = normalizeDshLaunchUrl(url);
      const hasLaunchAuthority = suppliedLaunch !== null && suppliedLaunch !== normalized;
      const rememberedAuthority = this.launchUrl !== null && sameDshWebUrl(this.launchUrl, normalized);
      if (probe.authenticationRequired && !hasLaunchAuthority && !rememberedAuthority) {
        this.authorizationRequiredEndpoint = normalized;
        throw new DshAuthorizationRequiredError(normalized);
      }
      this.rememberEndpoint(url);
      return normalized;
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
      if (this.isRunning()) return this.navigationUrl() ?? this.announcedUrl;
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
    let command: DshCommand | null | undefined;
    const resolveCommand = async (): Promise<DshCommand | null> => {
      if (command === undefined) command = await this.selectedCommand();
      this.assertStartActive(generation);
      return command;
    };
    const firstPort = Math.max(1, Math.min(preferredPort, 65535));
    for (let candidate = firstPort; candidate <= 65535; candidate += 1) {
      this.assertStartActive(generation);
      const url = dshWebUrl(candidate);
      const probe = await this.probe(url, 1500);
      this.assertStartActive(generation);
      if (probe.reachable) {
        const expected = allowAdopt && probe.isDsh ? await resolveCommand() : null;
        if (allowAdopt && probe.isDsh && await this.endpointMatchesCommand(url, expected)) {
          if (!probe.authenticationRequired) return this.rememberEndpoint(url, candidate);
          this.authorizationRequiredEndpoint ??= url;
        }
        continue;
      }
      try {
        return await this.launch(candidate, timeoutMs, generation, await resolveCommand());
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
    selectedCommand?: DshCommand | null,
  ): Promise<string> {
    this.assertStartActive(generation);
    const command = selectedCommand === undefined ? await this.selectedCommand() : selectedCommand;
    this.assertStartActive(generation);
    if (!command) {
      if (this.authorizationRequiredEndpoint) {
        throw new DshAuthorizationRequiredError(this.authorizationRequiredEndpoint);
      }
      throw new Error("DSH 尚未安装，请先在 mv-agent 设置中点击“安装”。");
    }
    return new Promise((resolve, reject) => {
      const rawArgs = [...command.argsPrefix, "web", "--no-open", "--port", String(port)];
      let executable = command.executable;
      let args = rawArgs;
      if (process.platform !== "win32") {
        const shell = process.env.SHELL || "/bin/zsh";
        args = ["-l", "-c", 'exec "$@"', "_", executable, ...rawArgs];
        executable = shell;
      }
      const child = this.spawn(executable, args, {
        cwd: command.cwd ?? this.vaultRoot(),
        env: command.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      this.managedCommand = command;
      this.output = "";
      this.announcedUrl = null;
      this.launchUrl = null;
      this.stopWebProxy();
      this.authorizationRequiredEndpoint = null;
      this.launchedPort = port;
      const ownerWrite = child.pid
        ? writeDshRuntimeOwner(command, child.pid, port)
        : command.requireRuntimeOwner
          ? Promise.reject(new Error("DSH runtime ownership requires an explicit home and process PID."))
          : Promise.resolve();
      const ownerReady: Promise<Error | null> = ownerWrite
        .then(() => null, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
      this.managedOwnerReady = ownerReady;

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
          const parsed = parseDshWebEndpoint(this.output);
          if (parsed) this.rememberEndpoint(parsed.launchUrl, port);
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const poll = async () => {
        if (settled) return;
        const target = this.navigationUrl() ?? fallbackUrl;
        // Probing needs endpoint identity only. Never pass Alpha's one-shot
        // launch authority into logging/instrumentation supplied by a probe.
        const probe = await this.probe(normalizeDshWebUrl(target) ?? target, 1500);
        if (settled) return;
        if (generation !== this.startGeneration || this.disposed) {
          cancel();
          return;
        }
        if (probe.reachable && probe.isDsh) {
          const ownerError = await ownerReady;
          if (ownerError) {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore cleanup failure */
            }
            rejectLaunch(ownerError);
            return;
          }
          const url = this.rememberEndpoint(target, port);
          // Alpha token endpoints need the loopback proxy before any iframe
          // can load: exchange the token for a session cookie now, while the
          // launch authority is still fresh. A proxy failure is a boot
          // failure — the child is killed and the start rejected. Settle
          // FIRST so the synchronous exit handler cannot race a second
          // rejection through.
          if (this.launchUrl) {
            try {
              await this.ensureWebProxy();
            } catch (error) {
              settled = true;
              clearPending();
              if (child.pid) {
                try {
                  child.kill("SIGTERM");
                } catch {
                  /* ignore cleanup failure */
                }
              }
              reject(error instanceof Error
                ? error
                : new Error("dsh 授权代理启动失败。"));
              return;
            }
          }
          resolveLaunch(url);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          // A timed-out start must not leave a live child behind: the exit
          // handler owns the owner-record and manager-state cleanup, so kill
          // first and reject.
          if (child.pid) {
            try {
              child.kill("SIGTERM");
            } catch {
              /* ignore cleanup failure */
            }
          }
          rejectLaunch(
            new Error(
              redactDshWebSecrets(this.output.trim()) ||
                `dsh web 未在 ${timeoutMs / 1000}s 内启动（端口 ${port}）。`,
            ),
          );
          return;
        }
        pollTimer = setTimeout(() => void poll(), 400);
      };

      child.once("error", (error) => {
        const owned = this.child === child;
        if (child.pid) {
          void ownerReady.then(() => removeDshRuntimeOwner(command, port, child.pid));
        }
        if (owned) {
          this.child = null;
          this.managedCommand = null;
          this.managedOwnerReady = null;
        }
        if (owned) this.clearUnmanagedEndpoint();
        if (!settled) {
          rejectLaunch(error);
        }
      });
      child.once("exit", (code) => {
        const owned = this.child === child;
        if (child.pid) {
          void ownerReady.then(() => removeDshRuntimeOwner(command, port, child.pid));
        }
        if (owned) {
          this.child = null;
          this.managedCommand = null;
          this.managedOwnerReady = null;
        }
        if (owned) this.clearUnmanagedEndpoint();
        if (settled) return;
        if (generation !== this.startGeneration || this.disposed) {
          cancel();
          return;
        }
        if (containsEaddrInUse(this.output)) {
          rejectLaunch(new DshPortOccupiedError(port, redactDshWebSecrets(this.output)));
          return;
        }
        const friendly = describeDshBootError(this.output);
        const tail = redactDshWebSecrets(this.output.trim());
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
    const expectedCommand = await this.selectedCommand();
    interface Candidate {
      url: string;
      port: number;
      isObsidianChild: boolean;
      connected: boolean;
      authenticationRequired?: boolean;
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
          if (!probe.reachable || !probe.isDsh) return null;
          if (!await this.endpointMatchesCommand(candidate.url, expectedCommand)) return null;
          candidate.authenticationRequired = probe.authenticationRequired === true;
          if (candidate.authenticationRequired && !candidate.connected
              && !(this.launchUrl && sameDshWebUrl(this.launchUrl, candidate.url))) {
            this.authorizationRequiredEndpoint ??= candidate.url;
            return null;
          }
          return candidate;
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
    const managedCommand = this.managedCommand;
    const managedPort = this.launchedPort;
    const ownerReady = this.managedOwnerReady;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.managedCommand = null;
      this.managedOwnerReady = null;
      this.announcedUrl = null;
      this.launchUrl = null;
      this.stopWebProxy();
      this.authorizationRequiredEndpoint = null;
      this.launchedPort = null;
      if (managedCommand && managedPort && child?.pid) {
        await ownerReady;
        await removeDshRuntimeOwner(managedCommand, managedPort, child.pid);
      }
      return;
    }
    let signalled = false;
    try {
      if (process.platform === "win32" && child.pid) {
        const result = await runProcess("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          timeoutMs: 15_000,
        });
        signalled = result.code === 0;
      } else {
        signalled = child.kill("SIGTERM");
      }
    } catch {
      signalled = false;
    }
    if (!signalled) return;
    this.child = null;
    this.managedCommand = null;
    this.managedOwnerReady = null;
    this.announcedUrl = null;
    this.launchUrl = null;
    this.authorizationRequiredEndpoint = null;
    this.launchedPort = null;
    if (managedCommand && managedPort && child.pid) {
      await ownerReady;
      await removeDshRuntimeOwner(managedCommand, managedPort, child.pid);
    }
  }

  /**
   * Windows package-mutation barrier: stop every machine-visible DSH runtime,
   * not only the instances owned or adopted by mv-AIDE. Re-enumerate until the
   * machine is clear so multiple instances and short-lived respawns are also
   * drained before npm mutates the installed package.
   */
  async stopAllDshForWindowsPackageMutation(options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    pollMs?: number;
  } = {}): Promise<DshWindowsPackageMutationDrainResult> {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32") return { stoppedPids: [], remainingPids: [] };

    this.invalidatePendingStart();
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollMs = options.pollMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    const stopped = new Set<number>();
    const enumerate = (): Promise<DshProcessInfo[]> =>
      this.discovery.listDshProcessesStrict
        ? this.discovery.listDshProcessesStrict()
        : this.discovery.listDshProcesses();

    while (true) {
      const discovered = await enumerate();
      const targets = new Map<number, DshProcessInfo>();
      for (const process of discovered) targets.set(process.pid, process);

      const managedChild = this.child;
      if (managedChild?.pid && managedChild.exitCode === null && !managedChild.killed) {
        targets.set(managedChild.pid, {
          pid: managedChild.pid,
          ppid: 0,
          port: this.launchedPort,
          command: "<mv-aide-managed-dsh>",
        });
      }

      if (targets.size === 0) {
        this.child = null;
        this.managedCommand = null;
        this.managedOwnerReady = null;
        this.announcedUrl = null;
        this.launchUrl = null;
        this.stopWebProxy();
        this.authorizationRequiredEndpoint = null;
        this.launchedPort = null;
        return { stoppedPids: [...stopped].sort((a, b) => a - b), remainingPids: [] };
      }

      for (const target of targets.values()) {
        let killed = false;
        try {
          killed = await this.discovery.killProcessTree(target.pid);
        } catch {
          killed = false;
        }
        if (!killed && managedChild?.pid === target.pid) {
          try {
            killed = managedChild.kill("SIGKILL");
          } catch {
            killed = false;
          }
        }
        if (killed) stopped.add(target.pid);
        if (managedChild?.pid === target.pid && killed) {
          if (this.managedCommand && this.launchedPort) {
            await this.managedOwnerReady;
            await removeDshRuntimeOwner(this.managedCommand, this.launchedPort, target.pid);
          }
          this.child = null;
          this.managedCommand = null;
          this.managedOwnerReady = null;
        }
      }
      this.announcedUrl = null;
      this.launchUrl = null;
      this.stopWebProxy();
      this.authorizationRequiredEndpoint = null;
      this.launchedPort = null;

      if (Date.now() >= deadline) {
        const remaining = await enumerate();
        const remainingPids = new Set(remaining.map((process) => process.pid));
        const liveChild = this.child;
        if (liveChild?.pid && liveChild.exitCode === null && !liveChild.killed) {
          remainingPids.add(liveChild.pid);
        }
        return {
          stoppedPids: [...stopped].sort((a, b) => a - b),
          remainingPids: [...remainingPids].sort((a, b) => a - b),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Stop only processes proven to implement this Vault's selected runtime. */
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
    const expected = await this.selectedCommand();
    const candidateUrls = new Set<string>();
    if (this.announcedUrl) candidateUrls.add(this.announcedUrl);
    for (const rawUrl of connectedUrls) {
      const normalized = normalizeDshWebUrl(rawUrl);
      if (normalized) candidateUrls.add(normalized);
    }
    if (expected) {
      for (const process of discovered) {
        if (process.port !== null) candidateUrls.add(dshWebUrl(process.port));
      }
    }

    for (const normalized of candidateUrls) {
      const port = Number(new URL(normalized).port);
      if (!Number.isInteger(port) || port <= 0) continue;
      if (expected) {
        if (!await this.endpointMatchesCommand(normalized, expected)) continue;
      } else {
        const probe = await this.probe(normalized, 2000);
        if (!probe.reachable || !probe.isDsh) continue;
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
    const managedCommand = this.managedCommand;
    const managedPort = this.launchedPort;
    const managedOwnerReady = this.managedOwnerReady;
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
      if (killed && target.port !== null) {
        stoppedPorts.push(target.port);
        if (expected) await removeDshRuntimeOwner(expected, target.port, target.pid);
      }
    }

    const managedPid = child?.pid;
    const managedStopped = child === null
      || managedPid === undefined
      || child.exitCode !== null
      || stoppedPids.includes(managedPid);
    if (managedStopped) {
      if (managedCommand && managedPort && managedPid) {
        await managedOwnerReady;
        await removeDshRuntimeOwner(managedCommand, managedPort, managedPid);
      }
      this.child = null;
      this.managedCommand = null;
      this.managedOwnerReady = null;
      this.announcedUrl = null;
      this.launchUrl = null;
      this.stopWebProxy();
      this.authorizationRequiredEndpoint = null;
      this.launchedPort = null;
    }
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
    const stopped = await this.stopAllTargetDshInstances(connectedUrls);
    if (stopped.failedPids.length > 0) {
      throw new Error(`DSH 进程无法停止，已取消重启。PID：${stopped.failedPids.join(", ")}`);
    }
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
    const [probe, expected] = await Promise.all([
      this.probe(endpoint, 2000),
      this.selectedCommand(),
    ]);
    if (!probe.reachable || !probe.isDsh || !await this.endpointMatchesCommand(endpoint, expected)) {
      this.announcedUrl = null;
      this.launchUrl = null;
      this.stopWebProxy();
      this.authorizationRequiredEndpoint = null;
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
        if (expected) await removeDshRuntimeOwner(expected, actualPort);
        this.announcedUrl = null;
        this.launchUrl = null;
        this.stopWebProxy();
        this.authorizationRequiredEndpoint = null;
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
    this.stopWebProxy();
    void this.stop();
  }
}
