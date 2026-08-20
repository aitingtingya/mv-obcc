import http from "node:http";
import path from "node:path";
import {
  listLiveIdeLocks,
  type DiscoveredIdeLock,
} from "../../ide/discovery-lock";
import type { IdeContextSnapshot } from "../../ide/context-snapshot";
import { isPathInside } from "../../path-utils";

interface WorkspaceRoute {
  lock: DiscoveredIdeLock;
  vaultRoot: string;
}

export interface CodexWorkspaceRouterOptions {
  listLocks?: () => DiscoveredIdeLock[];
  requestSnapshot?: (
    route: WorkspaceRoute,
    workspaceRoot: string,
  ) => Promise<IdeContextSnapshot | null>;
}

function pathSpecificity(value: string): number {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}

export function matchingWorkspaceRoutes(
  workspaceRoot: string,
  locks: DiscoveredIdeLock[],
): WorkspaceRoute[] {
  const routes: WorkspaceRoute[] = [];
  for (const lock of locks) {
    for (const vaultRoot of lock.workspaceFolders) {
      if (!isPathInside(workspaceRoot, vaultRoot)) continue;
      routes.push({ lock, vaultRoot });
    }
  }
  return routes.sort((left, right) => {
    const depth = pathSpecificity(right.vaultRoot) - pathSpecificity(left.vaultRoot);
    if (depth !== 0) return depth;
    const length = path.resolve(right.vaultRoot).length - path.resolve(left.vaultRoot).length;
    if (length !== 0) return length;
    return left.lock.port - right.lock.port;
  });
}

function validSnapshot(value: unknown): value is IdeContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<IdeContextSnapshot>;
  return (
    typeof snapshot.vaultRoot === "string" &&
    snapshot.vaultRoot.length > 0 &&
    Array.isArray(snapshot.openEditors) &&
    (snapshot.current === null || typeof snapshot.current === "object")
  );
}

async function requestSnapshotFromBridge(
  route: WorkspaceRoute,
  workspaceRoot: string,
): Promise<IdeContextSnapshot | null> {
  const payload = Buffer.from(JSON.stringify({ workspaceRoot }), "utf8");
  return await new Promise<IdeContextSnapshot | null>((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: route.lock.port,
        method: "POST",
        path: "/internal/ide-context",
        headers: {
          Authorization: `Bearer ${route.lock.authToken}`,
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > 2 * 1024 * 1024) {
            response.destroy();
            resolve(null);
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(validSnapshot(parsed) ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.setTimeout(1_000, () => {
      request.destroy();
      resolve(null);
    });
    request.once("error", () => resolve(null));
    request.end(payload);
  });
}

export class CodexWorkspaceRouter {
  constructor(private readonly options: CodexWorkspaceRouterOptions = {}) {}

  async resolveSnapshot(workspaceRoot: string): Promise<IdeContextSnapshot | null> {
    if (!workspaceRoot.trim()) return null;
    const listLocks = this.options.listLocks ?? listLiveIdeLocks;
    const requestSnapshot = this.options.requestSnapshot ?? requestSnapshotFromBridge;
    for (const route of matchingWorkspaceRoutes(workspaceRoot, listLocks())) {
      const snapshot = await requestSnapshot(route, workspaceRoot);
      if (snapshot) return snapshot;
    }
    return null;
  }
}
