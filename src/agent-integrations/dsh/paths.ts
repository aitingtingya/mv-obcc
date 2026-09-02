import os from "node:os";
import path from "node:path";
import { mvAideVaultRoot } from "../../storage/vault-paths";

export const DSH_RUNTIME_RELATIVE_PATH = "mv-aide/dsh/runtime";
export const DSH_NODE_RELATIVE_PATH = "mv-aide/dsh/node";
export const DSH_HOME_RELATIVE_PATH = "mv-aide/dsh/home";

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Match DSH's official configured path -> DSH_HOME -> ~/.dsh precedence. */
export function resolveDshHomeDirectory(
  configured?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const inherited = environment.DSH_HOME;
  const selected = configured
    ?? (inherited !== undefined && inherited.trim().length > 0
      ? inherited
      : path.join(os.homedir(), ".dsh"));
  return path.resolve(expandHome(selected));
}

/** Project one selected data root into a child-command environment. */
export function withDshHomeEnvironment(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): NodeJS.ProcessEnv {
  return { ...environment, DSH_HOME: path.resolve(homeDirectory) };
}

export function dshHome(): string {
  return resolveDshHomeDirectory();
}

export function dshWebProfileDirectory(homeDirectory = dshHome()): string {
  return path.join(homeDirectory, "profiles", "web");
}

export function dshWebProfilePatchPath(homeDirectory = dshHome()): string {
  return path.join(dshWebProfileDirectory(homeDirectory), "cordis.patch.yml");
}

export function dshAgentPackageDirectory(homeDirectory = dshHome()): string {
  return path.join(dshWebProfileDirectory(homeDirectory), "node_modules", "@mv-aide", "mv-agent");
}

export function dshManagerPackageDirectory(homeDirectory = dshHome()): string {
  return path.join(dshWebProfileDirectory(homeDirectory), "node_modules", "@mv-aide", "mv-dsh-manager");
}

export function dshSubworkspacePackageDirectory(homeDirectory = dshHome()): string {
  return path.join(dshWebProfileDirectory(homeDirectory), "node_modules", "@mv-aide", "mv-dsh-subworkspace");
}

/** Shared library used by the three managed DSH plugins; not a plugin row. */
export function dshCompatPackageDirectory(homeDirectory = dshHome()): string {
  return path.join(dshWebProfileDirectory(homeDirectory), "node_modules", "@mv-aide", "mv-dsh-compat");
}

export function dshVaultDirectory(vaultRoot: string): string {
  return path.join(mvAideVaultRoot(vaultRoot), "dsh");
}

export function dshVaultNodeDirectory(vaultRoot: string): string {
  return path.join(dshVaultDirectory(vaultRoot), "node");
}

export function dshVaultRuntimeDirectory(vaultRoot: string): string {
  return path.join(dshVaultDirectory(vaultRoot), "runtime");
}

export function dshVaultHomeDirectory(vaultRoot: string): string {
  return path.join(dshVaultDirectory(vaultRoot), "home");
}

export function effectiveDshHomeDirectory(
  vaultRoot: string,
  useVaultDshHome: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return useVaultDshHome
    ? path.resolve(dshVaultHomeDirectory(vaultRoot))
    : resolveDshHomeDirectory(undefined, environment);
}
