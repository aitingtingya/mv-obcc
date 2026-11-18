import { Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import type { VimFeatureStatus } from "../public";
export interface VimScriptSettingsActions {
  status(): VimFeatureStatus;
  openDirectory(): Promise<void>;
  reload(): Promise<void>;
}
/** The collapsed section has no watchers and constructs its contents only when opened. */
export function renderVimScriptSettings(
  container: HTMLElement,
  actions: VimScriptSettingsActions,
): void {
  const details = container.createEl("details", { cls: "mv-aide-vim-scripts" });
  details.createEl("summary", { text: t("Vim 脚本") });
  const content = details.createDiv();
  let mounted = false;
  const render = () => {
    content.empty();
    const status = actions.status(),
      scripts = status.scripts;
    new Setting(content)
      .setName(t("脚本目录"))
      .setDesc(
        t(
          "将脚本放入 mv-aide/vim/ 的 plugin、autoload、ftplugin、after 或 pack 目录。",
        ),
      )
      .addButton((button) =>
        button
          .setButtonText(t("打开目录"))
          .setDisabled(status.state !== "enabled")
          .onClick(async () => {
            try {
              await actions.openDirectory();
            } catch (error) {
              new Notice(String(error), 6000);
            }
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("重新加载脚本"))
          .setDisabled(status.state !== "enabled")
          .onClick(async () => {
            try {
              await actions.reload();
              render();
            } catch (error) {
              new Notice(String(error), 6000);
            }
          }),
      );
    content.createEl("p", {
      text: scripts?.pendingReload
        ? t("脚本有变化，重新加载后生效。")
        : t("脚本随 Vim 启用；整套重载会重新初始化脚本变量。"),
    });
    content.createEl("h4", { text: t("已加载脚本") });
    const files = content.createEl("ul");
    for (const file of status.loadedFiles) files.createEl("li", { text: file });
    if (scripts?.errors.length) {
      content.createEl("h4", { text: t("脚本错误") });
      for (const error of scripts.errors)
        content.createEl("pre", { text: error });
    }
    const capabilities = content.createEl("details");
    capabilities.createEl("summary", { text: t("支持的脚本能力") });
    for (const [label, entries] of [
      [t("函数"), scripts?.functions],
      [t("命令"), scripts?.commands],
      [t("事件"), scripts?.events],
      [t("选项"), scripts?.options],
    ] as const) {
      if (entries)
        capabilities.createEl("p", {
          text: `${label}: ${[...entries].sort().join(", ")}`,
        });
    }
  };
  details.addEventListener("toggle", () => {
    if (details.open && !mounted) {
      mounted = true;
      render();
    }
  });
}
