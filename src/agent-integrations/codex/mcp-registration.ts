import fs from "node:fs";
import path from "node:path";
import { t } from "../../i18n";
import { codexConfigPath } from "./paths";

export interface CodexMcpRegistrationResult {
  ok: boolean;
  message: string;
}

interface CodexMcpRegistrationRuntime {
  configPath?: string;
}

const MANAGED_BEGIN = "# BEGIN mv-AIDE managed Codex MCP server";
const MANAGED_END = "# END mv-AIDE managed Codex MCP server";
const LEGACY_MANAGED_BEGIN = "# BEGIN mv-SenceAI managed Codex MCP server";
const LEGACY_MANAGED_END = "# END mv-SenceAI managed Codex MCP server";
const SERVER_NAME = "mv_aide_obsidian";

export function defaultCodexConfigPath(): string {
  return codexConfigPath();
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function managedBlock(url: string, authToken: string): string {
  return [
    MANAGED_BEGIN,
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${authToken}`)} }`,
    "enabled = true",
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 60",
    MANAGED_END,
  ].join("\n");
}

function stripMarkedBlock(content: string, begin: string, end: string): string {
  const start = content.indexOf(begin);
  if (start < 0) return content;
  const endIndex = content.indexOf(end, start);
  if (endIndex < 0) return content;
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(endIndex + end.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n") + (before || after ? "\n" : "");
}

function stripManagedBlock(content: string): string {
  const stripped = stripMarkedBlock(content, MANAGED_BEGIN, MANAGED_END);
  return stripMarkedBlock(stripped, LEGACY_MANAGED_BEGIN, LEGACY_MANAGED_END);
}

function upsertManagedBlock(content: string, block: string): string {
  const stripped = stripManagedBlock(content).trimEnd();
  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.mv-aide.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export async function ensureCodexMcpRegistration(
  url: string,
  authToken: string,
  runtime: CodexMcpRegistrationRuntime = {},
): Promise<CodexMcpRegistrationResult> {
  try {
    const configPath = runtime.configPath ?? defaultCodexConfigPath();
    const current = readIfExists(configPath);
    writeFileAtomic(configPath, upsertManagedBlock(current, managedBlock(url, authToken)));
    return { ok: true, message: t("Codex MCP 已配置") };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeCodexMcpRegistration(
  runtime: CodexMcpRegistrationRuntime = {},
): Promise<CodexMcpRegistrationResult> {
  try {
    const configPath = runtime.configPath ?? defaultCodexConfigPath();
    const current = readIfExists(configPath);
    const next = stripManagedBlock(current);
    if (next !== current) writeFileAtomic(configPath, next);
    return { ok: true, message: t("Codex MCP 已移除") };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
