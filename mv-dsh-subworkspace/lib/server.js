// Same-origin browser API and independent runtime descriptor endpoint.

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const API_PREFIX = '/api/mv-dsh-subworkspace';

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function allowedRequest(req) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  const host = req.headers?.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  return value;
}

async function runtimeDescriptor() {
  try {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const marker = JSON.parse(await fs.readFile(path.join(packageRoot, '.mv-aide-bundle.json'), 'utf8'));
    return {
      schema: marker?.schema ?? null,
      fingerprint: typeof marker?.fingerprint === 'string' ? marker.fingerprint : null,
      mvAideVersion: typeof marker?.mvAideVersion === 'string' ? marker.mvAideVersion : null,
    };
  } catch {
    return { schema: null, fingerprint: null, mvAideVersion: null };
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function installSubworkspaceServer(ctx, store) {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = typeof webCtx.get === 'function' ? webCtx.get('webServer') : webCtx.webServer;
    if (!webServer?.register) return;
    const unregister = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (!allowedRequest(req)) {
          req.resume?.();
          sendJson(res, 403, { ok: false, error: 'forbidden' });
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        try {
          if (req.method === 'GET' && url.pathname === `${API_PREFIX}/runtime`) {
            sendJson(res, 200, { ok: true, runtime: await runtimeDescriptor() });
            return;
          }
          if (req.method === 'GET' && url.pathname === `${API_PREFIX}/roots`) {
            const primary = requireString(url.searchParams.get('primary'), 'primary');
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            const listed = await store.list(primary, sessionId);
            sendJson(res, 200, {
              ok: true,
              primaryPath: listed.primaryPath,
              // resolveRoots distinguishes explicit disabled from a no-flag
              // record; trust that decision rather than reinterpreting it.
              enabled: listed.enabled === false ? false : true,
              currentWorkspaceId: listed.currentWorkspaceId,
              roots: listed.roots.map(({ identity: _identity, ...root }) => root),
            });
            return;
          }
          if (req.method === 'POST' && url.pathname === `${API_PREFIX}/enabled`) {
            const body = await readBody(req);
            if (typeof body.enabled !== 'boolean') throw new Error('enabled must be a boolean');
            const result = await store.setEnabled(
              requireString(body.primary, 'primary'),
              body.enabled,
            );
            sendJson(res, 200, { ok: true, enabled: result.enabled });
            return;
          }
          if (req.method === 'POST' && url.pathname === `${API_PREFIX}/roots`) {
            const body = await readBody(req);
            const child = await store.add(
              requireString(body.primary, 'primary'),
              requireString(body.path, 'path'),
            );
            sendJson(res, 200, { ok: true, child });
            return;
          }
          if (req.method === 'DELETE' && url.pathname === `${API_PREFIX}/roots`) {
            const body = await readBody(req);
            await store.remove(
              requireString(body.primary, 'primary'),
              requireString(body.workspaceId, 'workspaceId'),
            );
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
    webCtx.effect?.(() => unregister, 'mv-dsh-subworkspace: browser API');
  });
}
