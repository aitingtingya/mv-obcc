# mv-AIDE 完整功能手册

[返回 README](../README.md) | [English](features-en.md)

本文档对应 mv-AIDE `0.9.7`，以设置页顺序记录功能、默认值、边界和故障处理。README 负责快速了解产品；本文档是功能行为的完整参考。

## 目录

- [概览](#overview)
- [运行要求](#requirements)
- [设置分区](#settings-map)
- [1. IDE 桥接](#ide-bridge)
- [2. mv-agent](#mv-agent)
- [3. 划词助手](#selection-assistant)
- [4. 行内补全](#inline-completion)
- [5. 终端](#terminal)
- [6. 源码编写辅助](#source-assist)
- [7. Vim 增强](#vim)
- [8. 默认文件打开器](#default-opener)
- [9. 文件系统与浏览器](#filesystem-browser)
- [API 提供商](#api-providers)
- [跨功能关系](#cross-feature)
- [命令与入口](#commands)
- [平台支持矩阵](#platform-matrix)
- [数据与网络边界](#storage-network)
- [故障排查](#troubleshooting)
- [来源与许可](#acknowledgements)

<a id="overview"></a>
## 概览

mv-AIDE 是 Obsidian 桌面端 AI IDE 插件。九个功能分区彼此独立，通过一条受控主线共享编辑器上下文：Agent 能读取当前工作现场，AI 能直接参与文字编辑，终端和源码工具留在 Obsidian 内，Vim、默认打开器和文件浏览则扩展编辑器与操作系统的边界。

设计原则：

- **本地优先**：本地服务只监听回环地址，不安装常驻后台守护进程。
- **显式启用**：网络模型、Vim、通用 MCP、默认打开器、外部命令等高影响功能都有独立开关。
- **按仓库隔离**：配置、Vimrc、库外文件镜像和运行状态以当前 vault 为边界。
- **可审核编辑**：Agent 修改可回到 Obsidian 的可编辑 Diff，而不是隐藏执行。
- **关闭即退出链路**：关闭模块后释放其编辑器扩展、监听器、状态项和本地服务。

<a id="requirements"></a>
## 运行要求

| 项目 | 要求 |
| --- | --- |
| Obsidian | 1.7.2 或更高版本 |
| 平台 | 桌面端；不支持移动端 |
| 插件 ID | `mv-obcc` |
| 网络 | 仅 AI 提供商与用户配置的 Agent 需要；其它核心编辑功能可离线运行 |
| 终端 | macOS/Linux 使用 PTY；Windows 使用 ConPTY/`pywinpty` |
| 默认打开器 | macOS、Windows、Linux；各平台需要一次系统注册或确认 |

推荐从社区插件市场安装。手动安装时，插件目录必须同时包含 `main.js`、`manifest.json`、`styles.css`。

<a id="settings-map"></a>
## 设置分区

| 顺序 | 分区 | 默认状态 | 主要作用 |
| --- | --- | --- | --- |
| 1 | IDE 桥接 | Claude 开；Codex、通用 MCP、dsh 关 | Agent 上下文、工具、Diff 审核 |
| 2 | mv-agent | 关 | 内置 DSH：环境安装、插件注入、视图与库外策略 |
| 3 | 划词助手 | 关 | 对 Markdown、PDF、网页选区调用 LLM |
| 4 | 行内补全 | 关 | Markdown ghost text 补全 |
| 5 | 终端 | 可用，默认右侧打开 | 系统 Shell、路径联动、MCP 输出 |
| 6 | 源码编写辅助 | 开；仅内置 Markdown profile | 非 md 后缀、Code Suite、Lint、TeX |
| 7 | Vim 增强 | 所有后缀均关 | 独立 Vim 引擎与仓库级 vimrc |
| 8 | 默认文件打开器 | 关 | 系统文件关联与库外文件镜像 |
| 9 | 文件系统与浏览器 | 三个入口均开 | 下载、历史、任意目录浏览 |

界面语言默认中文。所有设置保存在当前 vault 的插件数据中，不跨 vault 自动同步。

<a id="ide-bridge"></a>
## 1. IDE 桥接

### 目的与启用方式

IDE 桥接把 Obsidian 的活动上下文提供给 Claude Code、Codex CLI、通用 MCP 客户端或 DeepSeek Harness（dsh），并把 Agent 的文件修改带回 Obsidian 审核。

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| 启用 Claude Code IDE 功能 | 开 | 写入统一 discovery lock（`~/.mv-aide/ide`）并在 `~/.claude/ide` 写 Claude 兼容镜像，注册 `mv-aide` MCP，并管理必要 hooks/config |
| 启用 Codex IDE 功能 | 关 | 写入受管 MCP 配置块，提供 `/ide` 上下文 |
| 启用 dsh IDE 功能 | 关 | 启动 IDE 桥接并把权威 discovery lock 写入 `~/.mv-aide/ide`，使 dsh 中的 mv-AIDE 插件可连接本仓库 |
| 暴露 mv-AIDE 协议 | 关 | 向其它 MCP 客户端开放独立授权的 HTTP/stdio 接口 |
| 自动管理当前仓库 Claude 设置 | 开 | 仅管理当前仓库被插件接管的 `ANTHROPIC_BASE_URL` |
| 上游模式 | 原生 | 原生不改请求；兼容模式把 IDE system 上下文移动到 user 消息，不复制两份 |
| 支持所有活动页面 | 关 | 开启后追踪任意 Obsidian 标签；会精确忽略当前 Agent 自己的终端 |
| 追踪 Markdown / PDF / Web Viewer | 开 / 开 / 开 | “支持所有活动页面”关闭时分别控制页面类型 |
| 切换标签时保留选区高亮 | 开 | 离开页面后保留最后选区的视觉提示，不改变发送内容 |
| 推送 Lint 错误 | 开 | 将 Source Assist 诊断提供给 Agent |
| 包含标题面包屑 | 开 | 给选区补充所在标题层级 |

关闭 Claude 或 Codex 开关时，插件只清理由自己写入的注册和受管配置，不改客户端其它配置。Claude Code 可用 `/ide` 验证 IDE 连接，并用 `claude mcp get mv-aide` 查看注册；Codex 配置以受管块写入 `~/.codex/config.toml` 的 `mcp_servers.mv_aide_obsidian`。修改“支持所有活动页面”后应重启 Claude Code。

保留选区高亮只是一层视觉状态：切到终端等标签后仍能看到 Markdown、PDF 或网页的最后选区；回到原页面空点或重新划词后恢复 Obsidian 原有行为。

### 上下文与工具

可单独开关的 11 个公共工具默认全部开启，唯独网页全文读取默认关闭：

| 工具 | 默认 | 作用 |
| --- | --- | --- |
| `getLatestSelection` | 开 | 最近标签、选区与上下文 |
| `getOpenEditors` | 开 | 当前打开的编辑器和标签 |
| `openFile` | 开 | 在 Obsidian 中打开文件并定位 |
| `readCurrentWebPage` | 关 | 把当前已加载网页的可见正文转换为 Markdown |
| `getDiagnostics` | 开 | 当前 Source Assist/Lint 诊断 |
| `getTerminalOutput` | 开 | 最近终端输出，`lastN` 为 1–500，默认 50 |
| `searchVaultSymbols` | 开 | 搜索仓库符号 |
| `getBacklinks` | 开 | 当前笔记反向链接 |
| `getOutgoingLinks` | 开 | 当前笔记出链 |
| `searchTags` | 开 | 搜索标签 |
| `listNotesByTag` | 开 | 按标签列出笔记 |

协议内部另有 `openDiff`、`closeAllDiffTabs`、`close_tab` 三个审核/界面工具，因此通用 MCP 完整工具集为 14 个。Claude/Codex 通道按公共工具开关暴露；用户主动启用的通用 MCP 接口提供完整集合。

`readCurrentWebPage` 的最大返回字符数留空或为 `0` 时不限；正整数才截断。工具读取的是当前已经加载且可见的页面，不绕过登录、付费墙或浏览器安全边界。

通用 MCP 还提供 5 个只读资源：

- `obsidian://mv-aide/workspace/context`
- `obsidian://mv-aide/workspace/open-editors`
- `obsidian://mv-aide/workspace/latest-selection`
- `obsidian://mv-aide/workspace/latest-mention`
- `obsidian://mv-aide/workspace/diagnostics`

### MCP 协议与生命周期

- 支持 MCP 协议版本 `2026-07-28`、`2025-11-25`、`2025-03-26`，由客户端协商。
- Streamable HTTP 和 stdio 都绑定当前 vault；HTTP 只监听 `127.0.0.1`，使用每仓库独立随机 Bearer token。
- 设置页可复制 HTTP/stdio 配置、刷新状态和轮换 token。轮换后必须更新所有客户端。
- stdio 启动器只连接已经运行的 Obsidian，不负责唤醒应用。
- 服务在 Obsidian 启动空闲阶段按需加载；关闭开关或卸载插件会清理服务和注册。
- Claude/Codex 可执行文件通常自动检测，Windows 或自定义安装可填写完整路径。

### Diff 与权限

`openDiff` 使用 CodeMirror MergeView。默认权限模式下，用户可以查看、修改并接受或拒绝差异；`acceptEdits` 模式遵循 Agent 原生权限并直接接受。插件不会绕开 Agent 权限模式。

其它 Agent 可以用自己的 PreToolUse/hook 在写入前调用 `openDiff`。是否能在接受后跳过 Agent 自己的确认、是否支持回传修改后的输入、hook 超时策略，取决于对应客户端，不属于 MCP 标准保证。

Kimi Code `0.30+` 已验证可作为普通 MCP 客户端连接 stdio 启动器。hook 脚本需由用户自行提供；一个最小配置形态如下：

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

Kimi 当前只有放行/阻止，没有可编程“批准”；接受 Diff 后若要跳过原生确认，仍需 `permission.rules`。权限规则只在会话启动时加载，glob 不自动匹配点目录；审核页中的手工改动不能通过 `updatedInput` 回传。hook 上限 600 秒且超时/崩溃为 fail-open；权限模式识别依赖未公开的 `wire.jsonl` 中 `permission.set_mode` 事件，客户端升级后可能变化。

### 上游兼容与回退

原生模式不改 Agent 请求。兼容模式只用于自定义 Anthropic 上游：它把 IDE system 上下文移动到同一请求的 user 消息中，并可把当前仓库的 `ANTHROPIC_BASE_URL` 临时指向本地兼容端点。Anthropic 上游地址留空时自动读取 Claude 配置，设置页同时显示当前识别结果；关闭后只恢复插件接管前的值。

桥接失败时，编辑器、划词助手、行内补全、终端和源码工具仍可独立运行。“重启桥接”会重建本地服务与统一 discovery lock（含 Claude 兼容镜像）；“恢复插件管理的 Claude 设置”只恢复被接管的 `ANTHROPIC_BASE_URL`。也可使用“重新注册”或“清理注册”，清理不会删除其它 MCP 服务。

### dsh 支持

dsh 是第四个已适配 Agent。开启「启用 dsh IDE 功能」后，插件启动 IDE 桥接并把权威 discovery lock 写入 `~/.mv-aide/ide`，dsh 中安装的 `@mv-aide/dsh-plugin` 会扫描该 lock 文件，用与 Claude Code 相同的本地 JSON-RPC 协议连接本仓库（`127.0.0.1`、端口 `47000 + 仓库种子 % 1500`）。连接后 dsh 侧出现：

- `/mv-aide` 命令：`status`（本会话连接状态与桥信息）、`bridges`（列出所有 IDE 桥）、`connect <序号|端口|路径|auto>`（单会话手动选择/切回自动）、`tools`（列出 IDE 工具）、`selection`（读取当前选区）、`call <name> [json]`（调用任意桥接工具）。桥接选择按 dsh 会话独立持久化，重启 dsh 后仍恢复。在 `/` 菜单选中 `mv-aide` 后会先把命令补全进输入框（`/mv-aide `，选 `connect` 后为 `/mv-aide connect `），再继续弹出二级字段（`connect` 再弹桥列表、`call` 再弹工具列表），选中叶子才执行；选择器自身的错误以中文显示。
- `mv_aide__*` 原生工具（如 `mv_aide__getLatestSelection`、`mv_aide__openFile`），与本章「上下文与工具」的公共工具一一对应，遵守同一组工具开关。
- 被动上下文通知与 Diff 审核：dsh Agent 获得与 Claude Code 相同的选区推送和 `openDiff` 审核通道。

插件注入、环境安装和库外策略属于独立功能分区，见[第 2 章 mv-agent](#mv-agent)。

<a id="mv-agent"></a>
## 2. mv-agent

mv-agent 把 DeepSeek Harness（DSH）内嵌进 Obsidian：直接使用 DSH Web 界面，并把环境安装、插件注入、视图与库外边界控制收进一个独立分区。它与 IDE 桥接共享同一条本地桥接服务——mv-agent 负责把 DSH 装起来、接进来、管理范围，Agent 的上下文与工具仍经由第 1 章的桥接通道。

### 目的与启用方式

- **总开关**位于 IDE 桥接分区的「已适配 agent」区域（「启用 dsh IDE 功能」，默认关）。关闭后桥接不启动、不写 lock 文件，mv-agent 分区的其余设置保留但不生效。
- **视图**：命令面板提供「打开 mv-agent」「停止 mv-agent」「重启 mv-agent」，快捷键可在 Obsidian 快捷键设置中绑定。「停止 mv-agent」会关闭所有已打开的 mv-agent 界面并停止对应的 DSH 后台。视图是一个自定义 Obsidian 视图：上方 iframe 直接嵌入 DSH Web 界面（无浏览器工具栏），底部是 Obsidian 侧状态栏，显示当前已连接的 IDE 桥接客户端数和最新选区快照。
- **打开分区**：可选左/右/下，默认右侧。「重启 mv-agent」会重启插件托管的 `dsh web` 进程并刷新所有已打开视图。
- **终端感知增强**：默认关闭，只影响 mv-agent / DSH。开启时 mv-agent 不注册基础 `mv_aide__getTerminalOutput`，改为注册 `list/read/send/run/open/focus` 六个 mv-AIDE 原生终端工具；关闭时六个增强工具撤销并恢复原来的 `getTerminalOutput`。切换立即刷新工具，不重启 DSH，也不改变其它 IDE 客户端的公共 `tools/list`。库外权限继续复用 `getTerminalOutput` 的范围设置。
- **隐藏 Obsidian 原生状态栏**：默认关闭，只给 `body` 增减专用 class 并隐藏 Obsidian 自身 `.status-bar` 容器；不针对 mv-agent 自有状态栏写选择器，也不会触发桥接重连、DSH 重启或工具刷新。
- **地址与端口**：DSH Web 服务只绑定 `127.0.0.1`，默认端口 `3080`，可在设置中修改。视图自动探测已运行的 dsh 实例；未运行时显示「mv-agent 未运行」。

### 运行环境

设置页把运行环境拆成 Node.js、DSH、pnpm 和插件注入四层，每层都有独立检测结果和安装、升级、注入或修复按钮。

- DSH 支持 Node.js `22.19+` 的 22.x 或 `24+`。mv-AIDE 的仓库运行时固定使用经过 SHA-256 校验的官方 Node.js `24.18.1`。
- 缺失 Node.js、DSH 或 pnpm 时，点击对应按钮后选择“当前仓库”或“全局”；已安装但需要升级时严格在原位置执行，不再次询问位置。
- 点击下层项目会先补齐它依赖的上层。例如插件注入会依次确保 Node.js、DSH 和 pnpm 可用，每层完成后都重新读取真实状态。
- 仓库安装的最终运行时位于 `<vault>/mv-aide/dsh/`；下载、npm 缓存、安装脚本和 staging 仅存在于单次操作的临时工作区，成功、失败或取消后都会清理。全局 Node.js、DSH 或 pnpm 安装需要写受保护目录时，会弹出 macOS 管理员确认、Windows UAC 或 Linux `pkexec`，用户拒绝后停止且不会降级到仓库。
- macOS 全局 Node 安装会在 SHA-256 校验通过后，把公开的官方 `.pkg` 临时放到 `/private/tmp` 供系统安装服务读取；安装结束、失败或取消后都会删除该临时文件。
- 仓库和全局同时存在时优先使用仓库版本。插件注入写入当前 DSH web profile；缺失时显示“注入”，旧版或不完整时显示“修复”，已就绪时可“更新”。
- 安装下载只由用户点击触发。Node.js 下载先写入仓库临时目录，校验失败或安装取消会删除临时文件并保留原运行时。

### 插件注入与 DSH 侧能力

「插件注入」把 `@mv-aide/dsh-plugin` 注册进当前 DSH web profile 的 patch 层，DSH 热加载该目录，无需重启。注入后（能力细节见第 1 章「dsh 支持」）：

- `/mv-aide status | tools | bridges | connect <序号|端口|路径|auto> | selection | call <name> [json]` 命令；
- 与公共工具开关对应的 `mv_aide__*` 原生工具；
- 被动上下文通知与 Obsidian 可编辑 Diff 审核。

### DSH 插件、技能与预设管理

mv-agent 设置页和 DSH Web 页注入的 `/api/mv-aide/*` 管理面板现在执行真实安装而不是只写配置：

- **导入插件**：本地目录先经 `dsh plugin --profile web add file:<目录>` 安装到 `profiles/web/node_modules`，再注册 patch 行；`dsh` 不可用时回退为 `file:` 热加载并明确提示。卸载同时移除 patch 行与 profile 依赖。
- **克隆预设**：复制源预设的完整目录（含 `agent.cordis.yml` 与本地插件文件），新预设可被 DSH 正常挂载；不再写 DSH 不认识的 `base:` 字段。
- **预设启停**：用户预设通过目录改名（`<id>.disabled`）真实隐藏/恢复，不再写 DSH 不读取的 `disabled:` 字段；系统预设不支持停用。
- **新建技能**：写入 `$DSH_HOME/skills`（DSH 的真实用户技能根，热监听），并强制名称符合 DSH 的 kebab-case 规则，避免生成被静默忽略的技能。

### Diff 即权限

dsh 插件包装写文件工具：当一次写入需要 DSH 的权限确认（`write`/`edit` 升级重试）或会被现行策略直接拒绝（如只读模式下的 `str_replace_editor`）时，不再弹默认网页确认卡，而是通过桥接在 Obsidian 中打开可编辑 Diff：

- **接受** → 批准后的（可能已手工修改的）内容由 dsh 插件真实写盘，该次写入即权限授予。
- **拒绝** → 返回合成失败（未写入任何内容）。
- **桥接断开 / 超时 5 分钟 / 文件不可读 / 适配失败** → 回落到 DSH 默认确认流程，不改变行为。
- 触发边界：`danger-full-access` 下从不触发；只读工具与 `str_replace_editor` 的 `view` 不触发；`bash`/`pwsh` 不在覆盖范围，仍走 DSH 自身确认。
- 库内文件总是审核；**库外文件**仅当「使用 Obsidian 审阅仓库外 diff」开启时审核（默认关）。
- 已知限制：该写入不经过 DSH 的沙箱账本（不发出 `fs/observed`，审批不进入 DSH 审批审计），接受后模型可能再次读取文件确认。

### 被动上下文

桥接把选区变化推给 dsh 插件，插件注入 Agent 的 inbox，不需要 Agent 调用工具。两种投递模式（设置 → mv-agent → 被动推送）：

- **实时跟踪活动轨迹（live，默认）**：每次稳定选区状态即时注入，400ms 防抖、完全相同内容去重、未消费时原位替换；同一文件内的纯光标移动与低于防抖窗口的 URL 变化跳过。
- **仅发送消息时推送一次（on-send）**：只缓存，用户发送消息的那一刻推送一份快照；Agent 工作中不注入。显式 @提及在两种模式下都会唤起 Agent。

两种模式共有：`selection_changed` 作为插件上下文注入 inbox，上限 6000 字符，不唤醒空闲 Agent；@提及会 steering 当前 Agent 并触发行动（5 秒内重复 @提及去重）。状态栏的「位置」「选中」勾选框控制是否推送对应内容（轨迹跟踪开启时强制生效）。库内 Agent 总是收到推送；库外 Agent 按「库外项目工具策略」逐通道决定（默认全关）。

### 库外项目策略

mv-agent 分区的「IDE 工具」网格与 IDE 桥接的工具列表一一对应，区别是每一项末尾的控制从开关换成**范围下拉**：「仅库内工作区 / 库内外均可用」。所有通道默认仅库内。库外 Agent 调用未开放的通道会收到错误而不是桥接调用。网格中的「Diff 审核行为」行写入独立开关「使用 Obsidian 审阅仓库外 diff」（默认关），控制库外写入是否走 Obsidian Diff 审核。

<a id="selection-assistant"></a>
## 3. 划词助手

总开关默认关闭，独立于 IDE 桥接。启用后可在 Markdown、PDF、Web Viewer 中对选区调用模板。

- Markdown：右键 `LLM → 模板` 或快捷键。
- PDF：右键菜单通常由 Obsidian/pdf++ 占用，使用快捷键。
- Web Viewer：默认使用注入到网页中的已绑定快捷键；实验性的网页右键菜单会屏蔽网页原生右键，并可能被站点安全策略阻止。

### 提示词模板

内置“翻译”“总结”“润色”三个启用模板。每个模板独立配置：名称、启用状态、提示词、提供商、模型和思考模式。`{selection}` 表示选区；模板不含该变量时，选区自动追加在末尾。

思考模式可选默认、开启、关闭或自定义 JSON。自定义内容直接传给兼容提供商，是否生效取决于 API。

### 输出窗口与历史

- 回答以流式方式进入可拖动、可缩放的悬浮 Markdown 编辑器。
- 可以插入到光标、替换原选区或保留为独立结果。
- Pin 后复用同一窗口，插入或替换后也不自动关闭。
- 最近内容写入 `<vault>/mv-aide/llm-history/latest.md`，每次调用覆盖；该文件从文件树、搜索和快速切换中隐藏。
- “划词自动触发”每次启动默认关闭，必须在功能区手动点亮；只对启动后产生的新选区生效。

请求失败只在悬浮窗显示错误，不改原文。关闭总开关后移除右键入口、快捷键注入、自动触发监听和悬浮窗口运行链。

<a id="inline-completion"></a>
## 4. 行内补全

### 默认参数

| 设置 | 默认值 |
| --- | --- |
| 启用行内补全 | 关 |
| 自动补全按钮 | 每次启动未点亮 |
| 触发延迟 | 700 ms |
| 光标前上下文 | 2000 字符 |
| 光标后上下文 | 2000 字符 |
| 最大补全长度 | 200 字符 |
| 最大补全行数 | 3 |
| 接受 | `Tab` |
| 取消 | `Escape` |
| 拒绝并重生成 | 未绑定 |
| 手动请求 | 未绑定 |

启用后，功能区按钮控制自动触发；按钮未点亮时仍可使用手动请求键。补全只在 Markdown 编辑器中显示 ghost text，不会在请求完成前写入文档。

### 提示词与结果

可配置提示词主体、无需补全指令、拒绝后重生成指令。拒绝指令支持 `{rejected}`。无需补全指令中的 `<MV_AIDE_NO_COMPLETION>` 是协议哨兵，删除或改写会使“无需补全”结果无法稳定识别。

接受后用一个编辑事务写入；取消只清空建议；拒绝可把原建议发送给模型并请求另一版。新编辑、光标移动、文件切换或关闭功能都会使过期请求失效，旧响应不能覆盖新位置。

### 与其它输入功能的关系

AI 建议可见时优先消费接受/取消键。Vim Insert 模式中的完整优先级见[跨功能关系](#cross-feature)。模型和 API 配置与划词助手共用，但启用状态、提示词和运行生命周期独立。

<a id="terminal"></a>
## 5. 终端

### 打开与布局

通过功能区终端图标或命令面板“打开系统终端”启动。插件不绑定默认快捷键。

| 设置 | 默认值/选项 |
| --- | --- |
| 打开位置 | 右侧栏；也可选左侧栏、主栏、底部分栏 |
| 新终端打开方式 | 分屏（默认）或新建标签页；与打开位置独立 |
| 布局规则 | 左/右侧栏分屏为上下；主栏分屏为左右；底部首次从主栏上下拆出底栏，后续按打开方式在底栏中新建标签页或左右分屏 |
| macOS/Linux Shell | `$SHELL`，找不到时 `/bin/zsh` |
| macOS/Linux 参数 | `-l` |
| Windows Shell | `cmd.exe` |
| Windows 参数 | 空 |
| 字体 | `Menlo, Monaco, monospace` |
| 字号 | 13 px |
| 按键直通 | 开 |
| 主题 | 跟随 Obsidian；也可浅色、深色、自定义 |

主栏、侧栏和底部可以同时存在多个终端。关闭终端标签会结束对应进程；插件卸载会释放剩余 PTY/ConPTY 会话。

### 平台与依赖

- macOS/Linux 通过 PTY 运行真实 Shell。
- Windows 通过 `pywinpty` 使用 ConPTY。设置页可以检测或更新依赖，并可指定 Python 可执行文件。
- 自定义字体可使用 `MesloLGS NF` 等 Nerd Font 解决图标或分隔线缺字；留空回到默认字体栈。
- 自定义主题只保存结构化颜色，不执行 CSS 或 JavaScript。
- 自定义色板从内置浅色或深色色板复制创建，并可一键恢复默认配色。
- 按键直通开启时，终端聚焦后的 Ctrl、Alt、功能键和方向键组合优先发给终端程序。
- 双击或 Ctrl+点击可识别的文件路径时，插件尝试在 Obsidian 中打开并定位。

`getTerminalOutput` 只返回用户请求的最近行数，不持续把终端内容发送到网络。终端进程本身的联网行为由用户运行的命令决定。

<a id="source-assist"></a>
## 6. 源码编写辅助

### Profile 与后缀注册

源码功能默认启用，并固定包含 Markdown (`.md`) profile。用户可添加满足 `[a-z0-9][a-z0-9+_-]*` 的后缀，例如 `.tex`、`.bib`、`.py`、`.m`。

新增后缀后：

1. 注册为 Markdown view，以复用 CodeMirror/Live Preview 编辑器。
2. 出现在“新建非 MD 源码文件”入口与命令中。
3. 获得独立的 Code Suite、Lint、`mv-run`、正则替换、高亮与 Vim 设置。

如果同一后缀已被其它插件注册，mv-AIDE 会尝试改为 Markdown view，可能改变其它插件的打开方式。删除 profile 会移除本插件注册，不删除实际文件。

### Code Suite

Code Suite 是按 profile 独立开关的 Latex Suite 兼容编辑内核，不只是 snippets 列表。默认 Markdown profile 开启。

- 规则使用兼容 Latex Suite 的数组格式，支持 tabstop、数学模式、预览和上下文条件；行首 `//` 作为 JavaScript 风格注释忽略。
- 手动触发键默认 `Tab`；下一/上一 tabstop 默认 `Tab` / `Shift-Tab`，均可选择或录制。
- 关闭某 profile 的 Code Suite 只卸载该执行链，不取消后缀注册、不关闭高亮、Lint 或 Markdown view。
- 原生 `$...$`、`$$...$$` 与配置的 TeX 数学区域共享统一数学上下文；Code Suite 消费分析结果，不负责篡改渲染。
- `.tex` profile 的增强数学区域遵循三段式格式：`n` 行内内部内容、`j` 行间内部内容、`nl` 行内完整首尾、`jl` 行间完整首尾。

### TeX 增强

`.tex` profile 可单独启用 TeX outline 和增强数学渲染。增强渲染默认关闭，并要求该 profile 的 Code Suite runtime 开启。

- 支持原生 `\(...\)`、`\[...\]`、美元数学和用户配置的 `n/j/nl/jl` 区域。
- 分析与改写只产生统一数学区域；Obsidian MathJax 与 Code Suite 分别消费同一结果。
- 非活动公式可就地渲染，点击恢复原始源码编辑；失败时保留可编辑源码，不显示空白占位。
- 数学预览默认显示在公式上方，并可显示 `▶` 光标指示和括号高亮；位置、指示和高亮均有独立设置。
- 三段式采用精确字符串匹配，不是完整 TeX 语法解析器；错误、交叉或未闭合格式会跳过并继续寻找后续有效区域。

### Lint、mv-run 与正则替换

| 功能 | 行为 |
| --- | --- |
| Lint | 每 profile 配置命令；`{file}` 替换为带引号文件路径，否则路径追加到命令末尾 |
| 自动 Lint | 持续模式下编辑停止约 600 ms 后运行；可手动运行或清除 |
| 诊断格式 | `file:line:col: message`，列号可省略；可推送给 IDE 桥接 |
| `mv-run` | 读取文件底部匹配前缀的注释行；多个前缀以分号分隔。`mv-run: <命令>` 在最近活跃的 mv-AIDE 集成终端运行，没有终端时自动新建；`mv-run -n: <命令>` 始终新建一个集成终端再运行 |
| 当前文件正则 | 使用 CodeMirror 搜索面板 |
| 多文件正则 | 当前目录或整个 vault，先预览再应用 |
| 范围上限 | 每 profile 为关闭/当前文件/当前目录/整个 vault；Markdown 默认当前文件 |

外部命令以当前用户权限运行。命令为空时功能不执行；插件不会自动为 Lint 或 `mv-run` 安装工具链。

常见写法：`# mv-run: python main.py` 会复用最近活跃终端；`# mv-run -n: pytest` 会强制新建终端。块注释前缀同样支持，例如 `<!-- mv-run: npm run build -->`；TeX 可配置 `% mv-run -n: latexmk -pdf main.tex`。

### 高亮主题

可导入 Prism CSS、highlight.js CSS、VS Code/Shiki/TextMate JSON 或 mv-AIDE JSON。格式可自动识别；非 Prism 格式会转换成近似 token 配色，不能保证像素级还原。主题只影响源码 token，不改变 Code Suite 替换或 Markdown view 注册。

<a id="vim"></a>
## 7. Vim 增强

### 隔离与启用

Vim 由 mv-AIDE 独立实现，不依赖 Obsidian 内置 Vim 或第三方 Vim 引擎。每个源码后缀默认关闭；只有至少一个后缀开启时才动态加载宿主模块和 CodeMirror 扩展。

启用前会检查 Obsidian 内置 Vim 和已知冲突插件。检测到冲突时拒绝启用并提示用户处理，不自动更改其它插件设置。全部后缀关闭后，不读取 vimrc、不注册按键/状态栏/样式/监听器/计时器，也不保留全局兼容对象。

### 已实现能力

| 类别 | 支持内容 |
| --- | --- |
| 模式 | Normal、Insert、Replace、Visual、Visual Line、Visual Block、Operator-pending、Command-line |
| 基础移动 | `h j k l`、方向键、`gj/gk`、`0 ^ $ g_`、Home/End、`w/W/b/B/e/E/ge/gE`、`gg/G`、`{ } ( )`、`%`、`|`、`f/F/t/T/;/,` |
| 操作 | `d x X D`、`c s S C`、`y Y`、`p/P`、`>/<`、`=`、`~ g~ gu gU`、`J`、`u`、`Ctrl-r`、`.` |
| 文本对象 | `iw/aw`、`iW/aW`、`is/as`、`ip/ap`、圆/方/花/尖括号与单/双/反引号对象 |
| 状态 | unnamed、numbered、small-delete、named、black-hole、clipboard registers；宏 `q/@`；mark 命令 `m`、`'` 与反引号跳转；jump `Ctrl-o/Ctrl-i` |
| 搜索 | `/`、`?`、`n`、`N` |
| Ex | `:s`、`:%s`、`:w`、`:q`、`:wq`、`:x`、`:e`、`:sp`、`:vsp`、`:registers`、`:marks`、`:jumps`、`:set`、`:setlocal`、`:normal`、`:sort`、`:obcommand`、`:!` |
| vimrc | `set/setlocal`、map/noremap/unmap 系列、`mapleader`、Insert abbreviation、`source`、自定义 Ex、受控 autocmd |

完整 Vimscript、Lua、`<expr>` 等未实现语法会明确拒绝并提示，不会“解析成功但静默失效”。Vim Motions 的 EasyMotion、Oil、Picker、Harpoon 等扩展生态不属于本引擎。

### Vimrc 与选项

全局配置固定在 `<vault>/mv-aide/vim/.vimrc`。每个后缀还可保存虚拟 vimrc，在全局文件之后按顺序执行。完全相同的规范化指令只执行一次，语义不同的映射不合并。

| 选项 | 默认值 |
| --- | --- |
| `tabstop` | 4 |
| `shiftwidth` | 4 |
| `expandtab` | 开 |
| `ignorecase` / `smartcase` | 关 / 关 |
| `wrap` | 开 |
| `number` / `relativenumber` | 关 / 关 |
| `timeoutlen` | 1000 ms |
| `clipboard` | 空 |

旧用户目录或旧插件目录配置只用于设置页中的显式迁移；运行时不直接读取旧路径。旧用户目录文件在迁移成功后移除，旧插件目录文件只读复制且不被改写。`source` 文件按加载顺序监听，循环引用会被阻断。解析错误按指令隔离，不修改文档。

### 输入、光标与 Visual

- Insert 输入优先级：**可见 AI 建议 → Code Suite snippet/tabstop → Vim `imap`/`abbrev` → 原生输入**。
- Code Suite 开启时，Vim Insert 映射默认不共存；必须在对应后缀显式允许。Code Suite 关闭时映射自动可用。
- AI 建议可见时第一次 Escape 只取消建议；再次 Escape 退出 Insert。`Ctrl-[` 也退出 Insert。
- IME composition、粘贴和拖放不会当作普通 Vim 映射序列。
- 模式状态可选“只显示文字”或“只显示颜色”，不会重复表达。Normal/Visual 使用块光标，Insert 使用竖线，Replace/Operator 使用下划线。
- 非 Insert 块光标默认跟随文本色，也可选紫、蓝、绿、橙、红、青或自定义 RGB（每通道 0–255）；宽度会随中文等全角字符自适应。
- Visual 范围由唯一逻辑快照持有，宿主原生选区只保留活动端光标；字符、行、块操作、相对行号、AI 上下文和系统复制均读取逻辑范围。

`:!` 和 autocmd 间接执行外部程序需要单独授权，默认关闭。`:w/:wq/:x` 调用 Obsidian 当前视图的显式保存；保存失败不会继续退出。

<a id="default-opener"></a>
## 8. 默认文件打开器

### 模型与状态

总开关默认关闭。启用后当前 vault 启动仅监听本机的接收服务；系统 wrapper 把被双击文件的路径交给这个 vault。系统注册是持久的，不会因为重启计算机而消失。

检查结果严格区分：

1. Obsidian/mv-AIDE 不是默认打开器。
2. 已有 mv-AIDE 注入，但 owner 是其它 vault。
3. 当前 vault 是默认 owner。

“一键注入”不兼具清理功能：只要检测到已有或残缺的 mv-AIDE 注册，无论属于哪个 vault，都会返回现状并要求先显式清理。这样可避免多个 vault 互相覆盖。

### 后缀

- 内置：`.md`、`.markdown`、`.pdf`。
- 扩展：来自 Source Assist 已注册 profile，例如 `.tex`、`.py`、`.m`；是否可注册与该 profile 的 Code Suite 开关无关。
- 每个后缀独立开启。加入或删除扩展后缀时，需要清理旧系统注册并重新注入。
- 在仅内置状态下第一次开启任意扩展后缀会切入扩展模式，其余扩展仍保持各自关闭；设置入口固定在分区底部折叠区。

### 库外文件与镜像

库外文件不会复制进仓库正文目录。插件在 `<vault>/mv-aide/external-files/mirror` 创建可追踪入口：

1. 始终先尝试创建并验证真实符号链接。
2. 仅当平台或文件系统证明符号链接失败，并取得用户明确同意后，才使用隔离的受管副本和双向同步。
3. “重试并迁移符号链接”只迁移已经安全收敛的副本。
4. host/映射状态位于 `<vault>/mv-aide/external-files/hosts`。

检测到历史镜像目录时，设置页提供显式迁移；插件不会在启动时静默搬动旧数据。

不得把接收目录放在 `.obsidian` 下，也不得在 Obsidian 启动时扫描仓库并再次通过系统默认打开器打开文件；这避免启动递归和无限循环。

### 平台行为

| 平台 | 注入方式 | 用户确认 |
| --- | --- | --- |
| macOS | 安装 `MV AIDE File Opener.app`，bundle id `com.mv.aide.file-opener` | 可能需要在 Finder“打开方式”中确认 |
| Windows | 当前用户 `HKCU` ProgId `MV.AIDE.FileOpener[.<ext>]` | Windows 8+ 必须在“默认应用”中由用户逐后缀确认 |
| Linux | 安装 `mv-aide-file-opener.desktop` | 依桌面环境 MIME 设置确认 |

Windows 不申请管理员权限、不写受保护的 `UserChoice`。在系统列表中应选择 **MV AIDE File Opener**，不是 Windows Based Script Host。

系统 wrapper 的必要注册状态位于批准的 `~/.mv-aide/` 系统状态目录中，与 IDE discovery、dsh bridge selection 等跨进程状态共享同一根目录。它不是守护进程：Obsidian 关闭时先通过 Obsidian URL 唤醒目标 vault，再等待插件服务；Obsidian 已打开时会将窗口带到前台。

“Obsidian 内显示文件类型图标”默认开启，只影响标签页等界面；系统文件关联图标由 wrapper 应用提供，样式为白色文档、后缀标注与 Obsidian 官方 logo 徽章。

<a id="filesystem-browser"></a>
## 9. 文件系统与浏览器

三个入口默认开启，可分别关闭。

### 下载

在内置 Web Viewer 工具栏添加下载按钮，打开系统 Downloads：

- 按修改时间倒序排列。
- 默认只显示常见文档、图片和 Obsidian 可浏览类型；“显示全部”解除过滤。
- 点击文件按插件路由直接在当前 vault 打开。
- 每项还可显式“用系统默认应用打开”或“在文件夹中显示”。
- “打开下载文件夹”交给系统文件管理器。

### 浏览历史

在 Web Viewer 工具栏添加入口，调用 Obsidian 官方历史命令。新版本使用 `webviewer:open-history`，旧版本回退 `browser:open-history`；插件不自行保存网页历史。

### 浏览任意目录

在文件资源管理器工具栏添加目录按钮，打开路径浏览弹窗：

- 顶部路径可编辑，按 Enter 跳转。
- 下拉菜单包含常用位置和去重后的最近路径。
- 点击目录继续进入；点击文件使用与下载列表相同的插件路由。
- 插件支持的格式直接在当前 vault 打开，不经过系统默认打开器；明确点击“默认应用”时才走系统关联。

关闭入口后只移除对应按钮和监听器，不删除下载、历史或任何外部文件。

<a id="api-providers"></a>
## API 提供商

划词助手和行内补全共用提供商列表。

| 项目 | 行为 |
| --- | --- |
| 类型 | OpenAI-compatible 或 Anthropic |
| Base URL | 必填；OpenAI 兼容接口追加 `/chat/completions`，Anthropic 追加 `/v1/messages` |
| API Key | 明文保存在插件 `data.json`；本地无鉴权服务可留空 |
| 模型 | 用户自由维护；列表中的“模型名称”字符串原样发送给 API，内部 ID 只用于稳定引用 |
| 思考参数 | 默认、开、关、自定义 JSON；兼容性由提供商决定 |
| 绕过 CORS | 默认关；开启后走 Obsidian 内部网络请求，可绕过 `app://` Origin，但响应一次性返回，不流式显示 |

删除提供商或模型会清除引用它的模板和补全配置，防止保留悬空引用。插件不会自动上传仓库、终端或选区；只有用户触发的模板/补全请求以及明确启用的 Agent 工具会发送对应上下文。

<a id="cross-feature"></a>
## 跨功能关系

### 编辑输入优先级

Vim Insert 模式中的优先级固定为：

1. 已显示的 AI 行内建议。
2. Code Suite snippet 或 tabstop。
3. 经该后缀授权的 Vim `imap`/`abbrev`。
4. CodeMirror/系统原生输入。

Normal、Visual、Operator-pending、Command-line 由 Vim 消费非系统编辑键。IME composition、系统快捷键、粘贴和拖放不会被拆成 Vim 映射。

### 后缀与打开方式

Source Assist profile 是扩展后缀的唯一来源；Code Suite、Vim 与默认打开器分别消费该 profile，但各自有独立开关。关闭 Code Suite 不删除后缀，关闭 Vim 不影响源码编辑，关闭默认打开器不影响 Obsidian 内直接打开。

### 选区与 Agent

Markdown/PDF/Web Viewer 普通选区、Vim Visual 逻辑选区、IDE 最新选区和划词助手共享统一的“当前有效选区”接口。Vim Visual Block 按行连接后提供给 AI；关闭 Vim 后立即回退 Obsidian 原生选区。

### mv-agent 与 IDE 桥接

mv-agent 与 IDE 桥接共享同一条本地桥接服务、同一组公共工具开关和同一个 `openDiff` 审核通道；mv-agent 的「库外项目工具策略」是在公共开关之上、只对 dsh Agent 生效的范围控制。关闭「启用 dsh IDE 功能」只停止桥接与 lock 文件，mv-agent 分区的环境安装状态与设置保留；关闭整个 mv-agent 分区不影响 Claude Code / Codex / 通用 MCP。

### 故障隔离

- AI 请求失败不影响 IDE 桥接、终端或源码编辑。
- Code Suite/TeX 渲染失败保留原始源码。
- Vim 配置错误按指令隔离；全部 Vim 开关关闭后不加载运行时。
- 默认打开器注册失败不影响 Obsidian 内部文件路由。
- 终端依赖失败不阻止其它八个分区加载。
- mv-agent 环境缺失或 DSH 未运行时，其余八个分区照常工作；视图显示「mv-agent 未运行」而不是报错。

<a id="commands"></a>
## 命令与入口

命令名称会随界面语言显示中文或英文，主要分组如下：

- 将当前选区发送给 Claude/Agent。
- 打开系统终端。
- 打开、关闭、重启 mv-agent。
- 运行当前文件 `mv-run`。
- 新建已注册的非 Markdown 源码文件。
- 打开库外文件、按路径打开、清理失效库外链接。
- 当前文件正则替换、多文件正则替换。
- 每个启用的 LLM 模板命令。
- 运行 Lint、清除诊断、启用/禁用持续 Lint。
- Code Suite 内核注册的 snippet/tabstop/预览命令。

默认只给行内补全接受/取消键设置行为，不抢占全局命令快捷键。用户可在 Obsidian 的快捷键设置中绑定其它命令。

<a id="platform-matrix"></a>
## 平台支持矩阵

| 功能 | macOS | Windows | Linux | 备注 |
| --- | --- | --- | --- | --- |
| IDE 桥接 / MCP | 是 | 是 | 是 | 客户端可执行文件路径可能需手填 |
| mv-agent（DSH） | 是 | 是 | 是 | 全局安装授权：macOS 管理员 / Windows UAC / Linux `pkexec` |
| 划词 / 行内补全 | 是 | 是 | 是 | 取决于 API 兼容性 |
| 终端 | PTY | ConPTY/pywinpty | PTY | Windows 可在设置中检测依赖 |
| Source Assist / Code Suite | 是 | 是 | 是 | 桌面 CodeMirror |
| Vim | 是 | 是 | 是 | 需关闭其它 Vim 引擎 |
| 默认打开器 | `.app`/Launch Services | HKCU ProgId + 系统确认 | `.desktop`/MIME | Windows 不可静默设置 UserChoice |
| 符号链接镜像 | 原生 | 取决于权限/开发者模式 | 原生 | 失败后才允许受管副本回退 |
| Web Viewer 工具栏 | 是 | 是 | 是 | 依赖 Obsidian 内置 Web Viewer |

Windows 默认打开器的发布前验证步骤见 [WINDOWS-VALIDATION.md](../WINDOWS-VALIDATION.md)。

<a id="storage-network"></a>
## 数据与网络边界

### 持久化路径

| 路径 | 内容 |
| --- | --- |
| `<vault>/.obsidian/plugins/mv-obcc/data.json` | 插件设置、API Key、模板、profile、受管状态 |
| `<vault>/mv-aide/vim/.vimrc` | 当前 vault 的全局 Vim 配置 |
| `<vault>/mv-aide/external-files/mirror` | 库外文件符号链接或获授权的受管副本 |
| `<vault>/mv-aide/external-files/hosts` | 库外文件 host/映射状态 |
| `<vault>/mv-aide/llm-history/latest.md` | 最近一次划词助手内容，覆盖写入并从常用索引隐藏 |
| `<vault>/mv-aide/dsh/` | mv-agent 仓库级安装的 Node.js、DSH、pnpm 运行时与桥接插件 |
| `~/.mv-aide/ide/` | 统一 IDE 桥接发现注册表（mv-AIDE 权威 lock 文件） |
| `~/.mv-aide/dsh-bridge-selection.json` | dsh 各会话的桥接选择（持久化，会话键分区） |
| `~/.mv-aide/` | 默认打开器 wrapper、owner、系统关联，以及上述 IDE/dsh 状态 |

除本表列出的 `~/.mv-aide/` 条目外，运行配置不得放在用户目录。旧 Vim 配置路径只在用户点击迁移时读取，不作为运行时来源。

### 本地端口与外部网络

- IDE、通用 MCP、默认打开器服务只绑定 `127.0.0.1`。
- mv-agent 托管的 DSH Web 服务只绑定 `127.0.0.1`，默认端口 `3080`（可在设置中修改）。
- 通用 MCP 需要每 vault Bearer token；轮换后旧 token 立即失效。
- 划词助手和行内补全只连接用户配置的 API Base URL。
- Claude/Codex 自身网络、终端命令网络和 Web Viewer 浏览由对应程序负责。
- 插件不安装常驻 daemon，也不把服务绑定到局域网接口。

### 敏感数据

API Key 明文存储在 `data.json`，可能随 vault 备份或同步传播。不要提交真实 `data.json`，也不要把含密钥的演示 vault 发布。MCP token、Agent 管理块和默认打开器 owner 也应视作本机配置。

<a id="troubleshooting"></a>
## 故障排查

### Agent 未连接

1. 检查对应 Claude/Codex 开关和可执行文件路径。
2. 点击“刷新状态”或“重新注册”，重启客户端或重新执行客户端的 MCP 刷新命令。
3. 通用 MCP 客户端确认 URL、Bearer token 和协议版本；stdio 方式要求 Obsidian 已经运行。
4. 自定义 Anthropic 上游只在必要时启用兼容模式；先确认当前识别的上游地址。

### Diff 没有出现

检查 Agent 权限模式。`acceptEdits` 会直接接受；第三方 Agent 必须自行配置写入前 hook 才能调用 `openDiff`。hook 的超时和 fail-open 行为由 Agent 决定。

### 划词助手或行内补全报错

1. 检查提供商、模型、Base URL 和 API Key。
2. 浏览器控制台出现 CORS/`Failed to fetch` 时可开启“绕过 CORS”，但会失去流式输出。
3. 网页选区优先用快捷键；实验右键注入可能被站点阻止。
4. 行内补全无法抑制空结果时，恢复默认提示词并确认保留 `<MV_AIDE_NO_COMPLETION>`。

### Windows 终端无法启动

在终端设置中选择正确 Python，运行“检测依赖”；失败时执行“更新依赖”，或用同一解释器安装 `pywinpty`。自定义 Shell 路径必须指向可执行文件。

### 源码后缀打开方式异常

确认该后缀只有一个插件负责 view 注册。删除并重新添加 Source Assist profile 可刷新注册，但可能影响其它插件。Code Suite 关闭不会取消后缀注册。

### TeX 公式不渲染或 Code Suite 不触发

确认 `.tex` profile 的 Code Suite 已开启；增强渲染还需要单独开启。检查三段式开头/结尾是否精确匹配且未交叉。渲染失败时源码应保持可编辑，控制台日志可用于定位 MathJax 或规则错误。

### Vim 按键失效

关闭 Obsidian 内置 Vim、Vim Motions、Vimrc Support 等冲突引擎；确认当前后缀的 Vim 开关已开启。中文输入法 composition 结束后应恢复 Normal 键位。Insert 映射与 Code Suite 共存需在该后缀单独授权。

### 默认打开器注入后仍未生效

- 先点“检查”，若 owner 不是当前 vault 或注册残缺，必须“清理”后再“一键注入”。
- Windows 还需在系统“默认应用”中逐后缀选择 **MV AIDE File Opener**；详细步骤见 [Windows 验证文档](../WINDOWS-VALIDATION.md)。
- macOS 可在 Finder“打开方式”确认应用；图标未刷新通常是系统缓存。Windows 可重启 `explorer.exe` 或注销重登以刷新图标缓存。
- 不要手动把 wrapper 指向 Obsidian 可执行文件本身，否则可能造成 URL/文件关联循环。

### 库外文件无法保存

检查 `mv-aide/external-files/mirror` 中是否为有效符号链接。只有出现明确授权提示后才会使用受管副本；同步冲突不会静默覆盖任一侧。可以运行“重试并迁移符号链接”。

<a id="acknowledgements"></a>
## 来源与许可

- 行内补全的 CodeMirror ghost-text 架构参考了 [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot) 的公开思路。
- 终端 PTY 进程桥接参考了 [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar) 的公开设计。
- Source Assist 的 Code Suite 内核基于 [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5`，保留上游 MIT 许可。
- Vim 兼容目标与配置体验参考 [obsidian-vimrc-support](https://github.com/esm7/obsidian-vimrc-support) 和 [Vim Motions](https://github.com/saberzero1/motions) 的公开文档与用户可见思路；不打包或派生它们的 Vim 引擎，核心依据 Vim/Neovim 行为和 CodeMirror 6 API 独立实现。

mv-AIDE 在运行时不要求安装或启用上述任何插件。

法律声明见[第三方声明](../THIRD_PARTY_NOTICES.md)，Vim 边界见[Vim 独立实现与来源说明](vim-engine-provenance.md)，项目许可见[LICENSE](../LICENSE)。
