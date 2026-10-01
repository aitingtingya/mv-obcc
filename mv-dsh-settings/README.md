# @mv-aide/mv-dsh-settings

The plugin-owned settings store shared by mv-AIDE's three managed DeepSeek
Harness (DSH) plugins: `@mv-aide/mv-agent`, `@mv-aide/mv-dsh-manager`, and
`@mv-aide/mv-dsh-subworkspace`.

Releases up to DSH `0.1.6` exposed `ctx.settings.register(namespace, schema, …)`
— a live, schema-validated settings scope. `0.1.7` replaced that plane with
schema-derived plugin configuration forms, and the mv-AIDE feature switches can
no longer ride on it. This library is their single source of truth on every
release: one user-level document, one namespace per plugin:

```
~/.mv-aide/dsh/settings.json
{ "schema": 1, "namespaces": { "mv-agent": { … }, … } }
```

## Why this is its own package

The three plugins all mount inside one DSH process and must agree on **one**
document, **one** write queue, and **one** live namespace registry — a write
made through mv-dsh-manager's HTTP route has to reach the plugin that owns the
namespace, and two namespaces writing the same file must not lose each other's
update. That requires module-level state shared across the three, which is
exactly what `DEVELOPMENT-GUIDELINES` 规范十一.3 forbids the pure compatibility
library `@mv-aide/mv-dsh-compat` to own. The store therefore lives here, and
compat stays a stateless resolver library.

## Invariants

- No Cordis entry, no patch row, no settings card, and no LLM context injection
  — it is a library, not a fourth DSH plugin. It is materialized into the DSH
  profile as a sibling of `@mv-aide/mv-dsh-compat` and its integrity is folded
  into the diagnostics of the plugins that depend on it (规范十.4).
- Owns no path literal. The `~/.mv-aide/dsh/settings.json` authority stays in
  `mv-dsh-compat/lib/paths.js` and is imported from there (规范三:60), which
  `check:vault-storage` enforces.
- Zero runtime dependencies; third-party DSH adapters are forbidden.

## Document durability

- Directory `0700` (tightened even when an earlier version created it wider),
  file `0600`.
- Writes are temporary-file + rename, and keep exactly one `settings.json.bak`.
  The backup is a copy rather than a rename on purpose: renaming the live file
  away first would leave readers seeing `ENOENT` and falling back to defaults.
- One deterministic temporary name (`settings.json.tmp`), never a pid-suffixed
  one — every writer goes through the queue, so a crash can orphan at most that
  single file instead of accumulating one per attempt.
- Invalid JSON is quarantined as `settings.json.corrupt-<timestamp>` and the
  plugins continue on their defaults. If the quarantine rename itself fails it
  is reported through the log rather than swallowed, so the next write cannot
  silently overwrite the only copy.
- Every writer goes through `writeSettingsDocumentQueued`, a serialized
  read-modify-write. Calling `writeSettingsDocument` after reading the document
  yourself would sit outside the queue and could lose a concurrent namespace's
  update.

## Exports

- `@mv-aide/mv-dsh-settings/store` — `createSettingsScope`,
  `readSettingsDocument`, `writeSettingsDocument`,
  `writeSettingsDocumentQueued`, `subscribeSettingsNamespace`,
  `registeredSettingsScopes`, `settingsScopeFor`, `SETTINGS_FILE_SCHEMA`, and
  the re-exported `mvAideSettingsFile`.

## Test matrix

`npm --prefix mv-dsh-settings test` runs the package's own `node --test` suite;
`npm run test:packages` chains it with the other managed packages, and
`npm run test:dsh-preview` is the release gate that runs everything against the
pinned preview DSH.
