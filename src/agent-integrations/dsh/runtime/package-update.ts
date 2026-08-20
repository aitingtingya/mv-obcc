import https from "node:https";
import { t } from "../../../i18n";
import {
  prependExecutableDirectory,
  resolveUserCommandEnvironment,
} from "../../../process-environment";
import { processOutput, runProcess } from "../../../process-runner";

export type RuntimeUpdateRelation = "older" | "current" | "newer";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

export type TextFetcher = (url: string) => Promise<string>;

function parseVersion(value: string | undefined): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value?.trim() ?? "");
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part)
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareRuntimeVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(t("无法比较版本：{left} / {right}", { left, right }));
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function runtimeUpdateRelation(current: string, target: string): RuntimeUpdateRelation {
  const compared = compareRuntimeVersions(current, target);
  return compared < 0 ? "older" : compared > 0 ? "newer" : "current";
}

export function normalizeRuntimeVersion(value: string): string {
  return value.trim().replace(/^v(?=\d)/u, "");
}

export function fetchText(url: string, redirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const location = response.headers.location;
      if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        if (redirects <= 0) {
          reject(new Error(t("远端版本检查重定向次数过多。")));
          return;
        }
        fetchText(new URL(location, url).toString(), redirects - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(t("远端版本检查失败：HTTP {status}", {
          status: response.statusCode ?? "unknown",
        })));
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("end", () => resolve(body));
      response.once("error", reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error(t("远端版本检查超时。"))));
    request.once("error", reject);
  });
}

export async function resolveNodeTargetVersion(fetcher: TextFetcher = fetchText): Promise<string> {
  const body = await fetcher("https://nodejs.org/dist/index.json");
  const data = JSON.parse(body) as unknown;
  if (!Array.isArray(data)) throw new Error(t("Node.js 官方版本索引格式无效。"));
  const versions = data
    .map((entry) => typeof entry === "object" && entry !== null && "version" in entry
      ? String((entry as { version: unknown }).version)
      : "")
    .filter((version) => /^v\d+\.\d+\.\d+$/u.test(version))
    .filter((version) => (parseVersion(version)?.major ?? 0) >= 24)
    .sort((a, b) => compareRuntimeVersions(b, a));
  if (!versions[0]) throw new Error(t("Node.js 官方版本索引中没有可用的 24+ 稳定版本。"));
  return versions[0];
}

async function resolveNpmTargetVersion(
  npmExecutable: string,
  spec: string,
  runner: typeof runProcess,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  const baseEnvironment = environment
    ?? await resolveUserCommandEnvironment(process.platform, process.env, runner);
  const commandEnvironment = prependExecutableDirectory(baseEnvironment, npmExecutable);
  const result = await runner(npmExecutable, ["view", spec, "version", "--json"], {
    timeoutMs: 30_000,
    env: commandEnvironment,
  });
  if (result.code !== 0) {
    throw new Error(processOutput(result) || t("npm view {spec} 失败。", { spec }));
  }
  const output = result.stdout.trim();
  let version = output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed === "string") version = parsed;
  } catch {
    // npm may emit a plain version string depending on the client version.
  }
  if (!parseVersion(version)) {
    throw new Error(t("npm 返回了无效版本：{version}", { version: version || t("空输出") }));
  }
  return version.trim();
}

export function resolveDshTargetVersion(
  npmExecutable: string,
  runner: typeof runProcess = runProcess,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  return resolveNpmTargetVersion(npmExecutable, "@deepseek-ai/dsh@next", runner, environment);
}

export function resolvePnpmTargetVersion(
  npmExecutable: string,
  runner: typeof runProcess = runProcess,
  environment?: NodeJS.ProcessEnv,
): Promise<string> {
  return resolveNpmTargetVersion(npmExecutable, "pnpm@latest", runner, environment);
}
