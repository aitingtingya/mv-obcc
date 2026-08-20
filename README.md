# mv-AIDE

[English](README_EN.md) | [完整功能手册](docs/features.md)

**把 Obsidian 变成面向写作、研究与开发的 AI IDE。** mv-AIDE 让 Agent 感知你正在阅读和编辑的内容，并把 AI 编辑、源码工具、终端、Vim 与桌面文件工作流放进同一个界面。

> 仅支持桌面端，要求 Obsidian 1.7.2 及以上。

[GitHub 仓库](https://github.com/aitingtingya/mv-obcc)

![Claude Code 在 mv-AIDE 终端中读取当前文件与选区](media/readme/ide-bridge.gif)

## 为什么是 mv-AIDE

### Agent 不再脱离现场

Claude Code、Codex CLI 和任意 MCP Agent 可以读取当前标签、选区、诊断、终端输出和笔记关系。Agent 提出的修改回到 Obsidian 中，以可编辑 Diff 交给你确认。

### AI 是编辑器的一部分

「文件内AI助手」统一收纳 API 提供商、划词助手和行内补全。划词助手负责明确的局部任务，行内补全安静地延续当前文字；两者共用提供商，但开关和运行周期仍彼此独立。

### 从文字到源码与桌面工作流

同一插件内可以编辑 TeX 等源码、运行终端、使用独立 Vim 引擎、浏览电脑文件，并让库外文件由指定 Obsidian 仓库打开。每个模块都能单独关闭。

## 八个设置分区

以下顺序与 **设置 → mv-AIDE** 一致。具体默认值、平台边界和排障见[完整功能手册](docs/features.md)。

### 1. IDE 桥接

当前文件、选区和编辑器状态会被动同步给 Agent：选中文字后直接提问即可，不需要先要求 Agent 调用工具读取现场。支持 Claude Code、Codex CLI、通用 MCP 客户端和 DeepSeek Harness（dsh）；演示中 Claude Code 就运行在 mv-AIDE 的终端里，并自动收到 Obsidian 选区后直接回答。开启「启用 dsh IDE 功能」后，dsh 内的 mv-AIDE 插件经同一本地桥接获得现场上下文、IDE 工具、被动通知与 Diff 审核。

![Claude Code 自然提问时自动收到当前文件与选区并回答](media/readme/ide-bridge.gif)

[查看 IDE 桥接边界](docs/features.md#ide-bridge)

### 2. mv-agent

mv-agent 把 DeepSeek Harness（DSH）内嵌进 Obsidian：自定义视图承载 DSH Web 界面，底部状态栏显示已连接 Agent 数与最新选区快照；命令面板提供「打开 / 停止 / 重启 mv-agent」。设置页把运行环境拆成 Node.js、DSH、pnpm 和插件注入四层，每层独立检测并可一键安装、升级或修复——可装入仓库的 `mv-aide/dsh/`，或选择全局安装（写受保护目录时会请求系统授权，拒绝后不降级）。注入后 dsh 获得 `/mv-aide` 命令与 `mv_aide__*` IDE 工具；Agent 写文件的权限确认可改为 Obsidian 内可编辑 Diff（接受即写入）。对库外项目的工具与被动推送默认全部关闭，可按通道在设置中开放。

![真实 DSH 根据当前选区回答并展开 mv-agent 现场状态](media/readme/mv-agent.gif)

[查看 mv-agent 说明](docs/features.md#mv-agent)

### 3. 文件内AI助手

展开后依次是「API提供商」、「划词助手」、「行内补全」三个默认折叠的子区。展开状态只在当前设置页会话中记忆，不会新增持久化设置。

#### API提供商

统一管理 OpenAI-compatible 或 Anthropic 类型的端点、密钥和模型，供两个助手共用。

#### 划词助手

在 Markdown、PDF 或网页中选中文字，调用自己的提示词模板，流式结果可以继续编辑、插入或替换原文。下面是在英文 PDF 中划词并用 DeepSeek 翻译。

![英文 PDF 全页视图中划词并流式返回中文翻译](media/readme/selection-assistant.gif)

[查看划词助手设置](docs/features.md#selection-assistant)

#### 行内补全

在 Markdown 中输入时生成灰色 ghost text，用 Tab 接受后才写入正文，也可以取消、拒绝并请求另一版。

![灰色行内补全建议出现并由 Tab 写入正文](media/readme/inline-completion.gif)

[查看行内补全参数](docs/features.md#inline-completion)

### 4. 终端

在 Obsidian 的主栏、侧栏或底部分栏运行真实系统终端，让命令行和编辑器保持在同一个工作区。终端设置把“打开位置”和“新终端打开方式（分屏 / 新建标签页）”分开控制：左右侧栏分屏为上下，中间主栏分屏为左右；底部首次从主栏上下拆出底栏，之后按设置在底栏中新建标签页或左右分屏。`mv-run: <命令>` 会发送到最近活跃的 mv-AIDE 终端（没有时自动新建），`mv-run -n: <命令>` 则始终新建终端执行。

![Obsidian 编辑器与 mv-AIDE 真实系统终端](media/readme/terminal.png)

[查看终端支持范围](docs/features.md#terminal)

### 5. 源码编写辅助

按后缀注册非 Markdown 源码，配置高亮、Lint、正则替换、`mv-run`、Code Suite 和可选 TeX 数学增强。

![TeX Code Suite 与数学预览](media/readme/source-assist.gif)

[查看源码 profile 与 Code Suite](docs/features.md#source-assist)

### 6. Vim 增强

独立实现的 Vim 编辑核心支持主要模式、motion、operator、text object、寄存器、宏、搜索、Ex 命令和仓库级 `.vimrc`。

![Vim 模式、相对行号与真实编辑](media/readme/vim.gif)

**图例：** `NORMAL` 中以 motion 移动；`VISUAL` 中选区与光标同步；`INSERT` 中输入正文。左侧行号演示 `.vimrc` 的 `number` + `relativenumber`。

[查看 Vim 能力清单](docs/features.md#vim)

### 7. 默认文件打开器

把 Markdown、PDF 及选定源码后缀交给指定 Obsidian 仓库。即使 Obsidian 已关闭，双击库外文件也能唤醒目标仓库并打开它；Windows 上的库外 PDF 会使用短生命周期镜像，关闭最后一个对应标签后自动清理。

![Finder 双击库外文件并由目标 Obsidian 仓库打开](media/readme/default-opener.gif)

[查看平台限制与数据模型](docs/features.md#default-opener)

### 8. 文件系统与浏览器

从 Obsidian 直接浏览任意目录、打开下载文件，并给内置网页浏览器补充下载与历史入口。

![文件系统浏览弹窗与浏览器工具栏入口](media/readme/filesystem-browser.png)

[查看文件路由规则](docs/features.md#filesystem-browser)

## 安装

### 社区插件市场

1. 打开 **设置 → 第三方插件 → 社区插件 → 浏览**。
2. 搜索 `mv-AIDE`，安装并启用。

<details>
<summary>手动安装</summary>

从 [Releases](https://github.com/aitingtingya/mv-obcc/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入：

```text
<vault>/.obsidian/plugins/mv-obcc/
```

然后在 **设置 → 第三方插件** 中启用 mv-AIDE。

</details>

<details>
<summary>从源码构建</summary>

```bash
npm install
npm run verify
npm run deploy:local
```

`npm run package` 会在 `release/` 中生成发布产物。

</details>

## 数据与权限

- IDE 桥接、通用 MCP 和默认打开器服务只监听 `127.0.0.1`。
- API Key 以明文保存在当前仓库插件目录的 `data.json` 中；请保护仓库及其备份。
- Vim 配置、库外文件镜像和其它仓库级数据位于当前仓库的 `mv-aide/`；跨进程状态位于 `~/.mv-aide/`，其中 IDE discovery 在 `ide/`、dsh bridge selection 在 `dsh/`，默认打开器的当前 authority 为 `file-opener/`（升级时保留失败安全的 legacy 兼容）。
- mv-agent 的环境安装只在用户点击对应按钮后联网。仓库安装的 Node.js、DSH 和 pnpm 运行时位于 `<vault>/mv-aide/dsh/`；桥接与管理插件位于 DSH web profile。下载、npm 缓存和安装脚本仅使用临时工作区并在操作结束后删除。选择全局安装或原位升级时，插件会显示系统管理员授权，不会静默改装到仓库。
- Windows 默认应用必须由用户在系统设置中确认；插件只写当前用户注册表，不申请管理员权限，也不修改受保护的 `UserChoice`。
- 各模块都有独立开关。所有后缀都关闭 Vim 后，Vim 运行模块、监听器与编辑器扩展不会加载。

完整说明见[数据与网络边界](docs/features.md#storage-network)和[平台支持矩阵](docs/features.md#platform-matrix)。

## 文档

- [完整功能手册（中文）](docs/features.md)
- [Complete Feature Guide (English)](docs/features-en.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [许可证](LICENSE)

## 致谢

行内补全的 CodeMirror 架构参考了 [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot) 的公开思路；终端进程桥接参考了 [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar) 的公开设计。Source Assist 的 Code Suite 内核基于 [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5`，保留 MIT 声明。Vim 的兼容目标与配置体验参考了 [obsidian-vimrc-support](https://github.com/esm7/obsidian-vimrc-support) 和 [Vim Motions](https://github.com/saberzero1/motions) 的公开文档与用户可见思路，核心引擎依据 Vim/Neovim 行为和 CodeMirror 6 API 独立实现。

详见[第三方声明](THIRD_PARTY_NOTICES.md)与[许可证](LICENSE)。
