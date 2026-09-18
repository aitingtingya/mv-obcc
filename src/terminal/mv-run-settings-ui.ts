import { Setting } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { getLanguage, t } from "../i18n";
import { MV_RUN_DOC_URL } from "./mv-run-types";

/**
 * 在设置面板中渲染单个源码类型的「指令注释前缀」输入框（settings-tab 在
 * source-assist 的 profile 面板内调用本函数；UI 层挂载，不碰 source-assist 逻辑）。
 * 行右侧的文档按钮按界面语言打开 GitHub 手册的 mv-run 语法章节。
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
      t("用于命令「运行 mv-run 指令」：扫描本类型文件中以前缀开头的注释指令行（如 # mv-run: python main.py），在弹窗中选择默认或指定顺序后送入集成终端逐条执行。多个前缀用分号分隔（Python 填 #;#:，Markdown 填 <!--，TeX 填 %，JS 填 //）；<!-- 与 /* 前缀会连同 --> 与 */ 结尾一起识别。留空则禁用该类型。命名、分组与顺序语法见右侧文档按钮。"),
    )
    .addExtraButton((button) =>
      button
        .setIcon("book-open")
        .setTooltip(t("查看 mv-run 语法文档"))
        .onClick(() => {
          window.open(MV_RUN_DOC_URL[getLanguage()], "_blank");
        }),
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
