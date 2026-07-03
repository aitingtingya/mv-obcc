# mv-SenceAI 插件开发规范

本规范旨在阐明该插件的两大开发原则，所有后续的功能修改、重构以及第三方集成均必须无条件遵守此规范，以确保插件能够通过官方社区市场的安全审查且具备长期的运行稳定性。

---

## 规范一：插件描述去 "Obsidian" 化约束 (Plugin Description Constraints)

1. **红线说明**：
   官方社区插件审查指南明确规定：**插件的描述属性中禁止出现 "Obsidian" 单词（不区分大小写）**。因为在 Obsidian 官方插件市场内，"Obsidian" 这一前缀和词汇是冗余的，并且官方对此进行自动静态校验。
2. **规范要求**：
   - 严禁在 [manifest.json](manifest.json) 中的 `"description"` 字段包含 `"Obsidian"` 单词。例如，应使用 `"integrated tools"`、`"vault tools"` 或 `"system tools"` 来代替 `"Obsidian tools"`。
   - 严禁在 [package.json](package.json) 中的 `"description"` 字段包含 `"Obsidian"` 单词。
   - 在任何更新发布或向官方 releases 仓库推送 Pull Request 前，必须静态核验这两个描述字段，严防关键字溢入。

---

## 规范二：延迟初始化与 Vault 安全写入原则 (Delayed Initialization & Vault Safe-Writes)

1. **设计初衷**：
   Obsidian 在加载插件时会执行其 `onload()` 生命周期。如果在 `onload()` 期间同步触发耗时的网络操作、文件系统写入（尤其是写入 `.obsidian/` 目录）或后台服务绑定（例如注册本地 MCP 服务或建立与 Codex/Claude 的 Socket 监听连接），可能会引发严重的 IO 竞态竞争，阻碍 Obsidian 主界面的顺畅渲染，或引起目录尚未建好时的读写死锁。
2. **规范要求**：
   - **延迟绑定原则**：所有建立本地 TCP/WebSocket IDE 桥接服务器、扫描本地区域服务、调用外部系统命令（如运行 CLI 或 PowerShell/bash 命令）的操作，**必须**等到 Obsidian workspace 布局就绪后再行启动。
   - **核心接口实现**：
     - 使用 `app.workspace.onLayoutReady` 监听布局就绪状态。
     - 结合使用插件内建的 `schedulePostLayoutStartup` 异步处理管道（位于 `src/post-layout-startup.ts`），通过合理的防抖延迟（如 2000ms 延迟）以及插件卸载安全性状态守卫 (`isUnloaded()`)，来保证服务的平滑初始化。
     - 任何新的 MCP 注册流程或类似服务写入 `.obsidian/` 的行为，必须集成 to 此 `schedulePostLayoutStartup` 控制的异步生命周期内，严禁将代码直接放在 `onload()` 中同步触发。
