/** Only visual work is batched. Data delivery and readiness never await a frame. */
export class VisualFrame {
  private pending: { owner: Window; id: number } | null = null;

  request(owner: Window, render: () => void): void {
    if (this.pending) return;
    const id = owner.requestAnimationFrame(() => {
      this.pending = null;
      render();
    });
    this.pending = { owner, id };
  }

  cancel(): void {
    if (this.pending) this.pending.owner.cancelAnimationFrame(this.pending.id);
    this.pending = null;
  }
}
