import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dshWebSupportsNoOpen } from "../../../../mv-dsh-compat/lib/obsidian.js";
import { processOutput, runProcess } from "../../../process-runner";
import { dshVaultDirectory } from "../paths";
import type { DshCommand } from "./process";

/**
 * Persisted probe of a dsh binary's `web --no-open` support. The flag first
 * shipped in dsh v0.1.0-rc.8; the probe result is stable for a given binary,
 * so it is cached by command identity plus entry-script mtime — an upgrade
 * rewrites the entry and re-probes automatically. A failed probe is never
 * persisted and resolves to `true` (the established behavior for every
 * runtime whose capability is unknown).
 */
interface WebLaunchCapabilityRecord {
  schema: 1;
  entryStamp: string;
  noOpen: boolean;
  probedAt: number;
}

type WebLaunchCapabilityCache = Record<string, WebLaunchCapabilityRecord>;

function normalized(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : value;
}

function capabilityIdentityKey(command: DshCommand): string {
  const identity = {
    executable: normalized(command.executable),
    argsPrefix: command.argsPrefix.map(normalized),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** mtime:size of every absolute entry script behind the command ("-" when unreadable). */
async function entryStamp(command: DshCommand): Promise<string> {
  const entries = [
    command.executable,
    ...command.argsPrefix,
  ].filter((value) => path.isAbsolute(value));
  const stamps = await Promise.all(entries.map(async (entry) => {
    const stat = await fs.stat(entry).catch(() => null);
    return stat ? `${Math.round(stat.mtimeMs)}:${stat.size}` : "-";
  }));
  return stamps.join("|");
}

function cacheFile(vaultRoot: string): string {
  return path.join(dshVaultDirectory(vaultRoot), "web-launch-capabilities.json");
}

async function readCache(file: string): Promise<WebLaunchCapabilityCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, WebLaunchCapabilityRecord] => {
        const record = entry[1] as WebLaunchCapabilityRecord | null;
        return Boolean(record)
          && record?.schema === 1
          && typeof record.entryStamp === "string"
          && typeof record.noOpen === "boolean"
          && typeof record.probedAt === "number";
      });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

async function probeNoOpenSupport(
  command: DshCommand,
  runner: typeof runProcess,
): Promise<boolean | null> {
  const result = await runner(
    command.executable,
    [...command.argsPrefix, "web", "--help"],
    { timeoutMs: 10_000, env: command.env, cwd: command.cwd },
  ).catch(() => null);
  if (!result || result.code !== 0) return null;
  return dshWebSupportsNoOpen(processOutput(result));
}

/**
 * In-flight resolutions shared by concurrent callers (environment inspection
 * warming the cache while a launch needs the answer): one probe per cache
 * key, never two boots of the same dsh CLI.
 */
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Resolve whether `command`'s dsh web accepts `--no-open`, reading the
 * persisted probe when the binary is unchanged and probing `web --help`
 * otherwise. Probe failures return `true` without being written back.
 */
export async function resolveWebNoOpenCapability(
  vaultRoot: string,
  command: DshCommand,
  runner: typeof runProcess = runProcess,
): Promise<boolean> {
  const file = cacheFile(vaultRoot);
  const key = capabilityIdentityKey(command);
  const stamp = await entryStamp(command);
  const cached = (await readCache(file))[key];
  if (cached && cached.entryStamp === stamp) return cached.noOpen;
  const flightKey = `${file}:${key}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;
  const resolution = (async () => {
    const probed = await probeNoOpenSupport(command, runner);
    if (probed === null) return true;
    const cache = await readCache(file);
    cache[key] = { schema: 1, entryStamp: stamp, noOpen: probed, probedAt: Date.now() };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, "utf8");
      await fs.rename(temporary, file);
    } catch {
      // A cache-write failure only costs one re-probe next launch; never block it.
    }
    return probed;
  })();
  inFlight.set(flightKey, resolution);
  try {
    return await resolution;
  } finally {
    if (inFlight.get(flightKey) === resolution) inFlight.delete(flightKey);
  }
}
