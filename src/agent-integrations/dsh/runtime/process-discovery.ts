import { runProcess, windowsPowerShellEncodingLines } from "../../../process-runner";
import { t } from "../../../i18n";

/** One DSH-looking process plus its platform-level identity. */
export interface DshProcessInfo {
  pid: number;
  ppid: number;
  /** Listening port parsed from `--port`, or null when it is not present. */
  port: number | null;
  command: string;
  /** Native executable path when the platform can report it. */
  executable?: string;
  /**
   * True when `command` is only the process image name (from a light
   * ancestry-tree row), not a real command line. Consumers that match the
   * command against a runtime identity must treat such rows as "no command
   * line available"; consumers that only need the name (ancestry walks) may
   * use them directly.
   */
  nameOnly?: boolean;
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
  processCwd?(pid: number): Promise<string | null>;
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
    const command = asTrimmedString(record.CommandLine);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && command.length > 0) {
      const executable = asTrimmedString(record.ExecutablePath);
      result.push({ pid, ppid, command, ...(executable ? { executable } : {}) });
    }
  }
  return result;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

export function isDshCommand(command: string): boolean {
  const normalized = command.replace(/\\/gu, "/");
  return /\bdsh(?:\.exe)?\s+web(?:\s|$)/iu.test(normalized)
    || /apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)(?:["']?)(?:\s+[^\s]+)*\s+web(?:\s|$)/iu.test(normalized);
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
  return nodeHost && (
    /\/node_modules\/@deepseek-ai\/dsh(?:\/|$)/u.test(command)
    || /apps\/cli\/(?:lib\/bin\.js|src\/bin\.ts)(?:["']?)(?:\s+[^\s]+)*\s+web(?:\s|$)/u.test(command)
  );
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

async function unixProcessCwd(
  pid: number,
  platform: NodeJS.Platform,
  run = runProcess,
): Promise<string | null> {
  if (platform === "linux") {
    const result = await run("readlink", ["-f", `/proc/${pid}/cwd`], { timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  const result = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) return null;
  const line = result.stdout.split(/\r?\n/u).find((item) => item.startsWith("n"));
  return line?.slice(1).trim() || null;
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
    // Force UTF-8 output before anything else: without it WinPS writes through
    // the OEM codepage and non-ASCII command lines (e.g. a Chinese vault path)
    // arrive as mojibake under the runner's UTF-8 decoding. Default
    // Continue preference keeps a failed encoding switch non-fatal.
    ["-NoProfile", "-NonInteractive", "-Command", [...windowsPowerShellEncodingLines(), script].join("; ")],
    { timeoutMs: 8000 },
  );
  return result.code === 0 ? result.stdout : null;
}

/**
 * Fail-closed pre-mutation enumeration gets a much longer budget than
 * best-effort discovery: machines with a degraded WMI service take 100s+ for
 * a single Win32_Process query (measured in the field), and aborting package
 * mutation setup at 8s made every upgrade fail with a bare timeout message.
 */
export const WINDOWS_STRICT_ENUMERATION_TIMEOUT_MS = 60_000;
const WINDOWS_SNAPSHOT_CACHE_TTL_MS = 2000;
const WINDOWS_TCP_TABLE_TTL_MS = 2000;

/**
 * One CIM provider enumeration yields both the detailed DSH process list and
 * a light pid/ppid/name tree. The provider materializes CommandLine for every
 * process either way (server-side filtering does not reduce its cost), so the
 * script emits CommandLine/ExecutablePath only for dsh-looking rows to keep
 * the JSON small, and the tree powers in-memory ancestry walks instead of one
 * PowerShell spawn per parent level.
 */
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  // UTF-8 first, before `$ErrorActionPreference = 'Stop'`: a failed encoding
  // switch must stay a non-terminating error, and every CommandLine with
  // non-ASCII path segments must survive the runner's UTF-8 decoding. The
  // array is joined with spaces, so each line carries its own semicolon.
  ...windowsPowerShellEncodingLines().map((line) => `${line};`),
  "$ErrorActionPreference = 'Stop';",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "$commandLine = $_.CommandLine;",
  "$isDsh = ($null -ne $commandLine) -and ($commandLine -match '(?i)dsh');",
  "[PSCustomObject]@{",
  "ProcessId = $_.ProcessId;",
  "ParentProcessId = $_.ParentProcessId;",
  "Name = $_.Name;",
  "CommandLine = $(if ($isDsh) { $commandLine } else { $null });",
  "ExecutablePath = $(if ($isDsh) { $_.ExecutablePath } else { $null });",
  "}",
  "} | ConvertTo-Json -Compress",
].join(" ");

export interface DshWindowsProcessSnapshot {
  /** Verified dsh-runtime processes with full command lines. */
  readonly processes: DshProcessInfo[];
  /** pid → {ppid, name} for every process on the machine (Name only). */
  readonly tree: ReadonlyMap<number, { ppid: number; name: string }>;
}

export function parseWindowsProcessSnapshot(output: string): DshWindowsProcessSnapshot {
  const parsed = JSON.parse(output) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const tree = new Map<number, { ppid: number; name: string }>();
  const processes: DshProcessInfo[] = [];
  for (const item of items) {
    const record = item as {
      ProcessId?: unknown;
      ParentProcessId?: unknown;
      Name?: unknown;
      CommandLine?: unknown;
      ExecutablePath?: unknown;
    };
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
    const name = asTrimmedString(record.Name);
    tree.set(pid, { ppid, name });
    const command = asTrimmedString(record.CommandLine);
    if (!command) continue;
    const executable = asTrimmedString(record.ExecutablePath);
    const info: DshProcessInfo = {
      pid,
      ppid,
      command,
      port: parsePort(command),
      ...(executable ? { executable } : {}),
    };
    if (isDshRuntimeProcess(info)) processes.push(info);
  }
  return { processes, tree };
}

function emptyWindowsSnapshot(): DshWindowsProcessSnapshot {
  return { processes: [], tree: new Map() };
}

async function runWindowsSnapshotScript(
  run: typeof runProcess,
  timeoutMs: number,
) {
  return run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
    { timeoutMs },
  );
}

/** Best-effort snapshot: any failure degrades to an empty snapshot. */
async function windowsProcessSnapshot(run: typeof runProcess): Promise<DshWindowsProcessSnapshot> {
  const result = await runWindowsSnapshotScript(run, 8000);
  if (result.code !== 0 || !result.stdout.trim()) return emptyWindowsSnapshot();
  try {
    return parseWindowsProcessSnapshot(result.stdout);
  } catch {
    return emptyWindowsSnapshot();
  }
}

/**
 * Fail-closed snapshot for pre-mutation drains: never silently downgrade to
 * "no processes"; a timeout becomes an actionable localized error.
 */
async function windowsDshProcessesStrict(run: typeof runProcess): Promise<DshProcessInfo[]> {
  const result = await runWindowsSnapshotScript(run, WINDOWS_STRICT_ENUMERATION_TIMEOUT_MS);
  if (result.code !== 0) {
    if (result.timedOut) {
      throw new Error(t("枚举 Windows 进程超时：系统 WMI 响应异常缓慢。请以管理员身份执行 Restart-Service Winmgmt（或重启电脑）修复 WMI 后重试。"));
    }
    throw new Error(result.stderr || result.stdout || "Windows DSH process enumeration failed.");
  }
  if (!result.stdout.trim()) return [];
  return parseWindowsProcessSnapshot(result.stdout).processes;
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

export interface WindowsTcpEstablishedRow {
  readonly localPort: number;
  readonly remotePort: number;
  readonly pid: number;
}

export interface WindowsTcpTable {
  /** LISTENING local port → owning pid (first row wins). */
  readonly listeners: ReadonlyMap<number, number>;
  readonly established: readonly WindowsTcpEstablishedRow[];
}

function parseNetstatAddress(token: string): { port: number } | null {
  const separator = token.lastIndexOf(":");
  if (separator < 0) return null;
  const port = Number(token.slice(separator + 1));
  return Number.isInteger(port) && port >= 0 && port < 65536 ? { port } : null;
}

/**
 * Parse `netstat -ano -p tcp` output. Column headers are localized but the
 * row shape is positional and state tokens (LISTENING/ESTABLISHED) are never
 * localized, so columns are read from the end. Returns null when no TCP row
 * parses, so callers can fall back to the CIM NetTCPConnection cmdlets.
 */
export function parseNetstatTcpTable(output: string): WindowsTcpTable | null {
  const listeners = new Map<number, number>();
  const established: WindowsTcpEstablishedRow[] = [];
  let rows = 0;
  for (const line of output.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 5) continue;
    if (tokens[0].toUpperCase() !== "TCP") continue;
    const pid = Number(tokens[tokens.length - 1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const state = tokens[tokens.length - 2].toUpperCase();
    const local = parseNetstatAddress(tokens[1]);
    const remote = parseNetstatAddress(tokens[2]);
    if (!local || !remote) continue;
    rows += 1;
    if (state === "LISTENING") {
      if (!listeners.has(local.port)) listeners.set(local.port, pid);
    } else if (state === "ESTABLISHED") {
      established.push({ localPort: local.port, remotePort: remote.port, pid });
    }
  }
  return rows > 0 ? { listeners, established } : null;
}

/**
 * netstat reads the kernel TCP table through iphlpapi, not WMI, so it stays
 * fast even on machines whose WMI service is degraded (where every
 * Get-NetTCPConnection call costs 100s+). Shared by process discovery and the
 * bridge-status probe; cached briefly and keyed by the runner identity so
 * tests injecting fake runners never see each other's tables.
 */
let tcpTableSlot: {
  readonly run: typeof runProcess;
  readonly at: number;
  readonly promise: Promise<WindowsTcpTable | null>;
} | null = null;

export async function windowsTcpTable(
  run: typeof runProcess = runProcess,
): Promise<WindowsTcpTable | null> {
  const now = Date.now();
  if (
    tcpTableSlot
    && tcpTableSlot.run === run
    && now - tcpTableSlot.at < WINDOWS_TCP_TABLE_TTL_MS
  ) {
    return tcpTableSlot.promise;
  }
  const promise = (async () => {
    const result = await run("netstat", ["-ano", "-p", "tcp"], { timeoutMs: 8000 });
    if (result.code !== 0) return null;
    return parseNetstatTcpTable(result.stdout);
  })();
  tcpTableSlot = { run, at: now, promise };
  return promise;
}

async function windowsListenerPid(port: number, run = runProcess): Promise<number | null> {
  const table = await windowsTcpTable(run);
  if (table) return table.listeners.get(port) ?? null;
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
    // One WMI snapshot serves every read within the TTL window (and concurrent
    // callers share the in-flight query): the DSH list, ancestry walks, and
    // single-pid lookups. Previously each of those spawned its own
    // PowerShell+CIM query, which multiplied minutes on slow Windows machines.
    let snapshotCache: {
      readonly at: number;
      readonly promise: Promise<DshWindowsProcessSnapshot>;
    } | null = null;
    const snapshot = (): Promise<DshWindowsProcessSnapshot> => {
      const now = Date.now();
      if (snapshotCache && now - snapshotCache.at < WINDOWS_SNAPSHOT_CACHE_TTL_MS) {
        return snapshotCache.promise;
      }
      const promise = windowsProcessSnapshot(run);
      snapshotCache = { at: now, promise };
      return promise;
    };
    return {
      listDshProcesses: async () => (await snapshot()).processes,
      listDshProcessesStrict: () => windowsDshProcessesStrict(run),
      processInfo: async (pid) => {
        const snap = await snapshot();
        const detailed = snap.processes.find((process) => process.pid === pid);
        if (detailed) return detailed;
        const node = snap.tree.get(pid);
        // Tree rows carry only the image name, which is all the ancestry walk
        // needs (it matches /obsidian/i); the port stays unknown. Consumers
        // matching command lines against a runtime identity must not treat
        // this as evidence — hence the nameOnly marker.
        if (node) return { pid, ppid: node.ppid, command: node.name, port: null, nameOnly: true };
        return windowsProcessInfo(pid, run);
      },
      processCwd: async () => null,
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
    processCwd: (pid) => unixProcessCwd(pid, platform, run),
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
