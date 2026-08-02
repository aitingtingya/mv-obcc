# mv-AIDE 插件开发规范

本规范旨在阐明该插件的开发原则，所有后续的功能修改、重构以及第三方集成均必须无条件遵守此规范，以确保插件能够通过官方社区市场的安全审查且具备长期的运行稳定性。

---

## 规范一：插件描述去 "Obsidian" 化约束 (Plugin Description Constraints)

1. **红线说明**：
   官方社区插件审查指南明确规定：**插件的描述属性中禁止出现 "Obsidian" 单词（不区分大小写）**。因为在 Obsidian 官方插件市场内，"Obsidian" 这一前缀和词汇是冗余的，并且官方对此进行自动静态校验。官方 validator 直接报 Error：`Plugin description must not include the word "Obsidian". The word "Obsidian" in the description is redundant. It is implied by the context of the plugin directory.`（0.9.0 改名时曾在 description 中引入该词并被官方检查拦下，务必引以为戒。）
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

---

## 规范三：禁止自更新与插件目录运行时写入 (No Self-Update / No Runtime Writes into the Plugin Directory)

1. **红线说明**：
   官方 validator 的行为检查（BEHAVIOR）会直接报 Error：`Plugin appears to overwrite its own files by extracting an archive (main.js / manifest.json + file write + ZIP extraction). Extracting and overwriting plugin files at runtime is a self-update mechanism that bypasses Obsidian's plugin update process and can be used to deliver malicious code.` 任何"在运行时向插件自身安装目录（`<vault>/.obsidian/plugins/mv-obcc/`）写入、解出或替换文件"的实现都会被判定为绕过 Obsidian 更新机制的自更新行为；且该目录会被插件更新和同步工具整体覆盖，本就不适合存放任何运行时状态。
2. **规范要求**：
   - 严禁运行时（`main.js` 及其懒加载 bundle）向插件安装目录写入任何文件，包括运行时描述、缓存、解包/解码出的脚本或新版本产物。
   - 运行时生成物一律放 `os.tmpdir()`（按 vault 稳定哈希建子目录，目录权限 0700、含令牌的文件 0600），或用户显式授权的外部状态目录（如 `~/.mv-aide`）。
   - 严禁实现下载、解包、替换 `main.js` / `manifest.json` 等任何形式的自更新逻辑；版本分发只走 Obsidian 官方更新机制（GitHub release + community manifest）。
   - 历史违规案例：universal MCP 的 `runtime.json` 曾写入插件目录 `tmp/universal-mcp/`，已迁至 `os.tmpdir()/mv-aide-universal-mcp-<vault哈希>/runtime.json`（见 `main.ts` 的 `universalMcpRuntimeDescriptorPath()`）。新增任何运行时写文件路径前，先对照本条核验目标目录。

---

## 规范四：自有代码禁止动态代码执行 (No Dynamic Code Execution in First-Party Code)

1. **红线说明**：
   官方审核的静态扫描会直接报 Error：`Unsafe call to import for argument 0 (Variable 'module' declared as function parameter, which is considered unsafe...)`。`import(非字符串字面量)`、`eval(...)`、`new Function(...)` 都属于动态代码执行，官方一律按安全隐患拦截——无论参数在业务上是否可信。0.9.2 审核实例：`src/source-assist/tex-math.ts` 曾把用户配置当 JS 模块用 data: URL 动态 import，被官方拦下，已改为 `JSON.parse`（配置是纯声明式数据，本就不需要执行 JS）。
2. **规范要求**：
   - `src/` 下（vendor 之外）的自有代码严禁出现动态 `import(变量)`、`eval`、`new Function`。
   - 声明式用户配置（纯数据）一律设计为 JSON 并用 `JSON.parse` 解析，禁止设计成 `export default [...]` 这类需要执行的 JS 模块格式。
   - 解析器可以对封闭键名集合做有限的语法宽容（如 texMathFormats 接受裸键名/尾逗号/旧 `export default` 前缀，见 `normalizeTexMathFormatsText`），但底层必须是 `JSON.parse` 等纯解析，严禁演化为任何形式的执行。
   - **唯一豁免**：`src/vendor/latex-suite/src/snippets/parse.ts` 的 `import(module)`——上游 latex-suite 的 snippet 语义包含 RegExp trigger 与函数 replacement，只能 JS 求值；该文件受 vendor 完整性测试钉死，此模式严禁扩散到 vendor 之外的任何代码。
   - 若官方后续连豁免项也拦截，应对方式是携带理由申辩（上游官方插件同款构造、语义刚需），而不是在自有代码里复活该模式。
