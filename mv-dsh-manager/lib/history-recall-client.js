// @mv-aide/mv-dsh-manager — browser-side arrow-up history recall.
//
// Kept as its own DSH client module so the manager's recursive command picker,
// plan-review, file-drop, and settings surfaces remain isolated. The only
// behavior here is ArrowUp / ArrowDown on the composer textarea to cycle
// through the session's previously sent user messages.
//
// Recall round semantics (the anti-hijack contract):
//   • One ArrowUp press starts a recall ROUND bound to a monotonically
//     increasing token. Further ArrowUp presses continue the round ONLY while
//     the user has done nothing else to the composer since the last applied
//     message: the caret must still sit at the end of the displayed text (or
//     be unreadable-but-unchanged), and the draft must equal what this round
//     last displayed.
//   • Any of the following terminates the round IRREVERSIBLY, keeping the
//     current content and caret exactly as the user left them:
//       - ArrowLeft / ArrowRight / Home / End keydown (any modifiers),
//       - a mouse press inside the composer (mousedown on the element or a
//         drag across it),
//       - any edit gesture: beforeinput, compositionstart, paste, cut,
//       - a strict-selection change that disagrees with the round's expected
//         end-of-text caret (observed through selectionchange).
//   • After termination the ONLY way to re-arm recall is to empty the draft.
//     ArrowUp on a non-empty draft is passed through untouched (6b), so a
//     terminated round cannot be accidentally "continued".
//   • The plugin's own caret placement (focusComposerAtEnd) runs through the
//     same expected-selection bookkeeping, so it never looks like a user move.

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

    /**
     * @typedef {object} RecallRound
     * @property {string} anchorDraft
     * @property {number} desiredIndex
     * @property {number} displayedIndex
     * @property {string[]} messages
     * @property {boolean} fullLoaded
     * @property {AbortController | undefined} controller
     * @property {Promise<void> | undefined} request
     * @property {number} token — monotonically increasing round identity.
     *   Every async continuation (fetch .then/.catch, rAF caret placement,
     *   pending applyDesiredMessage steps) captures the token and abandons
     *   itself when the live round for the session is a different one.
     * @property {string | undefined} displayedDraft — what this round last
     *   wrote into the composer. `undefined` until the first display.
     * @property {boolean} exited — set by endRecallRound; once true the round
     *   is dead for navigation purposes even if the Map entry lingers for
     *   bookkeeping until the next session-switch cleanup.
     */

    /** @type {Map<string, RecallRound>} */
    const recallStates = new Map();

    /** Monotonic source of round tokens. */
    let nextRoundToken = 1;

    function getRecallState(sessionId) {
      return recallStates.get(sessionId);
    }

    /**
     * Terminate the recall round for `sessionId` IRREVERSIBLY (when active).
     * Content and caret are left exactly as they are — this function never
     * touches the draft or the selection. Aborts any in-flight history fetch
     * tied to the round. Returns the terminated round (or undefined).
     */
    function endRecallRound(sessionId, reason) {
      const state = recallStates.get(sessionId);
      if (!state) return undefined;
      recallStates.delete(sessionId);
      state.exited = true;
      state.controller?.abort();
      if (debugHooks.onRoundEnd) {
        try { debugHooks.onRoundEnd(sessionId, state, reason); } catch { /* hook is best-effort */ }
      }
      return state;
    }

    /**
     * Remove the round for `sessionId` entirely (session switch, dispose).
     * Unlike endRecallRound this is a bookkeeping removal, not a user-gesture
     * termination; both abort the in-flight fetch.
     */
    function clearRecallState(sessionId) {
      const state = recallStates.get(sessionId);
      if (!state) return;
      recallStates.delete(sessionId);
      state.exited = true;
      state.controller?.abort();
    }

    function setRecallState(sessionId, state) {
      recallStates.set(sessionId, state);
    }

    /** Whether `state` is still the live, non-exited round for its session. */
    function roundAlive(sessionId, state) {
      return state !== undefined && !state.exited && recallStates.get(sessionId) === state;
    }

    /** Test/inspection hook — unused in production wiring. */
    const debugHooks = { onRoundEnd: null };

    // ── Strict selection bookkeeping ─────────────────────────────────────
    /**
     * Read the composer's real DOM selection through the compat layer's
     * strict observer. Returns `{ status: 'known', start, end }` or
     * `{ status: 'unknown' }`; `unknown` is non-informational — it never
     * counts as a user move and never terminates a round.
     */
    function strictSelection(el) {
      try {
        if (typeof compat.composerSelection === 'function') {
          return compat.composerSelection(el);
        }
      } catch {
        // fall through to unknown
      }
      return { status: 'unknown' };
    }

    /**
     * Whether the caret may be treated as sitting at the very end of the
     * composer's rendered text — the only position from which a further
     * ArrowUp may continue the round.
     *
     * Non-judgmental cases (never terminate, always continue):
     *   • the selection is unreadable (`status: 'unknown'`) — treated as
     *     unchanged since the round last looked, unless a readable selection
     *     already established a baseline;
     *   • a caret placement of this round is still pending in a rAF — the
     *     caret is in transit, so the DOM offset is not yet meaningful.
     * A readable selection anywhere except the end (after placement ran)
     * returns `false` — that is a user caret move.
     */
    function caretAtEnd(el, state) {
      if (state?.caretPending === true) return true;
      const selection = strictSelection(el);
      if (selection.status !== 'known') return state?.selectionWasUnknown !== false;
      state.selectionWasUnknown = false;
      if (typeof el?.value === 'string') {
        return selection.start >= el.value.length && selection.end >= el.value.length;
      }
      const text = typeof el?.textContent === 'string' ? el.textContent : '';
      return selection.start >= text.length && selection.end >= text.length;
    }

    // ── Focus / draft helpers ────────────────────────────────────────────

    /**
     * Focus the composer and place the caret at the end. The 0.1.1 React
     * textarea commits `value` asynchronously after the store write, so the
     * selection is set inside a requestAnimationFrame — the same timing the
     * runtime's own restoreCaret uses. The 0.1.2+ contenteditable div is
     * caret-addressed through a Range instead of setSelectionRange.
     *
     * The rAF callback is bound to the round token of the state that asked
     * for it: when the round has ended (or been replaced) by the time the
     * frame runs, the caret placement is abandoned so it can never stomp a
     * user's own caret move. When called outside a round (e.g. the
     * ArrowDown exit path, which itself ends the round first) the callback
     * still runs — the caller passes `state === undefined`. The round also
     * records that a placement is pending; the position check treats a
     * pending placement as caret-in-transit rather than a user move.
     */
    function focusComposerAtEnd(ctx, sessionId, state) {
      const token = state?.token;
      if (state !== undefined) state.caretPending = true;
      const placeCaret = () => {
        try {
          if (state !== undefined) state.caretPending = false;
          if (typeof window === 'undefined' || window.closed === true || typeof document === 'undefined') return;
          if (state !== undefined && !roundAliveByToken(sessionId, token)) return;
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

    /** Token-flavored liveness check for rAF continuations. */
    function roundAliveByToken(sessionId, token) {
      const state = recallStates.get(sessionId);
      return state !== undefined && !state.exited && state.token === token;
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
      state.displayedDraft = message;
      focusComposerAtEnd(ctx, sessionId, state);
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

    // ── Round termination listeners ──────────────────────────────────────
    /**
     * The set of composer-terminating keydowns. Any modifier combination
     * still terminates the round: even Ctrl+ArrowLeft moves the caret, so
     * the safe rule is "a terminating key pressed at all ends the round".
     * These are observed on the CAPTURE phase so the round dies before the
     * default action moves the caret; no preventDefault/stopPropagation is
     * applied — the key keeps its native behavior.
     */
    const TERMINATING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

    /** Edit-gesture event types observed on the composer element (capture). */
    const TERMINATING_EDIT_EVENTS = ['beforeinput', 'compositionstart', 'paste', 'cut'];

    /**
     * The installed document/window-level observers for one apply() call.
     * Kept module-local so the uninstall path removes exactly what was added.
     */
    const roundObservers = { installed: false, cleanups: [] };

    function composerTargetOfEvent(event, ctx) {
      const target = event?.target;
      if (!target || typeof target !== 'object') return null;
      const sessionId = compat.currentSessionId(ctx);
      const composer = composerElement(ctx, sessionId);
      if (!composer) return null;
      if (target === composer || (typeof composer.contains === 'function' && composer.contains(target))) {
        return { composer, sessionId };
      }
      return null;
    }

    /**
     * Install the capture-phase terminators. One mousedown INSIDE the
     * composer (or a drag across it — mousedown fires on the composer when
     * the press lands in it) ends the round; clicks elsewhere (sidebar,
     * message list) do not, because they do not move the composer caret.
     * selectionchange is a fallback for platforms without keydown-before-
     * caret-move fidelity: it only ends the round when the strict selection
     * is readable AND disagrees with the round's expected end-of-text caret.
     */
    function installRoundObservers(ctx) {
      if (roundObservers.installed) return;
      roundObservers.installed = true;

      const onKeydownCapture = (event) => {
        try {
          if (typeof event?.key !== 'string') return;
          if (!TERMINATING_KEYS.has(event.key)) return;
          const hit = composerTargetOfEvent(event, ctx);
          if (!hit) return;
          endRecallRound(hit.sessionId, `key:${event.key}`);
        } catch {
          // Terminators are best-effort; the keydown path itself also guards.
        }
      };

      const onMousedownCapture = (event) => {
        try {
          const hit = composerTargetOfEvent(event, ctx);
          if (!hit) return;
          endRecallRound(hit.sessionId, 'mouse');
        } catch {
          // ignore
        }
      };

      const onEditEventCapture = (event) => {
        try {
          const hit = composerTargetOfEvent(event, ctx);
          if (!hit) return;
          endRecallRound(hit.sessionId, `edit:${event.type}`);
        } catch {
          // ignore
        }
      };

      const onSelectionChange = () => {
        try {
          const sessionId = compat.currentSessionId(ctx);
          const state = recallStates.get(sessionId);
          if (!state || state.exited) return;
          const composer = composerElement(ctx, sessionId);
          if (!composer) return;
          // Re-derive what the round expects right now. The round may be
          // mid-application (draft written, caret rAF pending); in that case
          // selection is unknown or transient and must not count as a move.
          const selection = strictSelection(composer);
          if (selection.status !== 'known') {
            state.selectionWasUnknown = true;
            return;
          }
          if (state.selectionWasUnknown === true) {
            // First readable selection after unknown — adopt it as the
            // baseline instead of terminating on the recovery itself.
            state.selectionWasUnknown = false;
            return;
          }
          const expectedText = typeof composer.value === 'string'
            ? composer.value
            : (typeof composer.textContent === 'string' ? composer.textContent : '');
          const atEnd = selection.start >= expectedText.length && selection.end >= expectedText.length;
          if (!atEnd && state.displayedDraft !== undefined && draftMatchesDisplay(composer, sessionId, ctx, state)) {
            endRecallRound(sessionId, 'selection');
          }
        } catch {
          // ignore
        }
      };

      const addWindow = (type, listener, capture) => {
        if (typeof window?.addEventListener !== 'function') return;
        window.addEventListener(type, listener, capture);
        roundObservers.cleanups.push(() => window.removeEventListener?.(type, listener, capture));
      };
      const addDocument = (type, listener, capture) => {
        const doc = typeof document === 'undefined' ? undefined : document;
        const target = doc?.addEventListener ? doc : (typeof window?.addEventListener === 'function' ? window : undefined);
        if (!target) return;
        target.addEventListener(type, listener, capture);
        roundObservers.cleanups.push(() => target.removeEventListener?.(type, listener, capture));
      };

      addWindow('keydown', onKeydownCapture, true);
      addWindow('mousedown', onMousedownCapture, true);
      addDocument('selectionchange', onSelectionChange, false);

      const doc = typeof document === 'undefined' ? undefined : document;
      if (doc?.addEventListener) {
        for (const type of TERMINATING_EDIT_EVENTS) {
          doc.addEventListener(type, onEditEventCapture, true);
          roundObservers.cleanups.push(() => doc.removeEventListener?.(type, onEditEventCapture, true));
        }
      }

      roundObservers.cleanups.push(() => {
        for (const sessionId of [...recallStates.keys()]) clearRecallState(sessionId);
      });
    }

    function uninstallRoundObservers() {
      if (!roundObservers.installed) return;
      roundObservers.installed = false;
      const cleanups = roundObservers.cleanups.splice(0);
      for (const cleanup of cleanups) {
        try { cleanup(); } catch { /* best-effort */ }
      }
    }

    /**
     * Whether the composer's current text equals what the round last
     * displayed — i.e. the user has not typed or deleted anything since.
     * Used together with the caret check: only "text unchanged AND caret
     * elsewhere" counts as a deliberate user move.
     */
    function draftMatchesDisplay(el, sessionId, ctx, state) {
      const now = composerDraft(el, sessionId, ctx);
      return now === state.displayedDraft;
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
      // its native caret-movement behavior. This is also the re-arm rule:
      // after a round terminated, the draft still holds the recalled text,
      // so ArrowUp passes through until the user empties the draft.
      if (isArrowUp && state === undefined && draftNow !== '') return;

      // ── ArrowDown in recall mode ────────────────────────────
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
        endRecallRound(target.sessionId, 'arrowdown-exit');
        focusComposerAtEnd(ctx, target.sessionId, undefined);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // ── ArrowUp ─────────────────────────────────────────────
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
          token: nextRoundToken++,
          // Until the first display the composer still shows the anchor
          // draft, so that is what "unchanged" compares against.
          displayedDraft: draftNow,
          exited: false,
          selectionWasUnknown: undefined,
          caretPending: false,
        };
        setRecallState(target.sessionId, nextState);
        applyDesiredMessage(target.sessionId, nextState, ctx);
        startFullHistory(target.sessionId, nextState, ctx);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // Already in recall mode — going further back. The round continues
      // ONLY when the user has left the composer exactly as this round last
      // displayed it: draft unchanged AND caret still at the end (or
      // selection unreadable since the last application). Any intervening
      // operation would have terminated the round through the capture
      // observers; this is the belt-and-suspenders position check.
      const draftUnchanged = draftMatchesDisplay(el, target.sessionId, ctx, state);
      const caretOk = caretAtEnd(el, state);
      if (draftUnchanged && caretOk) {
        if (!state.fullLoaded || state.desiredIndex + 1 < state.messages.length) {
          state.desiredIndex += 1;
          applyDesiredMessage(target.sessionId, state, ctx);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // The composer moved but the terminators missed it (exotic platform,
      // synthetic event order). End the round NOW and let this ArrowUp keep
      // its native behavior — recall must never hijack a moved caret.
      endRecallRound(target.sessionId, 'position-check');
    }

    /**
     * Install the ArrowUp/ArrowDown history-recall listener together with
     * the recall-round terminators.
     * @param {object} ctx - DSH client context (sessions + commandUi).
     * @param {object} options - Feature policy with get() and subscribe().
     */
    function apply(ctx, options = {}) {
      if (typeof window?.addEventListener !== 'function') return;

      const handler = (event) => onKeyDown(ctx, options, event);

      const install = () => {
        window.addEventListener('keydown', handler, true);
        installRoundObservers(ctx);
        return () => {
          window.removeEventListener('keydown', handler, true);
          uninstallRoundObservers();
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
