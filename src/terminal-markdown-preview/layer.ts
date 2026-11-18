/** A single popover stacking context per Obsidian window. Reorder by CSS so a
 * focused Markdown editor is never detached and reinserted on activation. */
interface PreviewLayer {
  host: HTMLElement;
  order: HTMLElement[];
}

const layers = new WeakMap<Document, PreviewLayer>();

export function mountTerminalPreview(root: HTMLElement) {
  const doc = root.ownerDocument;
  let layer = layers.get(doc);
  if (!layer) {
    layer = { host: doc.body.createDiv({ cls: "mv-aide-terminal-preview-layer" }), order: [] };
    layers.set(doc, layer);
  }
  const { host, order } = layer;
  host.appendChild(root);
  order.push(root);
  const applyOrder = () => order.forEach((item, index) => { item.style.zIndex = String(index); });
  applyOrder();
  return {
    activate() {
      const index = order.indexOf(root);
      if (index < 0 || index === order.length - 1) return;
      order.splice(index, 1);
      order.push(root);
      applyOrder();
    },
    remove() {
      const index = order.indexOf(root);
      if (index < 0) return;
      order.splice(index, 1);
      root.remove();
      if (order.length) applyOrder();
      else { host.remove(); layers.delete(doc); }
    },
  };
}
