import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { resolveClaudeClientIdentity } from "./claude-client-identity";
import { PORT_BASE, PORT_SPAN, SERVER_HOST } from "./constants";
import { moveMessageSystemBlocks } from "./message-transform";
import { stablePortSeed } from "./path-utils";
import type {
  BridgeClientContext,
  BridgeSettings,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types";

interface BridgeServerOptions {
  authToken: string;
  mcpAuthToken: string;
  vaultRoot: string;
  settings: () => BridgeSettings;
  upstreamBaseUrl: () => string;
  onMessage: (
    request: JsonRpcRequest,
    context: BridgeClientContext,
  ) => Promise<JsonRpcResponse | null>;
  onMcpMessage: (
    request: JsonRpcRequest,
    context: BridgeClientContext,
  ) => Promise<JsonRpcResponse | null>;
  onClientContextChanged?: (context: BridgeClientContext) => void;
  resolveClientIdentity?: typeof resolveClaudeClientIdentity;
  onLog?: (message: string) => void;
}

const HOP_BY_HOP = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function copyRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      output[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return output;
}

function copyResponseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      !HOP_BY_HOP.has(lower) &&
      lower !== "content-encoding" &&
      lower !== "content-length"
    ) {
      output[name] = value;
    }
  });
  return output;
}

export class BridgeServer {
  private server: http.Server | null = null;
  private websocketServer: WebSocketServer | null = null;
  private clients = new Map<WebSocket, BridgeClientContext>();
  private mcpSessions = new Map<string, BridgeClientContext>();
  private readonly identityByRemotePort = new Map<
    number,
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
      const authorization = request.headers["x-claude-code-ide-authorization"];
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
    this.identityByRemotePort.clear();
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
      void this.resolveContextIdentity(context, remotePort).then(() => {
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

    const settings = this.options.settings();
    const upstreamBaseUrl = this.options.upstreamBaseUrl().trim();
    if (settings.upstreamMode !== "compatibility" || !upstreamBaseUrl) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Compatibility proxy is disabled." }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks);
    if (
      body.length > 0 &&
      request.headers["content-type"]?.includes("application/json")
    ) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        body = Buffer.from(JSON.stringify(moveMessageSystemBlocks(parsed)));
      } catch {
        // Forward malformed or non-JSON content unchanged.
      }
    }

    try {
      const target = new URL(
        `${upstreamBaseUrl.replace(/\/$/, "")}${
          (request.url ?? "/").startsWith("/") ? request.url : `/${request.url}`
        }`,
      );
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: copyRequestHeaders(request.headers),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
        redirect: "manual",
      });
      response.writeHead(upstreamResponse.status, copyResponseHeaders(upstreamResponse.headers));
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(Buffer.from(value));
        }
      }
      response.end();
    } catch (error) {
      this.options.onLog?.(
        `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
      );
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "mv_obcc_proxy_error",
            message: "MV OBCC IDE compatibility proxy failed.",
          },
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
        if (remotePort) await this.resolveContextIdentity(context, remotePort);
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
    remotePort: number,
  ): Promise<void> {
    let pending = this.identityByRemotePort.get(remotePort);
    if (!pending) {
      const resolver =
        this.options.resolveClientIdentity ?? resolveClaudeClientIdentity;
      pending = resolver(remotePort, this.port, this.options.vaultRoot)
        .then((identity) =>
          identity
            ? {
                processId: identity.processId,
                sessionId: identity.sessionId,
              }
            : {},
        )
        .catch(() => ({}));
      this.identityByRemotePort.set(remotePort, pending);
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
    throw new Error("No local port is available for MV OBCC IDE.");
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
