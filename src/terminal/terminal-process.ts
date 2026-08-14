import { processOutput, runProcess, type ProcessResult } from "../process-runner";
import { findSystemExecutable } from "../universal-mcp-stdio-command";

export function resolvePythonCommand(configuredPath: string): string | null {
  if (configuredPath.trim()) return configuredPath.trim();
  if (process.platform === "win32") {
    return findSystemExecutable("py") || findSystemExecutable("python");
  }
  return findSystemExecutable("python3") || findSystemExecutable("python");
}

export async function probePythonModule(
  python: string,
  moduleName: string,
): Promise<ProcessResult> {
  return runProcess(python, ["-c", `import ${moduleName}`], {
    timeoutMs: 30_000,
  });
}

export async function installPythonPackage(
  python: string,
  packageName: string,
): Promise<ProcessResult> {
  return runProcess(python, ["-m", "pip", "install", "-U", packageName], {
    timeoutMs: 300_000,
  });
}

export async function loginShellPath(shellPath: string): Promise<string | null> {
  const result = await runProcess(
    shellPath,
    ["-lic", 'echo "__PATH__"; echo "$PATH"'],
    { timeoutMs: 15_000 },
  );
  if (result.code !== 0) return null;
  return processOutput(result).split("__PATH__\n")[1]?.trim().split("\n")[0] || null;
}
