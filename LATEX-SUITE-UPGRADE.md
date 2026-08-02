# Latex Suite Upgrade Guide

This plugin vendors Latex Suite as a black-box core. Source Assist may route
profile data by file extension, but it must not reimplement Latex Suite snippet
execution, math context, keymaps, tabstops, or parser semantics.

## Upgrade Steps

1. Pick an official upstream tag from `artisticat1/obsidian-latex-suite`.
   Do not use an arbitrary downloaded source snapshot.
2. Clone that exact tag, for example:
   ```sh
   git clone --depth 1 --branch 1.11.5 https://github.com/artisticat1/obsidian-latex-suite.git /Users/gingerman/Downloads/obsidian-latex-suite-1.11.5
   ```
3. Replace `src/vendor/latex-suite/src` with the upstream tag's `src`
   directory as a whole.
4. Sync dependency versions needed by that tag, especially `valibot`,
   `js-base64`, CodeMirror, and Lezer packages.
5. Keep the esbuild external boundary aligned with upstream. CodeMirror and
   Lezer runtime packages used by Obsidian editor state should remain external.
6. Reapply the documented compatibility patches and the generic external math
   region input below. The generic input changes only where math bounds come
   from; snippet execution and replacement semantics remain upstream-owned.
7. Update `tests/latex-suite-vendor-integrity.test.ts` to compare against the
   exact upstream tag directory and to list only the patched files below.

## Hard Boundaries

- Do not edit files under `src/vendor/latex-suite/src` except for the
  documented compatibility patches and generic external math region input.
- Do not call or wrap `runSnippets`, `Context`, `mathBoundsPlugin`,
  `keyboardEventPlugin`, `handleUpdate`, `onInput`, `getKeymaps`,
  `latexSuiteConfig`, tabstop helpers, or snippet queue internals from Source
  Assist.
- Source Assist may instantiate the upstream plugin host and pass settings data
  for the active profile. The rest of the snippet behavior must run inside the
  vendored Latex Suite implementation.
- Source Assist may provide pre-analyzed math bounds through
  `externalMathRegionsFacet`. Latex Suite must consume those bounds as the
  highest-priority source for math mode, snippets, brackets, and tooltips; it
  must not import Source Assist or parse three-part format settings itself.
- TeX preview enhancements are separate from Latex Suite snippets and must be
  fail-closed: preview failure must never stop a file from opening.
- TeX preview enhancements must stay lazy. The initial Markdown editor
  extension may only install an empty bootstrap; scanner, decorations, widgets,
  tooltips, and `renderMath` must be enabled after the editor has opened. If
  the editor file extension is not available on the first frame, the bootstrap
  must retry briefly until the extension is stable. Any activation failure must
  disable preview for that editor session.

## Generic External Math Region Input

These semantic integration points are intentionally narrow and must be
reapplied after replacing the vendored source:

- `utils/context.ts`: define `externalMathRegionsFacet`, query it before syntax
  tree math bounds, and merge it with non-overlapping native bounds. External
  regions are authoritative; Latex Suite continues to own all context and
  snippet behavior after receiving their boundaries and mode.
- `editor_extensions/math_tooltip.ts`: initialize tooltip state when a dynamic
  editor profile is installed while the cursor is already inside an external
  math region. Tooltip rendering itself remains the upstream implementation.

The facet is generic. It contains only boundaries, inline/display mode, preview
source, and preview source offset. Vendor code must not import
`source-assist/tex-math` or read `n/j/nl/jl` settings.

## Obsidian Source-Check Compatibility Patches

These files are allowed to differ from upstream, and no other vendor file
should differ:

- `features/run_snippets.ts`: build the debug Notice with DOM APIs instead of
  assigning `innerHTML`.
- `settings/settings.ts`: keep the current Obsidian type compatibility update.
- `settings/settings_tab.ts`: use a CSS class instead of direct style
  assignment, and build trigger help text with DOM APIs.
- `settings/ui/suggest.ts`: replace explicit `any` casts with a local
  structural type for Obsidian private UI fields.
- `snippets/parse.ts`: replace explicit `any` helper types with `unknown`
  based function types. Keep the dynamic `import(module)` because Latex Suite
  snippets are trusted local JavaScript modules; add only a documented lint
  exception for that line.

## Required Checks

Run these before deploying:

```sh
npm run verify
npm test -- tests/latex-suite-vendor-integrity.test.ts tests/latex-suite-source-check.test.ts
rg 'runSnippets|Context|mathBounds|keyboardEventPlugin|handleUpdate|onInput|getKeymaps|latexSuiteConfig|snippetExtensions|setSelectionToNextTabstop' src/source-assist
npm run deploy:local
```

Manual validation:

- `.md` math snippets behave like official Latex Suite.
- Bare array snippets such as `[{ trigger: "a", replacement: "\\alpha", options: "m" }]` parse successfully.
- `.tex` opens as Markdown view even when it contains display math.
- `\(...\)` shows an inline Latex Suite-style preview.
- `\[...\]` and common display environments show display preview without hiding source.
