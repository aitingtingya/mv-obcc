import path from "node:path";
import { promises as fs } from "node:fs";

export type OutsideFileRead =
  | { ok: true; contents: string }
  | { ok: false; error: string };

/**
 * Whether `value` is an absolute filesystem path on the current platform.
 * Out-of-vault diff review only accepts absolute paths; relative paths keep
 * resolving inside the vault (the existing `resolveVaultPath` behavior).
 */
export function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value.trim());
}

/** Read a file that lives OUTSIDE the Obsidian vault, for diff review. */
export async function readOutsideFileForDiff(
  absolutePath: string,
): Promise<OutsideFileRead> {
  try {
    const contents = await fs.readFile(absolutePath, "utf8");
    return { ok: true, contents };
  } catch (error) {
    // A missing file is a valid diff baseline (create): treat it as empty,
    // exactly like the in-vault path where a missing TFile reads as "".
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, contents: "" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Cannot read outside-vault file "${absolutePath}": ${message}`,
    };
  }
}

/**
 * Re-check that the outside-vault file still matches what the diff was opened
 * with; mirrors the in-vault `validateOriginal` semantics (stale → refuse).
 */
export async function validateOutsideOriginal(
  absolutePath: string,
  expectedContents: string,
): Promise<boolean> {
  const read = await readOutsideFileForDiff(absolutePath);
  return read.ok && read.contents === expectedContents;
}
