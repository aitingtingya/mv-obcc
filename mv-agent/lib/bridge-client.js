// mv-AIDE IDE bridge client (own protocol over WebSocket + JSON-RPC 2.0).
//
// mv-AIDE exposes a local server (127.0.0.1, port 47000 + stablePortSeed(vaultRoot) % 1500)
// that speaks `initialize` / `tools/list` / `tools/call` JSON-RPC 2.0. It is
// discovered through lock files at `~/.claude/ide/<port>.lock` (ideName === "Obsidian"),
// which carry the WebSocket auth token. The header name reuses Claude Code's
// convention so CC can also connect; the protocol itself is mv-AIDE's own.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const IDE_NAME = 'Obsidian';

/** Default reconnect policy. */
export const RECONNECT_POLICY = {
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
};

export function lockDirectory() {
  return path.join(os.homedir(), '.claude', 'ide');
}

/**
 * Scan `~/.claude/ide/*.lock` and return every mv-AIDE bridge endpoint.
 * @returns {Promise<Array<{port:number, authToken:string, workspaceFolders:string[]}>>}
 */
export async function discoverBridges(directory = lockDirectory()) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const match = /^(\d+)\.lock$/u.exec(entry);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isInteger(port)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.ideName !== IDE_NAME || parsed?.transport !== 'ws') continue;
    if (typeof parsed.authToken !== 'string' || parsed.authToken.length === 0) continue;
    found.push({
      port,
      authToken: parsed.authToken,
      workspaceFolders: Array.isArray(parsed.workspaceFolders)
        ? parsed.workspaceFolders
        : [],
    });
  }
  return found;
}

/**
 * Choose the bridge whose workspace matches `workspaceFolder` when given;
 * otherwise return the first bridge.
 */
export function selectBridge(bridges, workspaceFolder) {
  if (bridges.length === 0) return undefined;
  if (typeof workspaceFolder === 'string' && workspaceFolder.length > 0) {
    const norm = normalizePath(workspaceFolder);
    const hit = bridges.find((bridge) =>
      bridge.workspaceFolders.some((folder) => normalizePath(folder) === norm),
    );
    if (hit) return hit;
  }
  return bridges[0];
}

function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Keep only `true`-valued entries; the bridge policy is a plain record. */
function normalizeOutsideToolPolicy(value) {
  const policy = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, allowed] of Object.entries(value)) {
      if (typeof name === 'string' && allowed === true) policy[name] = true;
    }
  }
  return policy;
}

/**
 * A single WebSocket JSON-RPC connection to one mv-AIDE bridge.
 */
export class BridgeClient {
  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {string} opts.authToken
   * @param {(state:'connecting'|'connected'|'disconnected'|'error', detail?:unknown)=>void} [opts.onState]
   * @param {(notification: {jsonrpc?:string, method:string, params?:Record<string, unknown>})=>void} [opts.onNotification]
   */
  constructor(opts) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.onState = opts.onState ?? (() => {});
    this.onNotification = opts.onNotification ?? (() => {});
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.closedByUser = false;
    /** Server-side diff-review setting (see mv-AIDE "使用 Obsidian 审阅仓库外 diff"). */
    this.reviewOutsideVault = false;
    /** Server-side passive-delivery mode: 'live' | 'on-send'. */
    this.passiveDelivery = 'live';
    /** 状态栏「打开」勾选框：是否推送位置信息。 */
    this.pushLocation = true;
    /** 状态栏「选中」勾选框：是否推送选中文本。 */
    this.pushSelection = true;
    /** Per-channel opt-in for agents outside the vault (channel → boolean). */
    this.outsideToolPolicy = {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}`;
      const socket = new WebSocket(url, {
        headers: { 'x-claude-code-ide-authorization': this.authToken },
        handshakeTimeout: 5000,
      });
      this.socket = socket;
      this.onState('connecting');

      const onError = (error) => {
        this.onState('error', error instanceof Error ? error.message : String(error));
        reject(error);
      };
      socket.once('error', onError);
      socket.once('open', () => {
        socket.off('error', onError);
        this.onState('connected');
        resolve();
      });
      socket.on('message', (data) => this.handleMessage(data));
      socket.on('close', () => {
        this.rejectAll(new Error('bridge connection closed'));
        this.socket = null;
        this.onState('disconnected');
      });
    });
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message?.id !== 'undefined' && message.id !== null) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ?? `JSON-RPC error ${message.error.code ?? ''}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // Notification (no id): route to the passive context handler.
    if (message && typeof message.method === 'string') {
      this.onNotification(message);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  isOpen() {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  rpc(method, params, signal) {
    if (!this.isOpen()) return Promise.reject(new Error('bridge is not connected'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(String(id));
        reject(new Error('aborted'));
      };
      if (signal) {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const pending = {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.pending.set(String(id), pending);
      try {
        this.socket.send(payload);
      } catch (error) {
        this.pending.delete(String(id));
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mv-aide-dsh-plugin', version: '0.1.0' },
    });
    // mv-AIDE (recent) echoes its settings back with the result; older
    // builds omit them, leaving the defaults.
    this.reviewOutsideVault = result?.reviewOutsideVault === true;
    this.passiveDelivery = result?.passiveDelivery === 'on-send' ? 'on-send' : 'live';
    this.pushLocation = result?.pushLocation !== false;
    this.pushSelection = result?.pushSelection !== false;
    this.outsideToolPolicy = normalizeOutsideToolPolicy(result?.outsideToolPolicy);
    return result;
  }

  async listTools() {
    const result = await this.rpc('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    this.tools = tools.map((tool) => ({
      name: tool?.name,
      description: tool?.description ?? '',
      inputSchema: tool?.inputSchema ?? { type: 'object', properties: {} },
    }));
    return this.tools;
  }

  async callTool(name, args, signal) {
    const result = await this.rpc('tools/call', { name, arguments: args ?? {} }, signal);
    return result;
  }

  close() {
    this.closedByUser = true;
    this.rejectAll(new Error('bridge closed'));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}

/**
 * Owns discovery + connection + reconnect for one plugin lifetime.
 * All side effects are owned by the caller through `start()`/`dispose()`.
 */
export class BridgeSupervisor {
  /**
   * @param {object} opts
   * @param {(client:BridgeClient|null, tools:Array)=>void} opts.onGeneration
   *   Called with the connected client and its tools after each successful sync,
   *   and with (null, []) after a lost connection / exhausted reconnect budget.
   * @param {()=>Promise<string|undefined>} [opts.resolveWorkspace] async current workspace folder.
   * @param {(message:string)=>void} [opts.onLog]
   * @param {(notification: {method:string, params?:Record<string, unknown>})=>void} [opts.onNotification]
   *   Passive bridge notifications (selection_changed, at_mentioned, …).
   */
  constructor(opts) {
    this.onGeneration = opts.onGeneration;
    this.resolveWorkspace = opts.resolveWorkspace ?? (async () => undefined);
    this.onLog = opts.onLog ?? (() => {});
    this.onNotification = opts.onNotification ?? (() => {});
    this.client = null;
    this.disposed = false;
    this.attempts = 0;
    this.delay = RECONNECT_POLICY.initialDelayMs;
    this.timer = null;
    /** Vault roots of the currently selected bridge (from its lock file). */
    this.workspaceFolders = [];
    /** Mirrors the mv-agent setting `reviewOutsideVault` on the live bridge. */
    this.reviewOutsideVault = false;
    /** Mirrors the mv-agent setting `passiveDelivery` ('live' | 'on-send'). */
    this.passiveDelivery = 'live';
    /** Mirrors the mv-agent status-bar checkbox `pushLocation`. */
    this.pushLocation = true;
    /** Mirrors the mv-agent status-bar checkbox `pushSelection`. */
    this.pushSelection = true;
    /** Per-channel opt-in for agents outside the vault (channel → boolean). */
    this.outsideToolPolicy = {};
  }

  /** Whether the selected bridge connection is currently open. */
  isConnected() {
    return this.client?.isOpen() ?? false;
  }

  start() {
    void this.connectOnce();
  }

  async connectOnce() {
    if (this.disposed) return;
    const workspace = await this.resolveWorkspace().catch(() => undefined);
    const bridges = await discoverBridges().catch(() => []);
    const target = selectBridge(bridges, workspace);
    if (!target) {
      this.scheduleRetry('no mv-AIDE bridge lock file found');
      return;
    }
    this.workspaceFolders = target.workspaceFolders ?? [];

    const client = new BridgeClient({
      port: target.port,
      authToken: target.authToken,
      onState: (state, detail) => {
        if (state === 'error') this.onLog(`mv-aide bridge: ${detail}`);
      },
      onNotification: (notification) => {
        // Settings pushed by mv-AIDE apply immediately to the running
        // plugin (diff hook + passive delivery + tool gates) without
        // reconnecting.
        if (notification?.method === 'mv_aide_settings_changed') {
          const next = notification?.params?.reviewOutsideVault;
          if (typeof next === 'boolean') this.reviewOutsideVault = next;
          const mode = notification?.params?.passiveDelivery;
          if (mode === 'live' || mode === 'on-send') this.passiveDelivery = mode;
          const pushLocation = notification?.params?.pushLocation;
          if (typeof pushLocation === 'boolean') this.pushLocation = pushLocation;
          const pushSelection = notification?.params?.pushSelection;
          if (typeof pushSelection === 'boolean') this.pushSelection = pushSelection;
          const policy = notification?.params?.outsideToolPolicy;
          if (policy && typeof policy === 'object') {
            this.outsideToolPolicy = normalizeOutsideToolPolicy(policy);
          }
        }
        this.onNotification(notification);
      },
    });

    try {
      await client.connect();
      await client.initialize();
      this.reviewOutsideVault = client.reviewOutsideVault === true;
      this.passiveDelivery = client.passiveDelivery === 'on-send' ? 'on-send' : 'live';
      this.pushLocation = client.pushLocation !== false;
      this.pushSelection = client.pushSelection !== false;
      this.outsideToolPolicy = client.outsideToolPolicy;
      const tools = await client.listTools();
      this.client = client;
      this.attempts = 0;
      this.delay = RECONNECT_POLICY.initialDelayMs;
      this.onGeneration(client, tools);

      const onClose = () => {
        if (this.client === client) {
          this.client = null;
          this.onGeneration(null, []);
        }
        this.scheduleRetry('bridge disconnected');
      };
      client.socket?.once('close', onClose);
    } catch (error) {
      this.onLog(`mv-aide bridge connect failed: ${error instanceof Error ? error.message : String(error)}`);
      client.close();
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
    }
  }

  scheduleRetry(reason) {
    if (this.disposed || this.timer !== null) return;
    this.attempts += 1;
    if (this.attempts > RECONNECT_POLICY.maxAttempts) {
      this.onLog(`mv-aide bridge: giving up after ${RECONNECT_POLICY.maxAttempts} attempts (${reason})`);
      this.attempts = 0;
      this.delay = RECONNECT_POLICY.initialDelayMs;
      // Keep a slow retry cadence instead of dying: re-scan every maxDelayMs.
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.connectOnce();
      }, RECONNECT_POLICY.maxDelayMs);
      return;
    }
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, RECONNECT_POLICY.maxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connectOnce();
    }, delay);
  }

  /** Call a tool on the live connection. */
  callTool(name, args, signal) {
    if (!this.client?.isOpen()) return Promise.reject(new Error('mv-aide bridge is not connected'));
    return this.client.callTool(name, args, signal);
  }

  status() {
    return {
      connected: this.client?.isOpen() ?? false,
      toolCount: this.client?.tools.length ?? 0,
      attempts: this.attempts,
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.client?.close();
    this.client = null;
    this.onGeneration(null, []);
  }
}
