import type { Extension } from "@codemirror/state";
import type { PluginManifest } from "obsidian";
import type MvAideIdePlugin from "../../main";
import LatexSuitePlugin from "../vendor/latex-suite/src/main";
import {
  DEFAULT_SETTINGS as LATEX_SUITE_DEFAULT_SETTINGS,
  processLatexSuiteSettings,
  type LatexSuitePluginSettings,
} from "../vendor/latex-suite/src/settings/settings";
import type {
  SourceAssistProfile,
  SourceAssistSettings,
} from "../types";

export interface LatexSuiteProfileRuntime {
  extensionsByFileExtension: Record<string, Extension[]>;
}

const profileRuntimes = new WeakMap<MvAideIdePlugin, Map<string, {
  key: string;
  extensions: Extension[];
}>>();

export async function buildLatexSuiteProfileRuntime(
  plugin: MvAideIdePlugin,
  settings: SourceAssistSettings,
): Promise<LatexSuiteProfileRuntime> {
  const extensionsByFileExtension: Record<string, Extension[]> = {};
  let cache = profileRuntimes.get(plugin);
  if (!cache) {
    cache = new Map();
    profileRuntimes.set(plugin, cache);
  }
  const enabled = new Set(settings.enabled
    ? settings.profiles.filter((profile) => profile.latexSuiteEnabled).map((profile) => profile.extension)
    : []);
  for (const extension of cache.keys()) {
    if (!enabled.has(extension)) cache.delete(extension);
  }

  if (!settings.enabled) {
    return { extensionsByFileExtension };
  }

  for (const profile of settings.profiles) {
    if (!profile.latexSuiteEnabled) continue;
    const routed = profileToLatexSuiteSettings(settings, profile);
    const key = JSON.stringify(routed);
    let cached = cache.get(profile.extension);
    if (cached?.key !== key) {
      const host = new RoutedLatexSuitePlugin(plugin, routed);
      // SourceAssistFeature publishes the whole batch with one updateOptions.
      // Do not ask the vendor host to refresh every editor once per profile.
      host.CMSettings = processLatexSuiteSettings(await host.getSnippets(false, false), routed);
      host.setEditorExtensions();
      cached = { key, extensions: [...host.editorExtensions] };
      cache.set(profile.extension, cached);
    }
    extensionsByFileExtension[profile.extension] = cached.extensions;
  }

  return { extensionsByFileExtension };
}

class RoutedLatexSuitePlugin extends LatexSuitePlugin {
  constructor(
    parent: MvAideIdePlugin,
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
