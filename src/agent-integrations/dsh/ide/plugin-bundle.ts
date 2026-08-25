import agentPackageJson from "inline:../../../../mv-agent/package.json?text";
import agentReadme from "inline:../../../../mv-agent/README.md";
import agentActiveSessionControl from "inline:../../../../mv-agent/lib/active-session-control.js";
import agentBridgeClient from "inline:../../../../mv-agent/lib/bridge-client.js";
import agentClient from "inline:../../../../mv-agent/lib/client.js";
import agentDiffHook from "inline:../../../../mv-agent/lib/diff-hook.js";
import agentFeatureSettings from "inline:../../../../mv-agent/lib/feature-settings.js";
import agentHoverSidebar from "inline:../../../../mv-agent/lib/hover-sidebar.js";
import agentImageAdapter from "inline:../../../../mv-agent/lib/image-adapter.js";
import agentIndex from "inline:../../../../mv-agent/lib/index.js";
import agentPassiveState from "inline:../../../../mv-agent/lib/passive-state.js";
import agentPaths from "inline:../../../../mv-agent/lib/paths.js";
import agentSettingsClient from "inline:../../../../mv-agent/lib/settings-client.js";
import agentTerminalTools from "inline:../../../../mv-agent/lib/terminal-tools.js";

import dshManagerPackageJson from "inline:../../../../mv-dsh-manager/package.json?text";
import dshManagerIndex from "inline:../../../../mv-dsh-manager/lib/index.js";
import dshManagerFeatureSettings from "inline:../../../../mv-dsh-manager/lib/feature-settings.js";
import dshManagerModelCapabilitiesService from "inline:../../../../mv-dsh-manager/lib/model-capabilities-service.js";
import dshManagerPluginsService from "inline:../../../../mv-dsh-manager/lib/plugins-service.js";
import dshManagerPluginToggleState from "inline:../../../../mv-dsh-manager/lib/plugin-toggle-state.js";
import dshManagerSkillsService from "inline:../../../../mv-dsh-manager/lib/skills-service.js";
import dshManagerPresetsService from "inline:../../../../mv-dsh-manager/lib/presets-service.js";
import dshManagerBridgeService from "inline:../../../../mv-dsh-manager/lib/bridge-service.js";
import dshManagerPaths from "inline:../../../../mv-dsh-manager/lib/paths.js";
import dshManagerClient from "inline:../../../../mv-dsh-manager/lib/client.js";
import dshManagerFileDropClient from "inline:../../../../mv-dsh-manager/lib/file-drop-client.js";
import dshManagerModelCapabilitiesClient from "inline:../../../../mv-dsh-manager/lib/model-capabilities-client.js";
import dshManagerPlanReviewClient from "inline:../../../../mv-dsh-manager/lib/plan-review-client.js";
import dshManagerPlanReviewControl from "inline:../../../../mv-dsh-manager/lib/plan-review-control.js";
import dshManagerSettingsClient from "inline:../../../../mv-dsh-manager/lib/settings-client.js";
import dshManagerUiScript from "inline:../../../../mv-dsh-manager/lib/ui-script.js";

/** Release builds inline the complete dual-face mv-agent package into main.js. */
export const MV_AGENT_PLUGIN_FILES: Readonly<Record<string, string>> = {
  "package.json": agentPackageJson,
  "README.md": agentReadme,
  "lib/active-session-control.js": agentActiveSessionControl,
  "lib/bridge-client.js": agentBridgeClient,
  "lib/client.js": `${agentSettingsClient}\n${agentClient}`,
  "lib/diff-hook.js": agentDiffHook,
  "lib/feature-settings.js": agentFeatureSettings,
  "lib/hover-sidebar.js": agentHoverSidebar,
  "lib/image-adapter.js": agentImageAdapter,
  "lib/index.js": agentIndex,
  "lib/passive-state.js": agentPassiveState,
  "lib/paths.js": agentPaths,
  "lib/settings-client.js": agentSettingsClient,
  "lib/terminal-tools.js": agentTerminalTools,
};

export const MV_DSH_MANAGER_PLUGIN_FILES: Readonly<Record<string, string>> = {
  "package.json": dshManagerPackageJson,
  "lib/index.js": dshManagerIndex,
  "lib/feature-settings.js": dshManagerFeatureSettings,
  "lib/model-capabilities-service.js": dshManagerModelCapabilitiesService,
  "lib/plugins-service.js": dshManagerPluginsService,
  "lib/plugin-toggle-state.js": dshManagerPluginToggleState,
  "lib/skills-service.js": dshManagerSkillsService,
  "lib/presets-service.js": dshManagerPresetsService,
  "lib/bridge-service.js": dshManagerBridgeService,
  "lib/paths.js": dshManagerPaths,
  "lib/plan-review-control.js": dshManagerPlanReviewControl,
  "lib/plan-review-client.js": dshManagerPlanReviewClient,
  "lib/settings-client.js": dshManagerSettingsClient,
  "lib/file-drop-client.js": dshManagerFileDropClient,
  "lib/model-capabilities-client.js": dshManagerModelCapabilitiesClient,
  "lib/client.js": `${dshManagerSettingsClient}\n${dshManagerPlanReviewClient}\n${dshManagerModelCapabilitiesClient}\n${dshManagerFileDropClient}\n${dshManagerClient}`,
  "lib/ui-script.js": dshManagerUiScript,
};

/** Backwards-compatible alias for existing imports */
export const MV_PLUGIN_MANAGER_FILES = MV_DSH_MANAGER_PLUGIN_FILES;
export const DSH_PLUGIN_FILES = MV_AGENT_PLUGIN_FILES;
