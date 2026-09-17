import { promises as fs } from "node:fs";
import path from "node:path";
import type { DshCommand } from "./process";
import type { DshLayerStatus } from "./environment";
import { packageDirectory } from "./binary-occupancy";
import { t } from "../../../i18n";

/** A missing npm shim does not prove the actual package is absent. */
export async function inspectNpmPackageEntry(
  modulesRoot: string,
  name: "dsh" | "pnpm",
  nodeExecutable: string,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): Promise<{ command: DshCommand | null; status: DshLayerStatus | null }> {
  const directory = packageDirectory(modulesRoot, name);
  try {
    await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { command: null, status: null };
    return { command: null, status: { state: "error", installed: true, commandPath: directory, detail: String(error) } };
  }
  try {
    const root = await fs.realpath(directory);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      name?: unknown; bin?: string | Record<string, unknown>;
    };
    if (manifest.name !== (name === "dsh" ? "@deepseek-ai/dsh" : "pnpm")) throw new Error("Package name mismatch");
    const declared = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
    if (typeof declared !== "string" || !declared.trim()) throw new Error("Missing declared CLI entry");
    const entry = await fs.realpath(path.resolve(root, declared));
    const relative = path.relative(root, entry);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("CLI entry escapes package directory");
    if (!(await fs.stat(entry)).isFile()) throw new Error("CLI entry is not a file");
    // npm packages may expose a Node script or a native executable. Use the
    // declared entry itself for native binaries, just as npm's shim does.
    const handle = await fs.open(entry, "r");
    let nodeScript: boolean;
    try {
      const header = Buffer.alloc(256);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      nodeScript = /\.[cm]?js$/i.test(entry)
        || /^#![^\r\n]*\bnode(?:\s|$)/.test(header.toString("utf8", 0, bytesRead));
    } finally {
      await handle.close();
    }
    return {
      command: { executable: nodeScript ? nodeExecutable : entry, argsPrefix: nodeScript ? [entry] : [], env: environment, homeDirectory, origin: "global" },
      status: null,
    };
  } catch (error) {
    return { command: null, status: {
      state: "error", installed: true, commandPath: directory,
      detail: t("已找到 npm 包，但无法使用其命令入口：{path}（{detail}）", { path: directory, detail: error instanceof Error ? error.message : String(error) }),
    } };
  }
}
