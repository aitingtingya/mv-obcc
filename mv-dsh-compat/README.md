# @mv-aide/mv-dsh-compat

Pure compatibility boundary shared by mv-AIDE's Obsidian host and its managed DeepSeek Harness (DSH) plugins: `@mv-aide/mv-agent`, `@mv-aide/mv-dsh-manager`, and `@mv-aide/mv-dsh-subworkspace`. It exists so that version-specific DSH Host/Client object shapes (textarea/Lexical composers, pending interactions, preset openers, settings/slots/session/workspace surfaces) are interpreted in exactly one place instead of four.

## Invariants

- No Cordis entry, no patch row, no settings card, no independent runtime state, and no LLM context injection — it is a library, not a fourth DSH plugin. Its integrity is folded into the diagnostics of the plugins that depend on it.
- No import side effects; every export is a pure resolver.
- Owns no `DSH_HOME` path knowledge and never depends on Obsidian `src/**` modules. Bridge packages and the Obsidian host pass their own contexts in.
- Zero runtime dependencies; third-party adapters (`@dsh-std/*`, `tui.dsh/*`, `dsh-ecosystem-spec`) are forbidden as production or source dependencies.

## Preview-first resolution

DSH `0.1.1-rc.2` (preview) is the first-priority compatibility baseline. Every resolver probes structure first — the preview face is checked before any Alpha-only face (for example `resolvePresetOpener` returns `previewPresetOpener(ctx) ?? alphaPresetOpener(ctx)`). Version numbers are never used to decide whether an API can be called; they are used only for diagnostics, source evidence, and the acceptance matrix. A missing or unknown interface resolves to `null`/`undefined` so the caller can fail closed by disabling only that enhancement.

## Exports

- `@mv-aide/mv-dsh-compat/contracts` — runtime-family and capability constants plus `identifyDshRuntimeFamily` / `createCompatibilityReport` / `requireCapabilities` helpers for diagnostics.
- `@mv-aide/mv-dsh-compat/host` — Host-side resolvers: host settings/tools surfaces, session log reader and session inspector, preset opener and agent presets, model settings.
- `@mv-aide/mv-dsh-compat/client` — Browser-side resolvers: settings-card host, sessions and conversation, composer input, image encoder, pending plan review, chat projection, current session id, workspace client.
- `@mv-aide/mv-dsh-compat/obsidian` — the small subset used by the Obsidian-side runtime.

## Test matrix

`tests/fixtures/dsh-compat-matrix.json` pins the dual acceptance matrix — preview `0.1.1-rc.2` and alpha `0.1.2-alpha.3` with exact source commits — enforced by `npm run test:dsh-alpha` from the repository root. Adding a DSH version means extending that matrix with precise source evidence, never guessing at unknown interfaces.
