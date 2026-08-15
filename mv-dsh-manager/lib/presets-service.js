// Presets & Subagents Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function parseSimpleYaml(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
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

export async function listPresets(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const userPresetsDir = path.join(dshHome, '.agent-presets');

  const presets = [];

  // 1. Check if agentPresets service is available from DSH
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
      return { ok: true, presets };
    } catch {
      // Fall back to disk scan
    }
  }

  // 2. Fallback disk scan for user presets (~/.dsh/.agent-presets)
  try {
    const entries = await fs.readdir(userPresetsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        const presetDir = path.join(userPresetsDir, ent.name);
        const presetYmlPath = path.join(presetDir, 'preset.yml');
        let name = ent.name;
        let description = '';
        let enabled = true;

        try {
          const raw = await fs.readFile(presetYmlPath, 'utf-8');
          const meta = parseSimpleYaml(raw);
          if (meta.name) name = meta.name;
          if (meta.description) description = meta.description;
          if (meta.disabled === 'true' || meta.enabled === 'false') enabled = false;
        } catch {
          // No preset.yml
        }

        presets.push({
          id: ent.name,
          name,
          description,
          trust: 'user',
          enabled,
          path: presetDir,
        });
      }
    }
  } catch {
    // Directory not present yet
  }

  // Add default system presets if none found
  if (presets.length === 0) {
    presets.push(
      { id: 'standard', name: '标准模式', description: '全功能自主编程与交互预设', trust: 'system', enabled: true },
      { id: 'code', name: '极简编码', description: '专注文件编辑与 Shell 执行的轻量预设', trust: 'system', enabled: true }
    );
  }

  return { ok: true, presets };
}

export async function togglePreset(presetId, disabled) {
  if (!presetId) {
    return { ok: false, error: 'presetId is required' };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const presetDir = path.join(dshHome, '.agent-presets', presetId);
  const presetYmlPath = path.join(presetDir, 'preset.yml');

  try {
    let raw = '';
    try {
      raw = await fs.readFile(presetYmlPath, 'utf-8');
    } catch {
      raw = `name: ${presetId}\ndescription: 自定义智能体\n`;
    }

    const lines = raw.split(/\r?\n/).filter(l => !l.startsWith('disabled:') && !l.startsWith('enabled:'));
    lines.push(`disabled: ${Boolean(disabled)}`);

    await fs.mkdir(presetDir, { recursive: true });
    await fs.writeFile(presetYmlPath, lines.join('\n') + '\n', 'utf-8');

    return {
      ok: true,
      id: presetId,
      enabled: !disabled,
      message: `子智能体预设 "${presetId}" 已${disabled ? '停用' : '启用'}`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function copyPreset(sourceId, newId, displayName, description) {
  if (!sourceId || !newId) {
    return { ok: false, error: 'sourceId and newId are required' };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const userPresetsDir = path.join(dshHome, '.agent-presets');
  const targetDir = path.join(userPresetsDir, newId);

  try {
    await fs.mkdir(targetDir, { recursive: true });

    // Look for source directory
    const sourceUserDir = path.join(userPresetsDir, sourceId);
    let sourceExists = false;
    try {
      await fs.access(sourceUserDir);
      sourceExists = true;
    } catch {
      sourceExists = false;
    }

    if (sourceExists) {
      await fs.cp(sourceUserDir, targetDir, { recursive: true });
    }

    // Write updated preset.yml
    const presetYmlPath = path.join(targetDir, 'preset.yml');
    const yamlContent = [
      `name: "${displayName || newId}"`,
      `description: "${description || `从 ${sourceId} 克隆的子智能体预设`}"`,
      `base: "${sourceId}"`,
      `created_at: "${new Date().toISOString()}"`,
      '',
    ].join('\n');

    await fs.writeFile(presetYmlPath, yamlContent, 'utf-8');

    return {
      ok: true,
      id: newId,
      name: displayName || newId,
      path: targetDir,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deletePreset(presetId, force = false) {
  if (!presetId) {
    return { ok: false, error: 'presetId is required' };
  }

  const isSystem = presetId === 'standard' || presetId === 'code' || presetId === 'base';
  if (isSystem && !force) {
    return {
      ok: false,
      isSystem: true,
      error: `警告：预设 "${presetId}" 属于官方系统内置预设，删除可能影响基础会话功能。请在确认框中选择强制删除。`
    };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const targetDir = path.join(dshHome, '.agent-presets', presetId);

  try {
    await fs.rm(targetDir, { recursive: true, force: true });
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
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const targetDir = presetId
    ? path.join(dshHome, '.agent-presets', presetId)
    : path.join(dshHome, '.agent-presets');

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
