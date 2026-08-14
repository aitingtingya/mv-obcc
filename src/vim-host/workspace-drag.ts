export function isObsidianWorkspaceDragEvent(
  ownerDocument: Document,
  event: DragEvent,
): boolean {
  const hostWindow = ownerDocument.defaultView;
  if (!hostWindow) return false;
  for (const entry of event.composedPath()) {
    if (!(entry instanceof hostWindow.Element)) continue;
    const header = entry.closest<HTMLElement>(".workspace-tab-header");
    if (header?.draggable) return true;
  }
  return ownerDocument.body.classList.contains("is-grabbing") &&
    ownerDocument.querySelector(".workspace-drop-overlay") !== null;
}
