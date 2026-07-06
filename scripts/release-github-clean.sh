#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLEAN_ROOT="${CLEAN_ROOT:-/Users/gingerman/obsidian/git-learn-md/mv-obcc_clean}"
REPO="aitingtingya/mv-obcc"
REPO_URL="https://github.com/${REPO}.git"
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

get_github_token() {
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    printf "%s" "$GITHUB_TOKEN"
    return 0
  fi

  local credential token
  credential="$(
    printf "protocol=https\nhost=github.com\nusername=x-access-token\n\n" \
      | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true
  )"
  token="$(printf "%s\n" "$credential" | sed -n "s/^password=//p" | head -n 1)"
  if [[ -n "$token" ]]; then
    printf "%s" "$token"
    return 0
  fi

  cat >&2 <<'EOF'
GitHub token not found.

Provide it by either:
  1. exporting GITHUB_TOKEN for this command, or
  2. storing it once in git credential helper / macOS Keychain:

     git config --global credential.helper osxkeychain
     printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=YOUR_TOKEN\n\n' | git credential-osxkeychain store

Do not write the real token into repository files.
EOF
  return 1
}

GITHUB_TOKEN_RESOLVED="$(get_github_token)"
if [[ ! "$GITHUB_TOKEN_RESOLVED" =~ ^(ghp_|github_pat_) ]]; then
  echo "Resolved GitHub token does not look like a GitHub PAT. Abort." >&2
  exit 1
fi
BASIC_AUTH="$(printf "x-access-token:%s" "$GITHUB_TOKEN_RESOLVED" | base64 | tr -d "\n")"
GIT_AUTH_HEADER="Authorization: Basic ${BASIC_AUTH}"

echo "Preparing clean release ${VERSION} from ${SOURCE_ROOT}"
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

run_logged() {
  local name="$1"
  shift
  echo "Running ${name}..."
  "$@" > ".release-${name}.log" 2>&1 || {
    tail -n 120 ".release-${name}.log" >&2
    exit 1
  }
}

run_logged npm-install npm install --package-lock-only
run_logged npm-ci npm ci
run_logged verify npm run verify
run_logged package npm run package

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

if grep -RInE 'ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|x-access-token:(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)' \
  --exclude-dir=.git \
  --exclude="RELEASE-PROCESS.md" \
  .; then
  echo "Potential GitHub token found in release tree. Abort." >&2
  exit 1
fi

stage_items=()
for item in \
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
  versions.json; do
  [[ -e "$item" ]] && stage_items+=("$item")
done
git add -- "${stage_items[@]}"

if git diff --cached --name-only | grep -E '^(node_modules|dist|release|tests|\.obsidian|vitest\.config\.ts)'; then
  echo "Forbidden development/test path staged. Abort." >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "No file changes to commit."
else
  git commit -m "release: ${VERSION}"
fi

echo "Pushing main..."
git -c http.extraHeader="$GIT_AUTH_HEADER" push "$REPO_URL" main

echo "Publishing tag ${VERSION}..."
git tag -f "$VERSION"
git -c http.extraHeader="$GIT_AUTH_HEADER" push "$REPO_URL" "refs/tags/${VERSION}" --force

set +e
release_lookup="$(
  curl -fsS \
    -H "Authorization: Bearer $GITHUB_TOKEN_RESOLVED" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}" 2>/dev/null
)"
lookup_status=$?
set -e
if [[ $lookup_status -eq 0 && -n "$release_lookup" ]]; then
  release_id="$(node -e 'const r=JSON.parse(process.argv[1]); if (r.id) process.stdout.write(String(r.id));' "$release_lookup")"
  if [[ -n "$release_id" ]]; then
    echo "Deleting existing release ${VERSION}..."
    curl -fsS -X DELETE \
      -H "Authorization: Bearer $GITHUB_TOKEN_RESOLVED" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/${REPO}/releases/${release_id}" >/dev/null
  fi
fi

release_payload="$(node -e 'const version = process.argv[1]; process.stdout.write(JSON.stringify({ tag_name: version, target_commitish: "main", name: version, body: `mv-SenceAI ${version}`, draft: false, prerelease: false }));' "$VERSION")"
release_json="$(
  curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN_RESOLVED" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -d "$release_payload" \
    "https://api.github.com/repos/${REPO}/releases"
)"

upload_url="$(node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(r.upload_url.replace(/\{.*\}$/, ""));' "$release_json")"
html_url="$(node -e 'const r = JSON.parse(process.argv[1]); process.stdout.write(r.html_url);' "$release_json")"
for asset in "dist/main.js:main.js" "manifest.json:manifest.json" "styles.css:styles.css"; do
  src="${asset%%:*}"
  name="${asset##*:}"
  curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN_RESOLVED" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$src" \
    "${upload_url}?name=$name" >/dev/null
  echo "Uploaded ${name}"
done

unset GITHUB_TOKEN_RESOLVED BASIC_AUTH GIT_AUTH_HEADER
SUCCESS=1
echo "Published ${VERSION}: ${html_url}"
