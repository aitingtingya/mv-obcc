# @mv-aide/dsh-plugin

mv-AIDE bridge plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH, the `dsh` CLI). It connects a DSH agent to the **mv-AIDE Obsidian IDE bridge** — mv-AIDE's own WebSocket JSON-RPC protocol (`initialize` / `tools/list` / `tools/call`) — so the agent can read and act on live Obsidian context.

## What it provides

- **`/mv-aide`** slash command:
  - `/mv-aide status` — connection state + tool count.
  - `/mv-aide tools` — list the mv-AIDE IDE tools.
  - `/mv-aide selection` — call `getLatestSelection` and show the current selection.
  - `/mv-aide call <name> [json]` — call any bridge tool with JSON arguments.
- **`mv_aide__<tool>`** native tools, registered after connecting, e.g. `mv_aide__getLatestSelection`, `mv_aide__openFile`, `mv_aide__searchVaultSymbols`, `mv_aide__getBacklinks`.
- **Diff-as-permission hook** (see below): `write` / `edit` / `str_replace_editor` writes that need permission confirmation are reviewed as an Obsidian diff instead of the web approval card.
- **Vault workspace auto-enter**: on bridge connect the vault is made a DSH workspace, and (only when it has no session yet) a session is created with its cwd set to the vault root.

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

The bridge pushes id-less notifications, and this plugin delivers them to the running agent's inbox without a tool call. Two delivery modes are selectable in the mv-agent settings (mv-AIDE → mv-agent → 被动推送, carried over the bridge):

- **`live` (default, 实时跟踪活动轨迹)** — every stable selection state is injected as it happens, debounced (400 ms), deduplicated (exact repeats are never re-injected), and **replaced in place** while still pending (`Inbox.replace`), so a growing selection costs one message instead of one per intermediate state. Pure cursor moves inside the already-reported file and text-less URL changes below the debounce window are skipped.
- **`on-send` (仅发送消息时推送一次)** — the selection is only buffered; a single snapshot is pushed at the moment the user sends a message (the agent's turn starts, via the `agent/status` idle→running transition with an inbox `nextTurn` backup trigger), and nothing is injected while the agent works. Explicit @mentions still steer.

Both modes:

- `selection_changed` — injected into the agent's inbox as context (`source: { kind: 'plugin', plugin: 'mv-aide-dsh' }`), capped at 6000 chars. Injections do not wake an idle agent; they are claimed at the next step.
- `at_mentioned` — triggering mv-AIDE's "发送当前选中内容到 Claude Code" command **steers** the agent, waking it to act on the mention (duplicate mentions within 5 s are dropped).

Delivery targets agents by their session `cwd` against the bridge's vault `workspaceFolders`:
**in-vault agents always receive everything**; agents running **outside the vault** only receive a channel when the mv-agent setting「库外项目工具策略」(settings → mv-agent → IDE 工具) opts that channel in (default: all off). Without vault-folder knowledge every agent receives it; when no agent is allowed the delivery is dropped (logged). Each agent receives its own freshly built message.

The same per-channel policy gates the **active tools** (`mv_aide__*`): an outside-vault agent calling a non-opted tool gets an error instead of a bridge call.

## How it connects

mv-AIDE exposes a local server on `127.0.0.1` (port `47000 + stablePortSeed(vaultRoot) % 1500`) and writes a discovery lock file to `~/.claude/ide/<port>.lock` (`ideName: "Obsidian"`) carrying the WebSocket auth token. This plugin scans those lock files, connects with `x-claude-code-ide-authorization`, and speaks JSON-RPC. The header/lock-file naming reuses Claude Code's conventions so CC can also connect; the protocol itself is mv-AIDE's own.

## Install (hot-load)

This is a plain plugin package (no `dsh.bundle` declaration), registered through the profile's **patch layer**, which DSH hot-watches — no restart required.

```sh
# 1. Install the package into the web profile's node_modules:
dsh plugin --profile web add "file:<absolute-path-to-dsh-plugin>"
#    (the "declares no dsh.bundle" warning is expected)

# 2. Register the row in the profile's cordis.patch.yml:
#    $DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
- insert:
    - id: mv-aide
      name: '@mv-aide/dsh-plugin'
```

A running `dsh web` picks up the new row in about a second (the profile and home `cordis.patch.yml` are watched and hot-recomposed). Verify with:

```sh
dsh web --dump-config   # should list a `mv-aide` row
```

To uninstall: remove the insert block from `cordis.patch.yml` and remove the dependency (`dsh plugin --profile web remove @mv-aide/dsh-plugin`).

## Requirements

- Node 22.19+ within the Node 22 release line, or Node 24+ (the range declared by DeepSeek Harness is `^22.19.0 || >=24.0.0`; the DSH host runs in Node and the plugin uses `ws` for the custom WebSocket header).
- Obsidian running with the **mv-AIDE** plugin, and its IDE bridge active (enable Claude Code integration, or the `mv-agent` integration in the "已适配 agent" settings — either writes the discovery lock file).

## Configuration

The row accepts one optional field:

```yaml
- insert:
    - id: mv-aide
      name: '@mv-aide/dsh-plugin'
      config:
        workspace: '/absolute/path/to/vault'   # pin which vault's bridge to use (optional)
```

Without `workspace`, the plugin matches the current working directory against each bridge's `workspaceFolders`, falling back to the first discovered bridge.

## Reconnection

The plugin re-scans the lock files with exponential backoff (500 ms → 30 s) and reconnects automatically when Obsidian restarts. Tools unregister while the bridge is down and re-register on reconnect.
