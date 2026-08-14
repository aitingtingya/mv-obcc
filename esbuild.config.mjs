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
  "var __mvAideStartupNow = () => {",
  "  var measured = globalThis.performance?.now?.();",
  "  return typeof measured === 'number' && Number.isFinite(measured) ? measured : Date.now();",
  "};",
  "globalThis.__mvAideModuleEvaluationTiming = { startedAt: __mvAideStartupNow() };",
].join("\n");
const startupTimingFooter = [
  "if (globalThis.__mvAideModuleEvaluationTiming) {",
  "  globalThis.__mvAideModuleEvaluationTiming.endedAt = __mvAideStartupNow();",
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
      path: path.resolve(
        args.resolveDir,
        args.path.slice("inline:".length).replace(/\?text$/u, ""),
      ),
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
    const cycleFreeSchema = /var RawSnippetSchema = object\(\{\n  trigger: union\(\[string\d*\(\), instance\(RegExp\)\]\),\n  replacement: union\(\[string\d*\(\), special\(\(x\) => typeof x === "function"\)\]\),/u;
    return cycleFreeSchema.test(source) && !source.includes("ReplacementOutputSchema")
      ? "already-safe"
      : null;
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
  return "patched";
}

async function minifyPatchedBundle(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const transformed = await esbuild.transform(source, {
    format: "cjs",
    legalComments: "inline",
    loader: "js",
    minify: true,
    sourcefile: path.basename(filePath),
    target: "es2022",
  });
  // Generated template literals may preserve upstream indentation at physical
  // line endings. Strip it so deployed artifacts also pass diff whitespace QA.
  await fs.writeFile(filePath, transformed.code.replace(/[ \t]+$/gmu, ""), "utf8");
}

async function assertBrowserLoginSafetyBoundary(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const forbiddenMarkers = [
    "passkey disabled by mv-aide",
    "UA -> Safari",
    "navigator.credentials",
    "isConditionalMediationAvailable",
    "setUserAgent(",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  ];
  const found = forbiddenMarkers.filter((marker) => source.includes(marker));
  if (found.length > 0) {
    throw new Error(
      `Browser login safety boundary failed; production bundle contains: ${found.join(", ")}`,
    );
  }
}

async function assertProductionBundle(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const requiredMarkers = [
    "mv-AIDE bundles portions of obsidian-latex-suite 1.11.5",
    "__mvAideModuleEvaluationTiming",
  ];
  const missing = requiredMarkers.filter((marker) => !source.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Production bundle is missing required markers: ${missing.join(", ")}`);
  }
  const forbiddenDebugMarkers = [
    "[mv-aide vim] controller created",
    "[mv-aide vim] controller destroyed",
    "[mv-aide vim] host document changed",
  ];
  const found = forbiddenDebugMarkers.filter((marker) => source.includes(marker));
  if (found.length > 0) {
    throw new Error(`Production bundle contains Vim debug output: ${found.join(", ")}`);
  }
}

const latexSuiteStartupPatchPlugin = {
  name: "latex-suite-startup-patch",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const startupCycleState = await patchLatexSuiteStartupCycle("dist/main.js");
      if (production) {
        if (!startupCycleState) {
          throw new Error(
            "Latex Suite startup safety check failed: neither the patch target nor the known cycle-free schema was found.",
          );
        }
        await minifyPatchedBundle("dist/main.js");
        await assertBrowserLoginSafetyBoundary("dist/main.js");
        await assertProductionBundle("dist/main.js");
      }
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
  entryPoints: ["src/universal-mcp-stdio.ts"],
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
