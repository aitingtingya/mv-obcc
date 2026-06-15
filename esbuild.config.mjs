import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2022",
  platform: "node",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "dist/main.js",
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
