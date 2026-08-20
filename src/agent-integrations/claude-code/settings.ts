import fs from "node:fs";
import { claudeProjectLocalSettingsPath } from "./paths";

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type LegacyClaudeCleanupResult = "cleaned" | "not-needed" | "retry";

interface LegacyManagedBaseUrlRetryMetadata {
  managedLocalBaseUrl: string;
  previousLocalBaseUrl?: string;
}

type ExistingJsonResult =
  | { status: "loaded"; document: ClaudeSettingsFile }
  | { status: "not-found" }
  | { status: "unavailable" };

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function localClaudeSettingsPath(vaultRoot: string): string {
  return claudeProjectLocalSettingsPath(vaultRoot);
}

function legacyManagedBaseUrlRetryMetadata(
  result: LegacyClaudeCleanupResult,
  managedLocalBaseUrl: string | null | undefined,
  previousLocalBaseUrl: string | null | undefined,
): LegacyManagedBaseUrlRetryMetadata | null {
  if (result !== "retry" || !managedLocalBaseUrl) return null;
  return {
    managedLocalBaseUrl,
    ...(previousLocalBaseUrl ? { previousLocalBaseUrl } : {}),
  };
}

export function preserveLegacyManagedBaseUrlRetryMetadata(
  settings: object,
  result: LegacyClaudeCleanupResult,
  managedLocalBaseUrl: string | null | undefined,
  previousLocalBaseUrl: string | null | undefined,
): boolean {
  const metadata = legacyManagedBaseUrlRetryMetadata(
    result,
    managedLocalBaseUrl,
    previousLocalBaseUrl,
  );
  if (!metadata) return false;
  Object.assign(settings, metadata);
  return true;
}

function readExistingJson(filePath: string): ExistingJsonResult {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { status: "loaded", document: value }
      : { status: "unavailable" };
  } catch (error) {
    return isNotFoundError(error)
      ? { status: "not-found" }
      : { status: "unavailable" };
  }
}

function writeExistingJson(filePath: string, value: ClaudeSettingsFile): void {
  const temporary = `${filePath}.mv-aide-legacy.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function removeTemporaryFile(filePath: string): void {
  try {
    fs.rmSync(`${filePath}.mv-aide-legacy.tmp`, { force: true });
  } catch {
    // The original settings file remains authoritative and untouched.
  }
}

/**
 * One-way migration cleanup for the removed compatibility proxy. It only
 * restores ANTHROPIC_BASE_URL when the file still contains the exact value
 * previously managed by mv-AIDE; user changes are never overwritten.
 */
export function cleanupLegacyManagedBaseUrl(
  filePath: string,
  managedLocalBaseUrl: string | null | undefined,
  previousLocalBaseUrl: string | null | undefined,
): LegacyClaudeCleanupResult {
  if (!managedLocalBaseUrl) return "not-needed";
  const readResult = readExistingJson(filePath);
  if (readResult.status === "not-found") return "not-needed";
  if (readResult.status === "unavailable") return "retry";
  const { document } = readResult;
  const env = { ...(document.env ?? {}) };
  if (env.ANTHROPIC_BASE_URL !== managedLocalBaseUrl) return "not-needed";

  if (previousLocalBaseUrl) {
    env.ANTHROPIC_BASE_URL = previousLocalBaseUrl;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (Object.keys(env).length > 0) document.env = env;
  else delete document.env;

  try {
    if (Object.keys(document).length === 0) {
      fs.unlinkSync(filePath);
    } else {
      writeExistingJson(filePath, document);
    }
    return "cleaned";
  } catch {
    removeTemporaryFile(filePath);
    return "retry";
  }
}
