import { clipboardTarget } from "../core/registers";
import type { ScriptEditor } from "./contracts";

export class ConfigurationEffectError extends Error {}

function unavailable(operation: string): never {
  throw new ConfigurationEffectError(
    `Automatic vimrc reload cannot ${operation}; use an explicit command or Reload scripts.`,
  );
}

/** A file watcher can reconfigure a buffer, but cannot use its interactive ports. */
export function configurationEditor(editor: ScriptEditor): ScriptEditor {
  return {
    id: editor.id, viewId: editor.viewId, path: editor.path,
    line: (n) => editor.line(n), lines: () => editor.lines(), lineCount: () => editor.lineCount(),
    cursor: () => editor.cursor(), mark: (name) => editor.mark(name),
    mode: () => editor.mode(), options: () => editor.options(), saveView: () => editor.saveView(),
    readRegister: (name) => {
      if (name === "=") return unavailable("evaluate the interactive expression register");
      if (name === "+" || name === "*" || (name === '"' && clipboardTarget(editor.options())))
        return unavailable("read the clipboard");
      return editor.readRegister(name);
    },
    setCursor: () => unavailable("move the cursor"),
    setMark: () => unavailable("set marks"),
    replaceLines: () => unavailable("edit buffer text"),
    writeRegister: () => unavailable("write registers or the clipboard"),
    normal: () => unavailable("send Normal keys"),
    ex: () => unavailable("run an editor or host command"),
    restoreView: () => unavailable("move the viewport"),
    message: () => unavailable("show an editor message"),
    configure: (config) => editor.configure(config),
    beginEdit: () => unavailable("start an edit"), endEdit: () => unavailable("finish an edit"),
  };
}
