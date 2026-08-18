import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function patchFile() {
  return path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
}

function parsePatchDocument(raw) {
  const source = String(raw || '').trim() === '' ? '[]\n' : String(raw);
  const document = parseDocument(source, {
    keepSourceTokens: true,
    prettyErrors: true,
    strict: false,
  });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  if (document.contents === null) document.contents = document.createNode([]);
  if (!isSeq(document.contents)) {
    throw new Error('cordis.patch.yml must contain a top-level YAML sequence');
  }
  return { document, source };
}

function mapId(row) {
  if (!isMap(row)) return null;
  const value = row.get('id');
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

/**
 * Update one top-level DSH user-patch row without reparsing/re-emitting nested
 * config by hand. The YAML Document API preserves comments, nested values,
 * scalar types, and unrelated rows. A historical `include:<id>` override is
 * migrated only when it is the sole unambiguous row for the requested id.
 */
export function setPluginDisabledOverrideRaw(raw, pluginId, disabled) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('pluginId is required');

  const eol = String(raw || '').includes('\r\n') ? '\r\n' : '\n';
  const { document } = parsePatchDocument(raw);
  const rows = document.contents.items;
  const canonical = rows.filter((row) => mapId(row) === id);
  const legacyId = `include:${id}`;
  const legacy = rows.filter((row) => mapId(row) === legacyId);

  if (canonical.length > 1 || legacy.length > 1 || (canonical.length > 0 && legacy.length > 0)) {
    throw new Error(`ambiguous persistent patch rows for plugin "${id}"`);
  }

  let target = canonical[0] || legacy[0] || null;
  if (target && !isMap(target)) target = null;

  if (!target) {
    target = document.createNode({ id, disabled: Boolean(disabled) });
    document.contents.add(target);
  } else {
    if (legacy.length === 1) target.set('id', id);
    target.set('disabled', Boolean(disabled));
  }

  let rendered = String(document);
  if (eol === '\r\n') rendered = rendered.replace(/\n/gu, '\r\n');
  return rendered;
}

function renderDocument(document, raw) {
  const eol = String(raw || '').includes('\r\n') ? '\r\n' : '\n';
  let rendered = String(document);
  if (eol === '\r\n') rendered = rendered.replace(/\n/gu, '\r\n');
  return rendered;
}

async function atomicWritePatch(file, content) {
  const temporary = `${file}.mv-dsh-manager-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Remove user-layer registration material for one Loader id. This handles both
 * top-level id overrides and entries nested under an `insert:` patch. It does
 * not pretend a bundle-owned/core row can be deleted from its lower layer; the
 * caller can detect `removed === 0` and choose an explicit high-risk fallback.
 */
export function removePluginRegistrationRaw(raw, pluginId) {
  const id = String(pluginId || '').trim();
  if (!id) throw new Error('pluginId is required');
  const ids = new Set([id, `include:${id}`]);
  const { document } = parsePatchDocument(raw);
  let removed = 0;
  const kept = [];

  for (const row of document.contents.items) {
    if (!isMap(row)) {
      kept.push(row);
      continue;
    }
    if (ids.has(mapId(row))) {
      removed += 1;
      continue;
    }

    const insert = row.get('insert', true);
    if (isSeq(insert)) {
      const before = insert.items.length;
      insert.items = insert.items.filter((item) => !ids.has(mapId(item)));
      removed += before - insert.items.length;
      if (insert.items.length === 0 && row.items.length === 1) continue;
    }
    kept.push(row);
  }

  document.contents.items = kept;
  return { raw: renderDocument(document, raw), removed };
}

export async function persistPluginDisabled(pluginId, disabled) {
  const file = patchFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = await fs.readFile(file, 'utf8').catch(() => '[]\n');
  const updated = setPluginDisabledOverrideRaw(raw, pluginId, Boolean(disabled));
  await atomicWritePatch(file, updated);
  return { file, changed: updated !== raw };
}

export async function persistPluginRemoval(pluginId) {
  const file = patchFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const raw = await fs.readFile(file, 'utf8').catch(() => '[]\n');
  const result = removePluginRegistrationRaw(raw, pluginId);
  if (result.raw !== raw) await atomicWritePatch(file, result.raw);
  return { file, changed: result.raw !== raw, removed: result.removed };
}
