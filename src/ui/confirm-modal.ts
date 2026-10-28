import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export interface ConfirmActionOptions {
  /** 弹窗标题（走 i18n，调用方传入中文源串）。 */
  title: string;
  /** 可选说明文字，展示在标题下方。 */
  message?: string;
  /** 确认按钮文案，默认 t("确认")。 */
  confirmText?: string;
  /** 取消按钮文案，默认 t("取消")。 */
  cancelText?: string;
  /** 确认按钮是否使用警告色（危险操作），默认 true。 */
  warning?: boolean;
}

/**
 * 设置区统一的危险操作确认弹窗。样式与 ConfirmDisablePmModal 一致：
 * 标题 + 描述 + 取消 / 警告色确认。
 *
 * resolve(true) 仅发生在用户点确认；点取消、Esc、点遮罩关闭一律
 * resolve(false)。调用方用法：
 *
 * ```ts
 * if (!(await confirmAction(this.app, { title: t("删除模板"), message: ... }))) return;
 * ```
 */
export function confirmAction(
  app: App,
  options: ConfirmActionOptions,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = new (class extends Modal {
      onOpen(): void {
        this.setTitle(options.title);
        if (options.message) {
          this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: options.message,
          });
        }
        new Setting(this.contentEl)
          .addButton((btn) =>
            btn
              .setButtonText(options.cancelText ?? t("取消"))
              .onClick(() => this.close()),
          )
          .addButton((btn) => {
            btn.setButtonText(options.confirmText ?? t("确认"));
            if (options.warning !== false) btn.setWarning();
            btn.onClick(() => {
              settle(true);
              this.close();
            });
          });
      }

      onClose(): void {
        this.contentEl.empty();
        settle(false);
      }
    })(app);
    modal.open();
  });
}
