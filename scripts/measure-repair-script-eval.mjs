// Measures the module-evaluation cost of src/windows-developer-mode-repair.ts.
// The startup budget only allows splitting the embedded repair scripts into a
// lazily read auxiliary artifact when evaluation provably exceeds 50ms or 20%
// of plugin load time, so this script provides the measurement record.
import esbuild from "esbuild";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(os.tmpdir(), `mv-obcc-repair-eval-${process.pid}.cjs`);
const THRESHOLD_MS = 50;
const RUNS = 30;

try {
  await esbuild.build({
    entryPoints: [path.join(root, "src", "windows-developer-mode-repair.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });

  const require = createRequire(import.meta.url);
  // Cold require: includes the first disk read and parse.
  const coldStart = performance.now();
  require(outfile);
  const coldMs = performance.now() - coldStart;

  const samples = [];
  for (let index = 0; index < RUNS; index += 1) {
    delete require.cache[require.resolve(outfile)];
    const start = performance.now();
    require(outfile);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const medianMs = samples[Math.floor(samples.length / 2)];
  const p95Ms = samples[Math.floor(samples.length * 0.95)];
  const bundleBytes = fs.statSync(outfile).size;

  const report = {
    entry: "src/windows-developer-mode-repair.ts",
    bundleBytes,
    coldMs: Number(coldMs.toFixed(2)),
    medianMs: Number(medianMs.toFixed(2)),
    p95Ms: Number(p95Ms.toFixed(2)),
    runs: RUNS,
    thresholdMs: THRESHOLD_MS,
    withinBudget: medianMs <= THRESHOLD_MS,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.withinBudget) {
    console.error(
      `Module evaluation median ${report.medianMs}ms exceeds ${THRESHOLD_MS}ms; ` +
        "split the embedded repair scripts into a lazily read artifact.",
    );
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(outfile, { force: true });
}
