import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const DSH_PLUGIN_BUNDLE_MARKER = ".mv-aide-bundle.json";

export interface DshPluginBundleMarker {
  schema: 1 | 2;
  fingerprint: string;
  mvAideVersion?: string;
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
  mvAideVersion: string,
): Promise<void> {
  const marker: DshPluginBundleMarker = { schema: 2, fingerprint, mvAideVersion };
  const target = path.join(installedDir, DSH_PLUGIN_BUNDLE_MARKER);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(marker)}\n`, "utf8");
  await fs.rename(temporary, target);
}

export async function readDshPluginBundleMarker(
  installedDir: string,
): Promise<DshPluginBundleMarker | null> {
  try {
    const marker = JSON.parse(
      await fs.readFile(path.join(installedDir, DSH_PLUGIN_BUNDLE_MARKER), "utf8"),
    ) as Partial<DshPluginBundleMarker>;
    if ((marker.schema !== 1 && marker.schema !== 2) || typeof marker.fingerprint !== "string") {
      return null;
    }
    if (marker.schema === 2 && typeof marker.mvAideVersion !== "string") return null;
    return marker as DshPluginBundleMarker;
  } catch {
    return null;
  }
}

export async function installedDshPluginBundleMatches(
  installedDir: string,
  expectedFiles: Readonly<Record<string, string>>,
  expectedFingerprint = dshPluginBundleFingerprint(expectedFiles),
  expectedMvAideVersion?: string,
): Promise<boolean> {
  try {
    const marker = await readDshPluginBundleMarker(installedDir);
    if (!marker || marker.fingerprint !== expectedFingerprint) return false;
    if (expectedMvAideVersion !== undefined && marker.mvAideVersion !== expectedMvAideVersion) return false;

    const actualFiles: Record<string, string> = {};
    await Promise.all(Object.keys(expectedFiles).map(async (relativePath) => {
      actualFiles[relativePath] = await fs.readFile(path.join(installedDir, relativePath), "utf8");
    }));
    return dshPluginBundleFingerprint(actualFiles) === expectedFingerprint;
  } catch {
    return false;
  }
}
