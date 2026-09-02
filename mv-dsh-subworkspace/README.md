# @mv-aide/mv-dsh-subworkspace

Independent DeepSeek Harness plugin for attaching non-overlapping associated directories to a primary Workspace. It adds the `workspace` tool and a `_workspace` selector to native workspace-aware tools. Multi-root calls run through independent, concurrent native DSH tool executions and return one labelled result per root.

The plugin does not depend on mv-AIDE's IDE bridge, `@mv-aide/mv-agent`, or `@mv-aide/mv-dsh-manager`. When those plugins are also installed, normal DSH tool-pipeline composition applies.

The Workspace-row control is mounted between DSH's native ellipsis and plus buttons. Its popover closes only when the button is toggled, Escape is pressed, or the pointer is clicked outside; moving anywhere inside the expanded region never closes it.

The model-facing contract is:

- `workspace({ action: "list" })` returns the primary root, every associated root, the stable IDs accepted by other tools, and the live session default.
- `workspace({ action: "switch", workspaceId })` changes only the current live session default; `reset` returns it to the primary root. The selection is intentionally not persisted across DSH restarts.
- Omit `_workspace` to use that live default, pass one ID for one root, pass a non-empty ID array for independent concurrent calls, or pass `"all"` for the primary root plus every associated root.
- Some model providers serialize an array argument into a plain JSON string (`_workspace: "[\"a\",\"b\"]"`). Such a string is parsed strictly: a well-formed non-empty JSON array of non-empty strings selects exactly the batch it encodes; anything else is not guessed at and falls through to the single-ID branch, surfacing the existing unknown-ID error with the raw text.
- Each selected root enters the complete native DSH tool pipeline with its own projected session cwd. Arguments are otherwise unchanged and `_workspace` is removed. Relative paths and default shell cwd therefore resolve per root, while absolute paths remain absolute.
- Multi-root results stay independent and ordered like the selector. A failure in one root is labelled and returned without cancelling its siblings.

Associated roots are canonicalized with `realpath` and revalidated before execution. Exact duplicates, aliases, ancestors, and descendants of the primary or any existing associated root are rejected; concurrent additions are serialized and rechecked.

## Settings card

The plugin registers its own DSH **Settings → Plugin configuration** card (`mv-dsh-subworkspace` namespace) whose schema is `{ version, workspaces: { <canonicalPrimaryPath>: { enabled, children } } }`. The card edits only the per-primary **Enable subworkspace** toggle — an explicit off persists as a real value (the `enabled` flag deliberately carries no schema default so a persisted `false` is never collapsed). Adding or removing directories stays in the in-app workspace-row popover; saves from the card go through the plugin's serialized `/enabled` endpoint, which reaches the store without replacing children from a stale browser snapshot. When the DSH settings service or browser slot is missing, associated roots keep working from the last persisted state.
