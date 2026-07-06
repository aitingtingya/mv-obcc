import { DEFAULT_SETTINGS } from "../constants";
import type {
  SourceAssistProfile,
  SourceAssistSettings,
} from "../types";

export const SOURCE_ASSIST_EXTENSION_PATTERN = /^[a-z0-9][a-z0-9+_-]*$/;
export const CUSTOM_MARKDOWN_PLAIN_VISUALS_CLASS =
  "mv-senceai-source-plain-markdown";

export function normalizeSourceAssistExtension(value: string): string | null {
  const extension = value.trim().replace(/^\.+/, "").toLowerCase();
  if (!extension || !SOURCE_ASSIST_EXTENSION_PATTERN.test(extension)) return null;
  return extension;
}

export function customMarkdownPlainVisualsEnabled(
  registeredExtensions: Iterable<string>,
  rawExtension: string,
): boolean {
  const extension = rawExtension.replace(/^\.+/, "").toLowerCase();
  if (!extension || extension === "md" || extension === "tex") return false;
  for (const registeredExtension of registeredExtensions) {
    if (registeredExtension.toLowerCase() === extension) return true;
  }
  return false;
}

export function sourceAssistProfileId(extension: string): string {
  return `source-assist-${extension}`;
}

export const EMPTY_LATEX_SUITE_SNIPPETS = "export default []";

export function createSourceAssistProfile(
  extension: string,
): SourceAssistProfile {
  const normalized = normalizeSourceAssistExtension(extension);
  if (!normalized) {
    throw new Error(`Invalid source assist extension: ${extension}`);
  }
  return {
    id: sourceAssistProfileId(normalized),
    extension: normalized,
    enabled: true,
    snippets: EMPTY_LATEX_SUITE_SNIPPETS,
    snippetsTrigger: "Tab",
    snippetNextTabstopTrigger: "Tab",
    snippetPreviousTabstopTrigger: "Shift-Tab",
    texEnhancedRenderEnabled: false,
  };
}

function normalizeProfile(raw: Partial<SourceAssistProfile> | undefined): SourceAssistProfile | null {
  const extension = normalizeSourceAssistExtension(raw?.extension ?? "");
  if (!extension) return null;
  return {
    id: raw?.id || sourceAssistProfileId(extension),
    extension,
    enabled: raw?.enabled ?? true,
    snippets: typeof raw?.snippets === "string" ? raw.snippets : EMPTY_LATEX_SUITE_SNIPPETS,
    snippetsTrigger: raw?.snippetsTrigger || "Tab",
    snippetNextTabstopTrigger: raw?.snippetNextTabstopTrigger || "Tab",
    snippetPreviousTabstopTrigger: raw?.snippetPreviousTabstopTrigger || "Shift-Tab",
    texEnhancedRenderEnabled:
      extension === "tex" && raw?.texEnhancedRenderEnabled === true,
  };
}

export function normalizeSourceAssistSettings(
  loaded: Partial<SourceAssistSettings> | undefined,
): SourceAssistSettings {
  const defaults = DEFAULT_SETTINGS.sourceAssist;
  const seen = new Set<string>();
  const profiles: SourceAssistProfile[] = [];

  const rawProfiles = Array.isArray(loaded?.profiles) ? loaded.profiles : defaults.profiles;
  for (const raw of rawProfiles) {
    const profile = normalizeProfile(raw);
    if (!profile || seen.has(profile.extension)) continue;
    seen.add(profile.extension);
    profiles.push(profile);
  }

  if (!seen.has("md")) {
    profiles.unshift(createSourceAssistProfile("md"));
  }

  return {
    ...defaults,
    ...loaded,
    snippetDebug:
      loaded?.snippetDebug === "info" || loaded?.snippetDebug === "verbose"
        ? loaded.snippetDebug
        : "off",
    profiles,
  };
}

export function sourceAssistMarkdownExtensions(
  settings: SourceAssistSettings,
): string[] {
  return settings.profiles
    .map((profile) => profile.extension)
    .filter((extension) => extension !== "md");
}

export function sourceAssistTexEnhancedRenderEnabled(
  settings: SourceAssistSettings,
): boolean {
  return settings.profiles.some(
    (profile) =>
      profile.extension === "tex" &&
      profile.enabled &&
      profile.texEnhancedRenderEnabled,
  );
}
