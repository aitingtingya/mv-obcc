// Skills Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { isMap, parseDocument } from 'yaml';

const WRITABLE_SOURCES = new Set(['user-dsh', 'user-agents', 'project-dsh', 'project-agents']);

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents');
}

function getSkillsService(ctx) {
  // DSH rc.7 contexts may be reflect proxies: reading an undeclared service as
  // `ctx.skills` can throw before optional chaining helps. `ctx.get()` is the
  // official dynamic lookup for a consumer that intentionally does not inject
  // the service at plugin-apply time.
  try {
    const service = ctx?.get?.('skills');
    if (service && typeof service.snapshot === 'function') return service;
  } catch {
    // Fall through to reflection for older Cordis access shapes.
  }
  try {
    const service = ctx?.reflect?.get?.('skills');
    if (service && typeof service.snapshot === 'function') return service;
  } catch {
    // No skill registry in this context.
  }
  return null;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function writableRootForSource(source, cwd) {
  switch (source) {
    case 'user-dsh': return path.join(dshHome(), 'skills');
    case 'user-agents': return path.join(agentsHome(), 'skills');
    case 'project-dsh': return path.join(cwd, '.dsh', 'skills');
    case 'project-agents': return path.join(cwd, '.agents', 'skills');
    default: return null;
  }
}

async function enrichSkill(service, summary, cwd) {
  const base = {
    id: summary.name,
    name: summary.name,
    description: summary.description || '',
    whenToUse: summary.whenToUse || '',
    modelInvocable: summary.invocation?.modelInvocable !== false,
    userInvocable: summary.invocation?.userInvocable !== false,
    source: summary.source || 'unknown',
    provider: summary.provider || 'unknown',
    resourceBase: summary.resourceBase,
    writable: false,
    filePath: null,
  };

  if (!WRITABLE_SOURCES.has(base.source) || base.provider !== 'filesystem' || typeof service.get !== 'function') {
    return base;
  }
  try {
    const definition = await service.get(summary.name, { cwd });
    const root = writableRootForSource(base.source, cwd);
    if (definition?.path && root && isWithin(root, definition.path)) {
      return { ...base, writable: true, filePath: definition.path };
    }
  } catch {
    // The catalog remains authoritative; failure to load a body only removes authoring affordances.
  }
  return base;
}

async function snapshotSkills(ctx, deps = {}) {
  const service = deps.skillsService || getSkillsService(ctx);
  if (!service) return { ok: false, error: 'DSH skills registry is not available in current context' };
  const cwd = path.resolve(deps.cwd || process.cwd());
  try {
    const snapshot = deps.snapshot
      ? await deps.snapshot({ cwd })
      : await service.snapshot({ cwd });
    const skills = [];
    for (const summary of snapshot?.skills || []) {
      skills.push(await enrichSkill(service, summary, cwd));
    }
    return { ok: true, skills, complete: snapshot?.complete !== false, cwd, service };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listSkills(ctx, deps = {}) {
  const result = await snapshotSkills(ctx, deps);
  if (!result.ok) return result;
  const { skills, complete, cwd } = result;
  return { ok: true, skills, complete, cwd };
}

function splitFrontmatter(raw) {
  const source = String(raw || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!match) return { document: parseDocument('{}\n'), body: source, eol: source.includes('\r\n') ? '\r\n' : '\n' };
  const document = parseDocument(match[1], { keepSourceTokens: true, prettyErrors: true, strict: false });
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) throw new Error('SKILL.md frontmatter must be a YAML mapping');
  return {
    document,
    body: source.slice(match[0].length),
    eol: source.includes('\r\n') ? '\r\n' : '\n',
  };
}

function renderFrontmatter(document, body, eol = '\n') {
  let header = String(document).trimEnd();
  let rendered = `---\n${header}\n---\n${body}`;
  if (eol === '\r\n') rendered = rendered.replace(/\n/gu, '\r\n');
  return rendered;
}

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.mv-dsh-manager-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, 'utf8');
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSkill(ctx, skillId, predicate, deps = {}) {
  const timeoutMs = deps.observeTimeoutMs ?? 5_000;
  const intervalMs = deps.observeIntervalMs ?? 50;
  const sleepFn = deps.sleep || sleep;
  const deadline = Date.now() + timeoutMs;
  do {
    const observed = await snapshotSkills(ctx, deps);
    if (observed.ok) {
      const skill = observed.skills.find((entry) => entry.id === skillId || entry.name === skillId);
      if (predicate(skill)) return skill || null;
    }
    if (Date.now() >= deadline) break;
    await sleepFn(intervalMs);
  } while (true);
  return null;
}

export async function toggleSkill(ctx, skillId, disabled, deps = {}) {
  const listed = await snapshotSkills(ctx, deps);
  if (!listed.ok) return listed;
  const target = listed.skills.find((entry) => entry.id === skillId || entry.name === skillId);
  if (!target) return { ok: false, error: `Skill "${skillId}" not found in the official DSH catalog` };
  if (!target.writable || !target.filePath) {
    return { ok: false, readOnly: true, error: `Skill "${target.name}" is owned by provider "${target.provider}" / source "${target.source}" and is read-only here` };
  }

  try {
    const raw = await fs.readFile(target.filePath, 'utf8');
    const { document, body, eol } = splitFrontmatter(raw);
    document.set('disable-model-invocation', Boolean(disabled));
    document.set('user-invocable', !Boolean(disabled));
    await atomicWrite(target.filePath, renderFrontmatter(document, body, eol));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const wantedDisabled = Boolean(disabled);
  const observed = await waitForSkill(
    ctx,
    target.id,
    (skill) => Boolean(skill)
      && skill.modelInvocable === !wantedDisabled
      && skill.userInvocable === !wantedDisabled,
    deps,
  );
  if (!observed) {
    return { ok: false, error: `SKILL.md was updated, but DSH did not observe the requested invocation policy for "${target.name}" before the verification timeout` };
  }
  return {
    ok: true,
    id: target.id,
    modelInvocable: observed.modelInvocable,
    userInvocable: observed.userInvocable,
    message: `Skill "${target.name}" invocation policy is now observed by DSH.`,
  };
}

/** Normalize a user-supplied skill name to DSH's public kebab-case grammar. */
export function normalizeSkillName(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/_+/gu, '-')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized) ? normalized : '';
}

export async function importSkill(ctx, name, description, content, deps = {}) {
  const cleanName = normalizeSkillName(name);
  if (!cleanName) {
    return { ok: false, error: '技能名称不合法：DSH 只接受小写 kebab-case，例如 "code-reviewer"' };
  }
  const listed = await snapshotSkills(ctx, deps);
  if (!listed.ok) return listed;
  if (listed.skills.some((skill) => skill.id === cleanName)) {
    return { ok: false, exists: true, error: `技能 "${cleanName}" 已存在于 DSH catalog；不会覆盖已有 provider winner` };
  }

  const root = path.join(dshHome(), 'skills');
  const targetDir = path.join(root, cleanName);
  const targetFile = path.join(targetDir, 'SKILL.md');
  try {
    await fs.access(targetDir);
    return { ok: false, exists: true, error: `目标目录已存在：${targetDir}` };
  } catch {
    // Good: authoring is create-only.
  }

  let body = content || `# ${cleanName}\n\nSkill instructions here.`;
  let document = parseDocument('{}\n');
  let eol = body.includes('\r\n') ? '\r\n' : '\n';
  try {
    if (body.startsWith('---')) {
      const parsed = splitFrontmatter(body);
      document = parsed.document;
      body = parsed.body;
      eol = parsed.eol;
    }
    if (!isMap(document.contents)) document.contents = document.createNode({});
    document.set('name', cleanName);
    document.set('description', String(description || cleanName));
    document.set('disable-model-invocation', false);
    document.set('user-invocable', true);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(targetDir, { recursive: false });
    await atomicWrite(targetFile, renderFrontmatter(document, body, eol));
  } catch (error) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const observed = await waitForSkill(ctx, cleanName, (skill) => Boolean(skill), deps);
  if (!observed) {
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, error: `Skill file was created, but DSH did not publish "${cleanName}" in its catalog; the manager-created directory was rolled back` };
  }
  return { ok: true, id: cleanName, name: cleanName, source: observed.source, provider: observed.provider, message: `Skill "${cleanName}" is now present in the DSH catalog.` };
}

export async function deleteSkill(ctx, skillId, deps = {}) {
  const listed = await snapshotSkills(ctx, deps);
  if (!listed.ok) return listed;
  const target = listed.skills.find((entry) => entry.id === skillId || entry.name === skillId);
  if (!target) return { ok: false, error: `Skill "${skillId}" not found in the official DSH catalog` };
  if (!target.writable || !target.filePath) {
    return { ok: false, readOnly: true, error: `Skill "${target.name}" is not owned by a writable filesystem root` };
  }

  const root = writableRootForSource(target.source, listed.cwd);
  if (!root || !isWithin(root, target.filePath)) return { ok: false, error: 'Refusing to delete a skill outside its official writable root' };
  const skillDir = path.dirname(target.filePath);
  try {
    if (path.basename(target.filePath).toLowerCase() === 'skill.md' && isWithin(root, skillDir)) {
      await fs.rm(skillDir, { recursive: true, force: true });
    } else {
      await fs.unlink(target.filePath);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const gone = await waitForSkill(ctx, target.id, (skill) => !skill, deps);
  // `waitForSkill` returns null both for success-by-absence and timeout, so do one authoritative final read.
  void gone;
  const final = await snapshotSkills(ctx, deps);
  if (!final.ok || final.skills.some((skill) => skill.id === target.id)) {
    return { ok: false, error: `Skill file was removed, but DSH still publishes "${target.name}" in its catalog` };
  }
  return { ok: true, id: target.id, message: `Skill "${target.name}" is no longer present in the DSH catalog.` };
}

export async function openSkillFolder(ctx, skillId, deps = {}) {
  let targetPath = path.join(dshHome(), 'skills');
  if (skillId) {
    const listed = await snapshotSkills(ctx, deps);
    if (!listed.ok) return listed;
    const target = listed.skills.find((entry) => entry.id === skillId || entry.name === skillId);
    if (!target?.filePath) return { ok: false, error: `Skill "${skillId}" has no local filesystem path` };
    targetPath = path.dirname(target.filePath);
  }
  await fs.mkdir(targetPath, { recursive: true });
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  spawn(opener, [targetPath], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: targetPath };
}
