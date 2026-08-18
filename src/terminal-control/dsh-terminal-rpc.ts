import type {
  BridgeClientContext,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";
import type { TerminalRegistry } from "./terminal-registry";

const DSH_CLIENT_NAME = "mv-aide-dsh-plugin";

const TERMINAL_METHODS = new Set([
  "dsh/terminal/list",
  "dsh/terminal/read",
  "dsh/terminal/send",
  "dsh/terminal/run",
  "dsh/terminal/open",
  "dsh/terminal/focus",
]);

/**
 * Private JSON-RPC adapter used only by the bundled mv-agent client.
 * These methods are intentionally not tool definitions and never appear in
 * IDE/MCP tools/list.
 */
export class DshTerminalRpc {
  private readonly clientIds = new Set<string>();

  constructor(private readonly terminals: TerminalRegistry) {}

  observeInitialize(
    request: JsonRpcRequest,
    context?: BridgeClientContext,
  ): void {
    if (request.method !== "initialize" || !context || context.channel !== "ide") {
      return;
    }
    const clientInfo = request.params?.clientInfo;
    const clientName =
      clientInfo && typeof clientInfo === "object" && !Array.isArray(clientInfo)
        ? (clientInfo as Record<string, unknown>).name
        : undefined;
    if (clientName === DSH_CLIENT_NAME) {
      this.clientIds.add(context.clientId);
    } else {
      this.clientIds.delete(context.clientId);
    }
  }

  isDshClient(context?: BridgeClientContext): boolean {
    return !!context && context.channel === "ide" && this.clientIds.has(context.clientId);
  }

  async handle(
    request: JsonRpcRequest,
    context?: BridgeClientContext,
  ): Promise<JsonRpcResponse | null> {
    const method = request.method ?? "";
    if (!TERMINAL_METHODS.has(method)) return null;

    const id = request.id ?? null;
    if (!this.isDshClient(context)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      };
    }

    const params = request.params ?? {};
    try {
      switch (method) {
        case "dsh/terminal/list":
          return this.success(id, { terminals: this.terminals.list() });
        case "dsh/terminal/read": {
          const terminalId = optionalString(params.terminalId, "terminalId");
          const lastN = optionalNumber(params.lastN, "lastN");
          return this.success(id, this.terminals.read(terminalId, lastN ?? 50));
        }
        case "dsh/terminal/send": {
          const terminalId = optionalString(params.terminalId, "terminalId");
          const input = requiredString(params.input, "input", true);
          const submit = optionalBoolean(params.submit, "submit") ?? false;
          return this.success(id, this.terminals.send(terminalId, input, submit));
        }
        case "dsh/terminal/run": {
          const command = requiredString(params.command, "command");
          const terminalId = optionalString(params.terminalId, "terminalId");
          const newTerminal = optionalBoolean(params.newTerminal, "newTerminal") ?? false;
          return this.success(
            id,
            await this.terminals.run(command, { terminalId, newTerminal }),
          );
        }
        case "dsh/terminal/open":
          return this.success(id, await this.terminals.create());
        case "dsh/terminal/focus": {
          const terminalId = requiredString(params.terminalId, "terminalId");
          return this.success(id, await this.terminals.focus(terminalId));
        }
        default:
          return null;
      }
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof InvalidParamsError ? -32602 : -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  dispose(): void {
    this.clientIds.clear();
  }

  private success(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }
}

class InvalidParamsError extends Error {}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new InvalidParamsError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new InvalidParamsError(`${name} must be a string`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidParamsError(`${name} must be a finite number`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new InvalidParamsError(`${name} must be a boolean`);
  }
  return value;
}
