export type DshRuntimeFamily = "preview-0.1.1" | "alpha-0.1.2" | "unknown";
export type DshCapabilityStatus = "compatible" | "unavailable" | "unknown";
export type DshAdapterKind = "preview" | "alpha";

export interface DshCapabilityReport {
  readonly status: DshCapabilityStatus;
  readonly adapter?: DshAdapterKind;
  readonly evidence: readonly string[];
}

export interface DshCompatibilityReport {
  readonly version?: string;
  readonly family: DshRuntimeFamily;
  readonly capabilities: Readonly<Record<string, DshCapabilityReport>>;
}

export const DSH_RUNTIME_FAMILIES: Readonly<{
  preview: "preview-0.1.1";
  alpha: "alpha-0.1.2";
  unknown: "unknown";
}>;

export const DSH_CAPABILITIES: Readonly<Record<string, string>>;
export function identifyDshRuntimeFamily(version?: unknown): DshRuntimeFamily;
export function createCompatibilityReport(input?: {
  version?: unknown;
  capabilities?: Readonly<Record<string, unknown>>;
}): DshCompatibilityReport;
export function requireCapabilities(
  report: DshCompatibilityReport,
  required: readonly string[],
): Readonly<{ compatible: boolean; missing: readonly string[] }>;
