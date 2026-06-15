export type DiffDecision = "accept" | "reject";

export class DiffSession {
  private resolved = false;

  constructor(
    readonly id: string,
    readonly originalContents: string,
    readonly proposedContents: string,
    private readonly resolver: (decision: DiffDecision, contents: string) => void,
  ) {}

  resolve(decision: DiffDecision, contents = this.proposedContents): boolean {
    if (this.resolved) return false;
    this.resolved = true;
    this.resolver(decision, contents);
    return true;
  }

  get isResolved(): boolean {
    return this.resolved;
  }
}
