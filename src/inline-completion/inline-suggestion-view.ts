import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

import { inlineSuggestionField } from "./inline-suggestion-state";

/**
 * Renders the current inline suggestion as ghost text via a CodeMirror widget
 * decoration, placed just after the cursor (`side: 1`).
 */

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostTextWidget): boolean {
    return other.text === this.text;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.textContent = this.text;
    span.className = "mv-senceai-ghost-text";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const none: DecorationSet = Decoration.none;

export const inlineSuggestionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = none;

    update(update: import("@codemirror/view").ViewUpdate): void {
      const suggestion = update.state.field(inlineSuggestionField, false);
      if (!suggestion || !suggestion.text) {
        if (this.decorations.size) this.decorations = none;
        return;
      }
      const widget = Decoration.widget({
        widget: new GhostTextWidget(suggestion.text),
        side: 1,
        inlineOrder: true,
      });
      this.decorations = Decoration.set([
        widget.range(Math.min(suggestion.from, update.state.doc.length)),
      ]);
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export type { EditorView };
