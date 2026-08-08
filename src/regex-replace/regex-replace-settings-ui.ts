import { Setting } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import { t } from "../i18n";
import {
  regexScopeFor,
  type RegexScope,
} from "./regex-replace-types";

/**
 * 在设置面板中渲染单个源码类型（含 md）的正则替换范围下拉：
 * 关闭 / 单文件 / 当前文件夹 / 整个仓库。批量替换时只有落在
 * 各类型范围交集内的文件会参与（settings-tab 在 source-assist
 * 的 profile 面板内调用本函数；UI 层挂载）。
 */
export function renderRegexScopeSetting(
  containerEl: HTMLElement,
  plugin: MvSenceAiIdePlugin,
  extension: string,
): void {
  const isMd = extension === "md";
  const current = isMd
    ? plugin.settings.regexReplace.mdScope
    : regexScopeFor(plugin.settings.regexReplace, extension);

  new Setting(containerEl)
    .setName(t("正则替换范围"))
    .setDesc(
      t("该类型文件允许被正则查找替换触及的最大范围。批量替换时，只有落在各类型范围交集内的文件才会参与。"),
    )
    .addDropdown((dropdown) =>
      dropdown
        .addOption("off", t("（关闭）"))
        .addOption("file", t("单文件"))
        .addOption("folder", t("当前文件夹"))
        .addOption("vault", t("整个仓库"))
        .setValue(current)
        .onChange(async (value) => {
          const scope = value as RegexScope;
          if (isMd) {
            plugin.settings.regexReplace.mdScope = scope;
          } else {
            const profiles = plugin.settings.regexReplace.profiles;
            const target = profiles.find(
              (entry) => entry.extension === extension,
            );
            if (target) {
              target.scope = scope;
            } else {
              profiles.push({ extension, scope });
            }
          }
          await plugin.saveData(plugin.settings);
        }),
    );
}
