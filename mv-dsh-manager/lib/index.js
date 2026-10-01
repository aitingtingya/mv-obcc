// @mv-aide/mv-dsh-manager
// DSH Runtime Manager Plugin for Plugins, Skills, and Subagents

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listPlugins, togglePlugin, deletePlugin, importPlugin, openPluginFolder } from './plugins-service.js';
import { listSkills, toggleSkill, importSkill, deleteSkill, openSkillFolder } from './skills-service.js';
import { listPresets, togglePreset, copyPreset, deletePreset, openPresetDocument, syncPresetRows } from './presets-service.js';
import { migrateSubworkspaceAssociations } from './legacy-migration.js';
import { discoverBridges, listTools } from './bridge-service.js';
import { installPlanReviewControl } from './plan-review-control.js';
import { createModelCapabilitiesService, ModelCapabilitiesError } from './model-capabilities-service.js';
import { createHistoryRecallService, HistoryRecallError } from './history-recall-service.js';
import { UI_SCRIPT_TAG } from './ui-script.js';
import { installManagerFeatureSettings } from './feature-settings.js';
import { mvAideSettingsFile, registeredSettingsScopes, settingsScopeFor } from '../../mv-dsh-settings/lib/store.js';

export const name = 'mv-dsh-manager';
// Keep the frozen preview loader contract: optional capabilities are resolved
// structurally through mv-dsh-compat instead of being declared as hard boot
// dependencies.
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

/**
 * Every live mv-AIDE settings namespace, as the workbench panel reads them.
 * Values are effective (defaults ⊕ stored); `user` carries only the stored
 * overrides so the panel can show which switches were changed.
 */
function settingsSnapshot() {
  const namespaces = {};
  for (const scope of registeredSettingsScopes()) {
    let user = {};
    try {
      user = typeof scope.user === 'function' ? scope.user() : {};
    } catch {
      user = {};
    }
    namespaces[scope.namespace] = {
      values: { ...scope.get() },
      user,
      manage: scope.manage(),
      writable: scope.writable === true,
    };
  }
  return {
    ok: true,
    // The document's own path, not whichever scope happened to register first:
    // every scope in this process shares the one file.
    file: mvAideSettingsFile(),
    namespaces,
  };
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
  const featureSettings = installManagerFeatureSettings(ctx);
  installPlanReviewControl(ctx, {
    enabled: () => featureSettings.get().planReviewEnhancementEnabled !== false,
    subscribe: (listener) => featureSettings.subscribe(listener),
  });

  // Project the preset authoring directories into this profile's composition:
  // ≥0.1.7 has no preset-discovery service, so the rows are what DSH loads.
  // Failure stays non-fatal — the preset panel then reports the projection
  // state instead of the plugin breaking activation.
  void syncPresetRows().then((result) => {
    if (result?.changed) ctx.logger?.info?.(`mv-dsh-manager: projected ${result.rows.length} preset row(s) into ${result.file}`);
  }).catch((error) => {
    ctx.logger?.warn?.(`mv-dsh-manager: preset projection skipped: ${error instanceof Error ? error.message : String(error)}`);
  });

  // Associated roots used to live only in DSH's settings document; 0.1.7 keeps
  // a copy of it as `settings.yaml.imported` and feeds no plugin from there.
  void migrateSubworkspaceAssociations({ log: (message) => ctx.logger?.warn?.(message) }).then((result) => {
    if (result?.migrated) {
      ctx.logger?.info?.(`mv-dsh-manager: migrated ${result.primaries} associated-roots row(s) (${result.children} child workspace(s)) from ${result.file}`);
    }
    if (result?.pruned) {
      ctx.logger?.info?.(`mv-dsh-manager: pruned ${result.pruned} temp-scoped associated-roots row(s)`);
    }
  }).catch((error) => {
    ctx.logger?.warn?.(`mv-dsh-manager: associated-roots migration skipped: ${error instanceof Error ? error.message : String(error)}`);
  });

  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('webServer service not available; mv-dsh-manager API will not be mounted.');
    return;
  }
  const modelCapabilities = createModelCapabilitiesService(ctx);
  const historyRecall = createHistoryRecallService(ctx);

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
        // ── mv-AIDE plugin-owned settings (see mv-dsh-settings/lib/store.js) ──
        if (pathname === '/api/mv-aide/settings' && method === 'GET') {
          // The snapshot carries the absolute settings path (and so the OS user
          // name) plus every stored override; the POST below is already gated,
          // and a read has no reason to be looser.
          if (!isSameOriginBrowserRequest(req)) {
            return sendJson(403, { ok: false, error: 'Settings are same-origin only.' });
          }
          return sendJson(200, settingsSnapshot());
        }

        if (pathname === '/api/mv-aide/settings' && method === 'POST') {
          if (!isSameOriginBrowserRequest(req)) {
            return sendJson(403, { ok: false, error: 'Settings are same-origin only.' });
          }
          const payload = await readJsonBody();
          const scope = settingsScopeFor(typeof payload?.namespace === 'string' ? payload.namespace : '');
          if (!scope) {
            return sendJson(404, { ok: false, error: `未知的 mv-AIDE 设置命名空间：${String(payload?.namespace ?? '')}` });
          }
          if (scope.manage() !== 'panel') {
            return sendJson(409, {
              ok: false,
              code: 'managed-by-dsh',
              error: '当前 DSH 版本仍由 DSH 设置面板管理该命名空间，请在 DSH 设置中修改。',
            });
          }
          try {
            await scope.apply({ set: payload?.set ?? {}, unset: Array.isArray(payload?.unset) ? payload.unset : [] });
          } catch (error) {
            return sendJson(400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return sendJson(200, settingsSnapshot());
        }

        if (pathname === '/api/mv-aide/history-recall' && !isSameOriginBrowserRequest(req)) {
          return sendJson(403, { ok: false, error: 'History recall is same-origin only.' });
        }

        if (pathname === '/api/mv-aide/history-recall' && method === 'POST') {
          const payload = await readJsonBody();
          const data = await historyRecall.read(payload);
          return sendJson(200, data);
        }

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
          const { sourceId, newId, name: presetName } = payload;
          const result = await copyPreset(ctx, sourceId, newId, presetName);
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
        const knownError = err instanceof ModelCapabilitiesError || err instanceof HistoryRecallError;
        const status = knownError ? err.status : 500;
        return sendJson(status, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...(knownError ? { code: err.code } : {}),
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
