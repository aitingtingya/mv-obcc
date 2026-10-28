import type { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** In-memory only. Invalid, not-yet-saved text survives a local settings redraw. */
export class SettingsEditorDrafts {
  private readonly keys = new WeakMap<EditorView, string>();
  private readonly drafts = new Map<string, {
    value: string; selection: EditorSelection; top: number; left: number; focused: boolean;
  }>();

  value(key: string, saved: string): string { return this.drafts.get(key)?.value ?? saved; }

  attach(key: string, view: EditorView): void {
    this.keys.set(view, key);
    const draft = this.drafts.get(key);
    if (!draft) return;
    view.dispatch({ selection: draft.selection });
    view.scrollDOM.scrollTop = draft.top;
    view.scrollDOM.scrollLeft = draft.left;
    if (draft.focused) view.focus();
  }

  capture(view: EditorView): void {
    const key = this.keys.get(view);
    if (!key) return;
    this.drafts.set(key, { value: view.state.doc.toString(), selection: view.state.selection,
      top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, focused: view.hasFocus });
    this.keys.delete(view);
  }

  clear(): void { this.drafts.clear(); }
}
