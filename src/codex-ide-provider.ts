import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenEditorTab, SelectionState } from "./types";

export interface CodexIdeContextSnapshot {
  vaultRoot: string;
  current: SelectionState | null;
  openEditors: OpenEditorTab[];
}

interface CodexIdeProviderOptions {
  getSnapshot: () => Promise<CodexIdeContextSnapshot>;
  socketPath?: string;
  clientId?: string;
  onLog?: (message: string) => void;
}

interface PendingFrame {
  buffer: Buffer;
}

const CODEX_TUI_CLIENT_ID = "codex-tui";
const DEFAULT_CLIENT_ID = "mv-senceai-obsidian";
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export function defaultCodexIdeSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\codex-ipc";
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), "codex-ipc", `ipc-${uid}.sock`);
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

function isPathInside(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  const relative = path.relative(resolvedParent, resolvedChild);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function selectionRange(state: SelectionState) {
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

function descriptorFromSelection(state: SelectionState) {
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

function descriptorFromTab(tab: OpenEditorTab) {
  return {
    label: tab.label || tab.relativePath || tab.url || tab.uri,
    path: tab.relativePath || tab.url || tab.uri,
    fsPath: tab.filePath,
  };
}

function buildIdeContext(snapshot: CodexIdeContextSnapshot) {
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
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 150);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function prepareUnixSocket(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort: Codex validates ownership and write bits before connecting.
  }

  if (!fs.existsSync(socketPath)) return;
  if (await activeUnixSocketExists(socketPath)) {
    throw new Error(`Codex IDE socket is already in use: ${socketPath}`);
  }
  fs.unlinkSync(socketPath);
}

export class CodexIdeProvider {
  private server: net.Server | null = null;
  private socketPath = "";

  constructor(private readonly options: CodexIdeProviderOptions) {}

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const socketPath = this.options.socketPath ?? defaultCodexIdeSocketPath();
    if (process.platform !== "win32") {
      await prepareUnixSocket(socketPath);
    }

    const server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    this.server = server;
    this.socketPath = socketPath;
    this.options.onLog?.(`Codex IDE provider listening on ${socketPath}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = null;
    this.socketPath = "";
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    if (socketPath && process.platform !== "win32") {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Already removed or owned by another process.
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
    const snapshot = await this.options.getSnapshot();
    if (!workspaceRoot || !isPathInside(workspaceRoot, snapshot.vaultRoot)) {
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
    const sourceClientId =
      asRecord(message).type === "request" ? CODEX_TUI_CLIENT_ID : undefined;
    socket.write(
      encodeCodexIdeFrame(
        sourceClientId ? { ...(message as Record<string, unknown>), sourceClientId } : message,
      ),
    );
  }
}
