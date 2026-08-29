// @mv-aide/mv-dsh-subworkspace — associated roots for native DSH tools.

import { installSubworkspaceServer } from './server.js';
import { installSubworkspaceSettings } from './settings.js';
import { SubworkspaceStore } from './store.js';
import { installToolDispatcher } from './tools.js';

export const name = 'mv-dsh-subworkspace';
export const inject = ['tools'];

export function apply(ctx) {
  const store = new SubworkspaceStore();
  installSubworkspaceSettings(ctx, store);
  installSubworkspaceServer(ctx, store);
  // The `workspace` tool and `_workspace` decoration are registered per agent
  // scope inside the dispatcher so a disabled primary resolves neither; no
  // global `workspace` registration exists to mask.
  const disposeDispatcher = installToolDispatcher(ctx, store);
  ctx.effect?.(() => disposeDispatcher, 'mv-dsh-subworkspace: tool dispatcher');
}
