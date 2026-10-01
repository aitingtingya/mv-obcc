// Canonical mv-AIDE system paths owned by @mv-aide/mv-dsh-compat.
//
// 规范三 registers every `~/.mv-aide/**` location and makes the owning package's
// `lib/paths.js` the only authority allowed to spell it; the workspace boundary
// checker (`scripts/check-vault-storage-boundary.mjs`) exempts exactly this file
// per package, so path literals live here instead of in the modules that use
// them.

import os from 'node:os';
import path from 'node:path';

/** Canonical mv-AIDE settings file: one user-level document for every plugin. */
export function mvAideSettingsFile(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, '.mv-aide', 'dsh', 'settings.json');
}
