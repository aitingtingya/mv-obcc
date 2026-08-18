export const HIDE_OBSIDIAN_STATUS_BAR_CLASS =
  "mv-aide-hide-obsidian-native-status-bar";

/** Toggle only the body class consumed by mv-AIDE's native status-bar CSS. */
export function applyObsidianStatusBarVisibility(
  doc: Document,
  hidden: boolean,
): void {
  doc.body.classList.toggle(HIDE_OBSIDIAN_STATUS_BAR_CLASS, hidden);
}

export function clearObsidianStatusBarVisibility(doc: Document): void {
  doc.body.classList.remove(HIDE_OBSIDIAN_STATUS_BAR_CLASS);
}
