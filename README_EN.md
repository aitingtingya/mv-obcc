# mv-AIDE

[中文](README.md) | [Complete feature guide](docs/features-en.md)

**Turn Obsidian into an AI IDE for writing, research, and development.** mv-AIDE gives agents access to the material you are actively reading and editing, then brings AI editing, source tools, a terminal, Vim, and desktop file workflows into one interface.

> Desktop only; requires Obsidian 1.7.2 or later.

[GitHub repository](https://github.com/aitingtingya/mv-obcc)

![Claude Code reads the active file and selection from the mv-AIDE terminal](media/readme/ide-bridge.gif)

## Why mv-AIDE

### Agents stay in context

Claude Code, Codex CLI, and any MCP agent can read active tabs, selections, diagnostics, terminal output, and note relationships. Proposed edits return to Obsidian as an editable diff for review.

### AI becomes part of the editor

**In-file AI assistant** groups API Providers, Selection Assistant, and Inline Completion. The two assistants share providers while keeping independent switches and runtime lifecycles.

### One workflow from prose to source code and desktop files

Edit TeX and other source types, run a real terminal, use an independent Vim engine, browse the filesystem, and open external files in a chosen Obsidian vault. Every module can be disabled independently.

## Eight Settings Sections

The order below matches **Settings → mv-AIDE**. See the [complete feature guide](docs/features-en.md) for defaults, platform boundaries, and troubleshooting.

### 1. IDE Bridge

The active file, selection, and editor state are passively synchronized with the agent. Select text and ask naturally; there is no preliminary instruction to call a context-reading tool. Claude Code, Codex CLI, general MCP clients, and DeepSeek Harness (DSH) are supported. With **Enable DSH IDE features** turned on, the mv-AIDE plugin inside DSH connects through the same local bridge for live context, IDE tools, passive notifications, and diff review.

![Claude Code reads the active file and selection from the mv-AIDE terminal and answers](media/readme/ide-bridge.gif)

[IDE Bridge details](docs/features-en.md#ide-bridge)

### 2. mv-agent (DSH-powered)

mv-agent puts the DSH web interface directly inside Obsidian. Its bottom status bar shows the real bridge state, current page or file, selection, port, and expandable live details; the command palette provides **Open / Stop / Restart mv-agent**.

Settings inspect Node.js, DSH, pnpm, and plugin injection as four separate layers. They support vault or global installations as well as verified DeepSeek Harness source checkouts. Once injected, DSH gains the `/mv-aide` command and `mv_aide__*` IDE tools, including:

- per-conversation vault selection, history, and recovery;
- editable Obsidian diff review for file writes that require permission;
- direct drops from the vault or local filesystem: images become attachments and other files become live `@file` references;
- seven optional enhanced terminal tools, including reliable command execution and true tab closing;
- pre-upload image fitting plus image-input, reasoning-level, and compatibility declarations for models;
- out-of-vault tools and passive context that remain off by default and can be opened per channel.

Full injection manages three independent DSH plugins: mv-agent, mv-dsh-manager, and mv-dsh-subworkspace. The native **Plugin configuration** page contains cards for the first two; associated directories are managed from the control inserted directly between each Workspace row's ellipsis and plus buttons. mv-dsh-subworkspace does not depend on the IDE bridge. Its `workspace` tool can list, switch, and reset the current session root, while `_workspace` added generically to native DSH tools can select one root, an array, or `"all"` for independent concurrent execution without tool-specific adapters.

File drop is likewise independent of the IDE bridge, so local files can still be appended to the current DSH draft while the bridge is disabled. The injected DSH plugins support opt-in automatic updates aligned to the current mv-AIDE build, with an optional restart of mv-agent after the update; the native Obsidian status bar can also be hidden from the mv-agent section.

![Real DSH answers from the current selection and expands the live mv-agent status](media/readme/mv-agent.gif)

[mv-agent details](docs/features-en.md#mv-agent)

### 3. In-file AI assistant

Expanding it shows three default-collapsed subsections in this order: **API Providers**, **Selection Assistant**, and **Inline Completion**. Expansion state is remembered only for the current settings-page session and adds no persisted setting.

#### API Providers

Manage OpenAI-compatible or Anthropic endpoints, keys, and models shared by both assistants.

#### Selection Assistant

Select text in Markdown, PDF, or Web Viewer, invoke a prompt template, then edit, insert, or replace from the streamed result. Web Viewer is cross-origin isolated, so an opt-in injected context menu (experimental) is offered; when it is off, your bound "LLM: xxx" hotkeys are mirrored into the page. The demo translates a selection from an English PDF through DeepSeek.

![Selection Assistant streams a Chinese translation over a full-page English PDF](media/readme/selection-assistant.gif)

[Selection Assistant settings](docs/features-en.md#selection-assistant)

#### Inline Completion

Generate dimmed ghost text while writing Markdown. It enters the document only after Tab acceptance; it can also be canceled or rejected to request another version.

![A dimmed inline suggestion appears and Tab commits it to the document](media/readme/inline-completion.gif)

[Inline Completion parameters](docs/features-en.md#inline-completion)

### 4. Terminal

Run a real system terminal in the main area, a sidebar, or a bottom split, keeping the command line and editor in one workspace. Terminal settings control open position independently from the new-terminal mode (split or new tab). `mv-run: <command>` targets the most recently active mv-AIDE terminal (creating one when needed), while `mv-run -n: <command>` always creates a new terminal first. With mv-agent's **Enhanced terminal awareness** enabled, DSH can also read, send, run, focus, or close a terminal by id.

![Obsidian editor and the real mv-AIDE system terminal](media/readme/terminal.png)

[Terminal support](docs/features-en.md#terminal)

### 5. Source Assist

Register non-Markdown source extensions and configure highlighting, linting, regex replacement, `mv-run`, Code Suite, and optional enhanced TeX math rendering. The Markdown view header can be set to auto-collapse from this section as well.

![TeX Code Suite and math preview](media/readme/source-assist.gif)

[Source profiles and Code Suite](docs/features-en.md#source-assist)

### 6. Vim Enhancement

The independently implemented Vim core supports the major modes, motions, operators, text objects, registers, macros, search, Ex commands, and a vault-level `.vimrc`. When Obsidian's native status bar is hidden, the Vim mode badge automatically falls back to an overlay inside the editor.

![Vim modes, relative line numbers, and a real edit](media/readme/vim.gif)

**Legend:** use motions in `NORMAL`, move the live selection and cursor together in `VISUAL`, and enter text in `INSERT`. The gutter demonstrates `.vimrc` `number` + `relativenumber`.

[Vim capability reference](docs/features-en.md#vim)

### 7. Default File Opener

Route Markdown, PDF, and selected source extensions to a specific Obsidian vault. Double-clicking an external file can wake Obsidian and open the target vault even when it was closed; on Windows, external PDFs use a short-lived mirror that is cleaned after the last matching tab closes.

![Finder opens an external file in the selected Obsidian vault](media/readme/default-opener.gif)

[Platform limits and data model](docs/features-en.md#default-opener)

### 8. Filesystem & Browser

Browse arbitrary directories, open downloaded files, and add Downloads and History entry points to Obsidian's built-in Web Viewer. Three independent **auto-collapse** switches slim down the Web Viewer toolbar, the Markdown view header, and the workspace tab bar; **custom web page buttons** register a favorite URL as a ribbon icon or command-palette command that opens in the left, center, or right region with one click.

![Filesystem browser and Web Viewer toolbar entries](media/readme/filesystem-browser.png)

[File routing rules](docs/features-en.md#filesystem-browser)

## Installation

### Community Plugins

1. Open **Settings → Community plugins → Browse**.
2. Search for `mv-AIDE`, then install and enable it.

<details>
<summary>Manual installation</summary>

Download `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/aitingtingya/mv-obcc/releases), then place them in:

```text
<vault>/.obsidian/plugins/mv-obcc/
```

Enable mv-AIDE under **Settings → Community plugins**.

</details>

<details>
<summary>Build from source</summary>

```bash
npm install
npm run verify
npm run deploy:local
```

`npm run package` creates release artifacts under `release/`.

</details>

## Data & Permissions

- The IDE bridge, universal MCP endpoint, and default-opener service listen on `127.0.0.1` only.
- API keys are stored as plain text in `data.json` inside the current vault's plugin directory. Protect the vault and its backups accordingly.
- Vim configuration, external-file mirrors, and other vault-level data live under `mv-aide/` in the current vault. Cross-process state lives under `~/.mv-aide/`: IDE discovery under `ide/`, dsh bridge selection under `dsh/`, and the current default-opener authority under `file-opener/` (with failure-safe legacy compatibility during upgrade).
- mv-agent environment installation accesses the network only after the user clicks an action. Vault-installed Node.js, DSH, and pnpm runtimes live under `<vault>/mv-aide/dsh/`; the three independently managed DSH plugins live in the DSH web profile. Downloads, npm caches, and installer scripts use an operation-scoped temporary workspace that is removed when the action ends. Global installation or in-place upgrade uses a native administrator prompt and never silently falls back to the vault.
- Windows default-app confirmation must be completed by the user. The plugin writes only to the current user's registry, requests no administrator privileges, and never modifies the protected `UserChoice`.
- Modules have independent switches. When Vim is disabled for every extension, its runtime, listeners, and editor extensions are not loaded.

See [Data and network boundaries](docs/features-en.md#storage-network) and the [platform matrix](docs/features-en.md#platform-matrix) for details.

## Documentation

- [Complete Feature Guide](docs/features-en.md)
- [完整功能手册](docs/features.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [License](LICENSE)

## Acknowledgements

The CodeMirror architecture of Inline Completion was informed by the public design of [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot), and the terminal process bridge by [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar). Source Assist's Code Suite kernel is based on [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5` with its MIT notice preserved. Vim compatibility targets and configuration UX were informed by the public documentation and user-visible ideas of [obsidian-vimrc-support](https://github.com/esm7/obsidian-vimrc-support) and [Vim Motions](https://github.com/saberzero1/motions); mv-AIDE's core engine is independently implemented against Vim/Neovim behavior and CodeMirror 6 APIs.

See [Third-party notices](THIRD_PARTY_NOTICES.md) and the [license](LICENSE) for the exact boundaries.
