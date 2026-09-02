/**
 * Plugin-owned loopback reverse proxy for one authenticated DSH web endpoint.
 *
 * Why this exists (root cause, verified against real headless Chromium): the
 * mv-agent iframe is a cross-site context (top-level `app://obsidian.md` →
 * frame `http://127.0.0.1:<port>`), and Chromium never attaches a
 * `SameSite=Strict` cookie to requests fired from a cross-site iframe. Alpha
 * DSH mints exactly such a cookie during the launch-token exchange, so the
 * post-303 document fetch always arrives cookie-less and the endpoint answers
 * its 401 body — regardless of whether the iframe was pointed at the token
 * URL or the plain identity URL.
 *
 * Fix without touching the vendored DSH process: load the iframe from a
 * same-site plugin-owned loopback origin and terminate DSH authentication
 * server-side. The proxy owns the session cookie in memory and rewrites every
 * hop so the vendored fences stay satisfied:
 *
 * - `Host` is rewritten to the upstream authority (the cookie name and its
 *   signed audience are derived from it — see browser-auth.ts
 *   `requestAuthority` / `cookieName`).
 * - `Origin` is synthesized to the upstream origin, not forwarded. A direct
 *   browser would attach exactly this Origin (the SPA is same-origin with its
 *   own host), and every fence on the other side compares Origin against
 *   Host: the vendored `/api` fence accepts a matching Origin, and the
 *   mv-agent active-session control fence *requires* a present, matching
 *   Origin. Forwarding the iframe's proxy-origin or dropping the header
 *   entirely would both be rejected there.
 * - `sec-fetch-site` is rewritten to `same-origin` (the fence refuses an
 *   explicit `cross-site` marker).
 * - The minted `Cookie` replaces any client-supplied cookie header.
 *
 * Every `/api/` WebSocket upgrade is tunneled, not just the vendored one:
 * the SPA opens both `/api/remote.mux` (api-gateway REMOTE_STREAM_MUX_PATH)
 * and `/api/mv-agent/active-session` (mv-agent browser control socket), and
 * both pass the same `requestRejection`-style Host/Origin fences with the
 * header treatment below before being tunneled byte-for-byte. Unregistered
 * `/api/` paths are destroyed by the vendored webserver's exact-path
 * upgrade dispatch, so tunneling cannot invent routes upstream.
 */

import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

/** The vendored marker the SPA root document always carries. */
const DSH_WEB_MARKER = "__DSH_BOOT__";
/** Exact 401 body marker the vendored auth layer emits. */
const AUTH_REQUIRED_MARKER = "dsh web authentication required";
/** Prefix of every WebSocket upgrade path the SPA may open. */
const WS_UPGRADE_API_PREFIX = "/api/";
/** Hop-by-hop headers the proxy owns; client values are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface DshWebProxyDeps {
  /** Called once when the upstream starts answering 401 to the held cookie. */
  readonly onUnauthorized?: () => void;
}

interface Session {
  /** Minted `name=value` cookie pair, or "" when the endpoint needs no auth. */
  readonly cookie: string;
  /** The launch URL whose token minted this session (redacted in output). */
  readonly launchUrl: string;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly res: IncomingMessage;
}

/**
 * The surface DshProcessManager consumes. Real proxies are {@link DshWebProxy};
 * tests substitute fakes to assert lifecycle without sockets.
 */
export interface DshWebProxyLike {
  readonly upstream: string;
  readonly url: string | null;
  readonly ready: boolean;
  start(): Promise<string>;
  ensureExchanged(launchUrl: string): Promise<void>;
  invalidateExchange(): void;
  stop(): void;
}

export class DshWebProxy {
  private readonly onUnauthorized?: () => void;
  private readonly upstreamUrl: URL;
  private readonly upstreamAuthority: string;
  private readonly sockets = new Set<Duplex>();
  private server: http.Server | null = null;
  private listeningUrl: string | null = null;
  private exchangePromise: Promise<void> | null = null;
  private session: Session | null = null;

  constructor(upstream: string, deps: DshWebProxyDeps = {}) {
    this.onUnauthorized = deps.onUnauthorized;
    const parsed = parseUpstream(upstream);
    this.upstreamUrl = parsed;
    this.upstreamAuthority = parsed.host;
  }

  /** The real DSH endpoint this proxy fronts (semantic identity URL). */
  get upstream(): string {
    return `${this.upstreamUrl.origin}/`;
  }

  /** The proxy origin (`http://127.0.0.1:<port>/`) once started, else null. */
  get url(): string | null {
    return this.listeningUrl;
  }

  /** Whether a session cookie is held (call ensureExchanged first). */
  get ready(): boolean {
    return this.session !== null;
  }

  /**
   * Bind the proxy on an OS-assigned loopback port. Idempotent per instance.
   */
  async start(): Promise<string> {
    if (this.server) return this.listeningUrl ?? upstreamError("proxy server has no listening URL");
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
    server.on("connection", (socket: Duplex) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("dsh web proxy failed to bind a loopback port");
    }
    this.server = server;
    this.listeningUrl = `http://127.0.0.1:${address.port}/`;
    return this.listeningUrl;
  }

  /**
   * Exchange the launch token for a session cookie and verify the minted
   * cookie serves the SPA root. Concurrent callers share one exchange; an
   * exchange for the same launch URL is a no-op, a different launch URL
   * (token rotation after an upstream restart) re-exchanges.
   */
  async ensureExchanged(launchUrl: string): Promise<void> {
    const launch = parseUpstream(launchUrl);
    if (this.session && launch.href === this.session.launchUrl) return;
    if (this.exchangePromise) return this.exchangePromise;
    this.exchangePromise = this.exchangeToken(launch)
      .finally(() => {
        this.exchangePromise = null;
      });
    return this.exchangePromise;
  }

  /** Force the next ensureExchanged to redeem the current launch token. */
  invalidateExchange(): void {
    this.session = null;
  }

  /** Tear down the server and every live socket. Idempotent. */
  stop(): void {
    const server = this.server;
    this.server = null;
    this.listeningUrl = null;
    this.session = null;
    this.exchangePromise = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) server.close();
  }

  /**
   * Perform one upstream GET with the proxy's header discipline and the held
   * session cookie attached. Exposed for acceptance tests probing the real
   * binary through production code paths.
   */
  requestUpstream(pathAndQuery: string, headers: Record<string, string> = {}): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          protocol: this.upstreamUrl.protocol,
          hostname: this.upstreamUrl.hostname,
          port: this.upstreamUrl.port,
          method: "GET",
          path: pathAndQuery,
          setHost: false,
          headers: {
            ...headers,
            host: this.upstreamAuthority,
            ...(this.session?.cookie ? { cookie: this.session.cookie } : {}),
          },
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            res,
          });
        },
      );
      request.once("error", reject);
      request.setTimeout(15_000, () => request.destroy(new Error("dsh web proxy upstream timeout")));
      request.end();
    });
  }

  private async exchangeToken(launch: URL): Promise<void> {
    const response = await this.requestUpstream(launch.pathname + launch.search);
    const status = response.status;
    if (status === 200) {
      // No-auth endpoints (preview) serve the root directly; the proxy is not
      // used for them in practice, but keep the contract explicit.
      const body = await readProxyBody(response.res);
      if (body.includes(DSH_WEB_MARKER)) {
        this.session = { cookie: "", launchUrl: launch.href };
        return;
      }
      throw new Error(`dsh 授权交换失败（HTTP ${String(status)}，无启动标记）。`);
    }
    if (status === 303 || status === 302 || status === 307 || status === 308) {
      const cookie = firstCookie(response.headers["set-cookie"]);
      if (!cookie) throw new Error("dsh 授权响应未携带会话 Cookie。");
      this.session = { cookie, launchUrl: launch.href };
      // Verify the minted cookie actually serves the SPA root.
      const verify = await this.requestUpstream("/");
      const verifyBody = await readProxyBody(verify.res);
      if (verify.status !== 200 || !verifyBody.includes(DSH_WEB_MARKER)) {
        this.session = null;
        throw new Error(`dsh 会话 Cookie 验证失败（HTTP ${String(verify.status)}）。`);
      }
      return;
    }
    throw new Error(`dsh 授权交换失败（HTTP ${String(status)}）。`);
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.session) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("mv-agent proxy has no session yet.");
        return;
      }
      const request = http.request(
        {
          protocol: this.upstreamUrl.protocol,
          hostname: this.upstreamUrl.hostname,
          port: this.upstreamUrl.port,
          method: req.method ?? "GET",
          path: req.url ?? "/",
          setHost: false,
          headers: this.buildUpstreamHeaders(req),
        },
        (upstream) => {
          const status = upstream.statusCode ?? 502;
          if (status === 401) {
            void readProxyBody(upstream).then((body) => {
              if (body.includes(AUTH_REQUIRED_MARKER)) this.onUnauthorized?.();
            }).catch(() => undefined);
          }
          res.writeHead(status, filterResponseHeaders(upstream.headers));
          upstream.pipe(res);
          upstream.once("error", () => res.destroy());
        },
      );
      request.once("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("mv-agent proxy upstream failure.");
      });
      req.pipe(request);
      req.once("error", () => request.destroy());
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("mv-agent proxy failure.");
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const requestUrl = req.url ?? "/";
    if (!new URL(requestUrl, "http://dsh.invalid").pathname.startsWith(WS_UPGRADE_API_PREFIX)) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!this.session) {
      rejectUpgrade(socket, 503);
      return;
    }
    const request = http.request(
      {
        protocol: this.upstreamUrl.protocol,
        hostname: this.upstreamUrl.hostname,
        port: this.upstreamUrl.port,
        method: req.method ?? "GET",
        path: requestUrl,
        setHost: false,
        headers: {
          ...this.buildUpstreamHeaders(req),
          connection: "Upgrade",
          upgrade: websocketHeaderValue(req.headers.upgrade),
        },
      },
    );
    request.once("upgrade", (res, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/1.1 ${String(res.statusCode ?? 101)} ${res.statusMessage ?? "Switching Protocols"}`;
      const headerLines = Object.entries(res.headers)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
      socket.write(`${statusLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      const kill = (): void => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.once("error", kill);
      socket.once("error", kill);
      upstreamSocket.once("close", () => socket.destroy());
      socket.once("close", () => upstreamSocket.destroy());
    });
    request.once("response", (res) => {
      res.resume();
      res.once("end", () => rejectUpgrade(socket, res.statusCode ?? 502));
    });
    request.once("error", () => rejectUpgrade(socket, 502));
    request.end();
  }

  /**
   * The proxy's header discipline: hop-by-hop and browser-marking headers are
   * dropped, Host is rewritten to the upstream authority, `Origin` is
   * synthesized to the upstream origin (what a direct same-origin browser
   * would attach; the active-session control fence requires it present and
   * matching Host), `sec-fetch-site` becomes `same-origin`, and the held
   * session cookie replaces any client cookie.
   */
  private buildUpstreamHeaders(req: IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === "host" || lower === "origin" || lower === "cookie" || lower === "sec-fetch-site") continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    headers.host = this.upstreamAuthority;
    headers.origin = `${this.upstreamUrl.origin}`;
    headers["sec-fetch-site"] = "same-origin";
    if (this.session?.cookie) headers.cookie = this.session.cookie;
    return headers;
  }
}

function websocketHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ") || "websocket";
  return value || "websocket";
}

function parseUpstream(raw: string): URL {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") throw new Error("not http");
    return url;
  } catch {
    throw new Error(`invalid DSH upstream URL: ${redactSecrets(raw)}`);
  }
}

function firstCookie(setCookie: string[] | string | undefined): string | null {
  if (!setCookie) return null;
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!first) return null;
  const pair = first.split(";", 1)[0];
  return pair && pair.includes("=") ? pair.trim() : null;
}

export function readProxyBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    res.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.once("error", reject);
  });
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    filtered[name] = value;
  }
  return filtered;
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 404 ? "Not Found" : status === 503 ? "Service Unavailable" : "Bad Gateway";
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function redactSecrets(value: string): string {
  return value.replace(/([?&](?:token|access_token|auth|authorization)=)[^&\s]+/giu, "$1<redacted>");
}

function upstreamError(message: string): never {
  throw new Error(message);
}
