import os from "node:os";
import path from "node:path";
import { mvAideVaultRoot } from "../../storage/vault-paths";

export const DSH_RUNTIME_RELATIVE_PATH = "mv-aide/dsh/runtime";
export const DSH_NODE_RELATIVE_PATH = "mv-aide/dsh/node";

export function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export function dshWebProfileDirectory(): string {
  return path.join(dshHome(), "profiles", "web");
}

export function dshWebProfilePatchPath(): string {
  return path.join(dshWebProfileDirectory(), "cordis.patch.yml");
}

export function dshAgentPackageDirectory(): string {
  return path.join(dshWebProfileDirectory(), "node_modules", "@mv-aide", "mv-agent");
}

export function dshManagerPackageDirectory(): string {
  return path.join(dshWebProfileDirectory(), "node_modules", "@mv-aide", "mv-dsh-manager");
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
