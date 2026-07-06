# Third-party notices

The production bundle includes portions of the following MIT-licensed packages:

- `@codemirror/merge`
- `obsidian-latex-suite` 1.11.5 snippets and math-preview core code
- reduced source-highlight palettes derived from PrismJS / Prism themes CSS
- `valibot`
- `ws`
- `xterm` / `@xterm/addon-fit` terminal runtime and scoped terminal CSS rules

Obsidian, `@codemirror/state`, and `@codemirror/view` are runtime externals and
are not bundled into `main.js`.

`obsidian-latex-suite` is MIT-licensed:

- Copyright (c) 2022 artisticat1
- Source: <https://github.com/artisticat1/obsidian-latex-suite>
- Full license text: `src/vendor/latex-suite/LICENSE.md`

Built-in source-highlight palettes are reduced token color palettes derived from
MIT-licensed Prism theme CSS:

- PrismJS core themes, Source: <https://github.com/PrismJS/prism>
- Prism themes, Source: <https://github.com/PrismJS/prism-themes>
- Dracula Prism, Source: <https://github.com/dracula/prism>

Only scoped token palette data is bundled; the plugin does not inject upstream
theme CSS globally.

The integrated terminal uses MIT-licensed xterm.js packages and scoped copies
of the official xterm CSS layer rules:

- xterm.js, Source: <https://github.com/xtermjs/xterm.js>
- Packages: `xterm`, `@xterm/addon-fit`
