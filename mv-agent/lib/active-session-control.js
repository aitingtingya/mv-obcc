// Browser-to-host control plane for mv-agent's "open conversations only"
// invariant. Each live DSH frontend owns one WebSocket and reports the single
// session currently staged in that frontend. The union of those reports is
// the only set of sessions allowed to own an Obsidian bridge supervisor.

import WebSocket, { WebSocketServer } from 'ws';

export const ACTIVE_SESSION_PATH = '/api/mv-agent/active-session';
export const ACTIVE_SESSION_MAX_PAYLOAD = 8192;
export const ACTIVE_SESSION_PING_MS = 15000;

function safeCallback(callback, value, onLog) {
  try {
    const result = callback(value);
    if (result && typeof result.then === 'function') {
      void result.catch((error) => {
        onLog(`mv-aide active-session callback failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } catch (error) {
    onLog(`mv-aide active-session callback failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Pure multi-frontend activity registry. A client may have zero or one staged
 * session; a session is active while at least one client stages it.
 */
export class ActiveSessionRegistry {
  constructor(options = {}) {
    this.onActivate = options.onActivate ?? (() => {});
    this.onDeactivate = options.onDeactivate ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.clients = new Map();
    this.sessions = new Map();
  }

  /** Update one frontend, revoking its old session before activating the new one. */
  update(client, report) {
    const nextSessionId = report?.sessionId ?? null;
    const nextCwd = typeof report?.cwd === 'string' && report.cwd.length > 0
      ? report.cwd
      : undefined;
    const previous = this.clients.get(client);
    if (previous?.sessionId === nextSessionId) {
      if (nextSessionId !== null && nextCwd && previous.cwd !== nextCwd) {
        previous.cwd = nextCwd;
        const current = this.sessions.get(nextSessionId);
        if (current) current.cwd = nextCwd;
        safeCallback(
          this.onActivate,
          { sessionId: nextSessionId, cwd: nextCwd },
          this.onLog,
        );
      }
      return;
    }

    if (previous?.sessionId) this.removeViewer(client, previous.sessionId);
    if (nextSessionId === null) {
      this.clients.set(client, { sessionId: null, cwd: undefined });
      return;
    }

    this.clients.set(client, { sessionId: nextSessionId, cwd: nextCwd });
    let session = this.sessions.get(nextSessionId);
    if (!session) {
      session = { viewers: new Set(), cwd: nextCwd };
      this.sessions.set(nextSessionId, session);
    } else if (nextCwd) {
      session.cwd = nextCwd;
    }
    const wasEmpty = session.viewers.size === 0;
    session.viewers.add(client);
    if (wasEmpty) {
      safeCallback(
        this.onActivate,
        { sessionId: nextSessionId, cwd: session.cwd },
        this.onLog,
      );
    }
  }

  /** Remove a frontend and deactivate its session when it was the last viewer. */
  remove(client) {
    const previous = this.clients.get(client);
    this.clients.delete(client);
    if (previous?.sessionId) this.removeViewer(client, previous.sessionId);
  }

  removeViewer(client, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.viewers.delete(client);
    if (session.viewers.size > 0) return;
    this.sessions.delete(sessionId);
    safeCallback(this.onDeactivate, { sessionId }, this.onLog);
  }

  isActive(sessionId) {
    return typeof sessionId === 'string' && this.sessions.has(sessionId);
  }

  reportFor(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? { sessionId, cwd: session.cwd } : null;
  }

  activeSessionIds() {
    return [...this.sessions.keys()];
  }

  clear() {
    const ids = [...this.sessions.keys()];
    this.clients.clear();
    this.sessions.clear();
    for (const sessionId of ids) {
      safeCallback(this.onDeactivate, { sessionId }, this.onLog);
    }
  }
}

function rejectUpgrade(socket, status = '403 Forbidden', body = 'forbidden') {
  const payload = Buffer.from(body, 'utf8');
  socket.end([
    `HTTP/1.1 ${status}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${payload.length}`,
    '',
    body,
  ].join('\r\n'));
}

/** Same-origin, loopback-only guard for the browser control socket. */
export function isTrustedControlRequest(request) {
  const host = request?.headers?.host;
  const origin = request?.headers?.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  try {
    const authority = new URL(`http://${host}`);
    const source = new URL(origin);
    const hostname = authority.hostname.toLowerCase();
    const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    return loopback && source.host === host && (source.protocol === 'http:' || source.protocol === 'https:');
  } catch {
    return false;
  }
}

/** Parse and validate one browser activity frame. */
export function parseActiveSessionReport(data, isBinary = false) {
  if (isBinary) return null;
  let parsed;
  try {
    parsed = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.type !== 'active-session') return null;
  if (parsed.sessionId !== null && (
    typeof parsed.sessionId !== 'string' ||
    parsed.sessionId.length === 0 ||
    parsed.sessionId.length > 256
  )) return null;
  if (parsed.cwd !== undefined && parsed.cwd !== null && (
    typeof parsed.cwd !== 'string' || parsed.cwd.length === 0 || parsed.cwd.length > 4096
  )) return null;
  return {
    sessionId: parsed.sessionId,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
  };
}

/**
 * Mount the exact-path control WebSocket on DSH's webServer service.
 * The returned disposer owns the route, sockets, heartbeat, and registry.
 */
export function mountActiveSessionControl(ctx, options) {
  const webServer = ctx?.get ? ctx.get('webServer') : ctx?.webServer;
  if (!webServer || typeof webServer.registerUpgrade !== 'function') return undefined;
  const registry = options.registry;
  const onLog = options.onLog ?? (() => {});
  const server = new WebSocketServer({ noServer: true, maxPayload: ACTIVE_SESSION_MAX_PAYLOAD });

  const unregister = webServer.registerUpgrade({
    path: ACTIVE_SESSION_PATH,
    handler(request, socket, head) {
      if (!isTrustedControlRequest(request)) {
        rejectUpgrade(socket);
        return;
      }
      server.handleUpgrade(request, socket, head, (websocket) => {
        websocket.mvAideAlive = true;
        websocket.on('pong', () => {
          websocket.mvAideAlive = true;
        });
        websocket.on('message', (data, isBinary) => {
          const report = parseActiveSessionReport(data, isBinary);
          if (!report) {
            websocket.close(1008, 'invalid active-session report');
            return;
          }
          registry.update(websocket, report);
        });
        websocket.once('close', () => registry.remove(websocket));
        websocket.once('error', () => registry.remove(websocket));
      });
    },
  });

  const heartbeat = setInterval(() => {
    for (const websocket of server.clients) {
      if (websocket.mvAideAlive === false) {
        registry.remove(websocket);
        websocket.terminate();
        continue;
      }
      websocket.mvAideAlive = false;
      if (websocket.readyState === WebSocket.OPEN) websocket.ping();
    }
  }, ACTIVE_SESSION_PING_MS);
  heartbeat.unref?.();

  return () => {
    clearInterval(heartbeat);
    unregister();
    for (const websocket of server.clients) {
      registry.remove(websocket);
      websocket.terminate();
    }
    registry.clear();
    try {
      server.close();
    } catch (error) {
      onLog(`mv-aide active-session server close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
