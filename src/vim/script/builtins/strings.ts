import { vimReplacement } from "../../core/search";
import { scriptMatch, scriptPattern } from "../pattern";
import type { ScriptRegistry } from "../registry";
import {
  integer,
  listValue,
  numberValue,
  stringValue,
  truth,
  type VimValue,
} from "../value";
export function registerStrings(registry: ScriptRegistry): void {
  const add = registry.add.bind(registry);
  add("join", 1, 2, "Join a List", ([v, separator = " "]) =>
    listValue(v).map(stringValue).join(stringValue(separator)),
  );
  add(
    "split",
    1,
    3,
    "Split by a Vim pattern",
    ([v, pattern = "\\s\\+", keep = 0n]) => {
      const parts = stringValue(v).split(scriptPattern(stringValue(pattern)));
      return truth(keep) ? parts : parts.filter(Boolean);
    },
  );
  add("strlen", 1, 1, "UTF-8 byte length", ([v]) =>
    integer(new TextEncoder().encode(stringValue(v)).length),
  );
  add("strchars", 1, 2, "Unicode character count", ([v]) =>
    integer([...stringValue(v)].length),
  );
  add("strcharpart", 2, 4, "Unicode character slice", ([v, start, length]) =>
    [...stringValue(v)]
      .slice(
        numberValue(start),
        length === undefined
          ? undefined
          : numberValue(start) + numberValue(length),
      )
      .join(""),
  );
  add("strpart", 2, 4, "UTF-8 byte slice", ([v, start, length]) => {
    const bytes = new TextEncoder().encode(stringValue(v));
    const at = numberValue(start);
    return new TextDecoder().decode(
      bytes.slice(
        Math.max(0, at),
        length === undefined
          ? undefined
          : Math.max(0, at + numberValue(length)),
      ),
    );
  });
  add(
    "stridx",
    2,
    3,
    "Byte position of a substring",
    ([v, needle, start = 0n]) => {
      const text = stringValue(v),
        from = new TextDecoder().decode(
          new TextEncoder().encode(text).slice(0, numberValue(start)),
        ).length,
        at = text.indexOf(stringValue(needle), from);
      return at < 0
        ? -1n
        : integer(new TextEncoder().encode(text.slice(0, at)).length);
    },
  );
  add(
    "strridx",
    2,
    3,
    "Last byte position of a substring",
    ([v, needle, start]) => {
      const text = stringValue(v),
        at = text.lastIndexOf(
          stringValue(needle),
          start === undefined ? undefined : numberValue(start),
        );
      return at < 0
        ? -1n
        : integer(new TextEncoder().encode(text.slice(0, at)).length);
    },
  );
  add("tolower", 1, 1, "Lowercase text", ([v]) => stringValue(v).toLowerCase());
  add("toupper", 1, 1, "Uppercase text", ([v]) => stringValue(v).toUpperCase());
  add("trim", 1, 3, "Trim text", ([v, mask, direction = 0n]) => {
    const text = stringValue(v);
    if (mask === undefined) return text.trim();
    const chars = stringValue(mask).replace(/[\\\]\-^]/gu, "\\$&"),
      mode = numberValue(direction);
    return text.replace(
      new RegExp(
        `${mode !== 2 ? `^[${chars}]+` : "(?!)"}|${mode !== 1 ? `[${chars}]+$` : "(?!)"}`,
        "gu",
      ),
      "",
    );
  });
  add("escape", 2, 2, "Escape selected characters", ([v, chars]) =>
    [...stringValue(v)]
      .map((c) => (stringValue(chars).includes(c) ? `\\${c}` : c))
      .join(""),
  );
  add("nr2char", 1, 2, "Codepoint to character", ([v]) =>
    String.fromCodePoint(numberValue(v)),
  );
  add("char2nr", 1, 2, "First codepoint", ([v]) =>
    integer(stringValue(v).codePointAt(0) ?? 0),
  );
  add(
    "printf",
    1,
    Number.MAX_SAFE_INTEGER,
    "Format values",
    ([format, ...args]) => {
      let index = 0;
      return stringValue(format).replace(
        /%%|%([-+ 0]*)(\d*)(?:\.(\d+))?([sdifxXoc])/gu,
        (
          raw,
          flags: string,
          width: string,
          precision: string,
          code: string,
        ) => {
          if (raw === "%%") return "%";
          if (index >= args.length)
            throw new Error("E766: Insufficient arguments for printf()");
          const value = args[index++];
          let text =
            code === "s"
              ? stringValue(value)
              : code === "f"
                ? numberValue(value).toFixed(
                    precision === undefined ? 6 : Number(precision),
                  )
                : code === "c"
                  ? String.fromCodePoint(numberValue(value))
                  : Math.trunc(numberValue(value)).toString(
                      /[xX]/u.test(code) ? 16 : code === "o" ? 8 : 10,
                    );
          if (code === "X") text = text.toUpperCase();
          if (code === "s" && precision !== undefined)
            text = text.slice(0, Number(precision));
          return flags.includes("-")
            ? text.padEnd(Number(width), " ")
            : text.padStart(Number(width), flags.includes("0") ? "0" : " ");
        },
      );
    },
  );
  for (const name of ["match", "matchend", "matchstr", "matchlist"] as const)
    add(
      name,
      2,
      4,
      "Match a Vim pattern",
      ([v, pattern, start = 0n, count = 1n]) => {
        const text = stringValue(v),
          bytes = new TextEncoder().encode(text),
          prefix = new TextDecoder().decode(bytes.slice(0, numberValue(start))),
          regex = scriptPattern(stringValue(pattern), false, true);
        regex.lastIndex = prefix.length;
        let match: RegExpExecArray | null = null;
        for (let n = 0; n < numberValue(count); n++) {
          match = regex.exec(text);
          if (!match) break;
          if (!match[0]) regex.lastIndex++;
        }
        if (!match)
          return name === "matchstr" ? "" : name === "matchlist" ? [] : -1n;
        if (name === "matchstr") return match[0];
        if (name === "matchlist")
          return Array.from({ length: 10 }, (_, i) => match[i] ?? "");
        return integer(
          new TextEncoder().encode(
            text.slice(
              0,
              match.index + (name === "matchend" ? match[0].length : 0),
            ),
          ).length,
        );
      },
    );
  add(
    "substitute",
    4,
    4,
    "Vim replacement including expressions",
    async ([v, pattern, replacement, flags], ctx) => {
      const text = stringValue(v),
        template = stringValue(replacement),
        regex = scriptPattern(stringValue(pattern), false, true);
      let result = "",
        offset = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        await ctx.step();
        result += text.slice(offset, match.index);
        result += template.startsWith("\\=")
          ? stringValue(
              await ctx.expression(
                template.slice(2),
                new Map<string, VimValue>([["submatches", [...match]]]),
              ),
            )
          : vimReplacement(template, scriptMatch(match));
        offset = match.index + match[0].length;
        if (!stringValue(flags).includes("g")) break;
        if (!match[0]) regex.lastIndex++;
      }
      return result + text.slice(offset);
    },
  );
  add(
    "submatch",
    1,
    2,
    "Current substitution capture",
    ([index, list = 0n], ctx) => {
      const values = listValue(ctx.frame.specials.get("submatches") ?? []);
      const value = values[numberValue(index)] ?? "";
      return truth(list) ? stringValue(value).split("\n") : value;
    },
  );
}
