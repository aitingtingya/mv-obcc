import {
  Facet,
  type Extension,
  StateField,
  type EditorState,
} from "@codemirror/state";
import { encode } from "js-base64";

export type TexMathFormatOption = "n" | "j" | "nl" | "jl";

interface TexMathRegionBase {
  inner_start: number;
  inner_end: number;
  outer_start: number;
  outer_end: number;
  display: boolean;
  renderSource: string;
  renderSourceFrom: number;
  renderSourceTo: number;
}

export type TexMathRegion = TexMathRegionBase &
  (
    | {
        origin: "configured";
        format: TexMathFormatOption;
        kind:
          | "custom-inline-delimiter"
          | "custom-inline-environment"
          | "custom-display-delimiter"
          | "custom-display-environment";
      }
    | {
        origin: "native-dollar";
        format: "native-inline" | "native-display";
        kind: "native-inline-dollar" | "native-display-dollar";
      }
  );

type ConfiguredTexMathRegionKind = Extract<
  TexMathRegion,
  { origin: "configured" }
>["kind"];

export type ConfiguredTexMathRegion = Extract<
  TexMathRegion,
  { origin: "configured" }
>;

export type SourceAssistMathBound = TexMathRegion;

export const TEX_DISPLAY_ENVIRONMENTS = new Set([
  "align",
  "aligned",
  "alignat",
  "cases",
  "displaymath",
  "equation",
  "eqnarray",
  "flalign",
  "gather",
  "math",
  "multline",
  "split",
]);

interface BuiltInTexMathFormat {
  open: string;
  close: string;
  options: TexMathFormatOption;
}

/**
 * Factory preset for the settings panel's math formats. These entries only
 * pre-fill the default value of the settings box — at runtime the settings
 * text is the single source of truth, and deleting an entry there disables
 * that configured format. `$...$` and `$$...$$` are deliberately absent:
 * they are fixed native formats rather than user-configurable formats.
 */
const BUILT_IN_TEX_MATH_FORMATS: BuiltInTexMathFormat[] = [
  { open: "\\(", close: "\\)", options: "n" },
  { open: "\\[", close: "\\]", options: "j" },
  ...[...TEX_DISPLAY_ENVIRONMENTS].map((name) => ({
    open: `\\begin{${name}}`,
    close: `\\end{${name}}`,
    options: "jl" as const,
  })),
];

/** Escapes a TeX delimiter into its JS-string form for the settings box. */
function texMathFormatSettingString(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

/**
 * Built-in math formats as { 开头, 结尾, 设置 } entry lines (latex suite
 * style, comma-separated), used to pre-fill the settings default value.
 */
export function texMathBuiltInFormatExamples(): string[] {
  return BUILT_IN_TEX_MATH_FORMATS.map(
    (format) =>
      `{ 开头: "${texMathFormatSettingString(format.open)}", 结尾: "${texMathFormatSettingString(format.close)}", 设置: "${format.options}" },`,
  );
}

/**
 * Default text for the settings panel's custom math formats box: the
 * built-in formats as real entries users can freely edit or delete.
 */
export function texMathFormatsDefaultValue(): string {
  return ["export default [", ...texMathBuiltInFormatExamples(), "]"].join(
    "\n",
  );
}

/**
 * The built-in formats as a parsed config, derived from the same data as
 * texMathFormatsDefaultValue(). Runtime scanning is driven solely by the
 * settings text; this exists for tests and default injection.
 */
export function defaultTexMathConfig(): TexMathCustomConfig {
  const inline: TexMathDelimiterPair[] = [];
  const display: TexMathDelimiterPair[] = [];
  for (const format of BUILT_IN_TEX_MATH_FORMATS) {
    const pair: TexMathDelimiterPair = {
      open: format.open,
      close: format.close,
    };
    if (format.options.includes("l")) pair.environment = true;
    if (format.options.includes("j")) display.push(pair);
    else inline.push(pair);
  }
  return { inline, display };
}

export interface TexMathDelimiterPair {
  /** Opening delimiter, e.g. "$", "\\[", "\\begin{aligned}". */
  open: string;
  /** Closing delimiter, e.g. "$", "\\]", "\\end{aligned}". */
  close: string;
  /**
   * Environment format ("l" in the options): render the full
   * `\begin{...}...\end{...}` instead of only the inner content.
   */
  environment?: boolean;
}

/**
 * True for bounds whose rendering source is the full `\begin{...}...\end{...}`
 * (outer region) rather than only the inner content between delimiters.
 */
export function isTexEnvironmentKind(kind: SourceAssistMathBound["kind"]): boolean {
  return (
    kind === "custom-inline-environment" ||
    kind === "custom-display-environment"
  );
}

export interface TexMathCustomConfig {
  /** Configured inline (行内) delimiter pairs. */
  inline: TexMathDelimiterPair[];
  /** Configured display (行间) delimiter pairs. */
  display: TexMathDelimiterPair[];
}

export const EMPTY_TEX_MATH_CUSTOM_CONFIG: TexMathCustomConfig = {
  inline: [],
  display: [],
};

const texMathConfigFacet = Facet.define<
  TexMathCustomConfig,
  TexMathCustomConfig
>({
  combine: (values) => values[0] ?? EMPTY_TEX_MATH_CUSTOM_CONFIG,
});

export const texMathConfigField = StateField.define<TexMathCustomConfig>({
  create: (state) => state.facet(texMathConfigFacet),
  update: (config, transaction) =>
    transaction.reconfigured
      ? transaction.state.facet(texMathConfigFacet)
      : config,
});

export const texMathRegionsField = StateField.define<readonly TexMathRegion[]>({
  create: (state) =>
    analyzeTexMathSource(
      state.doc.toString(),
      state.field(texMathConfigField, false) ?? EMPTY_TEX_MATH_CUSTOM_CONFIG,
    ),
  update: (regions, transaction) => {
    const config =
      transaction.state.field(texMathConfigField, false) ??
      EMPTY_TEX_MATH_CUSTOM_CONFIG;
    const previousConfig =
      transaction.startState.field(texMathConfigField, false) ??
      EMPTY_TEX_MATH_CUSTOM_CONFIG;
    return transaction.docChanged || config !== previousConfig
      ? analyzeTexMathSource(transaction.newDoc.toString(), config)
      : regions;
  },
});

export function texMathAnalysisExtension(
  config: TexMathCustomConfig,
): Extension {
  return [
    texMathConfigFacet.of(config),
    texMathConfigField,
    texMathRegionsField,
  ];
}

export function texMathRegions(state: EditorState): readonly TexMathRegion[] {
  return (
    state.field(texMathRegionsField, false) ??
    analyzeTexMathSource(
      state.doc.toString(),
      state.field(texMathConfigField, false) ?? EMPTY_TEX_MATH_CUSTOM_CONFIG,
    )
  );
}

export function texMathBounds(state: EditorState): SourceAssistMathBound[] {
  return [...texMathRegions(state)];
}

export function texMathBoundAt(
  state: EditorState,
  pos: number,
): SourceAssistMathBound | null {
  return (
    texMathRegions(state).find(
      (bound) => pos >= bound.inner_start && pos <= bound.inner_end,
    ) ?? null
  );
}

/**
 * Parses the settings text for custom math formats. Reuses the same JS-array
 * shape as the snippets editor, with the three fields renamed:
 * `{ 开头, 结尾, 设置 }` where 设置 is "n" (inline) or "j" (display).
 *
 * @throws a descriptive string on invalid input, for the settings validator.
 */
export async function parseTexMathFormats(
  text: string,
): Promise<TexMathCustomConfig> {
  let raw: unknown;
  try {
    raw = await importTexMathFormats(text);
  } catch {
    throw "自定义数学格式需要是 export default [...] 数组";
  }
  if (!Array.isArray(raw)) {
    throw "自定义数学格式需要是 export default [...] 数组";
  }
  const inline: TexMathDelimiterPair[] = [];
  const display: TexMathDelimiterPair[] = [];
  const seenOpenings = new Map<string, string>();
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const open = typeof item["开头"] === "string" ? item["开头"].trim() : "";
    const close = typeof item["结尾"] === "string" ? item["结尾"].trim() : "";
    const options =
      typeof item["设置"] === "string" ? item["设置"].trim() : "";
    if (!open || !close) {
      throw `第 ${index + 1} 项缺少「开头」或「结尾」`;
    }
    if (!isTexMathFormatOption(options)) {
      throw `第 ${index + 1} 项的「设置」必须是 n（行内）、j（行间）、nl（行内环境）或 jl（行间环境）`;
    }
    const semanticKey = `${close}\u0000${options}`;
    const previous = seenOpenings.get(open);
    if (previous !== undefined) {
      if (previous === semanticKey) return;
      throw `第 ${index + 1} 项的「开头」与前面的条目冲突`;
    }
    seenOpenings.set(open, semanticKey);

    const pair: TexMathDelimiterPair = { open, close };
    if (options.includes("l")) pair.environment = true;
    if (options.startsWith("j")) display.push(pair);
    else inline.push(pair);
  });
  return { inline, display };
}

function isTexMathFormatOption(value: string): value is TexMathFormatOption {
  return value === "n" || value === "j" || value === "nl" || value === "jl";
}

async function importTexMathFormats(maybeJavaScriptCode: string): Promise<unknown> {
  try {
    try {
      return await importModuleDefault(
        `data:text/javascript;base64,${encode(maybeJavaScriptCode)}`,
      );
    } catch {
      return await importModuleDefault(
        `data:text/javascript;base64,${encode(
          `export default ${maybeJavaScriptCode}`,
        )}`,
      );
    }
  } catch {
    throw "Invalid format";
  }
}

async function importModuleDefault(module: string): Promise<unknown> {
  let data: { default?: unknown };
  try {
    data = await import(module);
  } catch {
    throw `failed to import module ${module}`;
  }
  if (!("default" in data)) {
    throw `No default export provided for module ${module}`;
  }
  return data.default;
}

interface TexMathFormatSpecBase {
  open: string;
  close: string;
  display: boolean;
  includeDelimiters: boolean;
  closeOnSameLine: boolean;
}

type TexMathFormatSpec = TexMathFormatSpecBase &
  (
    | {
        origin: "configured";
        format: TexMathFormatOption;
        kind: ConfiguredTexMathRegionKind;
      }
    | {
        origin: "native-dollar";
        format: "native-inline" | "native-display";
        kind: "native-inline-dollar" | "native-display-dollar";
      }
  );

interface TexMathOpening {
  at: number;
  format: TexMathFormatSpec;
}

export function analyzeTexMathSource(
  source: string,
  config: TexMathCustomConfig,
): readonly TexMathRegion[] {
  const formats = texMathFormatSpecs(config);
  if (source.length === 0) return [];

  const masked = maskTexComments(source);
  const regions: TexMathRegion[] = [];
  let cursor = 0;

  while (cursor < masked.length) {
    const opening = findNextOpening(masked, formats, cursor);
    if (!opening) break;

    const { at: outerStart, format } = opening;
    const innerStart = outerStart + format.open.length;
    const closeAt = findDelimiter(
      masked,
      format.close,
      innerStart,
      format,
      format.closeOnSameLine,
    );
    if (closeAt === -1) {
      cursor =
        format.origin === "native-dollar"
          ? outerStart + format.open.length
          : outerStart + 1;
      continue;
    }

    if (format.open !== format.close) {
      const repeatedOpen = findDelimiter(
        masked,
        format.open,
        innerStart,
        format,
      );
      if (repeatedOpen !== -1 && repeatedOpen < closeAt) {
        cursor = repeatedOpen;
        continue;
      }
    }

    const outerEnd = closeAt + format.close.length;
    if (innerStart < closeAt) {
      const renderSourceFrom = format.includeDelimiters
        ? outerStart
        : innerStart;
      const renderSourceTo = format.includeDelimiters ? outerEnd : closeAt;
      const regionBase: TexMathRegionBase = {
        inner_start: innerStart,
        inner_end: closeAt,
        outer_start: outerStart,
        outer_end: outerEnd,
        display: format.display,
        renderSource: source.slice(renderSourceFrom, renderSourceTo),
        renderSourceFrom,
        renderSourceTo,
      };
      if (format.origin === "configured") {
        regions.push({
          ...regionBase,
          origin: format.origin,
          format: format.format,
          kind: format.kind,
        });
      } else {
        regions.push({
          ...regionBase,
          origin: format.origin,
          format: format.format,
          kind: format.kind,
        });
      }
    }
    cursor = outerEnd;
  }

  assertTexMathRegions(regions);
  return regions;
}

function texMathFormatSpecs(
  config: TexMathCustomConfig,
): TexMathFormatSpec[] {
  const specs: TexMathFormatSpec[] = [
    {
      open: "$$",
      close: "$$",
      display: true,
      includeDelimiters: false,
      origin: "native-dollar",
      format: "native-display",
      kind: "native-display-dollar",
      closeOnSameLine: false,
    },
    {
      open: "$",
      close: "$",
      display: false,
      includeDelimiters: false,
      origin: "native-dollar",
      format: "native-inline",
      kind: "native-inline-dollar",
      closeOnSameLine: true,
    },
  ];
  for (const pair of config.inline) {
    if (isReservedNativeDollarPair(pair)) continue;
    const kind: ConfiguredTexMathRegionKind = pair.environment
      ? "custom-inline-environment"
      : "custom-inline-delimiter";
    specs.push({
      ...pair,
      display: false,
      includeDelimiters: pair.environment === true,
      origin: "configured",
      format: pair.environment ? "nl" : "n",
      kind,
      closeOnSameLine: false,
    });
  }
  for (const pair of config.display) {
    if (isReservedNativeDollarPair(pair)) continue;
    const kind: ConfiguredTexMathRegionKind = pair.environment
      ? "custom-display-environment"
      : "custom-display-delimiter";
    specs.push({
      ...pair,
      display: true,
      includeDelimiters: pair.environment === true,
      origin: "configured",
      format: pair.environment ? "jl" : "j",
      kind,
      closeOnSameLine: false,
    });
  }
  return specs;
}

function isReservedNativeDollarPair(pair: TexMathDelimiterPair): boolean {
  return (
    (pair.open === "$" && pair.close === "$") ||
    (pair.open === "$$" && pair.close === "$$")
  );
}

function findNextOpening(
  source: string,
  formats: readonly TexMathFormatSpec[],
  from: number,
): TexMathOpening | null {
  let best: TexMathOpening | null = null;
  for (const format of formats) {
    const at = findDelimiter(source, format.open, from, format);
    if (at === -1) continue;
    if (
      best === null ||
      at < best.at ||
      (at === best.at && format.open.length > best.format.open.length)
    ) {
      best = { at, format };
    }
  }
  return best;
}

function findDelimiter(
  source: string,
  delimiter: string,
  from: number,
  format: Pick<
    TexMathFormatSpec,
    "origin" | "format" | "open" | "close"
  >,
  closeOnSameLine = false,
): number {
  const lineEnd = closeOnSameLine ? source.indexOf("\n", from) : -1;
  let at = source.indexOf(delimiter, from);
  while (at !== -1) {
    if (lineEnd !== -1 && at >= lineEnd) return -1;
    if (
      !isEscaped(source, at) &&
      !isPartOfNativeDisplayDollar(source, at, delimiter, format, from)
    ) {
      return at;
    }
    at = source.indexOf(delimiter, at + 1);
  }
  return -1;
}

function isPartOfNativeDisplayDollar(
  source: string,
  at: number,
  delimiter: string,
  format: Pick<TexMathFormatSpec, "origin" | "format" | "open" | "close">,
  searchFrom: number,
): boolean {
  return (
    format.origin === "native-dollar" &&
    format.format === "native-inline" &&
    delimiter === "$" &&
    (source[at + 1] === "$" ||
      (at > searchFrom && source[at - 1] === "$"))
  );
}

function assertTexMathRegions(regions: readonly TexMathRegion[]): void {
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!;
    const previous = regions[index - 1];
    if (
      region.outer_start < 0 ||
      region.outer_start >= region.inner_start ||
      region.inner_start >= region.inner_end ||
      region.inner_end >= region.outer_end ||
      (previous !== undefined && previous.outer_end > region.outer_start)
    ) {
      throw new Error("Invalid overlapping TeX math regions");
    }
  }
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Replaces every comment character (unescaped % through end of line) with a
 * space, preserving length and offsets, so scanners never see math inside
 * comments while bounds still index into the original source.
 */
function maskTexComments(source: string): string {
  let masked = "";
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inComment) {
      if (char === "\n") {
        inComment = false;
        masked += char;
      } else {
        masked += " ";
      }
      continue;
    }
    if (char === "%" && !isEscaped(source, i)) {
      inComment = true;
      masked += " ";
      continue;
    }
    masked += char;
  }
  return masked;
}
