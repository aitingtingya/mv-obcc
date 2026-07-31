import esbuild from "esbuild";
import fs from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";

const production = process.argv[2] === "production";
const latexSuiteSource = path.resolve("src/vendor/latex-suite/src");
const licenseBanner = [
  "/*!",
  " * mv-AIDE bundles portions of obsidian-latex-suite 1.11.5.",
  " * obsidian-latex-suite is MIT licensed; see THIRD_PARTY_NOTICES.md and src/vendor/latex-suite/LICENSE.md.",
  " */",
].join("\n");
const startupTimingBanner = [
  "var __mvSenceAiStartupNow = () => {",
  "  var measured = globalThis.performance?.now?.();",
  "  return typeof measured === 'number' && Number.isFinite(measured) ? measured : Date.now();",
  "};",
  "globalThis.__mvSenceAiModuleEvaluationTiming = { startedAt: __mvSenceAiStartupNow() };",
].join("\n");
const startupTimingFooter = [
  "if (globalThis.__mvSenceAiModuleEvaluationTiming) {",
  "  globalThis.__mvSenceAiModuleEvaluationTiming.endedAt = __mvSenceAiStartupNow();",
  "}",
].join("\n");
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

const mainContext = await esbuild.context({
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
  banner: {
    js: production
      ? `${licenseBanner}\n${startupTimingBanner}`
      : startupTimingBanner,
  },
  footer: { js: startupTimingFooter },
  logLevel: "info",
  plugins: [inlineImportPlugin, latexSuiteStartupPatchPlugin],
});

const universalMcpStdioContext = await esbuild.context({
  entryPoints: ["scripts/universal-mcp-stdio.ts"],
  bundle: true,
  external: [...builtinModules],
  format: "cjs",
  target: "es2022",
  platform: "node",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "dist/universal-mcp-stdio.cjs",
  logLevel: "info",
});

// 构建顺序：stdio 启动器必须先于 main 构建，main 通过 inline: 导入把
// dist/universal-mcp-stdio.cjs 以文本内嵌（发布只随包 3 个标准文件）。
// watch 模式下 stdio 改动不会自动触发 main 重新内嵌，需重启 dev。
if (production) {
  await universalMcpStdioContext.rebuild();
  await mainContext.rebuild();
  await Promise.all(
    [mainContext, universalMcpStdioContext].map((context) => context.dispose()),
  );
} else {
  await universalMcpStdioContext.rebuild();
  await Promise.all(
    [mainContext, universalMcpStdioContext].map((context) => context.watch()),
  );
}
