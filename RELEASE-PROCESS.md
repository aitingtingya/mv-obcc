# mv-SenceAI 插件发布与更新流程指南

本项目的发布包含两条路径：本地开发测试用的 Obsidian 插件目录部署，以及 GitHub 官方发布仓的干净发布。GitHub 发布仓不是完整开发仓，不能混入 vault 工作区文件、测试目录、构建缓存或临时文件。

## 常用命令

本地部署到当前 vault：

```bash
npm run deploy:local
```

GitHub 发布必须使用临时干净克隆仓，不直接从当前 Obsidian vault 根目录推送：

```bash
GITHUB_TOKEN=... node path/to/release-script.mjs
```

`GITHUB_TOKEN` 需要有 `contents:write` 权限。不要把 token 写入仓库、脚本或文档。

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

## 推荐自动化流程

1. 删除旧临时目录：
   ```bash
   rm -rf /Users/gingerman/obsidian/git-learn-md/mv-obcc_clean
   ```
2. 克隆 GitHub 发布仓：
   ```bash
   git clone https://github.com/aitingtingya/mv-obcc.git /Users/gingerman/obsidian/git-learn-md/mv-obcc_clean
   ```
3. 从 `/Users/gingerman/obsidian/git-learn-md/mv-obcc-ide` 同步允许清单中的文件到临时仓根目录。
4. 在临时仓执行发布仓依赖清理。
5. 在临时仓运行：
   ```bash
   npm ci
   npm run verify
   npm run package
   ```
6. 确认临时仓没有测试目录和测试依赖链：
   ```bash
   test ! -d tests
   node -e "const lock=require('./package-lock.json'); for (const p of ['node_modules/vite','node_modules/rolldown','node_modules/@napi-rs/wasm-runtime','node_modules/@emnapi/core','node_modules/@emnapi/runtime']) if (lock.packages[p]) throw new Error(p)"
   ```
7. 提交并推送 GitHub `main`：
   ```bash
   git add .
   git commit -m "release: 0.7.1"
   git push origin main
   ```
8. 删除已存在的同版本 GitHub Release 和 tag，重新创建 Release，并只上传三件套：
   - `dist/main.js` 上传为 `main.js`
   - `manifest.json`
   - `styles.css`
9. 删除临时目录。

## 许可证要求

源码编写辅助 vendored `obsidian-latex-suite` 1.11.5 的 MIT-licensed 代码。发布前必须确认：

- `src/vendor/latex-suite/LICENSE.md` 存在。
- `THIRD_PARTY_NOTICES.md` 记录 upstream source、版本和 license 路径。
- 生产 bundle 顶部包含短 license banner，指向 third-party notice 和 vendored license。
