import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const DSH_PLUGIN_BUNDLE_MARKER = ".mv-aide-bundle.json";

interface DshPluginBundleMarker {
  schema: 1;
  fingerprint: string;
}

export function dshPluginBundleFingerprint(files: Readonly<Record<string, string>>): string {
  const hash = crypto.createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    const content = files[relativePath] ?? "";
    hash.update(`${relativePath.length}:`);
    hash.update(relativePath);
    hash.update(`${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function writeDshPluginBundleMarker(
  installedDir: string,
  fingerprint: string,
): Promise<void> {
  const marker: DshPluginBundleMarker = { schema: 1, fingerprint };
  const target = path.join(installedDir, DSH_PLUGIN_BUNDLE_MARKER);
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, "utf8");
  await fs.rename(temporary, target);
}

export async function installedDshPluginBundleMatches(
  installedDir: string,
  expectedFiles: Readonly<Record<string, string>>,
  expectedFingerprint = dshPluginBundleFingerprint(expectedFiles),
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(installedDir, DSH_PLUGIN_BUNDLE_MARKER), "utf8"),
    ) as Partial<DshPluginBundleMarker>;
    if (marker.schema !== 1 || marker.fingerprint !== expectedFingerprint) return false;

    const actualFiles: Record<string, string> = {};
    await Promise.all(Object.keys(expectedFiles).map(async (relativePath) => {
      actualFiles[relativePath] = await fs.readFile(path.join(installedDir, relativePath), "utf8");
    }));
    return dshPluginBundleFingerprint(actualFiles) === expectedFingerprint;
  } catch {
    return false;
  }
}
