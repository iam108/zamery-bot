const { hydrateDraftReport } = require('../bot/audit-workflow');
const { validateInspection } = require('../bot/audit-inspection');

function createAuditSubmitter(drafts, deliver) {
  return async function submit(owner, id, revision, ctx) {
    const run = async () => {
    const snapshot = await drafts.loadDraftForSubmit(owner, id, revision);
    if (snapshot.submitted_at) return { ok: true, already_submitted: true, draft_id: id };
    let data;
    try {
      data = hydrateDraftReport(snapshot);
      validateInspection(data);
    } catch (e) {
      await drafts.releaseDraftSubmission(owner, id, revision).catch(() => {});
      e.status = e.status || 400;
      throw e;
    }
    const deliveryCtx = { ...ctx, auditDelivery: {
      load: () => drafts.loadDraftDelivery(owner, id),
      save: progress => drafts.saveDraftDelivery(owner, id, revision, progress),
    } };
    // From this point onward a Telegram request may have reached its target
    // even when its response or checkpoint is lost. Keep this version frozen.
    await deliver(deliveryCtx, data);
    await drafts.markDraftSubmitted(owner, id, revision);
    return { ok: true, draft_id: id };
    };
    return drafts.withDraftDeliveryLock ? drafts.withDraftDeliveryLock(owner, id, run) : run();
  };
}

module.exports = { createAuditSubmitter };
