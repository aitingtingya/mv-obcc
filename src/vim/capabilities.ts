export interface VimCapability {
  id: string;
  label: string;
  keys?: readonly string[];
}

export interface VimCapabilityGroup {
  id: string;
  label: string;
  capabilities: readonly VimCapability[];
}

/**
 * Release contract for the independent Vim engine. Tests and documentation
 * consume this manifest so an advertised capability cannot exist only in copy.
 */
export const VIM_CAPABILITY_MANIFEST = {
  version: 1,
  groups: [
    {
      id: "modes",
      label: "Modes",
      capabilities: [
        capability("normal", "Normal mode"),
        capability("insert", "Insert mode", ["i", "a", "I", "A", "o", "O"]),
        capability("replace", "Replace mode", ["R"]),
        capability("visual", "Visual mode", ["v"]),
        capability("visual-line", "Visual Line mode", ["V"]),
        capability("visual-block", "Visual Block mode", ["<C-v>", "<C-q>"]),
        capability("operator-pending", "Operator-pending mode"),
        capability("command-line", "Command-line mode", [":", "/", "?"]),
      ],
    },
    {
      id: "motions",
      label: "Motions",
      capabilities: [
        capability("horizontal", "Character motions", ["h", "l", "<Left>", "<Right>"]),
        capability("vertical", "Line motions", ["j", "k", "<Down>", "<Up>", "gj", "gk"]),
        capability("line-boundaries", "Line boundaries", ["0", "^", "$", "g_", "<Home>", "<End>"]),
        capability("words", "Word motions", ["w", "W", "b", "B", "e", "E", "ge", "gE"]),
        capability("document-lines", "Document line jumps", ["gg", "G"]),
        capability("paragraphs", "Paragraph motions", ["{", "}"]),
        capability("sentences", "Sentence motions", ["(", ")"]),
        capability("matching-pair", "Matching pair motion", ["%"]),
        capability("column", "Column motion", ["|"]),
        capability("find", "Find/till motions", ["f", "F", "t", "T", ";", ","]),
      ],
    },
    {
      id: "operators",
      label: "Operators and changes",
      capabilities: [
        capability("delete", "Delete operator", ["d", "x", "X", "D"]),
        capability("change", "Change operator", ["c", "s", "S", "C"]),
        capability("yank", "Yank operator", ["y", "Y"]),
        capability("put", "Put", ["p", "P"]),
        capability("indent", "Indent and outdent", [">", "<"]),
        capability("format", "Reindent operator", ["="] ),
        capability("case", "Case operators", ["~", "g~", "gu", "gU"]),
        capability("join", "Join lines", ["J"]),
        capability("undo-redo", "Undo and redo", ["u", "<C-r>"]),
        capability("repeat", "Repeat last change", ["."]),
      ],
    },
    {
      id: "text-objects",
      label: "Text objects",
      capabilities: [
        capability("word-object", "Word", ["iw", "aw", "iW", "aW"]),
        capability("sentence-object", "Sentence", ["is", "as"]),
        capability("paragraph-object", "Paragraph", ["ip", "ap"]),
        capability("pair-object", "Pairs", ["i()", "a()", "i[]", "a[]", "i{}", "a{}", "i<>", "a<>"]),
        capability("quote-object", "Quotes", ["i\"", "a\"", "i'", "a'", "i`", "a`"]),
      ],
    },
    {
      id: "state",
      label: "Registers, macros, marks and jumps",
      capabilities: [
        capability("registers", "Unnamed, numbered, small-delete and named registers", ['"', "0", "1-9", "-", "a-z", "A-Z"]),
        capability("black-hole-register", "Black-hole register", ['"_']),
        capability("clipboard-registers", "System clipboard registers", ['"+', '"*']),
        capability("macros", "Record and replay macros", ["q", "@"]),
        capability("marks", "Set and jump to marks", ["m", "'", "`"]),
        capability("jump-list", "Jump list navigation", ["<C-o>", "<C-i>"]),
      ],
    },
    {
      id: "search-ex",
      label: "Search and Ex",
      capabilities: [
        capability("search", "Forward/backward search and repeat", ["/", "?", "n", "N"]),
        capability("substitute", "Line and whole-buffer substitution", [":s", ":%s"]),
        capability("files", "Save, quit, edit and split", [":w", ":q", ":wq", ":x", ":e", ":sp", ":vsp"]),
        capability("inspection", "Register, mark and jump inspection", [":registers", ":marks", ":jumps"]),
        capability("options", "Local option changes", [":set", ":setlocal"]),
        capability("normal-ex", "Normal and sort Ex commands", [":normal", ":sort"]),
        capability("obsidian-ex", "Obsidian command bridge", [":obcommand"]),
        capability("external-ex", "Authorized external command", [":!"]),
      ],
    },
    {
      id: "vimrc",
      label: "vimrc",
      capabilities: [
        capability("vimrc-options", "set and setlocal"),
        capability("vimrc-mappings", "Recursive and non-recursive mappings and unmap"),
        capability("vimrc-leader", "mapleader"),
        capability("vimrc-abbreviations", "Insert abbreviations and unabbreviate"),
        capability("vimrc-source", "Sandboxed source"),
        capability("vimrc-commands", "Custom Ex commands"),
        capability("vimrc-autocmd", "Controlled autocmd groups"),
        capability("vimrc-errors", "Unsupported Vimscript and expr rejection"),
      ],
    },
  ] satisfies readonly VimCapabilityGroup[],
} as const;

export function vimCapabilities(): readonly VimCapability[] {
  return VIM_CAPABILITY_MANIFEST.groups.flatMap((group) => group.capabilities);
}

function capability(
  id: string,
  label: string,
  keys?: readonly string[],
): VimCapability {
  return keys ? { id, label, keys } : { id, label };
}
