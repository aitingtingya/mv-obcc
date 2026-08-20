import { runProcess } from "../../../process-runner";
import {
  createDefaultDshProcessDiscoveryAdapter,
  type DshProcessDiscoveryAdapter,
  type DshProcessInfo,
} from "../runtime/process-discovery";
import { dshWebUrl, probeDshWeb, type DshWebProbeFn } from "../runtime/process";

export interface DshBridgeStatusRequest {
  dshPort: number;
  bridgePort: number;
  dshUrl?: string | null;
}

export interface DshBridgeStatusDependencies {
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
  discovery?: DshProcessDiscoveryAdapter;
  probe?: DshWebProbeFn;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function parsePidLines(output: string): number[] {
  const result = new Set<number>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(?:p)?(\d{1,10})\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) result.add(pid);
  }
  return [...result];
}

export function parseLsofEstablishedPids(output: string): number[] {
  const result = new Set<number>();
  for (const match of output.matchAll(/^p(\d{1,10})\s*$/gmu)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) result.add(pid);
  }
  return [...result];
}

export function parseSsEstablishedPids(output: string, bridgePort: number): number[] {
  const result = new Set<number>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes(`:${bridgePort}`)) continue;
    for (const match of line.matchAll(/pid=(\d{1,10})/gu)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) result.add(pid);
    }
  }
  return [...result];
}

async function unixEstablishedPids(
  bridgePort: number,
  platform: NodeJS.Platform,
  run: typeof runProcess,
): Promise<number[]> {
  const lsof = await run(
    "lsof",
    ["-nP", `-iTCP:${bridgePort}`, "-sTCP:ESTABLISHED", "-Fp"],
    { timeoutMs: 5000 },
  );
  if (lsof.code === 0) return parseLsofEstablishedPids(lsof.stdout);
  if (platform !== "linux") return [];

  const ss = await run("ss", ["-tnp", "state", "established"], { timeoutMs: 5000 });
  return ss.code === 0 ? parseSsEstablishedPids(ss.stdout, bridgePort) : [];
}

async function windowsEstablishedPids(
  bridgePort: number,
  run: typeof runProcess,
): Promise<number[]> {
  const script = [
    `Get-NetTCPConnection -State Established | Where-Object { $_.LocalPort -eq ${bridgePort} -or $_.RemotePort -eq ${bridgePort} }`,
    "| Select-Object -ExpandProperty OwningProcess",
  ].join(" ");
  const result = await run(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 8000 },
  );
  return result.code === 0 ? parsePidLines(result.stdout) : [];
}

async function establishedBridgePids(
  bridgePort: number,
  platform: NodeJS.Platform,
  run: typeof runProcess,
): Promise<number[]> {
  return platform === "win32"
    ? windowsEstablishedPids(bridgePort, run)
    : unixEstablishedPids(bridgePort, platform, run);
}

async function isDescendantOrSelf(
  discovery: DshProcessDiscoveryAdapter,
  pid: number,
  ancestorPid: number,
): Promise<boolean> {
  if (pid === ancestorPid) return true;
  let current = pid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 64; depth += 1) {
    if (current <= 0 || seen.has(current)) return false;
    seen.add(current);
    const info = await discovery.processInfo(current);
    if (!info) return false;
    if (info.ppid === ancestorPid) return true;
    if (info.ppid <= 0 || info.ppid === current) return false;
    current = info.ppid;
  }
  return false;
}

async function dshRootsForPort(
  discovery: DshProcessDiscoveryAdapter,
  dshPort: number,
  listenerPid: number,
): Promise<DshProcessInfo[]> {
  const processes = await discovery.listDshProcesses();
  const roots = processes.filter(
    (info) => info.pid === listenerPid || info.port === dshPort,
  );
  if (roots.length === 0) return [];
  const verified: DshProcessInfo[] = [];
  for (const root of roots) {
    if (await isDescendantOrSelf(discovery, listenerPid, root.pid)) verified.push(root);
  }
  return verified;
}

/**
 * True only when a real DSH web process has an ESTABLISHED TCP connection to
 * the current Obsidian IDE Bridge port. No IDE Bridge messages, handshake
 * fields, or client identities are inspected or changed.
 */
export async function isDshConnectedToBridge(
  request: DshBridgeStatusRequest,
  dependencies: DshBridgeStatusDependencies = {},
): Promise<boolean> {
  const { dshPort, bridgePort } = request;
  if (!validPort(dshPort) || !validPort(bridgePort)) return false;

  const platform = dependencies.platform ?? process.platform;
  const run = dependencies.run ?? runProcess;
  const discovery = dependencies.discovery ??
    createDefaultDshProcessDiscoveryAdapter(platform, run);
  const probe = dependencies.probe ?? probeDshWeb;
  const endpoint = request.dshUrl || dshWebUrl(dshPort);

  const web = await probe(endpoint, 1500);
  if (!web.reachable || !web.isDsh) return false;

  const listenerPid = await discovery.listenerPid(dshPort);
  if (!listenerPid) return false;
  const roots = await dshRootsForPort(discovery, dshPort, listenerPid);
  if (roots.length === 0) return false;

  const connectedPids = await establishedBridgePids(bridgePort, platform, run);
  for (const connectedPid of connectedPids) {
    for (const root of roots) {
      if (await isDescendantOrSelf(discovery, connectedPid, root.pid)) return true;
    }
  }
  return false;
}
