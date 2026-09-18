import fs from "node:fs/promises";
import path from "node:path";
import type { TerminalShellKind } from "../terminal/terminal-command";
import { mvAideTempDirectory } from "../storage/temp-paths";

export const RUN_OSC = 777;
export interface PreparedStep { command: string; dispose(): Promise<void> }
const singleQuote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`;
const psQuote = (text: string): string => `'${text.replace(/'/gu, "''")}'`;

/** Body is interpreted by the current shell, never by JavaScript or a new shell. */
export async function prepareStep(body: string, kind: TerminalShellKind, token: string, tempRoot = mvAideTempDirectory("mv-run")): Promise<PreparedStep> {
  if (!/^[a-f0-9]+$/u.test(token) || body.includes("\0")) throw new Error("Invalid command or control identity");
  const start = `mv-run;${token};start`;
  const end = `mv-run;${token};end;`;
  const variable = `__mv_run_${token}`;
  let command: string;
  if (kind === "posix") {
    command = `printf '\\033]${RUN_OSC};${start}\\007'; eval ${singleQuote(body)}; ${variable}=$?; printf '\\033]${RUN_OSC};${end}%s\\007' "$${variable}"; unset ${variable}`;
  } else if (kind === "fish") {
    const literal = `'${body.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
    command = `printf '\\033]${RUN_OSC};${start}\\007'; eval ${literal}; set -l ${variable} $status; printf '\\033]${RUN_OSC};${end}%s\\007' $${variable}; set -e ${variable}`;
  } else if (kind === "powershell") {
    const emit = (data: string): string => `Write-Host -NoNewline ([char]27 + ']${RUN_OSC};${data}' + [char]7)`;
    command = `${emit(start)}; try { Invoke-Expression ${psQuote(body)}; if ($?) { $${variable}=0 } elseif ($LASTEXITCODE) { $${variable}=$LASTEXITCODE } else { $${variable}=1 } } catch { $${variable}=1; Write-Host $_ }; Write-Host -NoNewline ([char]27 + ']${RUN_OSC};${end}' + $${variable} + [char]7); Remove-Variable ${variable} -ErrorAction SilentlyContinue`;
  } else {
    // Only the receipt lives in batch files. The user's command stays on the
    // interactive command line, preserving e.g. `for %i` (not batch `%%i`).
    await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(tempRoot, "step-"));
    try {
      const beginFile = path.join(directory, "begin.cmd");
      const endFile = path.join(directory, "end.cmd");
      await fs.writeFile(beginFile, `@echo \x1b]${RUN_OSC};${start}\x07\r\n`, { mode: 0o600 });
      await fs.writeFile(endFile, `@echo \x1b]${RUN_OSC};${end}%errorlevel%\x07\r\n`, { mode: 0o600 });
      if (/[\r\n]/u.test(body)) throw new Error("A cmd mv-run instruction must be one physical line");
      command = `call "${beginFile}" & ${body} & call "${endFile}"`;
      return { command, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  // The terminal's established safe-input encoder expands every UTF-8 byte.
  // Sending a whole instrumented command can fill a PTY's input/echo queues.
  // Load a private script then eval in this same interactive context instead;
  // don't source it (which changes $0/source scope in zsh) or spawn a subshell
  // for the command. cd, exports and interactive stdin survive between steps.
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(tempRoot, "step-"));
  try {
    const script = path.join(directory, kind === "powershell" ? "run.ps1" : "run.sh");
    await fs.writeFile(script, `${command}\n`, { mode: 0o600 });
    const invocation = kind === "powershell"
      ? `Invoke-Expression ([IO.File]::ReadAllText(${psQuote(script)}))`
      : kind === "fish"
        ? `begin; set -l ${variable}_script (string collect < '${script.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'); eval "$${variable}_script"; end`
        : `eval "$(command cat ${singleQuote(script)})"`;
    return { command: invocation, dispose: () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
