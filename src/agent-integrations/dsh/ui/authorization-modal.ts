import { Modal, Notice, Setting, type App } from "obsidian";
import { t } from "../../../i18n";

class DshAuthorizationModal extends Modal {
  private value = "";
  private settled = false;
  constructor(app: App, private readonly settle: (value: string | null) => void) { super(app); }

  onOpen(): void {
    this.setTitle(t("使用 DSH 授权 URL 重新连接"));
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("粘贴原 DSH 进程启动时输出的完整授权 URL。启动令牌只用于本次连接，不会保存到磁盘或日志。"),
    });
    new Setting(this.contentEl)
      .setName(t("DSH 授权 URL"))
      .addText((text) => {
        text.setPlaceholder(t("粘贴完整授权 URL")).onChange((value) => { this.value = value.trim(); });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); this.submit(); }
        });
        text.inputEl.focus();
      });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("取消")).onClick(() => this.close()))
      .addButton((button) => button.setButtonText(t("重新连接")).setCta().onClick(() => this.submit()));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.settle(null);
  }

  private submit(): void {
    if (this.settled) return;
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[?][^#]*\btoken=/iu.test(this.value)) {
      new Notice(t("请输入 DSH 输出的本机完整授权 URL。"));
      return;
    }
    this.settled = true;
    this.settle(this.value);
    this.close();
  }
}

export function promptDshAuthorizationUrl(app: App): Promise<string | null> {
  return new Promise((resolve) => new DshAuthorizationModal(app, resolve).open());
}
