import path from "node:path";

export type TerminalShellKind = "posix" | "fish" | "powershell" | "cmd";

/** Classify the configured interactive shell without executing it. */
export function terminalShellKind(
  shellPath: string,
  platform: NodeJS.Platform = process.platform,
): TerminalShellKind {
  const base = (platform === "win32" ? path.win32.basename(shellPath) : path.basename(shellPath))
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (base === "cmd") return "cmd";
  if (base === "powershell" || base === "pwsh") return "powershell";
  if (base === "fish") return "fish";
  // sh/bash/zsh/dash/ksh/ash and Unix shell symlinks share the POSIX-safe
  // wrapper. Unknown Windows shells retain the historical raw command path.
  return platform === "win32" ? "cmd" : "posix";
}

function octalUtf8(value: string): string {
  return [...Buffer.from(value, "utf8")]
    // POSIX printf %b requires the portable \0ddd form. Bare \ddd works in
    // some shells but zsh treats it as literal digits, corrupting the command.
    .map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

/**
 * Encode a shell command into one interactive input line whose outer parser
 * never sees command-provided bangs, quotes, backslashes, or newlines.
 * The decoded command is evaluated by the current shell so `cd`/`export`
 * continue to affect the same integrated terminal session.
 */
export function safeInteractiveShellCommand(
  command: string,
  kind: TerminalShellKind,
): string {
  if (command.includes("\0")) throw new Error("Terminal command must not contain NUL bytes");
  if (kind === "cmd") return command;
  if (kind === "powershell") {
    const encoded = Buffer.from(command, "utf8").toString("base64");
    return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
  }
  const encoded = octalUtf8(command);
  return kind === "fish"
    ? `begin; set -l __mv_aide_command (printf '%bX' '${encoded}' | string collect); set __mv_aide_command (string replace -r 'X$' '' -- "$__mv_aide_command" | string collect); eval "$__mv_aide_command"; end`
    : `__mv_aide_command=$(printf '%bX' '${encoded}'); __mv_aide_command=\${__mv_aide_command%X}; eval "$__mv_aide_command"; unset __mv_aide_command`;
}
