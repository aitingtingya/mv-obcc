# Vimscript 与 `.vim` 脚本

mv-AIDE 在自研 Vim 编辑引擎上运行传统 Vimscript 子集，不调用 Vim、Neovim 或 JavaScript 执行用户脚本。启用任一后缀的 Vim 后即可使用；生产环境无需安装额外运行时。语义对照使用实际 Vim 9.1。文件扩展名相同不代表兼容全部 Vim 插件。

## 放置与加载

唯一脚本根为当前 Vault 的 `mv-aide/vim/`：

```text
mv-aide/vim/
├── .vimrc
├── plugin/*.vim
├── autoload/*.vim
├── ftdetect/*.vim
├── ftplugin/*.vim
├── after/{plugin,ftplugin,autoload}/
└── pack/<组>/{start,opt}/<插件>/{plugin,autoload,ftplugin,after}/
```

- `.vimrc` 和其中 `source` 的依赖先执行。相对 `source` 路径以发起脚本目录为基准；`~/` 在此功能中表示 Vault 的 Vim 配置根，不表示系统 HOME。解析真实路径后仍须位于此根中。
- 启动时加载 `plugin` 与 `pack/*/start/*/plugin`，随后加载 `after` 覆盖。子目录中的 `.vim` 按稳定文件名顺序加载。`ftdetect` 注册文件类型事件，不把 `autoload`、`ftplugin` 和可选包当启动脚本执行。
- 首次调用 `demo#Action()` 时查找 `autoload/demo.vim`；更深的名称 `demo#part#Action()` 对应 `autoload/demo/part.vim`。
- `runtime` 加载首个匹配，`runtime!` 加载所有匹配；`packadd name` 加载可选包，`packadd! name` 只将包加入查找路径。`packloadall` 加载尚未加载的启动包；`scriptnames` 显示已加载文件。
- 文件类型覆盖 Markdown、TeX、BibTeX、Python、JavaScript、TypeScript 等；其他扩展名作为文件类型名称。`ftdetect` 可通过 `BufRead` 与 `setfiletype` 更改类型。类型脚本使用 `ftplugin/<类型>.vim`、`<类型>_*.vim` 和 `<类型>/*.vim`，包含包和 `after` 中的相应文件。
- 同一文件多个编辑视图只初始化一次缓冲区配置。按后缀保存的虚拟 vimrc 最后执行；其选项、映射、命令和缩写限定于对应缓冲区。
- 不读取系统 `~/.vimrc`、`~/.vim`，不提供联网插件安装器。配置根的真实位置必须在当前 Vault 内；根内的脚本、包和监听目录也不能通过符号链接跳出配置根。越界项不加载、不监听，原因显示在脚本诊断中。

## 语言和编辑接入

| 类别 | 当前实现 |
| --- | --- |
| 值与表达式 | 64 位整数、浮点、字符串、布尔、空值、引用语义的列表与字典、函数引用；索引、切片、解构赋值；算术、比较、大小写比较、短路逻辑、三元、字符串连接、正则比较、选项与寄存器读取 |
| 流程 | `let/unlet`、复合赋值、`if/elseif/else`、`for/while`、`break/continue`、`return/finish`、`try/catch/finally/throw` |
| 函数 | `function[!]`、参数、可变参数、脚本局部函数、autoload、Funcref、部分绑定、lambda、闭包和字典函数；`call`、`execute` 与 `eval()` 均使用自有解释器 |
| 映射 | 既有模式的 map/noremap/unmap/mapclear；`<expr>`、`<Plug>`、`<SID>`、`<Leader>`、`<LocalLeader>`、`<buffer>`、`<silent>`、`<nowait>`、`<unique>`；Insert 表达式缩写 |
| 用户命令 | `-nargs`、`-range`、`-count`、`-bang`、`-buffer`、参数/范围/次数/bang 占位符；名称以大写开头 |
| 编辑 | 行读取、替换、追加、删除；UTF-8 字节列与编辑器位置换算；光标、标记、寄存器、打开缓冲区查询、视图恢复；`normal[!]`、表达式寄存器、自定义 `operatorfunc/g@` |
| 事件 | `BufEnter/Leave/Add/Delete/WinEnter/WinLeave/Read/ReadPost`、`FileType`、`InsertEnter/Leave`、`BufWritePre/Post`、`CursorMoved[I]`、`TextChanged[I]`、`SourcePre/Post`、`VimEnter`、`User`；事件组、清除、模式、`++once`、嵌套控制、`doautocmd` |

`g:` 在当前 Vault 的运行时中共享；`s:` 属于脚本；`b:` 属于文档；`w:` 属于视图；`l:` 和 `a:` 属于调用帧，闭包引用其词法环境；`v:` 提供执行上下文。`setlocal` 与 buffer-local 映射不影响其他文件。`number/relativenumber/wrap/scrolloff` 等窗口选项按视图保存。

内置函数分为容器、字符串/正则、编辑器、查询和路径模块。设置页“支持的脚本能力”直接读取注册表，列出实际函数、命令、选项与事件；`exists()`、`has()` 使用相同注册信息。未知函数、命令、选项或不支持的语法明确报错。

正文与撤销历史仍由原编辑器持有。脚本修改通过 CodeMirror 事务，支持撤销；映射、自定义操作符和宏沿用原执行队列。`g@` 的参数为 `char`、`line` 或 `block`，范围通过 `'[`、`']` 标记传入。高频光标/文本事件仅在有相应订阅时调度；Vim 写入事件仍只来自原有 Vim 显式写入路径，不绑定 Obsidian 自动保存。

## 重载、错误与资源

设置 → Vim → **Vim 脚本** 默认折叠，提供打开目录、重新加载、已加载脚本、待重载状态、错误详情和能力清单。

- 保存 `.vimrc`、其配置依赖或虚拟配置时，变量、选项、映射、函数和事件定义可以自动更新。自动重载不会重跑插件顶层代码；在这次重载中尝试修改正文、移动光标、写寄存器或执行宿主操作会得到诊断。之后由你按映射、执行命令或显式重新加载脚本时，仍能使用原有的编辑能力。
- 新增或修改插件目录中的脚本显示待重载；点击“重新加载脚本”重建整个脚本运行时。全局/脚本/缓冲区/视图变量、函数、映射和事件重新初始化；正文、寄存器、宏和撤销历史保留。
- 语法树按文件内容缓存，不在普通按键路径读取文件或重新解析。循环、函数执行与批处理协作让出；执行中的视图按 Escape/Ctrl+C 可取消，关闭视图也会取消其未完成任务，其他视图继续运行。
- 错误包含脚本文件、行列与调用栈。已经完成的正文修改可撤销；这不等于把任意脚本的所有副作用整体回滚。
- 关闭 Vim 或卸载时释放运行状态、文件监听、视图引用和调度资源。

## 可运行示例

将 [示例目录](examples/vim/) 的内容复制到当前 Vault 的 `mv-aide/vim/`，启用 Markdown Vim 并重新加载脚本。

- `:1,3Prefix NOTE: ` 为前三行添加前缀，`u` 撤销。
- `\G` 在首行与末行之间切换，使用表达式映射。
- Insert 模式输入 `mva` 后按空格，展开为 `MV-AIDE`。
- Markdown 文件局部设置 HTML 注释格式；不会影响其他类型。

示例不自动创建或写入任何笔记。它们只有用户调用时才修改当前编辑器。

## 验收与兼容边界

首个第三方行为样本为未经改写的 **vim-commentary 1.3**，固定提交 `64a654ef4a20db1727938338310209b6a63f60c9`，SHA-256 `ad49e119b5f081a7a4be7dc8d90ce8ebc5a017c2193f511e42333c5a50c5182b`。测试比较真实 Vim 的单行、motion、Visual、范围命令、取消注释、次数、重复、宏与撤销结果。该测试样本不会自动安装到用户脚本目录。

这不是完整 Vim。首期不支持 Vim9script、Lua、作业/频道/网络函数、终端作业、独立插件窗口、完整语法高亮及联网插件管理器；Vim 全套选项、全部 Vim 正则原子和任意第三方插件也不在兼容承诺内。已有外部命令仍受原设置控制，不增加脚本文件写入接口。Windows/Linux 有平台路径与 CI 测试入口，实机桌面验收仅记录实际运行过的平台，不把 macOS 验收当作三平台实测。
