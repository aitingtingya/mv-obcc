# mv-SenceAI 插件发布与更新流程指南

本项目有两个仓库语义：

- 本地开发仓：当前 Obsidian vault 里的 `mv-obcc-ide/`，保留测试、开发工具和本地验证文件。
- GitHub 发布仓：`https://github.com/aitingtingya/mv-obcc.git`，只放干净插件源码和发布所需配置。

发布时必须使用 [scripts/release-github-clean.sh](/Users/gingerman/obsidian/git-learn-md/mv-obcc-ide/scripts/release-github-clean.sh)。不要手写临时发布命令，不要直接从 vault 根目录推送。

## 3 分钟推送流程

确认 `package.json`、`manifest.json`、`versions.json` 已经是目标版本后，在本地开发仓执行：

```bash
cd /Users/gingerman/obsidian/git-learn-md/mv-obcc-ide
VERSION=0.7.2 bash scripts/release-github-clean.sh
```

脚本会自动完成：

- 克隆 GitHub 发布仓到临时目录 `/Users/gingerman/obsidian/git-learn-md/mv-obcc_clean`。
- 只同步 allowlist 中的插件源码和发布配置。
- 删除发布仓不需要的测试依赖、测试配置和测试目录。
- 重新生成发布仓 `package-lock.json`。
- 运行 `npm ci`、`npm run verify`、`npm run package`。
- 显式 `git add` allowlist，不使用 `git add .`。
- 阻止 `node_modules/`、`dist/`、`release/`、`tests/`、`.obsidian/`、`vitest.config.ts` 被 staged。
- 推送 GitHub `main`。
- 强制更新同名 tag。
- 删除并重建 GitHub release。
- 上传 `main.js`、`manifest.json`、`styles.css`。
- 成功后删除临时目录；失败时保留临时目录用于排查。

## GitHub Token

脚本按以下顺序取 token：

1. `GITHUB_TOKEN` 环境变量。
2. Git credential helper / macOS Keychain 中保存的 `github.com` 凭据。

当前机器已经把 GitHub token 存入 macOS Keychain；后续 agent 正常情况下不需要再次询问 token。

如果换机器或 Keychain 丢失，只允许用下面方式重新写入，不能把真实 token 写进仓库文件：

```bash
git config --global credential.helper osxkeychain
printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=YOUR_TOKEN\n\n' | git credential-osxkeychain store
```

验证是否已保存，输出必须被掩码：

```bash
printf 'protocol=https\nhost=github.com\nusername=x-access-token\n\n' \
  | git credential fill \
  | sed -E 's/^password=.*/password=<stored>/'
```

## GitHub Token 防泄漏红线

- 禁止把真实 GitHub token 写入任何被同步到发布仓的文件，包括 `RELEASE-PROCESS.md`、`scripts/*`、`.github/workflows/*`、README、日志或临时脚本。
- 禁止把 token 写进 git remote URL，例如 `https://x-access-token:TOKEN@github.com/...`。
- 禁止在发布脚本里开启 `set -x`。
- 提交前必须让发布脚本执行 token 扫描；发现 `ghp_`、`github_pat_` 或带真实 token 的 `x-access-token:` 立刻中止。
- 若怀疑 token 已进入文件、日志或远端提交，立刻停止发布并吊销该 token。

## GitHub 干净发布原则

发布目标仓库根目录就是插件根目录，不能把 `mv-obcc-ide/` 作为子目录推送到 GitHub。

允许同步：

- `src/`
- `scripts/`
- `.github/`
- `.gitignore`
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

必须排除：

- `tests/`
- `vitest.config.ts`
- `node_modules/`
- `dist/`
- `release/`
- `.obsidian/`
- `.DS_Store`
- vault 临时文件，例如 `Untitled.tex`、`test-py.py`、普通笔记草稿

## 发布仓依赖清理

本地开发仓保留完整测试环境；GitHub 发布仓不上传测试。发布脚本必须在临时克隆仓内做这些清理：

- 从 `package.json` 删除 `scripts.test` 和 `scripts.test:watch`。
- 将 `scripts.verify` 固定为 `npm run lint && npm run typecheck && npm run build`。
- 从 `devDependencies` 删除 `vitest`、`jsdom`、`@types/jsdom`。
- 从 `tsconfig.json` 删除 `vitest/globals`。
- 从 `tsconfig.json` 的 `include` 删除 `tests/**/*.ts`。
- 运行 `npm install --package-lock-only`，让发布仓 lockfile 与发布仓 package 保持同步。

这能避免发布仓因测试依赖链引入 `vite -> rolldown -> @napi-rs/wasm-runtime -> @emnapi/*`，导致 GitHub Actions 的 `npm ci` 失败。

## 发布后检查

脚本成功后至少确认：

```bash
git ls-remote https://github.com/aitingtingya/mv-obcc.git main refs/tags/0.7.2
```

GitHub release 页面必须包含三个 assets：

- `main.js`
- `manifest.json`
- `styles.css`

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
