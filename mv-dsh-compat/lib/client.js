// Browser-realm projections shared by mv-agent, mv-dsh-manager, and
// mv-dsh-subworkspace. The preview faces are checked first; Alpha-only faces
// are selected only when the preview contract is absent.

export function safeClientGet(ctx, name) {
  try {
    const value = ctx?.get?.(name);
    if (value !== undefined) return value;
  } catch {
    // Optional services may reject undeclared dynamic reads.
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

export function resolveSettingsCardHost(ctx) {
  const slots = safeClientGet(ctx, 'slots');
  const settingsScope = safeClientGet(ctx, 'settingsScope');
  if (!slots || !settingsScope || typeof slots.inject !== 'function' || typeof slots.register !== 'function'
      || typeof settingsScope.bind !== 'function') return null;
  return Object.freeze({ adapter: 'preview', slots, settingsScope });
}

export function resolveSessions(ctx) {
  const sessions = safeClientGet(ctx, 'sessions');
  if (!sessions || (typeof sessions?.list?.getSnapshot !== 'function'
      && typeof sessions.binding !== 'function' && typeof sessions.scope !== 'function')) return null;
  return Object.freeze({ adapter: 'preview', sessions });
}

// --- Models settings: host controls this plugin augments ------------------
//
// `@deepseek-ai/dsh-client-ui-settings-models` renders every model row and
// every editor action row from one CSS module, so each control keeps a stable
// *local* class name behind a per-build hash (`<hash>_modelRow`). The rows and
// footers are structurally identical across the preview baselines, which makes
// those names the durable handle; the surrounding labels are not, because they
// are localized copy the host is free to reword (the per-row disclosure went
// from `容量 <n>` to `模型选项 <n>`, and the add-provider commit from
// `创建提供方` to `创建提供商`). These three readers therefore match a hashed
// class token by its local suffix and answer null whenever the shape is
// anything other than the one they were verified against — never a guess.

/** True when `element` carries a class token whose local name is `local`. */
function hasLocalClass(element, local) {
  if (!element || typeof element.getAttribute !== 'function') return false;
  const className = element.getAttribute('class');
  if (typeof className !== 'string' || className.length === 0) return false;
  return className.split(/\s+/u).some((token) => token === local || token.endsWith(`_${local}`));
}

/**
 * The disclosure control of one model entry — the button that expands the
 * entry's native capacity and input-type fields.
 *
 * It is the entry's only `button[aria-expanded]`: the row's other control is
 * the remove button, which carries no expansion state. An entry with none, or
 * with more than one, is a shape this reader does not recognise and yields
 * null rather than picking one.
 * @param {Element | null | undefined} entry - one model entry element.
 * @returns {Element | null} the disclosure button.
 */
export function modelRowDisclosure(entry) {
  if (!entry?.querySelectorAll) return null;
  const found = [...entry.querySelectorAll('button[aria-expanded]')];
  return found.length === 1 ? found[0] : null;
}

/**
 * The action row that closes one provider editor: the `div` holding its cancel
 * and commit controls. Every editor renders exactly one, and the card's own
 * row-level actions (`编辑` / `删除`, and the setup and add cards) live outside
 * it, which is what keeps a structural read from mistaking one for another.
 * @param {Element | null | undefined} root - an ancestor of the action row.
 * @returns {Element | null} the action row element.
 */
export function editorActionRow(root) {
  if (!root?.querySelectorAll) return null;
  const found = [...root.querySelectorAll('div')].filter((node) => hasLocalClass(node, 'editorActions'));
  return found.length === 1 ? found[0] : null;
}

const EDITOR_ACTION_KINDS = Object.freeze({ primary: 'primaryButton', secondary: 'secondaryButton' });

/**
 * One control of an editor's action row, addressed by role rather than by its
 * localized caption: `primary` is the commit control (its caption varies with
 * what the editor commits — a provider save, a new provider, a save-and-
 * continue) and `secondary` is the cancel control.
 * @param {Element | null | undefined} actionRow - the row from `editorActionRow`.
 * @param {'primary' | 'secondary'} kind - which control of that row to read.
 * @returns {Element | null} the button, or null when the row is absent or ambiguous.
 */
export function editorActionButton(actionRow, kind) {
  const local = EDITOR_ACTION_KINDS[kind];
  if (!actionRow?.querySelectorAll || !local) return null;
  const found = [...actionRow.querySelectorAll('button')].filter((button) => hasLocalClass(button, local));
  return found.length === 1 ? found[0] : null;
}

/**
 * The commit control of the editor that contains `root`, or null.
 * @param {Element | null | undefined} root - an ancestor of the action row.
 * @returns {Element | null} the commit button.
 */
export function editorSaveButton(root) {
  return editorActionButton(editorActionRow(root), 'primary');
}

/**
 * The cancel control of the editor that contains `root`, or null.
 * @param {Element | null | undefined} root - an ancestor of the action row.
 * @returns {Element | null} the cancel button.
 */
export function editorCancelButton(root) {
  return editorActionButton(editorActionRow(root), 'secondary');
}

export function resolveConversationImageEncoder(ctx) {
  const conversation = safeClientGet(ctx, 'conversation');
  if (!conversation || typeof conversation.encodeImage !== 'function') return null;
  return Object.freeze({ adapter: 'preview', conversation });
}

/**
 * The conversation the main view currently shows, plus its `cwd`.
 *
 * Two released shapes carry that fact:
 *   - ≤0.1.6: `SessionListState.current` on the list snapshot (a staging cell
 *     the client controller owns).
 *   - ≥0.1.7: `current` was removed. Navigation retains the on-screen session
 *     as `{ source: 'mainView' }`, and the controller republishes each row's
 *     live `retainedBy` counts, so the row with a positive `mainView` count is
 *     the current one. DSH's own layout/session code reads exactly this way
 *     (`Object.values(byId).find(row => (row.retainedBy.mainView ?? 0) > 0)`).
 *
 * Nothing else (route, localStorage, DOM) can answer this question, so a
 * missing answer must stay `null` rather than guessed.
 * @param ctx - client context exposing the `sessions` service.
 * @returns `{ sessionId, cwd }`; `sessionId` is null when no session is staged.
 */
export function currentSessionState(ctx) {
  const state = resolveSessions(ctx)?.sessions?.list?.getSnapshot?.();
  const staged = state?.current;
  if (typeof staged === 'string' && staged.length > 0) {
    return { sessionId: staged, cwd: rowCwd(state, staged) };
  }
  const byId = state?.byId;
  if (byId && typeof byId === 'object') {
    for (const row of Object.values(byId)) {
      if (!row || (row.retainedBy?.mainView ?? 0) <= 0) continue;
      const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : null;
      if (id !== null) {
        return { sessionId: id, cwd: typeof row.cwd === 'string' && row.cwd.length > 0 ? row.cwd : undefined };
      }
    }
  }
  return { sessionId: null, cwd: undefined };
}

/** Per-session `cwd` from a list snapshot, when the row carries one. */
function rowCwd(state, sessionId) {
  const cwd = state?.byId?.[sessionId]?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
}

export function currentSessionId(ctx) {
  const sessionId = currentSessionState(ctx).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

/** Page event carrying one settings snapshot after a panel save. */
export const MV_AIDE_SETTINGS_EVENT = 'mv-aide:settings-changed';

/**
 * Feed one mv-AIDE namespace's effective values into a browser policy.
 *
 * The values live in the plugin-owned document behind `/api/mv-aide/settings`
 * (see mv-dsh-settings/lib/store.js): ≥0.1.7 has no client settings
 * scope to read, so the panel's route is the only live source. A released DSH
 * scope, when one exists (≤0.1.6), is layered on top by the caller.
 * @param namespace - document namespace owned by the calling plugin.
 * @param apply - receives one effective value object, plus that namespace's
 *   whole entry so the caller can see `manage`/`writable` and refuse to publish
 *   over a scope that a released DSH card owns; must ignore junk.
 * @returns disposer removing the page listener.
 */
export function watchMvAideSettings(namespace, apply) {
  const accept = (snapshot) => {
    const entry = snapshot?.namespaces?.[namespace];
    const values = entry?.values;
    if (values && typeof values === 'object') apply(values, entry);
  };
  const refresh = async () => {
    if (typeof window?.fetch !== 'function') return;
    try {
      const response = await window.fetch('/api/mv-aide/settings', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      accept(await response.json());
    } catch {
      // A missing route (mv-dsh-manager absent) keeps the built-in defaults.
    }
  };
  const onChanged = (event) => {
    if (event?.detail && typeof event.detail === 'object') accept(event.detail);
    else void refresh();
  };
  window?.addEventListener?.(MV_AIDE_SETTINGS_EVENT, onChanged);
  void refresh();
  return () => window?.removeEventListener?.(MV_AIDE_SETTINGS_EVENT, onChanged);
}

export function resolveWorkspaceClient(ctx) {
  const workspaces = safeClientGet(ctx, 'workspaces');
  if (!workspaces || typeof workspaces?.list?.getSnapshot !== 'function') return null;
  if (typeof workspaces.pickDirectory === 'function') {
    return Object.freeze({
      adapter: 'preview',
      workspaces,
      pickDirectory: workspaces.pickDirectory.bind(workspaces),
    });
  }
  const uiWorkspace = safeClientGet(ctx, 'uiWorkspace');
  return Object.freeze({
    adapter: typeof uiWorkspace?.pickDirectory === 'function' ? 'alpha' : 'preview',
    workspaces,
    pickDirectory: typeof uiWorkspace?.pickDirectory === 'function'
      ? uiWorkspace.pickDirectory.bind(uiWorkspace)
      : undefined,
  });
}

export function resolveConversation(ctx, sessionId = currentSessionId(ctx)) {
  if (!sessionId) return null;
  const sessions = resolveSessions(ctx)?.sessions;
  const actx = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
  if (!actx) return null;
  const conversation = safeClientGet(actx, 'conversation');
  const input = conversation?.input?.for?.(actx);
  if (!conversation || !input || typeof input?.state?.getSnapshot !== 'function'
      || typeof input.setDraft !== 'function') return null;
  return Object.freeze({ adapter: 'preview', sessions, sessionId, actx, conversation, input });
}

function composerElement(doc) {
  const textarea = doc?.querySelector?.('textarea[data-phase]');
  if (textarea) return { adapter: 'preview', element: textarea };
  const lexical = doc?.querySelector?.('div[data-phase][data-composer-input]');
  return lexical ? { adapter: 'alpha', element: lexical } : null;
}

function domSelectionOffsets(element, view) {
  if (!element || Number.isInteger(element?.selectionStart)) {
    const start = Number.isInteger(element?.selectionStart) ? element.selectionStart : undefined;
    const end = Number.isInteger(element?.selectionEnd) ? element.selectionEnd : start;
    return start === undefined ? null : { start, end };
  }
  const selection = view?.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const beforeStart = element.ownerDocument.createRange();
  beforeStart.selectNodeContents(element);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = element.ownerDocument.createRange();
  beforeEnd.selectNodeContents(element);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
}

function pointAtOffset(element, offset) {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  let last = null;
  while (node) {
    last = node;
    const length = node.nodeValue?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.nodeValue?.length ?? 0 } : { node: element, offset: element.childNodes.length };
}

function strictSelectionResult(start, end, length) {
  if (start === undefined) return { status: 'unknown' };
  return {
    status: 'known',
    start: Math.max(0, Math.min(start, length)),
    end: Math.max(Math.max(0, Math.min(end, length)), Math.max(0, Math.min(start, length))),
  };
}

/**
 * Strict DOM selection observer for recall round bookkeeping.
 *
 * Unlike `selection()`, this NEVER fabricates a caret-at-end fallback when
 * the DOM disagrees with the draft or the selection is absent: it reports
 * `{ status: 'unknown' }` instead, so callers can treat an unreadable
 * selection as non-informational rather than as a caret move. When the
 * DOM reports a real selection it is normalized against the rendered
 * length only (clamping), never against the observable draft, so a React
 * async commit gap stays `unknown` instead of looking like end-of-text.
 */
function composerStrictSelection(composer) {
  const doc = composer.element?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
  const element = composer.element;
  if (!element || !doc) return { status: 'unknown' };
  if (domAdapterOf(element, doc) === 'preview') {
    if (typeof element.selectionStart !== 'number' || typeof element.selectionEnd !== 'number') {
      return { status: 'unknown' };
    }
    const length = typeof element.value === 'string' ? element.value.length : 0;
    return strictSelectionResult(element.selectionStart, element.selectionEnd, length);
  }
  const view = doc.defaultView ?? (typeof window === 'undefined' ? undefined : window);
  const selection = view?.getSelection?.() ?? doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return { status: 'unknown' };
  const range = selection.getRangeAt(0);
  if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return { status: 'unknown' };
  }
  try {
    const beforeStart = doc.createRange();
    beforeStart.selectNodeContents(element);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = doc.createRange();
    beforeEnd.selectNodeContents(element);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    const length = typeof element.textContent === 'string' ? element.textContent.length : 0;
    return strictSelectionResult(beforeStart.toString().length, beforeEnd.toString().length, length);
  } catch {
    return { status: 'unknown' };
  }
}

function domAdapterOf(element, doc) {
  const tag = element?.tagName;
  if (typeof tag === 'string' && tag.toLowerCase() === 'textarea') return 'preview';
  if (typeof tag === 'string' && tag.toLowerCase() === 'div') return 'alpha';
  const lexical = doc?.querySelector?.('div[data-phase][data-composer-input]');
  if (lexical === element) return 'alpha';
  const textarea = doc?.querySelector?.('textarea[data-phase]');
  if (textarea === element) return 'preview';
  return null;
}

function buildComposer(target, doc) {
  const dom = composerElement(doc);
  if (!target || !dom) return null;
  return Object.freeze({
    ...target,
    adapter: dom.adapter,
    element: dom.element,
    snapshot: () => target.input.state.getSnapshot(),
    selection() {
      const snapshot = target.input.state.getSnapshot();
      const rendered = dom.adapter === 'preview' ? dom.element.value : dom.element.textContent;
      if (typeof rendered === 'string' && rendered !== snapshot.draft) {
        return { start: snapshot.draft.length, end: snapshot.draft.length };
      }
      const selected = domSelectionOffsets(dom.element, doc?.defaultView);
      if (!selected) return { start: snapshot.draft.length, end: snapshot.draft.length };
      return {
        start: Math.max(0, Math.min(selected.start, snapshot.draft.length)),
        end: Math.max(0, Math.min(selected.end, snapshot.draft.length)),
      };
    },
    setDraft: (text) => target.input.setDraft(text),
    strictSelection: () => composerStrictSelection({ element: dom.element }),
    focusAt(start, end = start) {
      const snapshot = target.input.state.getSnapshot();
      const from = Math.max(0, Math.min(start, snapshot.draft.length));
      const to = Math.max(from, Math.min(end, snapshot.draft.length));
      dom.element.focus?.();
      if (dom.adapter === 'preview' && typeof dom.element.setSelectionRange === 'function') {
        dom.element.setSelectionRange(from, to);
        return;
      }
      const selection = doc?.defaultView?.getSelection?.() ?? doc?.getSelection?.();
      if (!selection) return;
      const range = doc.createRange();
      if (from === snapshot.draft.length && to === from && typeof range.selectNodeContents === 'function') {
        range.selectNodeContents(dom.element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      const fromPoint = pointAtOffset(dom.element, from);
      const toPoint = pointAtOffset(dom.element, to);
      range.setStart(fromPoint.node, fromPoint.offset);
      range.setEnd(toPoint.node, toPoint.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    },
  });
}

export function resolveComposerInput(input, doc = typeof document === 'undefined' ? undefined : document) {
  if (!input || typeof input?.state?.getSnapshot !== 'function' || typeof input.setDraft !== 'function') return null;
  return buildComposer({ input }, doc);
}

export function resolveComposer(ctx, doc = typeof document === 'undefined' ? undefined : document, sessionId = currentSessionId(ctx)) {
  return buildComposer(resolveConversation(ctx, sessionId), doc);
}

/**
 * The pending plan-review request of one session, if any.
 *
 * ≥0.1.7 projects pending interactions per Session inside the unified status
 * snapshot (`uiSession.sessionStatus`, a `ReadonlyMap<SessionId, SessionStatus>`
 * whose entry carries `pendingInteraction`), and the plan-review carrier is a
 * `PendingQuestion` with `kind === 'plan-review'` and a public `cancel()`.
 * The earlier `uiSession.pendingInteractions` map is still honored first so an
 * in-between Alpha build keeps working.
 */
function pendingPlanReview(ctx, sessionId) {
  const uiSession = safeClientGet(ctx, 'uiSession');
  const legacy = uiSession?.pendingInteractions?.getSnapshot?.();
  const fromLegacy = legacy instanceof Map ? legacy.get(sessionId) : legacy?.get?.(sessionId);
  const status = uiSession?.sessionStatus?.getSnapshot?.();
  const entry = status?.get?.(sessionId);
  const interaction = fromLegacy ?? entry?.pendingInteraction;
  const isPlanReview = interaction?.kind === 'plan-review';
  if (!isPlanReview || typeof interaction?.cancel !== 'function') return null;
  return Object.freeze({
    adapter: entry?.pendingInteraction === interaction ? 'alpha' : 'preview',
    key: interaction.key ?? interaction,
    interaction,
    cancel: () => interaction.cancel(),
  });
}

export function resolvePendingPlanReview(ctx, sessionId = currentSessionId(ctx)) {
  if (!sessionId) return null;
  return pendingPlanReview(ctx, sessionId);
}

/**
 * The Chat projection `{ order, nodes }` of one conversation.
 *
 * ≥0.1.7 removed `snapshot.chat` from the Session face and made both `binding`
 * and `scope` *borrow-only*: they answer for a generation something already
 * retains (DSH's own main view retains the on-screen conversation), and
 * `uiConversation.binding` throws for anything else. Only the current
 * conversation is ever asked for here, and a missing projection must stay null
 * rather than surface as a throw inside a key handler.
 */
export function resolveChatProjection(ctx, sessionId = currentSessionId(ctx)) {
  if (!sessionId) return null;
  const sessions = resolveSessions(ctx)?.sessions;
  let binding;
  try {
    binding = sessions?.binding?.(sessionId);
  } catch {
    binding = undefined;
  }
  try {
    const preview = binding?.session?.getSnapshot?.()?.chat;
    if (preview !== undefined) return Object.freeze({ adapter: 'preview', chat: preview, binding });
    const actx = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
    const uiConversation = actx ? safeClientGet(actx, 'uiConversation') : undefined;
    const target = uiConversation?.binding?.(sessionId)?.target?.('chat');
    const chat = target?.getSnapshot?.();
    return chat === undefined ? null : Object.freeze({ adapter: 'alpha', chat, binding, target });
  } catch {
    return null;
  }
}

/**
 * Standalone strict-selection read over the composer element resolved from
 * `doc` (defaults to the global document). Mirrors the per-composer
 * `strictSelection()` method but is callable without a resolved conversation
 * facade, so recall bookkeeping can poll the DOM even when the input store
 * is momentarily unavailable. Returns `{ status: 'known', start, end }` or
 * `{ status: 'unknown' }` — never a fabricated caret position.
 */
export function composerSelection(element, doc = element?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document)) {
  if (!element || !doc) return { status: 'unknown' };
  return composerStrictSelection({ element });
}

// The Obsidian build turns this exact object into a DSH client-runtime module
// inside each existing plugin bundle. The compatibility package itself stays
// a plain library: it has no Cordis entry, patch row, or independently loaded
// client plugin.
export const CLIENT_COMPAT_API = Object.freeze({
  safeClientGet,
  resolveSettingsCardHost,
  resolveSessions,
  modelRowDisclosure,
  editorActionRow,
  editorActionButton,
  editorSaveButton,
  editorCancelButton,
  resolveConversationImageEncoder,
  currentSessionState,
  currentSessionId,
  MV_AIDE_SETTINGS_EVENT,
  watchMvAideSettings,
  resolveWorkspaceClient,
  resolveConversation,
  resolveComposerInput,
  resolveComposer,
  resolvePendingPlanReview,
  resolveChatProjection,
  composerSelection,
});
