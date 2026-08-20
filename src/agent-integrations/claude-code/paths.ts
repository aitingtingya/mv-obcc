import os from "node:os";
import path from "node:path";

export function claudeConfigDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configured = environment.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(homeDirectory, ".claude");
}

export function claudeIdeDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(claudeConfigDirectory(environment, homeDirectory), "ide");
}

export function claudeSessionDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(claudeConfigDirectory(environment, homeDirectory), "sessions");
}

export function claudeSessionIdentityPath(
  processId: number,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(claudeSessionDirectory(environment, homeDirectory), `${processId}.json`);
}

export function claudeUserSettingsPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(claudeConfigDirectory(environment, homeDirectory), "settings.json");
}

export function claudeProjectDirectory(vaultRoot: string): string {
  return path.join(vaultRoot, ".claude");
}

export function claudeProjectLocalSettingsPath(vaultRoot: string): string {
  return path.join(claudeProjectDirectory(vaultRoot), "settings.local.json");
}

export function claudeProjectSettingsPath(vaultRoot: string): string {
  return path.join(claudeProjectDirectory(vaultRoot), "settings.json");
}
