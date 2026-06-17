import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import archiver from "archiver";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const releaseName = `${manifest.id}-${manifest.version}`;
const releaseDirectory = path.join(root, "release", releaseName);
const zipPath = `${releaseDirectory}.zip`;
const sourceZipPath = path.join(
  root,
  "release",
  `${releaseName}-source.zip`,
);

fs.rmSync(releaseDirectory, { recursive: true, force: true });
fs.mkdirSync(releaseDirectory, { recursive: true });
for (const [source, destination] of [
  ["dist/main.js", "main.js"],
  ["manifest.json", "manifest.json"],
  ["styles.css", "styles.css"],
]) {
  fs.copyFileSync(path.join(root, source), path.join(releaseDirectory, destination));
}
fs.rmSync(zipPath, { force: true });
async function createArchive(target, addContents) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    addContents(archive);
    void archive.finalize();
  });
}

await createArchive(zipPath, (archive) => {
  archive.directory(releaseDirectory, manifest.id);
});

fs.rmSync(sourceZipPath, { force: true });
await createArchive(sourceZipPath, (archive) => {
  archive.glob("**/*", {
    cwd: root,
    dot: true,
    ignore: [
      "node_modules/**",
      "dist/**",
      "release/**",
      ".git/**",
    ],
  }, {
    prefix: `${releaseName}-source`,
  });
});

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const checksumPaths = [
  zipPath,
  sourceZipPath,
  ...["main.js", "manifest.json", "styles.css"].map((fileName) =>
    path.join(releaseDirectory, fileName),
  ),
];
const checksumContents = checksumPaths
  .map((filePath) => {
    const relativePath = path.relative(path.join(root, "release"), filePath);
    return `${sha256(filePath)}  ${relativePath}`;
  })
  .join("\n");
fs.writeFileSync(
  path.join(root, "release", "SHA256SUMS"),
  `${checksumContents}\n`,
);

console.log(zipPath);
console.log(sourceZipPath);
