import fs from "node:fs";
import path from "node:path";
import { MANAGED_HOOK_MARKER } from "./constants";

interface HookCommand {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

interface ClaudeSettingsDocument {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const MANAGED_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

function readJson(filePath: string): ClaudeSettingsDocument {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: ClaudeSettingsDocument): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.mv-senceai-hook.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function isManagedHook(hook: HookCommand): boolean {
  return (
    hook.type === "command" &&
    typeof hook.command === "string" &&
    hook.command.includes(MANAGED_HOOK_MARKER)
  );
}

function removeManagedHooks(document: ClaudeSettingsDocument): void {
  if (!document.hooks || typeof document.hooks !== "object") return;
  for (const event of MANAGED_EVENTS) {
    const groups = Array.isArray(document.hooks[event]) ? document.hooks[event] : [];
    const remaining = groups
      .map((group) => ({
        ...group,
        hooks: Array.isArray(group.hooks)
          ? group.hooks.filter((hook) => !isManagedHook(hook))
          : [],
      }))
      .filter((group) => group.hooks.length > 0);
    if (remaining.length > 0) {
      document.hooks[event] = remaining;
    } else {
      delete document.hooks[event];
    }
  }
  if (Object.keys(document.hooks).length === 0) delete document.hooks;
}

export function managedTerminalMarkerCommand(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return [
      "$s=$env:CLAUDE_CODE_SESSION_ID;",
      "Write-Output ('{\"suppressOutput\":true,\"terminalSequence\":\"\\u001b]0;mv-senceai-ide:'+$s+'\\u0007\"}');",
      `# ${MANAGED_HOOK_MARKER}`,
    ].join(" ");
  }
  return [
    `printf '{"suppressOutput":true,"terminalSequence":"\\\\u001b]0;mv-senceai-ide:%s\\\\u0007"}\\n' "$CLAUDE_CODE_SESSION_ID";`,
    `: ${MANAGED_HOOK_MARKER}`,
  ].join(" ");
}

export function applyManagedTerminalHooks(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const document = readJson(filePath);
  removeManagedHooks(document);
  const hooks = { ...(document.hooks ?? {}) };
  const command = managedTerminalMarkerCommand(platform);
  for (const event of MANAGED_EVENTS) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ type: "command", command, timeout: 5 }] },
    ];
  }
  document.hooks = hooks;
  writeJson(filePath, document);
}

export function restoreManagedTerminalHooks(filePath: string): void {
  const document = readJson(filePath);
  removeManagedHooks(document);
  if (Object.keys(document).length === 0) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // The file may already be gone.
    }
    return;
  }
  writeJson(filePath, document);
}
