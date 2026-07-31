import type { ExternalFileOpenResult } from "./external-file-opener";
import type { ExternalFileSymlinkFallbackDecision } from "./external-file-symlink-fallback-modal";

export interface ExternalFileFallbackOrchestratorOptions {
  open: () => Promise<ExternalFileOpenResult>;
  requestDecision: (
    failure: NonNullable<ExternalFileOpenResult["symlinkFailure"]>,
    message: string,
  ) => Promise<ExternalFileSymlinkFallbackDecision>;
  authorizeManagedCopy: (
    failure: NonNullable<ExternalFileOpenResult["symlinkFailure"]>,
  ) => boolean | Promise<boolean>;
  repairWindowsSymlinkSupport?: () => boolean | Promise<boolean>;
}

/**
 * Runs one user-mediated retry after an actual, eligible symlink failure.
 * A managed copy is never authorized or selected speculatively.
 */
export async function openExternalFileWithFallbackConsent(
  options: ExternalFileFallbackOrchestratorOptions,
): Promise<ExternalFileOpenResult> {
  const first = await options.open();
  if (
    first.success ||
    first.managedCopyFallbackAvailable !== true ||
    !first.symlinkFailure
  ) {
    return first;
  }

  const decision = await options.requestDecision(
    first.symlinkFailure,
    first.message ?? "符号链接创建失败。",
  );
  if (decision === "cancel") return first;
  if (decision === "repair-and-retry") {
    if (!options.repairWindowsSymlinkSupport) return first;
    const repaired = await options.repairWindowsSymlinkSupport();
    return repaired ? await options.open() : first;
  }
  if (decision === "retry") return await options.open();

  const authorized = await options.authorizeManagedCopy(first.symlinkFailure);
  return authorized ? await options.open() : first;
}
