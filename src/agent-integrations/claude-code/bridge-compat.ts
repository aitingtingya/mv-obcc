import {
  BridgeServer as CoreBridgeServer,
  type BridgeServerOptions,
} from "../../ide/bridge-server";
import { resolveClaudeClientIdentity } from "./client-identity";

export const CLAUDE_IDE_AUTHORIZATION_HEADER =
  "x-claude-code-ide-authorization";

export function withClaudeBridgeCompatibility(
  options: BridgeServerOptions,
): BridgeServerOptions {
  return {
    ...options,
    ideAuthorizationHeader:
      options.ideAuthorizationHeader ?? CLAUDE_IDE_AUTHORIZATION_HEADER,
    resolveClientIdentity:
      options.resolveClientIdentity ?? resolveClaudeClientIdentity,
  };
}

export class ClaudeCompatibleBridgeServer extends CoreBridgeServer {
  constructor(options: BridgeServerOptions) {
    super(withClaudeBridgeCompatibility(options));
  }
}

export type { BridgeServerOptions };
