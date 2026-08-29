// Persistent associated-root state for @mv-aide/mv-dsh-subworkspace.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const STORE_VERSION = 1;
export const EMPTY_STATE = Object.freeze({ version: STORE_VERSION, workspaces: {} });

export class SubworkspacePersistenceError extends Error {
  constructor(message = 'subworkspace settings are unavailable; associated workspace changes cannot be persisted') {
    super(message);
    this.name = 'SubworkspacePersistenceError';
    this.code = 'PERSISTENCE_UNAVAILABLE';
  }
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyState(value) {
  const source = plainObject(value);
  const workspaces = {};
  for (const [primary, entry] of Object.entries(plainObject(source.workspaces))) {
    const children = Array.isArray(entry?.children)
      ? entry.children
        .filter((child) => child && typeof child.id === 'string' && typeof child.path === 'string')
        .map((child) => ({
          id: child.id,
          path: child.path,
          label: typeof child.label === 'string' && child.label.length > 0
            ? child.label
            : path.basename(child.path),
        }))
      : [];
    // `enabled` defaults to true when no explicit flag is present (compatibility
    // with persisted sections written before the toggle existed). Explicit
    // `enabled: false` stays disabled; disabling never deletes configured
    // children. New primaries default to disabled, which is governed by the
    // schema default in settings.js (z.boolean().default(false)).
    workspaces[primary] = { enabled: entry?.enabled === false ? false : true, children };
  }
  return { version: STORE_VERSION, workspaces };
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathsOverlap(left, right) {
  const a = pathKey(left);
  const b = pathKey(right);
  if (a === b) return true;
  const relativeAB = path.relative(a, b);
  if (relativeAB !== '' && relativeAB !== '..' && !relativeAB.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeAB)) {
    return true;
  }
  const relativeBA = path.relative(b, a);
  return relativeBA !== '' && relativeBA !== '..' && !relativeBA.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeBA);
}

function primaryId(canonicalPath) {
  return `primary-${createHash('sha256').update(canonicalPath).digest('hex').slice(0, 24)}`;
}

async function inspectDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new Error('workspace path must be a non-empty string');
  }
  const absolute = path.resolve(candidate);
  const canonical = await fs.realpath(absolute);
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory()) throw new Error(`workspace path is not a directory: ${absolute}`);
  return {
    path: canonical,
    identity: `${String(stats.dev)}:${String(stats.ino)}`,
    label: path.basename(canonical) || canonical,
  };
}

function rootError(id, configuredPath, message) {
  return {
    id,
    path: configuredPath,
    label: path.basename(configuredPath) || configuredPath,
    primary: false,
    valid: false,
    error: message,
  };
}

export class SubworkspaceStore {
  constructor(options = {}) {
    this.inspectDirectory = options.inspectDirectory ?? inspectDirectory;
    this.uuid = options.uuid ?? randomUUID;
    this.current = copyState(options.initialState ?? EMPTY_STATE);
    this.scope = null;
    this.unwatch = null;
    this.listeners = new Set();
    // Associated roots persist in profile settings. A switched default belongs
    // only to the live Agent session and intentionally does not survive restart.
    this.sessions = new Map();
    this.mutationTail = Promise.resolve();
  }

  attach(scope) {
    this.unwatch?.();
    this.scope = scope ?? null;
    if (scope?.get) this.publish(scope.get());
    this.unwatch = scope?.watch?.((next) => { this.publish(next); }) ?? null;
    return () => {
      this.unwatch?.();
      this.unwatch = null;
      if (this.scope === scope) this.scope = null;
    };
  }

  publish(value) {
    this.current = copyState(value);
    for (const listener of this.listeners) listener(this.current);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return copyState(this.current);
  }

  async commit(next) {
    const normalized = copyState(next);
    if (typeof this.scope?.replace !== 'function') throw new SubworkspacePersistenceError();
    await this.scope.replace(normalized);
    this.publish(this.scope.get?.() ?? normalized);
  }

  mutate(operation) {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async canonicalPrimary(primaryPath) {
    return (await this.inspectDirectory(primaryPath)).path;
  }

  // The lookup only sees workspaces the store has copied state for: explicit
  // `enabled: false` stays disabled, legacy pre-toggle records that never
  // carried the flag resolve to enabled so those workspaces keep their
  // associated roots available. A primary that has no entry at all is treated
  // as disabled; the explicit entry creation in add() enforces the schema's
  // default (disabled) for genuinely new primaries, while this method only
  // reflects what already exists.
  isEnabled(primaryPath) {
    if (typeof primaryPath !== 'string' || primaryPath.length === 0) return false;
    const workspace = this.current.workspaces[primaryPath];
    if (!workspace) return false;
    return workspace.enabled === false ? false : true;
  }

  async setEnabled(primaryPath, enabled) {
    const flag = enabled === true;
    return this.mutate(async () => {
      const primary = await this.inspectDirectory(primaryPath);
      const next = this.snapshot();
      const entry = next.workspaces[primary.path] ?? { children: [] };
      next.workspaces[primary.path] = { ...entry, enabled: flag };
      await this.commit(next);
      return { primaryPath: primary.path, enabled: this.isEnabled(primary.path) };
    });
  }

  async resolveRoots(primaryPath) {
    const primary = await this.inspectDirectory(primaryPath);
    const state = this.snapshot();
    const entry = state.workspaces[primary.path];
    const configured = entry?.children ?? [];
    // No persisted entry: this primary has never been seen, so default the
    // toggle to off (opt-in). An existing entry honours its explicit
    // `enabled:false`; a legacy entry without the flag resolves to enabled
    // for back-compat with records persisted before the toggle existed.
    const enabled = !entry ? false : (entry.enabled === false ? false : true);
    const roots = [{
      id: primaryId(primary.path),
      path: primary.path,
      label: primary.label,
      identity: primary.identity,
      primary: true,
      valid: true,
    }];
    for (const child of configured) {
      let inspected;
      try {
        inspected = await this.inspectDirectory(child.path);
      } catch (error) {
        roots.push(rootError(child.id, child.path, error instanceof Error ? error.message : String(error)));
        continue;
      }
      const conflict = roots.find((root) => root.valid && (
        root.identity === inspected.identity || pathsOverlap(root.path, inspected.path)
      ));
      if (conflict) {
        roots.push(rootError(
          child.id,
          child.path,
          `workspace overlaps configured root ${conflict.id} (${conflict.path})`,
        ));
        continue;
      }
      roots.push({
        id: child.id,
        path: inspected.path,
        label: child.label || inspected.label,
        identity: inspected.identity,
        primary: false,
        valid: true,
      });
    }
    return { primaryPath: primary.path, enabled, roots };
  }

  async list(primaryPath, sessionId) {
    const resolved = await this.resolveRoots(primaryPath);
    const selection = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    const selected = selection?.primary === resolved.primaryPath
      && resolved.roots.some((root) => root.id === selection.activeId && root.valid)
      ? selection.activeId
      : resolved.roots[0].id;
    return { ...resolved, currentWorkspaceId: selected };
  }

  async add(primaryPath, candidatePath) {
    return this.mutate(async () => {
      const [primary, candidate] = await Promise.all([
        this.inspectDirectory(primaryPath),
        this.inspectDirectory(candidatePath),
      ]);
      const resolved = await this.resolveRoots(primary.path);
      for (const root of resolved.roots) {
        if (!root.valid) continue;
        if (root.identity === candidate.identity || pathsOverlap(root.path, candidate.path)) {
          throw new Error(`workspace overlaps existing root ${root.id} (${root.path})`);
        }
      }
      const next = this.snapshot();
      if (!next.workspaces[primary.path]) {
        // No persisted entry yet: create it explicitly disabled. This is the
        // one place a new primary's initial enabled state is decided; legacy
        // records that already exist (with or without a flag) are left as-is.
        next.workspaces[primary.path] = { enabled: false, children: [] };
      }
      const entry = next.workspaces[primary.path];
      const child = { id: this.uuid(), path: candidate.path, label: candidate.label };
      next.workspaces[primary.path] = { ...entry, children: [...entry.children, child] };
      await this.commit(next);
      return child;
    });
  }

  async remove(primaryPath, workspaceId) {
    return this.mutate(async () => {
      const primary = await this.inspectDirectory(primaryPath);
      if (workspaceId === primaryId(primary.path)) throw new Error('the primary workspace cannot be removed');
      const next = this.snapshot();
      const entry = next.workspaces[primary.path] ?? { children: [] };
      const filtered = entry.children.filter((child) => child.id !== workspaceId);
      if (filtered.length === entry.children.length) throw new Error(`unknown workspace ID: ${workspaceId}`);
      next.workspaces[primary.path] = { ...entry, children: filtered };
      await this.commit(next);
      for (const [sessionId, selection] of this.sessions) {
        if (selection.primary === primary.path && selection.activeId === workspaceId) this.sessions.delete(sessionId);
      }
    });
  }

  async switch(primaryPath, sessionId, workspaceId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('workspace switching requires a live session');
    return this.mutate(async () => {
      const resolved = await this.resolveRoots(primaryPath);
      const target = resolved.roots.find((root) => root.id === workspaceId);
      if (!target) throw new Error(`unknown workspace ID: ${workspaceId}`);
      if (!target.valid) throw new Error(target.error ?? `workspace ${workspaceId} is unavailable`);
      this.sessions.set(sessionId, { primary: resolved.primaryPath, activeId: workspaceId });
      return target;
    });
  }

  async reset(primaryPath, sessionId) {
    const resolved = await this.resolveRoots(primaryPath);
    await this.switch(resolved.primaryPath, sessionId, resolved.roots[0].id);
    return resolved.roots[0];
  }

  clearSession(sessionId) {
    if (typeof sessionId === 'string') this.sessions.delete(sessionId);
  }

  async select(primaryPath, sessionId, selector) {
    const listed = await this.list(primaryPath, sessionId);
    const byId = new Map(listed.roots.map((root) => [root.id, root]));
    if (selector === 'all') {
      return { batch: true, roots: listed.roots };
    }
    if (Array.isArray(selector)) {
      if (selector.length === 0) throw new Error('workspace arrays must contain at least one workspace ID');
      const seen = new Set();
      const roots = [];
      for (const id of selector) {
        if (seen.has(id)) continue;
        seen.add(id);
        roots.push(byId.get(id) ?? rootError(String(id), '', `unknown workspace ID: ${String(id)}`));
      }
      return { batch: true, roots };
    }
    const id = typeof selector === 'string' ? selector : listed.currentWorkspaceId;
    return {
      batch: false,
      roots: [byId.get(id) ?? rootError(String(id), '', `unknown workspace ID: ${String(id)}`)],
    };
  }
}

export function stablePrimaryId(canonicalPath) {
  return primaryId(canonicalPath);
}
