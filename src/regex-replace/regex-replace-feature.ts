import { openSearchPanel, search } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, Notice } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import { t } from "../i18n";
import { regexScopeFor } from "./regex-replace-types";
import { scopeRank } from "./regex-scope";
import { RegexReplaceModal } from "./regex-replace-modal";

/**
 * 正则查找替换（P0-3，分层设计）：
 * - 单文件层：CodeMirror 原生搜索面板（自带正则开关、逐个/全部替换），
 *   文件类型的范围上限达到 "file" 才可用；
 * - 多文件层：RegexReplaceModal，当前文件夹/全库扫描 + 预览确认，
 *   每个文件按"类型上限 ∩ 请求范围"交集决定是否参与。
 */
export class RegexReplaceFeature {
  readonly extensions: Extension[];

  constructor(private readonly plugin: MvSenceAiIdePlugin) {
    this.extensions = [search({ top: true })];
  }

  registerCommands(): void {
    // 幂等：语言切换后重注册不会重复。
    this.plugin.removeCommand("regex-replace-current-file");
    this.plugin.removeCommand("regex-replace-multi-file");

    this.plugin.addCommand({
      id: "regex-replace-current-file",
      name: t("正则查找替换（当前文件）"),
      editorCallback: (_editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        const scope = regexScopeFor(
          this.plugin.settings.regexReplace,
          view.file.extension,
        );
        if (scopeRank(scope) < scopeRank("file")) {
          new Notice(t("该文件类型的正则替换已在设置中关闭"));
          return;
        }
        const cm = (view.editor as unknown as { cm?: EditorView }).cm;
        if (!cm) {
          new Notice(t("请在源码模式下使用正则替换"));
          return;
        }
        openSearchPanel(cm);
      },
    });

    this.plugin.addCommand({
      id: "regex-replace-multi-file",
      name: t("正则查找替换（多文件）"),
      callback: () => {
        const file = this.plugin.app.workspace.getActiveFile();
        if (!file) {
          new Notice(t("请先打开一个文件作为范围锚点"));
          return;
        }
        new RegexReplaceModal(this.plugin, file).open();
      },
    });
  }
}
