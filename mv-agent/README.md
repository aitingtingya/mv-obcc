# @mv-aide/mv-agent

mv-AIDE bridge plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, the `dsh` CLI). It connects a DSH agent to the **mv-AIDE Obsidian IDE bridge** — mv-AIDE's own WebSocket JSON-RPC protocol (`initialize` / `tools/list` / `tools/call`) — so the agent can read and act on live Obsidian context.

## What it provides

- **`/mv-aide`** slash command:
  - `/mv-aide status` — connection state, current bridge, and tool count for this session.
  - `/mv-aide bridges` — list every discovered mv-AIDE IDE bridge (port + vault folders), marking the current/selected one.
  - `/mv-aide connect <序号|端口|路径|auto>` — manually choose which bridge this dsh session connects to (`auto` returns to automatic matching; no argument lists bridges).
  - `/mv-aide tools` — list the mv-AIDE IDE tools.
  - `/mv-aide selection` — call `getLatestSelection` and show the current selection.
  - `/mv-aide call <name> [json]` — call any bridge tool with JSON arguments.
- **`mv_aide__<tool>`** native tools, registered after connecting, e.g. `mv_aide__getLatestSelection`, `mv_aide__openFile`, `mv_aide__searchVaultSymbols`, `mv_aide__getBacklinks`.
- **Diff-as-permission hook** (see below): `write` / `edit` / `str_replace_editor` writes that need permission confirmation are reviewed as an Obsidian diff instead of the web approval card.
- **Vault workspace auto-enter**: on bridge connect the vault is made a DSH workspace, and (only when it has no session yet) a session is created with its cwd set to the vault root.

## Enhanced terminal awareness

The mv-agent setting **「终端感知增强」** is disabled by default and affects mv-agent / DSH only. When enabled, the normal IDE `getTerminalOutput` tool is removed from mv-agent's registered tool set and replaced by seven native mv-AIDE terminal tools: `mv_aide__listTerminals`, `mv_aide__readTerminal`, `mv_aide__sendTerminalInput`, `mv_aide__runInTerminal`, `mv_aide__openTerminal`, `mv_aide__focusTerminal`, and `mv_aide__closeTerminal`. They operate only on mv-AIDE's own integrated terminal views and can address the most recently active terminal by runtime id. `closeTerminal` always requires an explicit id and closes the Obsidian tab plus its owned PTY; it does not merely type `exit`.

`listTerminals` also covers dormant historical terminals: tabs restored by Obsidian after a restart stay deferred (background leaves are not loaded until first shown) and are reported with `deferred: true`. Addressing such a terminal by id (read/send/run/focus) wakes it automatically via `loadIfDeferred` and spawns a fresh shell. A read waits for the fresh prompt to be committed to xterm; it never restores the previous process or scrollback. `closeTerminal` can close a deferred tab without waking it. Runtime ids are scoped to one app run and may renumber after a restart.

`sendTerminalInput` is the byte-verbatim path for keystrokes, Ctrl+C, TUI/REPL input, and optional Enter submission; shell metacharacters retain their native meaning. `runInTerminal` is the reliable shell-command path: it always transports an encoded UTF-8 command into POSIX shells, fish, or PowerShell before evaluation (cmd.exe retains its native command path), preserving quotes, `!`, whitespace, Unicode, multiline commands, and state changes such as `cd`/`export`. Use `runInTerminal`, not `sendTerminalInput`, for shell commands that require reliable quoting.

When the setting is disabled, all seven enhanced terminal tools disappear and mv-agent returns to the bridge's original `mv_aide__getTerminalOutput` tool. Switching the setting refreshes tools live; it does not restart DSH, reconnect the bridge, or alter the public IDE `tools/list` seen by other clients. For outside-vault sessions, the enhanced terminal tools reuse the existing `getTerminalOutput` outside-tool policy toggle.

## Diff-as-permission hook

A `tools/execute` wrapper intercepts the file-writing tools at the moment DSH would demand permission:

- an **escalation retry** (`sandbox_permissions` + `justification`) — the `write`/`edit` permission-confirmation path, or
- a write the standing policy would **deny outright** (`read-only`, or `workspace-write` with a target outside the writable roots) — the case `str_replace_editor` hits, since that tool has no escalation seam.

Instead of the default web approval card, the change opens as an Obsidian diff through the bridge (`openDiff`):

- **Accept** → the approved (possibly hand-edited) contents are written to disk by this plugin, and a success result matching the tool's own output contract is returned. That write *is* the permission grant.
- **Reject** → a synthetic failure (`nothing was written`).
- **Bridge down / timeout (5 min) / unreadable file / adapter mismatch** → falls through to DSH's default flow unchanged.

Trigger gating:

- Never fires when the file policy is `danger-full-access` (no permission is ever demanded), for read-only tools, or when `str_replace_editor` runs `view`.
- **In-vault files always review.** Files **outside the Obsidian vault** review only when the mv-agent setting **「使用 Obsidian 审阅仓库外 diff」** is enabled (default off). The setting reaches the plugin through the bridge `initialize` result and live `mv_aide_settings_changed` notifications.
- `bash`/`pwsh` are not covered — they keep DSH's own confirmation.

Known limitations: the write bypasses DSH's sandbox bookkeeping (`fs/observed` is not emitted), so the observation policy may nudge the model to re-read the file after an accepted diff; the approval is not recorded in DSH's approval audit log.

## Passive context delivery

The bridge pushes id-less notifications, but selection changes are only used to maintain the latest pending snapshot. A snapshot is injected into the running agent's inbox when the user sends the next message (via the `agent/status` idle→running transition, with an inbox `nextTurn` backup trigger); page and selection changes do not stream context into an agent while it is working.

- `selection_changed` — updates the pending snapshot (`source: { kind: 'plugin', plugin: 'mv-aide-dsh' }` when eventually injected), capped at 6000 chars, debounced by 400 ms, exact-repeat deduplicated, and replaced by the latest state.
- `at_mentioned` — triggering mv-AIDE's "发送当前选中内容到 Claude Code" command **steers** the agent immediately, waking it to act on the mention (duplicate mentions within 5 s are dropped).

Delivery targets agents by their session `cwd` against the bridge's vault `workspaceFolders`:
**in-vault agents always receive everything**; agents running **outside the vault** only receive a channel when the mv-agent setting「库外项目工具策略」(settings → mv-agent → IDE 工具) opts that channel in (default: all off). Without vault-folder knowledge every agent receives it; when no agent is allowed the delivery is dropped (logged). Each agent receives its own freshly built message.

The same per-channel policy gates the **active tools** (`mv_aide__*`): an outside-vault agent calling a non-opted tool gets an error instead of a bridge call.

## How it connects

mv-AIDE exposes a local server on `127.0.0.1` (port `47000 + stablePortSeed(vaultRoot) % 1500`) and writes the authoritative discovery lock file to `~/.mv-aide/ide/<port>.lock` (`ideName: "Obsidian"`) carrying the WebSocket auth token. When Claude Code integration is enabled, an identical compatibility mirror is also written to `~/.claude/ide/<port>.lock` because Claude CLI only scans `$CLAUDE_CONFIG_DIR/ide`. This plugin scans only the unified `~/.mv-aide/ide` registry, connects with `x-claude-code-ide-authorization`, and speaks JSON-RPC. The header/lock-file naming reuses Claude Code's conventions so CC can also connect; the protocol itself is mv-AIDE's own.

The browser half subscribes to DSH's official `sessions.list.current` store and keeps a same-origin control WebSocket to the host half. A session may own an Obsidian bridge only while at least one live DSH frontend currently has that session open. Switching or closing the frontend revokes the old session before activating the next one; multiple frontends contribute the union of their currently open sessions. Host startup, persisted sessions, `agent/status`, commands, and tools cannot bypass this activity gate.

## Install (hot-load)

This is a dual-face host/browser plugin registered through the profile's **patch layer**. The host row hot-loads; after installing or changing its `dsh.client` metadata, restart DSH once so the browser module graph is rebuilt.

```sh
# 1. Install the package into the web profile's node_modules:
dsh plugin --profile web add "file:<absolute-path-to-mv-agent>"

# 2. Register the row in the profile's cordis.patch.yml:
#    $DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
- insert:
    - id: mv-agent
      name: '@mv-aide/mv-agent'
```

A running `dsh web` picks up the new row in about a second (the profile and home `cordis.patch.yml` are watched and hot-recomposed). Verify with:

```sh
dsh web --dump-config   # should list an `mv-agent` row
```

To uninstall: remove the insert block from `cordis.patch.yml` and remove the dependency (`dsh plugin --profile web remove @mv-aide/mv-agent`).

## Requirements

- Node 22.19+ within the Node 22 release line, or Node 24+ (the range declared by DeepSeek Harness is `^22.19.0 || >=24.0.0`; the DSH host runs in Node and the plugin uses `ws` for the custom WebSocket header).
- Obsidian running with the **mv-AIDE** plugin, and its IDE bridge active (enable Claude Code integration, or the `mv-agent` integration in the "已适配 agent" settings — either writes the discovery lock file).

## Configuration

The row accepts one optional field:

```yaml
- insert:
    - id: mv-agent
      name: '@mv-aide/mv-agent'
      config:
        workspace: '/absolute/path/to/vault'   # pin which vault's bridge to use (optional)
```

Bridge selection is persisted in the v3 `~/.mv-aide/dsh/bridge-selection.json` store with explicit per-session and per-workspace records. An opened session first reuses its own target. A new session then chooses the outermost Obsidian vault that equals or contains its DSH workspace, or falls back to the DSH workspace's last attempted target. Manual and automatic choices both become the session target and update the workspace target. When neither exists, no supervisor or retry loop is created.

## Reconnection

Only currently opened sessions own independent bridge connections. A selected target that is temporarily unavailable is re-scanned with exponential backoff (500 ms → 30 s) while that session remains open, and is never silently replaced by another vault. Closing or switching away from the session closes its bridge and cancels retry immediately. After a DSH restart the browser control channel reconnects and reports the restored current session, so only that opened session resumes its persisted target.
