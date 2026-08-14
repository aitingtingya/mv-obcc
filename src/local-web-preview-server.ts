// 本地网页预览服务器：一个完全独立的 127.0.0.1 HTTP 服务，把本地网页目录
// 以受控方式喂给 Obsidian 内置 web viewer。
//
// 为什么需要它：Obsidian 主进程对每个 webview 挂了 will-navigate，凡不是
// http/https 的导航一律 preventDefault()，因此 file:// 无法直接进入内置
// 浏览器。这里的服务把 file:// 转成 http://127.0.0.1:<port>/...。
//
// 模块边界：与 bridge-server 完全解耦。功能关闭时不创建实例、不监听端口，
// bridge-server.ts / syncLocalServices / shouldRunLocalServer 均不修改。

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export const LOCAL_PREVIEW_SERVER_HOST = "127.0.0.1";
// bridge server 占用 47000-48499、universal MCP 占用 48500-49999；
// 本地预览使用独立的 45500-46999 段，保证 localStorage 按 vault 稳定。
export const LOCAL_PREVIEW_PORT_BASE = 45500;
export const LOCAL_PREVIEW_PORT_SPAN = 1500;

export interface LocalPreviewRoot {
  /** 入口文件所在目录的 realpath；所有请求必须落在这个目录内。 */
  rootReal: string;
  /** 请求路径为空时回退的入口文件名（例如 index.html）。 */
  entryName: string;
}

export interface LocalPreviewServerOptions {
  token: string;
  resolveRoot: (sessionId: string) => LocalPreviewRoot | null;
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xhtml: "application/xhtml+xml",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function isWithinRoot(realPath: string, rootReal: string): boolean {
  if (realPath === rootReal) return true;
  const prefix = rootReal.endsWith(path.sep)
    ? rootReal
    : rootReal + path.sep;
  if (process.platform === "win32") {
    return realPath.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return realPath.startsWith(prefix);
}

function plainError(
  response: http.ServerResponse,
  status: number,
): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end();
}

export class LocalPreviewServer {
  private server: http.Server | null = null;
  port = 0;

  constructor(private readonly options: LocalPreviewServerOptions) {}

  async start(preferredPort: number): Promise<number> {
    if (this.server) {
      throw new Error("Local preview server is already running.");
    }
    this.server = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.port =
      preferredPort === 0
        ? await this.listenOn(0)
        : await this.listenAvailable(preferredPort);
    return this.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }

    const rawPath = (request.url ?? "").split("?")[0];
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      plainError(response, 400);
      return;
    }

    const segments = pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    if (segments[0] !== this.options.token) {
      plainError(response, 404);
      return;
    }
    const sessionId = segments[1] ?? "";
    const root = sessionId ? this.options.resolveRoot(sessionId) : null;
    if (!root) {
      plainError(response, 404);
      return;
    }

    const relativePieces = segments
      .slice(2)
      .join("/")
      .split(/[\\/]+/)
      .filter((piece) => piece.length > 0);
    if (relativePieces.some((piece) => piece === "." || piece === "..")) {
      plainError(response, 404);
      return;
    }
    if (root.entryName.includes("/") || root.entryName.includes("\\")) {
      plainError(response, 404);
      return;
    }
    const relativePath = relativePieces.length
      ? path.join(...relativePieces)
      : root.entryName;
    const candidate = path.resolve(root.rootReal, relativePath);

    let realPath: string;
    try {
      realPath = fs.realpathSync(candidate);
    } catch {
      plainError(response, 404);
      return;
    }
    if (!isWithinRoot(realPath, root.rootReal)) {
      plainError(response, 404);
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realPath);
    } catch {
      plainError(response, 404);
      return;
    }
    if (!stat.isFile()) {
      plainError(response, 404);
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(realPath);
    } catch {
      plainError(response, 404);
      return;
    }
    response.writeHead(200, {
      "content-type": contentTypeFor(realPath),
      "content-length": String(buffer.length),
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(buffer);
  }

  private listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Local preview server is not initialized."));
        return;
      }
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        const address = this.server?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, LOCAL_PREVIEW_SERVER_HOST);
    });
  }

  private async listenAvailable(preferred: number): Promise<number> {
    for (let offset = 0; offset < LOCAL_PREVIEW_PORT_SPAN; offset += 1) {
      const candidate =
        LOCAL_PREVIEW_PORT_BASE +
        ((preferred - LOCAL_PREVIEW_PORT_BASE + offset) %
          LOCAL_PREVIEW_PORT_SPAN);
      if (await isPortAvailable(candidate)) {
        await this.listenOn(candidate);
        return candidate;
      }
    }
    throw new Error("No local port is available for MV AIDE local preview.");
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () =>
      tester.close(() => resolve(true)),
    );
    tester.listen(port, LOCAL_PREVIEW_SERVER_HOST);
  });
}
