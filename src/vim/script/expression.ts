import {
  equalValue,
  indexValue,
  integer,
  isFunction,
  numberValue,
  stringValue,
  truth,
  type ExpressionContext,
  type VimValue,
} from "./value";
export type Expression =
  | {
      kind: "literal";
      value: VimValue;
    }
  | {
      kind: "variable" | "option" | "register";
      name: string;
    }
  | {
      kind: "list";
      items: Expression[];
      rest?: Expression;
    }
  | {
      kind: "dict";
      items: [Expression, Expression][];
    }
  | {
      kind: "unary";
      operator: string;
      value: Expression;
    }
  | {
      kind: "binary";
      operator: string;
      left: Expression;
      right: Expression;
    }
  | {
      kind: "conditional";
      condition: Expression;
      yes: Expression;
      no: Expression;
    }
  | {
      kind: "index";
      target: Expression;
      index: Expression;
    }
  | {
      kind: "member";
      target: Expression;
      name: string;
    }
  | {
      kind: "slice";
      target: Expression;
      from: Expression | null;
      to: Expression | null;
    }
  | {
      kind: "call";
      target: Expression;
      args: Expression[];
    }
  | {
      kind: "lambda";
      parameters: string[];
      body: Expression;
    };
interface Token {
  text: string;
  position: number;
  value?: VimValue;
  kind: "name" | "literal" | "operator" | "end";
}
export function parseExpression(text: string): Expression {
  const parser = new ExpressionParser(text);
  const result = parser.expression();
  if (parser.peek().kind !== "end")
    throw new Error(
      `E488: Trailing characters at column ${parser.peek().position + 1}: ${parser.peek().text}`,
    );
  return result;
}
export function parseExpressionSequence(text: string): Expression[] {
  const parser = new ExpressionParser(text, false);
  const result: Expression[] = [];
  while (parser.peek().kind !== "end") result.push(parser.expression());
  return result;
}
class ExpressionParser {
  private readonly tokens: Token[];
  private index = 0;
  constructor(text: string, comments = true) {
    this.tokens = tokenize(text, comments);
  }
  peek(): Token {
    return this.tokens[this.index];
  }
  private take(): Token {
    return this.tokens[this.index++];
  }
  private accept(text: string): boolean {
    if (this.peek().text !== text) return false;
    this.index++;
    return true;
  }
  private require(text: string): void {
    if (!this.accept(text))
      throw new Error(
        `E15: Expected ${text} at column ${this.peek().position + 1}`,
      );
  }
  expression(minimum = 0): Expression {
    let left = this.atom();
    while (true) {
      const operator = this.peek().text;
      const precedence = priorities[operator];
      if (precedence === undefined || precedence < minimum) break;
      this.take();
      left = {
        kind: "binary",
        operator,
        left,
        right: this.expression(precedence + 1),
      };
    }
    if (minimum === 0 && this.accept("?")) {
      const yes = this.expression();
      this.require(":");
      left = {
        kind: "conditional",
        condition: left,
        yes,
        no: this.expression(),
      };
    }
    return left;
  }
  private atom(): Expression {
    const token = this.take();
    let value: Expression;
    if (["!", "+", "-"].includes(token.text))
      return { kind: "unary", operator: token.text, value: this.expression(7) };
    if (token.kind === "literal")
      value = { kind: "literal", value: token.value! };
    else if (token.text === "(") {
      value = this.expression();
      this.require(")");
    } else if (token.text === "[") {
      const items: Expression[] = [];
      let rest: Expression | undefined;
      if (!this.accept("]")) {
        do {
          items.push(this.expression());
        } while (this.accept(",") && this.peek().text !== "]");
        if (this.accept(";")) rest = this.expression();
        this.require("]");
      }
      value = { kind: "list", items, rest };
    } else if (token.text === "{") {
      const start = this.index;
      const parameters: string[] = [];
      while (this.peek().kind === "name") {
        parameters.push(this.take().text);
        if (!this.accept(",")) break;
      }
      if (this.accept("->")) {
        const body = this.expression();
        this.require("}");
        value = { kind: "lambda", parameters, body };
      } else {
        this.index = start;
        const items: [Expression, Expression][] = [];
        if (!this.accept("}")) {
          do {
            const key = this.expression();
            this.require(":");
            items.push([key, this.expression()]);
          } while (this.accept(",") && this.peek().text !== "}");
          this.require("}");
        }
        value = { kind: "dict", items };
      }
    } else if (token.kind === "name")
      value = {
        kind: token.text.startsWith("&")
          ? "option"
          : token.text.startsWith("@")
            ? "register"
            : "variable",
        name: /^[&@]/u.test(token.text) ? token.text.slice(1) : token.text,
      };
    else
      throw new Error(
        `E15: Invalid expression at column ${token.position + 1}: ${token.text}`,
      );
    while (true) {
      if (this.accept("("))
        value = { kind: "call", target: value, args: this.sequence(")") };
      else if (
        this.peek().text === "." &&
        this.tokens[this.index + 1]?.kind === "name" &&
        this.peek().position ===
          this.tokens[this.index - 1].position +
            this.tokens[this.index - 1].text.length &&
        this.tokens[this.index + 1].position === this.peek().position + 1
      ) {
        this.take();
        value = { kind: "member", target: value, name: this.take().text };
      } else if (this.accept("[")) {
        const from = this.peek().text === ":" ? null : this.expression();
        if (this.accept(":")) {
          const to = this.peek().text === "]" ? null : this.expression();
          this.require("]");
          value = { kind: "slice", target: value, from, to };
        } else {
          this.require("]");
          value = { kind: "index", target: value, index: from! };
        }
      } else break;
    }
    return value;
  }
  private sequence(end: string): Expression[] {
    const values: Expression[] = [];
    if (!this.accept(end)) {
      do {
        values.push(this.expression());
      } while (this.accept(",") && this.peek().text !== end);
      this.require(end);
    }
    return values;
  }
}
const priorities: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "==#": 3,
  "==?": 3,
  "!=#": 3,
  "!=?": 3,
  is: 3,
  isnot: 3,
  "is#": 3,
  "isnot#": 3,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "=~": 3,
  "!~": 3,
  "=~#": 3,
  "=~?": 3,
  "!~#": 3,
  "!~?": 3,
  ".": 4,
  "..": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
function tokenize(text: string, comments: boolean): Token[] {
  const result: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/u.test(text[index])) {
      index++;
      continue;
    }
    const position = index;
    const c = text[index];
    const last = result.at(-1);
    if (
      comments &&
      c === '"' &&
      last &&
      (last.kind === "literal" ||
        last.kind === "name" ||
        [")", "]", "}"].includes(last.text)) &&
      /\s/u.test(text[index - 1])
    )
      break;
    if (c === "'" || c === '"') {
      index++;
      let value = "";
      let closed = false;
      while (index < text.length) {
        const char = text[index++];
        if (char === c) {
          if (c === "'" && text[index] === "'") {
            value += "'";
            index++;
          } else {
            closed = true;
            break;
          }
        } else if (c === '"' && char === "\\") {
          const escape = text[index++];
          const replacements: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            e: "\x1b",
            b: "\b",
            '"': '"',
            "\\": "\\",
          };
          if (escape in replacements) value += replacements[escape];
          else if (/[xuU]/u.test(escape)) {
            const length = escape === "x" ? 2 : escape === "u" ? 4 : 8;
            const hex = text
              .slice(index)
              .match(new RegExp(`^[0-9a-fA-F]{1,${length}}`))?.[0];
            if (hex) {
              value += String.fromCodePoint(Number.parseInt(hex, 16));
              index += hex.length;
            } else value += escape;
          } else if (/[0-7]/u.test(escape)) {
            const rest = text.slice(index).match(/^[0-7]{0,2}/u)![0];
            value += String.fromCharCode(Number.parseInt(escape + rest, 8));
            index += rest.length;
          } else if (escape === "<") {
            const end = text.indexOf(">", index);
            if (end < 0) throw new Error("E15: Unclosed key notation");
            value += text.slice(index - 1, end + 1);
            index = end + 1;
          } else value += escape;
        } else value += char;
      }
      if (!closed) throw new Error("E114: Missing quote");
      result.push({
        kind: "literal",
        text: text.slice(position, index),
        position,
        value,
      });
      continue;
    }
    const number =
      /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.\d+(?:[eE][+-]?\d+)?|\d+)/u.exec(
        text.slice(index),
      );
    if (number) {
      index += number[0].length;
      result.push({
        kind: "literal",
        text: number[0],
        position,
        value: number[0].includes(".")
          ? Number(number[0])
          : integer(
              BigInt(
                /^0[0-7]+$/u.test(number[0])
                  ? `0o${number[0].slice(1)}`
                  : number[0],
              ),
            ),
      });
      continue;
    }
    const name =
      /^(?:&(?:[gl]:)?[A-Za-z][\w]*|@.|(?:<SID>|<SNR>\d+_)[A-Za-z_][\w#]*|[gsbwlav]:(?:[A-Za-z_][\w#]*|\d+)?|[A-Za-z_][\w#]*)/iu.exec(
        text.slice(index),
      );
    if (name) {
      index += name[0].length;
      const raw = name[0];
      result.push({
        kind: ["is", "isnot"].includes(raw) ? "operator" : "name",
        text: raw,
        position,
      });
      continue;
    }
    const operator =
      /^(?:==[?#]?|!=[?#]?|=~[?#]?|!~[?#]?|&&|\|\||<=|>=|->|\.\.|.)/u.exec(
        text.slice(index),
      )![0];
    index += operator.length;
    result.push({ kind: "operator", text: operator, position });
  }
  result.push({ kind: "end", text: "", position: index });
  return result;
}
export async function evaluate(
  node: Expression,
  context: ExpressionContext,
): Promise<VimValue> {
  await context.step();
  switch (node.kind) {
    case "literal":
      return node.value;
    case "variable":
      return context.variable(node.name);
    case "option":
      return context.option(node.name);
    case "register":
      return context.register(node.name);
    case "list": {
      if (node.rest)
        throw new Error("E15: Rest target is only valid in assignment");
      const values: VimValue[] = [];
      for (const item of node.items) values.push(await evaluate(item, context));
      return values;
    }
    case "dict": {
      const values = new Map<string, VimValue>();
      for (const [key, item] of node.items)
        values.set(
          stringValue(await evaluate(key, context)),
          await evaluate(item, context),
        );
      return values;
    }
    case "unary": {
      const value = await evaluate(node.value, context);
      if (node.operator === "!") return BigInt(!truth(value));
      if (typeof value === "number")
        return node.operator === "-" ? -value : value;
      const n = typeof value === "bigint" ? value : integer(numberValue(value));
      return node.operator === "-" ? integer(-n) : n;
    }
    case "binary": {
      const left = await evaluate(node.left, context);
      if (node.operator === "&&" && !truth(left)) return 0n;
      if (node.operator === "||" && truth(left)) return 1n;
      if (
        node.operator === "." &&
        left instanceof Map &&
        node.right.kind === "variable"
      )
        return indexValue(left, node.right.name);
      return binary(
        node.operator,
        left,
        await evaluate(node.right, context),
        context,
      );
    }
    case "conditional":
      return evaluate(
        truth(await evaluate(node.condition, context)) ? node.yes : node.no,
        context,
      );
    case "index":
      return indexValue(
        await evaluate(node.target, context),
        await evaluate(node.index, context),
      );
    case "member": {
      const parent = await evaluate(node.target, context);
      return parent instanceof Map
        ? indexValue(parent, node.name)
        : stringValue(parent) + stringValue(context.variable(node.name));
    }
    case "slice": {
      const value = await evaluate(node.target, context);
      const array =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : Array.isArray(value)
            ? value
            : null;
      if (!array) throw new Error("E709: Slice requires a String or List");
      const from = node.from
        ? numberValue(await evaluate(node.from, context))
        : 0;
      const end = node.to ? numberValue(await evaluate(node.to, context)) : -1;
      const slice = array.slice(
        Math.max(0, from < 0 ? array.length + from : from),
        Math.max(0, end < 0 ? array.length + end + 1 : end + 1),
      );
      return typeof value === "string"
        ? new TextDecoder().decode(slice as Uint8Array)
        : (slice as VimValue[]);
    }
    case "call": {
      const args: VimValue[] = [];
      for (const arg of node.args) args.push(await evaluate(arg, context));
      if (node.target.kind === "variable")
        return context.call(node.target.name, args);
      if (node.target.kind === "member") {
        const parent = await evaluate(node.target.target, context);
        if (!(parent instanceof Map))
          return (
            stringValue(parent) +
            stringValue(await context.call(node.target.name, args))
          );
        const target = indexValue(parent, node.target.name);
        if (!isFunction(target)) throw new Error("E695: Funcref required");
        return target.invoke(args, context, parent);
      }
      if (node.target.kind === "index") {
        const parent = await evaluate(node.target.target, context),
          key = await evaluate(node.target.index, context),
          target = indexValue(parent, key);
        if (!isFunction(target)) throw new Error("E695: Funcref required");
        return target.invoke(
          args,
          context,
          parent instanceof Map ? parent : undefined,
        );
      }
      const target = await evaluate(node.target, context);
      if (!isFunction(target)) throw new Error("E695: Funcref required");
      return target.invoke(args, context);
    }
    case "lambda":
      return {
        kind: "function",
        name: "<lambda>",
        invoke: async (args, caller) => {
          if (args.length !== node.parameters.length)
            throw new Error("E119: Wrong number of arguments");
          const locals = new Map(
            node.parameters.map((name, index) => [name, args[index]]),
          );
          return evaluate(node.body, {
            ...context.forCaller(caller),
            step: () => caller.step(),
            option: (name) => caller.option(name),
            register: (name) => caller.register(name),
            variable: (name) =>
              locals.has(name)
                ? locals.get(name)!
                : /^[bwva]:/u.test(name)
                  ? caller.variable(name)
                  : context.variable(name),
            assign: (name, value) => {
              if (locals.has(name)) locals.set(name, value);
              else context.assign(name, value);
            },
          });
        },
      };
  }
}
export function binary(
  operator: string,
  a: VimValue,
  b: VimValue,
  context: ExpressionContext,
): VimValue {
  if (operator === "&&" || operator === "||") return BigInt(truth(b));
  if (["==", "==#", "==?", "!=", "!=#", "!=?"].includes(operator))
    return BigInt(
      equalValue(a, b, operator.endsWith("?")) !== operator.startsWith("!"),
    );
  if (["is", "is#", "isnot", "isnot#"].includes(operator))
    return BigInt((a === b) !== operator.startsWith("isnot"));
  if (/^[=!]~/u.test(operator))
    return BigInt(
      context.match(
        stringValue(a),
        stringValue(b),
        operator.endsWith("?")
          ? true
          : operator.endsWith("#")
            ? false
            : undefined,
      ) !== operator.startsWith("!"),
    );
  if (operator === "." || operator === "..")
    return stringValue(a) + stringValue(b);
  if (operator === "+" && Array.isArray(a) && Array.isArray(b))
    return [...a, ...b];
  if (["<", ">", "<=", ">="].includes(operator)) {
    const x =
      typeof a === "string" && typeof b === "string" ? a : numberValue(a);
    const y =
      typeof a === "string" && typeof b === "string" ? b : numberValue(b);
    return BigInt(
      operator === "<"
        ? x < y
        : operator === ">"
          ? x > y
          : operator === "<="
            ? x <= y
            : x >= y,
    );
  }
  if (typeof a === "number" || typeof b === "number") {
    const x = numberValue(a),
      y = numberValue(b);
    if (operator === "+") return x + y;
    if (operator === "-") return x - y;
    if (operator === "*") return x * y;
    if (operator === "/") return x / y;
    if (operator === "%") throw new Error("E804: Cannot use '%' with Float");
  }
  const x = typeof a === "bigint" ? a : integer(numberValue(a)),
    y = typeof b === "bigint" ? b : integer(numberValue(b));
  if (operator === "+") return integer(x + y);
  if (operator === "-") return integer(x - y);
  if (operator === "*") return integer(x * y);
  if (operator === "/")
    return y === 0n
      ? x === 0n
        ? -0x8000000000000000n
        : x < 0
          ? -0x7fffffffffffffffn
          : 0x7fffffffffffffffn
      : integer(x / y);
  if (operator === "%") return y === 0n ? 0n : x % y;
  throw new Error(`E15: Unsupported operator ${operator}`);
}
