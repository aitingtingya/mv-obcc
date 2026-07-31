export interface UniversalMcpHealthIdentity {
  instanceId: string;
  pid: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function matchesUniversalMcpHealth(
  expected: UniversalMcpHealthIdentity,
  actualValue: unknown,
): boolean {
  const actual = asRecord(actualValue);
  return actual.instanceId === expected.instanceId && actual.pid === expected.pid;
}
