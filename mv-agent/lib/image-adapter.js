import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MAX_REQUEST_IMAGE_EDGE = 2000;
export const MAX_IMAGE_PREPROCESS_BYTES = 16 * 1024 * 1024;
// Decode-pixel ceiling for one raster. Four times the DSH admission default
// (64 MP / 8192px edge), so every image DSH accepts decodes normally while a
// hostile small-byte/pixel-bomb payload cannot exhaust memory.
const MAX_DECODE_PIXELS = 16384 * 16384;
const WRAPPER_MARK = Symbol.for('@mv-aide/mv-agent/image-adapter');
const RUNTIME_REGISTRY = Symbol.for('@mv-aide/runtime-bundle-registry');
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function maxPixelsForLongestEdge(width, height, maxEdge = MAX_REQUEST_IMAGE_EDGE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(maxEdge)) return null;
  const sourceWidth = Math.floor(width);
  const sourceHeight = Math.floor(height);
  const edge = Math.floor(maxEdge);
  if (sourceWidth <= 0 || sourceHeight <= 0 || edge <= 0) return null;
  if (Math.max(sourceWidth, sourceHeight) <= edge) return sourceWidth * sourceHeight;
  const scale = edge / Math.max(sourceWidth, sourceHeight);
  return Math.max(1, Math.floor(sourceWidth * scale)) * Math.max(1, Math.floor(sourceHeight * scale));
}

export function createImagePolicyService() {
  const perSession = new Map();
  return {
    setSession(sessionId, enabled) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      perSession.set(sessionId, enabled === true);
    },
    deleteSession(sessionId) {
      if (typeof sessionId === 'string') perSession.delete(sessionId);
    },
    enabledFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
      return perSession.get(sessionId);
    },
    clear() { perSession.clear(); },
    snapshot() { return new Map(perSession); },
  };
}

function serviceFrom(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
  } catch {
    return undefined;
  }
}

function runIterableInSession(storage, sessionId, iterable) {
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return iterable;
  return (async function* runWithSession() {
    const iterator = iterable[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const step = await storage.run(sessionId, () => iterator.next());
        if (step.done) {
          completed = true;
          return;
        }
        yield step.value;
      }
    } finally {
      if (!completed && typeof iterator.return === 'function') {
        await storage.run(sessionId, () => iterator.return());
      }
    }
  })();
}

function orientedDimensions(metadata) {
  const oriented = metadata?.autoOrient;
  const pageHeight = Number(metadata?.pageHeight);
  const pageCount = Number(metadata?.pages);
  return {
    width: Number(oriented?.width ?? metadata?.width),
    // Sharp exposes animated images as a vertically stacked multi-page image;
    // DSH's 2000px boundary applies to each frame, not that virtual total.
    height: pageCount > 1 && Number.isFinite(pageHeight) && pageHeight > 0
      ? pageHeight
      : Number(oriented?.height ?? metadata?.height),
  };
}

function outputForMediaType(pipeline, mediaType) {
  if (mediaType === 'image/png') return pipeline.png();
  if (mediaType === 'image/jpeg') return pipeline.jpeg();
  if (mediaType === 'image/webp') return pipeline.webp();
  if (mediaType === 'image/gif') return pipeline.gif();
  throw new Error(`unsupported image media type: ${mediaType}`);
}

function loadSharp() {
  const require = createRequire(import.meta.url);
  const loaded = require('sharp');
  return loaded?.default ?? loaded;
}

let sharpProbe;
/**
 * Whether the preprocessing pipeline can run here: an explicitly injected
 * sharp implementation is always usable, otherwise the native module must
 * load. Cached so one failed native load does not retry per request.
 */
function sharpAvailable(fitOptions) {
  if (fitOptions?.sharp) return true;
  if (fitOptions?.probeSharp) return fitOptions.probeSharp() === true;
  if (sharpProbe === undefined) {
    try {
      loadSharp();
      sharpProbe = true;
    } catch {
      sharpProbe = false;
    }
  }
  return sharpProbe;
}

/** Resize one encoded raster without modifying the caller's bytes. */
export async function fitImageBytes(
  data,
  mediaType,
  options = {},
) {
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) throw new Error(`unsupported image media type: ${mediaType}`);
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxEdge = options.maxEdge ?? MAX_REQUEST_IMAGE_EDGE;
  const sharp = options.sharp ?? loadSharp();
  const animated = mediaType === 'image/gif' || mediaType === 'image/webp';
  const decodeOptions = { animated, failOn: 'error', limitInputPixels: MAX_DECODE_PIXELS };
  const input = sharp(bytes, decodeOptions);
  const metadata = await input.metadata();
  const source = orientedDimensions(metadata);
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height)) {
    throw new Error('image dimensions are unavailable');
  }
  if (Math.max(source.width, source.height) <= maxEdge) {
    return { data: bytes, mediaType, width: source.width, height: source.height, resized: false };
  }
  const pipeline = sharp(bytes, decodeOptions)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  const encoded = new Uint8Array(await outputForMediaType(pipeline, mediaType).toBuffer());
  const fittedMetadata = await sharp(encoded, decodeOptions).metadata();
  const fitted = orientedDimensions(fittedMetadata);
  if (!Number.isFinite(fitted.width) || !Number.isFinite(fitted.height) || Math.max(fitted.width, fitted.height) > maxEdge) {
    throw new Error('resized image did not satisfy the 2000px boundary');
  }
  return { data: encoded, mediaType, width: fitted.width, height: fitted.height, resized: true };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new Error(`image exceeds preprocessing byte limit (${limit})`);
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function sameOriginLoopback(req) {
  const host = req?.headers?.host;
  const origin = req?.headers?.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  try {
    const authority = new URL(`http://${host}`);
    const source = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname.toLowerCase())
      && source.host === host
      && (source.protocol === 'http:' || source.protocol === 'https:');
  } catch {
    return false;
  }
}

/** Loopback check for non-browser callers that never send an Origin header. */
function loopbackHost(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string') return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

async function bundleDescriptor(packageRoot) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(packageRoot, '.mv-aide-bundle.json'), 'utf8'));
    return {
      schema: marker?.schema,
      fingerprint: typeof marker?.fingerprint === 'string' ? marker.fingerprint : null,
      mvAideVersion: typeof marker?.mvAideVersion === 'string' ? marker.mvAideVersion : null,
    };
  } catch {
    return { schema: null, fingerprint: null, mvAideVersion: null };
  }
}

async function runtimeDescriptor() {
  const agentRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return bundleDescriptor(agentRoot);
}

function publishRuntimeDescriptor(ctx) {
  const registry = process[RUNTIME_REGISTRY] ?? {};
  process[RUNTIME_REGISTRY] = registry;
  const descriptor = runtimeDescriptor();
  registry.agent = descriptor;
  ctx?.effect?.(() => () => {
    if (registry.agent === descriptor) delete registry.agent;
  }, 'mv-agent: runtime bundle identity');
  return registry;
}

function installWebRoutes(ctx, service, fitOptions, runtimeRegistry) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = serviceFrom(webCtx, 'webServer');
    if (!webServer || typeof webServer.register !== 'function') return;
    const unregister = webServer.register({
      kind: 'prefix',
      path: '/api/mv-agent',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname === '/api/mv-agent/runtime' && req.method === 'GET') {
          // Desktop callers (requestUrl) send no Origin header, so accept any
          // loopback Host; remote hosts are rejected like the fit route.
          if (!loopbackHost(req)) {
            req.resume?.();
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
            return;
          }
          const [agent, manager] = await Promise.all([
            runtimeRegistry.agent ?? Promise.resolve(null),
            runtimeRegistry.manager ?? Promise.resolve(null),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ schema: 1, agent, manager }));
          return;
        }
        if (url.pathname !== '/api/mv-agent/image-fit' || req.method !== 'POST') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'not found' }));
          return;
        }
        if (!sameOriginLoopback(req)) {
          req.resume?.();
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
          return;
        }
        const sessionId = url.searchParams.get('sessionId');
        const enabled = service.enabledFor(sessionId ?? undefined);
        if (enabled !== true) {
          req.resume?.();
          res.writeHead(204);
          res.end();
          return;
        }
        if (!sharpAvailable(fitOptions)) {
          // The preprocessing feature cannot run in this runtime; keep DSH's
          // native upload path instead of failing the user's send.
          req.resume?.();
          res.writeHead(204);
          res.end();
          return;
        }
        const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        try {
          const body = await readBody(req, MAX_IMAGE_PREPROCESS_BYTES);
          const fitted = await fitImageBytes(body, mediaType, fitOptions);
          if (!fitted.resized) {
            // Nothing changed; the caller keeps its original bytes and skips
            // re-wrapping them.
            res.writeHead(204);
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': fitted.mediaType,
            'Content-Length': String(fitted.data.byteLength),
            'X-Mv-Aide-Image-Resized': '1',
          });
          res.end(Buffer.from(fitted.data));
        } catch (error) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
    });
    if (typeof unregister === 'function' && typeof webCtx.effect === 'function') {
      webCtx.effect(() => unregister, 'mv-agent: image preprocessing routes');
    }
  });
}

/** Install upload policy, historical-request fitting, and local routes. */
export function installImageAdapter(ctx, options = {}) {
  const service = createImagePolicyService();
  const requestSession = new AsyncLocalStorage();
  const runtimeRegistry = publishRuntimeDescriptor(ctx);
  installWebRoutes(ctx, service, options, runtimeRegistry);

  if (typeof ctx?.inject === 'function') {
    ctx.inject(['llm'], (llmCtx) => {
      if (typeof llmCtx?.on !== 'function') return;
      llmCtx.on('llm/stream', (options, next) => {
        const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : null;
        return runIterableInSession(requestSession, sessionId, next());
      }, { global: true });
    });
    ctx.inject(['attachments'], (attachmentCtx) => {
      const attachments = serviceFrom(attachmentCtx, 'attachments');
      if (!attachments || typeof attachments.readImageRequest !== 'function') return;
      const current = attachments.readImageRequest;
      if (current?.[WRAPPER_MARK]) return;
      // Compatibility protection for oversized historical attachments lives at
      // the model-request stage only. The generic readImage stays DSH-native,
      // so every stored ref keeps matching its verified bytes (digest checks,
      // session export, and proxy reads are untouched).
      const wrapper = async function readImageRequestWithMvAideFit(ref, policy, signal) {
        const version = await current.call(this, ref, policy, signal);
        const sessionId = requestSession.getStore();
        if (service.enabledFor(typeof sessionId === 'string' ? sessionId : undefined) !== true) return version;
        if (Math.max(Number(version?.width), Number(version?.height)) <= MAX_REQUEST_IMAGE_EDGE) return version;
        let fitted;
        try {
          fitted = await fitImageBytes(version.data, version.mediaType, options);
        } catch {
          // The compatibility shim must never break the model request.
          return version;
        }
        if (!fitted.resized) return version;
        return {
          ...version,
          data: fitted.data,
          bytes: fitted.data.byteLength,
          width: fitted.width,
          height: fitted.height,
          // Keep the request identity bound to the delivered bytes.
          variantId: `sha256:${createHash('sha256').update(fitted.data).digest('hex')}`,
        };
      };
      Object.defineProperty(wrapper, WRAPPER_MARK, { value: { original: current } });
      attachments.readImageRequest = wrapper;
      if (typeof attachmentCtx.effect === 'function') {
        attachmentCtx.effect(() => () => {
          if (attachments.readImageRequest === wrapper) attachments.readImageRequest = current;
        }, 'mv-agent: historical image request adapter');
      }
    });
  }
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => service.clear(), 'mv-agent: clear image policy');
  }
  return service;
}
