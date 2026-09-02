// Shared capability vocabulary for mv-AIDE's independently implemented DSH
// compatibility boundary. This module is data-only: importing it performs no
// registration, probing, filesystem work, or mutation.

export const DSH_RUNTIME_FAMILIES = Object.freeze({
  preview: 'preview-0.1.1',
  alpha: 'alpha-0.1.2',
  unknown: 'unknown',
});

export const DSH_CAPABILITIES = Object.freeze({
  webLaunchAuth: 'web.launch-auth',
  hostSettings: 'host.settings',
  hostTools: 'host.tools',
  hostPresets: 'host.presets',
  hostPlanReview: 'host.plan-review',
  modelSchema: 'host.model-schema',
  clientSettingsCard: 'client.settings-card',
  clientSessions: 'client.sessions',
  clientComposer: 'client.composer',
  clientPendingInteraction: 'client.pending-interaction',
  clientWorkspace: 'client.workspace',
  clientConversationImages: 'client.conversation-images',
  clientCommands: 'client.commands',
});

export function identifyDshRuntimeFamily(version) {
  if (typeof version !== 'string') return DSH_RUNTIME_FAMILIES.unknown;
  const value = version.trim();
  if (/^0\.1\.1(?:-|$)/u.test(value)) return DSH_RUNTIME_FAMILIES.preview;
  if (/^0\.1\.2(?:-|$)/u.test(value)) return DSH_RUNTIME_FAMILIES.alpha;
  return DSH_RUNTIME_FAMILIES.unknown;
}

function capabilityStatus(value) {
  if (value === true || value?.status === 'compatible') return 'compatible';
  if (value === false || value?.status === 'unavailable') return 'unavailable';
  return 'unknown';
}

export function createCompatibilityReport({ version, capabilities = {} } = {}) {
  const normalized = {};
  for (const [id, value] of Object.entries(capabilities)) {
    normalized[id] = Object.freeze({
      status: capabilityStatus(value),
      adapter: value?.adapter === 'preview' || value?.adapter === 'alpha'
        ? value.adapter
        : undefined,
      evidence: Object.freeze(Array.isArray(value?.evidence)
        ? value.evidence.filter((item) => typeof item === 'string')
        : []),
    });
  }
  return Object.freeze({
    version: typeof version === 'string' && version.trim() ? version.trim() : undefined,
    family: identifyDshRuntimeFamily(version),
    capabilities: Object.freeze(normalized),
  });
}

export function requireCapabilities(report, required) {
  const missing = [];
  for (const id of required) {
    if (report?.capabilities?.[id]?.status !== 'compatible') missing.push(id);
  }
  return Object.freeze({ compatible: missing.length === 0, missing: Object.freeze(missing) });
}
