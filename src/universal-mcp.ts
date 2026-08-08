import { timingSafeEqual, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

export const UNIVERSAL_MCP_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-03-26",
] as const;

export const UNIVERSAL_MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

export const UNIVERSAL_MCP_RESOURCE_URIS = {
  context: "obsidian://mv-aide/workspace/context",
  openEditors: "obsidian://mv-aide/workspace/open-editors",
  latestSelection: "obsidian://mv-aide/workspace/latest-selection",
  latestMention: "obsidian://mv-aide/workspace/latest-mention",
  diagnostics: "obsidian://mv-aide/workspace/diagnostics",
} as const;

export type UniversalMcpProtocolVersion =
  (typeof UNIVERSAL_MCP_PROTOCOL_VERSIONS)[number];
export type UniversalMcpResourceUri =
  (typeof UNIVERSAL_MCP_RESOURCE_URIS)[keyof typeof UNIVERSAL_MCP_RESOURCE_URIS];

export interface UniversalMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface UniversalIdeContextSnapshot {
  current?: unknown;
  openEditors?: unknown[];
}

export interface UniversalIdeToolContext {
  clientId: string;
  channel: "mcp";
  sessionId?: string;
}

export interface UniversalIdeCapabilities {
  getContextSnapshot: () =>
    | UniversalIdeContextSnapshot
    | Promise<UniversalIdeContextSnapshot>;
  listIdeTools: () =>
    | UniversalMcpToolDefinition[]
    | Promise<UniversalMcpToolDefinition[]>;
  callIdeTool: (
    name: string,
    args: Record<string, unknown>,
    context: UniversalIdeToolContext,
  ) => unknown | Promise<unknown>;
}

export interface UniversalMcpRuntimeDescriptor {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  httpUrl: string;
  protocolVersions: UniversalMcpProtocolVersion[];
  startedAt: string;
  auth: {
    type: "bearer";
    token: string;
  };
}

export interface UniversalMcpServerOptions {
  authToken: string;
  capabilities: UniversalIdeCapabilities;
  runtimeDescriptorPath?: string;
  port?: number;
  host?: "127.0.0.1";
  serverName?: string;
  serverVersion?: string;
  maxRequestBytes?: number;
  requestBodyTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export type UniversalBridgeEvent =
  | "selection_changed"
  | "at_mentioned"
  | "diagnostics_changed"
  | "workspace_changed";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcPayload = JsonRpcRequest | Array<JsonRpcRequest | null>;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface LegacySession {
  id: string;
  protocolVersion: "2025-11-25" | "2025-03-26";
  context: UniversalIdeToolContext;
  subscriptions: Set<UniversalMcpResourceUri>;
  streams: Set<ServerResponse>;
}

interface ModernSubscription {
  key: string;
  id: JsonRpcId;
  resources: Set<UniversalMcpResourceUri>;
  response: ServerResponse;
}

interface PendingToolCall {
  key: string;
  name: string;
  requestId: JsonRpcId | undefined;
  tabName?: string;
  displayTabName?: string;
  context: UniversalIdeToolContext;
  cancelRequested: boolean;
  finished: boolean;
  cancellation: Promise<void> | null;
}

type LegacyTaskStatus = "working" | "completed" | "failed" | "cancelled";

type ModernTaskStatus = "working" | "completed" | "failed" | "cancelled";

interface ModernTask {
  taskId: string;
  status: ModernTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  tabName: string;
  displayTabName: string;
  context: UniversalIdeToolContext;
  executionFinished: boolean;
  cancellation: Promise<void> | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface LegacyTask {
  taskId: string;
  ownerSessionId: string;
  status: LegacyTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number;
  pollInterval: number;
  tabName: string;
  displayTabName: string;
  context: UniversalIdeToolContext;
  executionFinished: boolean;
  cancellation: Promise<void> | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  completion: Promise<void>;
  settleCompletion: () => void;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rpcCode = -32600,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const RESOURCE_DEFINITIONS: Array<{
  uri: UniversalMcpResourceUri;
  name: string;
  title: string;
  description: string;
}> = [
  {
    uri: UNIVERSAL_MCP_RESOURCE_URIS.context,
    name: "workspace-context",
    title: "Obsidian workspace context",
    description: "Current IDE context, selection, and open editor state.",
  },
  {
    uri: UNIVERSAL_MCP_RESOURCE_URIS.openEditors,
    name: "open-editors",
    title: "Open Obsidian editors",
    description: "All currently open Obsidian tabs and editor-like views.",
  },
  {
    uri: UNIVERSAL_MCP_RESOURCE_URIS.latestSelection,
    name: "latest-selection",
    title: "Latest Obsidian selection",
    description: "The latest selection observed by the existing IDE bridge.",
  },
  {
    uri: UNIVERSAL_MCP_RESOURCE_URIS.latestMention,
    name: "latest-mention",
    title: "Latest explicit Obsidian mention",
    description: "The latest selection explicitly sent to an agent by the user.",
  },
  {
    uri: UNIVERSAL_MCP_RESOURCE_URIS.diagnostics,
    name: "workspace-diagnostics",
    title: "Workspace lint diagnostics",
    description:
      "Per-file lint error counts pushed by the IDE bridge (errors only; populated only while the 'push lint error counts' setting is enabled).",
  },
];

const RESOURCE_URI_SET = new Set<UniversalMcpResourceUri>(
  RESOURCE_DEFINITIONS.map((resource) => resource.uri),
);
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;
const SSE_KEEPALIVE_MS = 15_000;
const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function responseResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function responseError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, jsonHeaders(headers));
  response.end(JSON.stringify(body));
}

function writeProblem(response: ServerResponse, problem: HttpProblem, id: JsonRpcId): void {
  writeJson(
    response,
    problem.status,
    responseError(id, problem.rpcCode, problem.message, problem.data),
  );
}

function isAuthorized(actual: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  if (!actual?.startsWith(prefix)) return false;
  const actualToken = Buffer.from(actual.slice(prefix.length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actualToken.length === expected.length && timingSafeEqual(actualToken, expected);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function decodeMcpHeader(value: string): string {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -2);
  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function requestedModernVersion(request: JsonRpcRequest): string | undefined {
  const meta = asRecord(request.params?._meta);
  const value = meta["io.modelcontextprotocol/protocolVersion"];
  return typeof value === "string" ? value : undefined;
}

function supportsModernTasks(request: JsonRpcRequest): boolean {
  const meta = asRecord(request.params?._meta);
  const clientCapabilities = asRecord(
    meta["io.modelcontextprotocol/clientCapabilities"],
  );
  const extensions = asRecord(clientCapabilities.extensions);
  const capability = extensions[TASKS_EXTENSION_ID];
  return capability !== null && typeof capability === "object" && !Array.isArray(capability);
}

function modernClientContext(request: JsonRpcRequest): UniversalIdeToolContext {
  const meta = asRecord(request.params?._meta);
  const clientInfo = asRecord(meta["io.modelcontextprotocol/clientInfo"]);
  const name = typeof clientInfo.name === "string" ? clientInfo.name : "unknown";
  const version = typeof clientInfo.version === "string" ? clientInfo.version : "unknown";
  return {
    clientId: `universal-mcp:${name}:${version}`,
    channel: "mcp",
  };
}

function requestName(request: JsonRpcRequest): string | undefined {
  if (request.method === "tools/call") {
    return typeof request.params?.name === "string" ? request.params.name : undefined;
  }
  if (request.method === "resources/read") {
    return typeof request.params?.uri === "string" ? request.params.uri : undefined;
  }
  return undefined;
}

function requireModernHeaders(
  request: JsonRpcRequest,
  headers: IncomingHttpHeaders,
): void {
  const bodyVersion = requestedModernVersion(request);
  const headerVersion = headerValue(headers, "mcp-protocol-version");
  if (!bodyVersion || !headerVersion || bodyVersion !== headerVersion) {
    throw new HttpProblem(
      400,
      "Header mismatch: MCP-Protocol-Version must match request metadata.",
      -32020,
    );
  }
  const meta = asRecord(request.params?._meta);
  const clientCapabilities = meta["io.modelcontextprotocol/clientCapabilities"];
  if (
    clientCapabilities === null ||
    typeof clientCapabilities !== "object" ||
    Array.isArray(clientCapabilities)
  ) {
    throw new HttpProblem(
      400,
      "Missing io.modelcontextprotocol/clientCapabilities request metadata.",
      -32602,
    );
  }
  if (headerValue(headers, "mcp-method") !== request.method) {
    throw new HttpProblem(
      400,
      "Header mismatch: Mcp-Method must match the JSON-RPC method.",
      -32020,
    );
  }
  const expectedName = requestName(request);
  if (expectedName !== undefined) {
    const actualName = headerValue(headers, "mcp-name");
    if (!actualName || decodeMcpHeader(actualName) !== expectedName) {
      throw new HttpProblem(
        400,
        "Header mismatch: Mcp-Name must match the JSON-RPC request.",
        -32020,
      );
    }
  }
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest | null {
  const record = asRecord(value);
  if (
    record.jsonrpc !== "2.0" ||
    typeof record.method !== "string" ||
    (record.params !== undefined &&
      (typeof record.params !== "object" ||
        record.params === null ||
        Array.isArray(record.params)))
  ) {
    return null;
  }
  return record as unknown as JsonRpcRequest;
}

async function readJsonRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<JsonRpcPayload> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new HttpProblem(413, "Request too large.", -32600);
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpProblem(400, "Parse error", -32700);
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new HttpProblem(400, "Invalid Request", -32600);
    }
    return parsed.map((item) => parseJsonRpcRequest(item));
  }
  const rpcRequest = parseJsonRpcRequest(parsed);
  if (!rpcRequest) {
    throw new HttpProblem(400, "Invalid Request", -32600);
  }
  return rpcRequest;
}

async function readJsonRequest(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<JsonRpcPayload> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const problem = new HttpProblem(408, "Request body timeout.", -32600);
      reject(problem);
      request.destroy(problem);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([
      readJsonRequestBody(request, maxBytes),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeSse(response: ServerResponse, message: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function toolCallArguments(params: Record<string, unknown> | undefined): Record<string, unknown> {
  return asRecord(params?.arguments);
}

function isResourceUri(value: unknown): value is UniversalMcpResourceUri {
  return typeof value === "string" && RESOURCE_URI_SET.has(value as UniversalMcpResourceUri);
}

function prepareUniversalDiffArgs(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  tabName: string;
  displayTabName: string;
} {
  const requestedName =
    typeof args.tab_name === "string"
      ? args.tab_name
      : typeof args.tabName === "string"
        ? args.tabName
        : "";
  const oldFilePath =
    typeof args.old_file_path === "string"
      ? args.old_file_path
      : typeof args.oldFilePath === "string"
        ? args.oldFilePath
        : typeof args.new_file_path === "string"
          ? args.new_file_path
          : typeof args.newFilePath === "string"
            ? args.newFilePath
            : "";
  const newFilePath =
    typeof args.new_file_path === "string"
      ? args.new_file_path
      : typeof args.newFilePath === "string"
        ? args.newFilePath
        : oldFilePath;
  const displayTabName =
    requestedName || `Claude: ${path.basename(newFilePath || oldFilePath || "diff")}`;
  const invisibleOwnershipSuffix = randomUUID()
    .replaceAll("-", "")
    .split("")
    .map((digit) =>
      Number.parseInt(digit, 16)
        .toString(2)
        .padStart(4, "0")
        .replaceAll("0", "\u200b")
        .replaceAll("1", "\u200c"),
    )
    .join("");
  const tabName = `${displayTabName}\u2063${invisibleOwnershipSuffix}`;
  return {
    args: { ...args, tab_name: tabName },
    tabName,
    displayTabName,
  };
}

function normalizeDiffResult(
  value: unknown,
  actualTabName: string,
  displayTabName: string,
): unknown {
  const record = asRecord(value);
  const originalContent = record.content;
  if (!Array.isArray(originalContent)) return value;
  const firstText = asRecord(originalContent[0]).text;
  const secondItem = asRecord(originalContent[1]);
  if (
    firstText === "DIFF_REJECTED" &&
    secondItem.text === actualTabName
  ) {
    const content = [...originalContent];
    content[1] = { ...secondItem, text: displayTabName };
    return { ...record, content };
  }
  // ToolRegistry's early view-construction failure serializes the rejection
  // tuple into the only text item. Restrict JSON parsing to that exact shape;
  // accepted file contents are never inspected or rewritten.
  if (originalContent.length === 1 && typeof firstText === "string") {
    try {
      const parsed = JSON.parse(firstText) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed[0] === "DIFF_REJECTED" &&
        parsed[1] === actualTabName
      ) {
        return {
          ...record,
          content: [
            {
              ...asRecord(originalContent[0]),
              text: JSON.stringify(["DIFF_REJECTED", displayTabName]),
            },
          ],
        };
      }
    } catch {
      // Arbitrary tool text is not protocol framing and is returned unchanged.
    }
  }
  return value;
}

export class UniversalMcpServer {
  private server: http.Server | null = null;
  private descriptor: UniversalMcpRuntimeDescriptor | null = null;
  private legacySessions = new Map<string, LegacySession>();
  private modernSubscriptions = new Map<string, ModernSubscription>();
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private legacyTasks = new Map<string, LegacyTask>();
  private modernTasks = new Map<string, ModernTask>();
  private latestSelection: unknown;
  private latestMention: unknown = null;
  private latestDiagnostics: unknown = null;
  private keepalive: NodeJS.Timeout | null = null;

  constructor(private readonly options: UniversalMcpServerOptions) {
    if (!options.authToken.trim()) {
      throw new Error("Universal MCP requires a non-empty bearer token.");
    }
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  get runtimeDescriptor(): UniversalMcpRuntimeDescriptor | null {
    return this.descriptor ? structuredClone(this.descriptor) : null;
  }

  async start(): Promise<UniversalMcpRuntimeDescriptor> {
    if (this.descriptor) return structuredClone(this.descriptor);
    const server = http.createServer((request, response) => {
      void this.handleHttp(request, response).catch((error) => {
        this.options.onLog?.(`Universal MCP HTTP error: ${String(error)}`);
        if (!response.headersSent) {
          writeJson(response, 500, responseError(null, -32603, "Internal error"));
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;

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
      server.listen(this.options.port ?? 0, this.options.host ?? "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Universal MCP did not acquire a TCP port.");
    }
    const descriptor: UniversalMcpRuntimeDescriptor = {
      schemaVersion: 1,
      instanceId: randomUUID(),
      pid: process.pid,
      httpUrl: `http://127.0.0.1:${address.port}/mcp`,
      protocolVersions: [...UNIVERSAL_MCP_PROTOCOL_VERSIONS],
      startedAt: new Date().toISOString(),
      auth: { type: "bearer", token: this.options.authToken },
    };
    this.server = server;
    this.descriptor = descriptor;
    this.keepalive = setInterval(() => this.writeKeepalives(), SSE_KEEPALIVE_MS);
    this.keepalive.unref?.();

    try {
      if (this.options.runtimeDescriptorPath) {
        await this.writeRuntimeDescriptor(this.options.runtimeDescriptorPath, descriptor);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.options.onLog?.(`Universal MCP listening on ${descriptor.httpUrl}`);
    return structuredClone(descriptor);
  }

  async stop(): Promise<void> {
    const descriptor = this.descriptor;
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;

    const ownedPendingDiffs = [...this.pendingToolCalls.values()].filter(
      (pending) => pending.name === "openDiff",
    );
    const ownedDiffTasks = [...this.legacyTasks.values()].filter(
      (task) => task.status === "working" || task.cancellation !== null,
    );
    const ownedModernDiffTasks = [...this.modernTasks.values()].filter(
      (task) => task.status === "working" || task.cancellation !== null,
    );
    await Promise.allSettled([
      ...ownedPendingDiffs.map((pending) => this.cancelPendingCall(pending)),
      ...ownedDiffTasks.map((task) => this.cancelLegacyTask(task)),
      ...ownedModernDiffTasks.map((task) => this.cancelModernTask(task)),
    ]);

    for (const subscription of this.modernSubscriptions.values()) {
      writeSse(
        subscription.response,
        responseResult(subscription.id, this.modernResult({
          _meta: {
            "io.modelcontextprotocol/subscriptionId": subscription.id,
          },
        })),
      );
      subscription.response.end();
    }
    this.modernSubscriptions.clear();
    for (const session of this.legacySessions.values()) {
      for (const stream of session.streams) stream.end();
    }
    this.legacySessions.clear();
    this.pendingToolCalls.clear();
    for (const task of this.legacyTasks.values()) {
      if (task.status === "working") {
        task.status = "cancelled";
        task.lastUpdatedAt = new Date().toISOString();
      }
      task.settleCompletion();
    }
    this.legacyTasks.clear();
    this.modernTasks.clear();

    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    if (descriptor && this.options.runtimeDescriptorPath) {
      await this.removeOwnedRuntimeDescriptor(
        this.options.runtimeDescriptorPath,
        descriptor.instanceId,
      );
    }
  }

  publishBridgeEvent(event: UniversalBridgeEvent, payload?: unknown): void {
    if (event === "selection_changed") {
      this.latestSelection = payload;
      this.publishResourceUpdates([
        UNIVERSAL_MCP_RESOURCE_URIS.context,
        UNIVERSAL_MCP_RESOURCE_URIS.latestSelection,
      ]);
      return;
    }
    if (event === "at_mentioned") {
      this.latestMention = payload ?? null;
      this.publishResourceUpdates([
        UNIVERSAL_MCP_RESOURCE_URIS.context,
        UNIVERSAL_MCP_RESOURCE_URIS.latestMention,
      ]);
      return;
    }
    if (event === "diagnostics_changed") {
      this.latestDiagnostics = payload ?? null;
      this.publishResourceUpdates([UNIVERSAL_MCP_RESOURCE_URIS.diagnostics]);
      return;
    }
    this.publishResourceUpdates([
      UNIVERSAL_MCP_RESOURCE_URIS.context,
      UNIVERSAL_MCP_RESOURCE_URIS.openEditors,
    ]);
  }

  publishResourceUpdates(resources: Iterable<UniversalMcpResourceUri>): void {
    const unique = new Set(resources);
    for (const uri of unique) {
      if (!RESOURCE_URI_SET.has(uri)) continue;
      for (const session of this.legacySessions.values()) {
        if (!session.subscriptions.has(uri)) continue;
        const notification = {
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: { uri },
        };
        const stream = [...session.streams].find(
          (candidate) => !candidate.destroyed && !candidate.writableEnded,
        );
        if (stream) writeSse(stream, notification);
      }
      for (const subscription of this.modernSubscriptions.values()) {
        if (!subscription.resources.has(uri)) continue;
        writeSse(subscription.response, {
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: {
            _meta: {
              "io.modelcontextprotocol/subscriptionId": subscription.id,
            },
            uri,
          },
        });
      }
    }
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const origin = headerValue(request.headers, "origin");
    if (origin && !isLoopbackOrigin(origin)) {
      writeJson(response, 403, responseError(null, -32000, "Forbidden Origin"));
      return;
    }
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }

    if (request.method === "OPTIONS" && pathname === "/mcp") {
      response.writeHead(204, {
        allow: "POST, GET, DELETE, OPTIONS",
        "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
        "access-control-allow-headers": [
          "authorization",
          "content-type",
          "accept",
          "mcp-protocol-version",
          "mcp-session-id",
          "mcp-method",
          "mcp-name",
        ].join(", "),
        ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
      });
      response.end();
      return;
    }

    if (!isAuthorized(headerValue(request.headers, "authorization"), this.options.authToken)) {
      writeJson(response, 401, { error: "Unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    if (pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        instanceId: this.descriptor?.instanceId ?? null,
        pid: process.pid,
      });
      return;
    }
    if (pathname !== "/mcp") {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    if (request.method === "GET") {
      this.openLegacyEventStream(request, response);
      return;
    }
    if (request.method === "DELETE") {
      await this.deleteLegacySession(request, response);
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "Method not allowed" }, { allow: "POST" });
      return;
    }

    const accept = headerValue(request.headers, "accept")?.toLowerCase() ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      writeJson(
        response,
        406,
        responseError(null, -32600, "Accept must include application/json and text/event-stream."),
      );
      return;
    }
    if (!headerValue(request.headers, "content-type")?.toLowerCase().includes("application/json")) {
      writeJson(response, 415, responseError(null, -32600, "Content-Type must be application/json."));
      return;
    }

    let rpcPayload: JsonRpcPayload;
    try {
      rpcPayload = await readJsonRequest(
        request,
        this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
        this.options.requestBodyTimeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS,
      );
    } catch (error) {
      writeProblem(
        response,
        error instanceof HttpProblem
          ? error
          : new HttpProblem(400, "Invalid Request", -32600),
        null,
      );
      return;
    }

    if (Array.isArray(rpcPayload)) {
      if (
        rpcPayload.some(
          (item) => item !== null && requestedModernVersion(item) !== undefined,
        )
      ) {
        writeJson(
          response,
          400,
          responseError(null, -32600, "JSON-RPC batches are not supported by protocol 2026-07-28."),
        );
        return;
      }
      await this.handleLegacyBatch(rpcPayload, request, response);
      return;
    }
    const rpcRequest = rpcPayload;

    const modernVersion = requestedModernVersion(rpcRequest);
    if (modernVersion !== undefined) {
      await this.handleModernRequest(rpcRequest, request, response, modernVersion);
      return;
    }
    if (rpcRequest.method === "initialize") {
      await this.handleLegacyInitialize(rpcRequest, response);
      return;
    }
    await this.handleLegacyRequest(rpcRequest, request, response);
  }

  private async handleLegacyInitialize(
    request: JsonRpcRequest,
    response: ServerResponse,
  ): Promise<void> {
    const requested = request.params?.protocolVersion;
    const protocolVersion =
      requested === "2025-03-26" || requested === "2025-11-25"
        ? requested
        : "2025-11-25";
    const sessionId = randomUUID();
    const session: LegacySession = {
      id: sessionId,
      protocolVersion,
      context: {
        clientId: `universal-mcp:${sessionId}`,
        channel: "mcp",
        sessionId,
      },
      subscriptions: new Set(),
      streams: new Set(),
    };
    this.legacySessions.set(sessionId, session);
    writeJson(
      response,
      200,
      responseResult(request.id ?? null, {
        protocolVersion,
        capabilities: {
          tools: {},
          resources: { subscribe: true, listChanged: false },
          ...(protocolVersion === "2025-11-25"
            ? {
                tasks: {
                  list: {},
                  cancel: {},
                  requests: { tools: { call: {} } },
                },
              }
            : {}),
        },
        serverInfo: this.serverInfo(),
        instructions: "Use IDE tools and resources to interact with the current Obsidian vault.",
      }),
      { "mcp-session-id": sessionId },
    );
  }

  private async handleLegacyRequest(
    request: JsonRpcRequest,
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.requireLegacySession(incoming, response, request.id ?? null);
    if (!session) return;
    if (request.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    if (request.method === "notifications/cancelled") {
      await this.cancelPendingTool(request.params?.requestId, session.context);
      response.writeHead(202);
      response.end();
      return;
    }
    if (request.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    try {
      const result = await this.dispatchRequest(request, session.context, false, session);
      // A valid Streamable HTTP session transports JSON-RPC method errors with HTTP 200.
      // HTTP 404 is reserved for a missing or terminated session.
      writeJson(response, 200, result);
    } catch (error) {
      this.writeRequestFailure(response, request, error);
    }
  }

  private async handleLegacyBatch(
    requests: Array<JsonRpcRequest | null>,
    incoming: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const firstId = requests.find((request) => request?.id !== undefined)?.id ?? null;
    const session = this.requireLegacySession(incoming, response, firstId);
    if (!session) return;
    if (session.protocolVersion !== "2025-03-26") {
      writeJson(
        response,
        400,
        responseError(null, -32600, "JSON-RPC batches are not supported by protocol 2025-11-25."),
      );
      return;
    }
    const responses: JsonRpcResponse[] = [];
    for (const request of requests) {
      if (!request) {
        responses.push(responseError(null, -32600, "Invalid Request"));
        continue;
      }
      if (request.method === "notifications/initialized") continue;
      if (request.method === "notifications/cancelled") {
        await this.cancelPendingTool(request.params?.requestId, session.context);
        continue;
      }
      if (request.id === undefined) continue;
      try {
        responses.push(
          await this.dispatchRequest(
            request,
            session.context,
            false,
            session,
            incoming,
            response,
          ),
        );
      } catch (error) {
        responses.push(this.requestFailureResponse(request, error));
      }
    }
    if (responses.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    writeJson(response, 200, responses);
  }

  private async handleModernRequest(
    request: JsonRpcRequest,
    incoming: IncomingMessage,
    response: ServerResponse,
    version: string,
  ): Promise<void> {
    if (version !== UNIVERSAL_MCP_MODERN_PROTOCOL_VERSION) {
      writeJson(
        response,
        400,
        responseError(request.id ?? null, -32022, "Unsupported protocol version", {
          supported: [...UNIVERSAL_MCP_PROTOCOL_VERSIONS],
          requested: version,
        }),
      );
      return;
    }
    try {
      requireModernHeaders(request, incoming.headers);
    } catch (error) {
      writeProblem(
        response,
        error instanceof HttpProblem
          ? error
          : new HttpProblem(400, "Header mismatch", -32020),
        request.id ?? null,
      );
      return;
    }
    if (request.method === "initialize") {
      writeJson(
        response,
        404,
        responseError(request.id ?? null, -32601, "initialize is not used by protocol 2026-07-28."),
      );
      return;
    }
    if (request.method === "subscriptions/listen") {
      this.openModernSubscription(request, incoming, response);
      return;
    }
    if (request.method === "notifications/cancelled") {
      await this.cancelPendingTool(request.params?.requestId, modernClientContext(request));
      response.writeHead(202);
      response.end();
      return;
    }
    if (request.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    try {
      const result = await this.dispatchRequest(
        request,
        modernClientContext(request),
        true,
        null,
        incoming,
        response,
      );
      writeJson(response, result.error?.code === -32601 ? 404 : 200, result);
    } catch (error) {
      this.writeRequestFailure(response, request, error);
    }
  }

  private async dispatchRequest(
    request: JsonRpcRequest,
    context: UniversalIdeToolContext,
    modern: boolean,
    legacySession: LegacySession | null,
    incoming?: IncomingMessage,
    outgoing?: ServerResponse,
  ): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    switch (request.method) {
      case "server/discover":
        if (!modern) return responseError(id, -32601, "Method not found: server/discover");
        return responseResult(id, this.modernResult({
          supportedVersions: [...UNIVERSAL_MCP_PROTOCOL_VERSIONS],
          capabilities: this.capabilities(true),
          instructions: "Use IDE tools and resources to interact with the current Obsidian vault.",
          ttlMs: 3_600_000,
          cacheScope: "private",
        }));
      case "ping":
        return responseResult(id, modern ? this.modernResult({}) : {});
      case "tools/list": {
        const tools = await Promise.resolve(this.options.capabilities.listIdeTools());
        const exposedTools =
          !modern && legacySession?.protocolVersion === "2025-11-25"
            ? tools.map((tool) =>
                tool.name === "openDiff"
                  ? {
                      ...tool,
                      execution: { taskSupport: "optional" },
                    }
                  : tool,
              )
            : tools;
        return responseResult(
          id,
          modern ? this.modernResult({ tools: exposedTools, ttlMs: 0, cacheScope: "private" }) : { tools: exposedTools },
        );
      }
      case "tools/call": {
        const name = typeof request.params?.name === "string" ? request.params.name : "";
        if (!name) return responseError(id, -32602, "Missing tool name.");
        const tools = await Promise.resolve(this.options.capabilities.listIdeTools());
        if (!tools.some((tool) => tool.name === name)) {
          return responseError(id, -32602, `Tool not found: ${name}`);
        }
        if (modern && name === "openDiff" && supportsModernTasks(request)) {
          const task = this.createModernTask(
            context,
            toolCallArguments(request.params),
          );
          return responseResult(id, this.modernTaskCreateResult(task));
        }
        const requestedTask = request.params?.task;
        if (
          !modern &&
          legacySession?.protocolVersion === "2025-11-25" &&
          requestedTask !== null &&
          typeof requestedTask === "object" &&
          !Array.isArray(requestedTask)
        ) {
          if (name !== "openDiff") {
            return responseError(id, -32601, `Tool does not support tasks: ${name}`);
          }
          const task = this.createLegacyTask(legacySession, toolCallArguments(request.params), requestedTask);
          return responseResult(id, { task: this.legacyTaskView(task) });
        }
        const result = await this.callTool(
          request,
          name,
          toolCallArguments(request.params),
          context,
          incoming,
          outgoing,
        );
        if (result === null || result === undefined) {
          return responseError(id, -32602, `Tool not found: ${name}`);
        }
        const toolResult = asRecord(result);
        return responseResult(
          id,
          modern ? this.modernResult(toolResult) : result,
        );
      }
      case "tasks/get": {
        if (modern) {
          if (!supportsModernTasks(request)) {
            return responseError(id, -32601, "Method not found: tasks/get");
          }
          const task = this.findModernTask(context, request.params?.taskId);
          return task
            ? responseResult(id, this.modernResult(this.modernTaskDetailedView(task)))
            : responseError(id, -32602, "Task not found.");
        }
        if (legacySession?.protocolVersion !== "2025-11-25") {
          return responseError(id, -32601, "Method not found: tasks/get");
        }
        const task = this.findLegacyTask(legacySession, request.params?.taskId);
        return task
          ? responseResult(id, this.legacyTaskView(task))
          : responseError(id, -32602, "Task not found.");
      }
      case "tasks/list": {
        if (modern || legacySession?.protocolVersion !== "2025-11-25") {
          return responseError(id, -32601, "Method not found: tasks/list");
        }
        this.pruneExpiredLegacyTasks();
        const tasks = [...this.legacyTasks.values()]
          .filter((task) => task.ownerSessionId === legacySession.id)
          .map((task) => this.legacyTaskView(task));
        return responseResult(id, { tasks });
      }
      case "tasks/result": {
        if (modern || legacySession?.protocolVersion !== "2025-11-25") {
          return responseError(id, -32601, "Method not found: tasks/result");
        }
        const task = this.findLegacyTask(legacySession, request.params?.taskId);
        if (!task) return responseError(id, -32602, "Task not found.");
        if (task.status === "working") await task.completion;
        if (task.error) return { jsonrpc: "2.0", id, error: task.error };
        return responseResult(id, this.taskResultWithMetadata(task));
      }
      case "tasks/cancel": {
        if (modern) {
          if (!supportsModernTasks(request)) {
            return responseError(id, -32601, "Method not found: tasks/cancel");
          }
          const task = this.findModernTask(context, request.params?.taskId);
          if (!task) return responseError(id, -32602, "Task not found.");
          if (task.status === "working") await this.cancelModernTask(task);
          return responseResult(id, this.modernResult({}));
        }
        if (legacySession?.protocolVersion !== "2025-11-25") {
          return responseError(id, -32601, "Method not found: tasks/cancel");
        }
        const task = this.findLegacyTask(legacySession, request.params?.taskId);
        if (!task || task.status !== "working") {
          return responseError(id, -32602, "Task is not cancellable.");
        }
        await this.cancelLegacyTask(task);
        return responseResult(id, this.legacyTaskView(task));
      }
      case "tasks/update": {
        if (!modern || !supportsModernTasks(request)) {
          return responseError(id, -32601, "Method not found: tasks/update");
        }
        // openDiff never enters input_required, so there are no outstanding
        // input requests. The extension specifies an empty acknowledgement.
        return responseResult(id, this.modernResult({}));
      }
      case "resources/list":
        return responseResult(
          id,
          modern
            ? this.modernResult({
                resources: RESOURCE_DEFINITIONS.map((resource) => ({
                  ...resource,
                  mimeType: "application/json",
                })),
                ttlMs: 0,
                cacheScope: "private",
              })
            : {
                resources: RESOURCE_DEFINITIONS.map((resource) => ({
                  ...resource,
                  mimeType: "application/json",
                })),
              },
        );
      case "resources/templates/list":
        return responseResult(
          id,
          modern
            ? this.modernResult({ resourceTemplates: [], ttlMs: 3_600_000, cacheScope: "public" })
            : { resourceTemplates: [] },
        );
      case "resources/read": {
        const uri = request.params?.uri;
        if (!isResourceUri(uri)) {
          return responseError(id, -32602, "Resource not found", { uri: uri ?? null });
        }
        const value = await this.readResource(uri);
        const contents = [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(value),
          },
        ];
        return responseResult(
          id,
          modern
            ? this.modernResult({ contents, ttlMs: 0, cacheScope: "private" })
            : { contents },
        );
      }
      case "resources/subscribe": {
        if (modern || !legacySession) {
          return responseError(id, -32601, "Method not found: resources/subscribe");
        }
        const uri = request.params?.uri;
        if (!isResourceUri(uri)) {
          return responseError(id, -32602, "Resource not found", { uri: uri ?? null });
        }
        legacySession.subscriptions.add(uri);
        return responseResult(id, {});
      }
      case "resources/unsubscribe": {
        if (modern || !legacySession) {
          return responseError(id, -32601, "Method not found: resources/unsubscribe");
        }
        const uri = request.params?.uri;
        if (!isResourceUri(uri)) {
          return responseError(id, -32602, "Resource not found", { uri: uri ?? null });
        }
        legacySession.subscriptions.delete(uri);
        return responseResult(id, {});
      }
      default:
        return responseError(id, -32601, `Method not found: ${request.method}`);
    }
  }

  private createModernTask(
    context: UniversalIdeToolContext,
    args: Record<string, unknown>,
  ): ModernTask {
    this.pruneExpiredModernTasks();
    const preparedDiff = prepareUniversalDiffArgs(args);
    const now = new Date().toISOString();
    const task: ModernTask = {
      taskId: randomUUID(),
      status: "working",
      statusMessage: "Waiting for the user to accept or reject the Obsidian diff.",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 60 * 60 * 1_000,
      pollIntervalMs: 500,
      tabName: preparedDiff.tabName,
      displayTabName: preparedDiff.displayTabName,
      context,
      executionFinished: false,
      cancellation: null,
    };
    this.modernTasks.set(task.taskId, task);
    void this.executeModernDiffTask(task, preparedDiff.args);
    return task;
  }

  private async executeModernDiffTask(
    task: ModernTask,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const rawResult = await Promise.resolve(
        this.options.capabilities.callIdeTool("openDiff", args, task.context),
      );
      const result = normalizeDiffResult(
        rawResult,
        task.tabName,
        task.displayTabName,
      );
      if (task.status === "working") {
        task.result = result;
        task.status = "completed";
        task.statusMessage = "The user completed the Obsidian diff review.";
      }
    } catch (error) {
      if (task.status === "working") {
        task.status = "failed";
        task.statusMessage = error instanceof Error ? error.message : "Diff task failed.";
        task.error = {
          code: -32603,
          message: task.statusMessage,
          data: {
            _meta: {
              "io.modelcontextprotocol/related-task": { taskId: task.taskId },
            },
          },
        };
      }
    } finally {
      task.executionFinished = true;
      task.lastUpdatedAt = new Date().toISOString();
    }
  }

  private modernTaskBase(task: ModernTask): Record<string, unknown> {
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: task.ttlMs,
      pollIntervalMs: task.pollIntervalMs,
    };
  }

  private modernTaskCreateResult(task: ModernTask): Record<string, unknown> {
    return {
      ...this.modernTaskBase(task),
      resultType: "task",
      _meta: {
        "io.modelcontextprotocol/related-task": { taskId: task.taskId },
        "io.modelcontextprotocol/serverInfo": this.serverInfo(),
      },
    };
  }

  private modernTaskDetailedView(task: ModernTask): Record<string, unknown> {
    const base = this.modernTaskBase(task);
    if (task.status === "completed") {
      return {
        ...base,
        result: this.modernResult(asRecord(task.result)),
      };
    }
    if (task.status === "failed") {
      return {
        ...base,
        error: task.error ?? { code: -32603, message: "Diff task failed." },
      };
    }
    return base;
  }

  private findModernTask(
    context: UniversalIdeToolContext,
    taskIdValue: unknown,
  ): ModernTask | null {
    this.pruneExpiredModernTasks();
    if (typeof taskIdValue !== "string") return null;
    // The per-Vault bearer token is the authorization boundary. clientInfo is
    // self-reported and may legitimately change across a reconnect, while the
    // random task id is designed to remain resumable.
    void context;
    return this.modernTasks.get(taskIdValue) ?? null;
  }

  private async cancelModernTask(task: ModernTask): Promise<void> {
    if (task.cancellation) return task.cancellation;
    if (task.status !== "working") return;
    task.status = "cancelled";
    task.statusMessage = "The diff task was cancelled by the client.";
    task.lastUpdatedAt = new Date().toISOString();
    task.cancellation = this.closeOwnedDiff(
      task.tabName,
      task.context,
      () => !task.executionFinished,
    ).catch((error) => {
      this.options.onLog?.(`Universal MCP task cancellation failed: ${String(error)}`);
    });
    return task.cancellation;
  }

  private pruneExpiredModernTasks(): void {
    const now = Date.now();
    for (const [taskId, task] of this.modernTasks) {
      if (
        task.status !== "working" &&
        task.ttlMs !== null &&
        Date.parse(task.createdAt) + task.ttlMs <= now
      ) {
        this.modernTasks.delete(taskId);
      }
    }
  }

  private createLegacyTask(
    session: LegacySession,
    args: Record<string, unknown>,
    taskRequestValue: object,
  ): LegacyTask {
    this.pruneExpiredLegacyTasks();
    const taskRequest = asRecord(taskRequestValue);
    const requestedTtl = taskRequest.ttl;
    const ttl =
      typeof requestedTtl === "number" &&
      Number.isFinite(requestedTtl) &&
      requestedTtl > 0
        ? Math.min(Math.floor(requestedTtl), 24 * 60 * 60 * 1_000)
        : 60 * 60 * 1_000;
    const now = new Date().toISOString();
    let settleCompletion: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      settleCompletion = resolve;
    });
    const preparedDiff = prepareUniversalDiffArgs(args);
    const task: LegacyTask = {
      taskId: randomUUID(),
      ownerSessionId: session.id,
      status: "working",
      statusMessage: "Waiting for the user to accept or reject the Obsidian diff.",
      createdAt: now,
      lastUpdatedAt: now,
      ttl,
      pollInterval: 500,
      tabName: preparedDiff.tabName,
      displayTabName: preparedDiff.displayTabName,
      context: session.context,
      executionFinished: false,
      cancellation: null,
      completion,
      settleCompletion,
    };
    this.legacyTasks.set(task.taskId, task);
    void this.executeLegacyDiffTask(task, preparedDiff.args);
    return task;
  }

  private async executeLegacyDiffTask(
    task: LegacyTask,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const rawResult = await Promise.resolve(
        this.options.capabilities.callIdeTool("openDiff", args, task.context),
      );
      const result = normalizeDiffResult(
        rawResult,
        task.tabName,
        task.displayTabName,
      );
      if (task.status === "working") {
        task.result = result;
        // Tool-level isError remains a normal JSON-RPC result. Only a thrown
        // protocol error moves the task into failed.
        task.status = "completed";
        task.statusMessage = "The user completed the Obsidian diff review.";
      }
    } catch (error) {
      if (task.status === "working") {
        task.status = "failed";
        task.statusMessage = error instanceof Error ? error.message : "Diff task failed.";
        task.error = {
          code: -32603,
          message: task.statusMessage,
          data: {
            _meta: {
              "io.modelcontextprotocol/related-task": { taskId: task.taskId },
            },
          },
        };
      }
    } finally {
      task.executionFinished = true;
      task.lastUpdatedAt = new Date().toISOString();
      task.settleCompletion();
    }
  }

  private findLegacyTask(
    session: LegacySession,
    taskIdValue: unknown,
  ): LegacyTask | null {
    this.pruneExpiredLegacyTasks();
    if (typeof taskIdValue !== "string") return null;
    const task = this.legacyTasks.get(taskIdValue);
    return task?.ownerSessionId === session.id ? task : null;
  }

  private legacyTaskView(task: LegacyTask): Record<string, unknown> {
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttl: task.ttl,
      pollInterval: task.pollInterval,
    };
  }

  private taskResultWithMetadata(task: LegacyTask): Record<string, unknown> {
    const fallback = {
      content: [{ type: "text", text: "DIFF_REJECTED" }],
      isError: task.status !== "completed",
    };
    const result = asRecord(task.result ?? fallback);
    return {
      ...result,
      _meta: {
        ...asRecord(result._meta),
        "io.modelcontextprotocol/related-task": { taskId: task.taskId },
      },
    };
  }

  private async cancelLegacyTask(task: LegacyTask): Promise<void> {
    if (task.cancellation) return task.cancellation;
    if (task.status !== "working") return;
    task.status = "cancelled";
    task.statusMessage = "The diff task was cancelled by the client.";
    task.lastUpdatedAt = new Date().toISOString();
    task.result = {
      content: [
        { type: "text", text: "DIFF_REJECTED" },
        { type: "text", text: task.displayTabName },
      ],
    };
    task.cancellation = this.closeOwnedDiff(
      task.tabName,
      task.context,
      () => !task.executionFinished,
    ).catch((error) => {
      this.options.onLog?.(`Universal MCP task cancellation failed: ${String(error)}`);
    }).finally(() => {
      task.settleCompletion();
    });
    return task.cancellation;
  }

  private pruneExpiredLegacyTasks(): void {
    const now = Date.now();
    for (const [taskId, task] of this.legacyTasks) {
      if (
        task.status !== "working" &&
        Date.parse(task.createdAt) + task.ttl <= now
      ) {
        this.legacyTasks.delete(taskId);
      }
    }
  }

  private async callTool(
    request: JsonRpcRequest,
    name: string,
    args: Record<string, unknown>,
    context: UniversalIdeToolContext,
    incoming?: IncomingMessage,
    outgoing?: ServerResponse,
  ): Promise<unknown> {
    const key = randomUUID();
    const preparedDiff = name === "openDiff" ? prepareUniversalDiffArgs(args) : null;
    const pending: PendingToolCall = {
      key,
      name,
      requestId: request.id,
      ...(preparedDiff ? { tabName: preparedDiff.tabName } : {}),
      ...(preparedDiff ? { displayTabName: preparedDiff.displayTabName } : {}),
      context,
      cancelRequested: false,
      finished: false,
      cancellation: null,
    };
    this.pendingToolCalls.set(key, pending);
    let complete = false;
    const onDisconnect = () => {
      if (!complete && name === "openDiff") void this.cancelPendingCall(pending);
    };
    incoming?.once("aborted", onDisconnect);
    outgoing?.once("close", onDisconnect);
    try {
      const result = await this.invokeIdeTool(
        name,
        preparedDiff?.args ?? args,
        context,
      );
      return preparedDiff
        ? normalizeDiffResult(
            result,
            preparedDiff.tabName,
            preparedDiff.displayTabName,
          )
        : result;
    } catch (error) {
      if (pending.cancelRequested) {
        return {
          content: [{ type: "text", text: "DIFF_REJECTED" }],
        };
      }
      throw error;
    } finally {
      complete = true;
      pending.finished = true;
      incoming?.off("aborted", onDisconnect);
      outgoing?.off("close", onDisconnect);
      this.pendingToolCalls.delete(key);
    }
  }

  private async invokeIdeTool(
    name: string,
    args: Record<string, unknown>,
    context: UniversalIdeToolContext,
  ): Promise<unknown> {
    if (name !== "close_tab") {
      return Promise.resolve(this.options.capabilities.callIdeTool(name, args, context));
    }
    const displayTabName =
      typeof args.tab_name === "string"
        ? args.tab_name
        : typeof args.tabName === "string"
          ? args.tabName
          : "";
    const actualTabNames = this.ownedTabNamesForDisplay(displayTabName, context);
    const results = await Promise.all([
      Promise.resolve(this.options.capabilities.callIdeTool(name, args, context)),
      ...actualTabNames.map((tabName) =>
        Promise.resolve(
          this.options.capabilities.callIdeTool(
            name,
            { ...args, tab_name: tabName },
            context,
          ),
        ),
      ),
    ]);
    if (actualTabNames.length === 0) return results[0];
    const counts = results.map((result) => this.closedDiffCount(result));
    if (counts.every((count): count is number => count !== null)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              closed: counts.reduce((sum, count) => sum + count, 0),
            }),
          },
        ],
      };
    }
    return results[0];
  }

  private ownedTabNamesForDisplay(
    displayTabName: string,
    context: UniversalIdeToolContext,
  ): string[] {
    if (!displayTabName) return [];
    const sameContext = (owner: UniversalIdeToolContext): boolean =>
      context.sessionId
        ? owner.sessionId === context.sessionId
        : owner.clientId === context.clientId;
    const names = new Set<string>();
    for (const pending of this.pendingToolCalls.values()) {
      if (
        pending.name === "openDiff" &&
        !pending.finished &&
        pending.displayTabName === displayTabName &&
        pending.tabName &&
        sameContext(pending.context)
      ) {
        names.add(pending.tabName);
      }
    }
    for (const task of this.legacyTasks.values()) {
      if (
        task.displayTabName === displayTabName &&
        task.ownerSessionId === context.sessionId &&
        !task.executionFinished
      ) {
        names.add(task.tabName);
      }
    }
    for (const task of this.modernTasks.values()) {
      if (
        task.displayTabName === displayTabName &&
        !task.executionFinished &&
        sameContext(task.context)
      ) {
        names.add(task.tabName);
      }
    }
    return [...names];
  }

  private async cancelPendingTool(
    requestId: unknown,
    context: UniversalIdeToolContext,
  ): Promise<void> {
    const normalizedId = requestId === undefined ? null : requestId;
    const matches = [...this.pendingToolCalls.values()].filter((pending) => {
      if (pending.name !== "openDiff" || pending.cancelRequested) return false;
      if (pending.requestId !== normalizedId) return false;
      if (context.sessionId) return pending.context.sessionId === context.sessionId;
      return pending.context.clientId === context.clientId;
    });
    // Modern requests are intentionally sessionless. If two clients report the same
    // clientInfo and reuse an id, refusing an ambiguous cancellation is safer than
    // closing another client's review. A transport disconnect still owns its exact call.
    if (!context.sessionId && matches.length !== 1) {
      if (matches.length > 1) {
        this.options.onLog?.("Universal MCP ignored an ambiguous diff cancellation.");
      }
      return;
    }
    await Promise.allSettled(matches.map((pending) => this.cancelPendingCall(pending)));
  }

  private async cancelPendingCall(pending: PendingToolCall): Promise<void> {
    if (pending.cancellation) return pending.cancellation;
    if (pending.name !== "openDiff" || !pending.tabName || pending.finished) return;
    pending.cancelRequested = true;
    pending.cancellation = this.closeOwnedDiff(
      pending.tabName,
      pending.context,
      () => !pending.finished,
    );
    return pending.cancellation;
  }

  private async closeOwnedDiff(
    tabName: string,
    context: UniversalIdeToolContext,
    isActive: () => boolean,
  ): Promise<void> {
    let delay = 0;
    while (isActive()) {
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (!isActive()) return;
      try {
        const result = await Promise.resolve(
          this.options.capabilities.callIdeTool("close_tab", { tab_name: tabName }, context),
        );
        if (this.didCloseDiff(result)) return;
      } catch (error) {
        this.options.onLog?.(`Universal MCP diff cancellation failed: ${String(error)}`);
      }
      delay = Math.min(delay === 0 ? 25 : delay * 2, 500);
    }
  }

  private didCloseDiff(value: unknown): boolean {
    return (this.closedDiffCount(value) ?? 0) > 0;
  }

  private closedDiffCount(value: unknown): number | null {
    const direct = asRecord(value);
    if (typeof direct.closed === "number") return direct.closed;
    const content = Array.isArray(direct.content) ? direct.content : [];
    for (const item of content) {
      const text = asRecord(item).text;
      if (typeof text !== "string") continue;
      try {
        const parsed = asRecord(JSON.parse(text));
        if (typeof parsed.closed === "number") return parsed.closed;
      } catch {
        // Non-JSON tool text is a valid response; another retry is harmless.
      }
    }
    return null;
  }

  private async readResource(uri: UniversalMcpResourceUri): Promise<unknown> {
    if (uri === UNIVERSAL_MCP_RESOURCE_URIS.latestMention) return this.latestMention;
    if (uri === UNIVERSAL_MCP_RESOURCE_URIS.diagnostics) {
      return this.latestDiagnostics ?? [];
    }
    const snapshot = await Promise.resolve(this.options.capabilities.getContextSnapshot());
    if (uri === UNIVERSAL_MCP_RESOURCE_URIS.context) return snapshot;
    if (uri === UNIVERSAL_MCP_RESOURCE_URIS.openEditors) {
      return Array.isArray(snapshot.openEditors) ? snapshot.openEditors : [];
    }
    return this.latestSelection === undefined ? (snapshot.current ?? null) : this.latestSelection;
  }

  private openLegacyEventStream(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const session = this.requireLegacySession(request, response, null);
    if (!session) return;
    const accept = headerValue(request.headers, "accept")?.toLowerCase() ?? "";
    if (!accept.includes("text/event-stream")) {
      writeJson(response, 406, { error: "Accept must include text/event-stream." });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    session.streams.add(response);
    const remove = () => session.streams.delete(response);
    request.once("aborted", remove);
    response.once("close", remove);
  }

  private openModernSubscription(
    request: JsonRpcRequest,
    incoming: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.id === undefined) {
      writeJson(response, 400, responseError(null, -32600, "Subscription requires an id."));
      return;
    }
    const notifications = asRecord(request.params?.notifications);
    const requestedResources = Array.isArray(notifications.resourceSubscriptions)
      ? notifications.resourceSubscriptions.filter(isResourceUri)
      : [];
    const key = randomUUID();
    const subscription: ModernSubscription = {
      key,
      id: request.id,
      resources: new Set(requestedResources),
      response,
    };
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.modernSubscriptions.set(key, subscription);
    writeSse(response, {
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": request.id },
        notifications: { resourceSubscriptions: requestedResources },
      },
    });
    const remove = () => this.modernSubscriptions.delete(key);
    incoming.once("aborted", remove);
    response.once("close", remove);
  }

  private async deleteLegacySession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const sessionId = headerValue(request.headers, "mcp-session-id");
    const session = sessionId ? this.legacySessions.get(sessionId) : undefined;
    if (!session) {
      writeJson(response, 404, { error: "Unknown MCP session." });
      return;
    }
    const sessionTasks = [...this.legacyTasks.values()].filter(
      (task) => task.ownerSessionId === session.id,
    );
    for (const task of sessionTasks) {
      await this.cancelLegacyTask(task);
      this.legacyTasks.delete(task.taskId);
    }
    const sessionPendingCalls = [...this.pendingToolCalls.values()].filter(
      (pending) => pending.context.sessionId === session.id,
    );
    await Promise.allSettled(
      sessionPendingCalls.map((pending) => this.cancelPendingCall(pending)),
    );
    for (const stream of session.streams) stream.end();
    this.legacySessions.delete(session.id);
    response.writeHead(204);
    response.end();
  }

  private requireLegacySession(
    request: IncomingMessage,
    response: ServerResponse,
    id: JsonRpcId,
  ): LegacySession | null {
    const sessionId = headerValue(request.headers, "mcp-session-id");
    const session = sessionId ? this.legacySessions.get(sessionId) : undefined;
    if (!session) {
      writeJson(response, 404, responseError(id, -32001, "Unknown MCP session."));
      return null;
    }
    const suppliedVersion = headerValue(request.headers, "mcp-protocol-version");
    if (suppliedVersion && suppliedVersion !== session.protocolVersion) {
      writeJson(
        response,
        400,
        responseError(id, -32022, "Unsupported protocol version", {
          supported: [session.protocolVersion],
          requested: suppliedVersion,
        }),
      );
      return null;
    }
    return session;
  }

  private capabilities(modern: boolean): Record<string, unknown> {
    return {
      tools: {},
      resources: { subscribe: true, listChanged: false },
      ...(modern
        ? { extensions: { [TASKS_EXTENSION_ID]: {} } }
        : {}),
    };
  }

  private modernResult(value: Record<string, unknown>): Record<string, unknown> {
    return {
      ...value,
      resultType: "complete",
      _meta: {
        ...asRecord(value._meta),
        "io.modelcontextprotocol/serverInfo": this.serverInfo(),
      },
    };
  }

  private writeRequestFailure(
    response: ServerResponse,
    request: JsonRpcRequest,
    error: unknown,
  ): void {
    writeJson(response, 200, this.requestFailureResponse(request, error));
  }

  private requestFailureResponse(
    request: JsonRpcRequest,
    error: unknown,
  ): JsonRpcResponse {
    this.options.onLog?.(
      `Universal MCP request failed (${request.method}): ${String(error)}`,
    );
    return responseError(
      request.id ?? null,
      -32603,
      error instanceof Error && error.message ? error.message : "Internal error",
    );
  }

  private serverInfo(): { name: string; version: string } {
    return {
      name: this.options.serverName ?? "mv-aide-universal",
      version: this.options.serverVersion ?? "0.0.0",
    };
  }

  private writeKeepalives(): void {
    for (const session of this.legacySessions.values()) {
      for (const stream of session.streams) {
        if (!stream.destroyed && !stream.writableEnded) stream.write(": keepalive\n\n");
      }
    }
    for (const subscription of this.modernSubscriptions.values()) {
      const stream = subscription.response;
      if (!stream.destroyed && !stream.writableEnded) stream.write(": keepalive\n\n");
    }
  }

  private async writeRuntimeDescriptor(
    descriptorPath: string,
    descriptor: UniversalMcpRuntimeDescriptor,
  ): Promise<void> {
    await fs.mkdir(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${descriptorPath}.${descriptor.instanceId}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await fs.rename(temporaryPath, descriptorPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await fs.unlink(descriptorPath).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      await fs.rename(temporaryPath, descriptorPath);
    }
  }

  private async removeOwnedRuntimeDescriptor(
    descriptorPath: string,
    instanceId: string,
  ): Promise<void> {
    try {
      const current = JSON.parse(await fs.readFile(descriptorPath, "utf8")) as {
        instanceId?: unknown;
      };
      if (current.instanceId === instanceId) await fs.unlink(descriptorPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onLog?.(`Universal MCP runtime descriptor cleanup failed: ${String(error)}`);
      }
    }
  }
}
