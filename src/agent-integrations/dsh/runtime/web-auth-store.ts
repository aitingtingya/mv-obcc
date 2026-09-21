import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dshWebAuthDirectory } from "../../../storage/system-paths";
import { dshRuntimeIdentityKey } from "./runtime-owner";
import type { DshCommand } from "./process";

interface SafeStorageLike {
  isEncryptionAvailable?(): boolean;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptString?(value: string): Buffer;
  decryptString?(value: Buffer): string;
  encryptStringAsync?(value: string): Promise<Buffer>;
  decryptStringAsync?(value: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>;
  getSelectedStorageBackend?(): string;
}

interface EncryptedEnvelope { schema: 1; encrypted: string }
interface StoredCredential {
  schema: 1;
  /**
   * Diagnostics only. The runtime identity that wrote the record used to be
   * part of the storage key, which made a session unreadable as soon as the
   * selected DSH command changed (vault runtime ↔ global shim, executable or
   * home moved by an upgrade). DSH itself binds its browser session to the
   * endpoint authority, so the endpoint is the only key that matters.
   */
  identityKey: string;
  origin: string;
  cookie: string;
  expiresAt: number;
}

export interface DshWebCredential { cookie: string; expiresAt: number }
export interface DshWebAuthStore {
  load(command: DshCommand, origin: string): Promise<DshWebCredential | null>;
  save(command: DshCommand, origin: string, credential: DshWebCredential): Promise<void>;
  remove(command: DshCommand, origin: string): Promise<void>;
  /**
   * Endpoints this vault holds a stored session for — the instances it opened
   * before, including ones started in an earlier Obsidian session. Reconnect
   * uses it to recognize its own DSH instead of starting another one.
   */
  endpoints(): Promise<string[]>;
}

export class DshWebAuthUnavailableError extends Error {
  constructor() {
    super("系统安全存储不可用，DSH 登录态仅在本次 Obsidian 运行期间有效。");
    this.name = "DshWebAuthUnavailableError";
  }
}

function safeStorageFromElectron(): SafeStorageLike | null {
  // This module is created by the plugin execution realm. Do not consult the
  // currently focused popout window: sandboxed windows intentionally lack
  // require(), while the main plugin realm remains the trusted authority.
  const privilegedWindow = window as Window & { require?: (name: string) => unknown };
  if (typeof privilegedWindow.require !== "function") return null;
  try {
    const remote = privilegedWindow.require("@electron/remote") as {
      require?: (name: string) => { safeStorage?: SafeStorageLike };
    };
    const storage = remote.require?.("electron")?.safeStorage;
    if (storage) return storage;
  } catch {
    /* Try the renderer-exported module below. */
  }
  try {
    return (privilegedWindow.require("electron") as { safeStorage?: SafeStorageLike }).safeStorage ?? null;
  } catch {
    return null;
  }
}

function normalizedOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]")) {
    throw new Error("DSH 登录态只允许绑定本机 HTTP 端点。");
  }
  return parsed.origin;
}

/** Endpoint-keyed record file: one browser session per DSH endpoint. */
function credentialFile(origin: string, root: string): string {
  return path.join(root, `${createHash("sha256").update(origin).digest("hex")}.json`);
}

/** Pre-endpoint key: `sha256(identityKey + NUL + origin)`. Kept for migration. */
function legacyCredentialFile(command: DshCommand, origin: string, root: string): string {
  const identityKey = dshRuntimeIdentityKey(command);
  return path.join(root, `${createHash("sha256").update(`${identityKey}\0${origin}`).digest("hex")}.json`);
}

function usableCredential(value: unknown): value is StoredCredential {
  const item = value as Partial<StoredCredential> | null;
  return item?.schema === 1
    && typeof item.origin === "string"
    && typeof item.cookie === "string"
    && item.cookie.length > 2
    && item.cookie.length <= 16_384
    && !/[\r\n;]/u.test(item.cookie)
    && item.cookie.includes("=")
    && typeof item.expiresAt === "number"
    && Number.isSafeInteger(item.expiresAt)
    && item.expiresAt > Date.now();
}

async function available(storage: SafeStorageLike | null): Promise<boolean> {
  if (!storage) return false;
  try {
    if (process.platform === "linux" && storage.getSelectedStorageBackend?.() === "basic_text") return false;
    if (storage.isAsyncEncryptionAvailable) return storage.isAsyncEncryptionAvailable();
    return storage.isEncryptionAvailable?.() === true;
  } catch {
    return false;
  }
}

async function encrypt(storage: SafeStorageLike, value: string): Promise<Buffer> {
  if (storage.encryptStringAsync) return storage.encryptStringAsync(value);
  if (storage.encryptString) return storage.encryptString(value);
  throw new DshWebAuthUnavailableError();
}

async function decrypt(storage: SafeStorageLike, value: Buffer): Promise<string> {
  if (storage.decryptStringAsync) return (await storage.decryptStringAsync(value)).result;
  if (storage.decryptString) return storage.decryptString(value);
  throw new DshWebAuthUnavailableError();
}

async function writeCredential(
  file: string,
  storage: SafeStorageLike,
  payload: StoredCredential,
): Promise<void> {
  const encrypted = await encrypt(storage, JSON.stringify(payload));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ schema: 1, encrypted: encrypted.toString("base64") } satisfies EncryptedEnvelope)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Read one record file; null when it is unreadable, malformed, or expired. */
async function readCredential(
  file: string,
  storage: SafeStorageLike,
): Promise<StoredCredential | null> {
  try {
    const envelope = JSON.parse(await fs.readFile(file, "utf8")) as Partial<EncryptedEnvelope>;
    if (envelope.schema !== 1 || typeof envelope.encrypted !== "string") throw new Error("invalid envelope");
    const parsed = JSON.parse(await decrypt(storage, Buffer.from(envelope.encrypted, "base64"))) as unknown;
    return usableCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every usable record under the store root, pruning the files that no longer
 * decrypt or have expired so the directory cannot grow without bound.
 */
async function scanCredentials(
  root: string,
  storage: SafeStorageLike,
): Promise<Array<{ file: string; credential: StoredCredential }>> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const found: Array<{ file: string; credential: StoredCredential }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    const credential = await readCredential(file, storage);
    if (credential) found.push({ file, credential });
    else await fs.rm(file, { force: true }).catch(() => undefined);
  }
  return found;
}

export function createDshWebAuthStore(
  storageProvider: () => SafeStorageLike | null = safeStorageFromElectron,
  root = dshWebAuthDirectory(),
): DshWebAuthStore {
  return {
    async load(command, origin) {
      const normalized = normalizedOrigin(origin);
      const storage = storageProvider();
      if (!await available(storage)) throw new DshWebAuthUnavailableError();
      const primary = credentialFile(normalized, root);
      const direct = await readCredential(primary, storage!);
      if (direct) return { cookie: direct.cookie, expiresAt: direct.expiresAt };
      // Fallback scan: records written under the old identity-keyed name, or by
      // a different command identity for the same endpoint. A match is moved to
      // the endpoint key so the next reload reads it directly.
      for (const entry of await scanCredentials(root, storage!)) {
        if (entry.credential.origin !== normalized) continue;
        if (entry.file !== primary) {
          try {
            await writeCredential(primary, storage!, entry.credential);
            await fs.rm(entry.file, { force: true }).catch(() => undefined);
          } catch {
            /* keep serving from the file we already read */
          }
        }
        return { cookie: entry.credential.cookie, expiresAt: entry.credential.expiresAt };
      }
      return null;
    },
    async save(command, origin, credential) {
      const normalized = normalizedOrigin(origin);
      const storage = storageProvider();
      if (!await available(storage)) throw new DshWebAuthUnavailableError();
      const payload: StoredCredential = {
        schema: 1,
        identityKey: dshRuntimeIdentityKey(command),
        origin: normalized,
        ...credential,
      };
      if (!usableCredential(payload)) throw new Error("DSH 登录态无效或已经过期。");
      await writeCredential(credentialFile(normalized, root), storage!, payload);
      // Drop the legacy twin so one session is not stored twice.
      await fs.rm(legacyCredentialFile(command, normalized, root), { force: true }).catch(() => undefined);
    },
    async remove(command, origin) {
      const normalized = normalizedOrigin(origin);
      await fs.rm(credentialFile(normalized, root), { force: true }).catch(() => undefined);
      await fs.rm(legacyCredentialFile(command, normalized, root), { force: true }).catch(() => undefined);
    },
    async endpoints() {
      const storage = storageProvider();
      if (!await available(storage)) return [];
      const origins = new Set<string>();
      for (const entry of await scanCredentials(root, storage!)) {
        origins.add(entry.credential.origin);
      }
      return [...origins];
    },
  };
}
