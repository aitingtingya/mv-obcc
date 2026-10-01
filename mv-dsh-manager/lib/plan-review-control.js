// @mv-aide/mv-dsh-manager — host-side plan review exit control.
//
// DSH rc.6 turns "Chat about it" into a cancelled userQuestions request.
// dsh-plan-mode then materializes that cancellation as an exit_plan_mode tool
// error whose text explicitly says to stop and wait for the user's message.
// Without an execution gate the agent immediately starts another step, spends
// one extra model call, and usually replies that it will wait. This module makes
// the existing instruction real: suppress only that automatic follow-up step.
// The suppression is scoped to the turn that carried the dismissal — the agent
// loop ends that turn on the rejection — so every later turn runs untouched. A
// goal round, a scheduled follow-up, and a queued plugin prompt each open their
// own turn, and none of them may be swallowed while the session waits.

export const PLAN_EXIT_TOOL = 'exit_plan_mode';
export const PLAN_REVIEW_DISMISS_MARKER = 'dismissed the plan review to speak instead';

function textFragments(result) {
  const values = [];
  if (typeof result?.error?.message === 'string') values.push(result.error.message);
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === 'text' && typeof item.text === 'string') values.push(item.text);
    }
  }
  return values;
}

export function isPlanReviewDismissResult(exec, result) {
  if (exec?.name !== PLAN_EXIT_TOOL || !exec?.agent?.session || result?.isError !== true) {
    return false;
  }
  return textFragments(result).some((text) => text.includes(PLAN_REVIEW_DISMISS_MARKER));
}

function hasRealUserMessage(messages) {
  return Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user');
}

/**
 * Install the plan-review exit gate into a DSH host context.
 *
 * The gate defers one session for the turn in which the plan review was
 * dismissed, and the installed `session/event` listener ends that deferral on
 * the turn's `turn/end`.
 *
 * The returned disposer is idempotent as far as Cordis listeners are concerned:
 * every listener disposer is called once when the owning plugin unloads.
 */
export function installPlanReviewControl(ctx, options = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {};
  const enabled = () => options.enabled?.() !== false;

  const deferredSessions = new WeakMap();
  let policyGeneration = 0;
  const unsubscribe = options.subscribe?.((next, previous) => {
    if (previous?.planReviewEnhancementEnabled !== false
        && next?.planReviewEnhancementEnabled === false) policyGeneration += 1;
  });

  const disposeExecute = ctx.on('tools/execute', async (exec, next) => {
    const result = await next();
    if (enabled() && isPlanReviewDismissResult(exec, result)) {
      deferredSessions.set(exec.agent.session, policyGeneration);
    }
    return result;
  });

  // The rejected step ends the agent-loop turn that produced the dismissal, and
  // the loop appends `turn/end` on every exit including abort and disposal. A
  // new turn is a new human-facing boundary, so the deferral ends with the turn
  // it was armed in.
  const disposeSessionEvent = ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') deferredSessions.delete(session);
  });

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async ({ agent, messages } = {}, next) => {
      const session = agent?.session;
      if (!enabled() || !session || deferredSessions.get(session) !== policyGeneration) return next();

      // The step immediately following the cancelled exit_plan_mode has no new
      // human input. Rejecting it ends the current turn before another LLM
      // request is assembled. Plugin notices or other synthetic context must not
      // wake the agent either.
      if (!hasRealUserMessage(messages)) return { kind: 'reject' };

      // Only clear the gate after the real user prompt survives the rest of the
      // pre-step chain. If another plugin rejects it, keep waiting for a prompt
      // that is actually accepted.
      const decision = await next();
      if (decision?.kind !== 'reject') deferredSessions.delete(session);
      return decision;
    },
    { prepend: true },
  );

  return () => {
    if (typeof disposePreStep === 'function') disposePreStep();
    if (typeof disposeSessionEvent === 'function') disposeSessionEvent();
    if (typeof disposeExecute === 'function') disposeExecute();
    unsubscribe?.();
  };
}
