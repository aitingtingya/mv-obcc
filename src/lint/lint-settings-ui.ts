import { Setting } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import { t } from "../i18n";

/**
 * 在设置面板中渲染单个源码类型的 Lint 命令输入框 + Lint 常驻开关
 * （settings-tab 在 source-assist 的 profile 面板内调用本函数；UI 层挂载，
 * 不碰 source-assist 逻辑）。
 */
export function renderLintSetting(
  containerEl: HTMLElement,
  plugin: MvSenceAiIdePlugin,
  extension: string,
): void {
  const profiles = plugin.settings.sourceLint.profiles;
  const profile = profiles.find((entry) => entry.extension === extension);

  new Setting(containerEl)
    .setName(t("Lint 命令"))
    .setDesc(
      t("留空则跳过该类型的 Lint。手动触发「Lint 当前文件」时执行。支持 {file} 占位符（当前文件路径，自动带引号）；无 {file} 时追加到命令末尾。输出需符合 文件:行:列: 消息（列号可省）。示例：chktex -f%f -v0 {file}；ruff check --output-format=concise {file}"),
    )
    .addText((text) =>
      text
        .setPlaceholder(t("如 ruff check --output-format=concise {file}"))
        .setValue(profile?.command ?? "")
        .onChange(async (value) => {
          const target = profiles.find(
            (entry) => entry.extension === extension,
          );
          if (target) {
            target.command = value;
          } else {
            profiles.push({ extension, command: value, persistent: false });
          }
          await plugin.saveData(plugin.settings);
        }),
    );

  new Setting(containerEl)
    .setName(t("Lint 常驻"))
    .setDesc(
      t("该类型源码文件打开即自动 Lint，编辑停顿后自动更新；可用命令对单个文件单独开启/关闭。"),
    )
    .addToggle((toggle) =>
      toggle
        .setValue(profile?.persistent ?? false)
        .onChange(async (value) => {
          const target = profiles.find(
            (entry) => entry.extension === extension,
          );
          if (target) {
            target.persistent = value;
          } else {
            profiles.push({ extension, command: "", persistent: value });
          }
          await plugin.saveData(plugin.settings);
        }),
    );
}
