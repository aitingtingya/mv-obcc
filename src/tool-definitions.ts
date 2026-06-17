import type { BridgeSettings } from "./types";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PUBLIC_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "getLatestSelection",
    description: "Get the most recently observed Obsidian tab and selection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getOpenEditors",
    description:
      "Get all open Obsidian tabs, including files, PDF documents, web pages, terminals, and plugin views.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "openFile",
    description:
      "Open a vault file in Obsidian and optionally reveal a line. Use this tool if the user explicitly asks to 'open' a file; if they ask to 'read' or 'view' the content of a file, use the built-in read/view tools instead.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        line: { type: "number", description: "Zero-based line number." },
        startText: { type: "string" },
        endText: { type: "string" },
        selectToEndOfLine: { type: "boolean" },
        makeFrontmost: { type: "boolean" },
      },
      required: ["filePath"],
      additionalProperties: true,
    },
  },
  {
    name: "readCurrentWebPage",
    description:
      "Convert the complete currently loaded, rendered content of the most recently viewed, still-open Obsidian Web Viewer page into Markdown-compatible text without navigating or reloading it. This reads the whole loaded scrolling document, not only the visible viewport. Use this tool whenever the user wants the full webpage, its main content, or a page summary. getLatestSelection only returns selected text and cannot show the whole page.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const INTERNAL_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "openDiff",
    description:
      "Open an editable side-by-side diff and wait for the user to accept or reject it.",
    inputSchema: {
      type: "object",
      properties: {
        old_file_path: { type: "string" },
        new_file_path: { type: "string" },
        new_file_contents: { type: "string" },
        tab_name: { type: "string" },
      },
      required: ["new_file_contents"],
      additionalProperties: true,
    },
  },
  {
    name: "closeAllDiffTabs",
    description: "Close all MV SenceAI IDE diff tabs and reject pending diffs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "getDiagnostics",
    description: "Return Obsidian diagnostics. Obsidian has no language diagnostics.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "close_tab",
    description: "Close a pending MV SenceAI IDE diff tab.",
    inputSchema: {
      type: "object",
      properties: {
        tab_name: { type: "string" },
      },
      additionalProperties: true,
    },
  },
];

export const IDE_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...PUBLIC_TOOL_DEFINITIONS,
  ...INTERNAL_TOOL_DEFINITIONS,
];

export function mcpToolDefinitions(settings: BridgeSettings): ToolDefinition[] {
  return PUBLIC_TOOL_DEFINITIONS.filter(
    (definition) =>
      settings.toolToggles[definition.name as keyof BridgeSettings["toolToggles"]] === true,
  );
}

export function isMcpToolEnabled(name: string, settings: BridgeSettings): boolean {
  return mcpToolDefinitions(settings).some((definition) => definition.name === name);
}
