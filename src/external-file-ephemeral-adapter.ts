export interface ExternalFileEphemeralLease {
  readonly vaultPath: string;
  commitOpened(): void;
  abort(): Promise<void>;
}

/**
 * Optional interception point for external files that need a short-lived vault
 * materialization instead of the normal persistent mirror strategy.
 *
 * Returning null preserves the existing external-file opener path unchanged.
 */
export interface ExternalFileEphemeralAdapter {
  prepare(externalPath: string): Promise<ExternalFileEphemeralLease | null>;
  dispose(): void;
}
