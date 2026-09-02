// Complete, non-live session history for browser-side ArrowUp recall.
// Reading through sessionQuery never expands the visible chat pagination.

import { resolveSessionInspector, resolveSessionLogReader } from '../../mv-dsh-compat/lib/host.js';

export class HistoryRecallError extends Error {
  constructor(message, status = 400, code = 'invalid-history-recall') {
    super(message);
    this.name = 'HistoryRecallError';
    this.status = status;
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sessionIdOf(payload) {
  const sessionId = payload?.sessionId;
  if (
    typeof sessionId !== 'string'
    || sessionId.trim() !== sessionId
    || sessionId.length === 0
    || sessionId.length > 512
    || sessionId.includes('\0')
  ) {
    throw new HistoryRecallError('sessionId must be a non-empty, trimmed string.');
  }
  return sessionId;
}

function contentOf(event) {
  const data = isRecord(event?.data) ? event.data : undefined;
  if (!data) return undefined;
  if (event.type === 'user/message') {
    const source = isRecord(data.source) ? data.source : undefined;
    if (source?.kind !== 'user') return undefined;
    return Array.isArray(data.content) ? data.content : undefined;
  }
  if (event.type !== 'steering/message') return undefined;
  const wrapped = isRecord(data.message) ? data.message : undefined;
  const content = wrapped?.content ?? data.content;
  return Array.isArray(content) ? content : undefined;
}

export function extractHistoryMessages(snapshot) {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const messages = [];
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq)) continue;
    const content = contentOf(event);
    if (!content) continue;
    const parts = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) messages.push({ seq: event.seq, text: parts.join('\n') });
  }
  messages.sort((left, right) => right.seq - left.seq);
  return messages;
}

export function createHistoryRecallService(ctx) {
  return Object.freeze({
    async read(payload) {
      const sessionId = sessionIdOf(payload);
      // Fast path: borrow the session's immutable view (zero-copy for live
      // sessions). Falls back to the replay-validated readSession when the
      // persistence service is absent; both are 503-free structural seams.
      const inspector = resolveSessionInspector(ctx);
      const reader = inspector ? null : resolveSessionLogReader(ctx);
      if (!inspector && !reader) {
        throw new HistoryRecallError(
          'This DSH runtime does not expose complete session history.',
          503,
          'session-history-unavailable',
        );
      }
      const snapshot = inspector
        ? await inspector.inspect(sessionId)
        : await reader.readSession(sessionId);
      return { ok: true, messages: extractHistoryMessages(snapshot) };
    },
  });
}
