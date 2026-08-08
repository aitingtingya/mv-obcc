/** 正则查找替换的纯函数引擎：原生 RegExp + String.replace，$ 语义与
 * CodeMirror 搜索面板一致，不写自研正则。 */

export interface RegexQueryOptions {
  /** false 时按字面字符串查找（自动转义）。 */
  regex: boolean;
  caseSensitive: boolean;
  /** 多行模式：^/$ 匹配行首行尾。 */
  multiline: boolean;
}

export interface RegexMatch {
  /** 匹配起始 offset（UTF-16 code unit，与 String.replace 一致）。 */
  from: number;
  to: number;
  /** 1 起始行号。 */
  line: number;
  /** 命中所在的整行文本，供预览展示。 */
  lineText: string;
  matchText: string;
}

const LITERAL_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** 构造全局 RegExp；非法正则抛 Error，message 交给 UI 展示。 */
export function buildRegex(
  query: string,
  options: RegexQueryOptions,
): RegExp {
  const source = options.regex
    ? query
    : query.replace(LITERAL_ESCAPE_RE, "\\$&");
  let flags = "g";
  if (!options.caseSensitive) flags += "i";
  if (options.multiline) flags += "m";
  return new RegExp(source, flags);
}

/** 逐匹配扫描 text。每次调用前请用全新的 RegExp（或自行复位 lastIndex）。 */
export function regexScan(text: string, re: RegExp): RegexMatch[] {
  const matches: RegexMatch[] = [];
  // 预先算好行首 offset，匹配时二分定位行号，避免每个匹配 O(n) 重扫。
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const from = m.index;
    const to = from + m[0].length;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= from) lo = mid;
      else hi = mid - 1;
    }
    let lineEnd = text.indexOf("\n", to);
    if (lineEnd === -1) lineEnd = text.length;
    matches.push({
      from,
      to,
      line: lo + 1,
      lineText: text.slice(lineStarts[lo], lineEnd),
      matchText: m[0],
    });
    // 零宽匹配（如 /a*?/）必须手动推进，否则原地死循环。
    if (m[0].length === 0) re.lastIndex++;
  }
  return matches;
}

/** 全文替换，返回新文本。$1/$& 等语义由 String.replace 原生提供。 */
export function applyRegexReplace(
  text: string,
  re: RegExp,
  replacement: string,
): string {
  re.lastIndex = 0;
  return text.replace(re, replacement);
}
