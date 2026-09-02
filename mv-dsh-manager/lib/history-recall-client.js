// @mv-aide/mv-dsh-manager — browser-side arrow-up history recall.
//
// Kept as its own DSH client module so the manager's recursive command picker,
// plan-review, file-drop, and settings surfaces remain isolated. The only
// behavior here is ArrowUp / ArrowDown on the composer textarea to cycle
// through the session's previously sent user messages.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager/history-recall-client',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = ['sessions', 'commandUi'];
    const compat = require('@mv-aide/mv-dsh-compat/client/manager');

    function safeGet(ctx, name) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name];
      } catch {
        return undefined;
      }
    }

    /**
     * Locate the composer input across supported DSH builds. The runtime in
     * use (0.1.1-rc.2) renders the composer as a React-controlled
     * `<textarea data-phase>`; its selection and value live on the element
     * itself. Newer DSH builds (0.1.2+, verified against vendor
     * dsh-v0.1.2-alpha.1 ui-conversation InputBar.tsx) replace it with a
     * Lexical contenteditable `<div data-phase data-composer-input>` — the
     * textarea no longer exists there.
     */
    function composerElement(ctx, sessionId) {
      try {
        return compat.resolveComposer(ctx, document, sessionId)?.element ?? null;
      } catch {
        return null;
      }
    }

    /**
     * Read the current draft text. The textarea's own `value` is the primary
     * source; the DSH input facade (InputState.draft) is the fallback when
     * the element disagrees or is unavailable (stale render, future DSH
     * layout changes) — the same precedence file-drop-client uses.
     */
    function composerDraft(el, sessionId, ctx) {
      if (el && typeof el.value === 'string') return el.value;
      return currentDraft(sessionId, ctx);
    }

    /**
     * Read the current draft text from the DSH input facade (InputState.draft).
     */
    function currentDraft(sessionId, ctx) {
      try {
        const state = compat.resolveComposer(ctx, document, sessionId)?.snapshot();
        return state && typeof state.draft === 'string' ? state.draft : '';
      } catch {
        return '';
      }
    }

    // ── Session plumbing ─────────────────────────────────────────────────
    function currentSession(ctx) {
      const sessions = compat.resolveSessions(ctx)?.sessions;
      const state = sessions?.list?.getSnapshot?.();
      const sessionId = typeof state?.current === 'string' ? state.current : undefined;
      if (!sessionId) return undefined;
      const binding = sessions?.binding?.(sessionId);
      if (!binding) return undefined;
      return { sessions, sessionId, binding, session: binding.session };
    }

    function inputFor(sessionId, ctx) {
      return compat.resolveConversation(ctx, sessionId)?.input;
    }

    // ── Menu / popup guards ─────────────────────────────────────────────
    /**
     * Check whether the slash menu or a popupSelect shell is open for this
     * session. Both must be closed before history recall may claim ArrowUp.
     */
    function menusOpen(sessionId, ctx) {
      try {
        const sessions = safeGet(ctx, 'sessions');
        const actx = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
        if (!actx) return false;

        const inputTriggers = safeGet(actx, 'inputTriggers');
        const ctrl = inputTriggers && typeof inputTriggers.sessionOf === 'function'
          ? inputTriggers.sessionOf(actx)
          : undefined;
        if (ctrl?.menu?.getSnapshot?.()?.open === true) return true;

        const commandUi = safeGet(ctx, 'commandUi');
        const popup = commandUi && typeof commandUi.popupFor === 'function'
          ? commandUi.popupFor(actx)
          : undefined;
        if (popup?.state?.getSnapshot?.()?.open === true) return true;

        return false;
      } catch {
        return false;
      }
    }

    /**
     * Whether keyboard focus currently sits on the composer textarea.
     * History recall is a composer gesture; when focus is elsewhere the
     * ArrowUp/Down keys belong to whatever surface the user is on.
     */
    function composerFocused(el) {
      try {
        if (typeof document === 'undefined') return false;
        return document.activeElement === el;
      } catch {
        return false;
      }
    }

    // ── History extraction ───────────────────────────────────────────────
    /**
     * Resolve the Chat projection `{ order, nodes }` for a session target.
     *
     * DSH 0.1.1-rc.2 folds the chat view into the session snapshot itself
     * (`snapshot.chat`). DSH 0.1.2+ moved it to the uiConversation service:
     * `uiConversation.binding(sessionId).target('chat')` yields an observable
     * whose snapshot is `{ order, nodes, ... }` (verified against vendor
     * dsh-v0.1.2-alpha.1 ui-chat apply.ts and ui-conversation assembly.ts).
     * The uiConversation service does not exist in 0.1.1, so its presence is
     * the version discriminator; both paths return the same shape.
     */
    function chatProjection(target, ctx) {
      const preview = target.session?.getSnapshot?.()?.chat;
      if (preview !== undefined) return preview;
      return compat.resolveChatProjection(ctx, target.sessionId)?.chat;
    }

    /**
     * Extract text content from user-sent messages, ordered from newest to
     * oldest. The Chat projection carries `{ order, nodes }` (`order` lists
     * visible node keys oldest-first; `nodes` is a node store with
     * `get(key)`). User-sent messages appear as `kind === 'user' |
     * 'steering'` nodes; plugin-injected context (`kind: 'context'`) and
     * commands are excluded, matching the runtime's own
     * `source.kind === 'user'` classification.
     */
    function userMessages(target, ctx) {
      const chat = chatProjection(target, ctx);
      if (!chat) return { messages: [] };

      const order = Array.isArray(chat.order) ? chat.order : [];
      const nodes = chat.nodes;
      const messages = [];
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const node = typeof nodes?.get === 'function' ? nodes.get(order[i]) : undefined;
        if (!node || (node.kind !== 'user' && node.kind !== 'steering')) continue;
        const parts = [];
        for (const block of node.data?.content || []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
        if (parts.length > 0) {
          messages.push(parts.join('\n'));
        }
      }
      return { messages };
    }

    // ── Navigation state (per-session, module-local) ─────────────────────
    const HISTORY_API = '/api/mv-aide/history-recall';
    /** @type {Map<string, { anchorDraft: string, desiredIndex: number, displayedIndex: number, messages: string[], fullLoaded: boolean, controller: AbortController | undefined, request: Promise<void> | undefined }>} */
    const recallStates = new Map();

    function getRecallState(sessionId) {
      return recallStates.get(sessionId);
    }

    function clearRecallState(sessionId) {
      recallStates.get(sessionId)?.controller?.abort();
      recallStates.delete(sessionId);
    }

    function setRecallState(sessionId, state) {
      recallStates.set(sessionId, state);
    }

    // ── Focus / draft helpers ────────────────────────────────────────────

    /**
     * Focus the composer and place the caret at the end. The 0.1.1 React
     * textarea commits `value` asynchronously after the store write, so the
     * selection is set inside a requestAnimationFrame — the same timing the
     * runtime's own restoreCaret uses. The 0.1.2+ contenteditable div is
     * caret-addressed through a Range instead of setSelectionRange.
     */
    function focusComposerAtEnd(ctx, sessionId) {
      const placeCaret = () => {
        try {
          if (typeof window === 'undefined' || window.closed === true || typeof document === 'undefined') return;
          if (typeof document.hasFocus === 'function' && document.hasFocus() !== true) return;
          const currentSessionId = compat.currentSessionId(ctx);
          if (currentSessionId && currentSessionId !== sessionId) return;
          const composer = compat.resolveComposer(ctx, document, sessionId);
          if (!composer) return;
          composer.focusAt(composer.snapshot().draft.length);
        } catch {
          // Caret restoration is best-effort.
        }
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(placeCaret);
      } else {
        placeCaret();
      }
    }

    function setDraft(sessionId, draft, ctx) {
      const input = inputFor(sessionId, ctx);
      if (!input) return false;
      try {
        input.setDraft(draft);
        return true;
      } catch {
        return false;
      }
    }

    function applyDesiredMessage(sessionId, state, ctx) {
      if (state.messages.length === 0) return false;
      let index = state.desiredIndex;
      if (index >= state.messages.length) {
        if (!state.fullLoaded) return false;
        index = state.messages.length - 1;
        state.desiredIndex = index;
      }
      const message = state.messages[index];
      if (typeof message !== 'string') return false;
      if (!setDraft(sessionId, message, ctx)) return false;
      state.displayedIndex = index;
      focusComposerAtEnd(ctx, sessionId);
      return true;
    }

    function validFullHistory(payload) {
      if (payload?.ok !== true || !Array.isArray(payload.messages)) return undefined;
      const records = [];
      for (const record of payload.messages) {
        if (!Number.isSafeInteger(record?.seq) || typeof record?.text !== 'string') {
          return undefined;
        }
        records.push({ seq: record.seq, text: record.text });
      }
      return records;
    }

    async function fetchFullHistory(sessionId, signal) {
      const response = await window.fetch(HISTORY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal,
      });
      if (!response.ok) throw new Error(`history recall failed (${response.status})`);
      const records = validFullHistory(await response.json());
      if (!records) throw new Error('history recall returned an invalid response');
      return records;
    }

    function startFullHistory(sessionId, state, ctx) {
      if (state.request || state.fullLoaded) return;
      const controller = new AbortController();
      state.controller = controller;
      state.request = fetchFullHistory(sessionId, controller.signal)
        .then((records) => {
          if (recallStates.get(sessionId) !== state || controller.signal.aborted) return;
          state.messages = records.map((record) => record.text);
          state.fullLoaded = true;
          state.controller = undefined;
          state.request = undefined;
          applyDesiredMessage(sessionId, state, ctx);
        })
        .catch(() => {
          if (recallStates.get(sessionId) !== state || controller.signal.aborted) return;
          // Complete history is an enhancement. Keep the already loaded local
          // messages, but never mutate the visible conversation pagination.
          state.fullLoaded = true;
          state.controller = undefined;
          state.request = undefined;
          applyDesiredMessage(sessionId, state, ctx);
        });
    }

    // ── Keyboard handler ─────────────────────────────────────────────────
    function onKeyDown(ctx, options, event) {
      // 1. Feature policy.
      if (typeof options.get === 'function' && options.get().historyRecallEnabled === false) return;
      // 2. Only the ArrowUp / ArrowDown gestures.
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      // 3. IME composition guard.
      if (event.isComposing === true) return;

      // 4. The composer textarea must exist and be connected.
      const sessionId = compat.currentSessionId(ctx);
      const el = composerElement(ctx, sessionId);
      if (!el || !el.isConnected) return;

      // 7. Focus must sit on the composer: recall is a composer gesture and
      // must never steal arrows from other surfaces (lists, sidebars, inputs).
      if (!composerFocused(el)) return;

      // 5. A current session, with menus closed.
      const target = currentSession(ctx);
      if (!target) return;
      if (menusOpen(target.sessionId, ctx)) return;

      const isArrowUp = event.key === 'ArrowUp';
      const state = getRecallState(target.sessionId);
      const draftNow = composerDraft(el, target.sessionId, ctx);

      // 6a. ArrowDown only while recall is active.
      if (!isArrowUp && state === undefined) return;
      // 6b. ArrowUp only from an empty draft — otherwise the textarea keeps
      // its native caret-movement behavior.
      if (isArrowUp && state === undefined && draftNow !== '') return;

      // ── ArrowDown in recall mode ───────────────────────────────────
      if (!isArrowUp && state !== undefined) {
        if (state.desiredIndex > 0) {
          state.desiredIndex -= 1;
          applyDesiredMessage(target.sessionId, state, ctx);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // Reached the newest message — restore anchor and exit recall mode.
        setDraft(target.sessionId, state.anchorDraft, ctx);
        clearRecallState(target.sessionId);
        focusComposerAtEnd(ctx, target.sessionId);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // ── ArrowUp ────────────────────────────────────────────────────
      if (state === undefined) {
        // Use the visible projection immediately, then replace it with the
        // complete raw-log history without expanding the visible chat page.
        const { messages } = userMessages(target, ctx);
        const nextState = {
          anchorDraft: draftNow,
          desiredIndex: 0,
          displayedIndex: -1,
          messages,
          fullLoaded: false,
          controller: undefined,
          request: undefined,
        };
        setRecallState(target.sessionId, nextState);
        applyDesiredMessage(target.sessionId, nextState, ctx);
        startFullHistory(target.sessionId, nextState, ctx);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Already in recall mode — going further back.
      if (!state.fullLoaded || state.desiredIndex + 1 < state.messages.length) {
        state.desiredIndex += 1;
        applyDesiredMessage(target.sessionId, state, ctx);
      }
      event.preventDefault();
      event.stopPropagation();
    }

    /**
     * Install the ArrowUp/ArrowDown history-recall listener.
     * @param {object} ctx - DSH client context (sessions + commandUi).
     * @param {object} options - Feature policy with get() and subscribe().
     */
    function apply(ctx, options = {}) {
      if (typeof window?.addEventListener !== 'function') return;

      const handler = (event) => onKeyDown(ctx, options, event);

      const install = () => {
        window.addEventListener('keydown', handler, true);
        return () => {
          window.removeEventListener('keydown', handler, true);
          for (const sessionId of [...recallStates.keys()]) clearRecallState(sessionId);
        };
      };

      if (typeof ctx?.effect === 'function') {
        ctx.effect(install, 'mv-dsh-manager: history recall');
      } else {
        install();
      }

      // Clear recall state when the session list changes (session switch).
      const sessions = safeGet(ctx, 'sessions');
      const list = sessions?.list;
      if (list && typeof list.subscribe === 'function') {
        const unsub = list.subscribe(() => {
          const current = list.getSnapshot?.()?.current;
          for (const key of recallStates.keys()) {
            if (key !== current) clearRecallState(key);
          }
        });
        if (typeof ctx?.effect === 'function') {
          ctx.effect(() => unsub, 'mv-dsh-manager: history recall session watch');
        }
      }
    }

    exports.inject = inject;
    exports.userMessages = userMessages;
    exports.apply = apply;
    return module.exports;
  },
});
