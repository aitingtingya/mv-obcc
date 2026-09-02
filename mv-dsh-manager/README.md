# @mv-aide/mv-dsh-manager

DSH runtime integration for plugin, skill, subagent, model-capability, and Obsidian file-drop management. It also hosts a **recursive slash-command field picker** for DSH commands, **ArrowUp history recall**, and a **clipboard write fallback** for the mv-agent iframe.

## Model capability editor

The manager augments DSH 0.1.1's native model rows with the model-level fields already supported by `llm-pi-ai` but not rendered by the native editor:

- input modalities (`text` / `image`);
- disabled or provider-mapped reasoning levels (`off` through `max`);
- all currently declared model-level compatibility switches and typed `chatTemplateKwargs`;
- name and capacity overrides for built-in catalog models.

`lib/model-capabilities-service.js` is the host-side settings/LLM boundary. It exposes only the two local `/api/mv-aide/model-capabilities*` routes, validates a fixed model-field vocabulary, writes custom models without dropping unknown fields, and uses `modelOverrides` for built-in models. `lib/model-capabilities-client.js` owns the browser controls and attaches them to the native model disclosure through stable accessibility labels rather than CSS-module hashes.

Capability changes are staged behind DSH's native Save action. Native provider/model/credential changes commit first; after the editor closes, the client reads a fresh revision and applies all capability changes in one settings mutation. A native failure or cancel writes nothing, while a failed second stage keeps a retryable draft and reports the partial save explicitly.

## Obsidian file-drop receiver

`lib/file-drop-client.js` is the isolated DSH-side half of mv-agent file drops. The Obsidian host resolves and validates native paths; this module accepts only an authenticated, per-iframe `postMessage` channel and uses DSH's current session APIs to:

- append regular files as native structured `@file` references, using a workspace-relative path when possible and an absolute path otherwise;
- append dropped folders as native directory references following the upstream `@path/` grammar (`@"path with spaces/` keeps the quote open), rendered with the folder chip appearance;
- register PNG, JPEG, WebP, and GIF bytes in DSH's native draft-image store;
- enforce the current session's input phase, block state, and projected image limits;
- commit mixed batches atomically and restore the original draft plus image IDs on failure.

The module never submits the composer, copies regular-file contents, exposes a path-reading HTTP route, or modifies the source file. The main manager client only invokes its `apply()` lifecycle hook; the settings, plugin, skill, preset, model-capability, plan-review, and slash-picker modules remain independent.

## History recall

`lib/history-recall-client.js` installs an ArrowUp/ArrowDown listener that recalls previously sent messages in the DSH composer. Pressing `↑` in an empty, focused composer first prefills the newest message from the visible conversation projection, then fetches the complete session history through `POST /api/mv-aide/history-recall` served by `lib/history-recall-service.js` and replaces the preview without expanding the visible chat pagination. `↓` walks forward; one more `↓` at the newest message restores the anchored draft and exits recall mode.

The service route is same-origin only (`isSameOriginBrowserRequest`) and reads through `@mv-aide/mv-dsh-compat`'s session inspector (zero-copy for live sessions) with a replay-validated `readSession` fallback. A runtime exposing neither seam answers 503, and the client treats that as fail closed: recall keeps the visible-message range, reports no error, and never mutates pagination.

Trigger guards: the feature policy (`historyRecallEnabled`), IME composition, open command/picker menus, non-empty drafts on `↑` (native caret movement is preserved), composer focus, and a current session. Session switches clear other sessions' recall state.

## Clipboard fallback

`lib/clipboard-client.js` keeps the DSH page on `navigator.clipboard` directly. Only a denied write (`NotAllowedError`) is delegated over the per-view authenticated, generation-rotated `postMessage` channel to the Obsidian host (`src/agent-integrations/dsh/runtime/clipboard-host.ts`), which completes the plain-text write through Electron's `clipboard.writeText`. The channel rides a transferred MessagePort for its full request/reply lifecycle, so moving the iframe between Obsidian windows does not change its identity. Only plain text is delegated; the clipboard is never read, and failures return real errors.

## Feature settings

`lib/feature-settings.js` registers the `mv-dsh-manager` Host settings namespace with a Schemastery schema of nine fields: `pluginManagementUiEnabled`, `skillManagementUiEnabled`, `presetManagementUiEnabled`, `modelCapabilitiesUiEnabled`, `fileDropEnabled`, `recursiveCommandPickerEnabled`, `planReviewEnhancementEnabled`, `historyRecallEnabled` (all booleans, default `true`), and `commandPickerMaxLeaves` (10–200, default 50). Values apply live; out-of-range or wrong-typed writes are rejected without publishing. When the settings service or browser slot is unavailable, every module keeps running with these defaults.

## Recursive slash-command field picker

When a DSH user selects a slash command that has secondary fields (for example `/mv-aide`), this plugin can keep showing a popupSelect list for each nested level until a leaf is chosen, then execute the completed command line. Before each popup level the plugin writes the completed command text into the composer (`/mv-aide `, then `/mv-aide connect `, etc.) so the user always sees the command land before picking the next level.

It is implemented through DSH's official client extension point (`ctx.commandUi.decorate` + `popupSelect`), entirely inside this package:

- Host half: `lib/bridge-service.js` + `lib/index.js` serve
  - `GET /api/mv-aide/bridges` — display-safe bridge list from the canonical `~/.mv-aide/ide` registry;
  - `GET /api/mv-aide/tools` — public mv-AIDE IDE tools for the `call` submenu.
- Browser half: `lib/client.js` is a self-contained DSH client bundle (prebuilt `window.__ModuleLoader__` format) that:
  - registers a declarative command tree via `registerCommandTree(name, root)`;
  - decorates the host command `/mv-aide`;
  - completes the composer draft through the session's `conversation.input` facade before each popup level;
  - recursively opens `connect …` → bridge list and `call …` → tool list;
  - executes leaf options through `ctx.remote.commands.execute` (requires the official dotted `remote.commands` inject);
  - handles Escape by picker level: at the first level it cancels back to the original draft and caret (matching DSH's first-level menu); at deeper levels it keeps the already-confirmed command line and only returns focus/caret to the composer;
  - surfaces its own errors in Chinese (DSH/host-internal error text is passed through unchanged).

### Built-in `/mv-aide` tree

- `status` / `tools` / `bridges` / `selection` — direct leaves.
- `connect …` — `connect auto` plus one option per discovered IDE bridge (`connect <port>`).
- `call …` — one option per public mv-AIDE IDE tool (`call <name>`).

Manual typing still works: `/mv-aide connect <port>`, `/mv-aide call <name> [json]`, etc.

### DSH-level hint auto-picker

The picker is a DSH-level feature: it scans the current session's command directory and automatically decorates every host command whose `input.hint` describes an enumerable leaf set. This means third-party commands do **not** need a special mv-aide hardcode; they only need to express their choices in the hint grammar.

Supported hint grammar (small subset):

- `[a|b]` — optional group with alternatives
- `a|b` — top-level or in-group alternation
- `<name>` — free-text placeholder (never expanded; the picker leaves it to manual typing)
- `<a|b>` — finite-choice placeholder (expanded to `a` / `b`)
- `--flag [<value>]` — optional flag; unresolved `<value>` is not expanded

Example:

```text
[status | on <pro|flash> [--text <s>] | off <pro|flash>] [--preset <id>]
```

becomes a nested picker: first `status` / `on` / `off`, then `on` and `off` open `pro` / `flash`. Enumerable multi-token hints are grouped by their shared token prefix; commands with only free-text hints (for example `<text>` or `text to echo`) keep DSH's default input behavior.

DSH writes some free-text slots as bare words inside hints — `/plan` is `[off|message]`, where `message` means "any message", not a fixed choice. The parser drops the verified bare-word slot `message`, so `/plan` shows only the real leaf `off`; manually typing `/plan <anything>` still uses DSH's default free-form input and can never send a literal `message`. Other slot names (`text`, `objective`, `preset`, …) appear inside `<...>` and are already left unexpanded, so no word list is maintained for them.

### Adding a tree for another command

The picker engine also remains generic for explicit trees. A future client module (or a follow-up version) can call:

```js
registerCommandTree('goal', {
  fields: [
    { key: 'list', label: 'list', line: '/goal list' },
    { key: 'create', label: 'create …', children: 'bridges' },
  ],
});
decorateCommand(ctx, 'goal');
```

`lib/client.js` exports `registerCommandTree`, `decorateCommand`, `syncHintDecorations`, and `parseHintFields` for programmatic use. DSH's own commands only expose `input.hint` text today, so explicit nested dynamic fields still need to be supplied; the hint auto-picker covers finite enumerable leaves without per-command code.

## Development

Tests run with Node's built-in test runner:

```sh
node --test test/*.test.js
```
