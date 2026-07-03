# Windows 实机验证手册

在真实 Windows 10/11 机器完成本清单后，才能把 Windows 状态标记为“实机通过”。

## 环境记录

记录以下版本与路径：

- Windows 版本和内部版本号
- Obsidian 桌面版版本
- Claude Code 版本
- Node.js 版本
- 测试 vault 路径，必须同时包含空格和中文，例如
  `C:\Users\<name>\Documents\Test Vault 中文`

## 构建与安装

1. 在源码目录运行 `npm ci`。
2. 运行 `npm run verify`，确认类型检查、65 项测试及生产构建全部通过。
3. 运行 `npm run package`。
4. 在 `release` 目录运行以下命令，并与 `SHA256SUMS` 逐项比较：

   ```powershell
   Get-FileHash -Algorithm SHA256 .\mv-obcc-ide-0.2.7.zip
   Get-FileHash -Algorithm SHA256 .\mv-obcc-ide-0.2.7-source.zip
   Get-FileHash -Algorithm SHA256 .\mv-obcc-ide-0.2.7\main.js
   Get-FileHash -Algorithm SHA256 .\mv-obcc-ide-0.2.7\manifest.json
   Get-FileHash -Algorithm SHA256 .\mv-obcc-ide-0.2.7\styles.css
   ```

5. 将 `release\mv-obcc-ide-0.2.7\` 复制到 `<vault>\.obsidian\plugins\mv-obcc-ide\`。
6. 只启用 `MV OBCC IDE`，关闭其他 Claude Code IDE 桥接插件。
7. 检查 `%USERPROFILE%\.claude\ide\` 中生成了对应端口的 lock 文件。

## MCP 与设置

1. 打开插件设置，确认全部文案为中文。
2. 确认 Claude 可执行文件能自动识别；若失败，填写 `claude.cmd` 或 `claude.exe` 完整路径。
3. 点击“重新注册”，确认状态显示“MCP 已注册并验证；重新启动 Claude Code 后生效”。
4. 运行 `claude mcp list` 和 `claude mcp get mv-obcc-ide`，确认 URL、Authorization header 和 Connected 状态正确。
5. 重启 Claude Code，确认出现 `mcp__mv-obcc-ide__getLatestSelection`、`getOpenEditors`、`openFile` 和已启用的网页工具。
6. 逐一关闭和开启主动工具，重新启动 Claude Code，确认工具清单同步变化。
7. 关闭“启用 MCP 主动工具”，确认 local MCP 注册被删除；重新开启后确认恢复。
8. 检查 MCP 只监听 `127.0.0.1`，且无 Bearer token 时返回 401。

## 上游自动解析

1. 将插件中的手动上游地址留空。
2. 分别在用户、项目和 local Claude 设置中配置不同 URL，确认显示来源遵循 local > project > user。
3. 兼容模式下确认 `.claude\settings.local.json` 指向插件本地端口。
4. 确认插件不会把本地代理地址当成真实上游形成循环。
5. 用脱敏抓包验证选区正文只在 `user` 消息出现一次。
6. 切换回原生模式，确认插件只恢复自己接管过的值。

## 标签与选区

1. 保持“支持所有活动页面”关闭，分别验证 Markdown、PDF、Web Viewer 三个开关。
2. 开启“支持所有活动页面”，确认三个页面类型开关变为不可用。
3. 检查 `.claude\settings.local.json` 中只新增本插件标记的 `SessionStart` 和 `UserPromptSubmit` Hook。
4. 同时从两个终端启动 Claude A 和 Claude B。
5. 确认 `%USERPROFILE%\.claude\sessions\<PID>.json` 分别映射两个 session。
6. 在 A 中交互时确认 A 保留上一个非自身终端页面；切到 B 的终端后，A 可以读取 B。
7. 对 B 执行对称测试；退出后确认其他 Claude 设置和 Hook 没有被破坏。

随后继续通用标签测试：

1. 打开 Markdown、PDF、PNG/JPG、Web Viewer、终端、搜索和一个第三方插件标签。
2. 调用 `getOpenEditors`，确认所有标题、类型和活动状态正确。
3. 确认后台延迟加载的 Markdown、PDF 和图片仍返回 Windows 绝对路径。
4. 在 Markdown 中选择中文、公式、Unicode 和 CRLF 多行文本。
5. 在 PDF 文本层选择文字，确认文件、页码和正文正确。
6. 在 Web Viewer 中选择文字，确认 URL、标题和正文正确。
7. 选中一段文本并发送任意消息，等 Claude 回复结束、右下角不再显示选区状态后，再调用 `getLatestSelection`，确认仍返回刚才的最后一次非空选区。
8. 清空选区并继续聊天，再次调用 `getLatestSelection`，确认空选区没有覆盖上一步结果。

## 视觉高亮

1. 确认“切换标签时保留选区高亮”默认开启。
2. 分别在 Markdown 源码模式、Live Preview、PDF 和 Web Viewer 中划词，然后切到普通标签和终端插件标签，确认源页面高亮仍保留。
3. 回到源页面空点，确认只清除该标签的视觉高亮；重新划词时确认替换该标签原高亮。
4. 在多个标签中分别划词，确认每个标签最多保留一个且互不影响。
5. Markdown 中编辑选中文字前后的内容，确认范围随编辑移动；完全删除选中文字后高亮消失。
6. 刷新或导航 Web Viewer、滚动触发 PDF 文本层重建，确认失效高亮安全清理且插件无报错。
7. 关闭设置开关，确认全部视觉高亮立即清除；重新开启后无需重启。
8. 重复 `getLatestSelection` 和状态感知测试，确认视觉高亮不改变发送给 Claude 的正文。

## 网页转 Markdown

1. 打开普通文章、GitHub 页面和需要登录的页面。
2. 记录读取前的 URL、标题和页面状态。
3. 调用 `readCurrentWebPage`，确认返回的是当前这个精确标签的 Markdown。
4. 确认页面没有刷新、没有跳转、登录状态未丢失。
5. 在长页面的顶部调用工具，确认结果同时包含视口下方已经加载但尚未滚动到的正文。
6. 打开两个 URL 或标题相同的标签，内容保持不同；切换到其中一个再离开网页，确认工具只读取最后追踪的精确标签。
7. 测试 SPA 动态内容，确认读取当前可见 DOM，不包含 `display: none` 的预载或 Reader 隐藏内容。
8. 测试 Canvas、跨域 iframe 和图片页面，确认返回明确的不可提取或部分提取状态。
9. 将“网页工具最大返回字符数”留空或设为 `0`，确认不截断；填写正整数后确认 `truncated` 标记和长度正确。

## 文件导航与 Diff

1. 用 `openFile` 测试含空格和中文的 Windows 路径。
2. 测试指定行、文本范围、仓库外路径拒绝和不存在文件。
3. 启动不预批准 `Edit` 的 Claude Code，修改现有文件。
4. 确认 Obsidian 出现可编辑 Diff；拒绝后文件不变。
5. 再次修改，在右侧更改候选文本后接受，确认只写入最终文本一次。
6. 关闭 Diff 标签，确认 Claude 收到 `DIFF_REJECTED`。
7. 并发打开两个 Diff 并逆序处理。
8. 测试新文件和源文件审核期间被外部修改的冲突。
9. 使用 `acceptEdits` 重试，确认直接写入且不额外弹 Diff。

## 生命周期

1. 保持 Obsidian 开启并重启 Claude Code。
2. 保持 Claude Code 关闭并重启 Obsidian。
3. 制造首选端口冲突，确认 lock、MCP URL 和实际端口一致。
4. 禁用插件，确认服务和 lock 消失，未完成 Diff 被拒绝。
5. 重新启用插件，确认 MCP 自动修复注册。

每项记录通过/失败、截图、脱敏日志和复现步骤。Windows 实机完成前不要修改测试报告中的未验证声明。
