// Agent-preset projection into the DSH profile composition.
//
// 0.1.5 published presets as directories: `~/.dsh/.agent-presets/<id>/` with
// `preset.yml` (display metadata) plus `agent.cordis.yml` (the composition the
// preset mounts). 0.1.7 deleted that loader and replaced it with a row:
// `@deepseek-ai/dsh-agent-preset` with `config: { id, name?, description?,
// order?, plugins }`, registered into `ctx.agentPresets`. There is no
// directory-discovery service, no `copy`, no `remove`, and no `path`/`trust` on
// the roster any more.
//
// mv-AIDE keeps the directory layout as its *authoring* format — mv-superds
// reads `mv-superds.yml` out of those directories, and users already have
// presets there — and projects it into the profile's `cordis.patch.yml`, which
// is the only composition surface a user layer owns. This module is that
// projection: read a preset directory, rewrite the references that only made
// sense relative to the directory, and maintain exactly one row per preset.
//
// Path rewrites are mandatory, not cosmetic: a plugin row's relative specifier
// resolves against its composition's `baseUrl`, which for a profile row is the
// profile directory (vendor/loader/src/config/tree.ts:120-125,
// apps/cli/src/profile-boot.ts:158-162), and the `!!js` scope exposes that same
// `baseUrl` (vendor/loader/src/config/utils.ts:6-11). A preset's own
// `./custom-bash.mjs` and `new URL('skills/', baseUrl)` therefore have to name
// the preset directory explicitly once they move into the profile.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

/** The plugin every projected preset row names. */
export const AGENT_PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset';
/** Row-id prefix, so a projected row is identifiable without reading its config. */
export const PRESET_ROW_PREFIX = 'agent-preset-';

export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u;
export const USER_PRESET_DIR = '.agent-presets';
/** Legacy mirror some earlier mv-aide builds moved disabled presets into. */
export const LEGACY_DISABLED_DIR = '.agent-presets-disabled';
export const COMPOSITION_FILE = 'agent.cordis.yml';
export const METADATA_FILE = 'preset.yml';
const DISABLED_SUFFIX = '.disabled';

export function presetRowId(presetId) {
  return `${PRESET_ROW_PREFIX}${presetId}`;
}

export function presetIdFromRowId(rowId) {
  const value = String(rowId ?? '');
  return value.startsWith(PRESET_ROW_PREFIX) ? value.slice(PRESET_ROW_PREFIX.length) : null;
}

/** `file:///abs/dir/` — always trailing-slashed, so URL joins behave. */
export function directoryUrl(directory) {
  const normalized = directory.endsWith('/') ? directory : `${directory}/`;
  const href = pathToFileURL(normalized).href;
  return href.endsWith('/') ? href : `${href}/`;
}

// ── Composition rewrite ──────────────────────────────────────────────────
// Only two shapes need rewriting, and both live on scalar nodes, so comments,
// anchors, block scalars, and every unrelated value survive untouched.

function rewriteRelativeSpecifier(value, presetUrl) {
  if (typeof value !== 'string' || !value.startsWith('.')) return null;
  try {
    return new URL(value, presetUrl).href;
  } catch {
    return null;
  }
}

function rewriteJsExpression(value, presetUrl) {
  const quoted = JSON.stringify(presetUrl);
  // A bare `baseUrl` identifier is the old composition's own directory; in a
  // profile row the loader's `baseUrl` is the profile directory instead.
  return value.replace(/\bbaseUrl\b/gu, quoted);
}

function walkNodes(node, visit) {
  if (isMap(node)) {
    for (const pair of node.items) {
      visit(pair.key, pair.value, pair);
      walkNodes(pair.value, visit);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      // A sequence item can itself be a whole composition row expressed as one
      // `!!js` scalar, so items are visited, not only map values.
      visit(undefined, item, undefined);
      walkNodes(item, visit);
    }
    return;
  }
}

/**
 * Rewrite every preset-directory-relative reference in one composition.
 * @param compositionRaw - the preset's `agent.cordis.yml` text.
 * @param directory - absolute preset directory.
 * @returns rewritten YAML text (unchanged text when nothing needed rewriting).
 */
export function rewriteCompositionPaths(compositionRaw, directory) {
  const presetUrl = directoryUrl(directory);
  const document = parseDocument(String(compositionRaw ?? ''), { prettyErrors: true, strict: false });
  if (document.errors.length > 0) throw document.errors[0];
  let changed = false;
  walkNodes(document.contents, (key, value) => {
    if (isScalar(key) && key.value === 'name' && isScalar(value)) {
      const rewritten = rewriteRelativeSpecifier(value.value, presetUrl);
      if (rewritten !== null && rewritten !== value.value) {
        value.value = rewritten;
        changed = true;
      }
      return;
    }
    if (isScalar(value) && value.tag === 'tag:yaml.org,2002:js' && typeof value.value === 'string') {
      const rewritten = rewriteJsExpression(value.value, presetUrl);
      if (rewritten !== value.value) {
        value.value = rewritten;
        changed = true;
      }
    }
  });
  return changed ? String(document) : String(compositionRaw ?? '');
}

// ── Directory discovery ──────────────────────────────────────────────────

async function readMetadata(directory, id) {
  try {
    const raw = await fs.readFile(path.join(directory, METADATA_FILE), 'utf8');
    const document = parseDocument(raw, { prettyErrors: true, strict: false });
    if (document.errors.length > 0) throw document.errors[0];
    const value = document.toJS?.() ?? {};
    return {
      name: typeof value?.name === 'string' && value.name ? value.name : id,
      description: typeof value?.description === 'string' ? value.description : '',
      order: Number.isFinite(value?.order) ? value.order : undefined,
    };
  } catch {
    return { name: id, description: '', order: undefined };
  }
}

/**
 * Read one authoring directory into a projectable preset.
 * @param directory - absolute preset directory.
 * @param id - preset id (the directory basename, without a `.disabled` suffix).
 * @returns `{ id, name, description, order, composition, directory }`, or null
 *   when the directory carries no composition to project.
 */
export async function readPresetDirectory(directory, id) {
  let composition;
  try {
    composition = await fs.readFile(path.join(directory, COMPOSITION_FILE), 'utf8');
  } catch {
    return null;
  }
  const metadata = await readMetadata(directory, id);
  return {
    id,
    name: metadata.name,
    description: metadata.description,
    order: metadata.order,
    composition: rewriteCompositionPaths(composition, directory),
    directory,
  };
}

/**
 * Every preset the authoring roots hold, newest convention first. A directory
 * whose name carries `.disabled` is reported as disabled; the legacy mirror
 * root is reported as disabled as well, because nothing in DSH reads it.
 * @param dshHome - `$DSH_HOME` (already resolved by the caller).
 * @returns presets plus the roots they were found under.
 */
export async function discoverPresetDirectories(dshHome) {
  const found = new Map();
  const roots = [
    { root: path.join(dshHome, USER_PRESET_DIR), legacyMirror: false },
    { root: path.join(dshHome, LEGACY_DISABLED_DIR), legacyMirror: true },
  ];
  for (const { root, legacyMirror } of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const disabledByRename = entry.name.endsWith(DISABLED_SUFFIX);
      const id = disabledByRename ? entry.name.slice(0, -DISABLED_SUFFIX.length) : entry.name;
      if (!PRESET_ID.test(id) || found.has(id)) continue;
      const directory = path.join(root, entry.name);
      const preset = await readPresetDirectory(directory, id);
      if (!preset) continue;
      found.set(id, {
        ...preset,
        directoryDisabled: disabledByRename || legacyMirror,
        legacyMirror,
      });
    }
  }
  return [...found.values()];
}

// ── Patch-row maintenance ────────────────────────────────────────────────

function parsePatchDocument(raw) {
  const source = String(raw ?? '').trim() === '' ? '[]\n' : String(raw);
  const document = parseDocument(source, { keepSourceTokens: true, prettyErrors: true, strict: false });
  if (document.errors.length > 0) throw document.errors[0];
  if (document.contents === null) document.contents = document.createNode([]);
  if (!isSeq(document.contents)) throw new Error('cordis.patch.yml must contain a top-level YAML sequence');
  return { document, source };
}

function renderDocument(document, raw) {
  const eol = String(raw ?? '').includes('\r\n') ? '\r\n' : '\n';
  const rendered = String(document);
  return eol === '\r\n' ? rendered.replace(/\n/gu, '\r\n') : rendered;
}

/** Every row of one patch document, top level first, then `insert:` children. */
function eachRow(document, visit) {
  for (const row of document.contents.items) {
    visit(row);
    if (!isMap(row)) continue;
    const insert = row.get('insert', true);
    if (isSeq(insert)) for (const child of insert.items) visit(child);
  }
}

function rowConfigId(row) {
  if (!isMap(row)) return null;
  const config = row.get('config', true);
  if (!isMap(config)) return null;
  const id = config.get('id');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function rowMatchesPreset(row, presetId) {
  if (!isMap(row)) return false;
  const rowId = row.get('id');
  if (typeof rowId === 'string' && rowId === presetRowId(presetId)) return true;
  return rowConfigId(row) === presetId;
}

function readDisabled(row) {
  const value = isMap(row) ? row.get('disabled') : undefined;
  if (typeof value === 'boolean') return value;
  if (isMap(value)) return 'conditional';
  return false;
}

/**
 * Read every projected preset row.
 * @param raw - `cordis.patch.yml` text.
 * @returns `[{ rowId, presetId, name, description, order, disabled, nested }]`.
 */
export function listPresetRows(raw) {
  const { document } = parsePatchDocument(raw);
  const rows = [];
  eachRow(document, (row) => {
    if (!isMap(row)) return;
    const presetId = rowConfigId(row);
    const rowId = row.get('id');
    const looksProjected = presetId !== null
      && (row.get('name') === AGENT_PRESET_PACKAGE
        || (typeof rowId === 'string' && rowId.startsWith(PRESET_ROW_PREFIX)));
    if (!looksProjected) return;
    const config = row.get('config', true);
    const name = config.get('name');
    const description = config.get('description');
    const order = config.get('order');
    rows.push({
      rowId: typeof rowId === 'string' ? rowId : presetRowId(presetId),
      presetId,
      name: typeof name === 'string' ? name : presetId,
      description: typeof description === 'string' ? description : '',
      order: typeof order === 'number' ? order : undefined,
      disabled: readDisabled(row),
    });
  });
  return rows;
}

function presetConfig(preset) {
  const config = { id: preset.id };
  if (typeof preset.name === 'string' && preset.name.length > 0) config.name = preset.name;
  if (typeof preset.description === 'string' && preset.description.length > 0) config.description = preset.description;
  if (Number.isFinite(preset.order)) config.order = preset.order;
  return config;
}

/**
 * Insert or replace one preset row, leaving every other row byte-identical.
 * The composition is attached as parsed YAML, so `!!js` tags, comments, block
 * scalars, and anchors inside it survive the move.
 * @param raw - current `cordis.patch.yml` text.
 * @param preset - `{ id, name, description, order, disabled, composition }`.
 * @returns `{ raw, changed }`.
 */
export function upsertPresetRowRaw(raw, preset) {
  const { document } = parsePatchDocument(raw);
  let replaced = false;
  for (const row of document.contents.items) {
    if (!isMap(row)) continue;
    const insert = row.get('insert', true);
    if (!isSeq(insert)) continue;
    insert.items = insert.items.map((child) => {
      if (!rowMatchesPreset(child, preset.id)) return child;
      replaced = true;
      return buildPresetRow(document, preset, child);
    });
  }
  if (!replaced) {
    for (const row of document.contents.items) {
      if (isMap(row) && rowMatchesPreset(row, preset.id)) {
        replaced = true;
        break;
      }
    }
  }

  if (!replaced) {
    const row = buildPresetRow(document, preset, null);
    let insertRow = document.contents.items.find((candidate) => isMap(candidate) && isSeq(candidate.get('insert', true)));
    if (!insertRow) {
      insertRow = document.createNode({ insert: [] });
      document.contents.add(insertRow);
    }
    insertRow.get('insert').add(row);
  }

  const rendered = renderDocument(document, raw);
  return { raw: rendered, changed: rendered !== raw };
}

function buildPresetRow(document, preset, existing) {
  const compositionDocument = parseDocument(String(preset.composition ?? ''), {
    prettyErrors: true,
    strict: false,
  });
  if (compositionDocument.errors.length > 0) throw compositionDocument.errors[0];
  const plugins = compositionDocument.contents === null
    ? document.createNode([])
    : compositionDocument.contents;
  const row = existing ?? document.createNode({ id: presetRowId(preset.id), name: AGENT_PRESET_PACKAGE });
  row.set('id', presetRowId(preset.id));
  row.set('name', AGENT_PRESET_PACKAGE);
  row.setIn(['config'], document.createNode(presetConfig(preset)));
  row.setIn(['config', 'plugins'], plugins);
  row.set('disabled', preset.disabled === true);
  return row;
}

/**
 * Remove one preset row wherever it sits.
 * @returns `{ raw, removed }` with `removed` counting the rows deleted.
 */
export function removePresetRowRaw(raw, presetId) {
  const { document } = parsePatchDocument(raw);
  let removed = 0;
  const kept = [];
  for (const row of document.contents.items) {
    if (isMap(row) && rowMatchesPreset(row, presetId)) {
      removed += 1;
      continue;
    }
    if (isMap(row)) {
      const insert = row.get('insert', true);
      if (isSeq(insert)) {
        const before = insert.items.length;
        insert.items = insert.items.filter((child) => !rowMatchesPreset(child, presetId));
        removed += before - insert.items.length;
        if (insert.items.length === 0 && row.items.length === 1) continue;
      }
    }
    kept.push(row);
  }
  document.contents.items = kept;
  const rendered = renderDocument(document, raw);
  return { raw: rendered, removed };
}

/**
 * Set one preset row's enablement. The row's own `disabled` flag is the switch:
 * the composition stays intact, so re-enabling is a single boolean write.
 * @returns `{ raw, changed }` and `found: false` when no row owns the preset.
 */
export function setPresetRowDisabledRaw(raw, presetId, disabled) {
  const { document } = parsePatchDocument(raw);
  let found = false;
  eachRow(document, (row) => {
    if (!rowMatchesPreset(row, presetId)) return;
    row.set('disabled', Boolean(disabled));
    found = true;
  });
  if (!found) return { raw, changed: false, found: false };
  const rendered = renderDocument(document, raw);
  return { raw: rendered, changed: rendered !== raw, found: true };
}
