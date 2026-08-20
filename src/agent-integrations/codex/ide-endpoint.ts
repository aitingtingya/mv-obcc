import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { IdeContextSnapshot } from "../../ide/context-snapshot";
import { isPathInside } from "../../path-utils";
import { codexIdeEndpoint } from "./paths";
import { CodexWorkspaceRouter } from "./workspace-router";

interface CodexIdeEndpointOptions {
  resolveSnapshot: (workspaceRoot: string) => Promise<IdeContextSnapshot | null>;
  socketPath?: string;
  clientId?: string;
  onLog?: (message: string) => void;
}

interface PendingFrame {
  buffer: Buffer;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

const DEFAULT_CLIENT_ID = "mv-aide-obsidian";
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export class CodexEndpointInUseError extends Error {
  readonly code = "EADDRINUSE";

  constructor(endpoint: string) {
    super(`Codex IDE endpoint is already in use: ${endpoint}`);
    this.name = "CodexEndpointInUseError";
  }
}

export class UnsafeCodexEndpointError extends Error {
  readonly code = "EUNSAFEENDPOINT";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeCodexEndpointError";
  }
}

export function encodeCodexIdeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeCodexIdeFrames(state: PendingFrame): unknown[] {
  const messages: unknown[] = [];
  while (state.buffer.length >= 4) {
    const length = state.buffer.readUInt32LE(0);
    if (length > MAX_FRAME_BYTES) {
      throw new Error("Codex IDE context frame is too large.");
    }
    if (state.buffer.length < 4 + length) break;
    const payload = state.buffer.subarray(4, 4 + length);
    messages.push(JSON.parse(payload.toString("utf8")));
    state.buffer = state.buffer.subarray(4 + length);
  }
  return messages;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function selectionRange(state: NonNullable<IdeContextSnapshot["current"]>) {
  return {
    start: {
      line: state.selection.start.line,
      character: state.selection.start.character,
    },
    end: {
      line: state.selection.end.line,
      character: state.selection.end.character,
    },
  };
}

function descriptorFromSelection(state: NonNullable<IdeContextSnapshot["current"]>) {
  return {
    label: state.title || path.basename(state.relativePath || state.filePath),
    path: state.relativePath || state.url || state.filePath,
    fsPath:
      state.resourceType === "markdown" ||
      state.resourceType === "pdf" ||
      state.resourceType === "file"
        ? state.filePath
        : undefined,
  };
}

function descriptorFromTab(tab: IdeContextSnapshot["openEditors"][number]) {
  return {
    label: tab.label || tab.relativePath || tab.url || tab.uri,
    path: tab.relativePath || tab.url || tab.uri,
    fsPath: tab.filePath,
  };
}

function buildIdeContext(snapshot: IdeContextSnapshot) {
  return {
    activeFile: snapshot.current
      ? {
          ...descriptorFromSelection(snapshot.current),
          selection: selectionRange(snapshot.current),
          activeSelectionContent: snapshot.current.selection.text,
          selections: [selectionRange(snapshot.current)],
        }
      : null,
    openTabs: snapshot.openEditors.map(descriptorFromTab),
  };
}

async function activeUnixSocketExists(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ownedByCurrentUser(stat: fs.Stats): boolean {
  const uid = currentUid();
  return uid === null || stat.uid === uid;
}

async function prepareUnixEndpoint(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UnsafeCodexEndpointError(
        `Codex IPC path is not a safe directory: ${directory}`,
      );
    }
    if (!ownedByCurrentUser(stat)) {
      throw new UnsafeCodexEndpointError(
        `Codex IPC directory is owned by another user: ${directory}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }

  if (!fs.existsSync(socketPath)) return;
  if (await activeUnixSocketExists(socketPath)) {
    throw new CodexEndpointInUseError(socketPath);
  }

  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) {
    throw new UnsafeCodexEndpointError(
      `Refusing to replace unsafe Codex IDE endpoint: ${socketPath}`,
    );
  }
  fs.unlinkSync(socketPath);
}

function socketIdentity(socketPath: string): SocketIdentity | null {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(left: SocketIdentity | null, right: SocketIdentity | null): boolean {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

export class CodexIdeEndpoint {
  private server: net.Server | null = null;
  private socketPath = "";
  private ownedSocket: SocketIdentity | null = null;

  constructor(private readonly options: CodexIdeEndpointOptions) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = this.options.socketPath ?? codexIdeEndpoint();
    if (process.platform !== "win32") {
      await prepareUnixEndpoint(socketPath);
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.off("error", onError);
          server.off("listening", onListening);
        };
        const onError = (error: NodeJS.ErrnoException) => {
          cleanup();
          reject(
            error.code === "EADDRINUSE"
              ? new CodexEndpointInUseError(socketPath)
              : error,
          );
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
    } catch (error) {
      server.close();
      throw error;
    }

    this.server = server;
    this.socketPath = socketPath;
    this.ownedSocket = process.platform === "win32" ? null : socketIdentity(socketPath);
    this.options.onLog?.(`Codex IDE endpoint listening on ${socketPath}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const socketPath = this.socketPath;
    const ownedSocket = this.ownedSocket;
    this.server = null;
    this.socketPath = "";
    this.ownedSocket = null;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    if (
      socketPath &&
      process.platform !== "win32" &&
      sameIdentity(ownedSocket, socketIdentity(socketPath))
    ) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Already removed or replaced.
      }
    }
  }

  private handleConnection(socket: net.Socket): void {
    const state: PendingFrame = { buffer: Buffer.alloc(0) };
    socket.on("data", (chunk) => {
      try {
        state.buffer = Buffer.concat([state.buffer, Buffer.from(chunk)]);
        for (const message of decodeCodexIdeFrames(state)) {
          void this.handleMessage(socket, message).catch((error) => {
            this.options.onLog?.(`Codex IDE request failed: ${String(error)}`);
            socket.destroy();
          });
        }
      } catch (error) {
        this.options.onLog?.(`Codex IDE frame error: ${String(error)}`);
        socket.destroy();
      }
    });
    socket.on("error", (error) => {
      this.options.onLog?.(`Codex IDE socket error: ${error.message}`);
    });
  }

  private async handleMessage(socket: net.Socket, message: unknown): Promise<void> {
    const request = asRecord(message);
    const type = typeof request.type === "string" ? request.type : "";
    if (type === "client-discovery-request") {
      this.write(socket, {
        type: "client-discovery-response",
        requestId: request.requestId,
        response: { canHandle: true },
      });
      return;
    }
    if (type !== "request") return;

    const requestId = String(request.requestId ?? "");
    const method = String(request.method ?? "");
    if (!requestId) return;
    if (method !== "ide-context") {
      this.writeError(socket, requestId, "no-handler-for-request");
      return;
    }

    const params = asRecord(request.params);
    const workspaceRoot = String(params.workspaceRoot ?? "");
    const snapshot = workspaceRoot
      ? await this.options.resolveSnapshot(workspaceRoot)
      : null;
    if (!snapshot) {
      this.writeError(socket, requestId, "no-client-found", method);
      return;
    }

    this.write(socket, {
      type: "response",
      requestId,
      resultType: "success",
      method,
      handledByClientId: this.options.clientId ?? DEFAULT_CLIENT_ID,
      result: {
        type: "broadcast",
        ideContext: buildIdeContext(snapshot),
      },
    });
  }

  private writeError(
    socket: net.Socket,
    requestId: string,
    error: string,
    method?: string,
  ): void {
    this.write(socket, {
      type: "response",
      requestId,
      resultType: "error",
      ...(method ? { method } : {}),
      handledByClientId: this.options.clientId ?? DEFAULT_CLIENT_ID,
      error,
    });
  }

  private write(socket: net.Socket, message: unknown): void {
    socket.write(encodeCodexIdeFrame(message));
  }
}

export type CodexIdeContextSnapshot = IdeContextSnapshot;

interface CodexIdeProviderOptions {
  getSnapshot: () => Promise<CodexIdeContextSnapshot>;
  socketPath?: string;
  clientId?: string;
  onLog?: (message: string) => void;
}

export function defaultCodexIdeSocketPath(
  platform: NodeJS.Platform = process.platform,
  _temporaryDirectory?: string,
  _uid?: number,
): string {
  return codexIdeEndpoint(platform);
}

export function codexIdeSocketPathForRuntime(
  _runtimeDirectory: string,
  platform: NodeJS.Platform = process.platform,
  _uid?: number,
): string {
  return codexIdeEndpoint(platform);
}

/** Compatibility provider retained for existing main.ts wiring. */
export class CodexIdeProvider {
  private readonly router = new CodexWorkspaceRouter();
  private readonly endpoint: CodexIdeEndpoint;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: CodexIdeProviderOptions) {
    this.endpoint = new CodexIdeEndpoint({
      socketPath: options.socketPath,
      clientId: options.clientId,
      onLog: options.onLog,
      resolveSnapshot: async (workspaceRoot) => {
        const local = await this.options.getSnapshot();
        if (isPathInside(workspaceRoot, local.vaultRoot)) return local;
        return await this.router.resolveSnapshot(workspaceRoot);
      },
    });
  }

  get isRunning(): boolean {
    return this.endpoint.isRunning;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.endpoint.isRunning) return;
    try {
      await this.endpoint.start();
      this.clearRetry();
    } catch (error) {
      if (error instanceof CodexEndpointInUseError) {
        this.scheduleRetry();
        this.options.onLog?.(error.message);
        return;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetry();
    await this.endpoint.stop();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start().catch((error) => {
        this.options.onLog?.(`Codex IDE standby retry failed: ${String(error)}`);
      });
    }, 2_000);
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
