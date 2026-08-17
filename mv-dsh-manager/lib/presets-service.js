// Presets & Subagents Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** DSH accepts only this shape for a preset directory name (dsh-agent-presets PRESET_ID). */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u;
const DISABLED_SUFFIX = '.disabled';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function userPresetsDir() {
  return path.join(dshHome(), '.agent-presets');
}

function parseSimpleYaml(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/u);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

async function readMetadata(dir) {
  try {
    return parseSimpleYaml(await fs.readFile(path.join(dir, 'preset.yml'), 'utf8'));
  } catch {
    return {};
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function quoteYaml(value) {
  return `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function getAgentPresetsService(ctx) {
  try {
    if (ctx && ctx.reflect && typeof ctx.reflect.get === 'function') {
      return ctx.reflect.get('agentPresets');
    }
  } catch {
    // Ignore
  }
  return null;
}

/** Scan one user-root directory (normal or `.disabled`) into a preset row. */
async function readUserPresetEntry(dir, id, enabled) {
  const meta = await readMetadata(dir);
  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    trust: 'user',
    enabled,
    path: dir,
  };
}

async function scanUserPresetDirs() {
  const root = userPresetsDir();
  const entries = [];
  try {
    const dirs = await fs.readdir(root, { withFileTypes: true });
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const disabled = ent.name.endsWith(DISABLED_SUFFIX);
      const id = disabled ? ent.name.slice(0, -DISABLED_SUFFIX.length) : ent.name;
      if (!PRESET_ID.test(id)) continue;
      entries.push(await readUserPresetEntry(path.join(root, ent.name), id, !disabled));
    }
  } catch {
    // Directory not present yet
  }
  return entries;
}

export async function listPresets(ctx) {
  const presets = [];

  // 1. Agent preset service view (system presets plus valid user presets).
  const agentPresets = getAgentPresetsService(ctx);
  if (agentPresets && typeof agentPresets.list === 'function') {
    try {
      const list = await agentPresets.list();
      for (const item of list) {
        presets.push({
          id: item.id,
          name: (item.metadata && item.metadata.name) || item.id,
          description: (item.metadata && item.metadata.description) || '',
          trust: item.trust || 'system',
          enabled: item.disabled ? false : true,
          path: item.path || '',
          broken: item.broken || false,
        });
      }
    } catch {
      // Fall back to disk scan below
    }
  }

  // 2. Merge user-root rows so `.disabled` presets stay visible and re-enableable.
  for (const entry of await scanUserPresetDirs()) {
    if (presets.some((preset) => preset.id === entry.id)) continue;
    presets.push(entry);
  }

  // 3. Add default system presets if nothing was found at all.
  if (presets.length === 0) {
    presets.push(
      { id: 'standard', name: '标准模式', description: '全功能自主编程与交互预设', trust: 'system', enabled: true },
      { id: 'code', name: '极简编码', description: '专注文件编辑与 Shell 执行的轻量预设', trust: 'system', enabled: true }
    );
  }

  return { ok: true, presets };
}

/**
 * Enable/disable a USER preset by renaming its directory to `<id>.disabled`.
 * DSH's discovery only reads directory names matching PRESET_ID, so a renamed
 * directory is genuinely hidden from new sessions; the old `disabled:` key in
 * preset.yml is not read by DSH and is no longer written.
 */
export async function togglePreset(presetId, disabled) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }

  const root = userPresetsDir();
  const enabledDir = path.join(root, presetId);
  const disabledDir = path.join(root, `${presetId}${DISABLED_SUFFIX}`);

  try {
    if (disabled) {
      if (await pathExists(disabledDir)) {
        return { ok: true, id: presetId, enabled: false, message: `子智能体预设 "${presetId}" 已停用` };
      }
      if (await pathExists(enabledDir)) {
        await fs.mkdir(root, { recursive: true });
        await fs.rename(enabledDir, disabledDir);
        return { ok: true, id: presetId, enabled: false, message: `子智能体预设 "${presetId}" 已停用` };
      }
      return { ok: false, error: `系统内置预设 "${presetId}" 不支持停用；如需停用请删除用户预设或使用克隆副本` };
    }

    if (await pathExists(enabledDir)) {
      return { ok: true, id: presetId, enabled: true, message: `子智能体预设 "${presetId}" 已启用` };
    }
    if (await pathExists(disabledDir)) {
      await fs.mkdir(root, { recursive: true });
      await fs.rename(disabledDir, enabledDir);
      return { ok: true, id: presetId, enabled: true, message: `子智能体预设 "${presetId}" 已启用` };
    }
    return { ok: false, error: `子智能体预设 "${presetId}" 不存在` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Clone a preset into the user root as a REAL, mountable preset: copy the
 * source directory (agent.cordis.yml + local plugin files + metadata), then
 * rewrite preset.yml to only the fields DSH reads (name/description/order).
 * A `base:` pointer would be silently ignored by DSH, so it is never written.
 */
export async function copyPreset(ctx, sourceId, newId, displayName, description) {
  if (!sourceId || !newId) {
    return { ok: false, error: 'sourceId and newId are required' };
  }
  if (!PRESET_ID.test(newId)) {
    return { ok: false, error: `新预设 ID "${newId}" 不合法，必须匹配 /^[a-z0-9][a-z0-9-]*$/` };
  }

  const targetDir = path.join(userPresetsDir(), newId);
  if (await pathExists(targetDir)) {
    return { ok: false, error: `预设 "${newId}" 已存在，克隆不会覆盖；请先删除或换一个 ID` };
  }

  // Resolve the real source directory: agentPresets service first, then user root.
  let sourceDir = null;
  let sourceMeta = {};
  const agentPresets = getAgentPresetsService(ctx);
  if (agentPresets && typeof agentPresets.resolve === 'function') {
    try {
      const resolved = await agentPresets.resolve(sourceId);
      if (typeof resolved?.path === 'string' && resolved.path.length > 0) {
        sourceDir = path.dirname(resolved.path);
        sourceMeta = {
          name: resolved.name,
          description: resolved.description,
          order: typeof resolved.order === 'number' ? resolved.order : undefined,
        };
      }
    } catch {
      // Unknown in the service view; fall through to the user root.
    }
  }

  if (!sourceDir) {
    const userSource = path.join(userPresetsDir(), sourceId);
    if (await pathExists(path.join(userSource, 'agent.cordis.yml'))) {
      sourceDir = userSource;
      const meta = await readMetadata(userSource);
      sourceMeta = {
        name: meta.name,
        description: meta.description,
        order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : undefined,
      };
    }
  }

  if (!sourceDir) {
    return { ok: false, error: `源预设 "${sourceId}" 不存在或无法定位其 agent.cordis.yml` };
  }

  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });

    // DSH preset metadata only understands name / description / order.
    const name = displayName || sourceMeta.name || sourceId;
    const desc = description || sourceMeta.description || `从 ${sourceId} 克隆的预设`;
    const metaLines = [`name: ${quoteYaml(name)}`, `description: ${quoteYaml(desc)}`];
    if (sourceMeta.order !== undefined) metaLines.push(`order: ${sourceMeta.order}`);
    await fs.writeFile(path.join(targetDir, 'preset.yml'), `${metaLines.join('\n')}\n`, 'utf8');

    return {
      ok: true,
      id: newId,
      name,
      path: targetDir,
      message: `预设 "${sourceId}" 已完整克隆为 "${newId}"（含 agent.cordis.yml）。`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deletePreset(presetId, force = false) {
  const isSystem = presetId === 'standard' || presetId === 'code' || presetId === 'base';
  if (isSystem && !force) {
    return {
      ok: false,
      isSystem: true,
      error: `警告：预设 "${presetId}" 属于官方系统内置预设，删除可能影响基础会话功能。请在确认框中选择强制删除。`
    };
  }

  const root = userPresetsDir();
  const targets = [path.join(root, presetId), path.join(root, `${presetId}${DISABLED_SUFFIX}`)];

  try {
    let removed = 0;
    for (const target of targets) {
      if (!await pathExists(target)) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    }
    if (removed === 0) {
      return { ok: false, error: `预设 "${presetId}" 不存在` };
    }
    return {
      ok: true,
      id: presetId,
      message: `子智能体预设 "${presetId}" 已成功删除。`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openPresetFolder(presetId) {
  let targetPath = userPresetsDir();
  if (presetId) {
    const candidate = path.join(targetPath, presetId);
    targetPath = await pathExists(candidate) ? candidate : targetPath;
  }
  await fs.mkdir(targetPath, { recursive: true });

  const platform = os.platform();
  const { spawn } = await import('node:child_process');
  if (platform === 'darwin') {
    spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'win32') {
    spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
  }

  return { ok: true, path: targetPath };
}
