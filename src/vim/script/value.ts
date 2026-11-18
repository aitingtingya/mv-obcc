/** Values belong to Vim, including reference containers and signed 64-bit Numbers. */
export type VimValue =
  | bigint
  | number
  | boolean
  | string
  | null
  | VimValue[]
  | Map<string, VimValue>
  | VimFunction;
export interface VimFunction {
  kind: "function";
  name: string;
  invoke(
    args: VimValue[],
    context: ExpressionContext,
    self?: Map<string, VimValue>,
  ): Promise<VimValue>;
}
export interface ExpressionContext {
  /** Keep lexical variables while invoking a lambda in the caller's editor and execution. */
  forCaller(caller: ExpressionContext): ExpressionContext;
  variable(name: string): VimValue;
  assign(name: string, value: VimValue): void;
  option(name: string): VimValue;
  register(name: string): Promise<VimValue>;
  call(name: string, args: VimValue[]): Promise<VimValue>;
  match(text: string, pattern: string, ignoreCase?: boolean): boolean;
  step(): Promise<void>;
}
export function integer(value: bigint | number): bigint {
  return BigInt.asIntN(
    64,
    typeof value === "bigint" ? value : BigInt(Math.trunc(value)),
  );
}
export function numberValue(value: VimValue): number {
  if (typeof value === "number" || typeof value === "bigint")
    return Number(value);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") return Number.parseInt(value, 10) || 0;
  throw new Error("E745: Number required");
}
export function truth(value: VimValue): boolean {
  return numberValue(value) !== 0;
}
export function stringValue(value: VimValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "v:true" : "v:false";
  if (value === null) return "v:null";
  throw new Error("E730: String required");
}
export function displayValue(value: VimValue, quoted = false): string {
  if (typeof value === "string")
    return quoted ? `'${value.replace(/'/gu, "''")}'` : value;
  if (Array.isArray(value))
    return `[${value.map((item) => displayValue(item, true)).join(", ")}]`;
  if (value instanceof Map)
    return `{${[...value].map(([key, item]) => `${displayValue(key, true)}: ${displayValue(item, true)}`).join(", ")}}`;
  if (isFunction(value)) return `function('${value.name}')`;
  return stringValue(value);
}
export function isFunction(value: VimValue): value is VimFunction {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "function"
  );
}
export function listValue(value: VimValue): VimValue[] {
  if (!Array.isArray(value)) throw new Error("E714: List required");
  return value;
}
export function dictValue(value: VimValue): Map<string, VimValue> {
  if (!(value instanceof Map)) throw new Error("E715: Dictionary required");
  return value;
}
export function copyValue(
  value: VimValue,
  deep: boolean,
  seen = new Map<VimValue, VimValue>(),
): VimValue {
  if (seen.has(value)) return seen.get(value)!;
  if (Array.isArray(value)) {
    const result: VimValue[] = [];
    seen.set(value, result);
    for (const item of value)
      result.push(deep ? copyValue(item, true, seen) : item);
    return result;
  }
  if (value instanceof Map) {
    const result = new Map<string, VimValue>();
    seen.set(value, result);
    for (const [key, item] of value)
      result.set(key, deep ? copyValue(item, true, seen) : item);
    return result;
  }
  return value;
}
export function equalValue(
  a: VimValue,
  b: VimValue,
  ignoreCase = false,
): boolean {
  if (typeof a === "string" && typeof b === "string")
    return ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((item, index) => equalValue(item, b[index], ignoreCase))
    );
  if (a instanceof Map && b instanceof Map)
    return (
      a.size === b.size &&
      [...a].every(
        ([key, item]) =>
          b.has(key) && equalValue(item, b.get(key)!, ignoreCase),
      )
    );
  if (
    (typeof a === "bigint" || typeof a === "number") &&
    (typeof b === "bigint" || typeof b === "number")
  )
    return a == b;
  if (
    (typeof a === "bigint" && typeof b === "string") ||
    (typeof b === "bigint" && typeof a === "string")
  )
    return numberValue(a) === numberValue(b);
  return a === b;
}
export function indexValue(value: VimValue, key: VimValue): VimValue {
  if (value instanceof Map) {
    const name = stringValue(key);
    if (!value.has(name))
      throw new Error(`E716: Key not present in Dictionary: ${name}`);
    return value.get(name)!;
  }
  const n = numberValue(key);
  if (Array.isArray(value)) {
    const at = n < 0 ? value.length + n : n;
    if (at < 0 || at >= value.length)
      throw new Error(`E684: List index out of range: ${n}`);
    return value[at];
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return n < 0 || n >= bytes.length
      ? ""
      : new TextDecoder().decode(bytes.slice(n, n + 1));
  }
  throw new Error("E689: Can only index a List, Dictionary or String");
}
