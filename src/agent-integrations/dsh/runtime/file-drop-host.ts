import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Notice, TFile, type App } from "obsidian";
import { t } from "../../../i18n";

export const MV_AIDE_FILE_DROP_PROTOCOL = "mv-aide/file-drop";
export const MV_AIDE_FILE_DROP_SCHEMA = 2;
export const MV_AIDE_FILE_DROP_MAX_FILES = 20;

const TRANSACTION_TIMEOUT_MS = 30_000;
const INIT_RETRY_MS = 300;
const INIT_RETRY_WINDOW_MS = 10_000;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type FileDropKind = "reference" | "image";

export interface ResolvedDropFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly kind: FileDropKind;
  readonly mediaType?: string;
}

interface DropSourceSnapshot {
  readonly vaultFiles: readonly TFile[];
  readonly browserFiles: readonly File[];
  readonly fileUris: readonly string[];
}

interface FileDropReply {
  readonly protocol: typeof MV_AIDE_FILE_DROP_PROTOCOL;
  readonly schema: typeof MV_AIDE_FILE_DROP_SCHEMA;
  readonly token: string;
  readonly generation: number;
  readonly type: "ready" | "prepared" | "result";
  readonly requestId?: string;
  readonly transactionId?: string;
  readonly ok?: boolean;
  readonly error?: string;
  readonly count?: number;
  readonly enabled?: boolean;
  readonly capabilities?: {
    readonly references?: boolean;
    readonly images?: boolean;
    readonly sourceImagePolicy?: boolean;
  };
}

interface PendingReply {
  readonly requestId: string;
  readonly expected: "prepared" | "result";
  readonly resolve: (reply: FileDropReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: number;
}

interface ElectronFilePathRuntime {
  readonly webUtils?: {
    getPathForFile?: (file: File) => string;
  };
}

interface ObsidianDragManager {
  readonly draggable?:
    | { readonly type?: string; readonly file?: unknown; readonly files?: unknown }
    | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomToken(viewWindow: Window): string {
  if (typeof viewWindow.crypto?.randomUUID === "function") {
    return viewWindow.crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  viewWindow.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dataTransferTypes(dataTransfer: DataTransfer | null): Set<string> {
  return new Set(Array.from(dataTransfer?.types ?? []));
}

function isSupportedImageMime(mediaType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

function hasOnlyNativeImages(dataTransfer: DataTransfer | null): boolean {
  const fileItems = Array.from(dataTransfer?.items ?? []).filter(
    (item) => item.kind === "file",
  );
  return (
    fileItems.length > 0 &&
    fileItems.every((item) => isSupportedImageMime(item.type))
  );
}

function asVaultFile(app: App, candidate: unknown): TFile | null {
  if (candidate instanceof TFile) return candidate;
  const candidatePath = (candidate as { path?: unknown } | null)?.path;
  if (typeof candidatePath !== "string" || candidatePath.length === 0) return null;
  const resolved = app.vault.getAbstractFileByPath(candidatePath);
  return resolved instanceof TFile ? resolved : null;
}

function internalVaultFiles(app: App): TFile[] {
  const manager = (app as unknown as { dragManager?: ObsidianDragManager }).dragManager;
  const draggable = manager?.draggable;
  if (!draggable) return [];
  const candidates = draggable.type === "files"
    ? Array.isArray(draggable.files) ? draggable.files : []
    : draggable.type === "file" ? [draggable.file] : [];
  const files: TFile[] = [];
  for (const candidate of candidates) {
    const file = asVaultFile(app, candidate);
    if (file) files.push(file);
  }
  return files;
}

function obsidianUriFiles(app: App, text: string): TFile[] {
  const files: TFile[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (!value.startsWith("obsidian://")) continue;
    try {
      const url = new URL(value);
      if (url.hostname !== "open") continue;
      const vault = url.searchParams.get("vault");
      if (vault && vault !== app.vault.getName()) continue;
      const filePath = url.searchParams.get("file") ?? url.searchParams.get("path");
      if (!filePath) continue;
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) files.push(file);
    } catch {
      // Ignore malformed URI-list lines; the complete batch is validated later.
    }
  }
  return files;
}

export function filePathsFromUriList(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value.length === 0 || value.startsWith("#")) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "file:") continue;
      paths.push(fileURLToPath(url));
    } catch {
      // Ignore non-file and malformed URI-list entries.
    }
  }
  return paths;
}

function captureDropSources(app: App, dataTransfer: DataTransfer): DropSourceSnapshot {
  const uriText = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  const managerFiles = internalVaultFiles(app);
  const uriVaultFiles = managerFiles.length > 0
    ? []
    : obsidianUriFiles(app, `${uriText}\n${plainText}`);
  return {
    vaultFiles: managerFiles.length > 0 ? managerFiles : uriVaultFiles,
    browserFiles: Array.from(dataTransfer.files),
    fileUris: filePathsFromUriList(uriText),
  };
}

function electronRuntime(viewWindow: Window): ElectronFilePathRuntime | null {
  try {
    const requireModule = (viewWindow as unknown as {
      require?: (moduleName: string) => unknown;
    }).require ?? (activeWindow as unknown as {
      require?: (moduleName: string) => unknown;
    }).require;
    return (requireModule?.("electron") as ElectronFilePathRuntime | undefined) ?? null;
  } catch {
    return null;
  }
}

export function browserFilePath(
  file: File,
  runtime: ElectronFilePathRuntime | null,
): string | null {
  try {
    const resolved = runtime?.webUtils?.getPathForFile?.(file);
    if (typeof resolved === "string" && path.isAbsolute(resolved)) return resolved;
  } catch {
    // Fall through to the legacy Electron File.path contract.
  }
  const legacy = (file as File & { path?: unknown }).path;
  return typeof legacy === "string" && path.isAbsolute(legacy) ? legacy : null;
}

function detectImageMediaType(header: Uint8Array): string | null {
  if (
    header.length >= 8 &&
    header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e &&
    header[3] === 0x47 && header[4] === 0x0d && header[5] === 0x0a &&
    header[6] === 0x1a && header[7] === 0x0a
  ) return "image/png";
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = new TextDecoder("ascii").decode(header);
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function imageTypeAt(filePath: string): Promise<string | null> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const header = new Uint8Array(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return detectImageMediaType(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function invalidReferencePath(filePath: string): boolean {
  for (const character of filePath) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

async function describePath(candidate: string): Promise<ResolvedDropFile> {
  const absolute = path.resolve(candidate);
  const canonical = await fs.promises.realpath(absolute);
  const status = await fs.promises.stat(canonical);
  if (!status.isFile()) {
    throw new Error(t("只能拖入普通文件，暂不支持文件夹。"));
  }
  await fs.promises.access(canonical, fs.constants.R_OK);
  const mediaType = await imageTypeAt(canonical);
  if (!mediaType && invalidReferencePath(canonical)) {
    throw new Error(t("文件路径包含 DSH 无法安全表示的字符：{path}", { path: canonical }));
  }
  return {
    path: canonical,
    name: path.basename(canonical),
    size: status.size,
    lastModified: Math.trunc(status.mtimeMs),
    kind: mediaType ? "image" : "reference",
    ...(mediaType ? { mediaType } : {}),
  };
}

export async function resolveDropFiles(
  app: App,
  sources: DropSourceSnapshot,
  viewWindow: Window,
): Promise<ResolvedDropFile[]> {
  const vaultRoot = (() => {
    const adapter = app.vault.adapter as { getBasePath?: () => string };
    if (typeof adapter.getBasePath !== "function") {
      throw new Error(t("文件拖入仅支持桌面文件系统 Vault。"));
    }
    return adapter.getBasePath();
  })();
  const candidates: string[] = [];
  if (sources.vaultFiles.length > 0) {
    for (const file of sources.vaultFiles) candidates.push(path.join(vaultRoot, file.path));
  } else {
    const runtime = electronRuntime(viewWindow);
    for (let index = 0; index < sources.browserFiles.length; index += 1) {
      const file = sources.browserFiles[index];
      if (!file) continue;
      const resolved = browserFilePath(file, runtime) ?? sources.fileUris[index];
      if (!resolved) {
        throw new Error(t("无法取得拖入文件的本机绝对路径。"));
      }
      candidates.push(resolved);
    }
    if (sources.browserFiles.length === 0) candidates.push(...sources.fileUris);
  }
  if (candidates.length === 0) throw new Error(t("没有识别到可用文件。"));

  const unique = new Map<string, ResolvedDropFile>();
  for (const candidate of candidates) {
    const file = await describePath(candidate);
    const key = process.platform === "win32" ? file.path.toLocaleLowerCase("en-US") : file.path;
    if (!unique.has(key)) unique.set(key, file);
    if (unique.size > MV_AIDE_FILE_DROP_MAX_FILES) {
      throw new Error(t("一次最多拖入 {count} 个文件。", { count: MV_AIDE_FILE_DROP_MAX_FILES }));
    }
  }
  const files = Array.from(unique.values());
  return files;
}

function isReply(value: unknown): value is FileDropReply {
  const reply = value as Partial<FileDropReply> | null;
  return (
    reply?.protocol === MV_AIDE_FILE_DROP_PROTOCOL &&
    reply.schema === MV_AIDE_FILE_DROP_SCHEMA &&
    (reply.type === "ready" || reply.type === "prepared" || reply.type === "result") &&
    typeof reply.token === "string" &&
    typeof reply.generation === "number"
  );
}

export interface DshFileDropHostOptions {
  readonly app: App;
  readonly frame: HTMLIFrameElement;
  readonly frameContainer: HTMLElement;
  readonly viewWindow: Window;
  /** Vault-owned policy, deliberately independent of IDE bridge state. */
  readonly autoFitImageSize: () => boolean;
}

/** Obsidian-side adapter for trusted desktop file drops into one DSH iframe. */
export class DshFileDropHost {
  private readonly overlay: HTMLDivElement;
  private targetOrigin: string | null = null;
  private token = "";
  private generation = 0;
  private ready = false;
  private featureDisabled = false;
  private disposed = false;
  private initTimer: number | null = null;
  private initDeadline = 0;
  private hideTimer: number | null = null;
  private pending: PendingReply | null = null;
  private busy = false;

  constructor(private readonly options: DshFileDropHostOptions) {
    this.overlay = options.frameContainer.createDiv({
      cls: "mv-aide-dsh-file-drop-overlay",
      text: t("拖到这里，添加到当前 mv-agent 对话"),
    });
    this.overlay.hidden = true;
    options.viewWindow.addEventListener("message", this.handleMessage);
    options.frameContainer.addEventListener("dragenter", this.handleDragEnter);
    options.frameContainer.addEventListener("dragover", this.handleDragOver);
    options.frameContainer.addEventListener("dragleave", this.handleDragLeave);
    options.frameContainer.addEventListener("drop", this.handleDrop);
  }

  setTarget(url: string, generation: number): void {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      this.clearChannel();
      return;
    }
    this.cancelPending(new Error(t("mv-agent 页面已重新加载。")));
    this.targetOrigin = origin;
    this.generation = generation;
    this.token = randomToken(this.options.viewWindow);
    this.ready = false;
    this.featureDisabled = false;
    this.hideOverlay();
    this.clearInitTimer();
  }

  frameLoaded(url: string, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    try {
      if (new URL(url).origin !== this.targetOrigin) return;
    } catch {
      return;
    }
    this.startInitLoop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending(new Error(t("mv-agent 视图已关闭。")));
    this.clearInitTimer();
    this.clearHideTimer();
    this.options.viewWindow.removeEventListener("message", this.handleMessage);
    this.options.frameContainer.removeEventListener("dragenter", this.handleDragEnter);
    this.options.frameContainer.removeEventListener("dragover", this.handleDragOver);
    this.options.frameContainer.removeEventListener("dragleave", this.handleDragLeave);
    this.options.frameContainer.removeEventListener("drop", this.handleDrop);
    this.overlay.remove();
  }

  private clearChannel(): void {
    this.targetOrigin = null;
    this.token = "";
    this.ready = false;
    this.featureDisabled = false;
    this.clearInitTimer();
    this.hideOverlay();
  }

  private startInitLoop(): void {
    this.clearInitTimer();
    this.initDeadline = Date.now() + INIT_RETRY_WINDOW_MS;
    this.sendInit();
    const retry = (): void => {
      this.initTimer = null;
      if (this.disposed || this.ready || Date.now() >= this.initDeadline) return;
      this.sendInit();
      this.initTimer = this.options.viewWindow.setTimeout(retry, INIT_RETRY_MS);
    };
    this.initTimer = this.options.viewWindow.setTimeout(retry, INIT_RETRY_MS);
  }

  private clearInitTimer(): void {
    if (this.initTimer === null) return;
    this.options.viewWindow.clearTimeout(this.initTimer);
    this.initTimer = null;
  }

  private sendInit(): void {
    if (this.disposed || this.ready || !this.targetOrigin || !this.token) return;
    this.options.frame.contentWindow?.postMessage({
      protocol: MV_AIDE_FILE_DROP_PROTOCOL,
      schema: MV_AIDE_FILE_DROP_SCHEMA,
      type: "init",
      token: this.token,
      generation: this.generation,
      targetOrigin: this.targetOrigin,
    }, this.targetOrigin);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (
      this.disposed ||
      event.source !== this.options.frame.contentWindow ||
      event.origin !== this.targetOrigin ||
      !isReply(event.data) ||
      event.data.token !== this.token ||
      event.data.generation !== this.generation
    ) return;
    if (event.data.type === "ready") {
      this.featureDisabled = event.data.enabled === false;
      this.ready = event.data.enabled === true
        && event.data.capabilities?.references === true
        && event.data.capabilities?.images === true
        && event.data.capabilities?.sourceImagePolicy === true;
      this.clearInitTimer();
      if (this.featureDisabled) this.hideOverlay();
      return;
    }
    const pending = this.pending;
    if (
      !pending ||
      event.data.requestId !== pending.requestId ||
      event.data.type !== pending.expected
    ) return;
    this.pending = null;
    this.options.viewWindow.clearTimeout(pending.timer);
    pending.resolve(event.data);
  };

  private recognizesDrag(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (this.featureDisabled) return false;
    const internal = internalVaultFiles(this.options.app).length > 0;
    const types = dataTransferTypes(dataTransfer);
    const external = types.has("Files") || types.has("text/uri-list");
    if (!internal && !external) return false;
    // When the manager client is unavailable, leave native image-only drops
    // to DSH's own document-level image handler.
    if (!this.ready && !internal && hasOnlyNativeImages(dataTransfer)) return false;
    return true;
  }

  private readonly handleDragEnter = (event: DragEvent): void => {
    if (!this.recognizesDrag(event.dataTransfer)) return;
    if (!this.ready) this.startInitLoop();
    event.preventDefault();
    this.clearHideTimer();
    this.overlay.hidden = false;
    this.overlay.toggleClass("is-unavailable", !this.ready);
    this.overlay.setText(this.ready
      ? t("拖到这里，添加到当前 mv-agent 对话")
      : t("文件拖入组件尚未就绪；松开后可查看原因"));
  };

  private readonly handleDragOver = (event: DragEvent): void => {
    if (!this.recognizesDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.clearHideTimer();
    this.overlay.hidden = false;
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    if (!this.recognizesDrag(event.dataTransfer)) return;
    this.clearHideTimer();
    this.hideTimer = this.options.viewWindow.setTimeout(() => this.hideOverlay(), 60);
  };

  private readonly handleDrop = (event: DragEvent): void => {
    if (!this.recognizesDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    this.hideOverlay();
    if (!event.dataTransfer) return;
    const sources = captureDropSources(this.options.app, event.dataTransfer);
    void this.acceptDrop(sources);
  };

  private clearHideTimer(): void {
    if (this.hideTimer === null) return;
    this.options.viewWindow.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private hideOverlay(): void {
    this.clearHideTimer();
    this.overlay.hidden = true;
  }

  private async acceptDrop(sources: DropSourceSnapshot): Promise<void> {
    if (this.busy) {
      new Notice(t("已有一批文件正在加入 mv-agent，请稍候。"), 6000);
      return;
    }
    if (!this.ready) {
      this.sendInit();
      new Notice(t("mv-dsh-manager 文件拖入组件尚未就绪或版本不兼容，请升级注入并刷新 mv-agent。"), 8000);
      return;
    }
    this.busy = true;
    let activeRequestId: string | null = null;
    let activeTransactionId: string | null = null;
    try {
      const files = await resolveDropFiles(this.options.app, sources, this.options.viewWindow);
      const requestId = randomToken(this.options.viewWindow);
      activeRequestId = requestId;
      const preparedPromise = this.waitForReply(requestId, "prepared");
      this.post({
        type: "prepare",
        requestId,
        autoFitImageSize: this.options.autoFitImageSize(),
        files: files.map((file, index) => ({
          id: String(index),
          kind: file.kind,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          ...(file.kind === "reference"
            ? { path: file.path }
            : { mediaType: file.mediaType }),
        })),
      });
      const prepared = await preparedPromise;
      if (prepared.ok !== true || !prepared.transactionId) {
        throw new Error(prepared.error || t("DSH 拒绝了这批文件。"));
      }
      activeTransactionId = prepared.transactionId;

      const imagePayloads: Array<{
        id: string;
        name: string;
        mediaType: string;
        lastModified: number;
        bytes: ArrayBuffer;
      }> = [];
      const transfer: Transferable[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file || file.kind !== "image" || !file.mediaType) continue;
        const bytes = await fs.promises.readFile(file.path);
        const currentStatus = await fs.promises.stat(file.path);
        const actualType = detectImageMediaType(bytes.subarray(0, 16));
        if (
          actualType !== file.mediaType ||
          currentStatus.size !== file.size ||
          Math.trunc(currentStatus.mtimeMs) !== file.lastModified
        ) {
          throw new Error(t("文件在拖入过程中发生变化：{path}", { path: file.path }));
        }
        const arrayBuffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
        transfer.push(arrayBuffer);
        imagePayloads.push({
          id: String(index),
          name: file.name,
          mediaType: file.mediaType,
          lastModified: file.lastModified,
          bytes: arrayBuffer,
        });
      }

      const resultPromise = this.waitForReply(requestId, "result");
      this.post({
        type: "commit",
        requestId,
        transactionId: prepared.transactionId,
        images: imagePayloads,
      }, transfer);
      const result = await resultPromise;
      if (result.ok !== true) throw new Error(result.error || t("文件加入失败。"));
      activeRequestId = null;
      activeTransactionId = null;
      new Notice(t("已将 {count} 个文件加入 mv-agent 草稿。", {
        count: result.count ?? files.length,
      }));
    } catch (error) {
      if (activeRequestId && activeTransactionId) {
        try {
          this.post({
            type: "cancel",
            requestId: activeRequestId,
            transactionId: activeTransactionId,
          });
        } catch {
          // Navigation/teardown already invalidated the transaction.
        }
      }
      new Notice(t("文件拖入失败：{message}", { message: errorMessage(error) }), 10_000);
    } finally {
      this.busy = false;
    }
  }

  private post(payload: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (!this.targetOrigin || !this.token) throw new Error(t("mv-agent 页面尚未就绪。"));
    this.options.frame.contentWindow?.postMessage({
      protocol: MV_AIDE_FILE_DROP_PROTOCOL,
      schema: MV_AIDE_FILE_DROP_SCHEMA,
      token: this.token,
      generation: this.generation,
      ...payload,
    }, this.targetOrigin, transfer);
  }

  private waitForReply(
    requestId: string,
    expected: "prepared" | "result",
  ): Promise<FileDropReply> {
    this.cancelPending(new Error(t("新的文件拖入请求替换了旧请求。")));
    return new Promise((resolve, reject) => {
      const timer = this.options.viewWindow.setTimeout(() => {
        if (this.pending?.requestId !== requestId || this.pending.expected !== expected) return;
        this.pending = null;
        reject(new Error(t("等待 mv-dsh-manager 响应超时。")));
      }, TRANSACTION_TIMEOUT_MS);
      this.pending = { requestId, expected, resolve, reject, timer };
    });
  }

  private cancelPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.options.viewWindow.clearTimeout(pending.timer);
    pending.reject(error);
  }
}
