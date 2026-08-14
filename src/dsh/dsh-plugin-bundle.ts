import packageJson from "inline:../../dsh-plugin/package.json?text";
import readme from "inline:../../dsh-plugin/README.md";
import bridgeClient from "inline:../../dsh-plugin/lib/bridge-client.js";
import diffHook from "inline:../../dsh-plugin/lib/diff-hook.js";
import index from "inline:../../dsh-plugin/lib/index.js";
import passiveState from "inline:../../dsh-plugin/lib/passive-state.js";

/** Release builds contain only three plugin files, so bridge sources live in main.js. */
export const DSH_PLUGIN_FILES: Readonly<Record<string, string>> = {
  "package.json": packageJson,
  "README.md": readme,
  "lib/bridge-client.js": bridgeClient,
  "lib/diff-hook.js": diffHook,
  "lib/index.js": index,
  "lib/passive-state.js": passiveState,
};
