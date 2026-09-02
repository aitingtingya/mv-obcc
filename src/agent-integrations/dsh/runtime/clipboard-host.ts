/**
 * Native-first clipboard fallback for one mv-agent iframe.
 *
 * The DSH page keeps using navigator.clipboard directly. Only a
 * NotAllowedError is delegated by the injected manager client. A transferred
 * MessagePort carries the complete request/reply lifecycle, so moving the
 * iframe between Obsidian windows does not change the channel identity.
 */

export const MV_AIDE_CLIPBOARD_PROTOCOL = "mv-aide/clipboard";
export const MV_AIDE_CLIPBOARD_SCHEMA = 1;

const INIT_RETRY_MS = 300;
const INIT_RETRY_WINDOW_MS = 10_000;

interface ClipboardInitMessage {
  readonly protocol: typeof MV_AIDE_CLIPBOARD_PROTOCOL;
  readonly schema: typeof MV_AIDE_CLIPBOARD_SCHEMA;
  readonly type: "init";
  readonly token: string;
  readonly generation: number;
  readonly targetOrigin: string;
}

interface ClipboardReadyReply {
  readonly protocol: typeof MV_AIDE_CLIPBOARD_PROTOCOL;
  readonly schema: typeof MV_AIDE_CLIPBOARD_SCHEMA;
  readonly token: string;
  readonly generation: number;
  readonly type: "ready";
}

interface ClipboardWriteRequest {
  readonly protocol: typeof MV_AIDE_CLIPBOARD_PROTOCOL;
  readonly schema: typeof MV_AIDE_CLIPBOARD_SCHEMA;
  readonly token: string;
  readonly generation: number;
  readonly type: "write-text";
  readonly requestId: string;
  readonly text: string;
}

interface ClipboardWriteResult {
  readonly protocol: typeof MV_AIDE_CLIPBOARD_PROTOCOL;
  readonly schema: typeof MV_AIDE_CLIPBOARD_SCHEMA;
  readonly token: string;
  readonly generation: number;
  readonly type: "write-result";
  readonly requestId: string;
  readonly ok: boolean;
  readonly error?: string;
}

type ClipboardTransportMessage = ClipboardReadyReply | ClipboardWriteRequest;
type ClipboardTransportMode = "port" | "legacy";

interface OwnedWindowTimer {
  readonly owner: Window;
  readonly id: number;
  readonly deadline: number;
}

interface ElectronClipboardLike {
  writeText(text: string): void;
}

interface RuntimeRequire {
  (moduleName: "electron"): {
    clipboard?: ElectronClipboardLike;
  };
}

export interface DshClipboardHostOptions {
  readonly frame: HTMLIFrameElement;
  readonly frameContainer: HTMLElement;
  /** Main Obsidian renderer; popouts are sandboxed and do not need require. */
  readonly privilegedWindow: Window;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function randomToken(hostWindow: Window): string {
  if (typeof hostWindow.crypto?.randomUUID === "function") {
    return hostWindow.crypto.randomUUID();
  }
  const bytes = new Uint8Array(24);
  hostWindow.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveElectronClipboard(
  privilegedWindow: Window,
): ElectronClipboardLike | null {
  const requireModule = (privilegedWindow as Window & {
    require?: RuntimeRequire;
  }).require;
  if (typeof requireModule !== "function") return null;
  try {
    const clipboard = requireModule("electron")?.clipboard;
    return typeof clipboard?.writeText === "function" ? clipboard : null;
  } catch {
    return null;
  }
}

function isTransportMessage(value: unknown): value is ClipboardTransportMessage {
  if (!isRecord(value)) return false;
  if (
    value.protocol !== MV_AIDE_CLIPBOARD_PROTOCOL ||
    value.schema !== MV_AIDE_CLIPBOARD_SCHEMA ||
    typeof value.token !== "string" ||
    typeof value.generation !== "number"
  ) return false;
  if (value.type === "ready") return true;
  return value.type === "write-text" &&
    typeof value.requestId === "string" &&
    typeof value.text === "string";
}

export class DshClipboardHost {
  private targetOrigin: string | null = null;
  private token = "";
  private generation = 0;
  private awaitingFrameLoadGeneration: number | null = null;
  private ready = false;
  private disposed = false;
  private boundWindow: Window | null = null;
  private transportPort: MessagePort | null = null;
  private transportMode: ClipboardTransportMode | null = null;
  private transportSequence = 0;
  private initTimer: OwnedWindowTimer | null = null;
  private initDeadline = 0;
  private readonly seenRequestIds = new Set<string>();

  constructor(private readonly options: DshClipboardHostOptions) {
    this.bindOwnerWindow();
  }

  setTarget(url: string, generation: number): void {
    this.bindOwnerWindow();
    try {
      const origin = new URL(url).origin;
      this.targetOrigin = origin === "null" ? null : origin;
    } catch {
      this.targetOrigin = null;
    }
    this.generation = generation;
    this.resetTransport();
    this.awaitingFrameLoadGeneration = this.targetOrigin ? generation : null;
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
      this.awaitingFrameLoadGeneration = null;
    } else {
      // Same-URL reloads create a new DSH realm even without beginNavigation.
      this.resetTransport();
    }
    this.startInitLoop();
  }

  /** Owner migration changes only legacy listeners; an established port stays live. */
  syncOwnerWindow(): void {
    this.bindOwnerWindow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearInitTimer();
    this.transportSequence += 1;
    this.closeTransportPort();
    if (this.boundWindow) {
      this.boundWindow.removeEventListener("message", this.handleWindowMessage);
    }
    this.boundWindow = null;
    this.seenRequestIds.clear();
  }

  private currentOwnerWindow(): Window {
    return this.options.frameContainer.ownerDocument.defaultView ??
      this.options.privilegedWindow;
  }

  private bindOwnerWindow(): void {
    if (this.disposed) return;
    const nextWindow = this.currentOwnerWindow();
    if (nextWindow === this.boundWindow) return;
    this.boundWindow?.removeEventListener("message", this.handleWindowMessage);
    nextWindow.addEventListener("message", this.handleWindowMessage);
    this.boundWindow = nextWindow;
    if (this.initTimer) {
      const remaining = Math.max(0, this.initTimer.deadline - Date.now());
      this.clearInitTimer();
      this.scheduleInitRetry(remaining);
    }
  }

  private resetTransport(): void {
    this.ready = false;
    this.transportSequence += 1;
    this.closeTransportPort();
    this.clearInitTimer();
    this.initDeadline = 0;
    this.seenRequestIds.clear();
    this.token = this.targetOrigin ? randomToken(this.currentOwnerWindow()) : "";
  }

  private startInitLoop(): void {
    if (
      this.disposed ||
      this.ready ||
      this.awaitingFrameLoadGeneration !== null ||
      !this.targetOrigin ||
      !this.token ||
      this.initTimer !== null
    ) return;
    this.initDeadline = Date.now() + INIT_RETRY_WINDOW_MS;
    this.sendInit();
    this.scheduleInitRetry(INIT_RETRY_MS);
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
    const init: ClipboardInitMessage = {
      protocol: MV_AIDE_CLIPBOARD_PROTOCOL,
      schema: MV_AIDE_CLIPBOARD_SCHEMA,
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
        this.handleTransportMessage(event.data, "port");
      };
      channel.port1.start();
      this.transportPort = channel.port1;
      frameWindow.postMessage(init, this.targetOrigin, [channel.port2]);
    } catch {
      this.closeTransportPort();
      frameWindow.postMessage(init, this.targetOrigin);
    }
  }

  private readonly handleWindowMessage = (event: MessageEvent): void => {
    if (
      this.disposed ||
      this.transportMode === "port" ||
      event.source !== this.options.frame.contentWindow ||
      event.origin !== this.targetOrigin
    ) return;
    this.handleTransportMessage(event.data, "legacy");
  };

  private handleTransportMessage(
    message: unknown,
    mode: ClipboardTransportMode,
  ): void {
    if (
      this.disposed ||
      !isTransportMessage(message) ||
      message.token !== this.token ||
      message.generation !== this.generation
    ) return;
    if (message.type === "ready") {
      if (mode === "legacy") this.closeTransportPort();
      this.transportMode = mode;
      this.ready = true;
      this.clearInitTimer();
      this.initDeadline = 0;
      return;
    }
    if (!this.ready || mode !== this.transportMode) return;
    this.handleWriteRequest(message, mode);
  }

  private handleWriteRequest(
    request: ClipboardWriteRequest,
    mode: ClipboardTransportMode,
  ): void {
    if (this.seenRequestIds.has(request.requestId)) return;
    this.seenRequestIds.add(request.requestId);
    let ok = true;
    let error = "";
    const clipboard = resolveElectronClipboard(this.options.privilegedWindow);
    if (!clipboard) {
      ok = false;
      error = "Electron clipboard is unavailable.";
    } else {
      try {
        clipboard.writeText(request.text);
      } catch (writeError) {
        ok = false;
        error = errorMessage(writeError);
      }
    }
    const result: ClipboardWriteResult = {
      protocol: MV_AIDE_CLIPBOARD_PROTOCOL,
      schema: MV_AIDE_CLIPBOARD_SCHEMA,
      token: this.token,
      generation: this.generation,
      type: "write-result",
      requestId: request.requestId,
      ok,
      ...(ok ? {} : { error }),
    };
    this.postTransportMessage(result, mode);
  }

  private postTransportMessage(
    message: ClipboardWriteResult,
    mode: ClipboardTransportMode,
  ): void {
    if (mode === "port" && this.transportPort) {
      this.transportPort.postMessage(message);
      return;
    }
    const frameWindow = this.options.frame.contentWindow;
    if (frameWindow && this.targetOrigin) {
      frameWindow.postMessage(message, this.targetOrigin);
    }
  }

  private scheduleInitRetry(delay: number): void {
    if (this.disposed || this.ready) return;
    const owner = this.currentOwnerWindow();
    const boundedDelay = Math.max(0, delay);
    const id = owner.setTimeout(() => {
      this.initTimer = null;
      if (this.disposed || this.ready) return;
      const remaining = this.initDeadline - Date.now();
      if (remaining <= 0) return;
      this.sendInit();
      this.scheduleInitRetry(Math.min(INIT_RETRY_MS, remaining));
    }, boundedDelay);
    this.initTimer = { owner, id, deadline: Date.now() + boundedDelay };
  }

  private clearInitTimer(): void {
    if (!this.initTimer) return;
    this.initTimer.owner.clearTimeout(this.initTimer.id);
    this.initTimer = null;
  }

  private closeTransportPort(): void {
    const port = this.transportPort;
    this.transportPort = null;
    this.transportMode = null;
    if (!port) return;
    port.onmessage = null;
    port.close();
  }
}
