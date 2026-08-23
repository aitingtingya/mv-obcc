const TERMINAL_TOOL_NAMES = new Set([
  'listTerminals',
  'readTerminal',
  'sendTerminalInput',
  'runInTerminal',
  'openTerminal',
  'focusTerminal',
  'closeTerminal',
]);

export function isEnhancedTerminalTool(name) {
  return TERMINAL_TOOL_NAMES.has(name);
}

export function terminalAwareToolDefinitions(ideTools, enhanced) {
  const byName = new Map();
  for (const tool of Array.isArray(ideTools) ? ideTools : []) {
    if (!tool?.name) continue;
    if (enhanced && tool.name === 'getTerminalOutput') continue;
    byName.set(tool.name, tool);
  }
  if (enhanced) {
    for (const tool of enhancedTerminalToolDefinitions()) byName.set(tool.name, tool);
  }
  return [...byName.values()];
}

export function enhancedTerminalToolDefinitions() {
  return [
    {
      name: 'listTerminals',
      description: 'List mv-AIDE integrated terminals and identify the active/recent terminal.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'readTerminal',
      description:
        'Read recent output from an mv-AIDE integrated terminal. Defaults to the recent terminal. '
        + 'Omitting lastN reads up to 50 lines of actual content (smart mode: skips blank viewport '
        + 'padding, so an idle shell reports its prompt). Passing lastN reads exactly that many '
        + 'trailing physical rows instead. When the tail is still empty (output not flushed yet), '
        + 'retries for up to waitMs milliseconds before returning. A terminal tab restored after '
        + 'Obsidian restart starts a fresh shell and waits for its new prompt; old scrollback is not restored.',
      inputSchema: {
        type: 'object',
        properties: {
          terminalId: { type: 'string' },
          lastN: { type: 'number', minimum: 1, maximum: 500 },
          waitMs: { type: 'number', minimum: 0, maximum: 5000, default: 0 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'sendTerminalInput',
      description:
        'Send byte-verbatim input to an mv-AIDE integrated terminal; optionally append Enter. '
        + 'Shell metacharacters keep their native meaning; use this for keystrokes, Ctrl+C, TUI, '
        + 'and REPL input, and use runInTerminal for shell commands that need reliable quoting.',
      inputSchema: {
        type: 'object',
        properties: {
          terminalId: { type: 'string' },
          input: { type: 'string' },
          submit: { type: 'boolean', default: false },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
    {
      name: 'runInTerminal',
      description:
        'Reliably run a shell command in the current integrated shell, preserving quotes, bangs, '
        + 'whitespace, Unicode, multiline text, and shell state. This is the command-execution '
        + 'entry point; optionally force a new terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          terminalId: { type: 'string' },
          newTerminal: { type: 'boolean', default: false },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
    {
      name: 'openTerminal',
      description: 'Create a new mv-AIDE integrated terminal and return its runtime terminal id.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'focusTerminal',
      description: 'Reveal and focus a specific mv-AIDE integrated terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          terminalId: { type: 'string' },
        },
        required: ['terminalId'],
        additionalProperties: false,
      },
    },
    {
      name: 'closeTerminal',
      description:
        'Close a specific mv-AIDE terminal tab and stop the PTY owned by that tab. '
        + 'This closes the Obsidian pane instead of merely sending exit to the shell.',
      inputSchema: {
        type: 'object',
        properties: {
          terminalId: { type: 'string' },
        },
        required: ['terminalId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function callEnhancedTerminalTool(client, name, args, signal) {
  switch (name) {
    case 'listTerminals':
      return client.listTerminals(signal);
    case 'readTerminal':
      return client.readTerminal(args ?? {}, signal);
    case 'sendTerminalInput':
      return client.sendTerminal(args ?? {}, signal);
    case 'runInTerminal':
      return client.runTerminal(args ?? {}, signal);
    case 'openTerminal':
      return client.openTerminal(signal);
    case 'focusTerminal':
      return client.focusTerminal(args ?? {}, signal);
    case 'closeTerminal':
      return client.closeTerminal(args ?? {}, signal);
    default:
      throw new Error(`Unknown enhanced terminal tool: ${name}`);
  }
}
