import { MarkdownView, Notice } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import { TERMINAL_VIEW_TYPE } from "../constants";
import { t } from "../i18n";
import { mvRunPrefixesFor } from "./mv-run-types";
import { extractMvRunCommands } from "./mv-run-parser";
import { TerminalView } from "./terminal-view";

/** 手动触发「运行文件底部指令」：解析当前文件的 mv-run 注释指令并逐行送入终端。 */
export async function runFileBottomCommand(
  plugin: MvSenceAiIdePlugin,
  activeView?: MarkdownView,
): Promise<void> {
  // editorCallback 已传入触发命令的视图，优先使用；缺省回退到当前活跃视图
  const view =
    activeView ?? plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) {
    new Notice(t("当前没有打开的 Markdown 视图"));
    return;
  }
  const prefixes = mvRunPrefixesFor(plugin.settings.mvRun, view.file.extension);
  if (prefixes.length === 0) {
    new Notice(t("未配置该文件类型的指令注释前缀"));
    return;
  }
  const commands = extractMvRunCommands(view.editor.getValue(), prefixes);
  if (commands.length === 0) {
    new Notice(t("未在文件中找到 mv-run 指令"));
    return;
  }

  // 无终端则新建、有则聚焦；命令发送到新激活的终端（而非最早打开的旧终端）。
  const leaf = await plugin.activateTerminalView();
  const terminalView =
    leaf?.view instanceof TerminalView
      ? leaf.view
      : plugin.app.workspace.getActiveViewOfType(TerminalView);
  if (!terminalView) return;
  for (const command of commands) {
    terminalView.sendInput(`${command}\r`);
  }
}
