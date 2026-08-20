import os from 'node:os';
import path from 'node:path';

export function mvAideIdeDirectory() {
  return path.join(os.homedir(), '.mv-aide', 'ide');
}
