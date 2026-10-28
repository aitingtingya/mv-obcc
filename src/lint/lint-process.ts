import { spawn } from "node:child_process";

/** User-configured shell command, with an owned process tree and bounded capture. */
export function execLintCommand(command: string, options: {
  cwd: string; maxBuffer: number; signal: AbortSignal;
}): Promise<{ stdout: string; stderr: string; error?: Error }> {
  if (options.signal.aborted) return Promise.resolve({ stdout: "", stderr: "" });
  return new Promise((resolve) => {
    // Lint settings deliberately contain a shell program (including pipes),
    // unlike structured executable/argv probes elsewhere in the plugin.
    const windows = process.platform === "win32";
    const shell = windows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = windows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];
    const child = spawn(shell, args, {
      cwd: options.cwd, shell: false, detached: !windows, windowsVerbatimArguments: windows,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[][] = [[], []];
    const sizes = [0, 0];
    let error: Error | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, signal); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") error = failure as Error; }
      }
    };
    const abort = () => {
      if (forceTimer) return;
      kill("SIGTERM");
      forceTimer = setTimeout(() => kill("SIGKILL"), 1000);
      forceTimer.unref();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    [child.stdout, child.stderr].forEach((stream, index) => stream.on("data", (chunk: Buffer) => {
      const remaining = options.maxBuffer - sizes[index];
      if (remaining > 0) output[index].push(chunk.subarray(0, remaining));
      sizes[index] += chunk.length;
      if (sizes[index] > options.maxBuffer) { error = new Error("Lint output exceeded maxBuffer"); abort(); }
    }));
    child.once("error", (failure) => { error = failure; });
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (forceTimer) clearTimeout(forceTimer);
      if (code !== 0 && !error) error = new Error(`Lint command exited with ${code}`);
      resolve({ stdout: Buffer.concat(output[0]).toString("utf8"), stderr: Buffer.concat(output[1]).toString("utf8"), error });
    });
  });
}
