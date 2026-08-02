import { Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import type { SourceAssistSettings } from "../types";
import {
  EMPTY_TEX_MATH_CUSTOM_CONFIG,
  parseTexMathFormats,
  texMathAnalysisExtension,
  type TexMathCustomConfig,
} from "./tex-math";
import { texMathLatexSuiteBridgeExtension } from "./tex-math-latex-suite-bridge";
import { texDisplayMathPreviewExtension } from "./tex-math-preview";
import {
  buildLatexSuiteProfileRuntime,
  type LatexSuiteProfileRuntime,
} from "./latex-suite-blackbox";
import {
  EMPTY_LATEX_SUITE_SNIPPETS,
  sourceAssistTexEnhancedRenderEnabled,
} from "./source-assist-settings";

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
    const mathConfig = await this.texMathConfig();
    if (generation !== this.rebuildGeneration) return;
    const next = this.sourceAssistExtensions(runtime, mathConfig);
    this.extensions.splice(0, this.extensions.length, ...next);
    this.plugin.app.workspace.updateOptions();
  }

  private async texMathConfig(): Promise<TexMathCustomConfig> {
    const texProfile = this.plugin.settings.sourceAssist.profiles.find(
      (profile) => profile.extension === "tex",
    );
    const text = texProfile?.texMathFormats ?? "[]";
    try {
      return parseTexMathFormats(text);
    } catch {
      return EMPTY_TEX_MATH_CUSTOM_CONFIG;
    }
  }

  private sourceAssistExtensions(
    runtime: LatexSuiteProfileRuntime,
    mathConfig: TexMathCustomConfig,
  ): Extension[] {
    if (!this.plugin.settings.sourceAssist.enabled) return [];
    const extensionsByFileExtension = {
      ...runtime.extensionsByFileExtension,
    };
    const texExtensions = extensionsByFileExtension.tex;
    if (texExtensions !== undefined) {
      extensionsByFileExtension.tex = [
        texMathAnalysisExtension(mathConfig),
        texMathLatexSuiteBridgeExtension(),
        ...texExtensions,
        ...(sourceAssistTexEnhancedRenderEnabled(
          this.plugin.settings.sourceAssist,
        )
          ? [texDisplayMathPreviewExtension()]
          : []),
      ];
    }
    const profileCompartment = new Compartment();
    return [
      profileCompartment.of([]),
      sourceAssistProfileRouter(profileCompartment, {
        extensionsByFileExtension,
      }),
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
