import path from "node:path";
import { mvAideRuntimeRoot, mvAideTempRoot } from "./system-paths";
import { mvAideVaultRoot } from "./vault-paths";

function assertRelativeScope(scope: string): string {
  const normalized = scope.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid mv-AIDE path scope: ${scope}`);
  }
  return normalized;
}

export function mvAideRuntimeDirectory(scope: string): string {
  return path.join(mvAideRuntimeRoot(), ...assertRelativeScope(scope).split("/"));
}

export function mvAideTempDirectory(scope: string): string {
  return path.join(mvAideTempRoot(), ...assertRelativeScope(scope).split("/"));
}

export function mvAideVaultTempDirectory(vaultRoot: string, scope: string): string {
  return path.join(
    mvAideVaultRoot(vaultRoot),
    "tmp",
    ...assertRelativeScope(scope).split("/"),
  );
}
