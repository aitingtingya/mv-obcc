# mv-SenceAI

**mv-SenceAI** 是一款专为 Obsidian 打造的 AI 笔记、科研、与终端桥接插件。它能够在您的本地代码环境、命令行工具与 Obsidian 知识库之间建立无缝的数据通道与操作体验。

本插件包含四个相对独立的核心能力：
1. **IDE 桥接 (IDE Bridge)**：为 Claude Code 与 Codex CLI 提供 Obsidian 当前的上下文信息（如当前标签、选区内容）。Claude Code 侧支持标准 MCP 主动工具和差异审核（Diff）；Codex CLI 侧支持 `/ide` 上下文读取，并通过标准 MCP 使用 Obsidian 工具。
2. **划词助手 (LLM Assistant)**：完全独立于 IDE 桥接的内置功能。允许您在 Obsidian 的各种视图（Markdown、PDF、Web Viewer）中选中文本后，通过自定义提示词直接流式调用 OpenAI 或 Anthropic 兼容的语言模型 API。
3. **行内补全 (Inline Completion)**：在 Markdown 编辑器中显示 ghost text 续写建议，支持接受、取消、拒绝后重新生成，并可在左侧功能区一键启用/停用。
4. **系统终端 (System Terminal)**：在 Obsidian 内部拉起全功能的本地系统终端（支持 macOS/Linux Shell 与 Windows ConPTY），支持与 Obsidian 双向联动，双击或 Ctrl+点击终端内文件路径可直接在编辑器中定位笔记。

---

## 安装指南

安装本插件有三种方式：**官方社区安装**、**手动从 Releases 安装** 或 **从源码自行构建**。

### 方法一：从 Obsidian 官方插件社区安装（推荐）
1. 在 Obsidian 中进入 **设置 -> 第三方插件 -> 社区插件 -> 浏览**。
2. 搜索 `mv-SenceAI` 并点击安装。
3. 启用该插件。

### 方法二：手动从 Releases 安装
1. 前往 GitHub 仓库的 [Releases](https://github.com/aitingtingya/mv-obcc/releases) 页面，下载最新版本（例如 `0.6.0`）的以下三个资产文件：
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. 在您的 Obsidian Vault 插件目录下新建文件夹，路径为：`<vault>/.obsidian/plugins/mv-obcc/`
3. 将下载的这三个文件复制到该文件夹中。
4. 进入 Obsidian **设置 -> 第三方插件**，找到 `mv-SenceAI` 并启用它。

### 方法三：从源码自行构建安装
1. 克隆或下载本仓库 of 源码，并在项目根目录下执行编译构建：
   ```bash
   # 安装开发依赖项
   npm ci
   # 编译并构建项目
   npm run build
   ```
2. 在您的 Obsidian Vault 的插件目录下新建文件夹：`<vault>/.obsidian/plugins/mv-obcc/`
3. 将构建生成的以下三个文件复制到该文件夹中：
   - `dist/main.js` (复制到目标文件夹后，需要确保文件名为 `main.js`)
   - `manifest.json`
   - `styles.css`
4. 刷新或重启 Obsidian，在**第三方插件**中启用它。

---

## 第三方集成配置

### 1. Claude Code 侧配置
1. 确保 Obsidian 已启动且 `mv-SenceAI` 插件处于启用状态。
2. 在与该 Obsidian Vault 对应的本地目录中启动 Claude Code。
3. 验证连接状态：
   - 在 Claude Code 终端输入 `/ide`，应提示已连接到 Obsidian。
   - 输入 `claude mcp list`，应当能看到 `mv-senceai-ide` 已连接。

### 2. Codex CLI 侧配置
1. 确保本机已安装并登录 Codex CLI。
2. 在插件设置底部启用 `启用 Codex IDE 功能`。
3. 在与该 Obsidian Vault 对应的本地目录中启动 Codex CLI。
4. 在 Codex CLI 中输入 `/ide`，应提示已连接，并在后续消息中自动带入当前 Obsidian 标签和选区上下文。

---

## 使用指南

### 1. IDE 桥接功能
- **被动状态感知**：开启后，插件会将当前的标签页和选区状态被动同步给 Claude Code。支持“所有活动页面”追踪（Markdown、PDF 或是 Web Viewer）。
- **主动工具 (MCP)**：Claude Code 与 Codex CLI 可以通过 HTTP MCP 协议主动调用插件提供的工具，例如 `getLatestSelection`（读取选区）、`getOpenEditors`（获取打开的标签）、`openFile`（定位并打开 Vault 文件）、`readCurrentWebPage`（读取 Web Viewer 页面为 Markdown）。
- **差异可视化审核 (Diff)**：当 Claude 提议修改文件时，插件会在 Obsidian 侧弹出基于 CodeMirror MergeView 的差异比对界面。您可以在界面内直接编辑、核对并确认，确认后的内容会写入硬盘。

### 2. ✍️ 划词助手功能
1. **配置 API**：在设置中的“API 提供商”区域配置模型 Base URL、模型名称和 API Key。
2. **配置提示词**：支持配置多个自定义提示词模板，支持使用 `{selection}` 占位符。
3. **触发方式**：选中文本后，可以通过右键菜单选择 `LLM -> {您的模板}`。自动触发点亮时，仅在产生新选区时自动调用指定模板。
4. **结果输出 (悬浮窗)**：触发后流式输出回答，且：
   - **支持拖拽与缩放**：通过拖动标题栏移动位置，拖拽右下角调整大小。
   - **支持固定 (Pin)**：固定后，后续调用会复用当前悬浮窗，插入或替换内容后也不会自动关闭。
   - **Markdown 原生预览与就地编辑**：悬浮窗内嵌了 Obsidian 原生的 Markdown 编辑器，允许直接在此排版、修改。

### 3. ⌨️ 行内补全功能
1. **配置 API 提供商**：指定行内补全的 Base URL、模型，并可配置思考模式（Thinking Mode）和上下文长度参数。
2. **快捷键录制**：在设置页直接按下想要绑定的快捷键（如 Accept、Cancel、Reject 重生成）。
3. **按需控制**：点亮左侧功能区的“行内补全”图标时自动触发；关闭时不会自动打扰，但仍可通过手动请求快捷键触发一次。

### 4. 💻 系统终端功能
- **启动与快捷键**：点击左侧功能区终端 Ribbon 图标，或使用命令面板运行 `Open System Terminal`。默认系统快捷键为 **`Cmd/Ctrl + Shift + T`**。
- **外观自适应**：终端文字、背景、前景色和光标会自动提取当前 Obsidian 主题颜色并完美同步。
- **自定义 Shell 与路径**：可在设置中指定 macOS/Linux 和 Windows 的 Shell 可执行文件路径及启动参数。
- **打开位置自定义**：在“💻 终端设置”中选择“终端打开位置”：
  - **右侧边栏 (Right Sidebar)**（默认）：在右边侧栏打开，多开时自动合并为侧栏标签页（Tabs）。
  - **左侧边栏 (Left Sidebar)**：在左边侧栏打开，多开时合并为标签页。
  - **中间主栏 (Middle Main Split / Tabs)**：在中间编辑器区域以新标签页（Tab）方式打开。
  - **底部拆分栏 (Bottom Split Pane)**：从当前编辑器窗口的下方以水平分割线拆分出一个底部终端面板。
- **底部分栏 3:1 占比与多标签复用**：
  - 选择“底部拆分栏”时，首次打开将自动将上方编辑区与下方终端区域的高度比例设置为 **`75:25`（即底部 1/4 占比）**。
  - 若已存在底部终端，再次打开时**不会重复向下拆分，而是自动在新终端中直接作为标签页（Tab 2, Tab 3）并入当前底部分栏**，保持界面整洁。
- **自定义字体支持**：支持在终端设置中填写 `Nerd Fonts` 字体（如 `MesloLGS NF` 等）及字号，彻底解决因默认字体 Menlo 缺字导致的 Zsh/Powerlevel10k 复杂主题图标或分隔线乱码重影（显示为 `WWWW...`）的问题。

---

## Windows 系统 PTY 依赖手动安装指南

在 Windows 下运行 PTY 本地终端需要依赖 Python 环境和 `pywinpty` 第三方库。若在插件设置中点击“更新依赖”失败，可按照以下步骤进行手动安装：

1. **安装 Python**：确保您的 Windows 系统上已安装 Python（推荐 3.10 及以上版本），并在安装时勾选了 `Add Python to PATH`。
2. **手动安装依赖包**：
   打开 Windows 的命令提示符（CMD）或 PowerShell，运行以下命令：
   ```cmd
   pip install pywinpty
   ```
   *注意：如果您在系统中有多个 Python 环境，或者在插件设置中指定了自定义 Python 路径（例如 `D:\Env\python.exe`），请确保使用对应的 python 路径进行安装：*
   ```cmd
   D:\Env\python.exe -m pip install pywinpty
   ```
3. **在插件中配置**：在 Obsidian **设置 -> mv-SenceAI -> 💻 终端设置** 中，点击“检测依赖”以确认 `pywinpty` 已被成功检测到。若检测通过，即可正常拉起终端。

---

## 功能边界与注意事项

> [!WARNING]
> 请务必了解以下插件的限制与工作边界。
>
> - **网页读取限制**：Web Viewer 仅能读取当前已成功加载渲染的 DOM 文本。Shadow DOM、 Canvas、跨域 iframe 和图片中的未 OCR 文字无法提取。
> - **PDF 视图限制**：PDF 需带有底层文本层方可划词或读取。因 PDF 视图右键菜单被 Obsidian 占用，请使用快捷键触发划词调用。
> - **配置的隔离性**：划词助手、行内补全或系统终端的 API 调用/配置错误，**绝对不会**波及或影响 Claude Code / Codex CLI 桥接通道的稳定性。
> - **桌面权限说明**：Claude Code 集成会读取和更新 Claude 项目配置与 IDE lock 文件；Codex 集成会创建本地 IPC socket，并在 `~/.codex/config.toml` 中维护本插件的 MCP 服务地址，均不会启动外部进程后台守护服务。

---

## 鸣谢

- 行内补全的 CodeMirror ghost-text 架构设计参考了插件 [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot)。mv-SenceAI 在运行时不绑定或依赖该插件。
- 本地系统终端的 PTY 进程桥接架构与基本实现参考了插件 [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar)。mv-SenceAI 在运行时不绑定或依赖该插件。

---
---

# mv-SenceAI (English)

**mv-SenceAI** is a desktop bridge and system terminal plugin connecting your local vaults, CLI tools, and development environment to Obsidian.

This plugin provides four key capabilities:
1. **IDE Bridge**: Feeds contextual information (active tab, selections) from your vault to Claude Code and Codex CLI. Claude Code uses the existing IDE/MCP bridge; Codex CLI uses `/ide` context IPC plus standard MCP tools.
2. **LLM Assistant (Selection Reader)**: A completely independent feature to call OpenAI or Anthropic compatible APIs directly from Obsidian views (Markdown, PDF, Web Viewer) using custom prompt templates, streaming responses into a floating output window.
3. **Inline Completion**: A separate Markdown-only ghost-text completion module with accept, cancel, and reject/regenerate shortcuts, controllable via a ribbon toggle button.
4. **System Terminal**: Spawns fully functional local system terminals (macOS/Linux Shell & Windows ConPTY) inside Obsidian, supporting automatic dark/light theme sync, customized fonts, and file path click-to-open integration.

---

## Installation Guide

You can install this plugin either **via the Community Plugin Store**, **manually from Releases**, or **by building from source**.

### Method 1: Installing via Obsidian Community Plugins (Recommended)
1. In Obsidian, go to **Settings -> Community Plugins -> Browse**.
2. Search for `mv-SenceAI` and click Install.
3. Enable the plugin.

### Method 2: Manual Installation from Releases
1. Go to the [Releases](https://github.com/aitingtingya/mv-obcc/releases) page of this repository and download the latest release files (e.g. `0.6.0`):
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Create a new folder named `mv-obcc` under your vault's plugins directory: `<vault>/.obsidian/plugins/mv-obcc/`
3. Copy the three downloaded files into this folder.
4. Enable the plugin under **Settings -> Community Plugins**.

### Method 3: Build From Source
1. Clone this repository and compile the source code in the project root:
   ```bash
   # Install dependencies
   npm ci
   # Compile and build the plugin
   npm run build
   ```
2. Create a folder named `mv-obcc` under your vault's plugins directory: `<vault>/.obsidian/plugins/mv-obcc/`
3. Copy the compiled files into the new directory:
   - `dist/main.js` (Rename this file to `main.js` in the destination folder)
   - `manifest.json`
   - `styles.css`
4. Enable the plugin in Obsidian settings.

---

## Third-Party Integration Configuration

### 1. Claude Code Configuration
1. Make sure Obsidian is running and `mv-SenceAI` is enabled.
2. Start Claude Code in the local directory corresponding to the active Obsidian Vault.
3. Verify connection:
   - Run `/ide` in Claude Code; it should confirm the connection to Obsidian.
   - Run `claude mcp list` and ensure `mv-senceai-ide` tools are listed.

### 2. Codex CLI Configuration
1. Ensure Codex CLI is installed and you are logged in.
2. Enable `Enable Codex IDE` at the bottom of the plugin settings.
3. Start Codex CLI in the matching vault directory.
4. Run `/ide` in Codex CLI to establish the active tab/selection context connection.

---

## Usage Guide

### 1. IDE Bridge Feature
- **Passive Context Sync**: Once enabled, active tab and selection state are passively synced to Claude Code. Supports tracking Markdown, PDF, and Web Viewer.
- **Active Tools (MCP)**: Claude Code and Codex CLI call plugin tools via standard HTTP MCP. Available tools: `getLatestSelection`, `getOpenEditors`, `openFile`, and `readCurrentWebPage`.
- **Diff View & Review**: When Claude proposes file modifications, the plugin displays a CodeMirror MergeView diff interface. You can review and edit changes directly before confirming execution.

### 2. ✍️ LLM Assistant Feature
1. **API Setup**: Set Base URL, model name, and API Key under the "API Provider" section.
2. **Prompt Templates**: Create templates utilizing the `{selection}` placeholder.
3. **Trigger**: Select text and trigger via the right-click menu `LLM -> {Your Template}`. If the ribbon auto-trigger is active, text selection automatically fires the template.
4. **Floating Window**: Outputs response stream into a movable/resizable window:
   - **Drag and Resize**: Drag title bar to move, drag bottom-right corner to resize.
   - **Pin Window**: Pinning reuses the current window and keeps it open after inserting/replacing text.
   - **Native Editor**: Houses a native Obsidian Markdown editor inside for editing/formatting.

### 3. ⌨️ Inline Completion Feature
1. **Configure Provider**: Select Base URL, model, thinking parameters, and raw Markdown context bounds.
2. **Keyboard Bindings**: Record shortcuts for Accept, Cancel, and Reject-Regenerate.
3. **Control Toggle**: Ribbons toggle handles auto-completion; when turned off, completions are only requested via manual shortcut.

### 4. 💻 System Terminal Feature
- **Spawning**: Spawn via the ribbon terminal icon or by running `Open System Terminal` in the command palette. Default shortcut is **`Cmd/Ctrl + Shift + T`**.
- **Visual Theme Sync**: Terminal background, foreground, selection, and cursor adapt to match Obsidian's active theme.
- **Custom executable path**: Define executable shell path and arguments for macOS/Linux and Windows.
- **Customizable Open Position**: Configure "Terminal Open Position" in settings:
  - **Right Sidebar (Default)**: Opens in the right panel; subsequent terminals merge into tabs.
  - **Left Sidebar**: Opens in the left panel; subsequent terminals merge into tabs.
  - **Middle Main Split**: Opens in the editor pane as standard tabs.
  - **Bottom Split Pane**: Opens as a horizontal split below the active pane.
- **Bottom Split 3:1 Height & Tab Reuse**:
  - Horizontal split automatically sets height ratio to **`75:25` (bottom 1/4 layout)**.
  - Subsequent terminal spawns **automatically merge as tabs (Tab 2, Tab 3) in the existing bottom panel** instead of stacking vertically.
- **Custom Font Support**: Specify customizable `Nerd Fonts` (e.g. `MesloLGS NF`) and font size in settings, solving characters or dividers formatting glitch (`WWWW...`) caused by Menlo default font.

---

## Windows Manual PTY Dependency Installation Guide

Spawning terminals on Windows relies on Python and the `pywinpty` package. If the "Update Dependencies" button fails, perform the manual installation:

1. **Install Python**: Verify Python (3.10+ recommended) is installed on Windows, with `Add Python to PATH` checked during setup.
2. **Install pywinpty Package**:
   Open CMD or PowerShell and execute:
   ```cmd
   pip install pywinpty
   ```
   *Note: If you have multiple Python environments or designated a custom path (e.g., `D:\Env\python.exe`), run pip via the target interpreter:*
   ```cmd
   D:\Env\python.exe -m pip install pywinpty
   ```
3. **Verify Settings**: Go to **Settings -> mv-SenceAI -> 💻 Terminal Settings**, and click "Verify Dependencies" to ensure `pywinpty` is detected.

---

## Limitations & Boundary Conditions

> [!WARNING]
> Please review the limitations of the web reader and PDF highlights.
>
> - **Web Reader Limits**: Standard iframe, Canvas, shadow DOM, and scanned PDF OCR limitations apply.
> - **PDF Interface**: Scanned PDFs without text layers cannot be read. Use shortcuts to trigger the LLM Assistant as the PDF right-click menu is locked by Obsidian.
> - **Config Isolation**: LLM Assistant, Inline Completion, and System Terminal configurations are fully isolated and **will not** interfere with Claude Code or Codex CLI IDE bridges.
> - **Permissions**: Integrated Claude Code and Codex CLI bridges manage project lock files, settings, and local Unix domain socket IPC; they do not start persistent background daemon processes.

---

## Acknowledgements

- The CodeMirror ghost-text architecture for Inline Completion was informed by [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot). mv-SenceAI has no runtime dependency on that plugin.
- The PTY process bridge architecture for the local terminal was informed by [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar). mv-SenceAI has no runtime dependency on that plugin.
