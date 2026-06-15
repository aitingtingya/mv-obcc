/**
 * Minimal declarations for semi-internal Obsidian APIs used by the LLM result
 * non-modal result surface (`llm-result-surface.ts`).
 *
 * These are NOT part of the public `obsidian.d.ts` contract:
 *  - Directly constructing `WorkspaceSplit` via `new` (the public type only
 *    exposes it as an abstract class you receive from the workspace).
 *  - `WorkspaceSplit.containerEl` — present at runtime but omitted from the
 *    public typings.
 *
 * Hover Editor uses the same technique. If Obsidian renames or removes these,
 * `LlmResultSurface` catches the failure and swaps its workspace host for an
 * editable textarea without opening a second window.
 */
import "obsidian";

declare module "obsidian" {
  interface WorkspaceSplit {
    /** DOM container of the split — present at runtime, missing from typings. */
    containerEl: HTMLElement;
  }
}

export {};
