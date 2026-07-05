import type { Extension } from "@codemirror/state";
import type { PluginManifest } from "obsidian";
import type MvSenceAiIdePlugin from "../../main";
import LatexSuitePlugin from "../vendor/latex-suite/src/main";
import {
  DEFAULT_SETTINGS as LATEX_SUITE_DEFAULT_SETTINGS,
  type LatexSuitePluginSettings,
} from "../vendor/latex-suite/src/settings/settings";
import type {
  SourceAssistProfile,
  SourceAssistSettings,
} from "../types";

export interface LatexSuiteProfileRuntime {
  extensionsByFileExtension: Record<string, Extension[]>;
}

export async function buildLatexSuiteProfileRuntime(
  plugin: MvSenceAiIdePlugin,
  settings: SourceAssistSettings,
): Promise<LatexSuiteProfileRuntime> {
  const extensionsByFileExtension: Record<string, Extension[]> = {};

  if (!settings.enabled) {
    return { extensionsByFileExtension };
  }

  for (const profile of settings.profiles) {
    if (!profile.enabled) continue;
    const host = new RoutedLatexSuitePlugin(
      plugin,
      profileToLatexSuiteSettings(settings, profile),
    );
    await host.processSettings();
    extensionsByFileExtension[profile.extension] = [...host.editorExtensions];
  }

  return { extensionsByFileExtension };
}

class RoutedLatexSuitePlugin extends LatexSuitePlugin {
  constructor(
    parent: MvSenceAiIdePlugin,
    settings: LatexSuitePluginSettings,
  ) {
    super(parent.app, parent.manifest as PluginManifest);
    this.settings = settings;
  }

  override async loadData(): Promise<unknown> {
    return this.settings;
  }

  override async saveData(_data: unknown): Promise<void> {
    // Source Assist owns persistence; Latex Suite only receives routed data.
  }

  override showSnippetsLoadedNotice(): void {
    // File watchers are disabled for routed in-settings profiles.
  }

  override watchFiles(): void {
    // Profile routing only passes settings data; no upstream file watching.
  }
}

function profileToLatexSuiteSettings(
  settings: SourceAssistSettings,
  profile: SourceAssistProfile,
): LatexSuitePluginSettings {
  return {
    ...LATEX_SUITE_DEFAULT_SETTINGS,
    snippets: profile.snippets,
    snippetVariables: LATEX_SUITE_DEFAULT_SETTINGS.snippetVariables,
    snippetsEnabled: settings.snippetsEnabled,
    snippetsTrigger: profile.snippetsTrigger,
    snippetNextTabstopTrigger: profile.snippetNextTabstopTrigger,
    snippetPreviousTabstopTrigger: profile.snippetPreviousTabstopTrigger,
    suppressSnippetTriggerOnIME: settings.suppressSnippetTriggerOnIME,
    removeSnippetWhitespace: settings.removeSnippetWhitespace,
    loadSnippetsFromFile: false,
    loadSnippetVariablesFromFile: false,
    snippetsFileLocation: "",
    snippetVariablesFileLocation: "",
    mathPreviewEnabled: settings.mathPreviewEnabled,
    mathPreviewPositionIsAbove: settings.mathPreviewPositionIsAbove,
    mathPreviewCursor: settings.mathPreviewCursor,
    mathPreviewBracketHighlighting: settings.mathPreviewBracketHighlighting,
    wordDelimiters: settings.wordDelimiters,
    snippetDebug: settings.snippetDebug,
  };
}
