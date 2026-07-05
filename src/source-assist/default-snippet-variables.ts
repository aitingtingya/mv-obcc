import { DEFAULT_SETTINGS as LATEX_SUITE_DEFAULT_SETTINGS } from "../vendor/latex-suite/src/settings/settings";
import {
  parseSnippetVariables,
  type SnippetVariables,
} from "../vendor/latex-suite/src/snippets/parse";

let defaultVariablesPromise: Promise<SnippetVariables> | null = null;

export function getDefaultSourceAssistSnippetVariables(): Promise<SnippetVariables> {
  defaultVariablesPromise ??= parseSnippetVariables(
    LATEX_SUITE_DEFAULT_SETTINGS.snippetVariables,
  );
  return defaultVariablesPromise;
}
