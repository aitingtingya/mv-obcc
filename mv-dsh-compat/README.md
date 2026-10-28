# @mv-aide/mv-dsh-compat

Pure compatibility boundary shared by mv-AIDE's Obsidian host and its managed DeepSeek Harness (DSH) plugins: `@mv-aide/mv-agent`, `@mv-aide/mv-dsh-manager`, and `@mv-aide/mv-dsh-subworkspace`. It exists so that version-specific DSH Host/Client object shapes (textarea/Lexical composers, pending interactions, preset openers, settings/slots/session/workspace surfaces) are interpreted in exactly one place instead of four.

## Invariants

- No Cordis entry, no patch row, no settings card, no independent runtime state, and no LLM context injection — it is a library, not a fourth DSH plugin. Its integrity is folded into the diagnostics of the plugins that depend on it.
- No import side effects or independently owned state. Resolvers and explicitly installed adapters receive their contexts from the owning module; service observers return cleanup functions. Process-wide settings state belongs in `@mv-aide/mv-dsh-settings`, not this library.
- Owns no `DSH_HOME` path knowledge and never depends on Obsidian `src/**` modules. Bridge packages and the Obsidian host pass their own contexts in. Its one path authority is `lib/paths.js`, which owns the user-level `~/.mv-aide/dsh/settings.json` location; `@mv-aide/mv-dsh-settings` reads it from here rather than spelling it again (规范三).
- Zero runtime dependencies; third-party adapters (`@dsh-std/*`, `tui.dsh/*`, `dsh-ecosystem-spec`) are forbidden as production or source dependencies.

## Preview-first resolution

DSH `0.2.1-rc.2` is the primary preview baseline; `0.2.0-rc.2` remains in regression coverage. Resolvers select verified object capabilities, never a version-number branch. The host directory adapter uses native `workingDirectory.ensure` and filesystem resolution when present. The client adapter owns native model-row structure and semantic composer operations (`caretSpan`, local insertion, `draftSnapshot` restoration), preserving the older paths when those capabilities are absent. Version numbers identify source evidence and acceptance runtimes, not production behavior.

## Exports

- `@mv-aide/mv-dsh-compat/contracts` — runtime-family and capability constants plus `identifyDshRuntimeFamily` / `createCompatibilityReport` / `requireCapabilities` helpers for diagnostics.
- `@mv-aide/mv-dsh-compat/host` — Host-side resolvers: host settings/tools surfaces, session log reader and session inspector, preset opener and agent presets, model settings.
- `@mv-aide/mv-dsh-compat/client` — Browser-side resolvers: settings-card host, sessions and conversation, composer input, image encoder, pending plan review, chat projection, current session id, workspace client.
- `@mv-aide/mv-dsh-compat/obsidian` — the small subset used by the Obsidian-side runtime, including the `dsh web` launch-flag probe (`dshWebSupportsNoOpen`, first shipped in dsh v0.1.0-rc.8; earlier web profiles never open a browser, so omission there is equivalent).

## Test matrix

`tests/fixtures/dsh-compat-matrix.json` pins exact versions, tags and commits for `preview` (`0.2.1-rc.2`) and `previousPreview` (`0.2.0-rc.2`); the alpha row is historical evidence only. `npm run test:dsh-preview` validates the unchanged official vendor checkout and both runtime packages, then runs both versions' package and real DSH/browser acceptance suites concurrently. Set `MV_DSH_PREVIEW_ROOT` and `MV_DSH_PREVIOUS_PREVIEW_ROOT` to isolated package directories; otherwise it uses the global primary package and installs the pinned previous package in a temporary directory. It never replaces the user's global DSH. Alpha compatibility is not extended or included in release gates.
