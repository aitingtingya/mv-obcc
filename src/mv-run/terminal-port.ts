import type { TerminalShellKind } from "../terminal/terminal-command";
import type { TerminalSessionEvent } from "../terminal/terminal-view";
import type { TerminalRegistry, TerminalRunOptions } from "../terminal-control/terminal-registry";

export interface RunTerminal {
  id: string;
  kind: TerminalShellKind;
  generation: number;
  currentGeneration(): number;
  alive(): boolean;
  send(command: string): Promise<void>;
  onControl(ident: number, handler: (data: string) => boolean): () => void;
  onSession(listener: (event: TerminalSessionEvent) => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(id: number): void;
}

export interface RunTerminalHost {
  acquire(options: TerminalRunOptions): Promise<RunTerminal>;
}

export function terminalHost(registry: TerminalRegistry): RunTerminalHost {
  return {
    async acquire(options) {
      const { terminalId, view, send } = await registry.prepareCommandTarget(options);
      const timerWindow = view.containerEl.ownerDocument.defaultView;
      if (!timerWindow) throw new Error("Terminal window closed");
      const generation = view.sessionGeneration();
      return {
        id: terminalId, kind: view.shellKind(), generation,
        currentGeneration: () => view.sessionGeneration(), alive: () => view.isShellAlive(),
        send: async command => {
          if (view.sessionGeneration() !== generation || !view.isShellAlive()) throw new Error("Terminal session changed");
          await send(command);
        },
        onControl: (ident, handler) => view.registerControlSequence(ident, handler),
        onSession: listener => view.subscribeSession(listener),
        setTimeout: (callback, milliseconds) => timerWindow.setTimeout(callback, milliseconds),
        clearTimeout: id => timerWindow.clearTimeout(id),
      };
    },
  };
}
