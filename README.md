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

划词助手负责明确的局部任务，行内补全安静地延续当前文字。两者共用可配置的 OpenAI 兼容或 Anthropic 提供商，同时保持独立开关和清晰的输入优先级。

### 从文字到源码与桌面工作流

同一插件内可以编辑 TeX 等源码、运行终端、使用独立 Vim 引擎、浏览电脑文件，并让库外文件由指定 Obsidian 仓库打开。每个模块都能单独关闭。

## 八个工作流

以下顺序与 **设置 → mv-AIDE** 完全一致。具体设置、默认值、平台边界和排障见[完整功能手册](docs/features.md)。

### 1. IDE 桥接

当前文件、选区和编辑器状态会被动同步给 Agent：选中文字后直接提问即可，不需要先要求 Agent 调用工具读取现场。支持 Claude Code、Codex CLI 和通用 MCP 客户端；演示中 Claude Code 就运行在 mv-AIDE 的终端里，并自动收到 Obsidian 选区后直接回答。

![Claude Code 自然提问时自动收到当前文件与选区并回答](media/readme/ide-bridge.gif)

[查看 IDE 桥接边界](docs/features.md#ide-bridge)

### 2. 划词助手

在 Markdown、PDF 或网页中选中文字，调用自己的提示词模板，流式结果可以继续编辑、插入或替换原文。下面是在英文 PDF 中划词并用 DeepSeek 翻译。

![英文 PDF 全页视图中划词并流式返回中文翻译](media/readme/selection-assistant.gif)

[查看划词助手设置](docs/features.md#selection-assistant)

### 3. 行内补全

在 Markdown 中输入时生成灰色 ghost text，用 Tab 接受后才写入正文，也可以取消、拒绝并请求另一版。

![灰色行内补全建议出现并由 Tab 写入正文](media/readme/inline-completion.gif)

[查看行内补全参数](docs/features.md#inline-completion)

### 4. 终端

在 Obsidian 的主栏、侧栏或底部分栏运行真实系统终端，让命令行和编辑器保持在同一个工作区。

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

把 Markdown 及选定源码后缀交给指定 Obsidian 仓库。即使 Obsidian 已关闭，双击库外文件也能唤醒目标仓库并打开它。

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
- Vim 配置、库外文件镜像和其它仓库级数据位于当前仓库的 `mv-aide/`；默认打开器 wrapper 的系统级注册信息是唯一允许写入用户目录的运行数据。
- Windows 默认应用必须由用户在系统设置中确认；插件只写当前用户注册表，不申请管理员权限，也不修改受保护的 `UserChoice`。
- 各模块都有独立开关。所有后缀都关闭 Vim 后，Vim 运行模块、监听器与编辑器扩展不会加载。

完整说明见[数据与网络边界](docs/features.md#storage-network)和[平台支持矩阵](docs/features.md#platform-matrix)。

## 文档

- [完整功能手册（中文）](docs/features.md)
- [Complete Feature Guide (English)](docs/features-en.md)
- [Windows 实机验证](WINDOWS-VALIDATION.md)
- [Vim 独立实现与来源说明](docs/vim-engine-provenance.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [许可证](LICENSE)

## 致谢

行内补全的 CodeMirror 架构参考了 [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot) 的公开思路；终端进程桥接参考了 [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar) 的公开设计。Source Assist 的 Code Suite 内核基于 [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5`，保留 MIT 声明。Vim 的兼容目标与配置体验参考了 [obsidian-vimrc-support](https://github.com/esm7/obsidian-vimrc-support) 和 [Vim Motions](https://github.com/saberzero1/motions) 的公开文档与用户可见思路，核心引擎依据 Vim/Neovim 行为和 CodeMirror 6 API 独立实现。

详见[第三方声明](THIRD_PARTY_NOTICES.md)与[Vim 来源说明](docs/vim-engine-provenance.md)。
