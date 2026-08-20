// mv-AIDE IDE bridge client (own protocol over WebSocket + JSON-RPC 2.0).
//
// mv-AIDE exposes a local server (127.0.0.1, port 47000 + stablePortSeed(vaultRoot) % 1500)
// that speaks `initialize` / `tools/list` / `tools/call` JSON-RPC 2.0. It is
// discovered through lock files in the mv-AIDE registry
// `~/.mv-aide/ide/<port>.lock`, which carry the WebSocket auth token. The
// transport header remains compatible with existing IDE clients; discovery
// ownership itself is exclusively mv-AIDE's.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import WebSocket from 'ws';
import {
  dshBridgeSelectionPath,
  legacyDshBridgeSelectionPath,
  mvAideIdeDirectory,
} from './paths.js';

export const IDE_NAME = 'Obsidian';

/** Default reconnect policy. */
export const RECONNECT_POLICY = {
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
};

/** Canonical mv-AIDE bridge registry. */
export function discoveryDirectories() {
  return [mvAideIdeDirectory()];
}

/** Backward-compatible alias for older callers/tests. */
export function lockDirectory() {
  return discoveryDirectories()[0];
}

/**
 * Scan the discovery directories and return every mv-AIDE bridge endpoint.
 * First directory wins for duplicate ports; results are sorted by port.
 * @param {string|string[]} [directories]
 * @returns {Promise<Array<{port:number, authToken:string, workspaceFolders:string[]}>>}
 */
export async function discoverBridges(directories = discoveryDirectories()) {
  const list = Array.isArray(directories) ? directories : [directories];
  const byPort = new Map();
  for (const directory of list) {
    let entries;
    try {
      entries = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^(\d+)\.lock$/u.exec(entry);
      if (!match) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || byPort.has(port)) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'));
      } catch {
        continue;
      }
      if (parsed?.ideName !== IDE_NAME || parsed?.transport !== 'ws') continue;
      if (typeof parsed.authToken !== 'string' || parsed.authToken.length === 0) continue;
      byPort.set(port, {
        port,
        authToken: parsed.authToken,
        workspaceFolders: Array.isArray(parsed.workspaceFolders)
          ? parsed.workspaceFolders
          : [],
      });
    }
  }
  return sortBridges([...byPort.values()]);
}

/** Sort bridges by ascending port for deterministic listing. */
export function sortBridges(bridges) {
  return [...bridges].sort((a, b) => a.port - b.port);
}

/** Normalize a path for cross-platform, case-insensitive-on-Windows matching. */
export function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Bridge workspace folders, safely. */
function bridgeFoldersOf(bridge) {
  return bridge && Array.isArray(bridge.workspaceFolders) ? bridge.workspaceFolders : [];
}

/** Persisted selection workspace folders, safely. */
function selectionFoldersOf(selection) {
  return selection && Array.isArray(selection.workspaceFolders) ? selection.workspaceFolders : [];
}

/** Cross-platform, case-insensitive-on-Windows path equality. */
function sameFolderPath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

/**
 * True when a bridge matches a persisted/manual selection snapshot.
 * The Obsidian vault path is the authoritative identity; the port is only a
 * tie-breaker/fast path. A stale port that now belongs to another vault must
 * never match. Legacy selections without folders keep port-only matching.
 */
export function bridgeMatchesSelection(bridge, selection) {
  if (!bridge || !selection) return false;
  const selectedFolders = selectionFoldersOf(selection);
  const currentFolders = bridgeFoldersOf(bridge);
  if (selectedFolders.length > 0 && currentFolders.length > 0) {
    return selectedFolders.some((folder) =>
      currentFolders.some((bridgeFolder) => sameFolderPath(bridgeFolder, folder)),
    );
  }
  if (selectedFolders.length === 0) {
    return typeof selection.port === 'number' && bridge.port === selection.port;
  }
  return false;
}

/**
 * Resolve a persisted selection to one current bridge. The vault path wins;
 * among multiple bridges for the same vault the saved port is preferred,
 * otherwise the lowest port is deterministic.
 */
export function selectBridgeForSelection(bridges, selection) {
  const sorted = sortBridges(bridges);
  const matches = sorted.filter((bridge) => bridgeMatchesSelection(bridge, selection));
  if (matches.length === 0) return undefined;
  if (selection && typeof selection.port === 'number') {
    const samePort = matches.find((bridge) => bridge.port === selection.port);
    if (samePort) return samePort;
  }
  return matches[0];
}

/** Canonical key for a DSH workspace path. */
export function workspaceKeyOf(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) return null;
  return normalizePath(workspace);
}

/** True when `root` equals or is a directory-boundary ancestor of `candidate`. */
export function pathContains(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** True when a bridge vault equals or contains this DSH workspace path. */
export function bridgeMatchesWorkspace(bridge, workspace) {
  const key = workspaceKeyOf(workspace);
  if (!key || !bridge) return false;
  return bridgeFoldersOf(bridge).some((folder) => pathContains(folder, key));
}

function pathDepth(value) {
  const normalized = normalizePath(value);
  const root = path.parse(normalized).root;
  return normalized.slice(root.length).split(path.sep).filter(Boolean).length;
}

/**
 * Choose the largest (outermost) live vault containing the DSH workspace.
 * Segment depth wins, then path length and port make ties deterministic.
 */
export function selectBridgeForWorkspace(bridges, workspace) {
  const key = workspaceKeyOf(workspace);
  if (!key) return undefined;
  const candidates = [];
  for (const bridge of bridges ?? []) {
    for (const folder of bridgeFoldersOf(bridge)) {
      if (!pathContains(folder, key)) continue;
      candidates.push({
        bridge,
        depth: pathDepth(folder),
        length: normalizePath(folder).length,
      });
    }
  }
  candidates.sort((left, right) =>
    left.depth - right.depth ||
    left.length - right.length ||
    left.bridge.port - right.bridge.port,
  );
  return candidates[0]?.bridge;
}

/**
 * Pure target resolver used by the supervisor:
 *  1. persisted conversation selection;
 *  2. bridge whose vault equals the DSH workspace;
 *  3. last selection made by any conversation in the same DSH workspace.
 * Returns undefined when nothing matches — never an arbitrary lowest port.
 */
export function resolveBridgeTarget(bridges, options = {}) {
  const sorted = sortBridges(bridges);
  const selection = options && options.selection ? options.selection : null;
  if (selection) {
    const bridge = selectBridgeForSelection(sorted, selection);
    return bridge ? { bridge, source: 'session' } : undefined;
  }
  if (typeof options?.workspace === 'string' && options.workspace.length > 0) {
    const hit = selectBridgeForWorkspace(sorted, options.workspace);
    if (hit) return { bridge: hit, source: 'workspace' };
  }
  if (options && options.workspaceSelection) {
    const bridge = selectBridgeForSelection(sorted, options.workspaceSelection);
    if (bridge) return { bridge, source: 'workspace-last' };
  }
  return undefined;
}

/**
 * Choose the bridge whose workspace matches `workspaceFolder` when given.
 * Manual selections must still exist; otherwise undefined so the caller
 * retries instead of silently switching vaults. Auto mode never falls back
 * to an arbitrary lowest-port bridge.
 */
export function selectBridge(bridges, workspaceFolder, manualSelection) {
  const sorted = sortBridges(bridges);
  if (sorted.length === 0) return undefined;
  if (manualSelection) return selectBridgeForSelection(sorted, manualSelection);
  if (typeof workspaceFolder === 'string' && workspaceFolder.length > 0) {
    const hit = selectBridgeForWorkspace(sorted, workspaceFolder);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Parse a `/mv-aide connect` argument into a bridge.
 * Accepts 1-based index, numeric port, or workspace path.
 */
export function parseBridgeSelector(input, bridges) {
  const raw = String(input ?? '').trim();
  const sorted = sortBridges(bridges);
  if (raw.length === 0) {
    return { ok: false, message: '请提供桥接序号、端口或仓库路径。' };
  }
  if (/^\d+$/u.test(raw)) {
    const num = Number(raw);
    if (Number.isInteger(num) && num >= 1 && num <= sorted.length) {
      return { ok: true, bridge: sorted[num - 1] };
    }
    const byPort = sorted.find((bridge) => bridge.port === num);
    if (byPort) return { ok: true, bridge: byPort };
    return { ok: false, message: `没有找到序号或端口 ${raw} 对应的 IDE 桥。` };
  }
  const norm = normalizePath(raw);
  const exact = sorted.filter((bridge) =>
    bridge.workspaceFolders.some((folder) => normalizePath(folder) === norm),
  );
  if (exact.length === 1) return { ok: true, bridge: exact[0] };
  if (exact.length > 1) {
    return { ok: false, message: `路径 ${raw} 匹配到多个桥，请用端口或序号选择。` };
  }
  const prefix = sorted.filter((bridge) =>
    bridge.workspaceFolders.some((folder) => {
      const normalized = normalizePath(folder);
      return normalized === norm || normalized.startsWith(`${norm}${path.sep}`);
    }),
  );
  if (prefix.length === 1) return { ok: true, bridge: prefix[0] };
  if (prefix.length > 1) {
    return { ok: false, message: `路径 ${raw} 匹配到多个桥，请用端口或序号选择。` };
  }
  return { ok: false, message: `没有找到 workspace 匹配 ${raw} 的 IDE 桥。` };
}

/** Stable per-session key for bridge selection persistence. */
export function sessionKeyOf(agent) {
  const sessionId = agent?.session?.id ?? agent?.id;
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return `session:${sessionId}`;
  }
  const cwd = agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    return `cwd:${normalizePath(cwd)}`;
  }
  return 'default';
}

/** Per-session bridge selection persistence file. */
export function bridgeSelectionPath() {
  return dshBridgeSelectionPath();
}

const selectionWriteQueues = new Map();

function selectionFromEntry(entry) {
  if (!entry || typeof entry.port !== 'number' || !Array.isArray(entry.workspaceFolders)) {
    return null;
  }
  const selection = {
    port: entry.port,
    workspaceFolders: [...entry.workspaceFolders],
  };
  if (typeof entry.workspace === 'string' && entry.workspace.length > 0) {
    selection.workspace = entry.workspace;
  }
  if (['manual', 'workspace', 'workspace-last'].includes(entry.source)) {
    selection.source = entry.source;
  }
  return selection;
}

function deriveWorkspaceSelections(sessions) {
  const workspaces = {};
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    if (!selectionFromEntry(entry) || typeof entry.workspace !== 'string' || entry.workspace.length === 0) continue;
    const key = workspaceKeyOf(entry.workspace);
    if (!key) continue;
    const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    const previous = workspaces[key];
    if (!previous || updatedAt >= previous.updatedAt) {
      workspaces[key] = {
        ...entry,
        workspace: key,
        sessionKey,
        source: ['manual', 'workspace', 'workspace-last'].includes(entry.source)
          ? entry.source
          : 'manual',
        updatedAt,
      };
    }
  }
  return workspaces;
}

async function readBridgeSelectionStateFile(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.sessions || typeof raw.sessions !== 'object') {
      return { valid: false, version: 0, sessions: {}, workspaces: {} };
    }
    const sessions = Object.fromEntries(Object.entries(raw.sessions).map(([sessionKey, entry]) => {
      if (!selectionFromEntry(entry) || ['manual', 'workspace', 'workspace-last'].includes(entry.source)) {
        return [sessionKey, entry];
      }
      // Before v3 only explicit `/connect` choices were persisted, so their
      // missing source is unambiguously manual.
      return [sessionKey, { ...entry, source: 'manual' }];
    }));
    const workspaces = raw.version === 3 && raw.workspaces && typeof raw.workspaces === 'object'
      ? { ...raw.workspaces }
      : deriveWorkspaceSelections(sessions);
    return {
      valid: true,
      version: typeof raw.version === 'number' ? raw.version : 1,
      sessions,
      workspaces,
    };
  } catch {
    return { valid: false, version: 0, sessions: {}, workspaces: {} };
  }
}

async function migrateLegacyBridgeSelectionPath(file) {
  if (file !== bridgeSelectionPath()) return;
  try {
    await fs.access(file);
    return;
  } catch {
    // Canonical file is absent; only then is the legacy root-level file eligible.
  }

  const legacyFile = legacyDshBridgeSelectionPath();
  const legacyState = await readBridgeSelectionStateFile(legacyFile);
  if (!legacyState.valid) return;
  await writeBridgeSelectionState(file, legacyState);
  const verified = await readBridgeSelectionStateFile(file);
  if (!verified.valid || verified.version !== 3) {
    throw new Error('DSH bridge selection migration verification failed.');
  }
  await fs.unlink(legacyFile);
}

async function readBridgeSelectionState(file = bridgeSelectionPath()) {
  await migrateLegacyBridgeSelectionPath(file);
  return readBridgeSelectionStateFile(file);
}

async function writeBridgeSelectionState(file, state) {
  const data = { version: 3, sessions: state.sessions, workspaces: state.workspaces };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function withSelectionWrite(file, operation) {
  const previous = selectionWriteQueues.get(file) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  selectionWriteQueues.set(file, run);
  return run.finally(() => {
    if (selectionWriteQueues.get(file) === run) selectionWriteQueues.delete(file);
  });
}

/**
 * Update one session's selection in the shared map; null removes the key.
 * `options` accepts either a legacy file path string or
 * `{ workspace, file }`. `workspace` is the DSH workspace cwd and powers the
 * per-workspace last-selected fallback.
 */
export async function updateBridgeSelection(sessionKey, selection, options = {}) {
  const file = typeof options === 'string' ? options : (options?.file ?? bridgeSelectionPath());
  const requestedWorkspace = typeof options === 'string' ? undefined : options?.workspace;
  return withSelectionWrite(file, async () => {
    const state = await readBridgeSelectionState(file);
    if (selection === null) {
      delete state.sessions[sessionKey];
      await writeBridgeSelectionState(file, state);
      return;
    }
    const workspace = typeof requestedWorkspace === 'string' && requestedWorkspace.length > 0
      ? normalizePath(requestedWorkspace)
      : typeof selection.workspace === 'string' && selection.workspace.length > 0
        ? normalizePath(selection.workspace)
        : undefined;
    const source = ['manual', 'workspace', 'workspace-last'].includes(selection.source)
      ? selection.source
      : 'manual';
    const entry = {
      port: selection.port,
      workspaceFolders: Array.isArray(selection.workspaceFolders)
        ? [...selection.workspaceFolders]
        : [],
      ...(workspace ? { workspace } : {}),
      source,
      updatedAt: Date.now(),
    };
    state.sessions[sessionKey] = entry;
    if (workspace) {
      const workspaceKey = workspaceKeyOf(workspace);
      if (workspaceKey) {
        state.workspaces[workspaceKey] = { ...entry, sessionKey };
      }
    }
    await writeBridgeSelectionState(file, state);
  });
}

/** Read one session's persisted selection, or null when absent/corrupt. */
export async function loadBridgeSelection(sessionKey, file = bridgeSelectionPath()) {
  const state = await readBridgeSelectionState(file);
  return selectionFromEntry(state.sessions[sessionKey]);
}

/**
 * Read the most recent bridge selection made by any conversation in the
 * given DSH workspace. Returns null when the workspace has no selection yet
 * or when the file only contains legacy v1 entries without a workspace.
 */
export async function loadLatestBridgeSelectionForWorkspace(workspace, file = bridgeSelectionPath()) {
  const key = workspaceKeyOf(workspace);
  if (!key) return null;
  const state = await readBridgeSelectionState(file);
  const entry = state.workspaces[key];
  const selection = selectionFromEntry(entry);
  if (!selection) return null;
  return {
    ...selection,
    sessionKey: typeof entry.sessionKey === 'string' ? entry.sessionKey : undefined,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
  };
}

/** Upgrade a recognized v1/v2 store to the explicit v3 sessions/workspaces shape. */
export async function migrateBridgeSelectionStore(file = bridgeSelectionPath()) {
  return withSelectionWrite(file, async () => {
    const state = await readBridgeSelectionState(file);
    if (!state.valid || state.version === 3) return false;
    await writeBridgeSelectionState(file, state);
    return true;
  });
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
    /** Whether mv-agent should replace getTerminalOutput with native terminal tools. */
    this.terminalAwarenessEnhanced = true;
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
    this.terminalAwarenessEnhanced = result?.terminalAwarenessEnhanced !== false;
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

  async listTerminals(signal) {
    return this.rpc('dsh/terminal/list', {}, signal);
  }

  async readTerminal(args, signal) {
    return this.rpc('dsh/terminal/read', args ?? {}, signal);
  }

  async sendTerminal(args, signal) {
    return this.rpc('dsh/terminal/send', args ?? {}, signal);
  }

  async runTerminal(args, signal) {
    return this.rpc('dsh/terminal/run', args ?? {}, signal);
  }

  async openTerminal(signal) {
    return this.rpc('dsh/terminal/open', {}, signal);
  }

  async focusTerminal(args, signal) {
    return this.rpc('dsh/terminal/focus', args ?? {}, signal);
  }

  close(reason = 'bridge closed') {
    this.closedByUser = true;
    this.rejectAll(new Error(reason));
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
    /** Persisted logical selection for this session, or null before resolution. */
    this.selection = opts.selection ?? null;
    /** Where the active target came from: 'session' | 'workspace' | 'workspace-last' | null. */
    this.targetSource = this.selection?.source ?? (this.selection ? 'session' : null);
    /** Guards overlapping connect attempts for this session. */
    this.connecting = null;
    /** Invalidates stale onClose callbacks after a manual switch. */
    this.switchToken = 0;
    /** Last connection failure message for user-facing status. */
    this.lastError = null;
    /** Vault roots of the currently selected bridge (from its lock file). */
    this.workspaceFolders = [];
    /** Mirrors the mv-agent setting `reviewOutsideVault` on the live bridge. */
    this.reviewOutsideVault = false;
    /** Mirrors the mv-agent setting `terminalAwarenessEnhanced`. */
    this.terminalAwarenessEnhanced = true;
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

  /** Switch this session to a manual target (null = auto) and reconnect. */
  async setTarget(selection) {
    if (this.disposed) return;
    if (this.connecting) {
      await this.connecting.catch(() => {});
    }
    if (this.disposed) return;
    this.selection = selection ?? null;
    this.targetSource = selection?.source ?? (selection ? 'session' : null);
    this.switchToken += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.client) {
      const old = this.client;
      this.client = null;
      old.close('bridge target changed');
      this.onGeneration(null, []);
    }
    this.attempts = 0;
    this.delay = RECONNECT_POLICY.initialDelayMs;
    void this.connectOnce();
  }

  async connectOnce() {
    if (this.disposed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectAttempt();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connectAttempt() {
    const token = this.switchToken;
    const workspace = await this.resolveWorkspace().catch(() => undefined);
    const bridges = await discoverBridges().catch(() => []);
    let resolved;
    if (this.selection) {
      // A persisted conversation choice is the strongest signal and must not
      // silently downgrade to a workspace default when its vault is offline.
      resolved = resolveBridgeTarget(bridges, { selection: this.selection });
      if (!resolved) {
        this.lastError = `manual bridge not found (vault ${this.selection.workspaceFolders?.join(' | ') || 'unknown'}, last port ${this.selection.port ?? '?'})`;
        this.onLog(`mv-aide bridge: ${this.lastError}`);
        this.scheduleRetry(this.lastError);
        return;
      }
    } else {
      let workspaceSelection = null;
      if (typeof workspace === 'string' && workspace.length > 0) {
        workspaceSelection = await loadLatestBridgeSelectionForWorkspace(workspace).catch(() => null);
      }
      resolved = resolveBridgeTarget(bridges, { workspace, workspaceSelection });
    }
    if (!resolved) {
      this.lastError = this.selection
        ? `manual bridge not found (vault ${this.selection.workspaceFolders?.join(' | ') || 'unknown'}, last port ${this.selection.port ?? '?'})`
        : 'no matching mv-AIDE bridge for this session (use /mv-aide connect to choose one)';
      this.onLog(`mv-aide bridge: ${this.lastError}`);
      if (this.selection) this.scheduleRetry(this.lastError);
      return;
    }
    const target = resolved.bridge;
    this.lastError = null;
    this.targetSource = this.selection?.source ?? resolved.source;
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
          const terminalAwarenessEnhanced = notification?.params?.terminalAwarenessEnhanced;
          if (typeof terminalAwarenessEnhanced === 'boolean') {
            this.terminalAwarenessEnhanced = terminalAwarenessEnhanced;
          }
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
      this.terminalAwarenessEnhanced = client.terminalAwarenessEnhanced !== false;
      this.pushLocation = client.pushLocation !== false;
      this.pushSelection = client.pushSelection !== false;
      this.outsideToolPolicy = client.outsideToolPolicy;
      const tools = await client.listTools();
      if (this.disposed || token !== this.switchToken) {
        client.close();
        return;
      }
      this.client = client;
      this.attempts = 0;
      this.delay = RECONNECT_POLICY.initialDelayMs;
      this.onGeneration(client, tools);

      const onClose = () => {
        if (this.disposed || token !== this.switchToken) return;
        if (this.client === client) {
          this.client = null;
          this.onGeneration(null, []);
        }
        this.scheduleRetry('bridge disconnected');
      };
      client.socket?.once('close', onClose);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onLog(`mv-aide bridge connect failed: ${this.lastError}`);
      client.close();
      this.scheduleRetry(this.lastError);
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
      port: this.client?.port ?? null,
      workspaceFolders: this.workspaceFolders,
      manual: this.selection?.source === 'manual' || (this.selection !== null && !this.selection.source),
      source: this.targetSource,
      lastError: this.lastError,
    };
  }

  dispose(reason = 'bridge closed') {
    this.disposed = true;
    this.switchToken += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.client?.close(reason);
    this.client = null;
    this.targetSource = null;
    this.onGeneration(null, []);
  }
}
