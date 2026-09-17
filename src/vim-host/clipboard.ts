import type { VimClipboard, VimRegister } from "../vim/core/types";

interface DesktopClipboard {
  readText(type?: "clipboard" | "selection"): string | Promise<string>;
  writeText(text: string, type?: "clipboard" | "selection"): void | Promise<void>;
  readHTML?(type?: "clipboard" | "selection"): string | Promise<string>;
  write?(data: { text: string; html: string }, type?: "clipboard" | "selection"): void | Promise<void>;
  selection?: DesktopClipboard;
}

const FORMAT = "mv-aide-vim-register";

/** Resolve from the plugin's realm, never from the window currently focused. */
export function createVimClipboard(
  resolve: () => DesktopClipboard = desktopClipboard,
  platform = process.platform,
): VimClipboard {
  const transport = (register: "+" | "*") => {
    const root = resolve();
    const selection = register === "*" && platform === "linux";
    return { api: selection && root.selection ? root.selection : root,
      channel: selection ? "selection" : "clipboard",
      type: selection && !root.selection ? "selection" as const : "clipboard" as const };
  };
  const writes = new Map<string, Promise<void>>();
  return {
    read(register) {
      const { api, type, channel } = transport(register);
      const read = (): VimRegister | Promise<VimRegister> => mapMaybe(api.readText(type), (text) => {
        const plain: VimRegister = { text, kind: text.endsWith("\n") ? "line" : "character" };
        if (!api.readHTML) return plain;
        return mapMaybe(api.readHTML(type), (html): VimRegister => {
          try {
            const encoded = new RegExp(`data-${FORMAT}="([A-Za-z0-9+/=]+)"`, "u").exec(html)?.[1];
            const metadata: unknown = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
            if (isRegister(metadata) && metadata.text === text) return { ...metadata };
          } catch { /* Foreign clipboard data has no verified Vim register metadata. */ }
          return plain;
        });
      });
      const pending = writes.get(channel);
      return pending ? pending.then(read) : read();
    },
    write(register, value) {
      const { api, type, channel } = transport(register);
      // Electron writeBuffer starts a NEW clipboard transaction and erases text.
      // Use the public atomic multi-format API, with inert, escaped HTML carrying
      // type metadata. Foreign copies replace that format and invalidate the type.
      const write = (): void | Promise<void> => api.write && api.readHTML
        ? api.write({ text: value.text, html: `<pre data-${FORMAT}="${Buffer.from(JSON.stringify(value)).toString("base64")}">${escapeHtml(value.text)}</pre>` }, type)
        : api.writeText(value.text, type);
      const pending = writes.get(channel);
      const result = pending ? pending.catch(() => {}).then(write) : write();
      if (result) {
        const tracked = Promise.resolve(result).finally(() => { if (writes.get(channel) === tracked) writes.delete(channel); });
        writes.set(channel, tracked);
        return tracked;
      }
    },
  };
}

function desktopClipboard(): DesktopClipboard {
  const runtimeRequire = Reflect.get(window, "require") as ((id: string) => unknown) | undefined;
  const runtime = runtimeRequire?.("electron") as { clipboard?: DesktopClipboard } | undefined;
  if (!runtime?.clipboard) throw new Error("Electron clipboard runtime is unavailable.");
  return runtime.clipboard;
}

function mapMaybe<T, R>(value: T | Promise<T>, map: (value: T) => R | Promise<R>): R | Promise<R> {
  return value !== null && typeof value === "object" && "then" in value ? Promise.resolve(value).then(map) : map(value);
}

function escapeHtml(text: string): string { return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;"); }

function isRegister(value: unknown): value is VimRegister {
  if (typeof value !== "object" || value === null) return false;
  const register = value as Partial<VimRegister>;
  return typeof register.text === "string" && ["character", "line", "block"].includes(register.kind ?? "")
    && (register.blockWidth === undefined || Number.isSafeInteger(register.blockWidth) && register.blockWidth > 0);
}
