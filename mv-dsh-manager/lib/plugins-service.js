// Plugins Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function isProtectedPlugin(entryId) {
  if (!entryId) return false;
  return (
    entryId === 'mv-dsh-manager' ||
    entryId === 'mv-agent' ||
    entryId.includes('mv-dsh-manager') ||
    entryId.includes('mv-agent') ||
    entryId.startsWith('@deepseek-ai/') ||
    entryId.startsWith('cordis:')
  );
}

export function listPlugins(ctx) {
  if (!ctx.loader || !ctx.loader.entries) {
    return { ok: false, error: 'Cordis loader not available in current context' };
  }

  const entries = [];
  try {
    for (const entry of ctx.loader.entries()) {
      if (!entry) continue;
      const id = entry.id || (entry.options && entry.options.id);
      if (!id) continue;

      const fiber = entry.fiber;
      let fiberPhase = null;
      if (fiber && fiber.state !== undefined) {
        fiberPhase = fiber.state;
      }

      entries.push({
        id: id,
        name: (entry.options && entry.options.name) || id,
        enabled: !entry.disabled,
        isProtected: isProtectedPlugin(id),
        fiberPhase: fiberPhase !== null ? fiberPhase : (entry.disabled ? 0 : 2),
      });
    }
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function togglePlugin(ctx, entryId, disabled) {
  if (!ctx.loader || !ctx.loader.entries) {
    return { ok: false, error: 'Cordis loader not available' };
  }

  try {
    let targetEntry = null;
    let actualId = entryId;

    for (const entry of ctx.loader.entries()) {
      if (!entry) continue;
      const id = entry.id || (entry.options && entry.options.id);
      const name = (entry.options && entry.options.name);
      if (id === entryId || name === entryId) {
        targetEntry = entry;
        actualId = id;
        break;
      }
    }

    if (!targetEntry) {
      return { ok: false, error: `Plugin entry "${entryId}" not found` };
    }

    if (typeof ctx.loader.update === 'function') {
      await ctx.loader.update(actualId, { disabled: Boolean(disabled) });
      return {
        ok: true,
        id: actualId,
        enabled: !disabled,
        message: `Plugin "${entryId}" has been ${disabled ? 'disabled' : 'enabled'}`
      };
    } else {
      return { ok: false, error: 'ctx.loader.update is not supported in this runtime' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deletePlugin(ctx, entryId, force = false) {
  if (!entryId) {
    return { ok: false, error: 'entryId is required' };
  }

  const isProtected = isProtectedPlugin(entryId);
  if (isProtected && !force) {
    return {
      ok: false,
      isProtected: true,
      error: `警告：插件 "${entryId}" 属于系统核心或管理器插件，删除可能导致相关功能失效。请在确认框中选择强制删除。`
    };
  }

  try {
    // 1. Disable or remove in loader
    if (ctx.loader) {
      try {
        if (typeof ctx.loader.remove === 'function') {
          await ctx.loader.remove(entryId);
        } else if (typeof ctx.loader.update === 'function') {
          await ctx.loader.update(entryId, { disabled: true });
        }
      } catch {
        // Ignore loader errors
      }
    }

    // 2. Remove from cordis.patch.yml if present
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profileDir = path.join(dshHome, 'profiles', 'web');
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    try {
      const raw = await fs.readFile(patchFile, 'utf8');
      const lines = raw.split(/\r?\n/);
      const kept = [];
      let skipping = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(`id: ${entryId}`) || line.includes(`id: '${entryId}'`) || line.includes(`id: "${entryId}"`)) {
          if (kept.length > 0 && kept[kept.length - 1].trim().startsWith('-')) {
            // Drop previous line if it was list item start
          }
          continue;
        }
        kept.push(line);
      }
      await fs.writeFile(patchFile, kept.join('\n'), 'utf8');
    } catch {
      // Patch file not present or error
    }

    return {
      ok: true,
      id: entryId,
      message: `插件 "${entryId}" 已成功删除/卸载。`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importPlugin(ctx, spec) {
  if (!spec || !spec.trim()) {
    return { ok: false, error: 'Plugin specification or path is required' };
  }

  const cleanSpec = spec.trim();
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const patchFile = path.join(profileDir, 'cordis.patch.yml');

  try {
    let raw = '';
    try {
      raw = await fs.readFile(patchFile, 'utf8');
    } catch {
      raw = '[]\n';
    }

    const pluginId = cleanSpec.split('/').pop().replace(/[@^~]/g, '');
    const appendBlock = `\n- insert:\n    - id: ${pluginId}\n      name: '${cleanSpec}'\n`;

    await fs.writeFile(patchFile, raw.trimEnd() + appendBlock, 'utf8');
    return {
      ok: true,
      id: pluginId,
      name: cleanSpec,
      message: `插件 "${cleanSpec}" 已成功导入配置。`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openPluginFolder(pluginId) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const targetDir = pluginId
    ? path.join(dshHome, 'profiles', 'web', 'node_modules', pluginId)
    : path.join(dshHome, 'profiles', 'web', 'node_modules');

  await fs.mkdir(targetDir, { recursive: true });

  const platform = os.platform();
  const { spawn } = await import('node:child_process');
  if (platform === 'darwin') {
    spawn('open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'win32') {
    spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  }

  return { ok: true, path: targetDir };
}
