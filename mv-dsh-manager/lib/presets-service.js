// Agent Presets adapter for @mv-aide/mv-dsh-manager.
// DSH remains the active-roster authority. The one intentional filesystem
// supplement is the manager's historical user-preset disable lifecycle:
// <id> <-> <id>.disabled under DSH's official user preset root.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u;
const USER_PRESET_DIR = '.agent-presets';
const COMPOSITION_FILE = 'agent.cordis.yml';
const METADATA_FILE = 'preset.yml';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function userPresetRoot() {
  return path.join(dshHome(), USER_PRESET_DIR);
}

function getAgentPresetsService(ctx) {
  // DSH rc.7 reflect contexts can reject undeclared service property reads.
  // Dynamic manager consumers must use the official lookup seam.
  try {
    const service = ctx?.get?.('agentPresets');
    if (service && typeof service.list === 'function') return service;
  } catch {
    // Fall through to reflection for older access shapes.
  }
  try {
    const service = ctx?.reflect?.get?.('agentPresets');
    if (service && typeof service.list === 'function') return service;
  } catch {
    // No roster service in this context.
  }
  return null;
}

function getApiProxy(ctx) {
  try {
    const service = ctx?.get?.('apiProxy');
    if (service?.agentPresets) return service;
  } catch {
    // Fall through to reflection for older access shapes.
  }
  try {
    const service = ctx?.reflect?.get?.('apiProxy');
    if (service?.agentPresets) return service;
  } catch {
    // No host opener service in this composition.
  }
  return null;
}

function mapPreset(item, defaultId, enabled = true) {
  return {
    id: item.id,
    name: item.name || item.id,
    description: item.description || '',
    trust: item.trust,
    path: item.path || null,
    enabled,
    isDefault: item.id === defaultId,
    writable: item.trust === 'user',
    broken: item.broken || null,
    order: item.order,
  };
}

async function readDisabledMetadata(directory, id) {
  try {
    const raw = await fs.readFile(path.join(directory, METADATA_FILE), 'utf8');
    const value = parse(raw);
    return {
      name: typeof value?.name === 'string' && value.name ? value.name : id,
      description: typeof value?.description === 'string' ? value.description : '',
      order: Number.isFinite(value?.order) ? value.order : undefined,
    };
  } catch {
    return { name: id, description: '', order: undefined };
  }
}

async function listDisabledUserPresets() {
  const root = userPresetRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.disabled')) continue;
    const id = entry.name.slice(0, -'.disabled'.length);
    if (!PRESET_ID.test(id)) continue;
    const directory = path.join(root, entry.name);
    const composition = path.join(directory, COMPOSITION_FILE);
    try {
      await fs.access(composition);
    } catch {
      continue;
    }
    const metadata = await readDisabledMetadata(directory, id);
    result.push(mapPreset({
      id,
      trust: 'user',
      path: composition,
      name: metadata.name,
      description: metadata.description,
      order: metadata.order,
    }, undefined, false));
  }
  return result;
}

export async function listPresets(ctx) {
  const service = getAgentPresetsService(ctx);
  if (!service) {
    return { ok: false, presets: [], authorable: false, error: 'DSH agentPresets service is not available in current context' };
  }
  try {
    const list = await service.list();
    const defaultId = service.defaultId;
    const active = (list || []).map((item) => mapPreset(item, defaultId, true));
    const activeIds = new Set(active.map((item) => item.id));
    const disabled = (await listDisabledUserPresets()).filter((item) => !activeIds.has(item.id));
    return {
      ok: true,
      presets: [...active, ...disabled],
      authorable: service.authorable !== false,
    };
  } catch (error) {
    return { ok: false, presets: [], authorable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function togglePreset(ctx, presetId, disabled) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const service = getAgentPresetsService(ctx);
  if (!service) return { ok: false, error: 'DSH agentPresets service is not available in current context' };
  const listed = await listPresets(ctx);
  if (!listed.ok) return listed;
  const target = listed.presets.find((preset) => preset.id === presetId);
  if (!target) return { ok: false, error: `预设 "${presetId}" 不存在` };
  if (target.trust === 'system') {
    return { ok: false, system: true, error: `系统内置预设 "${presetId}" 不支持停用；如需删除必须走高危删除确认。` };
  }
  if (!target.path) return { ok: false, error: `预设 "${presetId}" 缺少可操作路径` };

  const wantDisabled = Boolean(disabled);
  if (wantDisabled === (target.enabled === false)) {
    return { ok: true, id: presetId, enabled: !wantDisabled, message: `预设 "${presetId}" 已处于目标状态。` };
  }

  const currentDir = path.dirname(target.path);
  const disabledSuffix = '.disabled';
  const nextDir = wantDisabled
    ? `${currentDir}${disabledSuffix}`
    : currentDir.endsWith(disabledSuffix)
      ? currentDir.slice(0, -disabledSuffix.length)
      : currentDir;
  if (nextDir === currentDir) return { ok: false, error: `预设 "${presetId}" 的目录状态无法切换` };

  try {
    await fs.access(nextDir);
    return { ok: false, error: `目标目录已存在，拒绝覆盖：${nextDir}` };
  } catch {
    // Expected: destination must not exist.
  }

  try {
    await fs.rename(currentDir, nextDir);
    const observed = await service.list();
    const present = (observed || []).some((preset) => preset.id === presetId);
    if (wantDisabled ? present : !present) {
      await fs.rename(nextDir, currentDir).catch(() => undefined);
      return { ok: false, error: `目录已改名，但 DSH roster 未观察到预设 "${presetId}" 的目标状态，已尝试回滚。` };
    }
    return {
      ok: true,
      id: presetId,
      enabled: !wantDisabled,
      message: `预设 "${presetId}" 已通过目录${wantDisabled ? '隐藏' : '恢复'}并由 DSH roster 重新观测。`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function copyPreset(ctx, sourceId, newId, displayName) {
  if (!sourceId || !newId) return { ok: false, error: 'sourceId and newId are required' };
  if (!PRESET_ID.test(newId)) {
    return { ok: false, error: `新预设 ID "${newId}" 不合法，必须匹配 /^[a-z0-9][a-z0-9-]*$/` };
  }
  const service = getAgentPresetsService(ctx);
  if (!service || typeof service.copy !== 'function') {
    return { ok: false, error: 'DSH agentPresets.copy is not available in current context' };
  }
  try {
    await service.copy(sourceId, newId, displayName || undefined);
    const observed = await service.list();
    const created = (observed || []).find((preset) => preset.id === newId);
    if (!created) {
      return { ok: false, error: `agentPresets.copy returned, but DSH roster does not contain "${newId}"` };
    }
    return {
      ok: true,
      id: newId,
      name: created.name || newId,
      message: `预设 "${newId}" 已由 DSH agentPresets.copy 创建并重新观测。`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function deletePreset(ctx, presetId, force = false) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const service = getAgentPresetsService(ctx);
  if (!service || typeof service.remove !== 'function') {
    return { ok: false, error: 'DSH agentPresets.remove is not available in current context' };
  }
  const listed = await listPresets(ctx);
  if (!listed.ok) return listed;
  const target = listed.presets.find((preset) => preset.id === presetId);
  if (!target) return { ok: false, error: `预设 "${presetId}" 不存在` };

  if (target.trust === 'system' && !force) {
    return {
      ok: false,
      requiresForce: true,
      system: true,
      error: `预设 "${presetId}" 是 DeepSeek 官方系统内置预设，删除前必须经过高危确认。`,
    };
  }

  try {
    if (target.trust === 'system') {
      if (!target.path) return { ok: false, error: `系统预设 "${presetId}" 缺少路径，无法执行高危删除` };
      await fs.rm(path.dirname(target.path), { recursive: true, force: false });
    } else if (target.enabled === false) {
      if (!target.path) return { ok: false, error: `停用预设 "${presetId}" 缺少路径` };
      await fs.rm(path.dirname(target.path), { recursive: true, force: false });
    } else {
      await service.remove(presetId);
    }

    const observed = await service.list();
    if ((observed || []).some((preset) => preset.id === presetId)) {
      return { ok: false, error: `删除操作返回，但 DSH roster 仍包含 "${presetId}"` };
    }
    const disabledStillThere = (await listDisabledUserPresets()).some((preset) => preset.id === presetId);
    if (disabledStillThere) {
      return { ok: false, error: `删除操作返回，但停用目录仍包含 "${presetId}"` };
    }
    return {
      ok: true,
      id: presetId,
      forcedSystemDelete: target.trust === 'system',
      message: target.trust === 'system'
        ? `系统预设 "${presetId}" 已在高危确认后从其实际目录删除。`
        : `预设 "${presetId}" 已删除并由 DSH roster 重新观测。`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function openPresetDocument(ctx, presetId) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const apiProxy = getApiProxy(ctx);
  const openDocument = apiProxy?.agentPresets?.openDocument;
  if (typeof openDocument !== 'function') {
    return { ok: false, error: 'DSH apiProxy.agentPresets.openDocument is not available in current context' };
  }
  try {
    const response = await openDocument({
      rpcId: `mv-dsh-manager:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      payload: { agentPreset: presetId },
    });
    if (!response?.result?.ok) {
      return { ok: false, error: response?.result?.error?.message || `DSH refused to open preset "${presetId}"` };
    }
    return { ok: true, ...response.result.value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
