import { type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const themeConfig = {
  background: "var(--background-primary)",
  foreground: "var(--text-normal)",
  selection: "var(--text-selection)",
  cursor: "var(--text-normal)",
  dropdownBackground: "var(--background-primary)",
  dropdownBorder: "var(--background-modifier-border)",
  activeLine: "var(--background-primary)",
  matchingBracket: "var(--background-modifier-accent)",
  keyword: "#d73a49",
  variable: "var(--text-normal)",
  parameter: "var(--text-accent-hover)",
  function: "var(--text-accent-hover)",
  string: "var(--text-accent)",
  constant: "var(--text-accent-hover)",
  type: "var(--text-accent-hover)",
  class: "#6f42c1",
  number: "var(--text-accent-hover)",
  comment: "var(--text-faint)",
  heading: "var(--text-accent-hover)",
  invalid: "var(--text-error)",
  regexp: "var(--text-accent)",
};

const obsidianTheme = EditorView.theme({
  "&": {
    backgroundColor: themeConfig.background,
    color: themeConfig.foreground,
  },
  ".cm-content": {
    caretColor: themeConfig.cursor,
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: themeConfig.cursor,
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, & ::selection": {
    backgroundColor: themeConfig.selection,
  },
  ".cm-panels": {
    backgroundColor: themeConfig.dropdownBackground,
    color: themeConfig.foreground,
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "2px solid var(--background-modifier-border)",
  },
  ".cm-panels.cm-panels-bottom": {
    borderTop: "2px solid var(--background-modifier-border)",
  },
  ".cm-searchMatch": {
    backgroundColor: themeConfig.dropdownBackground,
    outline: `1px solid ${themeConfig.dropdownBorder}`,
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: themeConfig.selection,
  },
  ".cm-activeLine": {
    backgroundColor: themeConfig.activeLine,
  },
  ".cm-activeLineGutter": {
    backgroundColor: themeConfig.background,
  },
  ".cm-selectionMatch": {
    backgroundColor: themeConfig.selection,
  },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: themeConfig.matchingBracket,
    outline: "none",
  },
  ".cm-gutters": {
    backgroundColor: themeConfig.background,
    borderRight: "1px solid var(--background-modifier-border)",
    color: themeConfig.comment,
  },
  ".cm-lineNumbers, .cm-gutterElement": {
    color: "inherit",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "transparent",
    border: "none",
    color: themeConfig.foreground,
  },
  ".cm-tooltip": {
    backgroundColor: themeConfig.dropdownBackground,
    border: `1px solid ${themeConfig.dropdownBorder}`,
    color: themeConfig.foreground,
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    "& > ul > li[aria-selected]": {
      background: themeConfig.selection,
      color: themeConfig.foreground,
    },
  },
  ".cm-textfield": {
    backgroundColor: themeConfig.background,
    color: themeConfig.foreground,
  },
  ".cm-button": {
    backgroundColor: themeConfig.background,
    backgroundImage: "none",
    color: themeConfig.foreground,
  },
});

const obsidianHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: themeConfig.keyword },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: themeConfig.variable },
  { tag: [t.propertyName], color: themeConfig.function },
  { tag: [t.processingInstruction, t.string, t.inserted, t.special(t.string)], color: themeConfig.string },
  { tag: [t.function(t.variableName), t.labelName], color: themeConfig.function },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: themeConfig.constant },
  { tag: [t.definition(t.name), t.separator], color: themeConfig.variable },
  { tag: [t.className], color: themeConfig.class },
  { tag: [t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: themeConfig.number },
  { tag: [t.typeName], color: themeConfig.type },
  { tag: [t.operator, t.operatorKeyword], color: themeConfig.keyword },
  { tag: [t.url, t.escape, t.regexp, t.link], color: themeConfig.regexp },
  { tag: [t.meta, t.comment], color: themeConfig.comment },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.heading, color: themeConfig.heading, fontWeight: "bold" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: themeConfig.variable },
  { tag: t.invalid, color: themeConfig.invalid },
  { tag: t.strikethrough, textDecoration: "line-through" },
]);

export const sourceAssistSnippetsEditorTheme: Extension = [
  obsidianTheme,
  syntaxHighlighting(obsidianHighlightStyle),
];
