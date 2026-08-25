# Third-party notices

The production bundle includes portions of the following MIT-licensed packages:

- `@codemirror/merge`
- `obsidian-latex-suite` 1.11.5 snippets and math-preview core code
- DeepSeek Harness plugin-settings card CSS and disclosure chevron glyph
- reduced source-highlight palettes derived from PrismJS / Prism themes CSS
- `valibot`
- `ws`
- `@xterm/xterm` / `@xterm/addon-fit` terminal runtime and scoped terminal CSS rules

Obsidian, `@codemirror/state`, and `@codemirror/view` are runtime externals and
are not bundled into `main.js`.

`obsidian-latex-suite` is MIT-licensed:

- Copyright (c) 2022 artisticat1
- Source: <https://github.com/artisticat1/obsidian-latex-suite>
- Full license text: `src/vendor/latex-suite/LICENSE.md`

DeepSeek Harness is MIT-licensed. Portions of the DSH plugin-settings card
styling and the disclosure chevron glyph are mirrored from the upstream DSH
client UI so injected mv-AIDE settings cards match the host settings surface.

- Copyright (c) 2026 DeepSeek
- Source: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

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
- Packages: `@xterm/xterm`, `@xterm/addon-fit`
