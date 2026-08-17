// @mv-aide/mv-dsh-manager — browser-side plan review keyboard enhancement.
//
// Kept as its own DSH client module so the manager's existing recursive command
// picker remains isolated. The only behavior here is Escape on the currently
// visible plan-review interaction. It sends the exact cancellation carrier used
// by DSH rc.6 PendingQuestion.cancel(); the host-side plan-review-control module
// decides whether that cancellation may start another agent step.

window.__ModuleLoader__.load({
  id: '@mv-aide/mv-dsh-manager/plan-review-client',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = ['sessions'];
    const CANCEL_RESPONSE = Object.freeze({
      ok: false,
      error: Object.freeze({
        code: 'cancelled',
        message: 'the user closed this question request',
        details: Object.freeze({}),
      }),
    });

    function sessionsOf(ctx) {
      return ctx && typeof ctx.get === 'function'
        ? (ctx.get('sessions') || ctx.sessions)
        : ctx?.sessions;
    }

    function isPlanReviewInteraction(interaction) {
      if (interaction?.kind !== 'question' || typeof interaction.respond !== 'function') return false;
      const questions = interaction.payload?.questions;
      if (!Array.isArray(questions) || questions.length !== 1) return false;
      const question = questions[0];
      return question?.intent?.kind === 'plan-review' && question.detail !== undefined;
    }

    function activePlanReview(ctx) {
      const sessions = sessionsOf(ctx);
      const sessionId = sessions?.list?.getSnapshot?.()?.current;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
      const binding = sessions?.binding?.(sessionId);
      const pending = binding?.session?.getSnapshot?.()?.pending;
      if (!Array.isArray(pending)) return null;
      return pending.find(isPlanReviewInteraction) || null;
    }

    function apply(ctx) {
      if (typeof window?.addEventListener !== 'function') return;

      let inFlightKey = null;
      let dismissedKey = null;

      const onKeyDown = (event) => {
        if (event?.key !== 'Escape' || event.isComposing === true) return;

        const pending = activePlanReview(ctx);
        if (!pending) {
          dismissedKey = null;
          return;
        }

        const key = pending.key ?? pending;
        if (key === inFlightKey || key === dismissedKey) return;

        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        inFlightKey = key;

        Promise.resolve()
          .then(() => pending.respond(CANCEL_RESPONSE))
          .then((receipt) => {
            if (receipt?.accepted === false) {
              throw new Error(`plan review cancellation rejected: ${receipt.reason ?? 'unknown reason'}`);
            }
            dismissedKey = key;
          })
          .catch((error) => {
            console.warn('[mv-dsh-manager] plan review Escape cancellation failed', error);
          })
          .finally(() => {
            if (inFlightKey === key) inFlightKey = null;
          });
      };

      const install = () => {
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      };

      if (typeof ctx?.effect === 'function') {
        ctx.effect(install, 'mv-dsh-manager: plan review Escape');
      } else {
        install();
      }
    }

    exports.inject = inject;
    exports.CANCEL_RESPONSE = CANCEL_RESPONSE;
    exports.isPlanReviewInteraction = isPlanReviewInteraction;
    exports.activePlanReview = activePlanReview;
    exports.apply = apply;
    return module.exports;
  },
});
