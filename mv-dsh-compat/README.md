# @mv-aide/mv-dsh-compat

Pure compatibility boundary shared by mv-AIDE's Obsidian host and its managed DeepSeek Harness (DSH) plugins: `@mv-aide/mv-agent`, `@mv-aide/mv-dsh-manager`, and `@mv-aide/mv-dsh-subworkspace`. It exists so that version-specific DSH Host/Client object shapes (textarea/Lexical composers, pending interactions, preset openers, settings/slots/session/workspace surfaces) are interpreted in exactly one place instead of four.

## Invariants

- No Cordis entry, no patch row, no settings card, no independent runtime state, and no LLM context injection — it is a library, not a fourth DSH plugin. Its integrity is folded into the diagnostics of the plugins that depend on it.
- No import side effects; every export is a pure resolver. Process-wide state that several plugins must share belongs in a separate library; this one is deliberately stateless, and `@mv-aide/mv-dsh-settings` exists for that reason.
- Owns no `DSH_HOME` path knowledge and never depends on Obsidian `src/**` modules. Bridge packages and the Obsidian host pass their own contexts in. Its one path authority is `lib/paths.js`, which owns the user-level `~/.mv-aide/dsh/settings.json` location; `@mv-aide/mv-dsh-settings` reads it from here rather than spelling it again (规范三).
- Zero runtime dependencies; third-party adapters (`@dsh-std/*`, `tui.dsh/*`, `dsh-ecosystem-spec`) are forbidden as production or source dependencies.

## Preview-first resolution

DSH `0.2.0-rc.2` (preview) is the first-priority compatibility baseline. Every resolver probes structure first and picks a released face in order, never by version number — for example `resolvePresetOpener` returns the ≤0.1.6 directory adapter when `settingsController.openAgentPresetDirectory` exists, otherwise the ≥0.1.7 document adapter built on `openTextFile`, and `null` when neither is present. Version numbers are used only for diagnostics, source evidence, and the acceptance matrix. A missing or unknown interface resolves to `null`/`undefined` so the caller can fail closed by disabling only that enhancement.

## Exports

- `@mv-aide/mv-dsh-compat/contracts` — runtime-family and capability constants plus `identifyDshRuntimeFamily` / `createCompatibilityReport` / `requireCapabilities` helpers for diagnostics.
- `@mv-aide/mv-dsh-compat/host` — Host-side resolvers: host settings/tools surfaces, session log reader and session inspector, preset opener and agent presets, model settings.
- `@mv-aide/mv-dsh-compat/client` — Browser-side resolvers: settings-card host, sessions and conversation, composer input, image encoder, pending plan review, chat projection, current session id, workspace client.
- `@mv-aide/mv-dsh-compat/obsidian` — the small subset used by the Obsidian-side runtime, including the `dsh web` launch-flag probe (`dshWebSupportsNoOpen`, first shipped in dsh v0.1.0-rc.8; earlier web profiles never open a browser, so omission there is equivalent).

## Test matrix

`tests/fixtures/dsh-compat-matrix.json` pins the acceptance matrix — preview `0.2.0-rc.2` with its exact tag and source commit, plus the historical alpha `0.1.6-alpha.1` row kept as source evidence. `npm run test:dsh-preview` from the repository root is the release gate: it verifies the preview row against the repository manifest and the installed `@deepseek-ai/dsh`, then runs the package and end-to-end suites. Alpha compatibility is no longer extended or tested (`npm run test:dsh-alpha` is historical and is not part of the release flow). Adding a DSH version means extending that matrix with precise source evidence, never guessing at unknown interfaces.
