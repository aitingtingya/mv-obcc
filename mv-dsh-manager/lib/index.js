// @mv-aide/mv-dsh-manager
// DSH Runtime Manager Plugin for Plugins, Skills, and Subagents

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listPlugins, togglePlugin, deletePlugin, importPlugin, openPluginFolder } from './plugins-service.js';
import { listSkills, toggleSkill, importSkill, deleteSkill, openSkillFolder } from './skills-service.js';
import { listPresets, togglePreset, copyPreset, deletePreset, openPresetDocument } from './presets-service.js';
import { discoverBridges, listTools } from './bridge-service.js';
import { installPlanReviewControl } from './plan-review-control.js';
import { createModelCapabilitiesService, ModelCapabilitiesError } from './model-capabilities-service.js';
import { UI_SCRIPT_TAG } from './ui-script.js';

export const name = 'mv-dsh-manager';
export const inject = ['webServer'];

const RUNTIME_REGISTRY = Symbol.for('@mv-aide/runtime-bundle-registry');

function isSameOriginBrowserRequest(req) {
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

async function runtimeDescriptor() {
  try {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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

function publishRuntimeDescriptor(ctx) {
  const registry = process[RUNTIME_REGISTRY] ?? {};
  process[RUNTIME_REGISTRY] = registry;
  const descriptor = runtimeDescriptor();
  registry.manager = descriptor;
  ctx.effect?.(() => () => {
    if (registry.manager === descriptor) delete registry.manager;
  }, 'mv-dsh-manager: runtime bundle identity');
}

export function apply(ctx) {
  publishRuntimeDescriptor(ctx);
  installPlanReviewControl(ctx);

  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('webServer service not available; mv-dsh-manager API will not be mounted.');
    return;
  }
  const modelCapabilities = createModelCapabilitiesService(ctx);

  // ─────────────────────────────────────────────────────────────
  // 1. Unified Router for /api/mv-aide/*
  // ─────────────────────────────────────────────────────────────

  webServer.register({
    kind: 'prefix',
    path: '/api/mv-aide',
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      const sendJson = (status, data) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end(JSON.stringify(data));
      };

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      const readJsonBody = () =>
        new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch (err) {
              reject(err);
            }
          });
          req.on('error', reject);
        });

      try {
        // ── llm-pi-ai model capability API ──
        if (pathname.startsWith('/api/mv-aide/model-capabilities') && !isSameOriginBrowserRequest(req)) {
          return sendJson(403, { ok: false, error: 'Model capability settings are same-origin only.' });
        }

        if (pathname === '/api/mv-aide/model-capabilities' && method === 'GET') {
          const data = await modelCapabilities.describe(url.searchParams.get('provider'));
          return sendJson(200, data);
        }

        if (pathname === '/api/mv-aide/model-capabilities/apply' && method === 'POST') {
          const payload = await readJsonBody();
          const data = await modelCapabilities.apply(payload);
          return sendJson(200, data);
        }

        // ── Plugins API ──
        if (pathname === '/api/mv-aide/plugins' && method === 'GET') {
          const data = listPlugins(ctx);
          return sendJson(200, data);
        }

        if (pathname === '/api/mv-aide/plugins/toggle' && method === 'POST') {
          const payload = await readJsonBody();
          const { entryId, disabled } = payload;
          if (!entryId) return sendJson(400, { ok: false, error: 'entryId is required' });
          const result = await togglePlugin(ctx, entryId, disabled);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/plugins/import' && method === 'POST') {
          const payload = await readJsonBody();
          const { spec } = payload;
          const result = await importPlugin(ctx, spec);
          return sendJson(200, result);
        }

        if (pathname.startsWith('/api/mv-aide/plugins/') && method === 'DELETE') {
          const entryId = decodeURIComponent(pathname.replace('/api/mv-aide/plugins/', '').split('?')[0]);
          const force = url.searchParams.get('force') === 'true';
          const result = await deletePlugin(ctx, entryId, force);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/plugins/open-folder' && method === 'POST') {
          const payload = await readJsonBody();
          const result = await openPluginFolder(payload.pluginId);
          return sendJson(200, result);
        }

        // ── Skills API ──
        if (pathname === '/api/mv-aide/skills' && method === 'GET') {
          const data = await listSkills(ctx);
          return sendJson(200, data);
        }

        if (pathname === '/api/mv-aide/skills/toggle' && method === 'POST') {
          const payload = await readJsonBody();
          const { skillId, disabled } = payload;
          if (!skillId) return sendJson(400, { ok: false, error: 'skillId is required' });
          const result = await toggleSkill(ctx, skillId, disabled);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/skills/import' && method === 'POST') {
          const payload = await readJsonBody();
          const { name: skillName, description, content } = payload;
          const result = await importSkill(ctx, skillName, description, content);
          return sendJson(200, result);
        }

        if (pathname.startsWith('/api/mv-aide/skills/') && method === 'DELETE') {
          const skillId = decodeURIComponent(pathname.replace('/api/mv-aide/skills/', '').split('?')[0]);
          const result = await deleteSkill(ctx, skillId);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/skills/open-folder' && method === 'POST') {
          const payload = await readJsonBody();
          const result = await openSkillFolder(ctx, payload.skillId);
          return sendJson(200, result);
        }

        // ── Presets API ──
        if (pathname === '/api/mv-aide/presets' && method === 'GET') {
          const data = await listPresets(ctx);
          return sendJson(200, data);
        }

        if (pathname === '/api/mv-aide/presets/toggle' && method === 'POST') {
          const payload = await readJsonBody();
          const { presetId, disabled } = payload;
          if (!presetId) return sendJson(400, { ok: false, error: 'presetId is required' });
          const result = await togglePreset(ctx, presetId, disabled);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/presets/copy' && method === 'POST') {
          const payload = await readJsonBody();
          const { sourceId, newId, name: presetName, description } = payload;
          const result = await copyPreset(ctx, sourceId, newId, presetName, description);
          return sendJson(200, result);
        }

        if (pathname.startsWith('/api/mv-aide/presets/') && method === 'DELETE') {
          const presetId = decodeURIComponent(pathname.replace('/api/mv-aide/presets/', '').split('?')[0]);
          const force = url.searchParams.get('force') === 'true';
          const result = await deletePreset(ctx, presetId, force);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/presets/open-document' && method === 'POST') {
          const payload = await readJsonBody();
          const result = await openPresetDocument(ctx, payload.presetId);
          return sendJson(200, result);
        }

        // ── Recursive slash-command picker API ──
        if (pathname === '/api/mv-aide/bridges' && method === 'GET') {
          const bridges = await discoverBridges();
          return sendJson(200, { bridges });
        }

        if (pathname === '/api/mv-aide/tools' && method === 'GET') {
          return sendJson(200, { tools: listTools() });
        }

        return sendJson(404, { ok: false, error: `Route not found: ${method} ${pathname}` });
      } catch (err) {
        const status = err instanceof ModelCapabilitiesError ? err.status : 500;
        return sendJson(status, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof ModelCapabilitiesError ? { code: err.code } : {}),
        });
      }
    },
  });

  // ─────────────────────────────────────────────────────────────
  // 2. Web UI Client Script Injection (tapIndex)
  // ─────────────────────────────────────────────────────────────

  if (typeof webServer.tapIndex === 'function') {
    webServer.tapIndex((html) => {
      if (html.includes('id="mv-aide-dsh-manager-ui"')) return html;
      return html.replace('</body>', `${UI_SCRIPT_TAG}\n</body>`);
    });
  }
}
