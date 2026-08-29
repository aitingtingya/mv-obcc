// Browser half for @mv-aide/mv-dsh-subworkspace.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-subworkspace',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const BUTTON_ATTR = 'data-mv-dsh-subworkspace-button';
    const API = '/api/mv-dsh-subworkspace';
    // Sibling module injected by the plugin bundle before this file; registers
    // the Settings card under `settings.plugin.item`. ModuleLoader passes the
    // plugin-graph require into the factory (same contract as mv-agent), so
    // `require('@mv-aide/mv-dsh-subworkspace/settings-client')` resolves.
    let settingsClient = null;
    try {
      settingsClient = typeof require === 'function' ? require('@mv-aide/mv-dsh-subworkspace/settings-client') : null;
    } catch {
      settingsClient = null;
    }
    const CSS = `
      [${BUTTON_ATTR}] { display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.72;cursor:pointer; }
      [${BUTTON_ATTR}]:hover,[${BUTTON_ATTR}][aria-expanded="true"] { background:color-mix(in srgb,currentColor 12%,transparent);opacity:1; }
      .mv-dsh-subworkspace-popover { box-sizing:border-box;position:fixed;left:12px;top:12px;z-index:10000;width:min(420px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));overflow:auto;padding:10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;background:var(--background-primary,#202020);color:var(--text-normal,#eee);box-shadow:0 12px 34px rgba(0,0,0,.35);font-size:13px; }
      .mv-dsh-subworkspace-title { font-weight:650;margin:1px 2px 9px; }
      .mv-dsh-subworkspace-root { display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:7px; }
      .mv-dsh-subworkspace-root:hover { background:color-mix(in srgb,currentColor 7%,transparent); }
      .mv-dsh-subworkspace-root-main { min-width:0;flex:1; }
      .mv-dsh-subworkspace-root-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550; }
      .mv-dsh-subworkspace-root-path { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.58;font-size:11px; }
      .mv-dsh-subworkspace-actions { display:flex;justify-content:flex-end;gap:8px;margin-top:9px;padding-top:9px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent); }
      .mv-dsh-subworkspace-action { border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:7px;background:transparent;color:inherit;padding:5px 9px;cursor:pointer; }
      .mv-dsh-subworkspace-action:hover { background:color-mix(in srgb,currentColor 9%,transparent); }
      .mv-dsh-subworkspace-remove { border:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font-size:16px; }
      .mv-dsh-subworkspace-error { color:var(--text-error,#ff6b6b);padding:6px;white-space:pre-wrap; }
      .mv-dsh-subworkspace-empty { opacity:.62;padding:8px 6px; }
      .mv-dsh-subworkspace-root[data-disabled="true"] { opacity:.45; }
      .mv-dsh-subworkspace-remove:disabled, .mv-dsh-subworkspace-action:disabled { opacity:.35;cursor:default; }
      .mv-dsh-subworkspace-enable { display:flex;align-items:center;gap:8px;padding:7px 6px;margin:0 0 6px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent); }
      .mv-dsh-subworkspace-enable-text { flex:1;min-width:0;font-weight:550; }
      .mv-dsh-subworkspace-enable-hint { opacity:.58;font-size:11px;font-weight:400; }
      .mv-dsh-subworkspace-enable input { accent-color:var(--interactive-accent,#4c8bf5);width:15px;height:15px;margin:0;cursor:pointer;flex:none; }
    `;

    function apply(ctx) {
      settingsClient?.install(ctx);
      const workspaces = ctx.workspaces;
      let popover = null;
      let anchor = null;
      let observer = null;
      let disposed = false;
      let styleSheet = null;

      function ensureStyle() {
        if (styleSheet || typeof window.CSSStyleSheet !== 'function') return;
        try {
          const sheet = new window.CSSStyleSheet();
          sheet.replaceSync(CSS);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          styleSheet = sheet;
        } catch {
          // DSH's supported browser has constructable sheets; UI remains usable without CSS on older hosts.
        }
      }

      function icon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '17');
        svg.setAttribute('height', '17');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const folder = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        folder.setAttribute('d', 'M3.5 7.5h6l2-2h9v13h-17z');
        const link = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        link.setAttribute('d', 'M8.2 13.8l2-2m-3.8-.7-1.2 1.2a2 2 0 0 0 2.8 2.8l1.2-1.2m1.6-1.8 1.2-1.2a2 2 0 0 0-2.8-2.8L8 9.3');
        svg.append(folder, link);
        return svg;
      }

      function actionContainer(row) {
        for (const child of row.children) {
          if (child.tagName === 'SPAN' && child.querySelectorAll('button').length >= 2) return child;
        }
        return null;
      }

      function workspaceRows() {
        return [...document.querySelectorAll('[role="treeitem"][aria-expanded]')]
          .map((row) => ({ row, actions: actionContainer(row) }))
          .filter((entry) => entry.actions !== null);
      }

      function positionPopover() {
        if (!popover || !anchor?.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        const gap = 6;
        const width = Math.min(420, window.innerWidth - 24);
        const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
        // Runs exactly once per open (from openPopover, before content fills).
        // Content-owning re-renders must NEVER re-anchor the popover: deriving
        // top from the anchor after every add/remove toggled the box between
        // "below" and "above" (or the top:12 clamp), which is the reported
        // "jumps to the top of the window". Overflow after growth is handled
        // by keepPopoverInViewport instead.
        const contentHeight = popover.offsetHeight || 0;
        const fitsBelow = rect.bottom + gap + contentHeight <= window.innerHeight - 12;
        const top = fitsBelow
          ? rect.bottom + gap
          : Math.max(12, rect.top - Math.min(contentHeight, window.innerHeight - 24) - gap);
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
      }

      // Guard the popover inside the viewport without resetting its open-time
      // anchor-derived position. Scroll/resize events (captured, so ancestor
      // container scrolls also fire) run this; it only writes top/left when
      // the box would otherwise leave the visible area.
      //
      // Position comes from the element's own style when present: after the
      // open-time placement, `style.top/left` are the authoritative pixel
      // coordinates. getBoundingClientRect() is only a fallback for hosts where
      // layout data is trustworthy (jsdom reports zeros for fixed boxes).
      function keepPopoverInViewport() {
        if (!popover || !anchor?.isConnected) return;
        const margin = 12;
        const rect = popover.getBoundingClientRect();
        const top = popover.style.top ? parseFloat(popover.style.top) : rect.top;
        const left = popover.style.left ? parseFloat(popover.style.left) : rect.left;
        const height = popover.offsetHeight || rect.height;
        const width = popover.offsetWidth || rect.width;
        if (Number.isFinite(top)) {
          if (top < margin) popover.style.top = `${margin}px`;
          else if (top + height > window.innerHeight - margin) {
            popover.style.top = `${Math.max(margin, window.innerHeight - margin - height)}px`;
          }
        }
        if (Number.isFinite(left)) {
          if (left < margin) popover.style.left = `${margin}px`;
          else if (left + width > window.innerWidth - margin) {
            popover.style.left = `${Math.max(margin, window.innerWidth - margin - width)}px`;
          }
        }
      }

      function closePopover() {
        popover?.remove();
        popover = null;
        if (anchor) anchor.setAttribute('aria-expanded', 'false');
        anchor = null;
      }

      async function request(path, options) {
        const response = await window.fetch(`${API}${path}`, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      }

      function errorRow(message) {
        const row = document.createElement('div');
        row.className = 'mv-dsh-subworkspace-error';
        row.textContent = message;
        return row;
      }

      async function renderPopover(primary, panel = popover) {
        if (!panel || panel !== popover) return;
        panel.replaceChildren();
        const title = document.createElement('div');
        title.className = 'mv-dsh-subworkspace-title';
        title.textContent = '关联工作区';
        panel.appendChild(title);
        let data;
        try {
          data = await request(`/roots?primary=${encodeURIComponent(primary)}`);
        } catch (error) {
          if (panel === popover) panel.appendChild(errorRow(error instanceof Error ? error.message : String(error)));
          return;
        }
        // A slower response from a previously closed/switched popover must not
        // mutate the panel that replaced it.
        if (panel !== popover || anchor?.dataset.primary !== primary) return;

        // Per-primary enable switch. Toggling persists `workspaces.<primary>.
        // enabled`; disabled means this primary's sessions expose no workspace
        // tool and no `_workspace` parameter, while configured roots are kept.
        // server.js resolves legacy no-flag records to enabled=true for
        // compatibility, so a strict false check is sufficient here. New
        // primaries with no persisted entry report enabled=false from server;
        // the UI therefore starts off and asks the user to opt in.
        const enabled = data.enabled === false ? false : true;
        // Grey-out semantics (option B): when the primary is disabled the
        // children rows and 添加目录 button remain visible so the user sees
        // what was configured, but are rendered inert. This is purely a UI
        // affordance; it does not change the persistence model.
        const disabled = !enabled;
        const enableRow = document.createElement('label');
        enableRow.className = 'mv-dsh-subworkspace-enable';
        const enableText = document.createElement('span');
        enableText.className = 'mv-dsh-subworkspace-enable-text';
        enableText.append('启用关联工作区');
        const enableHint = document.createElement('div');
        enableHint.className = 'mv-dsh-subworkspace-enable-hint';
        enableHint.textContent = '关闭后此工作区的对话不再看到 workspace 工具与 _workspace 参数';
        enableText.appendChild(enableHint);
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = enabled;
        toggle.setAttribute('aria-label', `启用 ${primary} 的关联工作区`);
        toggle.addEventListener('click', (event) => event.stopPropagation());
        toggle.addEventListener('change', async (event) => {
          event.stopPropagation();
          const next = toggle.checked;
          toggle.disabled = true;
          try {
            await request('/enabled', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ primary, enabled: next }),
            });
            await renderPopover(primary, panel);
          } catch (error) {
            toggle.checked = !next;
            if (panel === popover) panel.appendChild(errorRow(error instanceof Error ? error.message : String(error)));
          } finally {
            toggle.disabled = false;
          }
        });
        enableRow.append(enableText, toggle);
        panel.appendChild(enableRow);

        const children = data.roots.filter((root) => root.primary !== true);
        if (children.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'mv-dsh-subworkspace-empty';
          empty.textContent = '尚未添加关联目录';
          panel.appendChild(empty);
        }
        for (const root of children) {
          const row = document.createElement('div');
          row.className = 'mv-dsh-subworkspace-root';
          const main = document.createElement('div');
          main.className = 'mv-dsh-subworkspace-root-main';
          const name = document.createElement('div');
          name.className = 'mv-dsh-subworkspace-root-name';
          name.textContent = `${root.label}${root.valid ? '' : ' · 不可用'}`;
          const location = document.createElement('div');
          location.className = 'mv-dsh-subworkspace-root-path';
          location.textContent = root.error || root.path;
          main.append(name, location);
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'mv-dsh-subworkspace-remove';
          remove.setAttribute('aria-label', `移除 ${root.label}`);
          remove.textContent = '×';
          if (disabled) remove.disabled = true;
          remove.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (disabled) return;
            remove.disabled = true;
            try {
              await request('/roots', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ primary, workspaceId: root.id }),
              });
              await renderPopover(primary, panel);
            } catch (error) {
              remove.disabled = false;
              if (panel === popover) panel.appendChild(errorRow(error instanceof Error ? error.message : String(error)));
            }
          });
          row.append(main, remove);
          if (disabled) {
            row.dataset.disabled = 'true';
            row.setAttribute('aria-disabled', 'true');
          }
          panel.appendChild(row);
        }
        const actions = document.createElement('div');
        actions.className = 'mv-dsh-subworkspace-actions';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'mv-dsh-subworkspace-action';
        add.textContent = '添加目录';
        if (disabled) {
          add.disabled = true;
          add.title = '关闭关联工作区时不可添加目录';
        }
        add.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (disabled) return;
          add.disabled = true;
          try {
            const selected = await workspaces.pickDirectory();
            if (selected) {
              await request('/roots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ primary, path: selected }),
              });
              await renderPopover(primary, panel);
            }
          } catch (error) {
            if (panel === popover) panel.appendChild(errorRow(error instanceof Error ? error.message : String(error)));
          } finally {
            add.disabled = false;
          }
        });
        actions.appendChild(add);
        panel.appendChild(actions);
        if (panel === popover) {
          // Open-time position is final; content changes only clamp the box
          // back into the viewport if it would otherwise overflow, so the
          // popover never relocates after in-popover operations.
          keepPopoverInViewport();
        }
      }

      function openPopover(button, primary) {
        if (anchor === button && popover) {
          closePopover();
          return;
        }
        closePopover();
        anchor = button;
        anchor.setAttribute('aria-expanded', 'true');
        popover = document.createElement('div');
        popover.className = 'mv-dsh-subworkspace-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '关联工作区');
        document.body.appendChild(popover);
        // The one and only anchor-derived placement. Content fills in
        // asynchronously; renderPopover only clamps overflow after that.
        positionPopover();
        void renderPopover(primary, popover);
      }

      function mountButtons() {
        if (disposed || typeof document === 'undefined' || !document.body) return;
        const items = workspaces.list.getSnapshot().items ?? [];
        const rows = workspaceRows();
        for (let index = 0; index < rows.length; index += 1) {
          const item = items[index];
          if (!item?.path) continue;
          const { row, actions } = rows[index];
          let button = row.querySelector(`[${BUTTON_ATTR}]`);
          if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.setAttribute(BUTTON_ATTR, '');
            button.setAttribute('aria-label', `管理 ${item.title || item.path} 的关联工作区`);
            button.setAttribute('aria-expanded', 'false');
            button.appendChild(icon());
            button.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              openPopover(button, button.dataset.primary);
            });
            const nativeButtons = [...actions.querySelectorAll('button')]
              .filter((candidate) => !candidate.hasAttribute(BUTTON_ATTR));
            const plus = nativeButtons[nativeButtons.length - 1];
            actions.insertBefore(button, plus ?? null);
          }
          button.dataset.primary = item.path;
        }
        if (anchor && !anchor.isConnected) closePopover();
      }

      function outsidePointer(event) {
        if (!popover || !anchor) return;
        if (popover.contains(event.target) || anchor.contains(event.target)) return;
        closePopover();
      }

      function keydown(event) {
        if (event.key === 'Escape' && popover) closePopover();
      }

      ensureStyle();
      const unsubscribe = workspaces.list.subscribe(mountButtons);
      observer = new MutationObserver(mountButtons);
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('pointerdown', outsidePointer, true);
      document.addEventListener('keydown', keydown, true);
      window.addEventListener('resize', keepPopoverInViewport, { passive: true });
      window.addEventListener('scroll', keepPopoverInViewport, { capture: true, passive: true });
      queueMicrotask(mountButtons);

      ctx.effect?.(() => () => {
        disposed = true;
        unsubscribe?.();
        observer?.disconnect();
        document.removeEventListener('pointerdown', outsidePointer, true);
        document.removeEventListener('keydown', keydown, true);
        window.removeEventListener('resize', keepPopoverInViewport);
        window.removeEventListener('scroll', keepPopoverInViewport, true);
        closePopover();
        document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((button) => button.remove());
        if (styleSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== styleSheet);
        styleSheet = null;
      }, 'mv-dsh-subworkspace: workspace row controls');
    }

    const definition = {
      name: 'mv-dsh-subworkspace-client',
      inject: ['workspaces'],
      apply,
    };
    exports.default = definition;
    exports.name = definition.name;
    exports.inject = definition.inject;
    exports.apply = definition.apply;
    return module.exports;
  },
});
