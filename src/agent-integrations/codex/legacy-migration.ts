import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexConfigPath } from "./paths";
import { removeCodexMcpRegistration } from "./mcp-registration";

const ALIAS_MANAGED_BEGIN = "# BEGIN mv-aide managed Codex environment";
const ALIAS_MANAGED_END = "# END mv-aide managed Codex environment";
const LEGACY_ALIAS_MANAGED_BEGIN = "# BEGIN mv-obcc managed Codex environment";
const LEGACY_ALIAS_MANAGED_END = "# END mv-obcc managed Codex environment";

function stripMarkedBlock(content: string, begin: string, end: string): string {
  const start = content.indexOf(begin);
  if (start < 0) return content;
  const endIndex = content.indexOf(end, start);
  if (endIndex < 0) return content;
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "");
}

function stripLegacyAliasBlocks(content: string): string {
  const current = stripMarkedBlock(content, ALIAS_MANAGED_BEGIN, ALIAS_MANAGED_END);
  return stripMarkedBlock(current, LEGACY_ALIAS_MANAGED_BEGIN, LEGACY_ALIAS_MANAGED_END);
}

export async function removeLegacyCodexShellAlias(): Promise<void> {
  const home = os.homedir();
  for (const target of [
    path.join(home, ".zshrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".bashrc"),
  ]) {
    if (!fs.existsSync(target)) continue;
    try {
      const current = fs.readFileSync(target, "utf8");
      const next = stripLegacyAliasBlocks(current);
      if (next !== current) fs.writeFileSync(target, `${next.trimEnd()}\n`, "utf8");
    } catch (error) {
      console.warn(`[mv-aide] Failed to clean legacy Codex shell block in ${target}`, error);
    }
  }
}

export async function cleanupLegacyCodexPluginRuntime(
  pluginDirectory: string,
): Promise<void> {
  const runtimeRoot = path.join(pluginDirectory, "tmp");
  for (const name of ["codex-ipc", "node-compile-cache"]) {
    await fs.promises.rm(path.join(runtimeRoot, name), {
      recursive: true,
      force: true,
    }).catch((error) => {
      console.warn(`[mv-aide] Failed to remove legacy Codex runtime ${name}`, error);
    });
  }
  try {
    if ((await fs.promises.readdir(runtimeRoot)).length === 0) {
      await fs.promises.rmdir(runtimeRoot);
    }
  } catch {
    // Missing or non-empty runtime root is fine.
  }
}

export async function cleanupLegacyDefaultCodexMcpRegistration(): Promise<void> {
  const legacyConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (path.resolve(legacyConfig) === path.resolve(codexConfigPath())) return;
  await removeCodexMcpRegistration({ configPath: legacyConfig });
}

export async function migrateLegacyCodexArtifacts(pluginDirectory: string): Promise<void> {
  await Promise.all([
    removeLegacyCodexShellAlias(),
    cleanupLegacyCodexPluginRuntime(pluginDirectory),
    cleanupLegacyDefaultCodexMcpRegistration(),
  ]);
}
