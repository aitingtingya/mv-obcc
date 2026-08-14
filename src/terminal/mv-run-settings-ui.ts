import { Setting } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { t } from "../i18n";

/**
 * 在设置面板中渲染单个源码类型的「指令注释前缀」输入框（settings-tab 在
 * source-assist 的 profile 面板内调用本函数；UI 层挂载，不碰 source-assist 逻辑）。
 */
export function renderMvRunSetting(
  containerEl: HTMLElement,
  plugin: MvAideIdePlugin,
  extension: string,
): void {
  const profiles = plugin.settings.mvRun.profiles;
  const existing = profiles.find((profile) => profile.extension === extension);
  new Setting(containerEl)
    .setName(t("指令注释前缀"))
    .setDesc(
      t("用于「运行文件底部指令」：文件注释里的 mv-run: <命令> 行会发送到终端。填写该文件类型的注释前缀，多个用分号分隔（如 Python 填 #;#:，Markdown 填 <!--，TeX 填 %，JS 填 //）。留空则禁用该类型。"),
    )
    .addText((text) =>
      text
        .setPlaceholder(t("如 #;#: 或 <!-- 或 %"))
        .setValue(existing?.prefixes ?? "")
        .onChange(async (value) => {
          const target = profiles.find(
            (profile) => profile.extension === extension,
          );
          if (target) {
            target.prefixes = value;
          } else {
            profiles.push({ extension, prefixes: value });
          }
          await plugin.saveData(plugin.settings);
        }),
    );
}
