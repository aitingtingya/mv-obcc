import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BridgeSettings, ResolvedUpstream } from "./types";

interface ClaudeSettingsDocument {
  env?: Record<string, unknown>;
}

function readBaseUrl(filePath: string): string {
  try {
    const document = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeSettingsDocument;
    const value = document.env?.ANTHROPIC_BASE_URL;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function usable(value: string, settings: BridgeSettings): string {
  if (!value || value === settings.managedLocalBaseUrl) return "";
  return value;
}

export function resolveAnthropicBaseUrl(
  vaultRoot: string,
  settings: BridgeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): ResolvedUpstream {
  const manual = settings.upstreamBaseUrl.trim();
  if (manual) return { url: manual, source: "manual" };

  const localPath = path.join(vaultRoot, ".claude", "settings.local.json");
  const local = usable(readBaseUrl(localPath), settings);
  if (local) return { url: local, source: "vault-local" };
  if (settings.previousLocalBaseUrl?.trim()) {
    return { url: settings.previousLocalBaseUrl.trim(), source: "vault-local" };
  }

  const project = usable(
    readBaseUrl(path.join(vaultRoot, ".claude", "settings.json")),
    settings,
  );
  if (project) return { url: project, source: "vault-project" };

  const user = usable(
    readBaseUrl(path.join(homeDirectory, ".claude", "settings.json")),
    settings,
  );
  if (user) return { url: user, source: "user" };

  const environmentUrl = usable(environment.ANTHROPIC_BASE_URL?.trim() ?? "", settings);
  if (environmentUrl) return { url: environmentUrl, source: "environment" };
  return { url: "", source: "none" };
}

export function migrateManualUpstream(
  vaultRoot: string,
  settings: BridgeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): BridgeSettings {
  const manual = settings.upstreamBaseUrl.trim();
  if (!manual) return settings;
  const withoutManual = { ...settings, upstreamBaseUrl: "" };
  const discovered = resolveAnthropicBaseUrl(
    vaultRoot,
    withoutManual,
    environment,
    homeDirectory,
  );
  return discovered.url === manual ? withoutManual : settings;
}
