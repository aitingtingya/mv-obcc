// Pure helpers for the passive-delivery dedupe / delivery decisions.
// Kept free of dsh runtime imports so `node --test` can cover them.

import { isInsideAny } from './diff-hook.js';

/**
 * Whether one channel may operate for an agent with the given session cwd:
 *  - no vault-folder knowledge (empty roots) → allow (nothing to compare);
 *  - cwd inside the vault roots → always allow (policy is outside-only);
 *  - otherwise → the per-channel opt-in (`outsideToolPolicy[name] === true`).
 */
export function allowedForAgent(cwd, folders, policy, channel) {
  const roots = Array.isArray(folders) ? folders : [];
  if (roots.length === 0) return true;
  if (typeof cwd === 'string' && cwd.length > 0 && isInsideAny(cwd, roots)) return true;
  return policy?.[channel] === true;
}

/**
 * Whether a selection/mention delivery may reach an OUTSIDE-vault agent,
 * driven by the page-type tracking keys (trackMarkdown / trackPdf /
 * trackWebview) copied from the mv-AIDE settings. Unknown view types fall
 * back to "any tracking key enabled".
 */
export function selectionAllowedForOutside(policy, viewType) {
  if (viewType === 'markdown') return policy?.trackMarkdown === true;
  if (viewType === 'pdf') return policy?.trackPdf === true;
  if (viewType === 'webview') return policy?.trackWebview === true;
  return (
    policy?.trackMarkdown === true ||
    policy?.trackPdf === true ||
    policy?.trackWebview === true
  );
}

/**
 * Canonical identity of one selection state: file + trimmed text. Two
 * states with the same signature carry the same context and must never be
 * injected twice.
 */
export function selectionSignature(filePath, text) {
  return `${filePath ?? ''}\u0000${text ?? ''}`;
}

/**
 * Delivery decision for a pending selection snapshot against the latest
 * delivered state:
 *  - 'drop'    — null, or identical to the latest state (re-broadcast);
 *  - 'clear'   — no text on the already-reported file (deselection / pure
 *                cursor move): it SUPERSEDES the latest state so the stale
 *                selected text is never delivered afterwards, but nothing
 *                is injected for it;
 *  - 'deliver' — new non-empty text, or a file change without text (the
 *                newly opened page is context of its own).
 */
export function shouldDeliverSelection(pending, lastFile, lastSignature) {
  if (!pending) return 'drop';
  if (pending.signature === lastSignature) return 'drop';
  if (pending.text.length === 0) {
    return pending.filePath === lastFile ? 'clear' : 'deliver';
  }
  return 'deliver';
}

/** Canonical identity of an @mention (file + line range). */
export function mentionSignature(params) {
  return `${params?.filePath ?? ''}\u0000${params?.lineStart ?? ''}\u0000${params?.lineEnd ?? ''}`;
}

/**
 * 状态栏勾选框的推送渠道开关：pushLocation/pushSelection 为 false 时该
 * 渠道不推送；两者皆关则整条 selection_changed 通知都不推送。
 */
export function selectionChannels(pushLocation, pushSelection) {
  const includeLocation = pushLocation !== false;
  const includeText = pushSelection !== false;
  return {
    includeLocation,
    includeText,
    enabled: includeLocation || includeText,
  };
}

/**
 * Prune expired entries and decide whether this mention signature was seen
 * recently. Side effect: a fresh (non-duplicate) signature is recorded.
 */
export function isDuplicateMention(recent, signature, now, windowMs, maxHistory) {
  while (recent.length > 0 && now - recent[0].at > windowMs) recent.shift();
  if (recent.some((entry) => entry.signature === signature)) return true;
  recent.push({ signature, at: now });
  if (recent.length > maxHistory) recent.shift();
  return false;
}
