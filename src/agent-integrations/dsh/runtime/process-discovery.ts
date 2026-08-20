import { runProcess } from "../../../process-runner";

/** One DSH-looking process plus its platform-level identity. */
export interface DshProcessInfo {
  pid: number;
  ppid: number;
  /** Listening port parsed from `--port`, or null when it is not present. */
  port: number | null;
  command: string;
  /** Native executable path when the platform can report it. */
  executable?: string;
}

/**
 * Platform adapter for the process facts `DshProcessManager` needs. All
 * policy decisions stay in the manager; this interface only reads and kills
 * operating-system processes.
 */
export interface DshProcessDiscoveryAdapter {
  listDshProcesses(): Promise<DshProcessInfo[]>;
  /**
   * Fail-closed process enumeration used before mutating the Windows DSH
   * package. Normal discovery may stay best-effort for UI/runtime probing.
   */
  listDshProcessesStrict?(): Promise<DshProcessInfo[]>;
  processInfo(pid: number): Promise<DshProcessInfo | null>;
  listenerPid(port: number): Promise<number | null>;
  killProcessTree(pid: number): Promise<boolean>;
}

export interface DshDiscoveredProcess extends DshProcessInfo {
  isObsidianChild: boolean;
}

interface RawProcessLine {
  pid: number;
  ppid: number;
  command: string;
  executable?: string;
}

function parsePort(command: string): number | null {
  const match = /--port[= ]\s*(\d{1,5})/iu.exec(command);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

function parsePsLine(line: string): RawProcessLine | null {
  const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/u.exec(line);
  if (!match) return null;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, command: match[3].trim() };
}

function parseSingleNumber(output: string): number | null {
  const match = /\d{1,7}/u.exec(output.trim());
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonProcesses(output: string): RawProcessLine[] {
  const parsed = JSON.parse(output) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const result: RawProcessLine[] = [];
  for (const item of items) {
    const record = item as {
      ProcessId?: unknown;
      ParentProcessId?: unknown;
      ExecutablePath?: unknown;
      CommandLine?: unknown;
    };
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    const command = String(record.CommandLine ?? "").trim();
    if (Number.isInteger(pid) && Number.isInteger(ppid) && command.length > 0) {
      const executable = String(record.ExecutablePath ?? "").trim();
      result.push({ pid, ppid, command, ...(executable ? { executable } : {}) });
    }
  }
  return result;
}

async function pgrep(args: string[], run = runProcess): Promise<number[]> {
  const result = await run("pgrep", args, { timeoutMs: 5000 });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function psAll(run = runProcess): Promise<RawProcessLine[]> {
  const result = await run("ps", ["-axo", "pid=,ppid=,command="], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => parsePsLine(line))
    .filter((item): item is RawProcessLine => item !== null);
}

function isDshCommand(command: string): boolean {
  return /\bdsh(?:\.exe)?\s+web(?:\s|$)/iu.test(command);
}

/**
 * Strong Windows classifier for a process that is executing DSH runtime code.
 * Merely mentioning `dsh` (for example npm install/view or an editor filename)
 * is intentionally insufficient.
 */
export function isDshRuntimeProcess(
  info: Pick<DshProcessInfo, "command" | "executable">,
): boolean {
  const executable = (info.executable ?? "").replace(/\\/gu, "/").toLowerCase();
  const executableBase = executable.split("/").at(-1) ?? "";
  if (executableBase === "dsh" || executableBase === "dsh.exe") return true;

  const firstToken = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(info.command);
  const invoked = (firstToken?.[1] ?? firstToken?.[2] ?? firstToken?.[3] ?? "")
    .replace(/\\/gu, "/")
    .toLowerCase()
    .split("/")
    .at(-1) ?? "";
  if (invoked === "dsh" || invoked === "dsh.exe" || invoked === "dsh.cmd") return true;

  const command = info.command.replace(/\\/gu, "/").toLowerCase();
  // npm itself only contains a package spec (`@deepseek-ai/dsh@x.y.z`). A live
  // DSH process is Node executing code from the installed package directory.
  const nodeHost = executableBase === "node" || executableBase === "node.exe"
    || invoked === "node" || invoked === "node.exe";
  return nodeHost && /\/node_modules\/@deepseek-ai\/dsh(?:\/|$)/u.test(command);
}

function toProcessInfo(line: RawProcessLine): DshProcessInfo {
  return {
    pid: line.pid,
    ppid: line.ppid,
    command: line.command,
    port: parsePort(line.command),
    ...(line.executable ? { executable: line.executable } : {}),
  };
}

function toProcessInfoOrNull(line: RawProcessLine | null): DshProcessInfo | null {
  return line ? toProcessInfo(line) : null;
}

async function unixProcessInfo(pid: number, run = runProcess): Promise<DshProcessInfo | null> {
  const result = await run("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.trim();
  if (!line) return null;
  return toProcessInfoOrNull(parsePsLine(line));
}

async function unixListenerPid(port: number, run = runProcess): Promise<number | null> {
  const lsof = await run(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { timeoutMs: 5000 },
  );
  if (lsof.code === 0) {
    const parsed = parseSingleNumber(lsof.stdout);
    if (parsed !== null) return parsed;
  }
  if (process.platform === "linux") {
    const ss = await run(
      "ss",
      ["-ltnp", `sport = :${port}`],
      { timeoutMs: 5000 },
    );
    if (ss.code === 0) {
      const match = /pid=(\d{1,7})/u.exec(ss.stdout);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

async function unixKillProcessTree(pid: number, run = runProcess): Promise<boolean> {
  const descendants = new Set<number>();
  const collect = async (parent: number): Promise<void> => {
    const children = await pgrep(["-P", String(parent)], run);
    for (const child of children) {
      if (child === parent || descendants.has(child)) continue;
      descendants.add(child);
      await collect(child);
    }
  };
  await collect(pid);

  const ordered = [pid, ...Array.from(descendants)].reverse();
  let signalled = false;
  for (const target of ordered) {
    const result = await run("kill", ["-TERM", String(target)], {
      timeoutMs: 5000,
    });
    signalled ||= result.code === 0;
  }
  if (!signalled) return false;
  await new Promise((resolve) => setTimeout(resolve, 600));
  for (const target of ordered) {
    const alive = await run("kill", ["-0", String(target)], { timeoutMs: 5000 });
    if (alive.code === 0) {
      await run("kill", ["-KILL", String(target)], { timeoutMs: 5000 });
    }
  }
  return true;
}

async function windowsPowerShell(run: typeof runProcess, script: string): Promise<string | null> {
  const result = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 8000 },
  );
  return result.code === 0 ? result.stdout : null;
}

const WINDOWS_DSH_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "Get-CimInstance Win32_Process",
  "| Where-Object { $_.CommandLine -and $_.CommandLine -match '(?i)dsh' }",
  "| Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine",
  "| ConvertTo-Json -Compress",
].join(" ");

async function windowsDshProcesses(
  run = runProcess,
  strict = false,
): Promise<RawProcessLine[]> {
  const result = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DSH_PROCESS_SCRIPT],
    { timeoutMs: 8000 },
  );
  if (result.code !== 0) {
    if (strict) {
      throw new Error(result.stderr || result.stdout || "Windows DSH process enumeration failed.");
    }
    return [];
  }
  if (!result.stdout.trim()) return [];
  try {
    return parseJsonProcesses(result.stdout).filter((line) =>
      isDshRuntimeProcess(toProcessInfo(line)));
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

async function windowsProcessInfo(pid: number, run = runProcess): Promise<DshProcessInfo | null> {
  const output = await windowsPowerShell(
    run,
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  );
  if (!output) return null;
  try {
    const parsed = parseJsonProcesses(output)[0];
    return parsed ? toProcessInfo(parsed) : null;
  } catch {
    return null;
  }
}

async function windowsListenerPid(port: number, run = runProcess): Promise<number | null> {
  const output = await windowsPowerShell(
    run,
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess | Select-Object -First 1`,
  );
  return output ? parseSingleNumber(output) : null;
}

async function windowsKillProcessTree(pid: number, run = runProcess): Promise<boolean> {
  const result = await run(
    "taskkill",
    ["/PID", String(pid), "/T", "/F"],
    { timeoutMs: 10_000 },
  );
  return result.code === 0;
}

/**
 * The real adapter for the current desktop platform. Every method is
 * asynchronous and uses the non-blocking process runner shared by the rest of
 * the plugin.
 */
export function createDefaultDshProcessDiscoveryAdapter(
  platform: NodeJS.Platform = process.platform,
  run: typeof runProcess = runProcess,
): DshProcessDiscoveryAdapter {
  if (platform === "win32") {
    return {
      listDshProcesses: async () =>
        (await windowsDshProcesses(run)).map(toProcessInfo),
      listDshProcessesStrict: async () =>
        (await windowsDshProcesses(run, true)).map(toProcessInfo),
      processInfo: (pid) => windowsProcessInfo(pid, run),
      listenerPid: (port) => windowsListenerPid(port, run),
      killProcessTree: (pid) => windowsKillProcessTree(pid, run),
    };
  }

  return {
    listDshProcesses: async () => {
      const [pgrepPids, allProcesses] = await Promise.all([
        pgrep(["-f", "dsh web"], run),
        psAll(run),
      ]);
      const processes = allProcesses
        .filter((line) => isDshCommand(line.command))
        .map(toProcessInfo);
      const seen = new Set(processes.map((process) => process.pid));
      for (const pid of pgrepPids) {
        if (seen.has(pid)) continue;
        const info = await unixProcessInfo(pid, run);
        if (info && isDshCommand(info.command)) {
          processes.push(info);
          seen.add(info.pid);
        }
      }
      return processes;
    },
    processInfo: (pid) => unixProcessInfo(pid, run),
    listenerPid: (port) => unixListenerPid(port, run),
    killProcessTree: (pid) => unixKillProcessTree(pid, run),
  };
}

/**
 * Walk up the parent chain and decide whether this process was spawned by an
 * Obsidian process. Connection to an external DSH never changes PPID, so this
 * is purely an OS-level ancestry check.
 */
export async function isObsidianChildProcess(
  adapter: DshProcessDiscoveryAdapter,
  info: DshProcessInfo,
): Promise<boolean> {
  if (/obsidian/iu.test(info.command)) return true;
  let current = info.ppid;
  for (let depth = 0; depth < 32; depth += 1) {
    if (current <= 0) return false;
    const parent = await adapter.processInfo(current);
    if (!parent) return false;
    if (/obsidian/iu.test(parent.command)) return true;
    if (parent.ppid === parent.pid) return false;
    current = parent.ppid;
  }
  return false;
}

/** List every DSH web process and annotate its Obsidian-child status. */
export async function discoverDshProcesses(
  adapter: DshProcessDiscoveryAdapter,
): Promise<DshDiscoveredProcess[]> {
  const processes = await adapter.listDshProcesses();
  const result: DshDiscoveredProcess[] = [];
  for (const process of processes) {
    result.push({
      ...process,
      isObsidianChild: await isObsidianChildProcess(adapter, process),
    });
  }
  return result;
}
