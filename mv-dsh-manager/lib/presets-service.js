// Agent-preset service for @mv-aide/mv-dsh-manager.
//
// 0.1.7 has no preset authoring API at all: the roster is read-only
// (`list()` returning `{id, name?, description?, order?, broken?}`), presets are
// declared as `@deepseek-ai/dsh-agent-preset` rows in the profile composition,
// and `copy`/`remove`/`authorable`/`path`/`trust` are gone. mv-AIDE therefore
// owns the authoring side itself, keeping the released directory layout as the
// editable artifact and projecting it into the profile's `cordis.patch.yml`
// (see ./preset-rows.js):
//
//   ~/.dsh/.agent-presets/<id>/{preset.yml,agent.cordis.yml,…}   authoring
//   <profile>/cordis.patch.yml  - insert: agent-preset-<id>      what DSH loads
//
// Enablement is the row's own `disabled` flag, so hiding a preset is one
// boolean in the user layer instead of renaming a directory.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { withProfileLock } from '../../mv-dsh-compat/lib/lock.js';
import {
  AGENT_PRESET_PACKAGE,
  COMPOSITION_FILE,
  METADATA_FILE,
  PRESET_ID,
  USER_PRESET_DIR,
  discoverPresetDirectories,
  listPresetRows,
  presetRowId,
  removePresetRowRaw,
  setPresetRowDisabledRaw,
  upsertPresetRowRaw,
} from './preset-rows.js';
import { resolveAgentPresets, resolvePresetOpener } from '../../mv-dsh-compat/lib/host.js';

export { PRESET_ID, presetRowId };

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function userPresetRoot() {
  return path.join(dshHome(), USER_PRESET_DIR);
}

function patchFile() {
  return path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
}

function getAgentPresetsService(ctx) {
  return resolveAgentPresets(ctx);
}

function metadataDocumentPath(directory) {
  return path.join(directory, METADATA_FILE);
}

/**
 * Run one read-modify-write of the profile composition under the shared lock.
 *
 * The Obsidian host rewrites the same `cordis.patch.yml` from its own process
 * when it injects or updates the managed plugins, so every projection, toggle,
 * copy and delete here has to re-detect inside the one cross-process lock the
 * two halves share (规范十.4).
 */
function withPatchLock(operation) {
  return withProfileLock(operation, path.dirname(patchFile()), {
    timeoutMessage: '等待其它 mv-AIDE 操作释放 DSH profile 锁超时。',
  });
}

/**
 * Read the profile composition, treating only a genuinely absent file as empty.
 *
 * Swallowing every error here turned a transient EACCES/EIO into "this profile
 * has no rows", and the next projection then rewrote the whole composition from
 * that empty base — dropping every unrelated row the user had, with the `.bak`
 * copied from the same failed read and so useless as a restore point. A failure
 * that is not `ENOENT` must therefore refuse the write and say so.
 */
async function readPatchRaw() {
  try {
    return await fs.readFile(patchFile(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '[]\n';
    throw new Error(`无法读取 profile 合成文件 ${patchFile()}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writePatchRaw(content) {
  const file = patchFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.mv-aide-preset-${process.pid}-${Date.now()}.tmp`;
  const backup = `${file}.bak`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.copyFile(file, backup).catch(() => undefined);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  // A projection must never leave an unparsable composition behind.
  const verify = await fs.readFile(file, 'utf8');
  try {
    const rows = listPresetRows(verify);
    return rows;
  } catch (error) {
    await fs.copyFile(backup, file).catch(() => undefined);
    throw new Error(`projected patch is not valid YAML; restored the backup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Project every authoring directory into the profile composition.
 *
 * Idempotent: an existing row keeps its own enablement (a panel toggle or a
 * hand edit), while a directory that is still disabled by name stays disabled.
 * @param options.write - `false` computes the projection without touching disk.
 * @returns `{ ok, file, changed, rows, discovered }`.
 */
export async function syncPresetRows(options = {}) {
  const write = options.write !== false;
  if (!write) return projectPresetRows({ ...options, write: false });
  return withPatchLock(() => projectPresetRows(options));
}

async function projectPresetRows(options = {}) {
  const write = options.write !== false;
  const raw = await readPatchRaw();
  const discovered = await discoverPresetDirectories(dshHome());
  const existing = new Map(listPresetRows(raw).map((row) => [row.presetId, row]));
  const staged = [];
  let document = raw;
  for (const preset of discovered) {
    const row = existing.get(preset.id);
    const disabled = preset.directoryDisabled === true || row?.disabled === true;
    const next = {
      id: preset.id,
      name: preset.name,
      description: preset.description,
      order: preset.order,
      composition: preset.composition,
      disabled,
    };
    const result = upsertPresetRowRaw(document, next);
    document = result.raw;
    staged.push({ id: preset.id, directory: preset.directory, dirDisabled: preset.directoryDisabled, disabled });
  }
  const changed = document !== raw;
  if (!write || !changed) {
    return { ok: true, file: patchFile(), changed: false, rows: listPresetRows(document), discovered: staged };
  }
  const rows = await writePatchRaw(document);
  return { ok: true, file: patchFile(), changed: true, rows, discovered: staged };
}

function mapRosterRow(item, defaultId) {
  return {
    id: item.id,
    name: item.name || item.id,
    description: item.description || '',
    order: item.order,
    broken: item.broken || null,
    isDefault: item.id === defaultId,
  };
}

/**
 * The live roster, enriched with the authoring facts DSH no longer exposes.
 * A preset is `writable` when mv-AIDE owns a directory or a projected row for
 * it; a bundled preset that only the DSH layers declare stays read-only.
 */
export async function listPresets(ctx) {
  const service = getAgentPresetsService(ctx);
  const defaultId = service?.defaultId;
  const roster = new Map();
  let rosterError = null;
  if (service && typeof service.list === 'function') {
    try {
      for (const item of (await service.list()) || []) {
        if (item?.id) roster.set(item.id, mapRosterRow(item, defaultId));
      }
    } catch (error) {
      rosterError = error instanceof Error ? error.message : String(error);
    }
  }

  const raw = await readPatchRaw();
  const rows = new Map(listPresetRows(raw).map((row) => [row.presetId, row]));
  let discovered = [];
  try {
    discovered = await discoverPresetDirectories(dshHome());
  } catch (error) {
    rosterError = rosterError ?? (error instanceof Error ? error.message : String(error));
  }
  const directories = new Map(discovered.map((entry) => [entry.id, entry]));

  const ids = new Set([...rows.keys(), ...directories.keys(), ...roster.keys()]);
  const presets = [];
  for (const id of ids) {
    const row = rows.get(id);
    const directory = directories.get(id);
    const live = roster.get(id);
    const enabled = row ? row.disabled !== true : directory ? directory.directoryDisabled !== true : true;
    presets.push({
      id,
      name: directory?.name ?? row?.name ?? live?.name ?? id,
      description: directory?.description ?? row?.description ?? live?.description ?? '',
      order: directory?.order ?? row?.order ?? live?.order,
      trust: directory || row ? 'user' : 'bundled',
      path: directory ? path.join(directory.directory, COMPOSITION_FILE) : null,
      directory: directory?.directory ?? null,
      document: directory ? metadataDocumentPath(directory.directory) : null,
      projected: Boolean(row),
      rowId: presetRowId(id),
      enabled,
      isDefault: live?.isDefault === true,
      writable: Boolean(directory || row),
      broken: live?.broken ?? null,
    });
  }
  presets.sort((left, right) => (left.order ?? Infinity) - (right.order ?? Infinity) || left.id.localeCompare(right.id));

  return {
    ok: rosterError === null,
    presets,
    authorable: true,
    file: patchFile(),
    ...(rosterError === null ? {} : { error: rosterError }),
  };
}

/**
 * Enable or disable one preset by writing its projected row.
 * Enabling also restores a directory that an older mv-aide (or a manual edit)
 * moved aside, so the next projection agrees with the row.
 */
export async function togglePreset(ctx, presetId, disabled) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const listed = await listPresets(ctx);
  const target = listed.presets.find((preset) => preset.id === presetId);
  if (!target) return { ok: false, error: `预设 "${presetId}" 不存在` };
  if (!target.writable) {
    return {
      ok: false,
      error: `预设 "${presetId}" 由 DSH 自身的层声明，mv-AIDE 无法停用或删除它。`,
    };
  }

  const wantDisabled = Boolean(disabled);
  if (target.enabled === !wantDisabled) {
    return { ok: true, id: presetId, enabled: target.enabled, message: `预设 "${presetId}" 已处于目标状态。` };
  }

  try {
    // The directory move is mv-AIDE's own state, not the profile composition,
    // so it stays outside the lock instead of holding it across unrelated IO.
    if (!wantDisabled) await restorePresetDirectory(presetId, target);
    return await withPatchLock(async () => {
      const raw = await readPatchRaw();
      const next = setPresetRowDisabledRaw(raw, presetId, wantDisabled);
      if (!next.found && !wantDisabled) {
        // The row vanished (hand edit): re-project it before toggling. The
        // unlocked projection runs here because this critical section already
        // holds the lock, and the lock is not reentrant.
        await projectPresetRows({});
        const reprojected = setPresetRowDisabledRaw(await readPatchRaw(), presetId, false);
        if (!reprojected.found) return { ok: false, error: `无法为预设 "${presetId}" 建立投影行` };
        if (reprojected.changed) await writePatchRaw(reprojected.raw);
      } else if (next.changed) {
        await writePatchRaw(next.raw);
      }
      return {
        ok: true,
        id: presetId,
        enabled: !wantDisabled,
        message: `预设 "${presetId}" 已${wantDisabled ? '停用' : '启用'}（profile 投影行 disabled=${wantDisabled}）。`,
      };
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Move a `.disabled`/legacy-mirror directory back under the canonical root. */
async function restorePresetDirectory(presetId, target) {
  const canonical = path.join(userPresetRoot(), presetId);
  if (target.directory === canonical) return canonical;
  const source = target.directory;
  if (!source) return canonical;
  try {
    await fs.access(canonical);
    return canonical;
  } catch {
    // Expected: the canonical location is free.
  }
  await fs.rename(source, canonical);
  return canonical;
}

/**
 * Clone one authoring directory and project the copy. The DSH roster is read
 * back afterwards, so a projection that DSH does not register is reported as a
 * failure instead of a silent success.
 */
export async function copyPreset(ctx, sourceId, newId, displayName) {
  if (!sourceId || !newId) return { ok: false, error: 'sourceId and newId are required' };
  if (!PRESET_ID.test(newId)) {
    return { ok: false, error: `新预设 ID "${newId}" 不合法，必须匹配 /^[a-z0-9][a-z0-9-]*$/` };
  }
  const listed = await listPresets(ctx);
  const source = listed.presets.find((preset) => preset.id === sourceId);
  if (!source) return { ok: false, error: `预设 "${sourceId}" 不存在` };
  if (!source.directory) {
    return {
      ok: false,
      error: `预设 "${sourceId}" 没有可复制的作者目录（它由 DSH 自身的层声明），无法克隆。`,
    };
  }
  const destination = path.join(userPresetRoot(), newId);
  const sourceDirectory = source.path ? path.dirname(source.path) : null;
  if (!sourceDirectory) return { ok: false, error: `预设 "${sourceId}" 缺少作者目录` };

  try {
    await fs.access(destination);
    return { ok: false, error: `目标目录已存在，拒绝覆盖：${destination}` };
  } catch {
    // Expected: the destination must not exist.
  }

  try {
    await fs.cp(sourceDirectory, destination, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `复制作者目录失败：${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    const metadata = await readPresetMetadata(destination, newId);
    await writePresetMetadata(destination, {
      ...metadata,
      name: typeof displayName === 'string' && displayName.trim() !== '' ? displayName.trim() : `${metadata.name} 副本`,
    });
    await rewriteCopiedMetadata(destination);
    // The projection writes the composition; the rollback below removes the row
    // again, so both run under one section rather than racing the injection.
    // `listPresets` is outside it because it only reads the DSH roster.
    await withPatchLock(() => projectPresetRows({}));
    const observed = await listPresets(ctx);
    const created = observed.presets.find((preset) => preset.id === newId);
    if (!created) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
      await withPatchLock(async () => {
        const rolled = removePresetRowRaw(await readPatchRaw(), newId);
        if (rolled.removed > 0) await writePatchRaw(rolled.raw).catch(() => undefined);
      });
      return { ok: false, error: `已复制目录，但 DSH roster 未包含 "${newId}"，已回滚。` };
    }
    return { ok: true, id: newId, name: created.name, message: `预设 "${newId}" 已克隆并投影到 profile。` };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readPresetMetadata(directory, id) {
  try {
    const raw = await fs.readFile(metadataDocumentPath(directory), 'utf8');
    const value = parse(raw) ?? {};
    return {
      name: typeof value.name === 'string' && value.name ? value.name : id,
      description: typeof value.description === 'string' ? value.description : '',
      ...(Number.isFinite(value.order) ? { order: value.order } : {}),
    };
  } catch {
    return { name: id, description: '' };
  }
}

async function writePresetMetadata(directory, metadata) {
  const lines = [`name: ${JSON.stringify(metadata.name)}`];
  if (metadata.description) lines.push(`description: ${JSON.stringify(metadata.description)}`);
  if (Number.isFinite(metadata.order)) lines.push(`order: ${metadata.order}`);
  await fs.writeFile(metadataDocumentPath(directory), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * A clone must not answer to the original preset's identity. mv-superds keys
 * its own guidance by `profileId:` in `mv-superds.yml`, which sits next to the
 * composition; the DSH composition itself carries no preset id.
 */
async function rewriteCopiedMetadata(directory) {
  const file = path.join(directory, 'mv-superds.yml');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  const next = raw.replace(
    /(^|\n)(\s*profileId:\s*)([^\n]+)/u,
    (match, lead, key) => `${lead}${key}${path.basename(directory)}`,
  );
  if (next !== raw) await fs.writeFile(file, next, 'utf8');
}

/** Delete a preset: its projected row first, then its authoring directory. */
export async function deletePreset(ctx, presetId, force = false) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const listed = await listPresets(ctx);
  const target = listed.presets.find((preset) => preset.id === presetId);
  if (!target) return { ok: false, error: `预设 "${presetId}" 不存在` };

  if (!target.writable) {
    if (!force) {
      return {
        ok: false,
        requiresForce: true,
        system: true,
        error: `预设 "${presetId}" 属于 DSH 官方层，mv-AIDE 无法删除其内容；可改为停用它。`,
      };
    }
    return {
      ok: false,
      error: `预设 "${presetId}" 由 DSH 官方层提供，没有可删除的作者目录。`,
    };
  }

  try {
    await withPatchLock(async () => {
      const raw = await readPatchRaw();
      const removed = removePresetRowRaw(raw, presetId);
      if (removed.removed > 0) await writePatchRaw(removed.raw);
    });
    const directory = target.directory ?? (target.path ? path.dirname(target.path) : null);
    if (directory) {
      await fs.rm(directory, { recursive: true, force: false });
    }
    const observed = await listPresets(ctx);
    if (observed.presets.some((preset) => preset.id === presetId)) {
      return { ok: false, error: `删除操作返回，但 mv-AIDE 仍能看到 "${presetId}"` };
    }
    return {
      ok: true,
      id: presetId,
      forcedSystemDelete: false,
      message: `预设 "${presetId}" 的投影行与作者目录已删除。`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Show one preset to the user: its authoring directory on ≤0.1.6, its document
 * (composition, falling back to the metadata file) on ≥0.1.7.
 */
export async function openPresetDocument(ctx, presetId) {
  if (!presetId || !PRESET_ID.test(presetId)) {
    return { ok: false, error: 'presetId is required and must be a valid DSH preset id' };
  }
  const opener = resolvePresetOpener(ctx);
  if (!opener) {
    return { ok: false, error: 'DSH preset document opener is not available in current context' };
  }
  const listed = await listPresets(ctx);
  const target = listed.presets.find((preset) => preset.id === presetId);
  try {
    const result = await opener.open(presetId, {
      path: target?.path ?? target?.document ?? null,
      directory: target?.directory ?? null,
    });
    // The opener's payload passes through, but this envelope stays authoritative
    // about which seam answered.
    return { ...result, ok: true, adapter: opener.adapter, presetId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export { AGENT_PRESET_PACKAGE };
