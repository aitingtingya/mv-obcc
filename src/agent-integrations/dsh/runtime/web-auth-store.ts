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

function binding(command: DshCommand, origin: string, root: string): { identityKey: string; origin: string; file: string } {
  const identityKey = dshRuntimeIdentityKey(command);
  const normalized = normalizedOrigin(origin);
  const file = `${createHash("sha256").update(`${identityKey}\0${normalized}`).digest("hex")}.json`;
  return { identityKey, origin: normalized, file: path.join(root, file) };
}

function validCredential(value: unknown, expected: ReturnType<typeof binding>): value is StoredCredential {
  const item = value as Partial<StoredCredential> | null;
  return item?.schema === 1
    && item.identityKey === expected.identityKey
    && item.origin === expected.origin
    && typeof item.cookie === "string"
    && item.cookie.length > 2
    && item.cookie.length <= 16_384
    && !/[\r\n;]/u.test(item.cookie)
    && item.cookie.includes("=")
    && typeof item.expiresAt === "number"
    && Number.isSafeInteger(item.expiresAt);
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

export function createDshWebAuthStore(
  storageProvider: () => SafeStorageLike | null = safeStorageFromElectron,
  root = dshWebAuthDirectory(),
): DshWebAuthStore {
  return {
    async load(command, origin) {
      const target = binding(command, origin, root);
      const storage = storageProvider();
      if (!await available(storage)) throw new DshWebAuthUnavailableError();
      try {
        const envelope = JSON.parse(await fs.readFile(target.file, "utf8")) as Partial<EncryptedEnvelope>;
        if (envelope.schema !== 1 || typeof envelope.encrypted !== "string") throw new Error("invalid envelope");
        const parsed = JSON.parse(await decrypt(storage!, Buffer.from(envelope.encrypted, "base64"))) as unknown;
        if (!validCredential(parsed, target) || parsed.expiresAt <= Date.now()) {
          await fs.rm(target.file, { force: true });
          return null;
        }
        return { cookie: parsed.cookie, expiresAt: parsed.expiresAt };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") await fs.rm(target.file, { force: true }).catch(() => undefined);
        return null;
      }
    },
    async save(command, origin, credential) {
      const target = binding(command, origin, root);
      const storage = storageProvider();
      if (!await available(storage)) throw new DshWebAuthUnavailableError();
      const payload: StoredCredential = { schema: 1, identityKey: target.identityKey, origin: target.origin, ...credential };
      if (!validCredential(payload, target) || payload.expiresAt <= Date.now()) throw new Error("DSH 登录态无效或已经过期。");
      const encrypted = await encrypt(storage!, JSON.stringify(payload));
      const temporary = `${target.file}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(target.file), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(target.file), 0o700);
      try {
        await fs.writeFile(temporary, `${JSON.stringify({ schema: 1, encrypted: encrypted.toString("base64") } satisfies EncryptedEnvelope)}\n`, { mode: 0o600 });
        await fs.rename(temporary, target.file);
        await fs.chmod(target.file, 0o600);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async remove(command, origin) {
      await fs.rm(binding(command, origin, root).file, { force: true }).catch(() => undefined);
    },
  };
}
