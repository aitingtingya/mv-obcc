# @mv-aide/mv-dsh-manager

DSH runtime visual management plugin for plugins, skills, and subagents. It also hosts a **recursive slash-command field picker** for DSH commands.

## Recursive slash-command field picker

When a DSH user selects a slash command that has secondary fields (for example `/mv-aide`), this plugin can keep showing a popupSelect list for each nested level until a leaf is chosen, then execute the completed command line. Before each popup level the plugin writes the completed command text into the composer (`/mv-aide `, then `/mv-aide connect `, etc.) so the user always sees the command land before picking the next level.

It is implemented through DSH's official client extension point (`ctx.commandUi.decorate` + `popupSelect`), entirely inside this package:

- Host half: `lib/bridge-service.js` + `lib/index.js` serve
  - `GET /api/mv-aide/bridges` — display-safe bridge list from `~/.mv-aide/ide` (with `~/.claude/ide` compatibility fallback);
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
