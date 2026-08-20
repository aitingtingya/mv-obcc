import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { App, EventRef, WorkspaceLeaf } from "obsidian";
import type {
  ExternalFileEphemeralAdapter,
  ExternalFileEphemeralLease,
} from "./external-file-ephemeral-adapter";
import { EXTERNAL_PDF_EPHEMERAL_FOLDER } from "./storage/vault-paths";

export const WINDOWS_PDF_EPHEMERAL_VAULT_FOLDER = EXTERNAL_PDF_EPHEMERAL_FOLDER;

const SESSION_PATTERN = /^p(\d+)-[0-9a-f-]{16,}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PART_MARKER = ".mv-aide-part-";
const DEFAULT_DELETE_RETRY_DELAYS_MS = [0, 100, 300, 750, 1500, 3000] as const;

interface WindowsPdfEphemeralMirrorOptions {
  app: App;
  getVaultRoot: () => string;
  platform?: NodeJS.Platform;
  sessionId?: () => string;
  linkFile?: (source: string, destination: string) => Promise<void>;
  unlinkFile?: (filePath: string) => void;
  processExists?: (pid: number) => boolean;
  deleteRetryDelaysMs?: readonly number[];
}

type MaterializationKind = "hardlink" | "copy" | "adopted";

type EntryState = "prepared" | "opened" | "deleting";

interface PdfEphemeralEntry {
  externalIdentity: string | null;
  vaultPath: string;
  absolutePath: string;
  sessionDirectory: string;
  state: EntryState;
  materialization: MaterializationKind;
  pendingLeases: number;
  committed: boolean;
  everObserved: boolean;
  deleteGeneration: number;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function isPdfPath(filePath: string): boolean {
  return path.posix.extname(filePath.replace(/\\/gu, "/")).toLowerCase() === ".pdf";
}

function externalPathIdentity(
  filePath: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    return path.win32.normalize(filePath).toLowerCase();
  }
  return path.normalize(filePath);
}

function pathHash(identity: string): string {
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function safePdfBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, "/");
  const raw = normalized.split("/").filter(Boolean).pop() || "external.pdf";
  const safe = raw
    .replace(/[<>:"|?*]/gu, "_")
    .split("")
    .map((character) => character.charCodeAt(0) < 32 ? "_" : character)
    .join("");
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

function normalizeVaultPath(vaultPath: string): string {
  return vaultPath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

function defaultProcessExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function shouldFallbackToCopy(error: unknown): boolean {
  const code = errorCode(error);
  return !["ENOENT", "ENOTDIR", "EISDIR", "EEXIST"].includes(code ?? "");
}

function isRetryableDeleteError(error: unknown): boolean {
  return ["EPERM", "EBUSY", "EACCES"].includes(errorCode(error) ?? "");
}

function leafVaultPath(leaf: WorkspaceLeaf): string | null {
  const viewFile = (leaf.view as unknown as { file?: { path?: string } | null })?.file;
  if (typeof viewFile?.path === "string" && viewFile.path) {
    return normalizeVaultPath(viewFile.path);
  }
  const stateFile = (
    leaf.getViewState?.() as { state?: { file?: string } } | undefined
  )?.state?.file;
  return typeof stateFile === "string" && stateFile
    ? normalizeVaultPath(stateFile)
    : null;
}

export class WindowsPdfEphemeralMirror implements ExternalFileEphemeralAdapter {
  private readonly platform: NodeJS.Platform;
  private readonly sessionId: string;
  private readonly linkFile: (source: string, destination: string) => Promise<void>;
  private readonly unlinkFile: (filePath: string) => void;
  private readonly processExists: (pid: number) => boolean;
  private readonly deleteRetryDelaysMs: readonly number[];
  private readonly entriesByVaultPath = new Map<string, PdfEphemeralEntry>();
  private readonly entriesByExternalIdentity = new Map<string, PdfEphemeralEntry>();
  private readonly preparing = new Map<string, Promise<PdfEphemeralEntry>>();
  private layoutChangeRef: EventRef | null = null;
  private initialized: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: WindowsPdfEphemeralMirrorOptions) {
    this.platform = options.platform ?? process.platform;
    this.sessionId = options.sessionId?.() ?? `p${process.pid}-${crypto.randomUUID()}`;
    this.linkFile = options.linkFile ?? ((source, destination) =>
      fs.promises.link(source, destination));
    this.unlinkFile = options.unlinkFile ?? ((filePath) => fs.unlinkSync(filePath));
    this.processExists = options.processExists ?? defaultProcessExists;
    this.deleteRetryDelaysMs = options.deleteRetryDelaysMs ??
      DEFAULT_DELETE_RETRY_DELAYS_MS;

    if (this.platform !== "win32") return;
    const workspace = this.options.app.workspace;
    this.layoutChangeRef = workspace.on("layout-change", () => {
      this.reconcileOpenEntriesBestEffort();
    });
    workspace.onLayoutReady(() => {
      void this.ensureInitialized();
    });
  }

  async prepare(externalPath: string): Promise<ExternalFileEphemeralLease | null> {
    if (
      this.disposed ||
      this.platform !== "win32" ||
      !isPdfPath(externalPath)
    ) {
      return null;
    }

    await this.ensureInitialized();
    if (this.disposed) return null;

    const identity = externalPathIdentity(externalPath, this.platform);
    const hash = pathHash(identity);
    let entry = this.reusableEntry(identity);
    if (!entry) {
      let pending = this.preparing.get(identity);
      if (!pending) {
        pending = this.materialize(externalPath, identity, hash);
        this.preparing.set(identity, pending);
      }
      try {
        entry = await pending;
      } finally {
        if (this.preparing.get(identity) === pending) {
          this.preparing.delete(identity);
        }
      }
    }

    entry.deleteGeneration++;
    if (entry.state === "deleting") {
      entry.state = entry.committed ? "opened" : "prepared";
    }
    entry.pendingLeases++;
    return this.createLease(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const workspace = this.options.app.workspace;
    if (this.layoutChangeRef) {
      workspace.offref(this.layoutChangeRef);
      this.layoutChangeRef = null;
    }

    for (const entry of [...this.entriesByVaultPath.values()]) {
      entry.deleteGeneration++;
      if (!entry.committed && !entry.everObserved) {
        try {
          this.deletePreparedEntryBestEffort(entry);
        } catch (error) {
          console.warn("[mv-aide] Failed to dispose a prepared Windows PDF mirror.", error);
        }
      }
    }
  }

  private createLease(entry: PdfEphemeralEntry): ExternalFileEphemeralLease {
    let settled = false;
    return {
      vaultPath: entry.vaultPath,
      commitOpened: () => {
        if (settled) return;
        settled = true;
        entry.pendingLeases = Math.max(0, entry.pendingLeases - 1);
        entry.committed = true;
        entry.state = "opened";
        try {
          if (this.openVaultPaths().has(entry.vaultPath)) {
            entry.everObserved = true;
          }
        } catch (error) {
          console.warn("[mv-aide] Failed to inspect Windows PDF leaf state.", error);
        }
        entry.deleteGeneration++;
        this.reconcileOpenEntriesBestEffort();
      },
      abort: async () => {
        if (settled) return;
        settled = true;
        entry.pendingLeases = Math.max(0, entry.pendingLeases - 1);
        if (entry.pendingLeases > 0) return;
        if (entry.committed) {
          if (
            entry.everObserved &&
            !this.openVaultPaths().has(entry.vaultPath)
          ) {
            await this.deleteEntryWithRetries(entry);
          }
          return;
        }
        await this.deleteEntryWithRetries(entry);
      },
    };
  }

  private reusableEntry(identity: string): PdfEphemeralEntry | null {
    const direct = this.entriesByExternalIdentity.get(identity);
    return direct && this.entryFileExists(direct) ? direct : null;
  }

  private async materialize(
    externalPath: string,
    identity: string,
    hash: string,
  ): Promise<PdfEphemeralEntry> {
    const { vaultRoot, rootDirectory } = this.paths();
    const sessionDirectory = path.join(rootDirectory, this.sessionId);
    const entryDirectory = path.join(sessionDirectory, hash);
    await fs.promises.mkdir(entryDirectory, { recursive: true });

    const sourcePath = fs.realpathSync.native(externalPath);
    const filename = safePdfBasename(externalPath);
    const absolutePath = path.join(entryDirectory, filename);
    const vaultPath = this.toVaultPath(vaultRoot, absolutePath);
    let materialization: MaterializationKind = "hardlink";
    let createdFinal = false;

    try {
      try {
        await this.linkFile(sourcePath, absolutePath);
        createdFinal = true;
      } catch (error) {
        if (!shouldFallbackToCopy(error)) throw error;
        materialization = "copy";
        await this.copyAtomically(sourcePath, absolutePath);
        createdFinal = true;
      }

      if (this.disposed) {
        if (createdFinal) fs.rmSync(absolutePath, { force: true });
        this.cleanupEmptyParents(entryDirectory, sessionDirectory, rootDirectory);
        throw new Error("Windows PDF ephemeral mirror was disposed during preparation.");
      }

      const entry: PdfEphemeralEntry = {
        externalIdentity: identity,
        vaultPath,
        absolutePath,
        sessionDirectory,
        state: "prepared",
        materialization,
        pendingLeases: 0,
        committed: false,
        everObserved: false,
        deleteGeneration: 0,
      };
      this.entriesByVaultPath.set(vaultPath, entry);
      this.entriesByExternalIdentity.set(identity, entry);
      return entry;
    } catch (error) {
      if (createdFinal) fs.rmSync(absolutePath, { force: true });
      this.cleanupEmptyParents(entryDirectory, sessionDirectory, rootDirectory);
      throw error;
    }
  }

  private async copyAtomically(source: string, destination: string): Promise<void> {
    const sourceBefore = await fs.promises.stat(source);
    if (!sourceBefore.isFile()) throw new Error("External PDF is no longer a file.");
    const temporary = `${destination}${PART_MARKER}${crypto.randomUUID()}`;
    try {
      await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      const [sourceAfter, copyStat] = await Promise.all([
        fs.promises.stat(source),
        fs.promises.stat(temporary),
      ]);
      if (
        sourceBefore.size !== sourceAfter.size ||
        sourceBefore.mtimeMs !== sourceAfter.mtimeMs ||
        copyStat.size !== sourceAfter.size
      ) {
        throw new Error("External PDF changed while its temporary mirror was being copied.");
      }
      await fs.promises.rename(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private ensureInitialized(): Promise<void> {
    if (this.platform !== "win32" || this.disposed) return Promise.resolve();
    if (!this.initialized) {
      this.initialized = this.initializeAfterLayout().catch((error) => {
        console.warn("[mv-aide] Windows PDF ephemeral mirror startup cleanup failed.", error);
      });
    }
    return this.initialized;
  }

  private async initializeAfterLayout(): Promise<void> {
    const { vaultRoot, rootDirectory } = this.paths();
    if (!fs.existsSync(rootDirectory)) return;
    const openPaths = this.openVaultPaths();

    for (const sessionName of fs.readdirSync(rootDirectory)) {
      if (this.disposed) return;
      const match = SESSION_PATTERN.exec(sessionName);
      if (!match) continue;
      const ownerPid = Number(match[1]);
      const sessionDirectory = path.join(rootDirectory, sessionName);
      let sessionStat: fs.Stats;
      try {
        sessionStat = fs.lstatSync(sessionDirectory);
      } catch {
        continue;
      }
      if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) continue;

      const foreignLiveSession = ownerPid !== process.pid && this.processExists(ownerPid);
      if (foreignLiveSession) continue;

      for (const hashName of fs.readdirSync(sessionDirectory)) {
        if (!HASH_PATTERN.test(hashName)) continue;
        const entryDirectory = path.join(sessionDirectory, hashName);
        let entryStat: fs.Stats;
        try {
          entryStat = fs.lstatSync(entryDirectory);
        } catch {
          continue;
        }
        if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;

        for (const filename of fs.readdirSync(entryDirectory)) {
          const absolutePath = path.join(entryDirectory, filename);
          if (filename.includes(PART_MARKER)) {
            fs.rmSync(absolutePath, { force: true });
            continue;
          }
          if (!filename.toLowerCase().endsWith(".pdf")) continue;
          let fileStat: fs.Stats;
          try {
            fileStat = fs.lstatSync(absolutePath);
          } catch {
            continue;
          }
          if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
          const vaultPath = this.toVaultPath(vaultRoot, absolutePath);
          if (!openPaths.has(vaultPath)) {
            fs.rmSync(absolutePath, { force: true });
            continue;
          }
          const adopted: PdfEphemeralEntry = {
            externalIdentity: null,
            vaultPath,
            absolutePath,
            sessionDirectory,
            state: "opened",
            materialization: "adopted",
            pendingLeases: 0,
            committed: true,
            everObserved: true,
            deleteGeneration: 0,
          };
          this.entriesByVaultPath.set(vaultPath, adopted);
        }
        this.removeDirectoryIfEmpty(entryDirectory);
      }
      this.removeDirectoryIfEmpty(sessionDirectory);
    }
    this.removeDirectoryIfEmpty(rootDirectory);
  }

  private reconcileOpenEntriesBestEffort(): void {
    void this.reconcileOpenEntries().catch((error) => {
      console.warn("[mv-aide] Windows PDF ephemeral reconciliation failed.", error);
    });
  }

  private async reconcileOpenEntries(): Promise<void> {
    if (this.disposed || this.platform !== "win32") return;
    await this.ensureInitialized();
    if (this.disposed) return;
    const openPaths = this.openVaultPaths();
    for (const entry of [...this.entriesByVaultPath.values()]) {
      if (!entry.committed) continue;
      if (openPaths.has(entry.vaultPath)) {
        entry.everObserved = true;
        entry.state = "opened";
        entry.deleteGeneration++;
        continue;
      }
      if (!entry.everObserved || entry.state === "deleting") continue;
      void this.deleteEntryWithRetries(entry).catch((error) => {
        entry.state = "opened";
        console.warn("[mv-aide] Windows PDF ephemeral cleanup failed.", error);
      });
    }
  }

  private async deleteEntryWithRetries(entry: PdfEphemeralEntry): Promise<void> {
    if (entry.state === "deleting") return;
    entry.state = "deleting";
    const generation = ++entry.deleteGeneration;

    for (const delayMs of this.deleteRetryDelaysMs) {
      if (this.disposed || generation !== entry.deleteGeneration) return;
      if (delayMs > 0) {
        await delay(delayMs);
      }
      if (this.disposed || generation !== entry.deleteGeneration) return;
      if (this.openVaultPaths().has(entry.vaultPath)) {
        entry.everObserved = true;
        entry.state = "opened";
        entry.deleteGeneration++;
        return;
      }
      try {
        this.unlinkFile(entry.absolutePath);
        this.forgetEntry(entry);
        this.cleanupEntryDirectories(entry);
        return;
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          this.forgetEntry(entry);
          this.cleanupEntryDirectories(entry);
          return;
        }
        if (!isRetryableDeleteError(error)) {
          console.warn(
            "[mv-aide] Failed to delete Windows PDF ephemeral mirror.",
            entry.absolutePath,
            error,
          );
          entry.state = "opened";
          return;
        }
      }
    }

    entry.state = "opened";
    console.warn(
      "[mv-aide] Windows kept a PDF ephemeral mirror locked; it will be cleaned on a later startup.",
      entry.absolutePath,
    );
  }

  private deletePreparedEntryBestEffort(entry: PdfEphemeralEntry): void {
    try {
      this.unlinkFile(entry.absolutePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return;
    }
    this.forgetEntry(entry);
    this.cleanupEntryDirectories(entry);
  }

  private forgetEntry(entry: PdfEphemeralEntry): void {
    this.entriesByVaultPath.delete(entry.vaultPath);
    if (
      entry.externalIdentity &&
      this.entriesByExternalIdentity.get(entry.externalIdentity) === entry
    ) {
      this.entriesByExternalIdentity.delete(entry.externalIdentity);
    }
  }

  private cleanupEntryDirectories(entry: PdfEphemeralEntry): void {
    const { rootDirectory } = this.paths();
    const entryDirectory = path.dirname(entry.absolutePath);
    this.cleanupEmptyParents(entryDirectory, entry.sessionDirectory, rootDirectory);
  }

  private cleanupEmptyParents(
    entryDirectory: string,
    sessionDirectory: string,
    rootDirectory: string,
  ): void {
    this.removeDirectoryIfEmpty(entryDirectory);
    this.removeDirectoryIfEmpty(sessionDirectory);
    this.removeDirectoryIfEmpty(rootDirectory);
  }

  private removeDirectoryIfEmpty(directory: string): void {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Non-empty, in use, or already gone. Never remove recursively here.
    }
  }

  private entryFileExists(entry: PdfEphemeralEntry): boolean {
    try {
      return fs.statSync(entry.absolutePath).isFile();
    } catch {
      this.forgetEntry(entry);
      return false;
    }
  }

  private openVaultPaths(): Set<string> {
    const paths = new Set<string>();
    this.options.app.workspace.iterateRootLeaves((leaf) => {
      const filePath = leafVaultPath(leaf);
      if (filePath) paths.add(filePath);
    });
    return paths;
  }

  private paths(): { vaultRoot: string; rootDirectory: string } {
    const vaultRoot = fs.realpathSync.native(this.options.getVaultRoot());
    const rootDirectory = path.join(
      vaultRoot,
      ...WINDOWS_PDF_EPHEMERAL_VAULT_FOLDER.split("/"),
    );
    return { vaultRoot, rootDirectory };
  }

  private toVaultPath(vaultRoot: string, absolutePath: string): string {
    const relative = path.relative(vaultRoot, absolutePath);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Windows PDF ephemeral mirror escaped the vault root.");
    }
    return normalizeVaultPath(relative.split(path.sep).join("/"));
  }
}
