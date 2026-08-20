export function createRememberedSettingsSubsection(
  containerEl: HTMLElement,
  id: string,
  title: string,
  openIds: Set<string>,
): HTMLElement {
  const document = containerEl.ownerDocument;
  const details = document.createElement("details");
  details.className = "mv-aide-settings-subsection";
  details.dataset.subsectionId = id;
  details.open = openIds.has(id);
  details.addEventListener("toggle", () => {
    if (details.open) {
      openIds.add(id);
    } else {
      openIds.delete(id);
    }
  });

  const summary = document.createElement("summary");
  summary.className = "mv-aide-settings-section-summary setting-item-name";
  summary.textContent = title;
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "mv-aide-settings-section-body";
  details.appendChild(body);
  containerEl.appendChild(details);
  return body;
}
