// Plugins Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { persistPluginDisabled, persistPluginRemoval } from './plugin-toggle-state.js';

const INJECTION_MANAGED_PACKAGES = new Map([
  ['mv-agent', { packageName: '@mv-aide/mv-agent', pathSegments: ['@mv-aide', 'mv-agent'] }],
  ['mv-dsh-manager', { packageName: '@mv-aide/mv-dsh-manager', pathSegments: ['@mv-aide', 'mv-dsh-manager'] }],
]);
const INJECTION_MANAGED_IDS = new Set(INJECTION_MANAGED_PACKAGES.keys());

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function profileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}

function profileManifestFile() {
  return path.join(profileDir(), 'package.json');
}

function injectionManagedPackage(configRowId) {
  return INJECTION_MANAGED_PACKAGES.get(String(configRowId || '')) || null;
}

function installedInjectionPackageDir(managedPackage) {
  return path.join(profileDir(), 'node_modules', ...managedPackage.pathSegments);
}

async function readProfileManifest() {
  try {
    return JSON.parse(await fs.readFile(profileManifestFile(), 'utf8'));
  } catch {
    return {};
  }
}

function runtimeEntryId(entry) {
  return entry?.id || entry?.options?.id || null;
}

export function configRowIdFromRuntimeId(entryId) {
  const id = String(entryId || '');
  return id.startsWith('include:') ? id.slice('include:'.length) : id;
}

function pluginName(entry) {
  return entry?.options?.name || runtimeEntryId(entry) || '';
}

function isCorePlugin(entry) {
  const runtimeId = runtimeEntryId(entry) || '';
  const configRowId = configRowIdFromRuntimeId(runtimeId);
  const name = pluginName(entry);
  return INJECTION_MANAGED_IDS.has(configRowId)
    || runtimeId.startsWith('cordis:')
    || configRowId.startsWith('cordis:')
    || name.startsWith('@deepseek-ai/');
}

function removablePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.startsWith('cordis:') || name.startsWith('@deepseek-ai/')) return null;
  if (name.startsWith('file:') || name.startsWith('link:') || name.startsWith('.')) return null;
  if (/^[A-Za-z]:[\\/]/u.test(name) || name.startsWith('/') || name.startsWith('\\\\')) return null;
  if (name.includes('/') && !name.startsWith('@')) return null;
  return name;
}

function sourceKind(entry) {
  const configRowId = configRowIdFromRuntimeId(runtimeEntryId(entry));
  if (INJECTION_MANAGED_IDS.has(configRowId)) return 'injection-managed';
  if (isCorePlugin(entry)) return 'core';
  if (removablePackageName(pluginName(entry))) return 'package';
  return 'runtime';
}

function entryView(entry) {
  const runtimeId = runtimeEntryId(entry);
  if (!runtimeId) return null;
  const configRowId = configRowIdFromRuntimeId(runtimeId);
  const name = pluginName(entry);
  const kind = sourceKind(entry);
  const packageName = kind === 'package' ? removablePackageName(name) : null;
  const fiber = entry?.fiber;
  const fiberPhase = fiber?.state !== undefined ? fiber.state : (entry?.disabled ? 0 : 2);
  return {
    id: runtimeId,
    runtimeEntryId: runtimeId,
    configRowId,
    name,
    enabled: !entry?.disabled,
    sourceKind: kind,
    packageName,
    // Product contract: every visible Loader entry keeps an uninstall/remove
    // affordance. Source kind chooses the adapter; protection only changes the
    // confirmation level, never whether the button exists.
    canUninstall: true,
    uninstallMode: kind === 'package' ? 'package' : kind === 'injection-managed' ? 'injection' : 'entry',
    isProtected: kind === 'core' || kind === 'injection-managed',
    requiresFrontendReload: configRowId === 'mv-agent',
    fiberPhase,
  };
}

function findPluginEntry(ctx, reference) {
  if (!ctx?.loader || typeof ctx.loader.entries !== 'function') return null;
  const wanted = String(reference || '');
  for (const entry of ctx.loader.entries()) {
    const view = entryView(entry);
    if (!view) continue;
    if (
      view.runtimeEntryId === wanted
      || view.configRowId === wanted
      || view.name === wanted
      || view.packageName === wanted
    ) return { entry, view };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPluginState(ctx, configRowId, disabled, deps = {}) {
  const timeoutMs = deps.observeTimeoutMs ?? 5_000;
  const intervalMs = deps.observeIntervalMs ?? 50;
  const sleepFn = deps.sleep || sleep;
  const deadline = Date.now() + timeoutMs;
  do {
    const found = findPluginEntry(ctx, configRowId);
    if (found && Boolean(found.entry.disabled) === Boolean(disabled)) return found.view;
    if (Date.now() >= deadline) break;
    await sleepFn(intervalMs);
  } while (true);
  return null;
}

/** Strip scopes, version syntax, and file extensions to a stable display id. */
export function pluginIdFromSpec(spec) {
  let cleaned = String(spec || '')
    .replace(/^(?:file|link):/u, '')
    .split('#')[0]
    .split('?')[0];
  const lastAt = cleaned.lastIndexOf('@');
  if (lastAt > 0) cleaned = cleaned.slice(0, lastAt);
  cleaned = cleaned
    .split(/[\\/]/u)
    .pop()
    .replace(/^@/u, '')
    .replace(/\.(?:js|mjs|cjs|tgz)$/u, '');
  const sanitized = cleaned.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized || 'imported-plugin';
}

/** Resolve `file:`/`link:` URLs and local paths to a native path; registry specs return null. */
export function localPluginPath(spec, cwd = process.cwd()) {
  const clean = String(spec || '').trim();
  if (clean.length === 0) return null;

  if (clean.startsWith('file:')) {
    try {
      const value = fileURLToPath(new URL(clean));
      if (/^\/[A-Za-z]:\//u.test(value)) return path.win32.normalize(value.slice(1));
      return value;
    } catch {
      const windows = /^file:\/?([A-Za-z]:[\\/].*)$/u.exec(clean);
      return windows ? path.win32.normalize(windows[1]) : null;
    }
  }
  if (clean.startsWith('link:')) {
    return path.resolve(cwd, clean.slice('link:'.length));
  }
  if (clean.startsWith('./') || clean.startsWith('../')) return path.resolve(cwd, clean);
  if (/^[A-Za-z]:[\\/]/u.test(clean) || clean.startsWith('/') || clean.startsWith('\\\\')) return clean;
  return null;
}

async function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function pathKind(filePath) {
  try {
    const info = await fs.stat(filePath);
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/** Run `dsh plugin --profile <profile> <args...>` as the canonical package lifecycle seam. */
export function runDshPlugin(args, { timeoutMs = 300_000, env = process.env, profile = 'web' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn('dsh', ['plugin', '--profile', profile, ...args], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, code: null, error: `dsh plugin ${args[0] ?? ''} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, error: error.message, stdout, stderr });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr, error: code === 0 ? undefined : `exit code ${code}` });
    });
  });
}

export function listPlugins(ctx) {
  if (!ctx?.loader || typeof ctx.loader.entries !== 'function') {
    return { ok: false, error: 'Cordis loader not available in current context' };
  }
  try {
    const entries = [];
    for (const entry of ctx.loader.entries()) {
      const view = entryView(entry);
      if (view) entries.push(view);
    }
    return { ok: true, entries };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function togglePlugin(ctx, entryId, disabled, deps = {}) {
  const found = findPluginEntry(ctx, entryId);
  if (!found) return { ok: false, error: `Plugin entry "${entryId}" not found` };

  const nextDisabled = Boolean(disabled);
  const persist = deps.persistDisabled || persistPluginDisabled;
  try {
    await persist(found.view.configRowId, nextDisabled);
  } catch (error) {
    return { ok: false, error: `Failed to persist plugin state: ${error instanceof Error ? error.message : String(error)}` };
  }

  const observed = deps.waitForObservedState
    ? await deps.waitForObservedState(found.view.configRowId, nextDisabled)
    : await waitForPluginState(ctx, found.view.configRowId, nextDisabled, deps);
  if (!observed) {
    return {
      ok: false,
      persistent: true,
      id: found.view.runtimeEntryId,
      configRowId: found.view.configRowId,
      error: `Persistent patch was updated, but DSH did not observe plugin "${found.view.configRowId}" as ${nextDisabled ? 'disabled' : 'enabled'} before the verification timeout`,
    };
  }

  return {
    ok: true,
    id: observed.runtimeEntryId || found.view.runtimeEntryId,
    runtimeEntryId: observed.runtimeEntryId || found.view.runtimeEntryId,
    configRowId: found.view.configRowId,
    enabled: !nextDisabled,
    persistent: true,
    requiresFrontendReload: found.view.requiresFrontendReload === true,
    message: `Plugin "${found.view.configRowId}" is now observed as ${nextDisabled ? 'disabled' : 'enabled'} by DSH.`,
  };
}

function manifestPluginState(manifest, packageName) {
  const dependencies = manifest?.dependencies || {};
  const bundles = manifest?.dsh?.profile?.bundles || [];
  return {
    installed: Object.prototype.hasOwnProperty.call(dependencies, packageName),
    bundled: Array.isArray(bundles) && bundles.includes(packageName),
  };
}

function packageNameFromRegistrySpec(spec) {
  const clean = String(spec || '').trim();
  if (clean.startsWith('@')) {
    const slash = clean.indexOf('/');
    if (slash < 0) return null;
    const versionAt = clean.indexOf('@', slash + 1);
    return versionAt < 0 ? clean : clean.slice(0, versionAt);
  }
  if (/^[a-zA-Z0-9._-]+(?:@[^/]+)?$/u.test(clean)) return clean.split('@')[0];
  return null;
}

export async function importPlugin(ctx, spec, deps = {}) {
  if (!spec || !String(spec).trim()) return { ok: false, error: 'Plugin specification or path is required' };

  const cleanSpec = String(spec).trim();
  const cwd = deps.cwd || process.cwd();
  const local = localPluginPath(cleanSpec, cwd);
  let packageName = packageNameFromRegistrySpec(cleanSpec);
  let dshSpec = cleanSpec;

  if (local) {
    const kind = await pathKind(local);
    if (!kind) return { ok: false, error: `本地插件路径不存在：${local}` };
    if (kind === 'directory') {
      const packageJson = await readPackageJson(local);
      if (!packageJson) return { ok: false, error: `本地插件目录缺少有效 package.json name：${local}` };
      packageName = packageJson.name;
    }
    dshSpec = `file:${local.replace(/\\/gu, '/')}`;
  }

  const runPluginAdd = deps.runPluginAdd || ((args) => runDshPlugin(args));
  const readManifest = deps.readProfileManifest || readProfileManifest;
  const before = await readManifest();
  const result = await runPluginAdd(['add', dshSpec]);
  if (!result.ok) {
    return { ok: false, error: `插件 "${cleanSpec}" 安装失败：${result.error || result.stderr || result.stdout || '未知错误'}` };
  }

  const after = await readManifest();
  if (!packageName) {
    const beforeDeps = new Set(Object.keys(before?.dependencies || {}));
    packageName = Object.keys(after?.dependencies || {}).find((name) => !beforeDeps.has(name)) || null;
  }
  if (!packageName) {
    return { ok: false, error: 'dsh plugin add succeeded, but the installed package could not be identified from the profile manifest' };
  }

  const state = manifestPluginState(after, packageName);
  if (!state.installed) {
    return { ok: false, error: `dsh plugin add returned success, but profile manifest does not contain dependency "${packageName}"` };
  }

  const observed = findPluginEntry(ctx, packageName)?.view || null;
  return {
    ok: true,
    id: observed?.configRowId || pluginIdFromSpec(packageName),
    name: packageName,
    installed: true,
    bundled: state.bundled,
    active: Boolean(observed),
    warning: state.bundled && !observed
      ? '插件 bundle 已由 DSH 写入 profile，但当前 Loader 尚未观察到该行；不要额外写入 cordis.patch.yml，必要时按 DSH 生命周期重启后加载。'
      : !state.bundled
        ? '该依赖未声明 dsh.bundle，DSH 已按普通 profile dependency 安装，不会作为插件层注册。'
        : undefined,
    message: `插件 "${packageName}" 已通过 dsh plugin 写入 profile 官方状态。`,
  };
}

export async function deletePlugin(ctx, entryId, force = false, deps = {}) {
  const found = findPluginEntry(ctx, entryId);
  if (!found) return { ok: false, error: `Plugin entry "${entryId}" not found` };
  if (found.view.isProtected && !force) {
    return {
      ok: false,
      requiresForce: true,
      isProtected: true,
      error: `插件 "${found.view.configRowId}" 属于官方/核心或 mv-AIDE 管理组件，卸载前必须经过高危确认。`,
    };
  }

  const persistRemoval = deps.persistRemoval || persistPluginRemoval;

  if (found.view.sourceKind === 'injection-managed') {
    // mv-agent / mv-dsh-manager are materialized by mv-AIDE itself rather than
    // declared as profile dependencies. Their uninstall lifecycle is therefore
    // user-patch registration removal + removal of the materialized package.
    const managedPackage = injectionManagedPackage(found.view.configRowId);
    if (!managedPackage) {
      return { ok: false, error: `未知的 mv-AIDE 注入组件 "${found.view.configRowId}"，拒绝删除 materialized package。` };
    }
    let patchResult;
    try {
      patchResult = await persistRemoval(found.view.configRowId);
      if (!patchResult || patchResult.removed < 1) {
        return { ok: false, error: `未在 DSH 用户 patch 中找到注入行 "${found.view.configRowId}"，拒绝伪报卸载成功。` };
      }
      const removeInjectedPackage = deps.removeInjectedPackage || (async () => {
        await fs.rm(installedInjectionPackageDir(managedPackage), { recursive: true, force: true });
      });
      await removeInjectedPackage(managedPackage.packageName);
    } catch (error) {
      return { ok: false, error: `插件 "${found.view.configRowId}" 注入卸载失败：${error instanceof Error ? error.message : String(error)}` };
    }
    return {
      ok: true,
      id: found.view.configRowId,
      packageName: managedPackage.packageName,
      installed: false,
      active: Boolean(findPluginEntry(ctx, entryId)),
      requiresFrontendReload: true,
      message: `插件 "${found.view.configRowId}" 已从 mv-AIDE 注入 patch 与 materialized package 中移除。`,
    };
  }

  if (found.view.sourceKind === 'package' && found.view.packageName) {
    const packageName = found.view.packageName;
    const runPluginRemove = deps.runPluginRemove || ((args) => runDshPlugin(args));
    const readManifest = deps.readProfileManifest || readProfileManifest;
    const result = await runPluginRemove(['remove', packageName]);
    if (!result.ok) {
      return { ok: false, error: `插件 "${packageName}" 卸载失败：${result.error || result.stderr || result.stdout || '未知错误'}` };
    }

    const after = await readManifest();
    const state = manifestPluginState(after, packageName);
    if (state.installed || state.bundled) {
      return { ok: false, error: `dsh plugin remove returned success, but profile manifest still references "${packageName}"` };
    }
    await persistRemoval(found.view.configRowId).catch(() => undefined);
    const stillRuntime = Boolean(findPluginEntry(ctx, entryId));
    return {
      ok: true,
      id: found.view.configRowId,
      packageName,
      installed: false,
      active: stillRuntime,
      warning: stillRuntime
        ? '官方 profile 状态已移除该 package，但当前 Loader 仍保留旧实例；等待 DSH 生命周期刷新或重启。'
        : undefined,
      message: `插件 "${packageName}" 已通过 dsh plugin 从 profile 官方状态移除。`,
    };
  }

  // User-inserted runtime rows can be removed from the user patch outright.
  // Bundle-owned/core rows have no deletion primitive in DSH's overlay grammar;
  // after the explicit high-risk confirmation, persist a disabled override so
  // the entry is functionally removed and stays removed across restart.
  try {
    const patchResult = await persistRemoval(found.view.configRowId);
    if (patchResult?.removed > 0) {
      return {
        ok: true,
        id: found.view.configRowId,
        installed: false,
        active: Boolean(findPluginEntry(ctx, entryId)),
        message: `插件 "${found.view.configRowId}" 的用户层 Loader 注册已移除。`,
      };
    }
    const persistDisabled = deps.persistDisabled || persistPluginDisabled;
    await persistDisabled(found.view.configRowId, true);
    const observed = deps.waitForObservedState
      ? await deps.waitForObservedState(found.view.configRowId, true)
      : await waitForPluginState(ctx, found.view.configRowId, true, deps);
    if (!observed) {
      return { ok: false, persistent: true, error: `已写入高危移除覆盖，但 DSH 未在超时前观察到 "${found.view.configRowId}" 停用。` };
    }
    return {
      ok: true,
      id: found.view.configRowId,
      installed: false,
      active: true,
      disabledFallback: true,
      warning: '该条目由更低层的 DSH bundle 提供，用户 patch 没有“删除下层行”的语法；已写入持久 disabled 覆盖，因此运行效果等同移除，但条目仍会以停用状态显示。',
      message: `插件 "${found.view.configRowId}" 已通过持久 disabled 覆盖移出运行态。`,
    };
  } catch (error) {
    return { ok: false, error: `插件 "${found.view.configRowId}" 卸载失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function openPluginFolder(pluginId) {
  const targetDir = pluginId
    ? path.join(profileDir(), 'node_modules', pluginId)
    : path.join(profileDir(), 'node_modules');
  await fs.mkdir(targetDir, { recursive: true });
  const platform = os.platform();
  if (platform === 'darwin') spawn('open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  else if (platform === 'win32') spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: targetDir };
}
