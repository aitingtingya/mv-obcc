import path from "node:path";
import { MarkdownView } from "obsidian";
import { RangeSet, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { GitFeature } from "./feature";

/** Editor-side Git presentation: change markers and current-line blame. Both default off and never touch other editor chains. */

function editorFile(feature: GitFeature, view: EditorView): string | null {
  const snapshot = feature.repository.snapshot;
  if (!snapshot) return null;
  let found: string | null = null;
  feature.plugin.app.workspace.iterateAllLeaves(leaf => {
    const leafView = leaf.view;
    if (found || !(leafView instanceof MarkdownView) || !leafView.file) return;
    if ((leafView.editor as unknown as { cm?: EditorView }).cm !== view) return;
    const relative = path.relative(snapshot.root, path.join(feature.repository.vaultRoot, leafView.file.path));
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) found = relative;
  });
  return found;
}

const NO_MARKERS = RangeSet.empty as RangeSet<GitMarker>;

class GitMarker extends GutterMarker {
  constructor(readonly cls: string) { super(); }
  toDOM(view: EditorView): HTMLElement {
    const el = (view.dom.ownerDocument ?? document).createElement("div");
    el.className = `mv-git-gutter-marker ${this.cls}`;
    return el;
  }
}

class MarkerPlugin {
  markers: RangeSet<GitMarker> = NO_MARKERS;
  private timer: number | null = null;
  private revision = -1;
  private generation = 0;
  constructor(readonly view: EditorView, readonly feature: GitFeature) { this.schedule(50); }
  update(update: ViewUpdate): void {
    const revision = this.feature.repository.snapshot?.revision ?? -1;
    if (update.docChanged || revision !== this.revision) this.schedule(600);
  }
  private schedule(delay: number): void {
    if (this.timer !== null) return;
    const win = this.view.dom.ownerDocument?.defaultView ?? window;
    this.timer = win.setTimeout(() => { this.timer = null; void this.recompute(); }, delay);
  }
  private clear(revision: number): void {
    this.revision = revision;
    if (this.markers !== NO_MARKERS) { this.markers = NO_MARKERS; this.view.dispatch({}); }
  }
  private async recompute(): Promise<void> {
    const feature = this.feature, generation = ++this.generation;
    const revision = feature.repository.snapshot?.revision ?? -1;
    if (!feature.settings.enabled || !feature.settings.editMarkers) { this.clear(revision); return; }
    const file = editorFile(feature, this.view);
    if (!file) { this.clear(revision); return; }
    const marks = await feature.repository.lineMarkers(file).catch(() => null);
    if (generation !== this.generation) return;
    this.revision = feature.repository.snapshot?.revision ?? -1;
    const builder = new RangeSetBuilder<GitMarker>();
    if (marks) {
      const doc = this.view.state.doc;
      const added = new GitMarker("is-added"), modified = new GitMarker("is-modified"), deleted = new GitMarker("is-deleted");
      const positions: [number, GitMarker][] = [];
      for (const line of marks.added) positions.push([line, added]);
      for (const line of marks.modified) positions.push([line, modified]);
      for (const line of marks.deletedAfter) positions.push([line, deleted]);
      positions.sort((a, b) => a[0] - b[0]);
      for (const [line, marker] of positions) {
        if (line < 1 || line > doc.lines) continue;
        builder.add(doc.line(line).from, doc.line(line).from, marker);
      }
    }
    this.markers = builder.finish();
    this.view.dispatch({});
  }
  destroy(): void {
    const win = this.view.dom.ownerDocument?.defaultView ?? window;
    if (this.timer !== null) win.clearTimeout(this.timer);
    this.generation++;
  }
}

class BlameWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: BlameWidget): boolean { return other.text === this.text; }
  toDOM(view: EditorView): HTMLElement {
    const el = (view.dom.ownerDocument ?? document).createElement("span");
    el.className = "mv-git-line-blame";
    el.textContent = this.text;
    return el;
  }
}

class BlamePlugin {
  decorations: DecorationSet = Decoration.none;
  private cache = new Map<string, string | null>();
  private pending = "";
  private generation = 0;
  private lastKey = "";
  constructor(readonly view: EditorView, readonly feature: GitFeature) {}
  update(update: ViewUpdate): void {
    const feature = this.feature;
    const revision = feature.repository.snapshot?.revision ?? -1;
    const off = !feature.settings.enabled || !feature.settings.lineBlame;
    if (off) { this.lastKey = ""; if (this.decorations !== Decoration.none) this.decorations = Decoration.none; return; }
    const line = update.state.doc.lineAt(update.state.selection.main.head).number;
    const stateKey = `${revision}:${line}`;
    if (!update.selectionSet && !update.docChanged && stateKey === this.lastKey) return;
    this.lastKey = stateKey;
    const file = editorFile(feature, this.view);
    if (!file) { if (this.decorations !== Decoration.none) this.decorations = Decoration.none; return; }
    const cacheKey = `${revision}:${file}:${line}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      const end = update.state.doc.line(line).to;
      this.decorations = Decoration.set([Decoration.widget({ widget: new BlameWidget(cached), side: 1 }).range(end)]);
      return;
    }
    if (this.decorations !== Decoration.none) this.decorations = Decoration.none;
    if (cached === null || this.pending === cacheKey) return;
    this.pending = cacheKey;
    const generation = ++this.generation;
    void feature.repository.blameLine(file, line).catch(() => null).then(text => {
      if (this.generation !== generation) return;
      this.pending = "";
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(cacheKey, text);
      this.view.dispatch({});
    });
  }
  destroy(): void { this.generation++; }
}

export function gitEditorExtensions(feature: GitFeature): Extension[] {
  const markerPlugin = ViewPlugin.define(view => new MarkerPlugin(view, feature));
  return [
    gutter({ class: "mv-git-gutter", markers: view => view.plugin(markerPlugin)?.markers ?? RangeSet.empty }),
    markerPlugin,
    ViewPlugin.define(view => new BlamePlugin(view, feature), { decorations: plugin => plugin.decorations }),
  ];
}
