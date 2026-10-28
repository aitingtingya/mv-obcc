import type { Terminal } from "@xterm/xterm";

/** Selected text owns its context menu; unselected clicks retain xterm's behavior. */
export function installTerminalContextMenu(
  host: HTMLElement,
  terminal: Pick<Terminal, "hasSelection" | "getSelection">,
  showMenu: (event: MouseEvent, selection: string) => void,
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 2 || !terminal.hasSelection()) return;
    // xterm reports TUI mouse presses as user input, which clears selection
    // before contextmenu. Do not send this selected-text gesture to the TUI.
    event.preventDefault();
    event.stopPropagation();
  };
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    showMenu(event, terminal.getSelection());
  };
  const onSelectedContextMenu = (event: MouseEvent) => {
    if (!terminal.hasSelection()) return;
    // Run before xterm's macOS right-click word selection can replace it.
    event.stopPropagation();
    openMenu(event);
  };
  host.addEventListener("mousedown", onMouseDown, true);
  host.addEventListener("contextmenu", onSelectedContextMenu, true);
  host.addEventListener("contextmenu", openMenu);
  return () => {
    host.removeEventListener("mousedown", onMouseDown, true);
    host.removeEventListener("contextmenu", onSelectedContextMenu, true);
    host.removeEventListener("contextmenu", openMenu);
  };
}
