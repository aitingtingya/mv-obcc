import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DshCommand } from "./process";
import { resolveDshHomeDirectory } from "../paths";

interface RuntimeOwnerRecord {
  schema: 1;
  pid: number;
  /**
   * The process actually listening on the dsh web port, recorded once the
   * launch becomes ready. Differs from `pid` when the spawn chain is wrapped
   * (Windows .cmd shims run through PowerShell, so the child is the shell,
   * not the node listener). Optional for backward compatibility with records
   * written before this field existed.
   */
  listenerPid?: number;
  port: number;
  identityKey: string;
  createdAt: number;
}

function normalized(value: string | undefined): string {
  return value ? path.resolve(value) : "";
}

export function dshRuntimeIdentityKey(command: DshCommand): string {
  const identity = {
    executable: normalized(command.executable),
    argsPrefix: command.argsPrefix.map((argument) => path.isAbsolute(argument) ? path.resolve(argument) : argument),
    cwd: normalized(command.cwd),
    homeDirectory: normalized(resolveDshHomeDirectory(command.homeDirectory, command.env)),
    sourceRoot: normalized(command.sourceRoot),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function ownerDirectory(command: DshCommand): string | null {
  const home = resolveDshHomeDirectory(command.homeDirectory, command.env);
  return path.join(home, ".mv-aide", "runtime-owners");
}

function ownerPath(command: DshCommand, port: number): string | null {
  const directory = ownerDirectory(command);
  return directory ? path.join(directory, `${port}.json`) : null;
}

export async function writeDshRuntimeOwner(
  command: DshCommand,
  pid: number,
  port: number,
  listenerPid?: number,
): Promise<void> {
  const target = ownerPath(command, port);
  if (!target) throw new Error("DSH runtime ownership requires an explicit home directory.");
  const record: RuntimeOwnerRecord = {
    schema: 1,
    pid,
    ...(Number.isInteger(listenerPid) && listenerPid! > 0 ? { listenerPid } : {}),
    port,
    identityKey: dshRuntimeIdentityKey(command),
    createdAt: Date.now(),
  };
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readMatchingDshRuntimeOwner(
  command: DshCommand,
  port: number,
): Promise<RuntimeOwnerRecord | null> {
  const target = ownerPath(command, port);
  if (!target) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as Partial<RuntimeOwnerRecord>;
    if (
      parsed.schema !== 1
      || !Number.isInteger(parsed.pid)
      || parsed.pid! <= 0
      || parsed.port !== port
      || parsed.identityKey !== dshRuntimeIdentityKey(command)
      || typeof parsed.createdAt !== "number"
      || (parsed.listenerPid !== undefined
        && (!Number.isInteger(parsed.listenerPid) || parsed.listenerPid <= 0))
    ) return null;
    return parsed as RuntimeOwnerRecord;
  } catch {
    return null;
  }
}

export async function removeDshRuntimeOwner(
  command: DshCommand,
  port: number,
  pid?: number,
): Promise<void> {
  const target = ownerPath(command, port);
  if (!target) return;
  if (pid !== undefined) {
    const current = await readMatchingDshRuntimeOwner(command, port);
    // A pid-scoped removal matches either the spawned child pid or the real
    // listener pid recorded at readiness — both identify the same instance.
    if (!current || (current.pid !== pid && current.listenerPid !== pid)) return;
  }
  await fs.rm(target, { force: true }).catch(() => undefined);
}
