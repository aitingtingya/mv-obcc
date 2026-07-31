# mv-SenceAI 0.8.1 测试报告

最近更新：2026-07-26

## 环境

- macOS 26.5.1，Apple Silicon
- Obsidian 1.12.7
- Claude Code 2.1.174
- Node.js 22.18.0
- Mimo Anthropic 兼容上游

## 自动验证

- TypeScript strict 类型检查：通过
- Vitest：359/359 通过；仅 Windows CI 真实注册表用例在当前 macOS 跳过
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

## Windows 注册表 v4 修复验证（2026-07-26）

- Explorer `FileExts\\.<ext>\\OpenWithProgids` 不再通过 `reg.exe /d ""` 写入；新版助手调用 `RegSetValueExW(..., REG_NONE, IntPtr.Zero, 0)` 创建真正的零字节值。
- 写入和检查统一走结构化的原生注册表助手，逐项校验值类型、原始字节长度和字符串内容；读取失败不会再被误判为“未注册”。
- Shell 变更通知使用 `SHCNE_ASSOCCHANGED`、`SHCNF_IDLIST` 和同步刷新；候选项刷新完成后才结束注入。
- 清理会全局枚举 SenceAI 的 OpenWith 和旧默认值引用，只删除本插件拥有的 ProgID、Capabilities、RegisteredApplications 与命名值，保留其它应用和扩展名原有默认值。
- 清理始终临时生成当前版助手，因此 owner 指向 v3 助手、助手缺失或没有 owner 的残留注册也能进入同一清理路径；注入仍不会隐式清理或覆盖现有注册。
- 自动测试覆盖零字节写入、2 字节伪空值、访问拒绝、额外后缀残留、部分写入回滚、旧版迁移和非 SenceAI 默认值保留。
- Windows CI 增加真实 `HKCU` 注册表往返用例，并通过 `reg.exe export` 断言导出结果为精确的 `hex(0):`；该用例仅在 Windows CI 且显式开启时运行，结束后清理测试键。
- macOS app bundle、LaunchServices 注入与清理代码没有修改。本节不声称 Windows 实机“打开方式”界面和双击文件已经验收，最终结果仍按 `WINDOWS-VALIDATION.md` 由 Windows 实机确认。

## 三项隔离整改收尾验证（2026-07-30）

收尾内容：响应式符号链接弹窗、通用 MCP 适配层、启动性能治理三块的剩余缺口。

- 弹窗 CSS：≤480px 全宽规则补上 `mv-senceai-universal-mcp-setting` 文本输入框；测试补长中文错误、长本地路径与 UNC 路径的 DOM 渲染断言、设置页弹窗五按钮顺序契约、低高度（`max-height`/`overflow-y`）与宽屏（`flex-wrap`）CSS 契约。
- 启动性能：轮询回退间隔新增按 storageKey 哈希派生的确定性错峰（`managedCopyPollInterval`，2000–3000ms），与 heartbeat 错峰（30000–35000ms）使用不同哈希域；新增测试固定错峰边界/确定性以及 watcher 以恢复结果播种指纹、启动期零全文重读的行为。
- Windows 修复脚本拆分判定：`node scripts/measure-repair-script-eval.mjs` 实测模块求值中位数 0.21ms、p95 0.37ms（24KB 独立打包，30 次采样），远低于 50ms / 20% 阈值，**不拆分**，该条按测量记录收尾。
- 构建隔离：`scripts/check-bundle-isolation.mjs` 断言 `dist/main.js` 不含通用 MCP 协议标记、独立产物齐全，已接入 `npm run verify`。
- 协议端到端：`npm run test:protocol`（`scripts/test-universal-mcp-stdio.mjs`）用真实构建产物经 stdio 代理对 2026-07-28 / 2025-11-25 / 2025-03-26 三版本跑发现、完整 8 工具 `tools/list`、4 资源 `resources/read` 及陈旧描述文件拒退，共 45 项断言通过。
- 官方 MCP Inspector 对真实客户端的验证、真实视口布局与真实 Obsidian 回归不在自动化范围内，按下方清单人工验收。

### 真实 Obsidian 实测（2026-07-30，`scripts/live-ide-tools-check.mjs`）

对正在运行的插件（通用 MCP 已开启）逐工具实测，自动化 23/23 通过 + 人工配合 3 项通过：

- 全部 8 个 IDE 工具逐一调通：`getLatestSelection`（无选区时返回设计内响应）、`getOpenEditors`（真实标签列表）、`openFile`（打开并定位行）、`readCurrentWebPage`（无前台网页时明确提示）、`openDiff`（任务创建、diff 标签真实出现）、`close_tab`（按名关闭并以 DIFF_REJECTED 了结任务）、`closeAllDiffTabs`（清空无残留）、`getDiagnostics`（`[]`）。
- 三版本 `server/discover`、`tools/list` 精确等于 8 个 `IDE_TOOL_DEFINITIONS`、4 个资源实时反映工作区、stdio 启动器对真实服务 `tools/list` 通过。
- 人工配合：网页标签前台时 `readCurrentWebPage` 返回 19872 字符正文（title/url/markdown 齐全）；用户点「接受」后 `openDiff` 回执 `FILE_SAVED` 且返回内容与提交一致（按契约由调用方写盘，插件不写文件）；选中文字并执行 `Send current selection to Claude Code` 后 `latest-mention` 资源实时更新（lineStart/lineEnd 正确），`latest-selection` 随选区/标签切换实时更新。
- 实测全程未触碰用户文件与标签页：临时 scratch 笔记自清理，`openFile` 复用叶子挤走的用户标签已自动恢复，基线比对一致。

### 人工验收清单（真实 Obsidian，部署后逐项确认）

弹窗与设置页（设置 → mv-SenceAI，触发符号链接失败弹窗）：

- [ ] 视口 1024 / 700 / 480 / 360px 宽度下弹窗无横向溢出，按钮依次为多列换行 / 两列 / 单列全宽，取消按钮始终最后。
- [ ] 100% / 150% / 200% 界面缩放下布局不破。
- [ ] 低高度窗口中弹窗纵向滚动、内容不裁剪。
- [ ] 五按钮全量场景（权限拒绝 + 开发者设置可用）按钮齐全且顺序正确。
- [ ] 超长无空格中文错误、长本地路径、UNC 路径均任意位置换行，不撑破弹窗。
- [ ] 窄侧栏下外部镜像与通用 MCP 设置项输入框、按钮换行正常。

通用 MCP：

- [ ] 开关默认关闭：无监听端口、无运行描述文件，`dist/main.js` 加载路径不含通用 MCP（启动计时可佐证）。
- [x] 开启后设置页显示运行状态与协议版本；复制 HTTP / stdio 配置到 Claude Code 或其他 Agent，三版本握手、8 工具、资源订阅通知（选区/提及变化）可用。（2026-07-30 已实测，Inspector 对真实桌面客户端的验证除外）
- [ ] 令牌轮换后旧令牌失效、新令牌可用；错误令牌与非本机 Origin 被拒绝。
- [ ] 关闭开关或卸载插件后连接、订阅、diff 待决与描述文件全部清理。

回归与启动：

- [x] Claude 选区广播、`at_mentioned`、Codex `/ide` 与 MCP 自动注册行为与整改前一致。（2026-07-30 实测：`Send current selection to Claude Code` 正常执行，原广播代码路径未改动、单测全绿；Codex 注册文件未变化）
- [ ] 启动计时（开发者工具 console）显示普通符号链接启动无子进程 / 注册表 / 哈希峰值；受管副本恢复在空闲队列分片执行。
- [ ] macOS / Linux 不进入 Windows 修复路径（如可测）。

## Windows 状态

代码包含 Windows 路径处理、Claude 可执行文件候选和 Windows CI；当前机器没有 Windows 虚拟机，因此没有声称 Windows 实机通过。请按 [`WINDOWS-VALIDATION.md`](WINDOWS-VALIDATION.md) 在 Windows Codex 环境继续验证。
