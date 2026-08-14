import { Modal, type App } from "obsidian";
import { t } from "./i18n";
import type { FileSymlinkFailure } from "./file-symlink-service";

export type ExternalFileSymlinkFallbackDecision =
  | "repair-and-retry"
  | "retry"
  | "managed-copy"
  | "cancel";

export interface ExternalFileSymlinkFallbackModalOptions {
  app: App;
  failure: FileSymlinkFailure;
  message: string;
  platform?: NodeJS.Platform;
  openDeveloperSettings?: () => Promise<void>;
}

/**
 * Presents choices after a verified symlink attempt has already failed.
 * This UI never creates or synchronizes a managed copy itself; it only returns
 * the user's explicit decision to the opener orchestration layer.
 */
export class ExternalFileSymlinkFallbackModal extends Modal {
  private settled = false;
  private readonly returnFocusEl: HTMLElement | null;

  constructor(
    private readonly options: ExternalFileSymlinkFallbackModalOptions,
    private readonly resolveDecision: (
      decision: ExternalFileSymlinkFallbackDecision,
    ) => void,
  ) {
    super(options.app);
    const activeElement = this.modalEl.ownerDocument.activeElement;
    this.returnFocusEl = activeElement
      && activeElement !== this.modalEl.ownerDocument.body
      && typeof (activeElement as HTMLElement).focus === "function"
      ? activeElement as HTMLElement
      : null;
  }

  onOpen(): void {
    const { contentEl } = this;
    const platform = this.options.platform ?? process.platform;
    this.modalEl.classList.add("mv-aide-symlink-modal");
    this.modalEl.setAttribute("aria-busy", "false");
    contentEl.empty();
    contentEl.createEl("h3", {
      text: platform === "win32"
        ? t("Windows 符号链接创建失败")
        : t("符号链接创建失败"),
    });
    const statusEl = contentEl.createEl("p", {
      text: this.options.message,
      cls: "setting-item-description mv-aide-status-error",
    });
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.setAttribute("aria-atomic", "true");
    contentEl.createEl("p", {
      text: t("插件仍会优先重试真实符号链接。只有您明确选择后，才会为本机启用独立的受管临时副本；启用后的日常打开和同步保持静默，仅在双方同时编辑冲突时询问。"),
      cls: "setting-item-description",
    });

    const buttonRow = contentEl.createDiv({ cls: "mv-aide-modal-button-row" });
    if (platform === "win32" && this.options.failure.reason === "permission-denied") {
      const repairButton = buttonRow.createEl("button", {
        text: t("管理员修复并重试"),
      });
      repairButton.addClass("mod-cta");
      repairButton.addEventListener("click", () => {
        this.finish("repair-and-retry");
      });
    }
    if (platform === "win32" && this.options.openDeveloperSettings) {
      const settingsButton = buttonRow.createEl("button", {
        text: t("打开开发者设置"),
      });
      settingsButton.addEventListener("click", () => {
        settingsButton.disabled = true;
        this.modalEl.setAttribute("aria-busy", "true");
        void this.options.openDeveloperSettings!().finally(() => {
          settingsButton.disabled = false;
          this.modalEl.setAttribute("aria-busy", "false");
          if (settingsButton.isConnected) {
            settingsButton.focus({ preventScroll: true });
          }
        });
      });
    }
    const retryButton = buttonRow.createEl("button", { text: t("重新检测") });
    retryButton.addEventListener("click", () => this.finish("retry"));

    const fallbackButton = buttonRow.createEl("button", {
      text: t("使用受管临时副本并打开"),
    });
    fallbackButton.addEventListener("click", () => this.finish("managed-copy"));

    const cancelButton = buttonRow.createEl("button", { text: t("取消") });
    cancelButton.addEventListener("click", () => this.finish("cancel"));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveDecision("cancel");
    }
    const returnFocusEl = this.returnFocusEl;
    queueMicrotask(() => {
      if (returnFocusEl?.isConnected) {
        returnFocusEl.focus({ preventScroll: true });
      }
    });
  }

  private finish(decision: ExternalFileSymlinkFallbackDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision(decision);
    this.close();
  }
}

export function requestExternalFileSymlinkFallbackDecision(
  options: ExternalFileSymlinkFallbackModalOptions,
): Promise<ExternalFileSymlinkFallbackDecision> {
  return new Promise((resolve) => {
    new ExternalFileSymlinkFallbackModal(options, resolve).open();
  });
}
