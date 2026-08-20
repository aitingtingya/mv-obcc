import fs from "node:fs";

interface HookCommand {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface ClaudeSettingsDocument {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export type LegacyClaudeHookCleanupResult = "cleaned" | "not-needed" | "retry";

type ExistingJsonResult =
  | { status: "loaded"; document: ClaudeSettingsDocument }
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

const LEGACY_MANAGED_HOOK_MARKER = "mv-aide-ide-terminal-marker-v1";
const LEGACY_MANAGED_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

function readExistingJson(filePath: string): ExistingJsonResult {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { status: "loaded", document: parsed }
      : { status: "unavailable" };
  } catch (error) {
    return isNotFoundError(error)
      ? { status: "not-found" }
      : { status: "unavailable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLegacyManagedHook(hook: unknown): hook is HookCommand {
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    typeof hook.command === "string" &&
    hook.command.includes(LEGACY_MANAGED_HOOK_MARKER)
  );
}

/** Remove terminal-title hooks created by older mv-AIDE versions. */
export function cleanupLegacyManagedTerminalHooks(
  filePath: string,
): LegacyClaudeHookCleanupResult {
  const readResult = readExistingJson(filePath);
  if (readResult.status === "not-found") return "not-needed";
  if (readResult.status === "unavailable") return "retry";
  const { document } = readResult;
  if (!document.hooks || typeof document.hooks !== "object") {
    return "not-needed";
  }

  let changed = false;
  for (const event of LEGACY_MANAGED_EVENTS) {
    const groups = document.hooks[event];
    if (!Array.isArray(groups)) continue;
    let eventChanged = false;
    const remaining: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        remaining.push(group);
        continue;
      }
      const kept = group.hooks.filter((hook) => !isLegacyManagedHook(hook));
      if (kept.length === group.hooks.length) {
        remaining.push(group);
        continue;
      }
      eventChanged = true;
      changed = true;
      if (kept.length > 0) remaining.push({ ...group, hooks: kept });
    }
    if (!eventChanged) continue;
    if (remaining.length > 0) document.hooks[event] = remaining;
    else delete document.hooks[event];
  }
  if (!changed) return "not-needed";
  if (Object.keys(document.hooks).length === 0) delete document.hooks;

  const temporary = `${filePath}.mv-aide-legacy-hook.tmp`;
  try {
    if (Object.keys(document).length === 0) {
      fs.unlinkSync(filePath);
    } else {
      fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      fs.renameSync(temporary, filePath);
    }
    return "cleaned";
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The original settings file remains authoritative and untouched.
    }
    return "retry";
  }
}
