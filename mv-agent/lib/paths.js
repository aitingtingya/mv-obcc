import os from 'node:os';
import path from 'node:path';

function mvAideHomeDirectory() {
  return path.join(os.homedir(), '.mv-aide');
}

export function mvAideIdeDirectory() {
  return path.join(mvAideHomeDirectory(), 'ide');
}

export function dshBridgeSelectionPath() {
  return path.join(mvAideHomeDirectory(), 'dsh', 'bridge-selection.json');
}

export function legacyDshBridgeSelectionPath() {
  return path.join(mvAideHomeDirectory(), 'dsh-bridge-selection.json');
}
