import fs from "node:fs";
import path from "node:path";
import type { BridgeSettings } from "./types";

interface ClaudeSettingsFile {
  env?: Record<string, string>;
  [key: string]: unknown;
}

export function localClaudeSettingsPath(vaultRoot: string): string {
  return path.join(vaultRoot, ".claude", "settings.local.json");
}

function readJson(filePath: string): ClaudeSettingsFile {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJson(filePath: string, value: ClaudeSettingsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.mv-senceai.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

export function applyManagedBaseUrl(
  filePath: string,
  proxyBaseUrl: string,
  settings: BridgeSettings,
): BridgeSettings {
  const document = readJson(filePath);
  const env = { ...(document.env ?? {}) };

  if (settings.managedLocalBaseUrl !== proxyBaseUrl) {
    const current = env.ANTHROPIC_BASE_URL ?? null;
    settings = {
      ...settings,
      previousLocalBaseUrl:
        current === settings.managedLocalBaseUrl ? settings.previousLocalBaseUrl : current,
      managedLocalBaseUrl: proxyBaseUrl,
    };
  }

  env.ANTHROPIC_BASE_URL = proxyBaseUrl;
  document.env = env;
  writeJson(filePath, document);
  return settings;
}

export function restoreManagedBaseUrl(
  filePath: string,
  settings: BridgeSettings,
): BridgeSettings {
  const document = readJson(filePath);
  const env = { ...(document.env ?? {}) };

  if (
    settings.managedLocalBaseUrl &&
    env.ANTHROPIC_BASE_URL === settings.managedLocalBaseUrl
  ) {
    if (settings.previousLocalBaseUrl) {
      env.ANTHROPIC_BASE_URL = settings.previousLocalBaseUrl;
    } else {
      delete env.ANTHROPIC_BASE_URL;
    }
    if (Object.keys(env).length > 0) {
      document.env = env;
    } else {
      delete document.env;
    }
    if (Object.keys(document).length > 0) {
      writeJson(filePath, document);
    } else {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // The file may already be gone.
      }
    }
  }

  return {
    ...settings,
    previousLocalBaseUrl: null,
    managedLocalBaseUrl: null,
  };
}
