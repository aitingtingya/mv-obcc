export interface RunTask {
  command: string;
  line: number;
  name?: string;
  groups: string[];
  protected: boolean;
  newTerminal: boolean;
}

export interface RunReference {
  kind: "task" | "group";
  name: string;
  respectProtection: boolean;
  column: number;
}

export interface RunPlan {
  steps: RunTask[];
  filtered: RunTask[];
}

export class RunSyntaxError extends Error {
  constructor(readonly reason: string, readonly column: number, readonly line?: number) {
    super(`${line === undefined ? "" : `${line}:`}${column}: ${reason}`);
    this.name = "RunSyntaxError";
  }
}
