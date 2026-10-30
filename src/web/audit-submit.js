const { hydrateDraftReport } = require('../bot/audit-workflow');
const { validateInspection } = require('../bot/audit-inspection');

function createAuditSubmitter(drafts, deliver, options = {}) {
  return async function submit(owner, id, revision, ctx) {
    const run = async () => {
    const snapshot = await drafts.loadDraftForSubmit(owner, id, revision);
    if (snapshot.submitted_at) return { ok: true, already_submitted: true, draft_id: id };
    let data;
    let trustedPacket;
    let storedProgress;
    try {
      if (snapshot.data?.ui_version >= 4) {
        if (!snapshot.order_id) throw new Error('Откройте проверку из заявки менеджера.');
        storedProgress = await drafts.loadDraftDelivery(owner, id);
        if (storedProgress.packet) trustedPacket = storedProgress.packet;
        else if (options.loadPacket) {
          // V5 delivers the complete manager packet; a client-side selection must
          // not silently omit original documents from the lawyer's handoff.
          const requested = snapshot.data.ui_version === 5 ? undefined : snapshot.data.request_packet?.materials?.map(f => f.id);
          trustedPacket = await options.loadPacket(snapshot.order_id, requested);
          if (snapshot.data.request_packet?.service && snapshot.data.request_packet.service !== trustedPacket.service) throw Object.assign(new Error('Менеджер изменил услугу в заявке. Обновите проверку перед отправкой.'), { status: 409 });
          if (snapshot.data.ui_version === 5) {
            for (const [field, label] of [['address', 'адрес'], ['object_category', 'тип объекта'], ['org', 'организацию']]) {
              const original = snapshot.data.request_packet?.[field];
              if (original != null && String(original).trim() !== String(trustedPacket[field] || '').trim()) throw Object.assign(new Error('Менеджер изменил ' + label + ' в заявке. Обновите проверку и сверьте материалы объекта перед отправкой.'), { status: 409 });
            }
          }
        }
        if (snapshot.data.ui_version === 5 && !trustedPacket) throw new Error('Не удалось проверить заявку менеджера. Обновите форму и повторите отправку.');
        if (trustedPacket) snapshot.data = { ...snapshot.data, request_packet: trustedPacket };
        const packet = snapshot.data.request_packet;
        if (!packet || !packet.org || !packet.address || !packet.service) throw new Error('В заявке не хватает данных объекта или услуги. Менеджеру нужно дополнить заявку.');
      }
      data = hydrateDraftReport(snapshot);
      validateInspection(data);
    } catch (e) {
      await drafts.releaseDraftSubmission(owner, id, revision).catch(() => {});
      e.status = e.status || 400;
      throw e;
    }
    if (trustedPacket && !storedProgress?.packet) await drafts.saveDraftDelivery(owner, id, revision, { ...storedProgress, packet: trustedPacket });
    const deliveryCtx = { ...ctx, auditDelivery: {
      load: () => drafts.loadDraftDelivery(owner, id),
      save: progress => drafts.saveDraftDelivery(owner, id, revision, trustedPacket ? { ...progress, packet: trustedPacket } : progress),
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
