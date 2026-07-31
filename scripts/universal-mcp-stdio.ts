#!/usr/bin/env node

import fs from "node:fs/promises";
import readline from "node:readline";
import type { UniversalMcpRuntimeDescriptor } from "../src/universal-mcp";
import { matchesUniversalMcpHealth } from "../src/universal-mcp-stdio-health";

const MODERN_PROTOCOL_VERSION = "2026-07-28";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcPayload = JsonRpcMessage | JsonRpcMessage[];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runtimePathFromArguments(args: string[], environment: NodeJS.ProcessEnv): string {
  const index = args.indexOf("--runtime");
  const argument = index >= 0 ? args[index + 1] : undefined;
  const runtimePath = argument || environment.MV_OBCC_MCP_RUNTIME;
  if (!runtimePath) {
    throw new Error(
      "Missing runtime descriptor. Pass --runtime <path> or set MV_OBCC_MCP_RUNTIME.",
    );
  }
  return runtimePath;
}

function isDescriptor(value: unknown): value is UniversalMcpRuntimeDescriptor {
  const record = asRecord(value);
  const auth = asRecord(record.auth);
  return (
    record.schemaVersion === 1 &&
    typeof record.instanceId === "string" &&
    typeof record.pid === "number" &&
    typeof record.httpUrl === "string" &&
    Array.isArray(record.protocolVersions) &&
    auth.type === "bearer" &&
    typeof auth.token === "string" &&
    auth.token.length > 0
  );
}

async function readDescriptor(runtimePath: string): Promise<UniversalMcpRuntimeDescriptor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(runtimePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Universal MCP runtime descriptor: ${String(error)}`);
  }
  if (!isDescriptor(parsed)) {
    throw new Error("Universal MCP runtime descriptor is invalid.");
  }
  return parsed;
}

function encodeMcpHeader(value: string): string {
  const isPlainAscii =
    /^[\x20-\x7e]+$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="));
  return isPlainAscii
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function messageVersion(message: JsonRpcMessage): string | undefined {
  const meta = asRecord(message.params?._meta);
  const version = meta["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

function messageName(message: JsonRpcMessage): string | undefined {
  if (message.method === "tools/call") {
    return typeof message.params?.name === "string" ? message.params.name : undefined;
  }
  if (message.method === "resources/read") {
    return typeof message.params?.uri === "string" ? message.params.uri : undefined;
  }
  return undefined;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeTransportError(id: JsonRpcMessage["id"], message: string): void {
  if (id === undefined) return;
  writeMessage({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32603, message },
  });
}

async function consumeSse(response: Response, onMessage: (message: unknown) => void): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onMessage(JSON.parse(data));
        } catch {
          // Ignore malformed SSE data without corrupting the stdio framing.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) return;
  }
}

class UniversalMcpStdioProxy {
  private legacySessionId: string | null = null;
  private legacyVersion: string | null = null;
  private legacyStreamAbort: AbortController | null = null;
  private requests = new Map<string, AbortController>();
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly descriptor: UniversalMcpRuntimeDescriptor) {}

  async verifyRuntime(): Promise<void> {
    const healthUrl = new URL(this.descriptor.httpUrl);
    healthUrl.pathname = "/healthz";
    healthUrl.search = "";
    const response = await fetch(healthUrl, {
      headers: { authorization: `Bearer ${this.descriptor.auth.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`Universal MCP health check failed (${response.status}).`);
    const health = asRecord(await response.json());
    if (!matchesUniversalMcpHealth(this.descriptor, health)) {
      throw new Error("Universal MCP runtime descriptor is stale.");
    }
  }

  async forward(message: JsonRpcPayload): Promise<void> {
    const singleMessage = Array.isArray(message) ? null : message;
    if (singleMessage?.method === "notifications/cancelled") {
      const requestId = singleMessage.params?.requestId;
      const controller = this.requests.get(JSON.stringify(requestId ?? null));
      if (controller) {
        controller.abort();
        return;
      }
    }

    const version = singleMessage ? messageVersion(singleMessage) : undefined;
    const modern = version === MODERN_PROTOCOL_VERSION;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.descriptor.auth.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (modern) {
      headers["mcp-protocol-version"] = MODERN_PROTOCOL_VERSION;
      headers["mcp-method"] = singleMessage?.method ?? "";
      const name = singleMessage ? messageName(singleMessage) : undefined;
      if (name !== undefined) headers["mcp-name"] = encodeMcpHeader(name);
    } else if (singleMessage?.method !== "initialize" && this.legacySessionId) {
      headers["mcp-session-id"] = this.legacySessionId;
      if (this.legacyVersion) headers["mcp-protocol-version"] = this.legacyVersion;
    }

    const requestKey =
      !singleMessage || singleMessage.id === undefined
        ? null
        : JSON.stringify(singleMessage.id ?? null);
    const controller = new AbortController();
    if (requestKey) this.requests.set(requestKey, controller);
    try {
      const response = await fetch(this.descriptor.httpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (singleMessage?.method === "initialize" && sessionId) {
        this.legacySessionId = sessionId;
        const body = await response.json();
        const result = asRecord(asRecord(body).result);
        this.legacyVersion =
          typeof result.protocolVersion === "string" ? result.protocolVersion : "2025-03-26";
        writeMessage(body);
        void this.openLegacyEventStream();
        return;
      }
      if (response.status === 202 || response.status === 204) return;
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        await consumeSse(response, writeMessage);
        return;
      }
      const text = await response.text();
      if (!text) {
        if (!response.ok) writeTransportError(singleMessage?.id, `HTTP ${response.status}`);
        return;
      }
      try {
        writeMessage(JSON.parse(text));
      } catch {
        writeTransportError(
          singleMessage?.id,
          `Universal MCP returned HTTP ${response.status}.`,
        );
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        writeTransportError(
          singleMessage?.id,
          `Universal MCP transport failed: ${String(error)}`,
        );
      }
    } finally {
      if (requestKey && this.requests.get(requestKey) === controller) {
        this.requests.delete(requestKey);
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.legacyStreamAbort?.abort();
    this.legacyStreamAbort = null;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    const sessionId = this.legacySessionId;
    const protocolVersion = this.legacyVersion;
    this.legacySessionId = null;
    this.legacyVersion = null;
    if (!sessionId) return;
    try {
      const response = await fetch(this.descriptor.httpUrl, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.descriptor.auth.token}`,
          "mcp-session-id": sessionId,
          ...(protocolVersion
            ? { "mcp-protocol-version": protocolVersion }
            : {}),
        },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok && response.status !== 404) {
        process.stderr.write(
          `mv-obcc MCP session cleanup returned HTTP ${response.status}.\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`mv-obcc MCP session cleanup failed: ${String(error)}\n`);
    }
  }

  private async openLegacyEventStream(): Promise<void> {
    if (!this.legacySessionId || this.legacyStreamAbort) return;
    const controller = new AbortController();
    this.legacyStreamAbort = controller;
    try {
      const response = await fetch(this.descriptor.httpUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.descriptor.auth.token}`,
          accept: "text/event-stream",
          "mcp-session-id": this.legacySessionId,
          ...(this.legacyVersion
            ? { "mcp-protocol-version": this.legacyVersion }
            : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Legacy MCP event stream failed (${response.status}).`);
      }
      await consumeSse(response, writeMessage);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        process.stderr.write(`mv-obcc MCP event stream closed: ${String(error)}\n`);
      }
    } finally {
      if (this.legacyStreamAbort === controller) this.legacyStreamAbort = null;
    }
  }
}

async function main(): Promise<void> {
  const runtimePath = runtimePathFromArguments(process.argv.slice(2), process.env);
  const proxy = new UniversalMcpStdioProxy(await readDescriptor(runtimePath));
  await proxy.verifyRuntime();

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message: JsonRpcPayload;
    try {
      message = JSON.parse(line) as JsonRpcPayload;
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    void proxy.forward(message);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  await proxy.stop();
}

void main().catch((error) => {
  process.stderr.write(`mv-obcc Universal MCP stdio proxy: ${String(error)}\n`);
  process.exitCode = 1;
});
