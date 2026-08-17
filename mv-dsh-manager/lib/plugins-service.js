// Plugins Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function isProtectedPlugin(entryId) {
  if (!entryId) return false;
  return (
    entryId === 'mv-dsh-manager' ||
    entryId === 'mv-agent' ||
    entryId.includes('mv-dsh-manager') ||
    entryId.includes('mv-agent') ||
    entryId.startsWith('@deepseek-ai/') ||
    entryId.startsWith('cordis:')
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Strip scopes, version syntax, and file extensions to a stable loader row id. */
export function pluginIdFromSpec(spec) {
  let cleaned = String(spec || '')
    .replace(/^(?:file|link):/u, '')
    .split('#')[0]
    .split('?')[0];
  const lastAt = cleaned.lastIndexOf('@');
  if (lastAt > 0) cleaned = cleaned.slice(0, lastAt);
  cleaned = cleaned
    .split('/')
    .pop()
    .replace(/^@/u, '')
    .replace(/\.(?:js|mjs|cjs)$/u, '');
  const sanitized = cleaned.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'imported-plugin';
}

/** Resolve `file:`/`link:` URLs and local paths to a native path; registry specs return null. */
export function localPluginPath(spec, cwd = process.cwd()) {
  const clean = String(spec || '').trim();
  if (clean.length === 0) return null;

  if (clean.startsWith('file:')) {
    try {
      return fileURLToPath(new URL(clean));
    } catch {
      return null;
    }
  }
  if (clean.startsWith('link:')) {
    const remainder = clean.slice('link:'.length);
    return path.resolve(cwd, remainder);
  }
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return path.resolve(cwd, clean);
  }
  if (/^[A-Za-z]:[\\/]/u.test(clean) || clean.startsWith('/') || clean.startsWith('\\\\')) {
    return clean;
  }
  return null;
}

async function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) return null;
    return parsed;
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

/**
 * Run `dsh plugin --profile <profile> <args...>` as a child process.
 * The DSH web process exposes no direct pnpm bridge, so the canonical CLI
 * forwarder is the least surprising installer. Callers (tests) may inject
 * their own runner.
 */
export function runDshPlugin(args, { timeoutMs = 300_000, env = process.env, profile = 'web' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, code: null, error: `dsh plugin ${args[0] ?? ''} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const child = spawn('dsh', ['plugin', '--profile', profile, ...args], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
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

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function profileDir() {
  return path.join(dshHome(), 'profiles', 'web');
}

function patchFile() {
  return path.join(profileDir(), 'cordis.patch.yml');
}

function insertRowMatches(line, pluginId) {
  const id = pluginIdFromSpec(pluginId);
  const escaped = escapeRegExp(id);
  return new RegExp(`^\\s*-\\s+id:\\s*['"]?${escaped}['"]?\\s*(?:#.*)?$`, 'u').test(line);
}

/** Remove every insert row for `pluginId`, dropping an insert block that becomes empty. */
function stripInsertRows(content, pluginId) {
  const lines = content.split(/\r?\n/u);
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*-?\s*insert:\s*$/u.test(line)) {
      let j = i + 1;
      while (j < lines.length && /^\s/u.test(lines[j])) j += 1;
      const block = lines.slice(i + 1, j);
      const rows = [];
      for (let k = 0; k < block.length; k += 1) {
        if (insertRowMatches(block[k], pluginId)) {
          const indent = (block[k].match(/^\s*/u) || [''])[0].length;
          let next = k + 1;
          while (next < block.length) {
            const nextIndent = (block[next].match(/^\s*/u) || [''])[0].length;
            if (nextIndent <= indent) break;
            next += 1;
          }
          k = next - 1;
          continue;
        }
        rows.push(block[k]);
      }
      const hasRow = block.some((blockLine) => /^\s*-?\s*id:\s*/u.test(blockLine));
      const keptRows = hasRow ? rows : block;
      if (rows.length > 0) {
        kept.push(line, ...keptRows);
      }
      i = j - 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

async function appendPatchInsert(pluginId, name) {
  let raw = '';
  try {
    raw = await fs.readFile(patchFile(), 'utf8');
  } catch {
    raw = '[]\n';
  }
  let stripped = stripInsertRows(raw, pluginId).trimEnd();
  if (stripped.trim() === '[]') stripped = '';
  const block = `- insert:\n    - id: ${pluginId}\n      name: ${yamlSingleQuote(name)}\n`;
  await fs.mkdir(profileDir(), { recursive: true });
  await fs.writeFile(patchFile(), `${stripped}${stripped ? '\n\n' : ''}${block}`, 'utf8');
}

export function listPlugins(ctx) {
  if (!ctx.loader || !ctx.loader.entries) {
    return { ok: false, error: 'Cordis loader not available in current context' };
  }

  const entries = [];
  try {
    for (const entry of ctx.loader.entries()) {
      if (!entry) continue;
      const id = entry.id || (entry.options && entry.options.id);
      if (!id) continue;

      const fiber = entry.fiber;
      let fiberPhase = null;
      if (fiber && fiber.state !== undefined) {
        fiberPhase = fiber.state;
      }

      entries.push({
        id: id,
        name: (entry.options && entry.options.name) || id,
        enabled: !entry.disabled,
        isProtected: isProtectedPlugin(id),
        fiberPhase: fiberPhase !== null ? fiberPhase : (entry.disabled ? 0 : 2),
      });
    }
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function togglePlugin(ctx, entryId, disabled) {
  if (!ctx.loader || !ctx.loader.entries) {
    return { ok: false, error: 'Cordis loader not available' };
  }

  try {
    let targetEntry = null;
    let actualId = entryId;

    for (const entry of ctx.loader.entries()) {
      if (!entry) continue;
      const id = entry.id || (entry.options && entry.options.id);
      const name = (entry.options && entry.options.name);
      if (id === entryId || name === entryId) {
        targetEntry = entry;
        actualId = id;
        break;
      }
    }

    if (!targetEntry) {
      return { ok: false, error: `Plugin entry "${entryId}" not found` };
    }

    if (typeof ctx.loader.update === 'function') {
      await ctx.loader.update(actualId, { disabled: Boolean(disabled) });
      return {
        ok: true,
        id: actualId,
        enabled: !disabled,
        message: `Plugin "${entryId}" has been ${disabled ? 'disabled' : 'enabled'}`
      };
    } else {
      return { ok: false, error: 'ctx.loader.update is not supported in this runtime' };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function removablePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name.startsWith('cordis:') || name.startsWith('@deepseek-ai/')) return null;
  if (name.startsWith('file:') || name.startsWith('link:') || name.startsWith('.')) return null;
  if (/^[A-Za-z]:[\\/]/u.test(name) || name.startsWith('/') || name.startsWith('\\\\')) return null;
  if (name.includes('/') && !name.startsWith('@')) return null;
  return name;
}

export async function deletePlugin(ctx, entryId, force = false, deps = {}) {
  if (!entryId) {
    return { ok: false, error: 'entryId is required' };
  }

  const isProtected = isProtectedPlugin(entryId);
  if (isProtected && !force) {
    return {
      ok: false,
      isProtected: true,
      error: `警告：插件 "${entryId}" 属于系统核心或管理器插件，删除可能导致相关功能失效。请在确认框中选择强制删除。`
    };
  }

  const runPluginRemove = deps.runPluginRemove || ((args) => runDshPlugin(args));

  // 1. Capture the package specifier before the loader row disappears.
  let packageName = null;
  if (ctx.loader && typeof ctx.loader.entries === 'function') {
    for (const entry of ctx.loader.entries()) {
      if (!entry) continue;
      const id = entry.id || (entry.options && entry.options.id);
      const name = (entry.options && entry.options.name);
      if (id === entryId || name === entryId) {
        packageName = removablePackageName(name);
        break;
      }
    }
  }

  try {
    // 2. Disable or remove in loader
    if (ctx.loader) {
      try {
        if (typeof ctx.loader.remove === 'function') {
          await ctx.loader.remove(entryId);
        } else if (typeof ctx.loader.update === 'function') {
          await ctx.loader.update(entryId, { disabled: true });
        }
      } catch {
        // Ignore loader errors
      }
    }

    // 3. Remove from cordis.patch.yml if present
    let patchRemoved = false;
    try {
      const raw = await fs.readFile(patchFile(), 'utf8');
      const stripped = stripInsertRows(raw, entryId);
      if (stripped !== raw) patchRemoved = true;
      await fs.writeFile(patchFile(), stripped, 'utf8');
    } catch {
      // Patch file not present or error
    }

    // 4. Remove the installed package from the profile node_modules as well.
    let removalDetail = '';
    if (packageName) {
      const result = await runPluginRemove(['remove', packageName]);
      if (!result.ok) {
        removalDetail = `；包 ${packageName} 从 profile 依赖移除失败：${result.error || result.stderr || ''}`;
      } else {
        removalDetail = `；包 ${packageName} 已从 profile 依赖移除`;
      }
    }

    return {
      ok: true,
      id: entryId,
      patchRemoved,
      packageName,
      message: `插件 "${entryId}" 已成功删除/卸载${removalDetail}。`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importPlugin(ctx, spec, deps = {}) {
  if (!spec || !spec.trim()) {
    return { ok: false, error: 'Plugin specification or path is required' };
  }

  const cleanSpec = spec.trim();
  const runPluginAdd = deps.runPluginAdd || ((args) => runDshPlugin(args));
  const cwd = deps.cwd || process.cwd();

  try {
    const local = localPluginPath(cleanSpec, cwd);
    let packageName = cleanSpec;
    let pluginId = pluginIdFromSpec(cleanSpec);
    let patchName = cleanSpec;
    let warning;
    let installedPath;

    if (local) {
      const kind = await pathKind(local);
      if (kind === 'directory') {
        const packageJson = await readPackageJson(local);
        if (packageJson) {
          packageName = packageJson.name;
          pluginId = pluginIdFromSpec(packageName);
        }

        const dshSpec = `file:${local.replace(/\\/gu, '/')}`;
        const added = await runPluginAdd(['add', dshSpec]);
        if (added.ok) {
          patchName = packageName;
          installedPath = path.join(profileDir(), 'node_modules', packageName);
        } else {
          const entry = packageJson?.main || 'lib/index.js';
          patchName = pathToFileURL(path.join(local, entry)).href;
          installedPath = local;
          warning = `dsh plugin add 失败（${added.error || added.stderr || '未知错误'}），已回退为 file: 热加载注册`;
        }
      } else if (kind === 'file') {
        patchName = pathToFileURL(local).href;
        installedPath = local;
        pluginId = pluginIdFromSpec(local);
        warning = '本地文件直接以 file: 热加载注册，未安装到 profile node_modules';
      } else {
        return { ok: false, error: `本地插件路径不存在：${local}` };
      }
    } else {
      pluginId = pluginIdFromSpec(cleanSpec);
      const added = await runPluginAdd(['add', cleanSpec]);
      if (!added.ok) {
        return {
          ok: false,
          error: `插件 "${cleanSpec}" 安装失败：${added.error || added.stdout || added.stderr || '未知错误'}`,
        };
      }
      packageName = cleanSpec;
      patchName = cleanSpec;
      installedPath = path.join(profileDir(), 'node_modules', packageName);
    }

    await appendPatchInsert(pluginId, patchName);
    return {
      ok: true,
      id: pluginId,
      name: packageName,
      installedPath,
      warning,
      message: warning
        ? `插件 "${packageName}" 已导入，但 ${warning}。`
        : `插件 "${packageName}" 已安装到 profile 插件目录并写入 cordis.patch.yml。`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openPluginFolder(pluginId) {
  const targetDir = pluginId
    ? path.join(profileDir(), 'node_modules', pluginId)
    : path.join(profileDir(), 'node_modules');

  await fs.mkdir(targetDir, { recursive: true });

  const platform = os.platform();
  if (platform === 'darwin') {
    spawn('open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'win32') {
    spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [targetDir], { detached: true, stdio: 'ignore' }).unref();
  }

  return { ok: true, path: targetDir };
}
