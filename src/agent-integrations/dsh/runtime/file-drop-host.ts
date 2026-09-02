import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Notice, TFile, TFolder, type App } from "obsidian";
import { t } from "../../../i18n";

export const MV_AIDE_FILE_DROP_PROTOCOL = "mv-aide/file-drop";
export const MV_AIDE_FILE_DROP_SCHEMA = 2;
export const MV_AIDE_FILE_DROP_MAX_FILES = 20;

const TRANSACTION_TIMEOUT_MS = 30_000;
const INIT_RETRY_MS = 300;
const INIT_RETRY_WINDOW_MS = 10_000;
const REQUIRED_CAPABILITIES = [
  "references",
  "images",
  "sourceImagePolicy",
] as const;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

type FileDropKind = "reference" | "image" | "directory";
type RequiredCapability = typeof REQUIRED_CAPABILITIES[number];
type FileDropChannelState =
  | "idle"
  | "connecting"
  | "ready"
  | "disabled"
  | "incompatible"
  | "timed-out"
  | "disposed";

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
  readonly vaultFolders: readonly TFolder[];
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
    readonly directories?: boolean;
  };
}

interface PendingReply {
  readonly requestId: string;
  readonly expected: "prepared" | "result";
  readonly resolve: (reply: FileDropReply) => void;
  readonly reject: (error: Error) => void;
  timer: OwnedWindowTimer;
}

interface OwnedWindowTimer {
  readonly owner: Window;
  readonly id: number;
  readonly deadline: number;
}

interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
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

function asVaultFolder(app: App, candidate: unknown): TFolder | null {
  if (candidate instanceof TFolder) return candidate;
  const candidatePath = (candidate as { path?: unknown } | null)?.path;
  if (typeof candidatePath !== "string" || candidatePath.length === 0) return null;
  const resolved = app.vault.getAbstractFileByPath(candidatePath);
  return resolved instanceof TFolder ? resolved : null;
}

export function internalVaultFolders(app: App): TFolder[] {
  const manager = (app as unknown as { dragManager?: ObsidianDragManager }).dragManager;
  const draggable = manager?.draggable;
  if (!draggable) return [];
  // Obsidian's file explorer starts folder drags with `dragFolder`, whose
  // draggable type is "folder"; mixed multi-selections ride "files" as TFolder
  // entries next to TFile ones. File drags ("file"/"files") are owned by
  // `internalVaultFiles` and must not be re-read here.
  const candidates = draggable.type === "files"
    ? Array.isArray(draggable.files) ? draggable.files : []
    : draggable.type === "folder" ? [draggable.file] : [];
  const folders: TFolder[] = [];
  for (const candidate of candidates) {
    const folder = asVaultFolder(app, candidate);
    if (folder) folders.push(folder);
  }
  return folders;
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

export function captureDropSources(app: App, dataTransfer: DataTransfer): DropSourceSnapshot {
  const uriText = dataTransfer.getData("text/uri-list");
  const plainText = dataTransfer.getData("text/plain");
  // Files and folders are collected independently: Obsidian's mixed
  // multi-selection carries TFolder entries inside a "files" draggable, and a
  // file-only guard would silently drop those folders.
  const managerFiles = internalVaultFiles(app);
  const managerFolders = internalVaultFolders(app);
  const uriVaultFiles = managerFiles.length > 0 || managerFolders.length > 0
    ? []
    : obsidianUriFiles(app, `${uriText}\n${plainText}`);
  return {
    vaultFiles: managerFiles.length > 0 ? managerFiles : uriVaultFiles,
    vaultFolders: managerFolders,
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
  if (status.isDirectory()) {
    await fs.promises.access(canonical, fs.constants.R_OK);
    return {
      path: canonical,
      name: path.basename(canonical),
      size: 0,
      lastModified: Math.trunc(status.mtimeMs),
      kind: "directory",
    };
  }
  if (!status.isFile()) {
    throw new Error(t("只能拖入普通文件和文件夹，暂不支持其他类型。"));
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
  }
  for (const folder of sources.vaultFolders) {
    candidates.push(path.join(vaultRoot, folder.path));
  }
  if (sources.vaultFiles.length === 0 && sources.vaultFolders.length === 0) {
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
  /** Vault-owned policy, deliberately independent of IDE bridge state. */
  readonly autoFitImageSize: () => boolean;
}

/** Obsidian-side adapter for trusted desktop file drops into one DSH iframe. */
export class DshFileDropHost {
  private readonly overlay: HTMLDivElement;
  private targetOrigin: string | null = null;
  private token = "";
  private generation = 0;
  private awaitingFrameLoadGeneration: number | null = null;
  private ready = false;
  private featureDisabled = false;
  private channelState: FileDropChannelState = "idle";
  private missingCapabilities: RequiredCapability[] = [];
  private disposed = false;
  private boundDocument: Document | null = null;
  private boundWindow: Window | null = null;
  private readonly listeningWindows = new Set<Window>();
  private transportPort: MessagePort | null = null;
  private transportMode: "port" | "legacy" | null = null;
  private transportSequence = 0;
  private initTimer: OwnedWindowTimer | null = null;
  private initDeadline = 0;
  private hideTimer: OwnedWindowTimer | null = null;
  private pending: PendingReply | null = null;
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private activeOperation: symbol | null = null;
  private transportEpoch = 0;
  private capabilities: NonNullable<FileDropReply["capabilities"]> | null = null;

  constructor(private readonly options: DshFileDropHostOptions) {
    this.overlay = options.frameContainer.createDiv({
      cls: "mv-aide-dsh-file-drop-overlay",
      text: t("拖到这里，添加到当前 mv-agent 对话"),
    });
    this.overlay.hidden = true;
    this.bindOwnerWindow();
    options.frameContainer.addEventListener("dragenter", this.handleDragEnter);
    options.frameContainer.addEventListener("dragover", this.handleDragOver);
    options.frameContainer.addEventListener("dragleave", this.handleDragLeave);
    options.frameContainer.addEventListener("drop", this.handleDrop);
  }

  setTarget(url: string, generation: number): void {
    this.bindOwnerWindow();
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      this.clearChannel();
      return;
    }
    this.targetOrigin = origin;
    this.generation = generation;
    this.resetTransport(new Error(t("mv-agent 页面已重新加载。")));
    this.awaitingFrameLoadGeneration = generation;
  }

  frameLoaded(url: string, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    this.bindOwnerWindow();
    try {
      if (new URL(url).origin !== this.targetOrigin) return;
    } catch {
      return;
    }
    if (this.awaitingFrameLoadGeneration === generation) {
      // setTarget already created the token for this navigation. Keeping it
      // lets a drop captured during navigation wait for the new client realm
      // instead of being rejected by the expected load event.
      this.awaitingFrameLoadGeneration = null;
    } else {
      // A same-URL iframe reload without beginNavigation creates an unexpected
      // client realm and must invalidate in-flight transport work.
      this.resetTransport(new Error(t("mv-agent 页面已重新加载。")));
    }
    this.startInitLoop();
  }

  /** Rebind this view after Obsidian adopts it into another desktop window. */
  syncOwnerWindow(): void {
    this.bindOwnerWindow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transportEpoch += 1;
    this.activeOperation = null;
    const closedError = new Error(t("mv-agent 视图已关闭。"));
    this.cancelPending(closedError);
    this.rejectReadyWaiters(closedError);
    this.setChannelState("disposed");
    this.clearInitTimer();
    this.clearHideTimer();
    for (const hostWindow of this.listeningWindows) {
      hostWindow.removeEventListener("message", this.handleMessage);
    }
    this.listeningWindows.clear();
    this.closeTransportPort();
    this.boundDocument = null;
    this.boundWindow = null;
    this.awaitingFrameLoadGeneration = null;
    this.options.frameContainer.removeEventListener("dragenter", this.handleDragEnter);
    this.options.frameContainer.removeEventListener("dragover", this.handleDragOver);
    this.options.frameContainer.removeEventListener("dragleave", this.handleDragLeave);
    this.options.frameContainer.removeEventListener("drop", this.handleDrop);
    this.overlay.remove();
  }

  private clearChannel(): void {
    this.transportEpoch += 1;
    this.activeOperation = null;
    const unavailableError = new Error(t("mv-agent 页面尚未就绪。"));
    this.cancelPending(unavailableError);
    this.rejectReadyWaiters(unavailableError);
    this.targetOrigin = null;
    this.token = "";
    this.transportSequence += 1;
    this.closeTransportPort();
    this.awaitingFrameLoadGeneration = null;
    this.setChannelState("idle");
    this.capabilities = null;
    this.clearInitTimer();
    this.clearHideTimer();
    this.hideOverlay();
  }

  private currentOwnerWindow(): Window {
    return this.options.frameContainer.ownerDocument.defaultView ??
      this.options.frame.ownerDocument.defaultView ?? activeWindow;
  }

  private bindOwnerWindow(): boolean {
    if (this.disposed) return false;
    const nextDocument = this.options.frameContainer.ownerDocument;
    const nextWindow = this.currentOwnerWindow();
    if (
      nextDocument === this.boundDocument &&
      nextWindow === this.boundWindow
    ) return false;
    const previousWindow = this.boundWindow;
    if (!this.listeningWindows.has(nextWindow)) {
      nextWindow.addEventListener("message", this.handleMessage);
      this.listeningWindows.add(nextWindow);
    }
    this.boundDocument = nextDocument;
    this.boundWindow = nextWindow;
    if (nextWindow !== previousWindow) this.rebindOwnedTimers(nextWindow);
    return true;
  }

  private resetTransport(error: Error): void {
    this.transportEpoch += 1;
    this.activeOperation = null;
    this.cancelPending(error);
    this.rejectReadyWaiters(error);
    this.clearInitTimer();
    this.clearHideTimer();
    this.transportSequence += 1;
    this.closeTransportPort();
    this.awaitingFrameLoadGeneration = null;
    this.setChannelState("idle");
    this.capabilities = null;
    this.token = this.targetOrigin ? randomToken(this.currentOwnerWindow()) : "";
    this.hideOverlay();
  }

  private startInitLoop(): void {
    if (
      this.disposed ||
      !this.targetOrigin ||
      !this.token ||
      this.channelState === "ready" ||
      this.channelState === "disabled" ||
      this.channelState === "incompatible"
    ) return;
    if (this.channelState === "connecting" && this.initDeadline > Date.now()) {
      this.sendInit();
      return;
    }
    this.clearInitTimer();
    this.setChannelState("connecting");
    this.initDeadline = Date.now() + INIT_RETRY_WINDOW_MS;
    this.sendInit();
    this.scheduleInitRetry(Math.min(INIT_RETRY_MS, INIT_RETRY_WINDOW_MS));
  }

  private clearInitTimer(): void {
    if (this.initTimer === null) return;
    this.initTimer.owner.clearTimeout(this.initTimer.id);
    this.initTimer = null;
  }

  private scheduleInitRetry(delay: number): void {
    const owner = this.currentOwnerWindow();
    const boundedDelay = Math.max(0, delay);
    const id = owner.setTimeout(() => {
      this.initTimer = null;
      if (this.disposed || this.channelState !== "connecting") return;
      const remaining = this.initDeadline - Date.now();
      if (remaining <= 0) {
        this.initDeadline = 0;
        this.setChannelState("timed-out");
        return;
      }
      this.sendInit();
      this.scheduleInitRetry(Math.min(INIT_RETRY_MS, remaining));
    }, boundedDelay);
    this.initTimer = {
      owner,
      id,
      deadline: Date.now() + boundedDelay,
    };
  }

  private rebindOwnedTimers(nextWindow: Window): void {
    const now = Date.now();
    if (this.initTimer) {
      const remaining = Math.max(0, this.initTimer.deadline - now);
      this.initTimer.owner.clearTimeout(this.initTimer.id);
      this.initTimer = null;
      this.scheduleInitRetry(remaining);
    }
    if (this.hideTimer) {
      const remaining = Math.max(0, this.hideTimer.deadline - now);
      this.hideTimer.owner.clearTimeout(this.hideTimer.id);
      this.hideTimer = null;
      this.scheduleOverlayHide(remaining, nextWindow);
    }
    if (this.pending) {
      const remaining = Math.max(0, this.pending.timer.deadline - now);
      this.pending.timer.owner.clearTimeout(this.pending.timer.id);
      this.pending.timer = this.schedulePendingTimeout(
        this.pending,
        remaining,
        nextWindow,
      );
    }
  }

  private setChannelState(state: FileDropChannelState): void {
    this.channelState = state;
    this.ready = state === "ready";
    this.featureDisabled = state === "disabled";
    if (state !== "incompatible") this.missingCapabilities = [];
    if (state === "ready") {
      for (const waiter of this.readyWaiters) waiter.resolve();
      this.readyWaiters.clear();
    } else if (
      state === "disabled" ||
      state === "incompatible" ||
      state === "timed-out" ||
      state === "disposed"
    ) {
      this.rejectReadyWaiters(this.channelError());
    }
    if (!this.overlay.hidden) this.renderOverlayState();
  }

  private channelError(): Error {
    if (this.channelState === "disabled") {
      return new Error(t("mv-dsh-manager 文件拖入功能已关闭。"));
    }
    if (this.channelState === "incompatible") {
      return new Error(t("当前 mv-dsh-manager 缺少文件拖入能力：{capabilities}。", {
        capabilities: this.missingCapabilities.join(", "),
      }));
    }
    if (this.channelState === "timed-out") {
      return new Error(t("等待 mv-dsh-manager 文件拖入组件连接超时。"));
    }
    if (this.channelState === "disposed") {
      return new Error(t("mv-agent 视图已关闭。"));
    }
    return new Error(t("mv-agent 页面尚未就绪。"));
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private waitForChannelReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (
      this.channelState === "disabled" ||
      this.channelState === "incompatible" ||
      this.channelState === "disposed"
    ) return Promise.reject(this.channelError());
    this.startInitLoop();
    if (this.channelState !== "connecting" && !this.ready) {
      return Promise.reject(this.channelError());
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  private renderOverlayState(): void {
    const unavailable =
      this.channelState === "incompatible" ||
      this.channelState === "timed-out";
    this.overlay.toggleClass("is-unavailable", unavailable);
    if (this.ready) {
      this.overlay.setText(t("拖到这里，添加到当前 mv-agent 对话"));
      return;
    }
    if (this.channelState === "incompatible") {
      this.overlay.setText(t("文件拖入组件与当前 mv-dsh-manager 不兼容"));
      return;
    }
    if (this.channelState === "timed-out") {
      this.overlay.setText(t("文件拖入组件连接超时；松开后将重新连接"));
      return;
    }
    this.overlay.setText(t("文件拖入组件正在重新连接；松开后将等待连接完成"));
  }

  private closeTransportPort(): void {
    const port = this.transportPort;
    this.transportPort = null;
    this.transportMode = null;
    if (!port) return;
    port.onmessage = null;
    port.close();
  }

  private sendInit(): void {
    if (
      this.disposed ||
      this.ready ||
      this.awaitingFrameLoadGeneration !== null ||
      !this.targetOrigin ||
      !this.token
    ) return;
    const frameWindow = this.options.frame.contentWindow;
    if (!frameWindow) return;
    const message = {
      protocol: MV_AIDE_FILE_DROP_PROTOCOL,
      schema: MV_AIDE_FILE_DROP_SCHEMA,
      type: "init",
      token: this.token,
      generation: this.generation,
      targetOrigin: this.targetOrigin,
    };
    this.transportSequence += 1;
    const sequence = this.transportSequence;
    this.closeTransportPort();
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event): void => {
        if (sequence !== this.transportSequence) return;
        this.handleReply(event.data, "port");
      };
      channel.port1.start();
      this.transportPort = channel.port1;
      frameWindow.postMessage(message, this.targetOrigin, [channel.port2]);
    } catch {
      this.closeTransportPort();
      frameWindow.postMessage(message, this.targetOrigin);
    }
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (
      this.disposed ||
      this.transportMode === "port" ||
      event.source !== this.options.frame.contentWindow ||
      event.origin !== this.targetOrigin ||
      !isReply(event.data)
    ) return;
    this.handleReply(event.data, "legacy");
  };

  private handleReply(
    reply: unknown,
    mode: "port" | "legacy",
  ): void {
    if (
      this.disposed ||
      !isReply(reply) ||
      reply.token !== this.token ||
      reply.generation !== this.generation
    ) return;
    if (reply.type === "ready") {
      if (mode === "legacy") this.closeTransportPort();
      this.transportMode = mode;
      const capabilities = reply.capabilities;
      this.capabilities = capabilities ?? null;
      this.clearInitTimer();
      this.initDeadline = 0;
      if (reply.enabled === false) {
        this.setChannelState("disabled");
        this.hideOverlay();
        return;
      }
      this.missingCapabilities = REQUIRED_CAPABILITIES.filter(
        (capability) => capabilities?.[capability] !== true,
      );
      this.setChannelState(
        this.missingCapabilities.length === 0 ? "ready" : "incompatible",
      );
      return;
    }
    const pending = this.pending;
    if (
      !pending ||
      mode !== this.transportMode ||
      reply.requestId !== pending.requestId ||
      reply.type !== pending.expected
    ) return;
    this.pending = null;
    pending.timer.owner.clearTimeout(pending.timer.id);
    pending.resolve(reply);
  }

  private recognizesDrag(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    if (this.featureDisabled) return false;
    const internal = internalVaultFiles(this.options.app).length > 0
      || internalVaultFolders(this.options.app).length > 0;
    const types = dataTransferTypes(dataTransfer);
    const external = types.has("Files") || types.has("text/uri-list");
    if (!internal && !external) return false;
    // When the manager client is unavailable, leave native image-only drops
    // to DSH's own document-level image handler.
    if (!this.ready && !internal && hasOnlyNativeImages(dataTransfer)) return false;
    return true;
  }

  private readonly handleDragEnter = (event: DragEvent): void => {
    this.syncOwnerWindow();
    if (!this.recognizesDrag(event.dataTransfer)) return;
    if (!this.ready) this.startInitLoop();
    event.preventDefault();
    this.clearHideTimer();
    this.overlay.hidden = false;
    this.renderOverlayState();
  };

  private readonly handleDragOver = (event: DragEvent): void => {
    this.syncOwnerWindow();
    if (!this.recognizesDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.clearHideTimer();
    this.overlay.hidden = false;
    this.renderOverlayState();
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    this.syncOwnerWindow();
    if (!this.recognizesDrag(event.dataTransfer)) return;
    this.clearHideTimer();
    this.scheduleOverlayHide(60);
  };

  private readonly handleDrop = (event: DragEvent): void => {
    this.syncOwnerWindow();
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
    this.hideTimer.owner.clearTimeout(this.hideTimer.id);
    this.hideTimer = null;
  }

  private scheduleOverlayHide(
    delay: number,
    owner = this.currentOwnerWindow(),
  ): void {
    const boundedDelay = Math.max(0, delay);
    const id = owner.setTimeout(() => {
      this.hideTimer = null;
      this.hideOverlay();
    }, boundedDelay);
    this.hideTimer = {
      owner,
      id,
      deadline: Date.now() + boundedDelay,
    };
  }

  private hideOverlay(): void {
    this.clearHideTimer();
    this.overlay.hidden = true;
  }

  private async acceptDrop(sources: DropSourceSnapshot): Promise<void> {
    if (this.activeOperation) {
      new Notice(t("已有一批文件正在加入 mv-agent，请稍候。"), 6000);
      return;
    }
    const operation = Symbol("mv-aide-file-drop");
    const operationEpoch = this.transportEpoch;
    this.activeOperation = operation;
    let activeRequestId: string | null = null;
    let activeTransactionId: string | null = null;
    try {
      await this.waitForChannelReady();
      this.assertCurrentOperation(operation, operationEpoch);
      const files = await resolveDropFiles(
        this.options.app,
        sources,
        this.currentOwnerWindow(),
      );
      this.assertCurrentOperation(operation, operationEpoch);
      if (
        files.some((file) => file.kind === "directory") &&
        this.capabilities?.directories !== true
      ) {
        throw new Error(t("当前 mv-dsh-manager 版本不支持文件夹拖入，请升级注入并刷新 mv-agent。"));
      }
      const requestId = randomToken(this.currentOwnerWindow());
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
          ...(file.kind === "image"
            ? { mediaType: file.mediaType }
            : { path: file.path }),
        })),
      });
      const prepared = await preparedPromise;
      this.assertCurrentOperation(operation, operationEpoch);
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

      this.assertCurrentOperation(operation, operationEpoch);
      const resultPromise = this.waitForReply(requestId, "result");
      this.post({
        type: "commit",
        requestId,
        transactionId: prepared.transactionId,
        images: imagePayloads,
      }, transfer);
      const result = await resultPromise;
      this.assertCurrentOperation(operation, operationEpoch);
      if (result.ok !== true) throw new Error(result.error || t("文件加入失败。"));
      activeRequestId = null;
      activeTransactionId = null;
      new Notice(t("已将 {count} 个文件加入 mv-agent 草稿。", {
        count: result.count ?? files.length,
      }));
    } catch (error) {
      if (
        operationEpoch === this.transportEpoch &&
        activeRequestId &&
        activeTransactionId
      ) {
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
      if (this.activeOperation === operation) this.activeOperation = null;
    }
  }

  private assertCurrentOperation(operation: symbol, epoch: number): void {
    if (this.activeOperation !== operation || this.transportEpoch !== epoch) {
      throw new Error(t("mv-agent 页面在文件拖入过程中发生变化，请重新拖入。"));
    }
  }

  private post(payload: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (!this.targetOrigin || !this.token) throw new Error(t("mv-agent 页面尚未就绪。"));
    const message = {
      protocol: MV_AIDE_FILE_DROP_PROTOCOL,
      schema: MV_AIDE_FILE_DROP_SCHEMA,
      token: this.token,
      generation: this.generation,
      ...payload,
    };
    if (this.transportMode === "port" && this.transportPort) {
      this.transportPort.postMessage(message, transfer);
      return;
    }
    if (this.transportMode !== "legacy") {
      throw new Error(t("mv-agent 页面尚未就绪。"));
    }
    const frameWindow = this.options.frame.contentWindow;
    if (!frameWindow) throw new Error(t("mv-agent 页面尚未就绪。"));
    frameWindow.postMessage(message, this.targetOrigin, transfer);
  }

  private waitForReply(
    requestId: string,
    expected: "prepared" | "result",
  ): Promise<FileDropReply> {
    this.cancelPending(new Error(t("新的文件拖入请求替换了旧请求。")));
    return new Promise((resolve, reject) => {
      const pending: PendingReply = {
        requestId,
        expected,
        resolve,
        reject,
        timer: { owner: this.currentOwnerWindow(), id: 0, deadline: 0 },
      };
      pending.timer = this.schedulePendingTimeout(
        pending,
        TRANSACTION_TIMEOUT_MS,
      );
      this.pending = pending;
    });
  }

  private schedulePendingTimeout(
    pending: PendingReply,
    delay: number,
    owner = this.currentOwnerWindow(),
  ): OwnedWindowTimer {
    const boundedDelay = Math.max(0, delay);
    const id = owner.setTimeout(() => {
      if (this.pending !== pending) return;
      this.pending = null;
      pending.reject(new Error(t("等待 mv-dsh-manager 响应超时。")));
    }, boundedDelay);
    return {
      owner,
      id,
      deadline: Date.now() + boundedDelay,
    };
  }

  private cancelPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.timer.owner.clearTimeout(pending.timer.id);
    pending.reject(error);
  }
}
