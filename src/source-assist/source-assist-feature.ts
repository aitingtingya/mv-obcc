import { Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import type { SourceAssistSettings } from "../types";
import { texDisplayMathPreviewExtension } from "./tex-math-preview";
import {
  buildLatexSuiteProfileRuntime,
  type LatexSuiteProfileRuntime,
} from "./latex-suite-blackbox";
import { sourceAssistTexEnhancedRenderEnabled } from "./source-assist-settings";

export class SourceAssistFeature {
  readonly extensions: Extension[] = [];
  private rebuildGeneration = 0;

  constructor(private readonly plugin: MvSenceAiIdePlugin) {}

  async load(): Promise<void> {
    await this.rebuild();
  }

  async settingsChanged(): Promise<void> {
    await this.rebuild();
  }

  private async rebuild(): Promise<void> {
    const generation = ++this.rebuildGeneration;
    const runtime = await buildLatexSuiteProfileRuntime(
      this.plugin,
      this.plugin.settings.sourceAssist,
    );
    if (generation !== this.rebuildGeneration) return;
    const next = this.sourceAssistExtensions(runtime);
    this.extensions.splice(0, this.extensions.length, ...next);
    this.plugin.app.workspace.updateOptions();
  }

  private sourceAssistExtensions(runtime: LatexSuiteProfileRuntime): Extension[] {
    if (!this.plugin.settings.sourceAssist.enabled) return [];
    const profileCompartment = new Compartment();
    return [
      profileCompartment.of([]),
      sourceAssistProfileRouter(profileCompartment, runtime),
      sourceAssistTexEnhancedRenderEnabled(this.plugin.settings.sourceAssist)
        ? texDisplayMathPreviewExtension({
            positionIsAbove:
              this.plugin.settings.sourceAssist.mathPreviewPositionIsAbove,
            cursor: this.plugin.settings.sourceAssist.mathPreviewCursor,
          })
        : [],
    ];
  }
}

function sourceAssistProfileRouter(
  profileCompartment: Compartment,
  runtime: LatexSuiteProfileRuntime,
): Extension {
  return ViewPlugin.fromClass(
    class {
      private currentFileExtension = "";
      private updateQueued = false;

      constructor(private readonly view: EditorView) {
        this.queueProfileUpdate();
      }

      update(update: ViewUpdate): void {
        const next = currentFileExtension(update.view);
        if (
          next !== this.currentFileExtension ||
          editorFileChanged(update)
        ) {
          this.queueProfileUpdate();
        }
      }

      private queueProfileUpdate(): void {
        if (this.updateQueued) return;
        this.updateQueued = true;
        queueMicrotask(() => {
          this.updateQueued = false;
          const next = currentFileExtension(this.view);
          if (next === this.currentFileExtension) return;
          this.currentFileExtension = next;
          this.view.dispatch({
            effects: profileCompartment.reconfigure(
              runtime.extensionsByFileExtension[next] ?? [],
            ),
          });
        });
      }
    },
  );
}

function currentFileExtension(view: EditorView): string {
  return (
    view.state.field(editorInfoField, false)?.file?.extension?.toLowerCase() ??
    "md"
  );
}

function editorFileChanged(update: ViewUpdate): boolean {
  return (
    update.startState.field(editorInfoField, false)?.file !==
    update.state.field(editorInfoField, false)?.file
  );
}
