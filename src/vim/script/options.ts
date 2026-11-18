import { DEFAULT_VIM_OPTIONS } from "../core/types";
import { optionName } from "../core/options";
import { integer, type VimValue } from "./value";
export interface ScriptOption {
  name: string;
  initial: VimValue;
  scope: "global" | "buffer" | "window";
}
const windowNames = new Set([
  "number",
  "relativenumber",
  "wrap",
  "cursorline",
  "scrolloff",
  "sidescrolloff",
]);
const bufferNames = new Set([
  "tabstop",
  "shiftwidth",
  "softtabstop",
  "expandtab",
  "autoindent",
  "textwidth",
  "iskeyword",
]);
export function scriptOptions(): Map<string, ScriptOption> {
  const definitions = new Map<string, ScriptOption>();
  for (const key of Object.keys(
    DEFAULT_VIM_OPTIONS,
  ) as (keyof typeof DEFAULT_VIM_OPTIONS)[]) {
    const value = DEFAULT_VIM_OPTIONS[key];
    definitions.set(key, {
      name: key,
      initial: typeof value === "number" ? integer(value) : value,
      scope: windowNames.has(key)
        ? "window"
        : bufferNames.has(key)
          ? "buffer"
          : "global",
    });
  }
  for (const [name, initial, scope] of [
    ["filetype", "", "buffer"],
    ["commentstring", "/*%s*/", "buffer"],
    ["operatorfunc", "", "global"],
    ["cpoptions", "", "global"],
    ["modelines", 0n, "global"],
    ["compatible", false, "global"],
    ["maxfuncdepth", 100n, "global"],
  ] as const)
    definitions.set(name, { name, initial, scope });
  return definitions;
}
export function scriptOptionName(raw: string): string {
  const name = raw.replace(/^[gl]:/u, "");
  return (
    optionName(name) ??
    (
      {
        ft: "filetype",
        cms: "commentstring",
        opfunc: "operatorfunc",
        cpo: "cpoptions",
        ml: "modelines",
        mfd: "maxfuncdepth",
      } as Record<string, string>
    )[name] ??
    name
  );
}
