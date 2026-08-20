// @mv-aide/mv-dsh-manager — bridge discovery + static tool list for the
// recursive slash-command field picker.
//
// This module is deliberately self-contained: it only scans the unified
// mv-AIDE bridge registry for display purposes. Real connection still happens
// through the `/mv-aide connect` host command; this service never connects.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mvAideIdeDirectory } from './paths.js';

export const IDE_NAME = 'Obsidian';

/** Canonical mv-AIDE bridge registry. */
export function discoveryDirectories() {
  return [mvAideIdeDirectory()];
}

export function sortBridges(bridges) {
  return [...bridges].sort((a, b) => a.port - b.port);
}

/**
 * Scan the lock directories and return display-safe bridge endpoints.
 * @returns {Promise<Array<{port:number, workspaceFolders:string[]}>>}
 */
export async function discoverBridges(directories = discoveryDirectories()) {
  const list = Array.isArray(directories) ? directories : [directories];
  const byPort = new Map();
  for (const directory of list) {
    let entries;
    try {
      entries = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /^(\d+)\.lock$/u.exec(entry);
      if (!match) continue;
      const port = Number(match[1]);
      if (!Number.isInteger(port) || byPort.has(port)) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'));
      } catch {
        continue;
      }
      if (parsed?.ideName !== IDE_NAME || parsed?.transport !== 'ws') continue;
      if (typeof parsed.authToken !== 'string' || parsed.authToken.length === 0) continue;
      byPort.set(port, {
        port,
        workspaceFolders: Array.isArray(parsed.workspaceFolders)
          ? parsed.workspaceFolders
          : [],
      });
    }
  }
  return sortBridges([...byPort.values()]);
}

/** Public mv-AIDE IDE tools used by the `call` submenu. */
export function listTools() {
  return [
    { name: 'getLatestSelection', description: 'Get the latest Obsidian selection / cursor context' },
    { name: 'getOpenEditors', description: 'List currently open Obsidian tabs' },
    { name: 'openFile', description: 'Open a vault file in Obsidian' },
    { name: 'readCurrentWebPage', description: 'Read the current Web Viewer page as Markdown' },
    { name: 'getDiagnostics', description: 'Return current source-lint diagnostics' },
    { name: 'getTerminalOutput', description: 'Read trailing mv-AIDE terminal output' },
    { name: 'searchVaultSymbols', description: 'Search headings across the vault' },
    { name: 'getBacklinks', description: 'List notes linking to a file' },
    { name: 'getOutgoingLinks', description: 'List links from a file' },
    { name: 'searchTags', description: 'Search tags by substring' },
    { name: 'listNotesByTag', description: 'List notes carrying a tag' },
    { name: 'closeAllDiffTabs', description: 'Close all open Obsidian diff tabs' },
  ];
}
