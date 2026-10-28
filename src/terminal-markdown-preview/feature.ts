import { Notice, type App, type Menu } from "obsidian";
import { t } from "../i18n";
import { TerminalPreviewSurface } from "./surface";

/** One controller per terminal; rendering is only started by its menu action. */
export class TerminalMarkdownPreview {
  private surface: TerminalPreviewSurface | null = null;
  private disposed = false;

  constructor(private readonly app: App, private readonly ownerDocument: () => Document) {}

  addMenuItem(menu: Menu, selection: string): void {
    menu.addItem(item => item
      .setTitle(t("Markdown 预览"))
      .setIcon("book-open")
      .setDisabled(!selection)
      .onClick(() => {
        void this.open(selection).catch((error: unknown) => this.reportError(error));
      }));
    menu.addItem(item => item
      .setTitle(t("剪贴板 Markdown 预览"))
      .setIcon("clipboard-paste")
      .onClick(() => {
        void this.openClipboard().catch((error: unknown) => this.reportError(error));
      }));
  }

  private async openClipboard(): Promise<void> {
    if (this.disposed) return;
    const text = await this.ownerDocument().win.navigator.clipboard.readText();
    if (this.disposed) return;
    if (!text) {
      new Notice(t("剪贴板中没有可预览的文本"));
      return;
    }
    await this.open(text);
  }

  private reportError(error: unknown): void {
    console.error("[mv-aide] Could not open terminal Markdown preview", error);
    new Notice(t("Markdown 预览操作失败：{error}", {
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async open(text: string): Promise<void> {
    if (this.disposed || !text) return;
    if (this.surface && (this.surface.isClosing || this.surface.ownerDocument !== this.ownerDocument())) {
      await this.surface.close();
    }
    if (this.disposed) return;
    if (!this.surface) {
      const surface = new TerminalPreviewSurface(this.app, this.ownerDocument(), () => {
        if (this.surface === surface) this.surface = null;
      });
      this.surface = surface;
    }
    await this.surface.show(text);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.surface?.close();
  }
}
