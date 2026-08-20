import os from "node:os";
import path from "node:path";

export function codexHome(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configured = environment.CODEX_HOME?.trim();
  return configured || path.join(homeDirectory, ".codex");
}

export function codexConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(codexHome(environment, homeDirectory), "config.toml");
}

export function codexIpcDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return path.join(codexHome(environment, homeDirectory), "ipc");
}

export function codexIdeEndpoint(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  return platform === "win32"
    ? "\\\\.\\pipe\\codex-ipc"
    : path.join(codexIpcDirectory(environment, homeDirectory), "ipc.sock");
}
