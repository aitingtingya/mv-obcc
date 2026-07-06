# mv-SenceAI 插件发布与更新流程指南

本项目的发布包含两条路径：本地开发测试用的 Obsidian 插件目录部署，以及 GitHub 官方发布仓的干净发布。GitHub 发布仓不是完整开发仓，不能混入 vault 工作区文件、测试目录、构建缓存或临时文件。

## 常用命令

本地部署到当前 vault：

```bash
npm run deploy:local
```

GitHub 发布必须使用临时干净克隆仓，不直接从当前 Obsidian vault 根目录推送。发布脚本只从环境变量读取 token：

```bash
GITHUB_TOKEN=... VERSION=0.7.2 bash ./release-github-clean.sh
```

`GITHUB_TOKEN` 需要有 `contents:write` 权限。不要把 token 写入仓库、脚本或文档。

## GitHub Token 防泄漏红线

- 禁止把真实 GitHub token 写入任何被同步到发布仓的文件，包括 `RELEASE-PROCESS.md`、临时脚本、`.github/workflows/*`、shell history 导出的日志或 README。
- 禁止将 token 硬编码到 release 脚本；脚本只能通过环境变量读取 `GITHUB_TOKEN`。
- 提交前必须运行 `git diff --cached` 并确认没有 `ghp_`、`github_pat_`、`x-access-token:` 后跟真实 token、或其它凭据字符串。
- 若怀疑 token 已进入文件或日志，立刻停止发布并吊销该 token 后重建。

## GitHub 干净发布原则

发布目标仓库是 `https://github.com/aitingtingya/mv-obcc.git`，其根目录就是插件项目根目录。发布时只同步插件源码和构建所需文件，禁止把本地开发目录 `mv-obcc-ide/` 作为子目录推送到 GitHub。

必须排除：

- `tests/`
- `vitest.config.ts`
- `node_modules/`
- `dist/`
- `release/`
- `.obsidian/`
- `.DS_Store`
- vault 临时文件，如 `Untitled.tex`、`test-py.py`、普通笔记草稿

允许同步：

- `src/`
- `scripts/`
- `.github/`
- `main.ts`
- `manifest.json`
- `styles.css`
- `esbuild.config.mjs`
- `eslint.config.mjs`
- `tsconfig.json`
- `package.json`
- `package-lock.json`
- `README.md`
- `DEVELOPMENT-GUIDELINES.md`
- `LATEX-SUITE-UPGRADE.md`
- `RELEASE-PROCESS.md`
- `THIRD_PARTY_NOTICES.md`
- `LICENSE`
- `TEST-REPORT.md`
- `WINDOWS-VALIDATION.md`
- `versions.json`

## 发布仓依赖清理

本地开发仓保留完整测试环境；GitHub 发布仓不上传测试，因此发布脚本必须在临时克隆仓内清理测试专用配置：

- 从 `package.json` 删除 `scripts.test` 和 `scripts.test:watch`。
- 将 `scripts.verify` 固定为 `npm run lint && npm run typecheck && npm run build`。
- 从 `devDependencies` 删除 `vitest`、`jsdom`、`@types/jsdom`。
- 从 `tsconfig.json` 删除 `vitest/globals`。
- 从 `tsconfig.json` 的 `include` 删除 `tests/**/*.ts`。
- 清理后运行 `npm install --package-lock-only`，让 `package-lock.json` 与发布仓 package 保持同步。

这能避免发布仓因测试依赖链引入 `vite -> rolldown -> @napi-rs/wasm-runtime -> @emnapi/*`，导致 GitHub Actions 的 `npm ci` 在不同 npm 版本下失败。

## 干净发布脚本模板

将下面脚本保存到临时文件，例如 `release-github-clean.sh`，在本地开发仓外执行。脚本成功后会删除临时目录；失败时会保留临时目录用于排查。

```bash
#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${SOURCE_ROOT:-/Users/gingerman/obsidian/git-learn-md/mv-obcc-ide}"
CLEAN_ROOT="${CLEAN_ROOT:-/Users/gingerman/obsidian/git-learn-md/mv-obcc_clean}"
REPO_URL="https://github.com/aitingtingya/mv-obcc.git"
AUTH_REPO_URL="https://x-access-token:${GITHUB_TOKEN:?GITHUB_TOKEN is required}@github.com/aitingtingya/mv-obcc.git"
VERSION="${VERSION:-$(SOURCE_ROOT="$SOURCE_ROOT" node -p "require(process.env.SOURCE_ROOT + '/package.json').version")}"
SUCCESS=0

cleanup() {
  if [[ "$SUCCESS" == "1" ]]; then
    rm -rf "$CLEAN_ROOT"
  else
    echo "Release failed; keeping temporary repository for debugging: $CLEAN_ROOT" >&2
  fi
}
trap cleanup EXIT

rm -rf "$CLEAN_ROOT"
git clone "$REPO_URL" "$CLEAN_ROOT"

find "$CLEAN_ROOT" -mindepth 1 -maxdepth 1 ! -name ".git" -exec rm -rf {} +

allowlist=(
  "src"
  "scripts"
  ".github"
  ".gitignore"
  "main.ts"
  "manifest.json"
  "styles.css"
  "esbuild.config.mjs"
  "eslint.config.mjs"
  "tsconfig.json"
  "package.json"
  "package-lock.json"
  "README.md"
  "DEVELOPMENT-GUIDELINES.md"
  "LATEX-SUITE-UPGRADE.md"
  "RELEASE-PROCESS.md"
  "THIRD_PARTY_NOTICES.md"
  "LICENSE"
  "TEST-REPORT.md"
  "WINDOWS-VALIDATION.md"
  "versions.json"
)

for item in "${allowlist[@]}"; do
  if [[ -e "$SOURCE_ROOT/$item" ]]; then
    mkdir -p "$(dirname "$CLEAN_ROOT/$item")"
    cp -R "$SOURCE_ROOT/$item" "$CLEAN_ROOT/$item"
  fi
done

cd "$CLEAN_ROOT"
rm -rf tests vitest.config.ts node_modules dist release .obsidian .DS_Store

node <<'NODE'
const fs = require("node:fs");

const packagePath = "package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.scripts = pkg.scripts || {};
delete pkg.scripts.test;
delete pkg.scripts["test:watch"];
pkg.scripts.verify = "npm run lint && npm run typecheck && npm run build";
for (const dep of ["vitest", "jsdom", "@types/jsdom"]) {
  delete pkg.devDependencies?.[dep];
}
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const tsconfigPath = "tsconfig.json";
const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
tsconfig.compilerOptions = tsconfig.compilerOptions || {};
if (Array.isArray(tsconfig.compilerOptions.types)) {
  tsconfig.compilerOptions.types = tsconfig.compilerOptions.types.filter(
    (type) => type !== "vitest/globals",
  );
}
if (Array.isArray(tsconfig.include)) {
  tsconfig.include = tsconfig.include.filter((entry) => entry !== "tests/**/*.ts");
}
fs.writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
NODE

npm install --package-lock-only
npm ci
npm run verify
npm run package

test ! -d tests
test ! -f vitest.config.ts
node <<'NODE'
const lock = JSON.parse(require("node:fs").readFileSync("package-lock.json", "utf8"));
for (const name of [
  "node_modules/vite",
  "node_modules/rolldown",
  "node_modules/@napi-rs/wasm-runtime",
  "node_modules/@emnapi/core",
  "node_modules/@emnapi/runtime",
]) {
  if (lock.packages?.[name]) throw new Error(`Unexpected test dependency in lockfile: ${name}`);
}
NODE

if grep -RInE 'ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|x-access-token:[^$]' \
  --exclude-dir=.git \
  --exclude=RELEASE-PROCESS.md \
  .; then
  echo "Potential GitHub token found in release tree. Abort." >&2
  exit 1
fi

git add -- \
  .gitignore \
  src \
  scripts \
  .github \
  main.ts \
  manifest.json \
  styles.css \
  esbuild.config.mjs \
  eslint.config.mjs \
  tsconfig.json \
  package.json \
  package-lock.json \
  README.md \
  DEVELOPMENT-GUIDELINES.md \
  LATEX-SUITE-UPGRADE.md \
  RELEASE-PROCESS.md \
  THIRD_PARTY_NOTICES.md \
  LICENSE \
  TEST-REPORT.md \
  WINDOWS-VALIDATION.md \
  versions.json

if git diff --cached --name-only | grep -E '^(node_modules|dist|release|tests|\.obsidian|vitest\.config\.ts)'; then
  echo "Forbidden development/test path staged. Abort." >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "No file changes to commit."
else
  git commit -m "release: ${VERSION}"
fi
git push "$AUTH_REPO_URL" main

release_id="$(
  curl -fsS \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/aitingtingya/mv-obcc/releases/tags/$VERSION" \
    | node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => { try { const r = JSON.parse(s); if (r.id) process.stdout.write(String(r.id)); } catch {} });'
)" || release_id=""
if [[ -n "$release_id" ]]; then
  curl -fsS -X DELETE \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/aitingtingya/mv-obcc/releases/$release_id"
fi

git tag -f "$VERSION"
git push "$AUTH_REPO_URL" "refs/tags/${VERSION}" --force

node - <<NODE > release-payload.json
console.log(JSON.stringify({
  tag_name: "$VERSION",
  target_commitish: "main",
  name: "$VERSION",
  body: "mv-SenceAI $VERSION",
  draft: false,
  prerelease: false,
}));
NODE

release_json="$(
  curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -d @release-payload.json \
    "https://api.github.com/repos/aitingtingya/mv-obcc/releases"
)"
rm -f release-payload.json

upload_url="$(
  node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(r.upload_url.replace(/\{.*\}$/, ""));' "$release_json"
)"
for asset in "dist/main.js:main.js" "manifest.json:manifest.json" "styles.css:styles.css"; do
  src="${asset%%:*}"
  name="${asset##*:}"
  curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$src" \
    "${upload_url}?name=$name"
done

SUCCESS=1
```

发布后检查：

```bash
git ls-remote https://github.com/aitingtingya/mv-obcc.git main "refs/tags/${VERSION}"
```

GitHub Actions 的 `npm ci`、`npm run verify` 和 package job 必须全部通过。

## 许可证要求

源码编写辅助 vendored `obsidian-latex-suite` 1.11.5 的 MIT-licensed 代码。发布前必须确认：

- `src/vendor/latex-suite/LICENSE.md` 存在。
- `THIRD_PARTY_NOTICES.md` 记录 upstream source、版本和 license 路径。
- 生产 bundle 顶部包含短 license banner，指向 third-party notice 和 vendored license。

源码高亮主题若复制或改写第三方主题配色，发布前必须确认：

- 主题来源允许再分发。
- `THIRD_PARTY_NOTICES.md` 记录主题来源和许可证。
- 不确定许可证的主题不得内置。
