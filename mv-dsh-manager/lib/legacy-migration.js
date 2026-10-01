// One-time migration of mv-AIDE state that lived in the released DSH settings
// document.
//
// ≤0.1.6 kept plugin settings in `~/.dsh/settings.yaml`, and mv-AIDE's
// associated-roots document (`mv-dsh-subworkspace.workspaces`) lived *only*
// there. 0.1.7 imports that file once into the profile composition — the copy
// survives as `~/.dsh/settings.yaml.imported`, which still carries the
// namespace — but it no longer feeds any plugin: the mv-AIDE settings store
// (`~/.mv-aide/dsh/settings.json`, see mv-dsh-settings/lib/store.js) is
// the authority now. Without this seed the user's associations are silently
// gone, which is exactly what the live `/api/mv-dsh-subworkspace/roots` route
// showed before the migration existed.
//
// Presets need no equivalent step: their authoring directories stay on disk and
// `presets-service.syncPresetRows()` re-projects them from the directories,
// including the legacy `.disabled` naming.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  mvAideSettingsFile,
  readSettingsDocument,
  settingsScopeFor,
  writeSettingsDocumentQueued,
} from '../../mv-dsh-settings/lib/store.js';

export const SUBWORKSPACE_NAMESPACE = 'mv-dsh-subworkspace';
/** Marker written with the seeded document, so the migration runs once. */
export const LEGACY_IMPORT_MARKER = 'legacyImportedAt';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/** Candidate legacy settings documents, newest convention first. */
function legacySettingsFiles(home = dshHome()) {
  return [
    path.join(home, 'settings.yaml'),
    path.join(home, 'settings.yaml.imported'),
  ];
}

function normalizeWorkspaces(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const workspaces = {};
  for (const [primary, record] of Object.entries(value)) {
    if (typeof primary !== 'string' || primary.length === 0) continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const children = Array.isArray(record.children)
      ? record.children
        .filter((child) => child && typeof child === 'object' && typeof child.path === 'string')
        .map((child) => ({
          // The store identifies every child by id and drops one without it, so
          // a hand-edited document (or one written before ids existed) must get
          // a real id here instead of losing the association silently.
          id: typeof child.id === 'string' && child.id.length > 0 ? child.id : randomUUID(),
          path: child.path,
          label: typeof child.label === 'string' && child.label.length > 0 ? child.label : path.basename(child.path),
        }))
      : [];
    workspaces[primary] = {
      enabled: record.enabled === true,
      children,
    };
  }
  return workspaces;
}

/** Read `mv-dsh-subworkspace` out of a released settings document. */
export async function readLegacySubworkspaceState(home = dshHome()) {
  for (const file of legacySettingsFiles(home)) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parse(raw, { strict: false });
    } catch {
      continue;
    }
    const block = parsed?.[SUBWORKSPACE_NAMESPACE];
    const workspaces = normalizeWorkspaces(block?.workspaces);
    if (!workspaces) continue;
    return {
      file,
      version: Number.isFinite(block?.version) ? block.version : 1,
      workspaces,
    };
  }
  return null;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realPathOrNull(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

/**
 * Drop stored associations whose primary workspace is a system-temp directory.
 *
 * Only these are provably junk: no durable workspace lives under `os.tmpdir()`,
 * and a test run's scratch vault cannot dispatch anything after it is removed.
 * A row for a path that merely looks missing (an unmounted volume, a moved
 * vault) is deliberately KEPT — its configuration is the user's, and the old
 * surface showed such rows as detached rather than deleting them. Leaving a
 * temp row in the store would make the migration below read the store as
 * "already owns associated roots" and skip the user's real document.
 *
 * Both the lexical path and its realpath are compared, because macOS reports
 * `/var/folders/...` while the same directory resolves to `/private/var/...`.
 * @returns `{ workspaces, pruned: [{ primary, reason }] }`.
 */
export async function pruneEphemeralWorkspaces(workspaces, options = {}) {
  const entries = workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)
    ? Object.entries(workspaces)
    : [];
  const rawTemp = options.tmpdir ?? os.tmpdir();
  const tempRoots = [rawTemp, await realPathOrNull(rawTemp)].filter((root) => typeof root === 'string' && root.length > 0);
  const kept = {};
  const pruned = [];
  for (const [primary, record] of entries) {
    const candidates = [primary, await realPathOrNull(primary)].filter((candidate) => typeof candidate === 'string');
    const inTemp = candidates.some((candidate) => tempRoots.some((root) => isInside(candidate, root)));
    if (inTemp) pruned.push({ primary, reason: 'primary workspace lives in the system temp directory' });
    else kept[primary] = record;
  }
  return { workspaces: kept, pruned };
}

/** The stored (effective) namespace state, live scope first, document second. */
async function currentNamespaceState(scope, options) {
  if (scope && typeof scope.get === 'function') {
    const value = scope.get();
    if (value && typeof value === 'object') return value;
  }
  const document = await readSettingsDocument(options.filePath ?? mvAideSettingsFile(), options.log);
  const stored = document.namespaces[SUBWORKSPACE_NAMESPACE];
  return stored && typeof stored === 'object' ? stored : null;
}

/** Persist the namespace state through the live scope, or into the file. */
async function writeNamespaceState(state, scope, options) {
  if (scope && typeof scope.replace === 'function') {
    await scope.replace(state);
    return;
  }
  // `options.filePath` names the document in tests; production always resolves
  // the plugin-owned store, the same default the read path uses. The read and
  // the write go through the store's queue, so this cannot interleave with a
  // scope write from another namespace and lose one of the two updates.
  const filePath = options.filePath ?? mvAideSettingsFile();
  await writeSettingsDocumentQueued(filePath, (document) => {
    document.namespaces[SUBWORKSPACE_NAMESPACE] = state;
  }, options.log);
}

/**
 * Seed the mv-AIDE store with the released associated-roots document, once.
 *
 * A store that already holds *live* associations (or an import marker) is left
 * alone: this is a migration, never an overwrite. Rows whose primary directory
 * disappeared are pruned first, so a store polluted by dead rows cannot veto
 * the import. When the subworkspace plugin is already mounted the seed is
 * delivered through its live scope, so the running instance picks it up
 * without a restart.
 * @returns `{ migrated, pruned, prunedPaths, reason?, file?, primaries?, children? }`.
 */
export async function migrateSubworkspaceAssociations(options = {}) {
  const home = options.home ?? dshHome();
  const legacy = options.legacy ?? await readLegacySubworkspaceState(home);
  const scope = settingsScopeFor(SUBWORKSPACE_NAMESPACE);
  const current = await currentNamespaceState(scope, options);
  // The marker lives in the stored user layer only: the scope's effective view
  // deliberately drops keys its schema does not declare. A second call after the
  // user cleared every association must still see the marker.
  const user = typeof scope?.user === 'function' ? scope.user() : {};
  const stored = current && typeof current.workspaces === 'object' && current.workspaces !== null
    ? current.workspaces
    : {};
  const { workspaces: survivors, pruned } = await pruneEphemeralWorkspaces(stored, options);
  const head = { migrated: false, pruned: pruned.length, prunedPaths: pruned.map((entry) => entry.primary) };

  if (pruned.length > 0) {
    // Reported, never persisted. These rows are the user's own configuration
    // and 规范三 forbids deleting user content on a read path; they are only
    // left out of the decision below, which is what stops a temp-polluted store
    // from vetoing the import of the user's real document. Cleaning them up is
    // the user's call through the ordinary remove control.
    options.log?.(`mv-dsh-manager: ignoring ${pruned.length} temp-scoped associated-roots row(s): ${pruned.map((entry) => `${entry.primary} (${entry.reason})`).join('; ')}`);
  }

  if (!legacy) return { ...head, reason: 'no legacy associated-roots document' };

  const primaries = Object.keys(legacy.workspaces);
  if (primaries.length === 0) return { ...head, reason: 'legacy document has no associated roots' };

  const marked = typeof user[LEGACY_IMPORT_MARKER] === 'number';
  if (marked) return { ...head, reason: 'mv-AIDE store already imported the legacy document' };
  if (Object.keys(survivors).length > 0) return { ...head, reason: 'mv-AIDE store already owns associated roots' };

  const state = {
    version: legacy.version,
    workspaces: legacy.workspaces,
    [LEGACY_IMPORT_MARKER]: Date.now(),
  };
  await writeNamespaceState(state, scope, options);

  return {
    ...head,
    migrated: true,
    file: legacy.file,
    primaries: primaries.length,
    children: primaries.reduce((total, primary) => total + legacy.workspaces[primary].children.length, 0),
  };
}
