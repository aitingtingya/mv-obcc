// @mv-aide/mv-dsh-manager
// DSH Runtime Manager Plugin for Plugins, Skills, and Subagents

import { listPlugins, togglePlugin, deletePlugin, importPlugin, openPluginFolder } from './plugins-service.js';
import { listSkills, toggleSkill, importSkill, deleteSkill, openSkillFolder } from './skills-service.js';
import { listPresets, copyPreset, deletePreset, togglePreset, openPresetFolder } from './presets-service.js';
import { UI_SCRIPT_TAG } from './ui-script.js';

export const name = 'mv-dsh-manager';
export const inject = ['webServer'];

export function apply(ctx) {
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('webServer service not available; mv-dsh-manager API will not be mounted.');
    return;
  }

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
          const data = await listSkills();
          return sendJson(200, data);
        }

        if (pathname === '/api/mv-aide/skills/toggle' && method === 'POST') {
          const payload = await readJsonBody();
          const { skillId, disabled } = payload;
          if (!skillId) return sendJson(400, { ok: false, error: 'skillId is required' });
          const result = await toggleSkill(skillId, disabled);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/skills/import' && method === 'POST') {
          const payload = await readJsonBody();
          const { name: skillName, description, content } = payload;
          const result = await importSkill(skillName, description, content);
          return sendJson(200, result);
        }

        if (pathname.startsWith('/api/mv-aide/skills/') && method === 'DELETE') {
          const skillId = decodeURIComponent(pathname.replace('/api/mv-aide/skills/', '').split('?')[0]);
          const result = await deleteSkill(skillId);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/skills/open-folder' && method === 'POST') {
          const payload = await readJsonBody();
          const result = await openSkillFolder(payload.skillId);
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
          const result = await togglePreset(presetId, disabled);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/presets/copy' && method === 'POST') {
          const payload = await readJsonBody();
          const { sourceId, newId, name: presetName, description } = payload;
          const result = await copyPreset(sourceId, newId, presetName, description);
          return sendJson(200, result);
        }

        if (pathname.startsWith('/api/mv-aide/presets/') && method === 'DELETE') {
          const presetId = decodeURIComponent(pathname.replace('/api/mv-aide/presets/', '').split('?')[0]);
          const force = url.searchParams.get('force') === 'true';
          const result = await deletePreset(presetId, force);
          return sendJson(200, result);
        }

        if (pathname === '/api/mv-aide/presets/open-folder' && method === 'POST') {
          const payload = await readJsonBody();
          const result = await openPresetFolder(payload.presetId);
          return sendJson(200, result);
        }

        return sendJson(404, { ok: false, error: `Route not found: ${method} ${pathname}` });
      } catch (err) {
        return sendJson(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
