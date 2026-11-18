import {
  copyValue,
  dictValue,
  displayValue,
  equalValue,
  integer,
  isFunction,
  listValue,
  numberValue,
  stringValue,
  truth,
  type VimValue,
} from "../value";
import type { ScriptRegistry } from "../registry";
export function registerContainers(registry: ScriptRegistry): void {
  const add = registry.add.bind(registry);
  add("type", 1, 1, "Vim value type", ([v]) =>
    BigInt(
      typeof v === "bigint"
        ? 0
        : typeof v === "string"
          ? 1
          : isFunction(v)
            ? 2
            : Array.isArray(v)
              ? 3
              : v instanceof Map
                ? 4
                : typeof v === "number"
                  ? 5
                  : typeof v === "boolean"
                    ? 6
                    : 7,
    ),
  );
  add("string", 1, 1, "Vim representation", ([v]) => displayValue(v, true));
  add("len", 1, 1, "Container or byte length", ([v]) =>
    integer(
      v instanceof Map
        ? v.size
        : Array.isArray(v)
          ? v.length
          : new TextEncoder().encode(stringValue(v)).length,
    ),
  );
  add("empty", 1, 1, "Test an empty value", ([v]) =>
    BigInt(
      v === null ||
        v === false ||
        v === 0n ||
        v === 0 ||
        v === "" ||
        (Array.isArray(v) && !v.length) ||
        (v instanceof Map && !v.size),
    ),
  );
  add("get", 2, 3, "Get a value with a default", ([v, key, fallback = 0n]) =>
    v instanceof Map
      ? (v.get(stringValue(key)) ?? fallback)
      : Array.isArray(v)
        ? (v.at(numberValue(key)) ?? fallback)
        : isFunction(v) && key === "name"
          ? v.name
          : fallback,
  );
  add("has_key", 2, 2, "Dictionary membership", ([v, key]) =>
    BigInt(dictValue(v).has(stringValue(key))),
  );
  add("keys", 1, 1, "Dictionary keys", ([v]) => [...dictValue(v).keys()]);
  add("values", 1, 1, "Dictionary values", ([v]) => [...dictValue(v).values()]);
  add("items", 1, 1, "Dictionary entries", ([v]) =>
    [...dictValue(v)].map(([key, value]) => [key, value]),
  );
  add("copy", 1, 1, "Shallow container copy", ([v]) => copyValue(v, false));
  add("deepcopy", 1, 2, "Deep container copy", ([v]) => copyValue(v, true));
  add("add", 2, 2, "Append to a List", ([v, item]) => {
    listValue(v).push(item);
    return v;
  });
  add("insert", 2, 3, "Insert into a List", ([v, item, at = 0n]) => {
    listValue(v).splice(numberValue(at), 0, item);
    return v;
  });
  add(
    "remove",
    2,
    3,
    "Remove a List range or Dictionary entry",
    ([v, key, last]) => {
      if (v instanceof Map) {
        const name = stringValue(key);
        if (!v.has(name)) throw new Error(`E716: Key not present: ${name}`);
        const old = v.get(name)!;
        v.delete(name);
        return old;
      }
      const list = listValue(v),
        raw = numberValue(key),
        at = raw < 0 ? list.length + raw : raw;
      if (at < 0 || at >= list.length)
        throw new Error("E684: List index out of range");
      const end =
        last === undefined
          ? at
          : numberValue(last) < 0
            ? list.length + numberValue(last)
            : numberValue(last);
      const removed = list.splice(at, end - at + 1);
      return last === undefined ? removed[0] : removed;
    },
  );
  add("extend", 2, 3, "Extend a List or Dictionary", ([v, other, action]) => {
    if (v instanceof Map) {
      for (const [key, value] of dictValue(other)) {
        if (v.has(key) && action === "error")
          throw new Error(`E737: Key already exists: ${key}`);
        if (!v.has(key) || action !== "keep") v.set(key, value);
      }
    } else {
      const list = listValue(v);
      list.splice(
        action === undefined ? list.length : numberValue(action),
        0,
        ...listValue(other),
      );
    }
    return v;
  });
  add("reverse", 1, 1, "Reverse a List", ([v]) => listValue(v).reverse());
  add("repeat", 2, 2, "Repeat a String or List", ([v, count]) => {
    const n = Math.max(0, numberValue(count));
    return Array.isArray(v)
      ? Array.from({ length: n }, () => v).flat()
      : stringValue(v).repeat(n);
  });
  add("range", 1, 3, "Inclusive integer range", async (args, ctx) => {
    const start = args.length === 1 ? 0 : numberValue(args[0]),
      end = args.length === 1 ? numberValue(args[0]) - 1 : numberValue(args[1]),
      step = args.length < 3 ? 1 : numberValue(args[2]);
    if (step === 0) throw new Error("E726: Stride is zero");
    const result: VimValue[] = [];
    for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
      await ctx.step();
      result.push(integer(n));
    }
    return result;
  });
  add("index", 2, 4, "Find an item", ([v, item, from = 0n, ic = 0n]) => {
    const list = listValue(v);
    const at = list.findIndex(
      (entry, i) =>
        i >= numberValue(from) && equalValue(entry, item, truth(ic)),
    );
    return integer(at);
  });
  add(
    "count",
    2,
    4,
    "Count matching values",
    ([v, item, ic = 0n, from = 0n]) => {
      const values = v instanceof Map ? [...v.values()] : listValue(v);
      return integer(
        values
          .slice(numberValue(from))
          .filter((entry) => equalValue(entry, item, truth(ic))).length,
      );
    },
  );
  for (const name of ["map", "filter"] as const)
    add(name, 2, 2, `${name} a container`, async ([v, callback], ctx) => {
      const entries: [VimValue, VimValue][] =
        v instanceof Map
          ? [...v]
          : listValue(v).map((item, i) => [integer(i), item]);
      const result: [VimValue, VimValue][] = [];
      for (const [key, item] of entries) {
        await ctx.step();
        const value =
          typeof callback === "string"
            ? await ctx.expression(
                callback,
                new Map([
                  ["key", key],
                  ["val", item],
                ]),
              )
            : await ctx.invoke(callback, [key, item]);
        if (name === "map" || truth(value))
          result.push([key, name === "map" ? value : item]);
      }
      if (v instanceof Map) {
        v.clear();
        for (const [key, item] of result) v.set(stringValue(key), item);
      } else
        listValue(v).splice(
          0,
          listValue(v).length,
          ...result.map(([, item]) => item),
        );
      return v;
    });
  add("sort", 1, 3, "Stable List sort", async ([v, comparator = ""], ctx) => {
    const list = listValue(v);
    const compare = async (a: VimValue, b: VimValue): Promise<number> => {
      if (
        isFunction(comparator) ||
        (typeof comparator === "string" &&
          !["", "n", "N", "f", "i"].includes(comparator))
      )
        return numberValue(await ctx.invoke(comparator, [a, b]));
      if (["n", "N", "f"].includes(stringValue(comparator)))
        return numberValue(a) - numberValue(b);
      let x = displayValue(a, typeof a !== "string"),
        y = displayValue(b, typeof b !== "string");
      if (comparator === "i") {
        x = x.toLowerCase();
        y = y.toLowerCase();
      }
      return x < y ? -1 : x > y ? 1 : 0;
    };
    async function merge(items: VimValue[]): Promise<VimValue[]> {
      if (items.length < 2) return items;
      const middle = Math.floor(items.length / 2),
        a = await merge(items.slice(0, middle)),
        b = await merge(items.slice(middle));
      const out: VimValue[] = [];
      let i = 0,
        j = 0;
      while (i < a.length && j < b.length) {
        await ctx.step();
        if ((await compare(a[i], b[j])) <= 0) out.push(a[i++]);
        else out.push(b[j++]);
      }
      return [...out, ...a.slice(i), ...b.slice(j)];
    }
    const sorted = await merge([...list]);
    list.splice(0, list.length, ...sorted);
    return v;
  });
  add(
    "uniq",
    1,
    2,
    "Remove adjacent duplicates",
    async ([v, comparator], ctx) => {
      const list = listValue(v);
      for (let i = 1; i < list.length; ) {
        const same =
          comparator === undefined
            ? equalValue(list[i - 1], list[i])
            : numberValue(
                await ctx.invoke(comparator, [list[i - 1], list[i]]),
              ) === 0;
        if (same) list.splice(i, 1);
        else i++;
      }
      return v;
    },
  );
  for (const name of ["min", "max"] as const)
    add(name, 1, 1, `${name} of values`, ([v]) => {
      const values = v instanceof Map ? [...v.values()] : listValue(v);
      if (!values.length) return 0n;
      return values.reduce((a, b) =>
        (
          name === "min"
            ? numberValue(a) < numberValue(b)
            : numberValue(a) > numberValue(b)
        )
          ? a
          : b,
      );
    });
  add("abs", 1, 1, "Absolute numeric value", ([v]) =>
    typeof v === "number"
      ? Math.abs(v)
      : typeof v === "bigint"
        ? integer(v < 0 ? -v : v)
        : integer(Math.abs(numberValue(v))),
  );
  add("float2nr", 1, 1, "Truncate a Float", ([v]) => integer(numberValue(v)));
  add("str2nr", 1, 3, "Parse a Number", ([v, base = 10n]) =>
    integer(Number.parseInt(stringValue(v), numberValue(base)) || 0),
  );
  add(
    "str2float",
    1,
    1,
    "Parse a Float",
    ([v]) => Number.parseFloat(stringValue(v)) || 0,
  );
  add("str2list", 1, 2, "Unicode codepoints", ([v]) =>
    [...stringValue(v)].map((c) => integer(c.codePointAt(0)!)),
  );
  add("list2str", 1, 2, "String from codepoints", ([v]) =>
    listValue(v)
      .map((c) => String.fromCodePoint(numberValue(c)))
      .join(""),
  );
}
