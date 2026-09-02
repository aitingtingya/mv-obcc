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

export function resolveConversationImageEncoder(ctx) {
  const conversation = safeClientGet(ctx, 'conversation');
  if (!conversation || typeof conversation.encodeImage !== 'function') return null;
  return Object.freeze({ adapter: 'preview', conversation });
}

export function currentSessionId(ctx) {
  const sessions = resolveSessions(ctx)?.sessions;
  const current = sessions?.list?.getSnapshot?.()?.current;
  return typeof current === 'string' && current.length > 0 ? current : null;
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

function previewPending(ctx, sessionId) {
  const sessions = resolveSessions(ctx)?.sessions;
  const pending = sessions?.binding?.(sessionId)?.session?.getSnapshot?.()?.pending;
  if (!Array.isArray(pending)) return null;
  const interaction = pending.find((value) => {
    if (value?.kind !== 'question' || typeof value.respond !== 'function') return false;
    const questions = value.payload?.questions;
    return Array.isArray(questions) && questions.length === 1
      && questions[0]?.intent?.kind === 'plan-review' && questions[0]?.detail !== undefined;
  });
  if (!interaction) return null;
  return Object.freeze({
    adapter: 'preview', key: interaction.key ?? interaction,
    interaction,
    async cancel(response) {
      const receipt = await interaction.respond(response);
      if (receipt?.accepted === false) throw new Error(`plan review cancellation rejected: ${receipt.reason ?? 'unknown reason'}`);
    },
  });
}

function alphaPending(ctx, sessionId) {
  const uiSession = safeClientGet(ctx, 'uiSession');
  const snapshot = uiSession?.pendingInteractions?.getSnapshot?.();
  const interaction = snapshot instanceof Map ? snapshot.get(sessionId) : snapshot?.get?.(sessionId);
  if (interaction?.kind !== 'plan-review' || typeof interaction.cancel !== 'function') return null;
  return Object.freeze({
    adapter: 'alpha', key: interaction.key ?? interaction, interaction,
    cancel: () => interaction.cancel(),
  });
}

export function resolvePendingPlanReview(ctx, sessionId = currentSessionId(ctx)) {
  if (!sessionId) return null;
  return previewPending(ctx, sessionId) ?? alphaPending(ctx, sessionId);
}

export function resolveChatProjection(ctx, sessionId = currentSessionId(ctx)) {
  if (!sessionId) return null;
  const sessions = resolveSessions(ctx)?.sessions;
  const binding = sessions?.binding?.(sessionId);
  const preview = binding?.session?.getSnapshot?.()?.chat;
  if (preview !== undefined) return Object.freeze({ adapter: 'preview', chat: preview, binding });
  const actx = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined;
  const uiConversation = actx ? safeClientGet(actx, 'uiConversation') : undefined;
  const target = uiConversation?.binding?.(sessionId)?.target?.('chat');
  const chat = target?.getSnapshot?.();
  return chat === undefined ? null : Object.freeze({ adapter: 'alpha', chat, binding, target });
}

// The Obsidian build turns this exact object into a DSH client-runtime module
// inside each existing plugin bundle. The compatibility package itself stays
// a plain library: it has no Cordis entry, patch row, or independently loaded
// client plugin.
export const CLIENT_COMPAT_API = Object.freeze({
  safeClientGet,
  resolveSettingsCardHost,
  resolveSessions,
  resolveConversationImageEncoder,
  currentSessionId,
  resolveWorkspaceClient,
  resolveConversation,
  resolveComposerInput,
  resolveComposer,
  resolvePendingPlanReview,
  resolveChatProjection,
});
