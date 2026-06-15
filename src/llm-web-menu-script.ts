/**
 * Scripts injected into webviewer pages to render a custom right-click menu.
 *
 * The Electron `<webview>` is an isolated, cross-origin browsing context: DOM
 * events do not bubble out to Obsidian, and Obsidian's `document.getSelection()`
 * cannot read the page's selection. So we run this script inside the page: it
 * intercepts `contextmenu`, draws a floating menu, and on click stashes the
 * selection + chosen label into `window.__mvObccLlmMenu.pendingInvoke`. The
 * Obsidian side polls that field via `executeJavaScript` and dispatches the LLM
 * call (see `LlmFeature.installWebMenus`).
 *
 * Structure mirrors `selection-highlights.ts` web script helpers (idempotent
 * window key + cleanup), but uses a distinct key to avoid any conflict.
 */

export interface LlmWebPendingInvoke {
  label: string;
  index: number;
  selection: string;
}

const WEB_MENU_STATE_KEY = "__mvObccLlmMenu";

/**
 * Returns the IIFE source string to inject. `templatesJson` must be a JSON
 * string encoding `Array<{ label: string }>`.
 */
export function llmWebMenuInstallScript(templatesJson: string): string {
  return `(() => {
    try {
      const key = ${JSON.stringify(WEB_MENU_STATE_KEY)};
      const templates = ${templatesJson};
      const state = window[key];
      if (state && state.version === 1) {
        // Templates may have changed; refresh the list.
        state.templates = templates;
        return { success: true, installed: false };
      }

      let menuEl = null;

      const closeMenu = () => {
        if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
        menuEl = null;
      };

      const onContextMenu = (event) => {
        try {
          const selection = window.getSelection ? window.getSelection() : null;
          const text = selection ? selection.toString() : "";
          if (!text || !text.trim()) return; // let the page's native menu through
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          menuEl = document.createElement("div");
          menuEl.setAttribute("data-mv-obcc-llm-menu", "true");
          menuEl.style.cssText = [
            "position:fixed",
            "z-index:2147483647",
            "left:" + event.clientX + "px",
            "top:" + event.clientY + "px",
            "min-width:160px",
            "padding:4px 0",
            "margin:0",
            "background:#ffffff",
            "color:#1f2328",
            "border:1px solid rgba(0,0,0,0.15)",
            "border-radius:8px",
            "box-shadow:0 8px 24px rgba(0,0,0,0.18)",
            "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
            "user-select:none",
          ].join(";");

          const header = document.createElement("div");
          header.textContent = "LLM";
          header.style.cssText = "padding:4px 12px;color:#8a9199;font-size:11px;text-transform:uppercase;letter-spacing:.04em;";
          menuEl.appendChild(header);

          templates.forEach((tpl, index) => {
            const item = document.createElement("div");
            item.textContent = tpl.label;
            item.style.cssText = "padding:6px 12px;cursor:pointer;white-space:nowrap;";
            item.addEventListener("mouseenter", () => { item.style.background = "#f1f3f5"; });
            item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
            item.addEventListener("click", (clickEvent) => {
              clickEvent.preventDefault();
              clickEvent.stopPropagation();
              const sel = window.getSelection ? window.getSelection() : null;
              const currentText = sel ? sel.toString() : "";
              const pending = {
                label: tpl.label,
                index: index,
                selection: currentText,
              };
              const current = window[key];
              if (current) current.pendingInvoke = pending;
              closeMenu();
            });
            menuEl.appendChild(item);
          });

          document.body.appendChild(menuEl);
        } catch (err) {
          // Never let the menu break page interaction.
        }
      };

      const onPointerDown = (event) => {
        if (!menuEl) return;
        if (menuEl.contains(event.target)) return;
        closeMenu();
      };

      const onKey = (event) => {
        if (event.key === "Escape") closeMenu();
      };

      const cleanup = () => {
        closeMenu();
        document.removeEventListener("contextmenu", onContextMenu, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKey, true);
        delete window[key];
      };

      document.addEventListener("contextmenu", onContextMenu, true);
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKey, true);

      window[key] = {
        version: 1,
        templates: templates,
        pendingInvoke: null,
        cleanup: cleanup,
      };
      return { success: true, installed: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}

/**
 * Polling script: returns and clears the pending invoke payload if any.
 * Must match `LlmWebPendingInvoke` when non-null.
 */
export function llmWebMenuPollScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_MENU_STATE_KEY)}];
      if (!state || !state.pendingInvoke) return null;
      const pending = state.pendingInvoke;
      state.pendingInvoke = null;
      return pending;
    } catch {
      return null;
    }
  })()`;
}

export function llmWebMenuCleanupScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_MENU_STATE_KEY)}];
      if (state && typeof state.cleanup === "function") state.cleanup();
      return true;
    } catch {
      return false;
    }
  })()`;
}

// ===========================================================================
// Independent dismiss-signal chain (parallel to the context-menu/hotkey chains).
// Separate idempotent key, separate state, separate listener. When the user
// left-clicks anywhere on the page (outside the context menu), stashes a
// pending signal that the Obsidian side polls and uses to close an unpinned,
// non-streaming result surface. Needed because the Electron <webview> is an
// isolated browsing context: its pointerdown never bubbles to Obsidian's main
// document, so the surface's own outside-click listener cannot see it.
// ===========================================================================

export const WEB_DISMISS_STATE_KEY = "__mvObccLlmDismiss";

export interface LlmWebDismissPending {
  at: number;
}

/**
 * Returns the IIFE source string to inject. Idempotent re-injection preserves
 * any pending signal. The listener
 * fires only on left-button (button === 0) clicks so right-click still
 * reaches the context-menu chain, and ignores clicks inside the in-page
 * context menu so menu items can dispatch their invoke without dismissing.
 */
export function llmWebDismissInstallScript(): string {
  return `(() => {
    try {
      const key = ${JSON.stringify(WEB_DISMISS_STATE_KEY)};
      const existing = window[key];
      if (existing && existing.version === 2) {
        return { success: true, installed: false };
      }
      if (existing && typeof existing.cleanup === "function") {
        existing.cleanup();
      }

      const onPointerDown = (event) => {
        try {
          // Only left-button clicks dismiss; right-click feeds the context-menu chain.
          if (event.button !== 0) return;
          // Ignore clicks inside the in-page context menu so menu items can
          // dispatch their invoke without the surface being torn down.
          const menu = document.querySelector('[data-mv-obcc-llm-menu="true"]');
          if (menu && menu.contains(event.target)) return;
          const state = window[key];
          if (state) state.pending = { at: Date.now() };
        } catch {
          // Never break page interaction.
        }
      };

      const cleanup = () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        delete window[key];
      };

      document.addEventListener("pointerdown", onPointerDown, true);
      window[key] = {
        version: 2,
        pending: null,
        cleanup: cleanup,
      };
      return { success: true, installed: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}

/**
 * Polling script: returns and clears the pending dismiss payload if any.
 * Its timestamp prevents old clicks from dismissing a surface created later.
 */
export function llmWebDismissPollScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_DISMISS_STATE_KEY)}];
      if (!state || !state.pending) return null;
      const pending = state.pending;
      state.pending = null;
      return pending;
    } catch {
      return null;
    }
  })()`;
}

export function llmWebDismissCleanupScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_DISMISS_STATE_KEY)}];
      if (state && typeof state.cleanup === "function") state.cleanup();
      return true;
    } catch {
      return false;
    }
  })()`;
}

// ===========================================================================
// Independent hotkey-sync chain (parallel to the context-menu chain above).
// Separate idempotent key, separate state, separate listeners — the
// context-menu code above is never touched or referenced.
// ===========================================================================

export const WEB_HOTKEY_STATE_KEY = "__mvObccLlmHotkey";

export interface LlmWebHotkeyPending {
  index: number;
  label: string;
  selection: string;
}

/**
 * Returns the IIFE source string to inject for hotkey syncing. `bindingsJson`
 * must be a JSON array whose i-th element is either null (template i has no
 * bound hotkey) or an array of `{ modifiers: string[], key: string }`. Only
 * templates that have ≥1 binding participate. `labelsJson` is a JSON array of
 * label strings, indexed identically to the bindings array.
 *
 * The matcher inlined below is a verbatim twin of `matchBinding` in
 * `src/llm-hotkey-match.ts` — keep them in sync. The webview runs in an
 * isolated world and cannot import that module.
 *
 * Key design points:
 *  - Letters/digits are matched via `event.code` so macOS `Option+T`
 *    (which yields `event.key = "†"`) still matches.
 *  - Listeners attach to `window` in the capture phase so they also see
 *    keystrokes while focus is in an `<input>`/`<textarea>`.
 *  - `onKey` always reads the latest bindings from the shared state object,
 *    so re-injection (which only updates `state.bindings`) takes effect
 *    immediately without re-adding listeners.
 *  - Selection is read from `getSelection()` for normal text and from
 *    `selectionStart/selectionEnd` for inputs/textareas.
 *  - Auto-repeat and IME composition events are ignored.
 */
export function llmWebHotkeyInstallScript(
  bindingsJson: string,
  labelsJson: string,
  isMac: boolean,
): string {
  return `(() => {
    try {
      const key = ${JSON.stringify(WEB_HOTKEY_STATE_KEY)};
      const isMac = ${JSON.stringify(isMac)};
      const bindings = ${bindingsJson};
      const labels = ${labelsJson};

      // ---- Verbatim twin of matchBinding (src/llm-hotkey-match.ts) ----
      const normalizeObsidianKey = (raw) => {
        if (!raw) return null;
        const k = raw.toUpperCase();
        if (k.length === 1 && k >= "A" && k <= "Z") return { kind: "code", code: "Key" + k };
        if (k.length === 1 && k >= "0" && k <= "9") return { kind: "code", code: "Digit" + k };
        if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) return { kind: "key", key: k };
        return { kind: "key", key: k };
      };
      const matchBinding = (binding, event) => {
        if (event.repeat || event.isComposing) return false;
        const normalized = normalizeObsidianKey(binding.key);
        if (!normalized) return false;
        if (normalized.kind === "code") {
          if (event.code !== normalized.code) return false;
        } else {
          if ((event.key || "").toUpperCase() !== normalized.key) return false;
        }
        const mods = binding.modifiers || [];
        const needMod = mods.indexOf("Mod") >= 0;
        const needCtrl = mods.indexOf("Ctrl") >= 0;
        const needMeta = mods.indexOf("Meta") >= 0;
        const needAlt = mods.indexOf("Alt") >= 0;
        const needShift = mods.indexOf("Shift") >= 0;
        const wantMeta = needMeta || (needMod && isMac);
        const wantCtrl = needCtrl || (needMod && !isMac);
        if (wantMeta !== !!event.metaKey) return false;
        if (wantCtrl !== !!event.ctrlKey) return false;
        if (needAlt !== !!event.altKey) return false;
        if (needShift !== !!event.shiftKey) return false;
        return true;
      };

      // ---- Selection reader: normal DOM text + input/textarea ----
      const readSelection = () => {
        try {
          const el = document.activeElement;
          const tag = el && el.tagName ? el.tagName.toUpperCase() : "";
          if (tag === "INPUT" || tag === "TEXTAREA") {
            const node = el;
            if (typeof node.selectionStart === "number" && typeof node.selectionEnd === "number") {
              const start = node.selectionStart;
              const end = node.selectionEnd;
              if (start !== end && typeof node.value === "string") {
                return node.value.slice(start, end);
              }
            }
            return "";
          }
          const sel = window.getSelection ? window.getSelection() : null;
          return sel ? sel.toString() : "";
        } catch {
          return "";
        }
      };

      const state = window[key];
      if (state && state.version === 2) {
        // Refresh bindings (the user may have re-bound keys).
        state.bindings = bindings;
        state.labels = labels;
        return { success: true, installed: false };
      }
      if (state && typeof state.cleanup === "function") {
        state.cleanup();
      } else if (state) {
        delete window[key];
      }

      const onKey = (event) => {
        try {
          const current = window[key];
          if (!current) return;
          const templates = current.bindings || [];
          let matchedIndex = -1;
          for (let templateIndex = 0; templateIndex < templates.length; templateIndex++) {
            const templateBindings = templates[templateIndex];
            if (!Array.isArray(templateBindings)) continue;
            for (const binding of templateBindings) {
              if (binding && matchBinding(binding, event)) {
                matchedIndex = templateIndex;
                break;
              }
            }
            if (matchedIndex >= 0) break;
          }
          if (matchedIndex < 0) return;
          const selection = readSelection();
          if (!selection || !selection.trim()) return;
          // Only suppress the page's default handling when we actually act.
          event.preventDefault();
          event.stopImmediatePropagation();
          current.pending = {
            index: matchedIndex,
            label: (current.labels && current.labels[matchedIndex]) || ("LLM " + (matchedIndex + 1)),
            selection: selection,
          };
        } catch (err) {
          // Never break page input.
        }
      };

      const cleanup = () => {
        window.removeEventListener("keydown", onKey, true);
        delete window[key];
      };

      // Capture phase on window: fires before page handlers and covers
      // input/textarea focus, where document-level listeners can be too late.
      window.addEventListener("keydown", onKey, true);

      window[key] = {
        version: 2,
        bindings: bindings,
        labels: labels,
        pending: null,
        cleanup: cleanup,
      };
      return { success: true, installed: true };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  })()`;
}

/** Polling script: returns and clears the pending hotkey payload if any. */
export function llmWebHotkeyPollScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_HOTKEY_STATE_KEY)}];
      if (!state || !state.pending) return null;
      const pending = state.pending;
      state.pending = null;
      return pending;
    } catch {
      return null;
    }
  })()`;
}

export function llmWebHotkeyCleanupScript(): string {
  return `(() => {
    try {
      const state = window[${JSON.stringify(WEB_HOTKEY_STATE_KEY)}];
      if (state && typeof state.cleanup === "function") state.cleanup();
      return true;
    } catch {
      return false;
    }
  })()`;
}
