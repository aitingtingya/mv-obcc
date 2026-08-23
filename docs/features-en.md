# mv-AIDE Complete Feature Guide

[Back to README](../README_EN.md) | [中文](features.md)

This guide describes mv-AIDE `0.9.10` in the same order as its settings page, including behavior, defaults, boundaries, and recovery procedures. The README is the visual introduction; this document is the complete behavioral reference.

## Contents

- [Overview](#overview)
- [Requirements](#requirements)
- [Settings map](#settings-map)
- [1. IDE Bridge](#ide-bridge)
- [2. mv-agent](#mv-agent)
- [3. In-file AI assistant](#in-document-ai)
  - [API Providers](#api-providers)
  - [Selection Assistant](#selection-assistant)
  - [Inline Completion](#inline-completion)
- [4. Terminal](#terminal)
- [5. Source Assist](#source-assist)
- [6. Vim Enhancement](#vim)
- [7. Default File Opener](#default-opener)
- [8. Filesystem & Browser](#filesystem-browser)
- [Cross-feature behavior](#cross-feature)
- [Commands and entry points](#commands)
- [Platform matrix](#platform-matrix)
- [Data and network boundaries](#storage-network)
- [Troubleshooting](#troubleshooting)
- [Provenance and licenses](#acknowledgements)

<a id="overview"></a>
## Overview

mv-AIDE is a desktop AI IDE plugin for Obsidian. Its eight main settings sections preserve functional boundaries, with **In-file AI assistant** grouping API Providers, Selection Assistant, and Inline Completion. Features share only the editor context they need: agents can read the active work surface, AI can participate directly in text editing, source tools and a terminal remain inside Obsidian, and Vim, the default opener, and filesystem browsing extend the editor to desktop workflows.

Design principles:

- **Local first**: local services bind only to loopback and no persistent background daemon is installed.
- **Explicit enablement**: model access, Vim, universal MCP, the default opener, and external commands have independent switches.
- **Vault isolation**: configuration, vimrc, external-file mirrors, and runtime ownership are scoped to the current vault.
- **Reviewable editing**: agent edits can return as an editable Obsidian diff instead of executing invisibly.
- **Clean shutdown**: disabling a module releases its editor extensions, listeners, status UI, and local services.

<a id="requirements"></a>
## Requirements

| Item | Requirement |
| --- | --- |
| Obsidian | 1.7.2 or later |
| Platform | Desktop only; mobile is unsupported |
| Plugin ID | `mv-obcc` |
| Network | Needed only for configured AI providers and agents; core editing tools can run offline |
| Terminal | PTY on macOS/Linux; ConPTY through `pywinpty` on Windows |
| Default opener | macOS, Windows, and Linux; each requires one-time system registration or confirmation |

Community Plugins is the recommended installation route. A manual installation must contain `main.js`, `manifest.json`, and `styles.css` together.

<a id="settings-map"></a>
## Settings Map

| Order | Section | Default | Purpose |
| --- | --- | --- | --- |
| 1 | IDE Bridge | Claude on; Codex, universal MCP, and dsh off | Agent context, tools, and diff review |
| 2 | mv-agent | Off | Built-in DSH: environment install, plugin injection, view, and out-of-vault policy |
| 3 | In-file AI assistant | All three subsections collapsed; Selection and Inline switches off | API providers, selection tasks, and Markdown ghost text |
| 4 | Terminal | Available; opens on the right | System shell, path links, and MCP output |
| 5 | Source Assist | On; Markdown profile only | Non-md extensions, Code Suite, linting, and TeX |
| 6 | Vim Enhancement | Off for every extension | Independent Vim engine and vault vimrc |
| 7 | Default File Opener | Off | System associations and external-file mirrors |
| 8 | Filesystem & Browser | All three entry points on | Downloads, history, and arbitrary-directory browsing |

Inside **In-file AI assistant**, the order is fixed: **API Providers**, **Selection Assistant**, then **Inline Completion**. All three start collapsed. Their expansion state is remembered only for the current settings-page session and creates no persisted field. This is an information-architecture change only: provider, selection, and inline settings retain their existing fields, defaults, persistence, and runtime paths.

The UI language defaults to Chinese. Persisted settings are stored per vault and are not automatically shared across vaults.

<a id="ide-bridge"></a>
## 1. IDE Bridge

### Purpose and Enablement

IDE Bridge provides active Obsidian context to Claude Code, Codex CLI, general MCP clients, or DeepSeek Harness (DSH), and returns proposed file edits to Obsidian for review.

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable Claude Code IDE support | On | Writes the unified discovery lock (`~/.mv-aide/ide`) plus the Claude compatibility mirror in `~/.claude/ide`, and registers the `mv-aide` MCP service |
| Enable Codex IDE support | Off | Writes a managed MCP block and exposes `/ide` context |
| Enable DSH IDE support | Off | Starts the IDE bridge and writes the authoritative discovery lock to `~/.mv-aide/ide` so the mv-AIDE plugin inside dsh can connect to this vault |
| Expose the mv-AIDE protocol | Off | Opens separately authorized HTTP/stdio access for other MCP clients |
| Support all active pages | Off | Tracks any non-terminal Obsidian tab; terminal tabs are always excluded and the latest valid passive context is retained |
| Track Markdown / PDF / Web Viewer | On / On / On | Per-view controls while “all active pages” is off |
| Preserve selection highlight across tabs | On | Keeps a visual reminder without changing transmitted selection data |
| Push lint errors | On | Makes Source Assist diagnostics available to agents |
| Include heading breadcrumb | On | Adds the enclosing heading hierarchy to selection context |

Disabling Claude or Codex removes only registrations and discovery information written by mv-AIDE. Other client configuration is preserved. In Claude Code, use `/ide` to verify the IDE connection and `claude mcp get mv-aide` to inspect registration. Codex receives a managed `mcp_servers.mv_aide_obsidian` block in `~/.codex/config.toml`. “Support all active pages” updates live; terminal exclusion requires no hook installation or agent restart.

Preserved selection highlighting is visual state only: the latest Markdown, PDF, or web selection remains visible after switching to a terminal or another tab; clicking or selecting again on the original page restores native Obsidian behavior.

### Context and Tools

There are 11 independently configurable public tools. All are on by default except full web-page reading:

| Tool | Default | Purpose |
| --- | --- | --- |
| `getLatestSelection` | On | Latest tab, selection, and context |
| `getOpenEditors` | On | Open editors and tabs |
| `openFile` | On | Open and locate a file in Obsidian |
| `readCurrentWebPage` | Off | Convert visible content from the loaded page to Markdown |
| `getDiagnostics` | On | Current Source Assist/lint diagnostics |
| `getTerminalOutput` | On | Recent terminal output; `lastN` is 1–500, default 50 |
| `searchVaultSymbols` | On | Search vault symbols |
| `getBacklinks` | On | Backlinks for the current note |
| `getOutgoingLinks` | On | Outgoing links for the current note |
| `searchTags` | On | Search tags |
| `listNotesByTag` | On | List notes under a tag |

The protocol also uses three review/UI tools, `openDiff`, `closeAllDiffTabs`, and `close_tab`, for a complete universal MCP set of 14 tools. Claude and Codex channels respect the public-tool switches; the explicitly enabled universal MCP endpoint exposes the complete set.

The maximum result length for `readCurrentWebPage` is unlimited when blank or `0`, and truncated only for a positive integer. It reads already loaded, visible page content and does not bypass authentication, paywalls, or browser security boundaries.

Universal MCP also publishes five read-only resources:

- `obsidian://mv-aide/workspace/context`
- `obsidian://mv-aide/workspace/open-editors`
- `obsidian://mv-aide/workspace/latest-selection`
- `obsidian://mv-aide/workspace/latest-mention`
- `obsidian://mv-aide/workspace/diagnostics`

### MCP Protocol and Lifecycle

- Negotiates MCP versions `2026-07-28`, `2025-11-25`, and `2025-03-26`.
- Streamable HTTP and stdio are scoped to the current vault. HTTP binds only to `127.0.0.1` and uses a random per-vault Bearer token.
- Settings can copy HTTP/stdio configuration, refresh status, and rotate the token. Every client must be updated after rotation.
- The stdio launcher connects only to an already running Obsidian instance; it does not wake the application.
- Services load on demand after Obsidian becomes idle and are removed when disabled or uninstalled.
- Claude/Codex executables are normally auto-detected; enter a full path for Windows or custom installations.

### Diff and Permissions

`openDiff` uses CodeMirror MergeView. Under normal permissions, users can inspect, edit, accept, or reject the patch. Under `acceptEdits`, mv-AIDE follows the agent's native permission and accepts without another dialog. It does not bypass the agent permission model.

Other agents can call `openDiff` from their own PreToolUse/write hook. Whether acceptance skips a second native prompt, whether edited tool input can be returned, and how hook timeouts behave are client-specific and are not guaranteed by MCP.

Kimi Code `0.30+` has been validated as a normal MCP client connected through the stdio launcher. Users must supply their own hook script; a minimal configuration shape is:

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

Kimi currently exposes allow/block rather than a programmable “approve.” Skipping its native prompt after accepting the diff still requires `permission.rules`. Rules load only at session startup and globs do not automatically match dot-directories. Manual edits in the review cannot return through `updatedInput`. Hooks cap at 600 seconds and fail open on timeout/crash; permission-mode detection depends on the unpublished `permission.set_mode` event in `wire.jsonl` and may change between client versions.

### Bridge and Fallback

The IDE bridge no longer rewrites agent requests or exposes an arbitrary upstream proxy. Passive context is delivered through the IDE protocol, while proactive capabilities are invoked through IDE/MCP tools.

If the bridge fails, the editor, Selection Assistant, Inline Completion, Terminal, and Source Assist still operate independently. “Restart bridge” rebuilds the local service and the unified discovery lock (including the Claude compatibility mirror). “Re-register” and “Clean registration” affect only mv-AIDE's own integration.

### DSH Support

DSH is the fourth adapted agent. With **Enable DSH IDE support** turned on, the plugin starts the IDE bridge and writes the authoritative discovery lock to `~/.mv-aide/ide`; the installed `@mv-aide/mv-agent` scans that lock file and connects to this vault over the same local JSON-RPC protocol as Claude Code (`127.0.0.1`, port `47000 + vault seed % 1500`). Once connected, dsh gains:

- The `/mv-aide` command: `status` (per-session connection state and bridge info), `bridges` (list all IDE bridges), `connect <index|port|path|auto>` (per-session manual selection / back to auto), `tools` (list IDE tools), `selection` (read the current selection), and `call <name> [json]` (invoke any bridge tool). Bridge selection is persisted per dsh session and restored after dsh restarts. Automatic resolution tries, in order: the current conversation's last successful vault, the same DSH workspace's last successful vault, then a live vault containing that workspace. If none is connectable it remains disconnected; it never chooses an unrelated port. Every candidate must pass WebSocket authentication, `initialize`, and `tools/list`, so a stale lock or bad token falls through to the next candidate. Picking `mv-aide` from the `/` menu first completes the command into the composer (`/mv-aide `, then `/mv-aide connect ` for `connect`) before opening each recursive popup (`connect` shows the bridge list, `call` shows the tool list) and executes only when a leaf is selected; errors raised by the picker itself are shown in Chinese.
- **Multiple vaults and conversations**: one DSH conversation connects to one vault at a time. Different conversations may connect to different vaults or to the same vault concurrently. Each conversation owns its connection, reconnect loop, and history; switching or closing one never affects another. The vault path is the identity, so a changed port is recovered by path. `connect auto` clears only the current conversation's history.
- Native `mv_aide__*` tools (e.g. `mv_aide__getLatestSelection`, `mv_aide__openFile`), matching the public tools in “Context and Tools” and obeying the same switches.
- Passive context notifications and diff review: dsh agents receive the same selection pushes and `openDiff` review channel as Claude Code.

Plugin injection, environment installation, and the out-of-vault policy belong to the standalone feature area — see [Chapter 2, mv-agent](#mv-agent).

<a id="mv-agent"></a>
## 2. mv-agent (DSH-powered)

mv-agent embeds DeepSeek Harness (DSH) directly into Obsidian: use the DSH web UI inside Obsidian, with environment installation, plugin injection, the view, and out-of-vault boundaries managed in one standalone section. It shares the local bridge service with IDE Bridge — mv-agent installs DSH, connects it, and manages scope, while agent context and tools still flow through the Chapter 1 bridge channel.

### Purpose and Enablement

- The **master switch** lives in the “Adapted agents” area of IDE Bridge (**Enable DSH IDE support**, off by default). When off, the bridge does not start and no lock file is written; the rest of the mv-agent section is preserved but inactive.
- **View**: the command palette provides **Open mv-agent**, **Stop mv-agent**, and **Restart mv-agent**; hotkeys can be bound in Obsidian's hotkey settings. **Stop mv-agent** closes every open mv-agent view and stops its DSH backend. The custom Obsidian view embeds the DSH web UI directly in an iframe (no browser toolbar), with an Obsidian-side status bar below it. Its connection dot reads the real TCP relationship between that view's DSH endpoint and the current Vault bridge: gray while checking, green when connected, and red only after a confirmed disconnect. It does not depend on whether this Vault originally started the shared DSH instance.
- **Open region**: left, right, or bottom; right by default. “Restart mv-agent” restarts the plugin-managed `dsh web` process and refreshes every open view.
- **Enhanced terminal awareness**: off by default and scoped to mv-agent / DSH only. When enabled, mv-agent does not register the basic `mv_aide__getTerminalOutput`; it registers seven native mv-AIDE terminal tools for list/read/send/run/open/focus/close instead. When disabled, those seven disappear and the original `getTerminalOutput` returns. `sendTerminalInput` is the raw path for Ctrl+C, TUI/REPL input, and optional Enter; `runInTerminal` is the reliable shell-command path and preserves quotes, `!`, whitespace, Unicode, multiline commands, and same-shell `cd`/`export` effects. Deferred tabs restored after an Obsidian restart start a fresh shell only: `readTerminal` waits for its new prompt to be committed to xterm and never restores old output. `closeTerminal` requires an explicit id and closes the Obsidian tab and its PTY without waking a deferred tab. Switching refreshes tools live without restarting DSH and never changes the public `tools/list` seen by other IDE clients. Outside-vault access continues to reuse the existing `getTerminalOutput` scope setting.
- **Automatically fit image size**: on by default. Images are processed before they are sent and written into DSH history. A longest edge above 2000px is proportionally reduced to 2000px; smaller image bytes and the original local file are left unchanged. Turning it off restores DSH's native size limit.
- **Hide Obsidian native status bar**: off by default. It only toggles a dedicated `body` class that hides Obsidian's own `.status-bar` container; it does not target mv-agent's own status UI and does not reconnect the bridge, restart DSH, or refresh tools.
- **Address and port**: the DSH web service binds only to `127.0.0.1`, default port `3080`, configurable in settings. The view auto-detects an already running dsh instance; while none is running it shows “mv-agent is not running.”

### Runtime Environment

Settings exposes Node.js, DSH, pnpm, and plugin injection as four layers. Clicking **Check** reads the actual local versions and then checks the installable targets. A version below its target shows the target version and **Upgrade**; a version equal to its target shows **Reinstall**. Opening settings does not perform these remote version checks automatically.

- DSH supports Node.js 22.19+ within Node 22, or Node 24+. When mv-AIDE actively installs or upgrades Node.js, it selects the latest stable Node release with major version 24 or newer and verifies the package against that release's official `SHASUMS256.txt`.
- The DSH update target follows npm's `@deepseek-ai/dsh@next` channel, while pnpm follows `pnpm@latest`. Dist-tags are used only to resolve a target; installation uses the resolved exact version.
- When Node.js, DSH, or pnpm is absent, clicking its action asks for a vault or global location. An installed dependency is upgraded or reinstalled strictly in place. If the local version is newer than the current channel target, mv-AIDE does not downgrade it automatically.
- Acting on a lower layer satisfies its prerequisites first. Plugin injection, for example, ensures Node.js, DSH, and pnpm in order and re-inspects real state after every layer. A successful installer exit code is not sufficient: the post-install version must exactly match the chosen target or the operation reports failure.
- Final vault-installed runtimes live under `<vault>/mv-aide/dsh/`. Downloads, npm caches, installer scripts, and staging files exist only in an operation-scoped temporary workspace and are removed after success, failure, or cancellation. A global write to a protected directory requests native macOS administrator authorization, Windows UAC, or Linux `pkexec`. Refusing authorization stops the chain and never falls back to the vault.
- For a global macOS Node installation, the verified public `.pkg` is staged temporarily in `/private/tmp` so the system installer service can read it. The temporary file is removed after success, failure, or cancellation.
- When both locations exist, the vault installation is preferred. Runtime detection first resolves the user's actual command environment: macOS/Linux use the login interactive shell PATH, while Windows merges the current process PATH with User and Machine PATH values; Node and npm must be paired and runnable. Global DSH/pnpm are resolved from that npm's global prefix first, then from the same user command PATH as a fallback. Version checks, installation, upgrades, and post-install verification all reuse that environment so detection cannot resolve one toolchain while execution silently uses another. Injection targets the shared DSH web profile; mv-agent and mv-dsh-manager report their versions, integrity, and actual load state separately.
- **Source-checkout installations**: a running `pnpm dsh web`, `apps/cli/src/bin.ts`, or built `apps/cli/lib/bin.js` can be identified from its verified endpoint, listener command line, and cwd without scanning the user's disk. If the CLI cannot be reconstructed safely, mv-AIDE reports “DSH is running” separately from “not yet manageable” instead of calling it entirely uninstalled.
- **Custom DSH directory**: enter either the DeepSeek Harness repository root or `apps/cli`. Validation checks manifest identity, the declared bin entry, real-path containment, Node/pnpm, version output, and `dsh --profile web --dump-config`. A validated custom directory always wins; if it breaks, mv-AIDE reports the failure instead of silently choosing another DSH. Clearing it restores the existing vault-before-global order.
- Source checkouts retain the same detection, start/stop/restart, injection, and management features. Check uses the Git branch's configured upstream commit as update authority instead of substituting the npm release version. An explicit Upgrade/Reinstall requires a clean Git worktree, a configured upstream, and a fast-forward update before dependencies are installed, the project is built, and the CLI is revalidated. mv-AIDE never auto-stashes, force-merges, or substitutes an npm copy. A cross-process lock keyed by the real source root serializes the operation; a failed post-update build or validation rolls back and rebuilds the original commit, and a failed restoration is reported explicitly.
- Downloads start only from an explicit user action. Node.js is downloaded into the operation-scoped temporary workspace; checksum failure or cancellation removes temporary files and preserves the previous runtime.

### Plugin Injection and DSH-side Capabilities

**Plugin injection** writes two public packages into the active DSH web profile's `node_modules` and registers them in its patch layer: `@mv-aide/mv-agent` provides the bridge, command, and native tools, while `@mv-aide/mv-dsh-manager` provides plugin, skill, and preset management. Each bundle marker records the mv-AIDE release version that shipped it and a content fingerprint; the authority is mv-AIDE's `manifest.version`, not either package's own version. The resulting graph is also verified with `dsh --profile web --dump-config`.

- **Below the current mv-AIDE version**: shows the installed version and recommends Upgrade. Checks and background startup do not overwrite it; only an explicit user upgrade writes the current bundle.
- **Equal to the current mv-AIDE version**: fully checks the marker, file set, fingerprint, patch registration, and actual DSH load. Missing or damaged state shows Repair. A different fingerprint at the same version is reported as a build conflict and can be replaced only by an explicit Update.
- **Above the current mv-AIDE version**: shows Newer version installed, skips the older build's fingerprint comparison, update, and overwrite, and only confirms that the package structure is readable and DSH actually loaded it. If the newer package is not loaded or is structurally damaged, the UI directs the user to the matching newer mv-AIDE; the older build never downgrades it.
- **Legacy marker or invalid version**: shows Version unknown and recommends Upgrade, without automatic replacement. Full injection is Ready only when both mv-agent and mv-dsh-manager independently satisfy compatibility and load checks.
- A cross-process lock serializes writes to the shared profile and every writer rechecks versions after acquiring it. Each package is published through its own staging directory, full validation, directory swap, and rollback; the next operation first recovers an interrupted transaction. Background checks never kill a working DSH. Settings distinguish disk bundles from the versions loaded by the running DSH and show Restart pending; an explicit Open/Restart mv-agent coordinates the required restart.

Once injected (capability details in Chapter 1, “DSH Support”):

- `/mv-aide status | tools | bridges | connect <index|port|path|auto> | selection | call <name> [json]`;
- native `mv_aide__*` tools matching the public tool switches;
- passive context notifications and editable Obsidian diff review.

### Image Uploads

With **Automatically fit image size** enabled, mv-agent preprocesses ordinary messages, Queue/Steer sends, and image-capable slash commands through one path before DSH creates the upload payload or writes history. PNG, JPEG, WebP, and GIF keep their formats, including transparency, orientation, and animation semantics. If confirmed preprocessing fails, the composer and draft images remain in place, an explicit error is shown, and the oversized original is not sent. Each session follows the setting from the vault whose bridge handshake it completed, so two sessions may use opposite settings; when no setting authority is known, native DSH behavior is preserved. The request-time guard remains for oversized images already present in old history, but new uploads no longer rely on that fallback.

### DSH Model Capability Settings

mv-dsh-manager appends **Model capabilities** inside the capacity disclosure of each model in DSH's native Models catalog; it does not create a second model-settings page. Both hand-declared models and DSH built-in catalog models can declare text/image input, disabled or mapped reasoning levels, and every model-level compatibility field exposed by DSH 0.1.1's `llm-pi-ai` schema. Reasoning uses canonical DSH levels (`off/minimal/low/medium/high/xhigh/max`) mapped to the provider's wire value, for example `max → 最大`.

- Selecting Text + Image stores `input: ['text', 'image']`; the next model resolution and request sees it immediately. This is a user declaration about the endpoint, so a provider can still reject an incorrect declaration.
- Reasoning may inherit, be explicitly disabled, or map several levels. `off` may omit its wire value; every other level requires one. The default reasoning level remains session- or provider-owned.
- The collapsed expert area covers DSH's current model-level `compat`: reasoning formats, request/stream behavior, strict tools, cache/Anthropic switches, and typed `chatTemplateKwargs`. Every boolean can return to inheritance.
- Editing a built-in model shows a warning and creates only that model's `modelOverrides`; it never changes or copies the installed catalog. Clearing the last field removes the empty override and restores catalog defaults.
- Capability drafts share the native provider card's Save action. DSH first saves the native model, capacity, credential, and provider fields; only after that editor closes successfully are capabilities committed atomically against a fresh revision. Cancel or native failure writes nothing. A second-stage failure explicitly reports that the base model was saved while capabilities were not and offers a retry.
- Independent host/client modules implement the feature. The host accepts only whitelisted `llm-pi-ai` model fields and preserves other models, unknown fields, and future compat keys. Older DSH schemas are reported as unsupported and are never guessed into.

### DSH Plugin, Skill, and Preset Management

The `/api/mv-aide/*` management panels injected into the mv-agent settings and the DSH web page now perform real installation instead of config-only writes:

- **Import plugin**: package names and local paths are delegated to `dsh plugin --profile web add <spec>`; a local path is converted to an absolute `file:<path>` spec. Success must be confirmed from the web profile manifest, and this path does not append another patch row. If `dsh plugin add` is unavailable or fails, the operation returns that error directly; **there is no `file:` hot-load fallback**. Package-plugin removal likewise uses `dsh plugin remove` and verifies the manifest.
- **Clone preset**: copies the complete source preset directory (including `agent.cordis.yml` and local plugin files) so the clone mounts normally; DSH-unknown `base:` fields are no longer written.
- **Preset enable/disable**: user presets are truly hidden/restored by renaming their directory (`<id>.disabled`) instead of writing a `disabled:` key DSH never reads; system presets cannot be disabled.
- **New skill**: writes into `$DSH_HOME/skills` (DSH's real, hot-watched user skill root) and enforces DSH's kebab-case name rule so the created skill is never silently ignored.

### Diff as Permission

The dsh plugin wraps file-writing tools: when a write would demand DSH's permission confirmation (a `write`/`edit` escalation retry) or would be denied outright by the standing policy (e.g. `str_replace_editor` under read-only), the change opens as an editable Obsidian diff through the bridge instead of the default web approval card:

- **Accept** → the approved (possibly hand-edited) contents are written to disk by the dsh plugin; that write is the permission grant.
- **Reject** → a synthetic failure (nothing was written).
- **Bridge down / 5-minute timeout / unreadable file / adapter mismatch** → falls through to DSH's default flow unchanged.
- Trigger boundaries: never fires under `danger-full-access`, for read-only tools, or for `str_replace_editor` `view`; `bash`/`pwsh` are not covered and keep DSH's own confirmation.
- In-vault files always review. Files **outside the vault** review only when **Review out-of-vault diffs in Obsidian** is enabled (off by default).
- Known limitations: the write bypasses DSH's sandbox bookkeeping (no `fs/observed` is emitted and the approval is not recorded in DSH's approval audit), so the model may re-read the file after accepting.

### Passive Context

The bridge continuously records the latest valid selection state, but selection changes are not injected into the agent immediately. When the user sends a message to dsh, the plugin injects the latest snapshot into that agent's inbox; while the agent is working, page or selection changes do not create a stream of passive injections. Explicit @mentions still steer the current agent (duplicate mentions within 5 s are dropped).

`selection_changed` only updates the pending snapshot, capped at 6000 characters, with a 400 ms debounce, exact-repeat deduplication, and latest-state replacement. The status bar's **Location** and **Selection** checkboxes independently control whether those fields are included. In-vault agents can always receive the snapshot; out-of-vault agents are governed per channel by the **Out-of-vault tool policy** (all off by default).

### Out-of-vault Project Policy

The “IDE tools” grid in the mv-agent section mirrors the IDE Bridge tool list one-to-one, with one difference: each row's trailing control is a **scope dropdown** — “In-vault workspaces only / Both in- and out-of-vault” — instead of a toggle. Every channel defaults to in-vault only. An out-of-vault agent calling a non-opted channel receives an error instead of a bridge call. The grid's “Diff review behavior” row writes the standalone **Review out-of-vault diffs in Obsidian** switch (off by default), controlling whether out-of-vault writes go through Obsidian diff review.

<a id="in-document-ai"></a>
## 3. In-file AI assistant

This main section consolidates settings navigation only; it does not merge three data models or runtimes. After expanding it, **API Providers**, **Selection Assistant**, and **Inline Completion** appear in that order and start collapsed.

<a id="api-providers"></a>
### API Providers

Selection Assistant and Inline Completion share one provider list.

| Item | Behavior |
| --- | --- |
| Types | OpenAI-compatible or Anthropic |
| Base URL | Required; OpenAI-compatible appends `/chat/completions`, Anthropic appends `/v1/messages` |
| API key | Plain text in plugin `data.json`; optional for unauthenticated local services |
| Models | User-maintained; the model name is sent unchanged to the API, while the internal ID is only a stable reference |
| Reasoning | Default, on, off, or custom JSON; provider compatibility varies |
| Bypass CORS | Off by default; uses Obsidian's internal request channel when on, bypassing `app://` Origin but returning the full response at once instead of streaming |

Deleting a provider or model clears template/completion references to prevent dangling configuration. mv-AIDE does not automatically upload vault, terminal, or selection data. Only a user-triggered template/completion request or an explicitly enabled agent tool sends the relevant context.

<a id="selection-assistant"></a>
### Selection Assistant

The master switch is off by default and independent from IDE Bridge. Once enabled, templates can act on selections in Markdown, PDF, and Web Viewer.

- Markdown: use `LLM → Template` from the context menu or a hotkey.
- PDF: the context menu is commonly owned by Obsidian/pdf++; use a hotkey.
- Web Viewer: bound hotkeys are injected by default. Experimental context-menu injection suppresses the page's native menu and may be blocked by site security policy.

#### Prompt Templates

Three enabled templates ship by default: Translate, Summarize, and Polish. Each has an independent name, enable switch, prompt, provider, model, and reasoning mode. `{selection}` inserts selected text; when absent, the selection is appended to the prompt.

Reasoning can be Default, On, Off, or custom JSON. Custom payload support depends on the provider.

#### Result Window and History

- Responses stream into a draggable, resizable floating Markdown editor.
- The result can be inserted at the cursor, replace the original selection, or remain separate.
- Pinning reuses the current window and prevents automatic closing after insert/replace.
- The latest content is overwritten at `<vault>/mv-aide/llm-history/latest.md`; this file is hidden from the file tree, search, and quick switcher.
- Selection auto-trigger defaults to off on every launch and must be armed from the ribbon. It reacts only to new selections created afterward.

Request failures are shown in the floating window and do not modify source text. Disabling the section removes its context menus, injected hotkeys, auto-trigger listeners, and active result pipeline.

<a id="inline-completion"></a>
### Inline Completion

#### Defaults

| Setting | Default |
| --- | --- |
| Enable Inline Completion | Off |
| Automatic-completion ribbon state | Disarmed on every launch |
| Trigger delay | 700 ms |
| Context before cursor | 2,000 characters |
| Context after cursor | 2,000 characters |
| Maximum completion length | 200 characters |
| Maximum completion lines | 3 |
| Accept | `Tab` |
| Cancel | `Escape` |
| Reject and regenerate | Unbound |
| Manual request | Unbound |

Once enabled, the ribbon button controls automatic requests; a manual request key still works while the button is disarmed. Ghost text appears only in the Markdown editor and is never written before acceptance.

#### Prompts and Results

The prompt body, no-completion instruction, and regenerate-after-rejection instruction are configurable. The rejection prompt supports `{rejected}`. `<MV_AIDE_NO_COMPLETION>` in the no-completion instruction is a protocol sentinel; changing or deleting it prevents reliable suppression of empty suggestions.

Accept applies one editor transaction. Cancel only clears the suggestion. Reject can send the previous suggestion back to request another version. New edits, cursor movement, file switches, or disabling the feature invalidate stale requests so an old response cannot overwrite a new cursor position.

#### Interaction with Other Input Features

A visible AI suggestion consumes its accept/cancel keys first. See [Cross-feature behavior](#cross-feature) for the complete Vim Insert priority. Selection Assistant and Inline Completion share provider definitions but have independent switches, prompts, and runtime lifecycles.

<a id="terminal"></a>
## 4. Terminal

### Opening and Layout

Open the terminal from the ribbon or the “Open System Terminal” command. No global hotkey is assigned by default.

| Setting | Default/options |
| --- | --- |
| Open position | Right sidebar; left sidebar, main area, and bottom split are available |
| New terminal open mode | Split (default) or new tab; independent from open position |
| Layout rule | Left/right sidebar splits stack vertically; main-area splits are left/right; bottom first creates a lower pane, then later terminals become tabs or left/right splits inside that pane according to the selected mode |
| macOS/Linux shell | `$SHELL`, falling back to `/bin/zsh` |
| macOS/Linux arguments | `-l` |
| Windows shell | `cmd.exe` |
| Windows arguments | Empty |
| Font | `Menlo, Monaco, monospace` |
| Size | 13 px |
| Key passthrough | On |
| Theme | Follow Obsidian; light, dark, and custom are available |

Multiple terminals can coexist in main, side, and bottom areas. Closing a terminal tab ends its process; unloading the plugin releases remaining PTY/ConPTY sessions.

### Platform and Dependencies

- macOS/Linux run the real shell through a PTY.
- Windows uses ConPTY through `pywinpty`. Settings can check/update the dependency and select a Python executable.
- A Nerd Font such as `MesloLGS NF` can fix missing terminal icons or dividers; leaving the field empty restores the default font stack.
- Custom themes store structured color values only and execute no CSS or JavaScript.
- A custom palette is copied from the built-in light or dark palette and can be reset to defaults in one action.
- With key passthrough enabled, Ctrl, Alt, function-key, and arrow combinations go to the focused terminal before Obsidian hotkeys.
- Double-clicking or Ctrl-clicking a recognized path attempts to open and locate it in Obsidian.

`getTerminalOutput` returns only the requested recent lines and does not continuously transmit terminal content. Network activity by commands inside the shell remains the user's responsibility.

<a id="source-assist"></a>
## 5. Source Assist

### Profiles and Extension Registration

Source Assist is enabled by default and always includes a Markdown (`.md`) profile. Users may add extensions matching `[a-z0-9][a-z0-9+_-]*`, such as `.tex`, `.bib`, `.py`, or `.m`.

Adding an extension:

1. Registers it as a Markdown view to reuse the CodeMirror/Live Preview editor.
2. Adds it to “Create non-MD source file” ribbon and command entries.
3. Gives it independent Code Suite, lint, `mv-run`, regex, highlighting, and Vim settings.

If another plugin already owns the extension, mv-AIDE attempts to switch it to Markdown view, which can change the other plugin's behavior. Removing a profile removes mv-AIDE's registration but never deletes source files.

### Code Suite

Code Suite is a per-profile Latex Suite-compatible editing kernel, not merely a snippet list. It is enabled for the default Markdown profile.

- Rules use a Latex Suite-compatible array format with tabstops, math context, previews, and context conditions; a leading `//` line is ignored as a JavaScript-style comment.
- Manual trigger defaults to `Tab`; next/previous tabstop default to `Tab` / `Shift-Tab`. Each can be selected or recorded.
- Disabling Code Suite unloads only that profile's execution pipeline. Extension registration, highlighting, linting, and Markdown view remain.
- Native `$...$`, `$$...$$`, and configured TeX regions share one math-context source. Code Suite consumes the analysis and does not own visual rendering.
- A `.tex` profile's three-part math formats are: `n` inline with inner source, `j` display with inner source, `nl` inline with complete delimiters, and `jl` display with complete delimiters.

### Enhanced TeX

`.tex` profiles can independently enable TeX outline and enhanced math rendering. Enhanced rendering is off by default and requires that profile's Code Suite runtime.

- Supports native `\(...\)`, `\[...\]`, dollar math, and user-defined `n/j/nl/jl` regions.
- Analysis and rewriting produce one unified math-region model; Obsidian MathJax and Code Suite consume the same result independently.
- Inactive formulas can render in place; clicking restores original editable source. Failure preserves source rather than showing an empty widget.
- Math previews appear above the formula by default and may show the `▶` cursor indicator and bracket highlighting; position, indicator, and highlighting have independent settings.
- Three-part formats use exact string matching, not a complete TeX parser. Invalid, crossing, or unclosed formats are skipped while scanning continues for later valid regions.

### Lint, mv-run, and Regex Replacement

| Feature | Behavior |
| --- | --- |
| Lint | Per-profile command; `{file}` becomes a quoted path, otherwise the path is appended |
| Automatic lint | Persistent mode runs about 600 ms after editing stops; manual run and clear are available |
| Diagnostic format | `file:line:col: message`, with optional column; diagnostics can be sent through IDE Bridge |
| `mv-run` | Reads matching comment lines at the end of the file; prefixes are semicolon-separated. `mv-run: <command>` runs in the most recently active mv-AIDE integrated terminal, creating one when none exists; `mv-run -n: <command>` always creates a new integrated terminal first |
| Current-file regex | Uses the CodeMirror search panel |
| Multi-file regex | Current folder or full vault, with preview before apply |
| Maximum scope | Off/current file/current folder/full vault per profile; Markdown defaults to current file |

External commands run with the current user's permissions. Empty commands do nothing; mv-AIDE does not install lint or `mv-run` toolchains.

Typical forms: `# mv-run: python main.py` reuses the most recently active terminal, while `# mv-run -n: pytest` forces a new one. Block-comment prefixes also work, for example `<!-- mv-run: npm run build -->`; TeX can use `% mv-run -n: latexmk -pdf main.tex` when `%` is configured as a prefix.

### Highlight Themes

Prism CSS, highlight.js CSS, VS Code/Shiki/TextMate JSON, and mv-AIDE JSON can be imported with optional format detection. Non-Prism formats are converted to approximate token colors and are not guaranteed to be pixel-identical. Highlight themes affect tokens only, not Code Suite expansion or view registration.

<a id="vim"></a>
## 6. Vim Enhancement

### Isolation and Enablement

mv-AIDE's Vim engine is independently implemented and does not depend on Obsidian's built-in Vim or a third-party Vim engine. Every source extension is off by default; host and CodeMirror modules are dynamically loaded only when at least one extension is enabled.

Before enablement, mv-AIDE checks built-in Vim and known conflicting plugins. A conflict refuses activation with instructions and never modifies another plugin's settings. When every extension is off, mv-AIDE reads no vimrc and registers no Vim keys, status item, styles, listener, timer, or global compatibility object.

### Implemented Capabilities

| Category | Supported behavior |
| --- | --- |
| Modes | Normal, Insert, Replace, Visual, Visual Line, Visual Block, Operator-pending, Command-line |
| Motions | `h j k l`, arrows, `gj/gk`, `0 ^ $ g_`, Home/End, `w/W/b/B/e/E/ge/gE`, `gg/G`, `{ } ( )`, `%`, `|`, `f/F/t/T/;/,` |
| Operators/actions | `d x X D`, `c s S C`, `y Y`, `p/P`, `>/<`, `=`, `~ g~ gu gU`, `J`, `u`, `Ctrl-r`, `.` |
| Text objects | `iw/aw`, `iW/aW`, `is/as`, `ip/ap`, paired parentheses/brackets/braces/angles, and single/double/backtick quotes |
| State | unnamed, numbered, small-delete, named, black-hole, and clipboard registers; macros `q/@`; mark commands `m`, `'`, and the backtick jump; jumps `Ctrl-o/Ctrl-i` |
| Search | `/`, `?`, `n`, `N` |
| Ex | `:s`, `:%s`, `:w`, `:q`, `:wq`, `:x`, `:e`, `:sp`, `:vsp`, `:registers`, `:marks`, `:jumps`, `:set`, `:setlocal`, `:normal`, `:sort`, `:obcommand`, `:!` |
| vimrc | `set/setlocal`, map/noremap/unmap families, `mapleader`, Insert abbreviations, `source`, custom Ex, controlled autocmd |

Complete Vimscript, Lua, `<expr>`, and similar unsupported syntax is rejected explicitly instead of parsing successfully and failing silently. Vim Motions extras such as EasyMotion, Oil, Picker, and Harpoon are outside this engine's scope.

### Vimrc and Options

The global configuration is fixed at `<vault>/mv-aide/vim/.vimrc`. Every extension can also store a virtual vimrc that executes afterward. Exactly identical normalized directives execute once; semantically distinct mappings are not merged.

| Option | Default |
| --- | --- |
| `tabstop` | 4 |
| `shiftwidth` | 4 |
| `expandtab` | On |
| `ignorecase` / `smartcase` | Off / Off |
| `wrap` | On |
| `number` / `relativenumber` | Off / Off |
| `timeoutlen` | 1,000 ms |
| `clipboard` | Empty |

Legacy user-directory or plugin-directory files are read only through explicit migration in settings and are never runtime sources. A migrated user-directory file is removed only after success; an old plugin-directory file is copied read-only and never rewritten. Sourced files are watched in load order; source cycles are blocked. Parse errors are isolated by directive and never modify the document.

### Input, Cursor, and Visual State

- Insert priority is **visible AI suggestion → Code Suite snippet/tabstop → authorized Vim `imap`/`abbrev` → native input**.
- While Code Suite is active, Vim Insert mappings are disabled by default and require per-extension coexistence permission. They become available automatically when Code Suite is off.
- With an AI suggestion visible, the first Escape cancels it; the next Escape leaves Insert. `Ctrl-[` also leaves Insert.
- IME composition, paste, and drag/drop are not interpreted as ordinary Vim mapping sequences.
- Mode status displays either text or one color swatch, never both. Normal/Visual use a block cursor, Insert a bar, and Replace/Operator an underline.
- The non-Insert block cursor follows text color by default or can use violet, blue, green, orange, red, cyan, or custom RGB (0–255 per channel). Its width adapts to full-width characters such as CJK.
- One logical snapshot owns the Visual range while the host selection holds only the active cursor. Character/line/block operators, relative numbers, AI context, and system copy use the logical range.

`:!` and external programs reached through autocmd require separate authorization, off by default. `:w/:wq/:x` call an explicit save on the current Obsidian view; a failed save never proceeds to quit.

<a id="default-opener"></a>
## 7. Default File Opener

### Ownership and Status

The master switch is off by default. Enabling it starts a loopback receiver for the current vault; the system wrapper sends a double-clicked path to that vault. System registration is persistent and does not disappear after a computer restart.

Status checks distinguish exactly:

1. Obsidian/mv-AIDE is not the default opener.
2. An mv-AIDE injection exists but another vault owns it.
3. The current vault is the owner.

“Install” never doubles as cleanup. Any existing or incomplete mv-AIDE registration, regardless of owner, is reported and must be explicitly cleaned before another installation. This prevents vaults from silently replacing one another.

### Extensions

- Built in: `.md`, `.markdown`, `.pdf`.
- Extended: registered Source Assist profiles such as `.tex`, `.py`, and `.m`, independent of their Code Suite switch.
- Each extension is enabled independently. Changing the registered set requires cleanup followed by a new installation.
- Enabling the first source extension from the built-in-only state enters extended mode while every other source extension remains independently off. The controls remain in the collapsible area at the bottom of the section.

### External Files and Mirrors

External files are not copied into normal note folders. Except for external PDFs on Windows, mv-AIDE continues to use the existing persistent mirror model under `<vault>/mv-aide/external-files/mirror`:

1. Always attempt and verify a real symbolic link first.
2. Use an isolated managed copy with bidirectional synchronization only after the platform/filesystem proves links unavailable and the user explicitly consents.
3. “Retry and migrate to symbolic links” acts only on safely converged managed copies.
4. Host/mapping state lives under `<vault>/mv-aide/external-files/hosts`.

External PDFs on Windows use a separate short-lived mirror under `<vault>/mv-aide/external-files/pdf-ephemeral` and do not enter the persistent mapping above:

1. Prefer a normal-file hard link; fall back to an asynchronous copy only when the filesystem cannot create the hard link, including cross-volume cases.
2. Copies are first written to an isolated `.mv-aide-part-*` file and atomically renamed to `.pdf` only after completion checks, so the PDF viewer never indexes an incomplete copy.
3. Reopening the same PDF during one run reuses its temporary mirror. Cleanup starts when the last matching tab closes, with short retries when Windows still holds the file handle.
4. Temporary PDFs left by an abnormal exit are handled after the workspace layout is restored on the next launch; files still referenced by restored tabs or owned by another live process are preserved.

When a legacy persistent mirror directory is detected, settings still offers only the existing explicit migration. Startup never silently moves old data.

The receiver must not live under `.obsidian`, and Obsidian startup must never scan vault files and send them through the system default opener. These constraints prevent startup recursion and infinite loops.

### Platform Behavior

| Platform | Installation | User confirmation |
| --- | --- | --- |
| macOS | Installs `MV AIDE File Opener.app`, bundle id `com.mv.aide.file-opener` | Finder “Open With” confirmation may be needed |
| Windows | Current-user `HKCU` ProgId `MV.AIDE.FileOpener[.<ext>]` | Windows 8+ requires per-extension confirmation in Default Apps |
| Linux | Installs `mv-aide-file-opener.desktop` | Depends on desktop MIME settings |

Windows requests no elevation and never writes protected `UserChoice`. Select **MV AIDE File Opener**, not Windows Based Script Host, in the system UI.

The current authority for mv-AIDE-owned opener artifacts is `~/.mv-aide/file-opener/`, including owner, runtime, wrapper, helper, and icon files. Operating-system associations do not live in that directory: macOS keeps them in Launch Services, Windows in the current user's `HKCU`, and Linux in desktop/MIME databases. The wrapper is not a daemon: if Obsidian is closed it first wakes the target vault through an Obsidian URL, then waits for the plugin service; if Obsidian is already running it brings the window forward.

During upgrade, only exact legacy wrapper/runtime/helper/icon names under the `~/.mv-aide/` root with a verifiable owner are considered. Migration generates and verifies the new-authority assets first, then completes macOS Launch Services activation, switches the Windows-owned registration while confirming effective defaults are unchanged, or switches the Linux desktop entry. Only then are the legacy owner/runtime retired; old artifacts are cleaned only at known paths. Invalid data, conflicts, custom paths, symlinks, or any failure before the switch preserve the legacy owner and old entry for continued use and a later retry. While a verified old launcher remains active, the compatibility path refreshes only that exact legacy runtime file.

“Show file-type icons inside Obsidian” is on by default and affects only tabs and similar UI. The wrapper application provides system association icons using a white document, extension label, and official Obsidian logo badge.

<a id="filesystem-browser"></a>
## 8. Filesystem & Browser

All three entry points are on by default and can be disabled independently.

### Downloads

Adds a Downloads button to the built-in Web Viewer toolbar and opens the system Downloads folder:

- Sorts newest first by modification time.
- Shows common documents, images, and Obsidian-browsable formats by default; “Show all” removes the filter.
- Clicking a file opens it through mv-AIDE's route in the current vault.
- Each item also offers “Open with default app” and “Show in folder.”
- “Open Downloads folder” delegates to the system file manager.

### Browser History

Adds a Web Viewer toolbar entry that invokes Obsidian's official history command. New builds use `webviewer:open-history`, with `browser:open-history` as a compatibility fallback. mv-AIDE does not maintain a second browsing-history database.

### Browse Any Directory

Adds a directory button to the file explorer toolbar and opens a path browser:

- The top path is editable; Enter navigates to it.
- A dropdown contains common locations and deduplicated recent paths.
- Clicking a directory descends; clicking a file uses the same route as Downloads.
- Supported formats open directly in the current vault rather than through the system default handler. Only an explicit “default app” action uses system association.

Disabling an entry removes only its button and listeners and never deletes downloads, history, or external files.

<a id="cross-feature"></a>
## Cross-feature Behavior

### Editor Input Priority

Vim Insert priority is fixed:

1. A visible AI inline suggestion.
2. A Code Suite snippet or tabstop.
3. A Vim `imap`/`abbrev` authorized for that extension.
4. Native CodeMirror/system input.

Normal, Visual, Operator-pending, and Command-line consume non-system editing keys. IME composition, system shortcuts, paste, and drag/drop are not split into Vim mappings.

### Extensions and Openers

Source Assist profiles are the single source for additional extensions. Code Suite, Vim, and Default Opener consume the profile independently. Disabling Code Suite does not remove the extension, disabling Vim does not affect source editing, and disabling Default Opener does not affect direct opening inside Obsidian.

### Selection and Agents

Normal Markdown/PDF/Web Viewer selections, Vim's logical Visual selection, IDE latest-selection context, and Selection Assistant share one effective-selection interface. Visual Block text is joined by line for AI consumption. Disabling Vim immediately returns ownership to the native Obsidian selection.

### mv-agent and IDE Bridge

mv-agent shares IDE Bridge's local bridge service, the same public tool switches, and the same `openDiff` review channel; mv-agent's **Out-of-vault tool policy** is a scope control layered on top of the public switches that applies to dsh agents only. Turning off **Enable DSH IDE support** stops only the bridge and the lock file; mv-agent's environment-install state and settings are preserved. Disabling the whole mv-agent section does not affect Claude Code / Codex / universal MCP.

### Failure Isolation

- AI request failures do not disable IDE Bridge, Terminal, or source editing.
- Code Suite/TeX rendering failures preserve editable source.
- Vim configuration errors are isolated per directive; an all-off Vim configuration does not load the runtime.
- Default-opener registration failures do not affect internal Obsidian file routing.
- Missing terminal dependencies do not prevent the other seven main sections from loading.
- When the mv-agent environment is missing or DSH is not running, the other seven main sections work normally; the view shows “mv-agent is not running” instead of failing.

<a id="commands"></a>
## Commands and Entry Points

Command names are localized with the interface language. Major groups include:

- Send the current selection to Claude/an agent.
- Open System Terminal.
- Open, close, and restart mv-agent.
- Run `mv-run` for the current file.
- Create a registered non-Markdown source file.
- Open an external file, open by path, and prune broken external links.
- Current-file and multi-file regex replacement.
- One command per enabled LLM template.
- Run lint, clear diagnostics, and enable/disable persistent lint.
- Commands registered by the Code Suite kernel for snippets, tabstops, and previews.

Only Inline Completion's accept/cancel behavior has default editing keys; mv-AIDE does not assign global command hotkeys. Bind other commands from Obsidian's Hotkeys settings.

<a id="platform-matrix"></a>
## Platform Matrix

| Feature | macOS | Windows | Linux | Notes |
| --- | --- | --- | --- | --- |
| IDE Bridge / MCP | Yes | Yes | Yes | Client executable paths may need manual configuration |
| mv-agent (DSH) | Yes | Yes | Yes | Global install authorization: macOS administrator / Windows UAC / Linux `pkexec` |
| Selection / Inline AI | Yes | Yes | Yes | Depends on API compatibility |
| Terminal | PTY | ConPTY/pywinpty | PTY | Windows dependency checks are available in settings |
| Source Assist / Code Suite | Yes | Yes | Yes | Desktop CodeMirror only |
| Vim | Yes | Yes | Yes | Other Vim engines must be disabled |
| Default Opener | `.app`/Launch Services | HKCU ProgId + system confirmation | `.desktop`/MIME | Windows cannot silently set UserChoice |
| Symbolic-link mirror | Native | Depends on permission/developer mode | Native | Managed-copy fallback only after proven failure |
| Web Viewer toolbar | Yes | Yes | Yes | Requires Obsidian's built-in Web Viewer |

<a id="storage-network"></a>
## Data and Network Boundaries

### Persistent and Runtime Paths

| Path | Content |
| --- | --- |
| `<vault>/.obsidian/plugins/mv-obcc/data.json` | Settings, API keys, templates, profiles, managed state |
| `<vault>/mv-aide/vim/.vimrc` | Global Vim configuration for this vault |
| `<vault>/mv-aide/external-files/mirror` | External-file symlinks or explicitly authorized managed copies |
| `<vault>/mv-aide/external-files/hosts` | External-file host/mapping state |
| `<vault>/mv-aide/llm-history/latest.md` | Latest Selection Assistant content, overwritten and hidden from common indexes |
| `<vault>/mv-aide/dsh/` | Vault-installed Node.js, DSH, and pnpm runtimes for mv-agent |
| `$DSH_HOME/profiles/web/` (default `~/.dsh/profiles/web/`) | DSH web profile, patch layer, and `@mv-aide/mv-agent` / `@mv-aide/mv-dsh-manager` |
| `~/.mv-aide/ide/` | Unified IDE bridge discovery registry (authoritative mv-AIDE lock files) |
| `~/.mv-aide/dsh/bridge-selection.json` | Per-session dsh bridge selections (persisted, partitioned by session key) |
| `~/.mv-aide/file-opener/` | Current default-opener authority: owner, runtime, wrapper, helper, and icon files; excludes OS association databases |
| `~/.mv-aide/runtime/` | Rebuildable runtime artifacts for Terminal, universal MCP, and Codex integration |
| `~/.mv-aide/tmp/` | Operation-scoped temporary files for DSH installation, opener preflight, and similar work |
| `$CLAUDE_CONFIG_DIR/ide/` (default `~/.claude/ide/`) | Claude Code discovery compatibility mirror; `~/.mv-aide/ide/` remains authoritative |
| `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | Marked, managed `mcp_servers.mv_aide_obsidian` block |

New mv-AIDE cross-process artifacts are written only to the exact subdirectories above. Claude, Codex, and DSH client locations respect `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `DSH_HOME`, respectively. Legacy Vim paths are read only when the user explicitly requests migration and are not runtime sources.

### Local Ports and External Network

- IDE, universal MCP, and default-opener services bind only to `127.0.0.1`.
- The DSH web service managed by mv-agent binds only to `127.0.0.1`, default port `3080` (configurable in settings).
- Universal MCP requires a per-vault Bearer token; rotation invalidates the previous token immediately.
- Selection Assistant and Inline Completion connect only to the configured API Base URL.
- Claude/Codex networking, terminal-command networking, and Web Viewer browsing are owned by those programs.
- mv-AIDE installs no persistent daemon and binds no service to a LAN interface.

### Sensitive Data

API keys are stored in plain text in `data.json` and may propagate through vault backup or sync. Do not commit a real `data.json` or publish a demonstration vault containing keys. MCP tokens, managed agent blocks, and default-opener owner state should also be treated as machine configuration.

<a id="troubleshooting"></a>
## Troubleshooting

### Agent Does Not Connect

1. Check the relevant Claude/Codex switch and executable path.
2. Refresh status or re-register, then restart the client or invoke its MCP refresh command.
3. For universal MCP, verify the URL, Bearer token, and protocol version. Stdio requires Obsidian to be running.
4. The IDE bridge no longer proxies custom upstreams; if an agent uses a custom model endpoint, troubleshoot it in the agent's own configuration.

### DSH Environment, Injection, or Plugin Import Fails

1. Inspect the mv-agent layers in order: Node.js → DSH → pnpm → Plugin Injection. A lower-layer action satisfies prerequisites first, but preserves the actual error from any failed layer.
2. Full injection is ready only when both `@mv-aide/mv-agent` and `@mv-aide/mv-dsh-manager` are present and `--dump-config` verification succeeds. Use Repair when either package or verification is missing.
3. A plugin-graph change coordinates one restart of a running DSH instance. If the UI still has the old module graph, inspect the restart error, then use **Restart mv-agent** from the command palette.
4. User plugin imports always go through `dsh plugin add`. If the command, local path, `package.json` name, or profile-manifest verification fails, correct the cause and retry. Do not expect a `file:` hot-load fallback and do not append a patch row manually.

### Diff Does Not Appear

Check the agent permission mode. `acceptEdits` accepts directly. Third-party agents need their own write hook to call `openDiff`; timeout and fail-open behavior belongs to the agent.

### Selection Assistant or Inline Completion Fails

1. Check provider, model, Base URL, and API key.
2. If the console reports CORS/`Failed to fetch`, enable Bypass CORS, with the tradeoff that output no longer streams.
3. Prefer hotkeys for web selections; experimental menu injection may be blocked by a site.
4. If Inline Completion cannot suppress empty results, restore the default prompt and keep `<MV_AIDE_NO_COMPLETION>` intact.

### Windows Terminal Does Not Start

Select the correct Python executable, run Check Dependencies, then Update Dependencies if needed, or install `pywinpty` with the same interpreter. A custom shell path must point to an executable.

### Source Extension Opens Incorrectly

Ensure only one plugin owns the extension's view registration. Removing and re-adding the Source Assist profile refreshes mv-AIDE registration but may affect other plugins. Disabling Code Suite does not unregister the extension.

### TeX Does Not Render or Code Suite Does Not Trigger

Verify that the `.tex` profile's Code Suite is on; enhanced rendering has a separate switch. Check that three-part start/end strings match exactly and do not cross. Rendering failure should leave source editable; console output can identify MathJax or rule errors.

### Vim Keys Stop Working

Disable Obsidian built-in Vim, Vim Motions, Vimrc Support, and other engines, then confirm Vim is enabled for the current extension. Normal keys should resume after a CJK IME composition ends. Insert mappings require per-extension authorization while Code Suite is active.

### Default Opener Is Installed but Ineffective

- Run Check first. If another vault owns it or registration is incomplete, Clean before Install.
- The current authority for mv-AIDE-owned opener files is `~/.mv-aide/file-opener/`. Do not equate that directory's existence with an effective OS association.
- If Check reports a legacy-path migration failure, old files remain intact. Correct the reported permission, path, or new/old conflict and run Check again; do not first delete the old owner or wrapper manually.
- Windows also requires choosing **MV AIDE File Opener** per extension in Default Apps; the plugin does not bypass Windows user confirmation by directly modifying `UserChoice`.
- On macOS, confirm Finder's “Open With” choice. Stale icons are normally an OS cache issue. On Windows, restart `explorer.exe` or sign out and back in to refresh the icon cache.
- Do not manually point the wrapper directly at the Obsidian executable; doing so can create URL/file-association loops.

### External File Cannot Be Saved

Check that the entry under `mv-aide/external-files/mirror` is a valid symbolic link. A managed copy is used only after an explicit consent prompt; synchronization conflicts never silently overwrite either side. Use “Retry and migrate to symbolic links” when appropriate.

<a id="acknowledgements"></a>
## Provenance and Licenses

- Inline Completion's CodeMirror ghost-text architecture was informed by the public design of [obsidian-github-copilot](https://github.com/Pierrad/obsidian-github-copilot).
- The terminal PTY process bridge was informed by the public design of [obsidian-claude-sidebar](https://github.com/derek-larson14/obsidian-claude-sidebar).
- Source Assist's Code Suite kernel is based on [obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) `1.11.5`, preserving the upstream MIT license.
- Vim compatibility targets and configuration UX were informed by the public documentation and user-visible ideas of [obsidian-vimrc-support](https://github.com/esm7/obsidian-vimrc-support) and [Vim Motions](https://github.com/saberzero1/motions). mv-AIDE bundles or derives neither engine; its core is independently implemented against Vim/Neovim behavior and CodeMirror 6 APIs.

mv-AIDE does not require any of the plugins above to be installed or enabled at runtime.

See [Third-party notices](../THIRD_PARTY_NOTICES.md) for legal notices and implementation boundaries, and [LICENSE](../LICENSE) for the project license.
