import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ClaudeClientIdentity {
  processId: number;
  sessionId: string;
}

interface ClaudeSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
}

export function parseLsofClientPid(
  output: string,
  remotePort: number,
  serverPort: number,
): number | null {
  let processId: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      processId = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (
      processId &&
      line.startsWith("n") &&
      line.includes(`:${remotePort}->`) &&
      line.endsWith(`:${serverPort}`)
    ) {
      return processId;
    }
  }
  return null;
}

export function parsePowerShellClientPid(output: string): number | null {
  const parsed = Number(output.trim().split(/\r?\n/).find((line) => /^\d+$/.test(line.trim())));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function pathBelongsToVault(candidate: string, vaultRoot: string): boolean {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function readClaudeSessionIdentity(
  processId: number,
  vaultRoot: string,
  homeDirectory = os.homedir(),
): ClaudeClientIdentity | null {
  try {
    const filePath = path.join(
      homeDirectory,
      ".claude",
      "sessions",
      `${processId}.json`,
    );
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeSessionFile;
    if (
      value.pid !== processId ||
      typeof value.sessionId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.cwd !== "string" ||
      !pathBelongsToVault(value.cwd, vaultRoot)
    ) {
      return null;
    }
    return { processId, sessionId: value.sessionId.toLowerCase() };
  } catch {
    return null;
  }
}

async function processForConnection(
  remotePort: number,
  serverPort: number,
  platform: NodeJS.Platform,
): Promise<number | null> {
  if (platform === "win32") {
    const script = [
      `$connection = Get-NetTCPConnection -State Established`,
      `  | Where-Object { $_.LocalPort -eq ${remotePort} -and $_.RemotePort -eq ${serverPort} }`,
      "  | Select-Object -First 1 -ExpandProperty OwningProcess",
      "if ($connection) { Write-Output $connection }",
    ].join(" ");
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const { stdout } = await execFileAsync(executable, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ]);
        const processId = parsePowerShellClientPid(stdout);
        if (processId) return processId;
      } catch {
        // Try the next PowerShell host.
      }
    }
    return null;
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-a",
      `-iTCP:${remotePort}`,
      "-sTCP:ESTABLISHED",
      "-Fpcn",
    ]);
    return parseLsofClientPid(stdout, remotePort, serverPort);
  } catch {
    return null;
  }
}

export async function resolveClaudeClientIdentity(
  remotePort: number,
  serverPort: number,
  vaultRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeClientIdentity | null> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const processId = await processForConnection(remotePort, serverPort, platform);
    if (processId) {
      const identity = readClaudeSessionIdentity(processId, vaultRoot);
      if (identity) return identity;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
