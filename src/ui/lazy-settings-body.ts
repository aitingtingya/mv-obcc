/** Owns only rendering, never settings values or persistence. */
export class LazySettingsBody {
  private rendered = false;
  private readonly details: HTMLDetailsElement;
  private readonly onToggle = (): void => this.renderIfOpen();

  constructor(readonly body: HTMLElement, private readonly render: () => void) {
    this.details = body.parentElement as HTMLDetailsElement;
    this.details.addEventListener("toggle", this.onToggle);
  }

  renderIfOpen(): void {
    if (this.rendered || !this.details.open) return;
    this.rendered = true;
    this.render();
  }

  invalidate(): void {
    this.body.replaceChildren();
    this.rendered = false;
    this.renderIfOpen();
  }

  dispose(): void {
    this.details.removeEventListener("toggle", this.onToggle);
  }
}
