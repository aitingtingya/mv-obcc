import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { PORT_BASE, PORT_SPAN, SERVER_HOST } from "../constants";
import { isPathInside, stablePortSeed } from "../path-utils";
import type { IdeContextSnapshot } from "./context-snapshot";
import type {
  BridgeClientContext,
  BridgeSettings,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";

type ClientIdentityResolver = (
  remotePort: number,
  serverPort: number,
  vaultRoot: string,
) => Promise<{ processId: number; sessionId: string } | null>;

export interface BridgeServerOptions {
  authToken: string;
  mcpAuthToken: string;
  ideAuthorizationHeader?: string;
  vaultRoot: string;
  settings: () => BridgeSettings;
  externalFileOpenerToken?: () => string;
  onExternalFileOpen?: (
    request: { path: string; makeFrontmost: boolean },
    context: BridgeClientContext,
  ) => Promise<unknown>;
  onMessage: (
    request: JsonRpcRequest,
    context: BridgeClientContext,
  ) => Promise<JsonRpcResponse | null>;
  onMcpMessage: (
    request: JsonRpcRequest,
    context: BridgeClientContext,
  ) => Promise<JsonRpcResponse | null>;
  onIdeContextSnapshot?: (
    workspaceRoot: string,
  ) => Promise<IdeContextSnapshot | null>;
  onClientContextChanged?: (context: BridgeClientContext) => void;
  resolveClientIdentity?: ClientIdentityResolver;
  onLog?: (message: string) => void;
}

function toolResultValue(response: JsonRpcResponse | null): unknown {
  if (!response?.result || typeof response.result !== "object") return undefined;
  const result = response.result as {
    content?: Array<{ type?: unknown; text?: unknown }>;
    isError?: unknown;
  };
  if (result.isError === true) return undefined;
  const text = result.content?.find(
    (item) => item?.type === "text" && typeof item.text === "string",
  )?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class BridgeServer {
  private server: http.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private clients = new Map<WebSocket, BridgeClientContext>();
  private mcpSessions = new Map<string, BridgeClientContext>();
  private readonly identityBySocket = new WeakMap<
    net.Socket,
    Promise<Pick<BridgeClientContext, "processId" | "sessionId">>
  >();
  private heartbeat: NodeJS.Timeout | null = null;
  port = 0;

  constructor(private readonly options: BridgeServerOptions) {}

  async start(): Promise<number> {
    this.server = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.websocketServer.on("connection", (socket, request) =>
      this.handleConnection(socket, request),
    );
    this.server.on("upgrade", (request, socket, head) => {
      const authorizationHeader =
        this.options.ideAuthorizationHeader ?? "x-mv-aide-ide-authorization";
      const authorization = request.headers[authorizationHeader];
      if (authorization !== this.options.authToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.websocketServer?.handleUpgrade(request, socket, head, (client) => {
        this.websocketServer?.emit("connection", client, request);
      });
    });

    const preferred = PORT_BASE + (stablePortSeed(this.options.vaultRoot) % PORT_SPAN);
    this.port = await this.listenAvailable(preferred);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.keys()) {
        if (client.readyState === client.OPEN) client.ping();
      }
    }, 30_000);
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
    this.websocketServer?.close();
    this.websocketServer = null;
    this.mcpSessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const client of this.clients.keys()) {
      if (client.readyState === client.OPEN) client.send(serialized);
    }
  }

  ideClients(): BridgeClientContext[] {
    return [...this.clients.values()].map((context) => ({ ...context }));
  }

  sendToClient(clientId: string, message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const [client, context] of this.clients) {
      if (context.clientId === clientId && client.readyState === client.OPEN) {
        client.send(serialized);
        return;
      }
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const context: BridgeClientContext = {
      clientId: randomUUID(),
      channel: "ide",
    };
    this.clients.set(socket, context);
    this.options.onClientContextChanged?.({ ...context });
    const remotePort = request.socket.remotePort;
    if (remotePort) {
      void this.resolveContextIdentity(context, request.socket, remotePort).then(() => {
        this.options.onClientContextChanged?.({ ...context });
      });
    }
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      void this.processMessage(socket, data.toString());
    });
  }

  private async processMessage(socket: WebSocket, raw: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }
    if (request.id === undefined || request.id === null) return;
    try {
      const context = this.clients.get(socket);
      if (!context) return;
      const response = await this.options.onMessage(request, { ...context });
      if (response) socket.send(JSON.stringify(response));
    } catch (error) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        }),
      );
    }
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = (request.url ?? "").split("?")[0];
    if (pathname === "/health" || pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, port: this.port }));
      return;
    }
    if (pathname === "/mcp") {
      await this.handleMcpHttp(request, response);
      return;
    }
    if (pathname === "/external-file/open") {
      await this.handleExternalFileOpenHttp(request, response);
      return;
    }
    if (pathname === "/internal/ide-context") {
      await this.handleIdeContextHttp(request, response);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found." }));
  }

  private async handleIdeContextHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, {
        allow: "POST",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.options.authToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 64 * 1024) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      chunks.push(buffer);
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Parse error" }));
      return;
    }
    const workspaceRoot =
      body && typeof body === "object" && "workspaceRoot" in body
        ? (body as { workspaceRoot?: unknown }).workspaceRoot
        : undefined;
    if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Missing workspaceRoot." }));
      return;
    }

    try {
      const snapshot = await this.resolveIdeContextSnapshot(workspaceRoot);
      if (!snapshot) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Workspace not found." }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(snapshot));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Internal error",
        }),
      );
    }
  }

  private async resolveIdeContextSnapshot(
    workspaceRoot: string,
  ): Promise<IdeContextSnapshot | null> {
    if (!isPathInside(workspaceRoot, this.options.vaultRoot)) return null;

    if (this.options.onIdeContextSnapshot) {
      return await this.options.onIdeContextSnapshot(workspaceRoot);
    }

    const context: BridgeClientContext = {
      clientId: "mv-aide-internal-ide-context",
      channel: "ide",
    };
    const [selectionResponse, editorsResponse] = await Promise.all([
      this.options.onMessage(
        {
          jsonrpc: "2.0",
          id: "internal-selection",
          method: "tools/call",
          params: { name: "getLatestSelection", arguments: {} },
        },
        context,
      ),
      this.options.onMessage(
        {
          jsonrpc: "2.0",
          id: "internal-editors",
          method: "tools/call",
          params: { name: "getOpenEditors", arguments: {} },
        },
        context,
      ),
    ]);

    const selection = toolResultValue(selectionResponse);
    const openEditors = toolResultValue(editorsResponse);
    if (!Array.isArray(openEditors)) return null;
    return {
      vaultRoot: this.options.vaultRoot,
      current:
        selection && typeof selection === "object" && !Array.isArray(selection)
          ? (selection as IdeContextSnapshot["current"])
          : null,
      openEditors: openEditors as IdeContextSnapshot["openEditors"],
    };
  }

  private async handleExternalFileOpenHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.options.onExternalFileOpen || !this.options.externalFileOpenerToken) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "External file opener is disabled." }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, {
        allow: "POST",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    if (
      request.headers.authorization !==
      `Bearer ${this.options.externalFileOpenerToken()}`
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 64 * 1024) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      chunks.push(buffer);
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Parse error" }));
      return;
    }
    const pathValue =
      body && typeof body === "object" && "path" in body
        ? (body as { path?: unknown }).path
        : undefined;
    if (typeof pathValue !== "string" || pathValue.trim() === "") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Missing path." }));
      return;
    }
    const makeFrontmost =
      body && typeof body === "object" && "makeFrontmost" in body
        ? (body as { makeFrontmost?: unknown }).makeFrontmost !== false
        : true;

    try {
      const result = await this.options.onExternalFileOpen(
        { path: pathValue, makeFrontmost },
        { clientId: randomUUID(), channel: "ide" },
      );
      const failed =
        result !== null &&
        typeof result === "object" &&
        "success" in result &&
        (result as { success?: unknown }).success === false;
      response.writeHead(failed ? 422 : 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Internal error",
        }),
      );
    }
  }

  private async handleMcpHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.options.settings().mcpEnabled) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "MCP tools are disabled." }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${this.options.mcpAuthToken}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        allow: "POST, DELETE, OPTIONS",
        "access-control-allow-headers":
          "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
        "access-control-allow-methods": "POST, DELETE, OPTIONS",
      });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId === "string") this.mcpSessions.delete(sessionId);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, {
        allow: "POST, DELETE, OPTIONS",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 2 * 1024 * 1024) {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Request too large" }));
        return;
      }
      chunks.push(buffer);
    }

    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }

    if (rpcRequest.id === undefined || rpcRequest.id === null) {
      response.writeHead(202);
      response.end();
      return;
    }

    try {
      const suppliedSessionId = request.headers["mcp-session-id"];
      let context =
        typeof suppliedSessionId === "string"
          ? this.mcpSessions.get(suppliedSessionId)
          : undefined;
      if (!context) {
        context = {
          clientId: randomUUID(),
          channel: "mcp",
        };
        const remotePort = request.socket.remotePort;
        if (remotePort) {
          await this.resolveContextIdentity(context, request.socket, remotePort);
        }
      }
      const rpcResponse = await this.options.onMcpMessage(rpcRequest, {
        ...context,
      });
      if (!rpcResponse) {
        response.writeHead(202);
        response.end();
        return;
      }
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (rpcRequest.method === "initialize") {
        const sessionId = randomUUID();
        this.mcpSessions.set(sessionId, context);
        headers["mcp-session-id"] = sessionId;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify(rpcResponse));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcRequest.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        }),
      );
    }
  }

  private async resolveContextIdentity(
    context: BridgeClientContext,
    socket: net.Socket,
    remotePort: number,
  ): Promise<void> {
    let pending = this.identityBySocket.get(socket);
    if (!pending) {
      const resolver = this.options.resolveClientIdentity;
      pending = (resolver
        ? resolver(remotePort, this.port, this.options.vaultRoot)
        : Promise.resolve(null))
        .then((identity) =>
          identity
            ? {
                processId: identity.processId,
                sessionId: identity.sessionId,
              }
            : {},
        )
        .catch(() => ({}));
      this.identityBySocket.set(socket, pending);
    }
    Object.assign(context, await pending);
  }

  private async listenAvailable(preferred: number): Promise<number> {
    if (!this.server) throw new Error("Server is not initialized.");
    for (let offset = 0; offset < PORT_SPAN; offset += 1) {
      const candidate = PORT_BASE + ((preferred - PORT_BASE + offset) % PORT_SPAN);
      if (await isPortAvailable(candidate)) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            this.server?.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            this.server?.off("error", onError);
            resolve();
          };
          this.server?.once("error", onError);
          this.server?.once("listening", onListening);
          this.server?.listen(candidate, SERVER_HOST);
        });
        return candidate;
      }
    }
    throw new Error("No local port is available for MV AIDE IDE.");
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => tester.close(() => resolve(true)));
    tester.listen(port, SERVER_HOST);
  });
}
