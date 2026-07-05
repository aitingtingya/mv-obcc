import {
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import {
  highlightSelectionMatches,
  searchKeymap,
} from "@codemirror/search";
import { lintKeymap } from "@codemirror/lint";
import { ExtraButtonComponent } from "obsidian";
import { sourceAssistSnippetsEditorTheme } from "./snippets-editor-theme";

export interface SourceAssistSnippetsEditorOptions {
  containerEl: HTMLElement;
  footerEl: HTMLElement;
  initialValue: string;
  validate: (value: string) => Promise<void>;
  onValidChange: (value: string) => Promise<void>;
}

export function createSourceAssistSnippetsEditor({
  containerEl,
  footerEl,
  initialValue,
  validate,
  onValidChange,
}: SourceAssistSnippetsEditorOptions): EditorView {
  const validity = footerEl.createDiv("mv-senceai-snippets-editor-validity");
  const validityIndicator = new ExtraButtonComponent(validity);
  validityIndicator
    .setIcon("checkmark")
    .extraSettingsEl.addClass("mv-senceai-snippets-editor-validity-indicator");

  const validityText = validity.createDiv({
    cls: "mv-senceai-snippets-editor-validity-text setting-item-description",
  });
  let validationRun = 0;

  const updateValidityIndicator = (success: boolean, message?: string) => {
    validityIndicator.setIcon(success ? "checkmark" : "cross");
    validityIndicator.extraSettingsEl.removeClass(success ? "invalid" : "valid");
    validityIndicator.extraSettingsEl.addClass(success ? "valid" : "invalid");
    validityText.setText(
      success ? "已保存" : message ?? "语法无效，已保留上一次合法 snippets",
    );
  };

  const validateAndSave = async (value: string, silent = false) => {
    const run = ++validationRun;
    try {
      await validate(value);
      if (run !== validationRun) return;
      updateValidityIndicator(true);
      await onValidChange(value);
    } catch (error) {
      if (run !== validationRun) return;
      if (!silent) {
        updateValidityIndicator(false);
        console.error("[mv-senceai-ide] Invalid source assist snippets.", error);
      }
    }
  };

  const extensions = [
    ...sourceAssistSnippetsEditorBasicSetup,
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged) return;
      void validateAndSave(update.state.doc.toString());
    }),
  ];

  const view = new EditorView({
    parent: containerEl,
    state: EditorState.create({ doc: initialValue, extensions }),
  });

  void validateAndSave(initialValue, true);
  return view;
}

const sourceAssistSnippetsEditorBasicSetup: Extension[] = [
  lineNumbers(),
  highlightSpecialChars(),
  history(),
  javascript(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  indentUnit.of("    "),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  EditorView.lineWrapping,
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  highlightSelectionMatches(),
  sourceAssistSnippetsEditorTheme,
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    indentWithTab,
    ...lintKeymap,
  ]),
];
