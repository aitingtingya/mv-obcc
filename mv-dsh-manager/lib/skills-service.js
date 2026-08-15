// Skills Service for @mv-aide/mv-dsh-manager
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) {
    return { metadata: {}, body: raw };
  }
  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { metadata: {}, body: raw };
  }
  const header = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();
  const metadata = {};

  const lines = header.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else if (val === 'true') {
        val = true;
      } else if (val === 'false') {
        val = false;
      }
      metadata[key] = val;
    }
  }
  return { metadata, body };
}

function stringifyFrontmatter(metadata, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(metadata)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}

export async function listSkills() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const userSkillsDir = path.join(dshHome, 'skills');

  const skills = [];

  async function scanDir(dirPath, scope) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;

        if (ent.isDirectory()) {
          const skillDir = path.join(dirPath, ent.name);
          const skillMdPath = path.join(skillDir, 'SKILL.md');
          const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

          let filePath = null;
          let isEnabled = true;

          try {
            await fs.access(skillMdPath);
            filePath = skillMdPath;
          } catch {
            try {
              await fs.access(skillMdDisabledPath);
              filePath = skillMdDisabledPath;
              isEnabled = false;
            } catch {
              // No SKILL.md
            }
          }

          if (filePath) {
            try {
              const raw = await fs.readFile(filePath, 'utf-8');
              const { metadata, body } = parseFrontmatter(raw);
              const disabledByMeta = metadata['disable-model-invocation'] === true && metadata['user-invocable'] === false;
              if (disabledByMeta) isEnabled = false;

              skills.push({
                id: metadata.name || ent.name,
                name: metadata.name || ent.name,
                description: metadata.description || '',
                scope: scope,
                enabled: isEnabled,
                userInvocable: metadata['user-invocable'] !== false,
                modelInvocable: metadata['disable-model-invocation'] !== true,
                path: skillDir,
                filePath: filePath,
              });
            } catch (err) {
              console.warn(`[mv-dsh-manager] Failed to read skill at ${filePath}:`, err);
            }
          }
        } else if (ent.isFile() && (ent.name.endsWith('.md') || ent.name.endsWith('.md.disabled'))) {
          const isEnabled = !ent.name.endsWith('.disabled');
          const baseName = ent.name.replace(/\.disabled$/, '').replace(/\.md$/, '');
          const filePath = path.join(dirPath, ent.name);

          try {
            const raw = await fs.readFile(filePath, 'utf-8');
            const { metadata, body } = parseFrontmatter(raw);
            const disabledByMeta = metadata['disable-model-invocation'] === true && metadata['user-invocable'] === false;

            skills.push({
              id: metadata.name || baseName,
              name: metadata.name || baseName,
              description: metadata.description || '',
              scope: scope,
              enabled: isEnabled && !disabledByMeta,
              userInvocable: metadata['user-invocable'] !== false,
              modelInvocable: metadata['disable-model-invocation'] !== true,
              path: filePath,
              filePath: filePath,
            });
          } catch (err) {
            console.warn(`[mv-dsh-manager] Failed to read flat skill at ${filePath}:`, err);
          }
        }
      }
    } catch {
      // Directory doesn't exist yet, ignore
    }
  }

  // 1. Scan User Skills (~/.dsh/skills)
  await scanDir(userSkillsDir, 'user');

  // 2. Scan Project Skills (./.dsh/skills)
  const projectSkillsDir = path.join(process.cwd(), '.dsh', 'skills');
  if (projectSkillsDir !== userSkillsDir) {
    await scanDir(projectSkillsDir, 'project');
  }

  return { ok: true, skills };
}

export async function toggleSkill(skillId, disabled) {
  const { skills } = await listSkills();
  const target = skills.find((s) => s.id === skillId || s.name === skillId);
  if (!target) {
    return { ok: false, error: `Skill "${skillId}" not found` };
  }

  try {
    const raw = await fs.readFile(target.filePath, 'utf-8');
    const { metadata, body } = parseFrontmatter(raw);

    if (disabled) {
      metadata['disable-model-invocation'] = true;
      metadata['user-invocable'] = false;
    } else {
      metadata['disable-model-invocation'] = false;
      metadata['user-invocable'] = true;
    }

    const updated = stringifyFrontmatter(metadata, body);
    await fs.writeFile(target.filePath, updated, 'utf-8');

    return {
      ok: true,
      id: target.id,
      enabled: !disabled,
      message: `Skill "${target.name}" has been ${disabled ? 'disabled' : 'enabled'}`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function importSkill(name, description, content) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Skill name is required' };
  }
  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!cleanName) {
    return { ok: false, error: 'Invalid skill name' };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const targetDir = path.join(dshHome, 'skills', cleanName);
  const targetFile = path.join(targetDir, 'SKILL.md');

  try {
    await fs.mkdir(targetDir, { recursive: true });

    let bodyText = content || `# ${cleanName}\n\nSkill instructions here.`;
    let metadata = {
      name: cleanName,
      description: description || cleanName,
      'disable-model-invocation': false,
      'user-invocable': true,
    };

    if (bodyText.startsWith('---')) {
      const parsed = parseFrontmatter(bodyText);
      metadata = { ...metadata, ...parsed.metadata };
      bodyText = parsed.body;
    }

    const finalContent = stringifyFrontmatter(metadata, bodyText);
    await fs.writeFile(targetFile, finalContent, 'utf-8');

    return {
      ok: true,
      id: cleanName,
      name: cleanName,
      path: targetDir,
      message: `Skill "${cleanName}" imported successfully`
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteSkill(skillId) {
  const { skills } = await listSkills();
  const target = skills.find((s) => s.id === skillId || s.name === skillId);
  if (!target) {
    return { ok: false, error: `Skill "${skillId}" not found` };
  }

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const userSkillsDir = path.join(dshHome, 'skills');

  // 安全检查：仅允许删除用户全局目录或项目目录下的技能
  const targetPath = path.resolve(target.path);
  const allowedUser = path.resolve(userSkillsDir);
  const allowedProj = path.resolve(process.cwd(), '.dsh', 'skills');

  if (!targetPath.startsWith(allowedUser) && !targetPath.startsWith(allowedProj)) {
    return { ok: false, error: 'Cannot delete system or built-in skills' };
  }

  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.unlink(targetPath);
    }
    return { ok: true, id: target.id, message: `Skill "${target.name}" deleted successfully` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function openSkillFolder(skillId) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  let targetPath = path.join(dshHome, 'skills');

  if (skillId) {
    const { skills } = await listSkills();
    const target = skills.find((s) => s.id === skillId || s.name === skillId);
    if (target) {
      targetPath = target.path;
    }
  }

  try {
    await fs.mkdir(targetPath, { recursive: true });
    const opener = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open';
    spawn(opener, [targetPath], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
