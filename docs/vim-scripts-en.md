# Vimscript and `.vim` scripts

mv-AIDE executes a traditional Vimscript subset on its independently authored Vim engine. It does not invoke Vim, Neovim or JavaScript to execute user scripts. Enable Vim for a source extension to use it; no additional runtime installation is required. Behavior is compared with real Vim 9.1. A `.vim` extension does not imply compatibility with every Vim plugin.

## Location and loading

The only script root is `mv-aide/vim/` inside the current vault:

```text
mv-aide/vim/
├── .vimrc
├── plugin/*.vim
├── autoload/*.vim
├── ftdetect/*.vim
├── ftplugin/*.vim
├── after/{plugin,ftplugin,autoload}/
└── pack/<group>/{start,opt}/<plugin>/{plugin,autoload,ftplugin,after}/
```

- `.vimrc` and its `source` dependencies execute first. Relative source paths resolve against the calling script's directory. In this integration, `~/` denotes the vault's Vim configuration root, not the operating-system home. Resolved real paths must remain inside this root.
- Startup loads `plugin` and `pack/*/start/*/plugin`, followed by `after` overrides. Nested `.vim` files use stable filename ordering. `ftdetect` registers file-type events; autoload files, file-type scripts and optional packages are not eagerly executed as startup plugins.
- Calling `demo#Action()` first searches for `autoload/demo.vim`; `demo#part#Action()` uses `autoload/demo/part.vim`.
- `runtime` loads the first match, `runtime!` all matches. `packadd name` loads an optional package; `packadd! name` adds its lookup path without executing its plugins. `packloadall` loads start packages not already loaded. `scriptnames` lists loaded files.
- File-type mapping covers Markdown, TeX, BibTeX, Python, JavaScript, TypeScript and other common extensions. Unknown extensions become their own type names. `ftdetect` can use `BufRead` and `setfiletype` to change detection. Type scripts are `ftplugin/<type>.vim`, `<type>_*.vim` and `<type>/*.vim`, including package and `after` equivalents.
- Multiple views of one file initialize buffer configuration once. The extension's virtual vimrc runs last; its options, mappings, commands and abbreviations are local to that buffer.
- System `~/.vimrc` and `~/.vim` are not runtime sources. There is no network plugin installer or custom external root. The real configuration root must be inside this vault. Scripts, packages and watched directories must resolve inside that root. Out-of-bounds entries are neither loaded nor watched and appear in script diagnostics.

## Language and editor integration

| Area | Implemented behavior |
| --- | --- |
| Values and expressions | Signed 64-bit integers, floats, strings, booleans, null, reference Lists/Dictionaries and Funcrefs; indexing, slicing, destructuring; arithmetic, comparisons/case variants, short circuiting, ternaries, concatenation, pattern comparisons, option/register access |
| Control flow | `let/unlet`, compound assignment, `if/elseif/else`, `for/while`, `break/continue`, `return/finish`, `try/catch/finally/throw` |
| Functions | `function[!]`, parameters, varargs, script-local/autoload functions, Funcrefs, partial argument binding, lambdas, closures and Dictionary functions; `call`, `execute` and `eval()` use the script interpreter |
| Mappings | Existing mode families of map/noremap/unmap/mapclear; `<expr>`, `<Plug>`, `<SID>`, `<Leader>`, `<LocalLeader>`, `<buffer>`, `<silent>`, `<nowait>`, `<unique>`; expression Insert abbreviations |
| User commands | `-nargs`, `-range`, `-count`, `-bang`, `-buffer`, and argument/range/count/bang placeholders; names start with an uppercase letter |
| Editing | Read/replace/append/delete lines, UTF-8 byte columns, cursor/marks/registers, open-buffer queries and view restoration; `normal[!]`, the expression register, custom `operatorfunc/g@` |
| Events | `BufEnter/Leave/Add/Delete/WinEnter/WinLeave/Read/ReadPost`, `FileType`, `InsertEnter/Leave`, `BufWritePre/Post`, `CursorMoved[I]`, `TextChanged[I]`, `SourcePre/Post`, `VimEnter`, `User`; groups, clearing, patterns, `++once`, nesting control and `doautocmd` |

`g:` belongs to the vault runtime, `s:` to a script, `b:` to a document and `w:` to a view. `l:` and `a:` belong to a call frame; closures retain their lexical environment. `v:` provides execution context. Local mappings and `setlocal` do not alter unrelated files. Window options such as `number`, `relativenumber`, `wrap` and `scrolloff` are stored per view.

Builtins live in separate container, string/pattern, editor, query and path modules. The settings capability list is generated from the registry and lists available functions, commands, options and events; `exists()` and `has()` use the same registration data. Unsupported functions, commands, options and syntax report errors.

The existing editor remains the sole owner of text and undo history. Script edits use CodeMirror transactions and remain undoable. Mappings, custom operators and macros share existing execution boundaries. `g@` receives `char`, `line` or `block`, with the affected region in `'[` and `']`. Cursor/text events are scheduled only when subscribed. Write events retain the explicit Vim write boundary and are not attached to Obsidian autosave.

## Reload, diagnostics and resources

Settings → Vim → **Vim scripts** is collapsed by default. It exposes the directory, reload action, loaded scripts, pending changes, diagnostics and supported capabilities.

- Saving `.vimrc`, its configuration dependencies, or a virtual vimrc can update variables, options, mappings, functions and event definitions automatically. Automatic reload does not re-run plugin top-level code. Attempts to edit text, move the cursor, write registers or invoke host actions during that reload produce a diagnostic. Invoking a mapping or command afterwards, or explicitly reloading scripts, retains the usual editing capabilities.
- Changes under plugin directories mark scripts pending. **Reload scripts** reconstructs the runtime, including variables, functions, mappings and events. Documents, registers, macros and undo history remain intact.
- Parsed programs are cached by source contents. Ordinary keys do not read script files or parse them again. Loops and batch execution yield cooperatively. Escape/Ctrl+C in the executing view cancels its work; closing that view also cancels it without cancelling another view.
- Diagnostics include the source file, line/column and call stack. Completed text edits remain undoable; arbitrary script side effects are not claimed to be one rollback transaction.
- Disabling Vim or unloading releases runtime state, file watchers, view references and scheduled work.

## Runnable example

Copy the contents of the [example directory](examples/vim/) into the vault's `mv-aide/vim/`, enable Markdown Vim, and reload scripts.

- `:1,3Prefix NOTE: ` prefixes the first three lines; `u` undoes the edit.
- `\G` uses an expression mapping to toggle between the first and last lines.
- Type `mva` followed by a space in Insert mode to expand it to `MV-AIDE`.
- The Markdown file-type script selects HTML comments only for that type.

The examples do not create notes automatically. They edit the current document only when invoked.

## Verification and boundaries

The first third-party behavior fixture is unmodified **vim-commentary 1.3**, commit `64a654ef4a20db1727938338310209b6a63f60c9`, SHA-256 `ad49e119b5f081a7a4be7dc8d90ce8ebc5a017c2193f511e42333c5a50c5182b`. Tests compare real Vim results for line, motion, Visual, range command, uncomment, count, repeat, macro and undo operations. This fixture is not automatically installed in a user's script directory.

This is not a complete Vim implementation. Vim9script, Lua, jobs/channels/network functions, terminal jobs, plugin-owned windows, full syntax highlighting and network plugin management are outside this delivery. The entire Vim option set, every pattern atom and arbitrary third-party plugins are not promised. Existing external commands retain their existing permission setting; scripts receive no new file-write interface. Windows/Linux path semantics have automated tests and CI entry points; desktop verification is reported only for platforms actually exercised.
