import esbuild from "esbuild";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

const production = process.argv[2] === "production";
const latexSuiteSource = path.resolve("src/vendor/latex-suite/src");
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/closebrackets",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/comment",
  "@codemirror/fold",
  "@codemirror/gutter",
  "@codemirror/highlight",
  "@codemirror/history",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/matchbrackets",
  "@codemirror/panel",
  "@codemirror/rangeset",
  "@codemirror/rectangular-selection",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/stream-parser",
  "@codemirror/text",
  "@codemirror/tooltip",
  "@codemirror/view",
  "@lezer/highlight",
  "@lezer/common",
  "@lezer/lr",
  ...builtinModules,
];

const inlineImportPlugin = {
  name: "inline-import",
  setup(build) {
    build.onResolve({ filter: /^inline:/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice("inline:".length)),
      namespace: "inline-text",
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-text" }, async (args) => ({
      contents: `export default ${JSON.stringify(await fs.readFile(args.path, "utf8"))};`,
      loader: "js",
    }));
  },
};

await fs.rm("dist/latex-suite-blackbox.cjs", { force: true });

async function patchLatexSuiteStartupCycle(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const schemaPattern = /var ReplacementOutputSchema = union\(\[\n  (literal\d*)\(false\),\n  (string\d*)\(\),\n  array\(instance\((BaseNode\d*)\)\)\n\]\);/;
  const match = source.match(schemaPattern);
  if (!match) {
    return;
  }
  const [, literalFn, stringFn, baseNodeClass] = match;
  let patched = source.replace(
    schemaPattern,
    `var ReplacementOutputSchema;\nfunction getReplacementOutputSchema() {\n  return ReplacementOutputSchema ?? (ReplacementOutputSchema = union([\n    ${literalFn}(false),\n    ${stringFn}(),\n    array(instance(${baseNodeClass}))\n  ]));\n}`,
  );
  const parsePattern = "safeParse(ReplacementOutputSchema, rawReplacement)";
  if (!patched.includes(parsePattern)) {
    throw new Error("Latex Suite startup patch failed: schema usage not found.");
  }
  patched = patched.replace(parsePattern, "safeParse(getReplacementOutputSchema(), rawReplacement)");
  await fs.writeFile(filePath, patched, "utf8");
}

const latexSuiteStartupPatchPlugin = {
  name: "latex-suite-startup-patch",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await patchLatexSuiteStartupCycle("dist/main.js");
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  alias: {
    src: latexSuiteSource,
  },
  external,
  format: "cjs",
  target: "es2022",
  platform: "node",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "dist/main.js",
  logLevel: "info",
  plugins: [inlineImportPlugin, latexSuiteStartupPatchPlugin],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
