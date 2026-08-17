import agentPackageJson from "inline:../../mv-agent/package.json?text";
import agentReadme from "inline:../../mv-agent/README.md";
import agentActiveSessionControl from "inline:../../mv-agent/lib/active-session-control.js";
import agentBridgeClient from "inline:../../mv-agent/lib/bridge-client.js";
import agentClient from "inline:../../mv-agent/lib/client.js";
import agentDiffHook from "inline:../../mv-agent/lib/diff-hook.js";
import agentHoverSidebar from "inline:../../mv-agent/lib/hover-sidebar.js";
import agentIndex from "inline:../../mv-agent/lib/index.js";
import agentPassiveState from "inline:../../mv-agent/lib/passive-state.js";

import dshManagerPackageJson from "inline:../../mv-dsh-manager/package.json?text";
import dshManagerIndex from "inline:../../mv-dsh-manager/lib/index.js";
import dshManagerPluginsService from "inline:../../mv-dsh-manager/lib/plugins-service.js";
import dshManagerSkillsService from "inline:../../mv-dsh-manager/lib/skills-service.js";
import dshManagerPresetsService from "inline:../../mv-dsh-manager/lib/presets-service.js";
import dshManagerBridgeService from "inline:../../mv-dsh-manager/lib/bridge-service.js";
import dshManagerClient from "inline:../../mv-dsh-manager/lib/client.js";
import dshManagerPlanReviewClient from "inline:../../mv-dsh-manager/lib/plan-review-client.js";
import dshManagerPlanReviewControl from "inline:../../mv-dsh-manager/lib/plan-review-control.js";
import dshManagerUiScript from "inline:../../mv-dsh-manager/lib/ui-script.js";

/** Release builds inline the complete dual-face mv-agent package into main.js. */
export const MV_AGENT_PLUGIN_FILES: Readonly<Record<string, string>> = {
  "package.json": agentPackageJson,
  "README.md": agentReadme,
  "lib/active-session-control.js": agentActiveSessionControl,
  "lib/bridge-client.js": agentBridgeClient,
  "lib/client.js": agentClient,
  "lib/diff-hook.js": agentDiffHook,
  "lib/hover-sidebar.js": agentHoverSidebar,
  "lib/index.js": agentIndex,
  "lib/passive-state.js": agentPassiveState,
};

export const MV_DSH_MANAGER_PLUGIN_FILES: Readonly<Record<string, string>> = {
  "package.json": dshManagerPackageJson,
  "lib/index.js": dshManagerIndex,
  "lib/plugins-service.js": dshManagerPluginsService,
  "lib/skills-service.js": dshManagerSkillsService,
  "lib/presets-service.js": dshManagerPresetsService,
  "lib/bridge-service.js": dshManagerBridgeService,
  "lib/plan-review-control.js": dshManagerPlanReviewControl,
  "lib/plan-review-client.js": dshManagerPlanReviewClient,
  "lib/client.js": `${dshManagerPlanReviewClient}\n${dshManagerClient}`,
  "lib/ui-script.js": dshManagerUiScript,
};

/** Backwards-compatible alias for existing imports */
export const MV_PLUGIN_MANAGER_FILES = MV_DSH_MANAGER_PLUGIN_FILES;
export const DSH_PLUGIN_FILES = MV_AGENT_PLUGIN_FILES;
