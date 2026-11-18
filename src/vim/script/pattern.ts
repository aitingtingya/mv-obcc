import { compileVimPattern, type VimMatch } from "../core/search";
import { DEFAULT_VIM_OPTIONS } from "../core/types";
/** Script and editing regexes share the original compiler; postfix assertions are lowered here. */
export function scriptPattern(
  pattern: string,
  ignorecase = false,
  global = false,
): RegExp {
  let source = pattern;
  // Each postfix assertion belongs to the preceding Vim atom, not the whole prefix.
  source = source.replace(/\\%\(/gu, "\\(\uE002");
  const assertions: string[] = [];
  const atom = String.raw`(?:\\\([^]*?\\\)|\[[^\]]*\]|\\[sSdDwWkax]|\\.|[^\\])`;
  source = source.replace(
    new RegExp(`(${atom})\\\\@(<!|<=|!|=)`, "gu"),
    (_match, value: string, kind: string) => {
      const compiled = compileVimPattern(
        value,
        { ...DEFAULT_VIM_OPTIONS, ignorecase },
        "",
      ).source;
      assertions.push(`(?${kind}${compiled})`);
      return `\uE000${assertions.length - 1}\uE001`;
    },
  );
  const base = compileVimPattern(
    source,
    { ...DEFAULT_VIM_OPTIONS, ignorecase },
    global ? "g" : "",
  );
  const lowered = base.source.replace(
    /\uE000(\d+)\uE001/gu,
    (_match, index: string) => assertions[Number(index)],
  );
  return new RegExp(lowered.replace(/\(\uE002/gu, "(?:"), base.flags);
}
export function scriptMatch(match: RegExpExecArray): VimMatch {
  return {
    from: match.index,
    to: match.index + match[0].length,
    text: match[0],
    groups: match.slice(1),
  };
}
