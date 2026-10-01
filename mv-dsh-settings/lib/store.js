// Plugin-owned settings store for the mv-AIDE DSH plugins.
//
// The released DSH settings plane changed shape: ≤0.1.6 exposed
// `ctx.settings.register(namespace, schema, …)` (a live, schema-validated
// scope), while ≥0.1.7 exposes only schema-derived *plugin configuration
// forms* (`ctx.settings.configure`) and no namespace registration at all. The
// mv-AIDE feature switches therefore must not depend on that plane; this module
// is their single source of truth.
//
// One user-level file holds every mv-AIDE namespace, mirroring how the released
// settings file was user-level rather than profile-scoped:
//
//   ~/.mv-aide/dsh/settings.json
//   { "schema": 1, "namespaces": { "mv-agent": { … }, … } }
//
// Writes are atomic (tmp + rename) and keep one `.bak` copy. Reads fail closed
// to the caller's defaults and never throw into plugin activation: a corrupt or
// unreadable file quarantines itself and the plugins keep running on defaults.
//
// This module lives in its own package rather than inside
// `@mv-aide/mv-dsh-compat` on purpose. The three managed plugins mount inside
// one DSH process and must agree on one document, one write queue and one
// namespace registry, so the state below IS shared between them — which is
// exactly the "independent state" 规范十一.3 forbids a pure compatibility
// library to own. Moving it out leaves `@mv-aide/mv-dsh-compat` a pure library
// without changing a single behaviour. The path authority stays where 规范三
// puts it (`mv-dsh-compat/lib/paths.js`); both packages are siblings under
// `@mv-aide/`, so the relative import resolves the same in this repository and
// inside the DSH profile.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { mvAideSettingsFile } from '../../mv-dsh-compat/lib/paths.js';

export const SETTINGS_FILE_SCHEMA = 1;

// Re-exported because every consumer imports the path from this module, while
// 规范三:60 keeps the single authority in `mv-dsh-compat/lib/paths.js`.
export { mvAideSettingsFile };

function emptyDocument() {
  return { schema: SETTINGS_FILE_SCHEMA, namespaces: {} };
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDocument();
  const namespaces = value.namespaces && typeof value.namespaces === 'object' && !Array.isArray(value.namespaces)
    ? value.namespaces
    : {};
  const clean = {};
  for (const [namespace, entry] of Object.entries(namespaces)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) clean[namespace] = { ...entry };
  }
  return { schema: SETTINGS_FILE_SCHEMA, namespaces: clean };
}

/** Read the document, quarantining an unreadable/corrupt file instead of failing. */
export async function readSettingsDocument(filePath = mvAideSettingsFile(), log = () => {}) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`mv-aide settings unreadable (${filePath}): ${error?.message ?? error}`);
    return emptyDocument();
  }
  if (text.trim() === '') return emptyDocument();
  try {
    return normalizeDocument(JSON.parse(text));
  } catch (error) {
    log(`mv-aide settings are not valid JSON; starting from defaults: ${error?.message ?? error}`);
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, quarantine);
    } catch (renameError) {
      // The next write would otherwise overwrite the un-quarantined file and
      // the user's settings would be gone with nothing having said so.
      log(`mv-aide settings could not be quarantined as ${quarantine} (${renameError?.message ?? renameError}); `
        + `the unreadable file is still at ${filePath}`);
    }
    return emptyDocument();
  }
}

/** Directory `0700`, tightened even when an earlier version created it wider. */
async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

/**
 * Persist the document atomically, keeping one `.bak` of the previous bytes.
 *
 * One deterministic temporary name, never a pid-suffixed one: every writer goes
 * through {@link writeSettingsDocumentQueued}, so a crash can leave at most that
 * single file behind instead of accumulating one orphan per attempt. The `.bak`
 * is a copy rather than a rename on purpose — renaming the live document away
 * first would leave readers seeing ENOENT and falling back to defaults, and a
 * backup is not worth a window in which the user's settings appear to be gone.
 *
 * @param filePath - destination document.
 * @param document - complete document to write.
 */
export async function writeSettingsDocument(filePath, document) {
  const directory = path.dirname(filePath);
  const body = `${JSON.stringify(normalizeDocument(document), null, 2)}\n`;
  await ensurePrivateDirectory(directory);
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  await fs.copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
  await fs.rename(temporary, filePath);
}

// ── In-process change bus ────────────────────────────────────────────────
// Every mv-AIDE host plugin imports this same file through the profile's
// compat package, so one module instance serves all of them and a write from
// any of them (or from the manager's HTTP route) reaches the others live.
const bus = new Map();

/** Subscribe to one namespace's effective values; returns an unsubscribe. */
export function subscribeSettingsNamespace(namespace, listener) {
  let listeners = bus.get(namespace);
  if (!listeners) {
    listeners = new Set();
    bus.set(namespace, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) bus.delete(namespace);
  };
}

function notifySettingsNamespace(namespace, effective) {
  for (const listener of [...(bus.get(namespace) ?? [])]) {
    try {
      listener(effective);
    } catch {
      // A listener must never break a settings write.
    }
  }
}

// ── Live scope registry ──────────────────────────────────────────────────
// The manager's settings route serves every mv-AIDE namespace, but each plugin
// owns its own scope. One shared module instance makes an in-process registry
// the whole handshake: a plugin publishes its scope, the route enumerates them.
const scopes = new Map();

function registerSettingsScope(scope) {
  scopes.set(scope.namespace, scope);
  return () => {
    if (scopes.get(scope.namespace) === scope) scopes.delete(scope.namespace);
  };
}

/** Every live mv-AIDE settings scope in this process, keyed by namespace name. */
export function registeredSettingsScopes() {
  return [...scopes.values()];
}

/** One live scope by namespace, or null when that plugin is not mounted. */
export function settingsScopeFor(namespace) {
  return scopes.get(namespace) ?? null;
}

// ── Serialized document writes ───────────────────────────────────────────
// Every namespace shares one document, so writes are queued per file: a
// read-modify-write pair from two namespaces must never lose one of them.
const writeQueues = new Map();

function enqueueDocumentWrite(filePath, task) {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(filePath, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * One serialized read-modify-write over the shared document.
 *
 * Every writer must go through here — a caller that read the document itself
 * and then called {@link writeSettingsDocument} directly would sit outside the
 * queue and could interleave with a scope write, silently losing one of the two
 * updates. `mutate` receives the freshly read document and returns nothing; the
 * document it edited is written back.
 *
 * @param filePath - destination document.
 * @param mutate - edits the read document in place.
 * @param log - diagnostic sink.
 */
export function writeSettingsDocumentQueued(filePath, mutate, log = () => {}) {
  return enqueueDocumentWrite(filePath, async () => {
    const document = await readSettingsDocument(filePath, log);
    mutate(document);
    await writeSettingsDocument(filePath, document);
    return document;
  });
}

/**
 * A settings scope with the shape the released DSH scope had, backed by the
 * mv-AIDE document. Consumers keep their existing code:
 *   - `get()` — effective values (defaults ⊕ stored user values);
 *   - `watch(listener)` — effective values on every accepted change;
 *   - `set/unset/apply/replace` — writes into this namespace's user values;
 *   - `writable` — whether writes are accepted at all.
 *
 * @param opts.namespace - document namespace owned by the caller.
 * @param opts.defaults - base values merged under the stored user values.
 * @param opts.validate - optional validator over effective values; a throw
 *   rejects the write and leaves the stored document untouched.
 * @param opts.filePath - settings document override (tests).
 * @param opts.log - diagnostic sink.
 */
export function createSettingsScope(opts) {
  const namespace = opts.namespace;
  const defaults = Object.freeze({ ...(opts.defaults ?? {}) });
  const validate = typeof opts.validate === 'function' ? opts.validate : (value) => value;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const filePath = opts.filePath ?? mvAideSettingsFile();

  let user = {};
  let effective = Object.freeze({ ...defaults });
  let ready = false;
  // Which surface owns editing: `panel` (the mv-AIDE workbench) or `dsh` (a
  // released DSH settings card on ≤0.1.6). One writer at a time.
  let manage = opts.manage === 'dsh' ? 'dsh' : 'panel';
  const listeners = new Set();

  const publish = (next) => {
    const previous = effective;
    effective = Object.freeze({ ...next });
    for (const listener of [...listeners]) {
      try {
        listener(effective, previous);
      } catch {
        // Consumer faults stay inside the consumer.
      }
    }
  };

  const compute = (nextUser) => {
    const merged = { ...defaults };
    for (const [key, value] of Object.entries(nextUser)) {
      if (typeof value === typeof defaults[key]) merged[key] = value;
    }
    const validated = validate(merged);
    return validated && typeof validated === 'object' ? { ...validated } : merged;
  };

  const write = async (mutate) => enqueueDocumentWrite(filePath, async () => {
    const document = await readSettingsDocument(filePath, log);
    const nextUser = { ...(document.namespaces[namespace] ?? {}) };
    mutate(nextUser);
    const nextEffective = compute(nextUser);
    document.namespaces[namespace] = nextUser;
    await writeSettingsDocument(filePath, document);
    user = nextUser;
    ready = true;
    publish(nextEffective);
    notifySettingsNamespace(namespace, effective);
    return effective;
  });

  const scope = {
    namespace,
    filePath,
    get writable() {
      return manage === 'panel';
    },
    /** Which surface owns editing: `'panel'` or `'dsh'`. */
    manage() {
      return manage;
    },
    setManage(source) {
      manage = source === 'dsh' ? 'dsh' : 'panel';
    },
    /** Stop serving this scope to the settings route. */
    release() {
      return unregister();
    },
    get() {
      return effective;
    },
    user() {
      return { ...user };
    },
    isReady() {
      return ready;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(listener) {
      return scope.subscribe(listener);
    },
    async load() {
      const document = await readSettingsDocument(filePath, log);
      user = { ...(document.namespaces[namespace] ?? {}) };
      ready = true;
      publish(compute(user));
      return effective;
    },
    async set(key, value) {
      return write((next) => { next[key] = value; });
    },
    async unset(key) {
      return write((next) => { delete next[key]; });
    },
    /**
     * Apply one panel save atomically: `set` values land, `unset` keys are
     * removed, everything else keeps its stored value.
     */
    async apply(patch) {
      const setValues = patch?.set && typeof patch.set === 'object' ? patch.set : {};
      const removed = Array.isArray(patch?.unset) ? patch.unset : [];
      return write((next) => {
        for (const key of removed) delete next[key];
        for (const [key, value] of Object.entries(setValues)) next[key] = value;
      });
    },
    async replace(values) {
      const source = values && typeof values === 'object' ? values : {};
      return write((next) => {
        for (const key of Object.keys(next)) delete next[key];
        for (const [key, value] of Object.entries(source)) next[key] = value;
      });
    },
  };

  const unregister = registerSettingsScope(scope);
  return scope;
}
