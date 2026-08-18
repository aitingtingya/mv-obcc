import { MarkdownView, Notice } from "obsidian";
import type MvAideIdePlugin from "../../main";
import { t } from "../i18n";
import { mvRunPrefixesFor } from "../terminal/mv-run-types";
import { capturePersistedMvRunSnapshot } from "./mv-run-editor-sync";
import type { TerminalRegistry } from "./terminal-registry";

export interface MvRunInstruction {
  command: string;
  newTerminal: boolean;
}

const MV_RUN_INSTRUCTION_RE = /^mv-run(?:\s+(-n))?\s*:\s*(.+)$/;

const BLOCK_PREFIX_ENDINGS: Record<string, string> = {
  "<!--": "-->",
  "/*": "*/",
};

/**
 * Extended mv-run parser kept outside the legacy terminal module so the
 * existing parser remains untouched. Only `-n` is accepted as an option.
 */
export function extractMvRunInstructions(
  text: string,
  prefixes: string[],
): MvRunInstruction[] {
  if (prefixes.length === 0) return [];
  const instructions: MvRunInstruction[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const instruction = instructionFromLine(line, prefixes);
    if (instruction) instructions.push(instruction);
  }
  return instructions;
}

export async function runFileBottomCommandWithTerminalRegistry(
  plugin: MvAideIdePlugin,
  registry: TerminalRegistry,
  activeView?: MarkdownView,
): Promise<void> {
  const view =
    activeView ?? plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice(t("当前没有打开的 Markdown 视图"));
    return;
  }

  let snapshot;
  try {
    snapshot = await capturePersistedMvRunSnapshot(plugin.app, view);
  } catch (error) {
    console.error("[mv-aide] mv-run 保存当前编辑器内容失败", error);
    new Notice(t("保存当前文件失败，未执行 mv-run 指令"));
    return;
  }
  if (!snapshot) {
    new Notice(t("当前没有打开的 Markdown 视图"));
    return;
  }

  const prefixes = mvRunPrefixesFor(plugin.settings.mvRun, snapshot.file.extension);
  if (prefixes.length === 0) {
    new Notice(t("未配置该文件类型的指令注释前缀"));
    return;
  }

  const instructions = extractMvRunInstructions(snapshot.text, prefixes);
  if (instructions.length === 0) {
    new Notice(t("未在文件中找到 mv-run 指令"));
    return;
  }

  for (const instruction of instructions) {
    await registry.run(instruction.command, {
      newTerminal: instruction.newTerminal,
    });
  }
}

function instructionFromLine(
  line: string,
  prefixes: string[],
): MvRunInstruction | null {
  for (const prefix of prefixes) {
    if (!line.startsWith(prefix)) continue;
    let body = line.slice(prefix.length).trim();
    const ending = BLOCK_PREFIX_ENDINGS[prefix];
    if (ending) {
      body = body.replace(new RegExp(`\\s*${escapeRegExp(ending)}$`), "").trim();
    }
    const match = MV_RUN_INSTRUCTION_RE.exec(body);
    if (!match) continue;
    return {
      command: match[2],
      newTerminal: match[1] === "-n",
    };
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
