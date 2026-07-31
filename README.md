# mv-AIDE

[English](README_EN.md)

**mv-AIDE** 是一款 Obsidian 桌面端 AI IDE 插件：它把 Claude Code、Codex CLI 以及任意支持 MCP 的 Agent 桥接到你的本地知识库，同时在 Obsidian 内提供划词调用 LLM、行内补全、系统终端、源码编写辅助与默认文件打开器等能力。

- 仓库：<https://github.com/aitingtingya/mv-obcc>
- 仅桌面端，要求 Obsidian 1.7.2 及以上

## 功能概览

1. **IDE 桥接**：向 Claude Code、Codex CLI 与通用 MCP Agent 提供 Obsidian 上下文（当前标签、选区、打开的文件），暴露 8 个 IDE 工具，支持 Diff 审核。
2. **划词助手**：在 Markdown / PDF / Web Viewer 中划词，用自定义提示词模板流式调用 LLM，结果输出到可拖拽、可固定的悬浮窗。
3. **行内补全**：Markdown 编辑器内的 ghost text 续写，支持接受、取消与拒绝后重生成。
4. **终端**：在 Obsidian 内拉起全功能系统终端（macOS/Linux PTY、Windows ConPTY），支持主题、自定义字体与文件路径联动。
5. **源码编写辅助**：把 `.tex` 等非 md 后缀注册为 Markdown view，按后缀配置 latex-suite 风格 Snippets、源码高亮与可选 TeX 增强渲染。
6. **默认文件打开器**：把 `.md` 及源码后缀注册为系统默认打开方式，库外文件经镜像目录在指定 vault 中打开。

另内置多提供商的 **API 提供商** 管理（划词助手与行内补全共用，见下文专节）。

## 安装

### 方法一：社区插件市场（推荐）

1. 在 Obsidian 中进入 **设置 → 第三方插件 → 社区插件 → 浏览**。
2. 搜索 `mv-AIDE`，点击安装并启用。

### 方法二：手动安装

1. 前往 [Releases](https://github.com/aitingtingya/mv-obcc/releases) 页面，下载最新版本的三个资产文件：`main.js`、`manifest.json`、`styles.css`。
2. 在 vault 插件目录下新建文件夹 `<vault>/.obsidian/plugins/mv-obcc/`，把三个文件复制进去。
3. 进入 **设置 → 第三方插件**，找到 `mv-AIDE` 并启用。

### 方法三：源码构建

```bash
npm install        # 安装开发依赖
npm run verify     # lint + 类型检查 + 测试 + 构建 + bundle 隔离检查
npm run deploy:local   # 构建并部署到相邻 vault（或指定 vault 路径）的插件目录
# 或者：
npm run package    # 生成 release/ 下的发布目录与 zip 包
```
## 功能详解

以下六节与设置页（**设置 → mv-AIDE**）的六个分区一一对应。

### 1. IDE 桥接

#### Claude Code / Codex / 通用 Agent 接入

- **启用 Claude Code IDE 功能**（默认开启）：自动写 Claude IDE lock、注册 MCP（服务名 `mv-aide`）、管理 hooks。关闭后不写 IDE lock、不注册 MCP、不接管 Claude 设置。验证：在 Claude Code 中输入 `/ide` 应提示已连接；`claude mcp get mv-aide` 可查看注册。
- **启用 Codex IDE 功能**（默认关闭）：开启后支持 Codex CLI `/ide` 上下文读取，并把本插件 MCP 工具以受管块写入 `~/.codex/config.toml`（配置键 `mcp_servers.mv_aide_obsidian`）。
- **暴露 mv-AIDE 协议**（默认关闭）：面向任意 MCP 客户端的独立授权开关，用户可以自行接入其它 agent；与 Claude Code、Codex 及 MCP 工具开关互不影响。只在本机 `127.0.0.1` 提供 Streamable HTTP 与 stdio 两种接入，每个 vault 使用独立随机 Bearer 令牌，支持协议版本 `2026-07-28` / `2025-11-25` / `2025-03-26`（由客户端协商）。设置页提供 **mv-AIDE 协议状态**、**复制 HTTP 配置**、**复制 stdio 配置**、**刷新状态** 与 **轮换令牌**（轮换后需更新所有客户端配置）。stdio 启动器只连接已经运行的 Obsidian，不会自行启动 Obsidian；服务在 Obsidian 启动完成后的空闲阶段按需加载，关闭开关或卸载插件即清理。
- 通用 MCP 以标准 resources 提供被动上下文：`obsidian://mv-aide/workspace/context`、`open-editors`、`latest-selection`、`latest-mention`；工具侧完整暴露与 Claude/Codex 相同的 8 个 IDE 工具。

#### 权限审核 hook（建议模式）

插件不随附各 agent 的 hook 实现，但推荐用 agent 自带的 hook 机制把写入确认接到 `openDiff` 上，复刻 Claude Code 的审核闭环：agent 的写入前 hook 拦截写文件工具 → 用磁盘旧内容与工具输入构造新内容 → 调通用 MCP 的 `openDiff` 弹审核页 → 接受则放行（由 agent 原生写入，插件从不写文件），拒绝则阻止该次写入。

Kimi Code 已验证配置（0.30+；hook 脚本需自备，作为普通 MCP 客户端连接 stdio 启动器）：

```toml
# ~/.kimi-code/config.toml
[[hooks]]
event = "PreToolUse"
matcher = "^(Write|Edit)$"
command = "node /path/to/your-diff-hook.mjs"
timeout = 600

[[permission.rules]]
decision = "allow"
pattern = "Write(F:/path/to/vault/**)"
```

已知限制：Kimi hook 只有放行/阻止、没有编程式「批准」，接受后跳过原生确认需靠 `permission.rules` 放行；权限规则只在会话启动时加载（改后要重启会话而非 `/reload`），glob 不匹配点目录（如 `.kimi-code` 需单独写规则）；审核页内手改不会回传给 agent（无 `updatedInput` 机制）；hook 超时上限 600 秒且超时/崩溃 fail-open；权限模式需嗅探会话目录 `wire.jsonl` 的 `permission.set_mode` 事件（未公开格式，可能随版本变化）。

#### 状态感知（被动）

- **支持所有活动页面**（默认关闭）：追踪任意 Obsidian 标签，并通过 Claude 会话 PID 和终端标题标记（`mv-aide:` 前缀）精确忽略该会话自己的终端；改变后请重新启动 Claude Code。
- 未开启"支持所有活动页面"时，可单独开关：**追踪 Markdown 页面**、**追踪 PDF 页面**、**追踪 Web Viewer 页面**。

#### 视觉辅助

- **切换标签时保留选区高亮**（默认开启）：切换到终端等特殊标签后，仍显示 Markdown、PDF 和网页中最后一次划词；回到原页面空点或重新划词时恢复 Obsidian 原有行为。此功能不影响发送给 Claude 的选区。

#### 主动：MCP 工具

- **启用 MCP 主动工具**：通过标准 MCP 提供给 Claude Code 和 Codex CLI；改变后请重启对应客户端或重新执行 `/mcp`。
- 四个可单独开关的工具：**获取最近标签与选区**（`getLatestSelection`）、**获取全部打开标签**（`getOpenEditors`）、**在 Obsidian 中打开文件**（`openFile`）、**读取最近网页为 Markdown**（`readCurrentWebPage`）。
- **网页工具最大返回字符数**：留空或填 0 表示不限，忠实返回当前已加载页面的完整可见内容；填正整数时才截断。
- 完整 IDE 工具集共 8 个：`getLatestSelection`、`getOpenEditors`、`openFile`、`readCurrentWebPage`、`openDiff`、`closeAllDiffTabs`、`getDiagnostics`、`close_tab`。其中 `openDiff` 仍在 Obsidian 内由用户接受或拒绝。
- **MCP 注册状态**：显示注册结果，可 **重新注册** / **清理注册**。
- **Claude 可执行文件** / **Codex 可执行文件**：通常自动检测；Windows 或自定义安装位置可填完整路径。

#### 上游兼容

- **上游模式**：**原生** 不改请求；**兼容** 会把 IDE system 上下文移动到对应 user 消息中（不复制两份），用于自定义 Anthropic Base URL 等场景。
- 兼容模式下可用：**Anthropic 上游地址（可选）**（留空自动读取 Claude 配置）、**当前识别的上游**、**自动管理当前仓库的 Claude 设置**（仅把当前仓库的 `ANTHROPIC_BASE_URL` 指向本地兼容端点；关闭时恢复插件接管前的值）。

#### Diff 与维护

- **Diff 审核行为**：完全跟随 Claude Code 权限模式——默认权限会在 Obsidian 内弹出基于 CodeMirror MergeView 的差异审核界面（可直接编辑、核对后确认写入）；`acceptEdits` 会直接接受编辑，插件不额外弹窗。
- **重启桥接**：重建本地服务和 Claude Code IDE lock 文件。
- **恢复插件管理的 Claude 设置**：只恢复本插件替换过的 `ANTHROPIC_BASE_URL`，不改其他配置。

### 2. 划词助手

- **总开关 → 启用**：完全独立于 IDE 桥接。开启后在 Markdown / PDF / Web Viewer 中划词，经右键菜单 `LLM → {模板}` 或快捷键调用预设提示词。
- **提示词模板**：支持 `{selection}` 占位符表示划词内容；不含占位符时划词会自动追加到末尾。每个模板可单独开关，并独立选择提供商、模型与思考模式（默认 / 开 / 关 / 自定义 JSON）。
- **悬浮窗**：流式输出回答；拖动标题栏移动位置、拖拽右下角缩放；**固定（Pin）** 后复用当前窗口，插入或替换内容后也不自动关闭；内嵌 Obsidian 原生 Markdown 编辑器，可就地排版修改。历史内容复用库内文件 `mv-aide-llm-history/latest.md`（每次调用覆盖，已对文件树、搜索与快速切换隐藏）。
- **划词自动触发模板**：选择模板后，左侧功能区出现「划词自动触发」按钮（点亮后才生效，每次启动默认关闭）；点亮后产生新选区即自动用所选模板调用助手。
- **网页视图注入右键菜单（实验性）**：因网页跨域隔离，Obsidian 读不到网页内的选区；开启后向网页注入脚本显示插件右键菜单（会屏蔽网页原生右键，部分站点可能失效）。关闭时网页视图改用快捷键——插件会自动把已绑定的「LLM：xxx」快捷键同步注入网页，网页内外用同一个快捷键。
- **PDF 视图**：右键菜单被 Obsidian / pdf++ 占用，无法注入 LLM 菜单，请用快捷键触发（在 Obsidian 快捷键设置中给「LLM：xxx」命令绑键）。

### 3. 行内补全

- **启用行内补全**：开启后左侧功能区出现「行内补全」按钮；按钮点亮时自动补全，未点亮时只响应手动请求按键。
- **补全模型**：复用上方 API 提供商配置，选择提供商与模型；**思考** 可设默认 / 开 / 关 / 自定义（自定义填 JSON）。
- **参数**（留空使用默认值）：**触发延迟** 700ms、**光标前上下文长度** 与 **光标后上下文长度** 各 2000 字符、**最大补全字符数** 200、**最大补全行数** 3。
- **快捷键**：**接受按键**（默认 Tab，插入当前 ghost text）、**取消按键**（默认 Esc，只清空不请求模型）、**拒绝按键**（可清空不绑定；绑定后把被拒绝的补全发回模型并请求另一版）、**手动请求按键**（可清空不绑定；按钮未点亮时也可请求一次）。点 **录制** 后直接按下想绑定的键即可。
- **补全提示词**三段自定义：**补全提示词主体**、**无需补全指令**、**拒绝后重生成指令**（支持 `{rejected}` 占位符代表被拒绝的补全文本），均可一键 **恢复默认**。注意：**无需补全指令** 中的 `<MV_SENCEAI_NO_COMPLETION>` 哨兵必须保留，修改或删除会导致无法正确抑制无效补全。

### 4. 终端

- **打开方式**：点击左侧功能区终端图标，或命令面板运行 `Open System Terminal (打开系统终端)`；插件不设默认快捷键，可在 Obsidian 快捷键设置中自行绑定。
- **终端打开位置**：右侧边栏（默认）/ 左侧边栏 / 中间主栏（以标签页打开）/ 底部拆分栏（首次自动按 75:25 高度拆分，再次打开并入既有底部面板的标签页）。
- **Shell 配置**：**macOS/Linux Shell 路径**（留空默认 `$SHELL` 或 `/bin/zsh`）与 **参数**（默认 `-l`）；**Windows Shell 路径**（留空默认 `cmd.exe`）与 **参数**。
- **字体与字号**：**自定义终端字体 (Font Family)**（可填 Nerd Font 如 `MesloLGS NF`，解决图标/分隔线乱码；留空默认 `Menlo, Monaco, monospace`）、**终端字号 (Font Size)**（默认 13px）、**终端按键直通 (Key passthrough)**（终端聚焦时把 Ctrl/Alt/F 键/方向键组合直接发给终端程序，不再触发 Obsidian 快捷键）。
- **Python 与依赖**：**Python 可执行文件路径**（留空则在 PATH 中自动寻找）；Windows 下 **Windows 依赖管理 (pywinpty)** 提供 **检测依赖** 与 **更新依赖** 按钮。
- **终端主题**：跟随 Obsidian / 浅色 / 深色 / 自定义；自定义主题从内置浅色或深色色板复制创建，只保存结构化颜色数据（不执行 CSS/JS），可 **恢复默认配色**。
- 终端内双击或 Ctrl+点击文件路径，可直接在编辑器中定位对应笔记。

### 5. 源码编写辅助

- **启用源码编写辅助**：按后缀管理源码类型 profile（默认带固定的 `Markdown (.md)` profile）。**添加新源码类型**（如 `.tex`、`.bib`、`.m`）后，该后缀自动注册为 Markdown view，并出现在左侧功能区与命令面板的「新建非 MD 源码文件」中。
- 每个 profile 提供：**启用该后缀的 snippets 替换**（关闭只停用该 profile 的 snippets、tabstop 与预览 runtime，不取消后缀注册、不影响高亮）与 **源码高亮主题**（内置主题 + 已载入的自定义主题）。
- **Snippets**：latex-suite 风格内核；填写格式与 Latex Suite 的 snippets 设置一致，可直接粘贴原 snippets 数组，行首 `//` 按 JS 注释处理。**手动触发按键**（默认 Tab）、**下一 tabstop**、**上一 tabstop** 可下拉选择或 **录制**。内核内置行为：IME 输入抑制与 snippet 去空白默认开启，调试输出默认关闭。
- `.tex` profile 额外提供 **打开 TeX 增强渲染**（实验功能，默认关闭）：用插件自定义 Live Preview 扩展渲染 `\(...\)`、`\[...\]` 和常见数学环境（公式预览显示在公式上方，带 `▶` 光标指示）；要求该 profile 的 snippets 替换开关处于开启状态，否则不会加载。
- **自定义代码高亮主题**：从本地 `.css` / `.json` 文件 **载入自定义代码高亮主题**，支持 Prism CSS、highlight.js CSS、VS Code / Shiki / TextMate JSON 与 mv-AIDE JSON（可自动检测格式）；非 Prism 格式会转换为近似效果，不能完全还原。
- **兼容性提醒**：若某后缀已由 Obsidian 或其它插件注册为其它 view，本插件会尝试解除原注册并改为 Markdown view，可能影响其它插件对同后缀文件的打开方式；TeX 增强渲染也可能影响光标移动、折叠或其它编辑器插件兼容性，建议按需开启。

### 6. 默认文件打开器

- **启用默认文件打开器**（默认关闭）：开启后启动本地服务，供系统默认打开器 wrapper 把电脑上的外部文件打开到当前 vault。
- **支持的后缀范围**：**仅支持 md** 或 **支持扩展后缀名**（扩展后缀来自源码编写辅助中已启用的 profile）。
- **系统默认打开方式**：提供 **检查** / **一键注入** / **清理**。检查会区分"不是默认打开器 / 其它 vault 是默认 owner / 当前 vault 是默认 owner"；注入不会覆盖已有或残缺注册，切换 vault 或更新后缀前请先清理再注入。
- **Windows 流程**：一键注入把 ProgId `MV.AIDE.FileOpener[.<后缀>]` 完整注册到"打开方式"和"默认应用"列表（显示名 **MV AIDE File Opener**）→ 自动打开 Windows 默认应用设置 → 由用户为每个后缀完成系统确认（Windows 8 及以上不允许应用静默替换默认应用；认准 MV AIDE File Opener，不要选 Windows Based Script Host）→ 再点 **检查** 确认 → 需要时用 **清理** 移除。注册只写当前用户的 `HKCU`，不申请管理员权限，也不写受保护的 `UserChoice`。
- **macOS / Linux 流程**：macOS 注入 `MV AIDE File Opener.app`（bundle id `com.mv.aide.file-opener`）；Linux 使用 `mv-aide-file-opener.desktop`；清理按钮同样适用。
- **镜像目录**（默认 `mv-aide-external-files/mirror`）：双击打开库外文件时，始终优先在该目录创建并验证真实 symlink；仅当创建失败且本机已授权时，才使用隔离的受管临时副本与双向同步。可手动点 **重试并迁移符号链接** 把安全收敛的副本迁回真实符号链接。
- wrapper 状态写入 `~/.mv-aide/`；wrapper 不安装常驻后台守护进程——Obsidian 关闭时，它会先通过 Obsidian URL 唤醒目标 vault，再等待插件本地服务启动。
- **Obsidian 内显示文件类型图标**：在标签页按后缀显示 MD、PY、TEX 等格式徽标（可关）；系统侧文件关联图标为白文档 + 后缀标注 + Obsidian 官方 logo 徽章。

## API 提供商

划词助手与行内补全共用此处的提供商配置（设置页"划词助手"分区顶部）。

- 支持配置多个提供商，类型可选 **OpenAI 兼容** 或 **Anthropic**。
- **API Base URL** 必填：OpenAI 兼容类型自动追加 `/chat/completions`，Anthropic 类型自动追加 `/v1/messages`。
- **API Key**：明文保存在插件 `data.json`；本地无鉴权服务（如 Ollama）可留空。
- **模型** 列表自由增删，模型名即发往 API 的值；删除提供商或模型会自动清掉引用它的模板与补全配置。
- **绕过 CORS(代理模式)**：默认关闭（流式逐字输出）。开启后改用 Obsidian 内部网络通道，可绕过部分端点对 `app://` Origin 的 CORS 拒绝（表现为"Failed to fetch"），但会失去流式、改为一次性返回。

## 安全与权限

- 所有本地服务（IDE 桥接、通用 MCP、默认打开器 wrapper 服务）只监听 `127.0.0.1`，不对局域网暴露。
- 「暴露 mv-AIDE 协议」开关默认关闭，每个 vault 使用独立随机 Bearer 令牌，可随时轮换。
- Windows 注册表只写当前用户 `HKCU`；**清理** 只删除本插件自身的注册，不申请管理员权限，不写受保护的 `UserChoice`。
- 默认文件打开器访问库外文件需显式启用；受管临时副本只在 symlink 明确失败且用户授权后使用。
- Claude / Codex 集成只写各自的 IDE lock、MCP 注册与受管配置块，不安装常驻后台守护进程。
- 划词助手、行内补全与终端的 API 调用或配置错误相互隔离，不影响 IDE 桥接通道。
- API Key 以明文保存于插件 `data.json`，请按需保护 vault 目录。

## 故障排查

- **Windows 终端无法拉起**：设置页"终端"分区点 **检测依赖**；失败则点 **更新依赖**，或手动执行 `pip install pywinpty`（自定义了 Python 路径时用对应解释器，如 `D:\Env\python.exe -m pip install pywinpty`）。
- **MCP 未连接**：终端执行 `claude mcp get mv-aide` 确认注册；在设置页 **MCP 注册状态** 点 **重新注册**；改动工具开关后需重启客户端或重新执行 `/mcp`。
- **Windows 默认应用未生效**：确认已在系统默认应用设置中为每个后缀选择 **MV AIDE File Opener**（不要选 Windows Based Script Host），再回到设置页点 **检查**。
- **资源管理器图标未更新**：属 Windows 图标缓存问题，重启资源管理器（`explorer.exe`）或注销重登后生效。
- **网页划词无反应**：网页右键注入为实验性，部分站点会失效；改用快捷键（插件已把快捷键同步注入网页）。

## 致谢

- 行内补全的 CodeMirror ghost-text 架构设计参考了 [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot)。
- 本地系统终端的 PTY 进程桥接架构参考了 [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar)。
- 源码编写辅助的 Snippets 内核 vendor 自 [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5`，并保留上游 MIT 许可声明。
- 本插件在运行时不绑定或依赖上述插件。
