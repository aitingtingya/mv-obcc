import path from "node:path";

export function normalizeForComparison(value: string, platform = process.platform): string {
  const normalized = path.normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveVaultPath(
  vaultRoot: string,
  requestedPath: string,
  platform = process.platform,
): { absolutePath: string; relativePath: string } | null {
  if (!requestedPath.trim()) return null;

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedRoot = pathApi.resolve(vaultRoot);
  let normalizedRequest = requestedPath.trim();
  if (/^file:\/\//i.test(normalizedRequest)) {
    const filePath =
      platform === "win32"
        ? normalizedRequest.replace(/^file:\/\/\/?/i, "")
        : new URL(normalizedRequest).pathname;
    normalizedRequest = decodeURIComponent(filePath);
  } else {
    normalizedRequest = decodeURI(normalizedRequest);
  }
  const absolutePath = pathApi.isAbsolute(normalizedRequest)
    ? pathApi.resolve(normalizedRequest)
    : pathApi.resolve(normalizedRoot, normalizedRequest);

  const relativePath = pathApi.relative(normalizedRoot, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  ) {
    return null;
  }

  return {
    absolutePath,
    relativePath: relativePath.split(pathApi.sep).join("/"),
  };
}

export function fileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.startsWith("/")
    ? encodeURI(`file://${normalized}`)
    : encodeURI(`file:///${normalized}`);
}

export function stablePortSeed(vaultRoot: string): number {
  let hash = 2166136261;
  for (const char of normalizeForComparison(vaultRoot)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
