# MV OBCC IDE 0.2.7 测试报告

日期：2026-06-13

## 环境

- macOS 26.5.1，Apple Silicon
- Obsidian 1.12.7
- Claude Code 2.1.174
- Node.js 22.18.0
- Mimo Anthropic 兼容上游

## 自动验证

- TypeScript strict 类型检查：通过
- Vitest：65/65 通过
- 生产 esbuild：通过
- `npm audit`：0 个漏洞
- 从源码 ZIP 全新执行 `npm ci` 和 `npm run verify`：通过
- 安装 ZIP、源码 ZIP 和插件文件 SHA-256 校验：通过
- GitHub Actions 同时配置 `macos-latest` 和 `windows-latest`

测试覆盖消息角色移动、上游地址优先级、代理循环规避、旧配置迁移、MCP 鉴权和初始化、Windows `.cmd`/`.bat`/`.exe` 参数传递、MCP 注册复验、macOS CLI 调用回归、WebSocket IDE 鉴权、定向客户端消息、端口冲突、macOS/Windows PID 解析、Claude session 文件校验、Hook 合并恢复、活动页面类型、终端标记、路径、lock 文件、Claude 设置恢复、Diff 状态幂等、网页精确标签读取、跨平台最近选区缓存和持久视觉高亮状态机。

## macOS 真实联调

- 插件加载、稳定端口和 IDE lock：通过
- `/health` 与 `/healthz` 健康检查：通过
- `/ide` 连接与 `getDiagnostics` 内部调用：通过
- HTTP MCP 自动注册和 `claude mcp list` Connected：通过
- MCP 关闭后移除注册且端点返回 404，重新开启后自动恢复：通过
- MCP 无令牌返回 401，正确令牌初始化返回 200：通过
- 真实模型调用 `mcp__mv-obcc-ide__getCurrentSelection`：通过
- 主动工具开关同时影响 `tools/list` 和直接调用：通过
- 全部打开标签包含 Markdown、PDF、网页、终端和插件页：通过
- 图片标签标题、类型和绝对路径：通过
- 后台 DeferredView 文件路径恢复：通过
- Obsidian Web Viewer 选区：通过
- 切换到无选区标签后保留最后一次非空网页选区：通过
- GitHub 当前页面使用 Obsidian Reader 转 Markdown：通过
- 网页读取前后 URL 与 WebContents ID 完全不变：通过
- PDF 文件、页码和同一 DOM 文本选区：通过
- 中文设置页面和自动上游来源显示：通过
- 兼容转换抓包：正文出现一次、只保留 user 消息：通过
- Diff 拒绝：源文件保持原文，通过
- Diff 接受：采用右侧最后编辑的全文并只写入一次，通过
- Claude 内部 `close_tab` 生命周期：通过
- `acceptEdits`：直接写入且不创建 Diff 标签，通过
- 两个 Claude 进程同时连接同一 IDE 端口：通过
- 两个进程分别拥有独立 PID、TTY 和 Claude session 文件：通过
- Terminal 3.26.0 支持 OSC 标题更新：通过

## 0.2.3 变更验证

- Windows MCP 注册不再使用 `shell: true`。
- `.cmd` 和 `.bat` 通过显式 `cmd.exe /d /s /c` 调用，HTTP Authorization header 保持为单一参数。
- `.exe` 继续通过参数数组直接调用。
- 注册成功必须经过 `claude mcp get mv-obcc-ide` 对 URL、令牌和 Connected 状态的复验。
- macOS 保持直接 `execFile(executable, args)`；对应回归测试通过。
- Windows 实机操作由用户按验证手册完成，本报告不声称 Windows 实机通过。

## 0.2.4 变更验证

- 网页工具只读取精确保存的 `WorkspaceLeaf`；相同 URL 或标题的其他标签不会被误读。
- 网页正文来自当前 WebContents 的 `document.body.innerText`，不再调用 Reader，因此隐藏的预载任务内容不会混入结果。
- 自动测试覆盖视口上方、视口内和视口下方的已加载正文，确认返回整个滚动文档而非当前视口。
- 网页默认取消原有字符上限；超过 20 万字符的测试正文完整返回。只有设置正整数上限时才截断。
- Windows HTTP MCP 没有可靠 `sessionId` 时，`getLatestSelection` 回退到全局最近非空选区；空选区不会覆盖缓存。
- 有 `sessionId` 的 macOS/IDE 客户端继续严格按会话隔离，不回退到其他会话。
- 本节为代码和自动化验证，不声称完成新的 Windows 或 macOS 真机交互测试。

## 0.2.5 变更验证

- Markdown 使用独立 CodeMirror 状态字段保存视觉范围；失焦产生的空选区不会清除，源编辑器内的空点、键盘折叠或输入会清除。
- Markdown 视觉范围会随文档修改映射，被选文字完全删除后自动移除。
- PDF 只在 Selection 的锚点仍位于当前 PDF 视图时处理空选区，切换到终端或其他标签产生的空 Selection 会被忽略。
- Web Viewer 页面内部只在真实非空选区时更新高亮；空的 `selectionchange` 保留高亮，页面内 `pointerup` 或 `keyup` 后的空选区才清除。
- 视觉高亮拥有独立设置和存储路径，不读写 `SelectionState`、最近选区缓存、IDE WebSocket 或 MCP。
- PDF 和 Web Viewer 使用 CSS Custom Highlight 并按能力静默降级；Markdown 不依赖该 API。
- 本节完成类型检查、自动测试和生产构建，不声称完成新的 Windows 或 macOS 真机视觉验收。

## 0.2.6 变更验证

- Markdown 备用 Decoration 在真实 CodeMirror 选区仍非空时也会生成，修复切换终端后原生选区不再着色、备用层又被抑制的问题。
- 编辑器聚焦时通过 CSS 隐藏备用层，由 Obsidian 原生选区显示；编辑器失焦时备用层恢复主题的 `--text-selection` 颜色，避免双重着色。
- 自动测试直接检查真实非空选区下的 Decoration 范围，并验证聚焦与失焦 CSS 规则。
- PDF、Web Viewer、`SelectionState`、最近选区缓存、IDE WebSocket 和 MCP 代码未修改。
- 本节完成类型检查、自动测试和生产构建，不声称完成新的 macOS 真机视觉验收。

## 0.2.7 变更验证

- 修复 Markdown ViewPlugin 在 CodeMirror `update()` 内嵌套 `dispatch()` 导致插件实例崩溃、保存范围从未建立的问题。
- 保存范围改为在原始 transaction 内由 StateField 同步更新，不创建第二个 transaction，也不修改真实 selection。
- 高亮改用 `outerDecorations`，尽量包裹 Live Preview 的普通 Markdown 渲染 Decoration。
- 编辑器内使用 `:focus-within` 隐藏备用颜色；焦点进入终端或其他标签时恢复主题的 `--text-selection`。
- jsdom 真实 EditorView 测试验证：非空选择产生实际高亮 DOM、CodeMirror exception sink 无异常、外部元素取得焦点后真实 selection 保持不变。
- 开关关闭后停止记录并清除范围；重新开启时从当前真实 selection 恢复。PDF、Web、IDE、MCP 和最近选区逻辑未修改。
- 本节完成类型检查、自动测试和生产构建；最终视觉效果仍由 Obsidian 真机验收。

## Windows 状态

代码包含 Windows 路径处理、Claude 可执行文件候选和 Windows CI；当前机器没有 Windows 虚拟机，因此没有声称 Windows 实机通过。请按 [`WINDOWS-VALIDATION.md`](WINDOWS-VALIDATION.md) 在 Windows Codex 环境继续验证。
