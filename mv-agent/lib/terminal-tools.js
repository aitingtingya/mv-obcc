const TERMINAL_TOOL_NAMES = new Set([
  'listTerminals',
  'readTerminal',
  'sendTerminalInput',
  'runInTerminal',
  'openTerminal',
  'focusTerminal',
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
      description: 'Read recent lines from an mv-AIDE integrated terminal. Defaults to the recent terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          terminalId: { type: 'string' },
          lastN: { type: 'number', minimum: 1, maximum: 500, default: 50 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'sendTerminalInput',
      description: 'Send raw input to an mv-AIDE integrated terminal; optionally submit it with Enter.',
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
      description: 'Run a shell command in an mv-AIDE integrated terminal, optionally forcing a new terminal.',
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
    default:
      throw new Error(`Unknown enhanced terminal tool: ${name}`);
  }
}
