// Native DSH plugin-settings card for @mv-aide/mv-dsh-subworkspace.
//
// Schema shape owned here: { version, workspaces: { <canonicalPrimaryPath>:
// { enabled: boolean, children: [{ id, path, label }] } } }. The card edits only
// the per-primary `enabled` flag; children are managed by the in-app "关联工作区"
// popover. The browser SettingsScope is deliberately read/subscription-only for
// this dynamic nested dictionary: DSH exposes set/unset for top-level fields,
// not a public nested mutate method. Saves therefore reuse this plugin's
// `/enabled` endpoint, which reaches the serialized SubworkspaceStore and
// preserves children without replacing a stale browser snapshot.
//
// Scope deltas remain read-side metadata for the "已覆盖" badge; writes are
// acknowledged by the endpoint and then reconciled when that scope mirror
// publishes the persisted value.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-subworkspace/settings-client',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const compat = require('@mv-aide/mv-dsh-compat/client/subworkspace');
    const NS = 'mv-dsh-subworkspace';

    const languageIsZh = () => String(document.documentElement?.lang || navigator.language || '').toLowerCase().startsWith('zh');

    // Card chrome mirrored 1:1 from DSH's native PluginCard/fields CSS modules
    // (packages/client/ui-settings-plugins) so the injected card is visually
    // indistinguishable from the Host's own cards in both themes.
    const CARD_CSS = `
.mva-spc-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.mva-spc-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.mva-spc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mva-spc-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.mva-spc-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.mva-spc-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mva-spc-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.mva-spc-chevronOpen{transform:rotate(180deg)}
.mva-spc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.mva-spc-readonly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-disclose{appearance:none;border:none;background:none;padding:0;margin-top:4px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:4px;text-align:left}
.mva-spc-disclose:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.mva-spc-discloseChevron{transition:transform .16s;color:var(--dsw-alias-label-tertiary);flex:none}
.mva-spc-discloseChevronOpen{transform:rotate(90deg)}
.mva-spc-children{margin:8px 0 4px;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:6px}
.mva-spc-children[data-disabled="true"]{opacity:.55}
.mva-spc-childrenLoading{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-style:italic}
.mva-spc-child{display:flex;align-items:center;gap:8px;min-width:0}
.mva-spc-childText{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.mva-spc-childLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-childPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.mva-spc-childRemove{appearance:none;border:none;background:none;padding:0 2px;font:inherit;font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none}
.mva-spc-childRemove:hover:not(:disabled){color:var(--dsw-alias-label-error)}
.mva-spc-childRemove:disabled{cursor:default;opacity:.4}
.mva-spc-childrenActions{margin-top:2px;display:flex;justify-content:flex-start}
.mva-spc-addDir{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:none;padding:3px 10px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mva-spc-addDir:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-addDir:disabled{opacity:.4;cursor:default}
.mva-spc-childError{margin:2px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.mva-spc-childEmpty{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-style:italic}
.mva-spc-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.mva-spc-field+.mva-spc-field{border-top:1px solid var(--dsw-alias-border-l2)}
.mva-spc-fieldHead{display:flex;align-items:center;gap:8px}
.mva-spc-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-sub{padding:12px 0 0}
.mva-spc-subtitle{display:flex;align-items:center;gap:8px}
.mva-spc-subtext{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.mva-spc-subname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-subpath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.mva-spc-badges{display:inline-flex;align-items:center;gap:8px}
.mva-spc-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.mva-spc-badgeCurrent{margin-left:6px;vertical-align:1px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mva-spc-sub[data-detached="true"]{opacity:.6}
.mva-spc-enable{display:flex;align-items:center;gap:8px;margin:6px 0 0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);cursor:pointer}
.mva-spc-enable:hover{border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-enableLabel{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}
.mva-spc-check{accent-color:var(--dsw-alias-brand-primary);width:15px;height:15px;margin:0;flex:none}
.mva-spc-empty{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.mva-spc-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}
.mva-spc-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error);white-space:pre-wrap}
.mva-spc-discard,.mva-spc-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.mva-spc-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.mva-spc-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.mva-spc-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.mva-spc-discard:disabled,.mva-spc-save:disabled{opacity:.4;cursor:default}
.mva-spc-discard:focus-visible,.mva-spc-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`;
    const ensureCardStyle = () => {
      // A DSH browser half: Obsidian's styles.css pipeline does not reach the
      // DSH web document, so the card carries its own stylesheet as a
      // constructable sheet (no <style> element). Every browser that runs the
      // DSH web UI supports constructable stylesheets.
      if (typeof document === 'undefined' || typeof CSSStyleSheet !== 'function' || !Array.isArray(document.adoptedStyleSheets)) return;
      const marker = window;
      const sheet = new CSSStyleSheet();
      // Per-plugin guard: sibling cards (mv-agent / mv-dsh-manager / mv-dsh-subworkspace)
      // share the page but own disjoint class sets, so each must inject its own sheet
      // regardless of the others. Self-heal when the window marker survives an HMR
      // reload that dropped the adopted sheet.
      if (marker.__MVA_DSH_SUBWORKSPACE_CARD_STYLE__ && document.adoptedStyleSheets.includes(marker.__MVA_DSH_SUBWORKSPACE_CARD_STYLE__)) return;
      sheet.replaceSync(CARD_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      marker.__MVA_DSH_SUBWORKSPACE_CARD_STYLE__ = sheet;
    };
    // Byte-for-byte copy of DSH's IconChevronDownOutline14 glyph, so the card
    // needs no extra module require to draw the native disclosure chevron.
    const CHEVRON_PATH = 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z';
    const chevron = (open) => React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true,
      className: open ? 'mva-spc-chevron mva-spc-chevronOpen' : 'mva-spc-chevron',
    }, React.createElement('path', { d: CHEVRON_PATH, fill: 'currentColor' }));

    const safeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalizeWorkspaces = (value) => {
      const source = safeObject(value);
      const out = {};
      for (const [primary, entry] of Object.entries(source)) {
        const node = safeObject(entry);
        out[primary] = {
          // Mirror store copyState: explicit false stays false, everything
          // else (including legacy entries with no flag) resolves enabled.
          enabled: node.enabled === false ? false : true,
          children: Array.isArray(node.children) ? node.children : [],
        };
      }
      return out;
    };
    const userLeaf = (user, primary) => safeObject(safeObject(user).workspaces?.[primary])?.enabled;

    // Same API base the in-conversation popover drives; the card shares the
    // endpoint surface so per-card child mutations stay serialised with
    // popover mutations through the store.
    const API = '/api/mv-dsh-subworkspace';
    const errMessage = (error) => error instanceof Error ? error.message : String(error);
    const apiRequest = async (path, options) => {
      const response = await window.fetch(`${API}${path}`, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    };

    const persistEnabledDrafts = async (drafts, request = apiRequest) => {
      const entries = Object.entries(safeObject(drafts));
      const settled = await Promise.allSettled(entries.map(([primary, enabled]) => request('/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary, enabled: enabled === true }),
      })));
      const accepted = {};
      const rejected = {};
      settled.forEach((result, index) => {
        const [primary, enabled] = entries[index];
        if (result.status === 'fulfilled') accepted[primary] = enabled === true;
        else rejected[primary] = errMessage(result.reason);
      });
      return { accepted, rejected };
    };

    const normalizePath = (value) => typeof value === 'string'
      ? value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
      : '';
    // The settings page manages every primary workspace DSH knows about, not
    // just the one the current session lives in. The workspace service list
    // is the source of truth for which primaries exist (and their sidebar
    // order); persisted settings entries merge onto matching list rows.
    // Configured primaries that no longer match any DSH workspace (renamed,
    // moved, or removed) stay listed as detached rows at the end so their
    // configured directories remain manageable — disabling/removal never
    // drops persisted children.
    const buildDisplayRows = (workspaceItems, configuredWorkspaces, currentPath) => {
      const items = Array.isArray(workspaceItems) ? workspaceItems : [];
      const configured = safeObject(configuredWorkspaces);
      const remaining = new Map();
      for (const primary of Object.keys(configured)) remaining.set(normalizePath(primary), primary);
      const rows = [];
      for (const item of items) {
        if (typeof item?.path !== 'string' || item.path.length === 0) continue;
        const pathKey = normalizePath(item.path);
        if (!pathKey) continue;
        const configuredKey = remaining.get(pathKey);
        if (configuredKey !== undefined) remaining.delete(pathKey);
        const entry = safeObject(configured[configuredKey]);
        const hasEntry = configuredKey !== undefined;
        rows.push({
          primary: hasEntry ? configuredKey : item.path,
          title: typeof item.title === 'string' && item.title.length > 0 ? item.title : null,
          configured: hasEntry,
          detached: false,
          current: normalizePath(currentPath) === pathKey,
          // Unconfigured rows display as off: the schema default for new
          // primaries is disabled. Display-only — nothing is written until
          // the user explicitly saves a draft for that row.
          enabled: hasEntry ? (entry.enabled === false ? false : true) : false,
          childrenCount: hasEntry && Array.isArray(entry.children) ? entry.children.length : 0,
        });
      }
      for (const primary of remaining.values()) {
        const entry = safeObject(configured[primary]);
        rows.push({
          primary,
          title: null,
          configured: true,
          detached: true,
          current: normalizePath(currentPath) === normalizePath(primary),
          enabled: entry.enabled === false ? false : true,
          childrenCount: Array.isArray(entry.children) ? entry.children.length : 0,
        });
      }
      return rows;
    };

    // Full primary workspace list plus the current workspace path. The
    // browser side shares one cordis runtime with client-runtime, which
    // exposes the workspace service on the reflection slot 'workspaces'
    // (dsh-client-runtime ctx.reflect.provide('workspaces', this)). Its list
    // snapshot has { items: [{workspaceId, path, sessionIds, ...}],
    // recentWorkspaceId }; the sessions service exposes a list snapshot with
    // `current`. Current-path selection order: current session's workspace →
    // recent workspace → null (nothing connected yet).
    const useWorkspaceList = (ctx) => {
      // getSnapshot must return a stable reference: useSyncExternalStore
      // compares snapshots with Object.is on every render, so constructing a
      // fresh object each call would loop re-renders until React throws and
      // the host drops the whole card. Version the cache by the underlying
      // snapshot references instead — DSH service snapshots are replaced, not
      // mutated, so a changed (snap, currentSessionId) pair is new content.
      const cached = { key: null, result: { items: [], currentPath: null } };
      const getSnapshot = () => {
        const workspaces = compat.resolveWorkspaceClient(ctx)?.workspaces;
        const sessions = compat.resolveSessions(ctx)?.sessions;
        const snap = workspaces?.list?.getSnapshot?.();
        const items = snap && Array.isArray(snap.items) ? snap.items : [];
        const currentSessionId = sessions?.list?.getSnapshot?.()?.current;
        if (cached.key !== null && cached.key[0] === snap && cached.key[1] === currentSessionId) return cached.result;
        const byCurrent = currentSessionId == null ? undefined
          : items.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(currentSessionId));
        const byRecent = snap?.recentWorkspaceId
          ? items.find((w) => w?.workspaceId === snap.recentWorkspaceId)
          : undefined;
        const chosen = byCurrent ?? byRecent;
        const result = {
          items,
          currentPath: typeof chosen?.path === 'string' ? chosen.path : null,
        };
        cached.key = [snap, currentSessionId];
        cached.result = result;
        return result;
      };
      return React.useSyncExternalStore(
        (listener) => {
          const workspaces = compat.resolveWorkspaceClient(ctx)?.workspaces;
          const sessions = compat.resolveSessions(ctx)?.sessions;
          const subscriptions = [];
          if (typeof workspaces?.list?.subscribe === 'function') subscriptions.push(workspaces.list.subscribe(listener));
          if (typeof sessions?.list?.subscribe === 'function') subscriptions.push(sessions.list.subscribe(listener));
          return () => { for (const sub of subscriptions) { try { typeof sub === 'function' ? sub() : sub?.unsubscribe?.(); } catch { /* ignore */ } } };
        },
        getSnapshot,
      );
    };

    // Renders the per-primary child manager. Fetches the freshest children
    // from the plugin's own endpoint (not the settings snapshot, which can
    // go stale while the popover mutates the same store). All operations
    // (add, remove) are immediate and skip the card's save/draft cycle —
    // same interaction model the popover uses.
    function ChildrenPanel({ ctx, primary, enabled, zh }) {
      const h = React.createElement;
      // phase: 'idle' | 'loading' | 'ready' | 'error'
      // op: null | { kind: 'add' } | { kind: 'remove', id }
      const [phase, setPhase] = React.useState('idle');
      const [items, setItems] = React.useState([]);
      const [op, setOp] = React.useState(null);
      const [fetchError, setFetchError] = React.useState(null);

      const refresh = React.useCallback(async () => {
        setPhase('loading');
        setFetchError(null);
        try {
          const data = await apiRequest(`/roots?primary=${encodeURIComponent(primary)}`);
          const roots = Array.isArray(data.roots) ? data.roots.filter((root) => root && root.primary !== true) : [];
          setItems(roots);
          setPhase('ready');
        } catch (error) {
          setFetchError(errMessage(error));
          setPhase('error');
        }
      }, [primary]);

      React.useEffect(() => { refresh().catch(() => {}); }, [refresh]);

      const removeChild = async (id) => {
        if (op) return;
        setOp({ kind: 'remove', id });
        setFetchError(null);
        try {
          await apiRequest('/roots', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ primary, workspaceId: id }),
          });
          await refresh();
        } catch (error) {
          setFetchError(errMessage(error));
        } finally {
          setOp(null);
        }
      };

      const addChild = async () => {
        if (op) return;
        // Resolve at call time, not at render time: the render-time capture can
        // predate the ui-workspace plugin's apply (whose `uiWorkspace` service
        // provides pickDirectory on Alpha), so a stale adapter stays picker-less
        // even though the service is up by the moment the user clicks. Preview
        // (rc.2) resolves through the same call and is unaffected.
        const picker = compat.resolveWorkspaceClient(ctx)?.pickDirectory;
        if (typeof picker !== 'function') {
          setFetchError(zh ? '当前环境不支持目录选择器。' : 'Directory picker unavailable in this environment.');
          return;
        }
        setOp({ kind: 'add' });
        setFetchError(null);
        try {
          const selected = await picker();
          if (selected) {
            await apiRequest('/roots', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ primary, path: selected }),
            });
            await refresh();
          }
        } catch (error) {
          setFetchError(errMessage(error));
        } finally {
          setOp(null);
        }
      };

      const disableActions = !enabled || op !== null;
      return h('div', { className: 'mva-spc-children', role: 'region', 'aria-label': zh ? '已配置的关联目录' : 'Configured directories', ...(enabled ? {} : { 'data-disabled': 'true' }) },
        phase === 'loading' && items.length === 0
          ? h('p', { className: 'mva-spc-childrenLoading', role: 'status' }, zh ? '加载目录列表…' : 'Loading directories…')
          : null,
        phase === 'ready' && items.length === 0
          ? h('p', { className: 'mva-spc-childEmpty' }, zh ? '尚未添加关联目录。' : 'No directories added yet.')
          : null,
        items.map((root) => h('div', { key: root.id, className: 'mva-spc-child' },
          h('div', { className: 'mva-spc-childText' },
            h('span', { className: 'mva-spc-childLabel' }, `${root.label || root.path}${root.valid ? '' : (zh ? ' · 不可用' : ' · unavailable')}`),
            h('span', { className: 'mva-spc-childPath' }, root.error || root.path)),
          h('button', {
            type: 'button',
            className: 'mva-spc-childRemove',
            disabled: disableActions,
            'aria-label': `${zh ? '移除' : 'Remove'} ${root.label || root.path}`,
            onClick: () => { removeChild(root.id).catch(() => {}); },
          }, '×'))),
        h('div', { className: 'mva-spc-childrenActions' },
          h('button', {
            type: 'button',
            className: 'mva-spc-addDir',
            disabled: disableActions,
            title: !enabled ? (zh ? '启用关联工作区后可添加目录' : 'Enable associated workspaces to add directories') : undefined,
            onClick: () => { addChild().catch(() => {}); },
          }, op?.kind === 'add' ? (zh ? '选择目录中…' : 'Picking…') : (zh ? '添加目录' : 'Add directory'))),
        fetchError ? h('p', { className: 'mva-spc-childError', role: 'status' }, fetchError) : null);
    }

    function Card({ scope, ctx }) {
      const snapshot = React.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      );
      const zh = languageIsZh();
      const value = safeObject(snapshot.value);
      const workspaces = normalizeWorkspaces(value.workspaces);
      const user = safeObject(snapshot.user);
      const { items: workspaceItems, currentPath } = useWorkspaceList(ctx);
      const rows = React.useMemo(
        () => buildDisplayRows(workspaceItems, workspaces, currentPath),
        [workspaceItems, workspaces, currentPath],
      );
      const [open, setOpen] = React.useState(false);
      const [expandedPrimary, setExpandedPrimary] = React.useState(null);
      // draft contains unsaved user choices. acknowledged contains successful
      // endpoint writes that the asynchronous settings mirror has not reflected
      // yet; it prevents a successful checkbox from flashing back to stale data.
      const [draft, setDraft] = React.useState({});
      const [acknowledged, setAcknowledged] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [saveErrors, setSaveErrors] = React.useState({});
      const dirty = Object.keys(draft).length > 0;
      const h = React.createElement;
      // Drafts and the child-panel expansion are keyed by primary path, so a
      // session switch (or the workspace list updating) never needs to reset
      // them — every row stays visible regardless of which primary is
      // current.
      const setFlag = (primary, enabled) => {
        setSaveErrors((current) => {
          if (!Object.prototype.hasOwnProperty.call(current, primary)) return current;
          const next = { ...current };
          delete next[primary];
          return next;
        });
        setDraft((current) => ({ ...current, [primary]: enabled === true }));
      };
      React.useEffect(() => {
        const reflected = new Map(rows.map((row) => [row.primary, row]));
        setAcknowledged((current) => {
          let changed = false;
          const next = { ...current };
          for (const [primary, enabled] of Object.entries(current)) {
            const row = reflected.get(primary);
            if (row?.configured === true && row.enabled === (enabled === true)) {
              delete next[primary];
              changed = true;
            }
          }
          return changed ? next : current;
        });
      }, [rows]);
      const save = async () => {
        if (!dirty || saving || !snapshot.writable) return;
        const attempted = { ...draft };
        setSaving(true);
        try {
          const { accepted, rejected } = await persistEnabledDrafts(attempted);
          setAcknowledged((current) => ({ ...current, ...accepted }));
          setDraft((current) => {
            const next = { ...current };
            for (const [primary, enabled] of Object.entries(accepted)) {
              if (next[primary] === enabled) delete next[primary];
            }
            return next;
          });
          setSaveErrors((current) => {
            const next = { ...current };
            for (const primary of Object.keys(attempted)) delete next[primary];
            return { ...next, ...rejected };
          });
        } finally {
          setSaving(false);
        }
      };
      // `!open`: the card header alone stays mounted even when the body isn't.
      // `status !== 'ready'`: while the settings mirror is still warming up
      // (initial fetch in flight) we render the shell so the card is present
      // in the section's card list and never flickers in/out; the body is
      // replaced by a small loading hint instead of vanishing entirely.
      const loading = snapshot.status !== 'ready';
      ensureCardStyle();
      const rowElements = rows.map((row) => {
        const { primary } = row;
        const hasDraft = Object.prototype.hasOwnProperty.call(draft, primary);
        const hasAcknowledged = Object.prototype.hasOwnProperty.call(acknowledged, primary);
        // buildDisplayRows already resolved each row's effective enabled value
        // (legacy no-flag entries → on; unconfigured primaries → schema
        // default off), so the draft only overrides the row value.
        const shown = hasDraft
          ? draft[primary]
          : hasAcknowledged
            ? acknowledged[primary]
            : row.enabled;
        const leaf = userLeaf(user, primary);
        const overridden = row.configured && leaf !== undefined;
        const name = row.title || primary.split(/[\\/]/).filter(Boolean).pop() || primary;
        const expanded = expandedPrimary === primary;
        return h('div', { key: primary, className: 'mva-spc-sub', ...(row.detached ? { 'data-detached': 'true' } : {}) },
          h('div', { className: 'mva-spc-subtitle' },
            h('div', { className: 'mva-spc-subtext' },
              h('span', { className: 'mva-spc-subname' },
                name,
                row.current ? h('span', { className: 'mva-spc-badge mva-spc-badgeCurrent' }, zh ? '当前' : 'Current') : null),
              h('span', { className: 'mva-spc-subpath' }, primary),
              h('label', { className: 'mva-spc-enable' },
                h('span', { className: 'mva-spc-enableLabel' }, zh ? '开启子工作区' : 'Enable subworkspace'),
                h('input', {
                  type: 'checkbox',
                  className: 'mva-spc-check',
                  checked: Boolean(shown),
                  disabled: !snapshot.writable,
                  'aria-label': `${zh ? '开启子工作区' : 'Enable subworkspace'}: ${primary}`,
                  onChange: (event) => setFlag(primary, event.target.checked),
                })),
              h('button', {
                type: 'button',
                className: 'mva-spc-disclose',
                'aria-expanded': expanded,
                onClick: () => setExpandedPrimary(expanded ? null : primary),
              },
                h('svg', {
                  width: 10, height: 10, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true,
                  className: expanded ? 'mva-spc-discloseChevron mva-spc-discloseChevronOpen' : 'mva-spc-discloseChevron',
                }, h('path', { d: CHEVRON_PATH, fill: 'currentColor' })),
                row.detached
                  ? (zh ? `已不在工作区列表 · 已配置 ${row.childrenCount} 个` : `No longer in workspace list · ${row.childrenCount} configured`)
                  : (zh ? `已配置 ${row.childrenCount} 个` : `${row.childrenCount} configured`))),
            overridden ? h('span', { className: 'mva-spc-badges' },
              h('span', { className: 'mva-spc-badge' }, zh ? '已覆盖' : 'Overridden')) : null),
          expanded ? h(ChildrenPanel, { key: 'children', ctx, primary, enabled: Boolean(shown), zh }) : null);
      });
      const bodyChildren = [];
      if (loading) {
        bodyChildren.push(h('p', { key: 'loading', className: 'mva-spc-readonly', role: 'status' }, zh ? '设置加载中…' : 'Loading settings…'));
      } else if (rows.length === 0) {
        bodyChildren.push(h('p', { key: 'empty', className: 'mva-spc-empty' }, zh
          ? '还没有任何 DSH 主工作区。在主页创建工作区后，即可在此为它配置关联目录。'
          : 'No DSH primary workspaces yet. Create a workspace from the home page, then configure its associated directories here.'));
      } else {
        if (!snapshot.writable) bodyChildren.push(h('p', { key: 'readonly', className: 'mva-spc-readonly', role: 'status' }, zh ? '当前设置文档只读。' : 'The settings document is read-only.'));
        bodyChildren.push(h('div', { key: 'field', className: 'mva-spc-field' },
          h('div', { className: 'mva-spc-fieldHead' },
            h('label', { className: 'mva-spc-label' }, zh ? '开启子工作区' : 'Enable subworkspace'))));
        for (const element of rowElements) bodyChildren.push(element);
      }
      const rowNames = new Map(rows.map((row) => [
        row.primary,
        row.title || row.primary.split(/[\\/]/).filter(Boolean).pop() || row.primary,
      ]));
      const failureText = Object.entries(saveErrors)
        .map(([primary, message]) => `${rowNames.get(primary) || primary}: ${message}`)
        .join('\n');
      bodyChildren.push(h('div', { key: 'footer', className: 'mva-spc-footer' },
        failureText ? h('p', { className: 'mva-spc-failed', role: 'status' }, `${zh ? '保存失败，草稿已保留。' : 'Save failed; the draft was kept.'}\n${failureText}`) : null,
        h('button', { key: 'discard', type: 'button', className: 'mva-spc-discard', disabled: !dirty || saving, onClick: () => { setDraft({}); setSaveErrors({}); } }, zh ? '放弃修改' : 'Discard'),
        h('button', { key: 'save', type: 'button', className: 'mva-spc-save', disabled: !dirty || saving || !snapshot.writable, onClick: save }, saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save'))));
      return h('li', { className: open ? 'mva-spc-card mva-spc-cardOpen' : 'mva-spc-card' },
        h('button', {
          type: 'button', className: 'mva-spc-header', 'aria-expanded': open,
          'aria-label': `${zh ? (open ? '收起设置' : '展开设置') : (open ? 'Hide settings' : 'Show settings')}: mv-dsh-subworkspace`,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'mva-spc-headText' },
            h('span', { className: 'mva-spc-name' }, 'mv-dsh-subworkspace'),
            h('span', { className: 'mva-spc-description' }, zh ? '为每个主工作区启用关联工作区，并向原生工具注入 _workspace。' : 'Enable associated workspaces per primary workspace and inject _workspace into native tools.')),
          dirty ? h('span', { className: 'mva-spc-pending' }, zh ? '未保存' : 'Unsaved') : null,
          chevron(open)),
        open ? h('div', { className: 'mva-spc-body' }, ...bodyChildren) : null,
      );
    }

    function install(ctx) {
      if (typeof ctx?.inject !== 'function') return;
      ctx.inject(['slots', 'settingsScope'], (settingsCtx) => {
        const host = compat.resolveSettingsCardHost(settingsCtx);
        if (!host) return;
        const { slots, settingsScope } = host;
        const scope = settingsScope.bind({ namespace: NS });
        slots.inject('settings.plugin.item', () => slots.register({
          name: 'settings.plugin.item', key: NS,
        }, () => React.createElement(Card, { scope, ctx })));
      });
    }

    module.exports = { install, __test: { normalizePath, buildDisplayRows, persistEnabledDrafts } };
    return module.exports;
  },
});
