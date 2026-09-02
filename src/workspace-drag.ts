/** Cross-realm-safe classifier for Obsidian's native workspace-tab drag. */
export function isObsidianWorkspaceDragEvent(
  ownerDocument: Document,
  event: DragEvent,
): boolean {
  for (const entry of event.composedPath()) {
    const element = entry as Partial<Element> | null;
    if (element?.ownerDocument !== ownerDocument || typeof element.closest !== "function") {
      continue;
    }
    const header = element.closest<HTMLElement>(".workspace-tab-header");
    if (header?.draggable) return true;
  }
  return ownerDocument.body.classList.contains("is-grabbing") &&
    ownerDocument.querySelector(".workspace-drop-overlay") !== null;
}
