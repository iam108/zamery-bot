function packetFromOrder(order, materials) {
  const id = Number(order.id);
  const type = String(order.object_type || '').toLowerCase();
  const files = materials.map(file => ({ id: file.id, name: file.name, mime: file.mime, role: file.role, bytes: file.bytes, sha256: file.sha256, url: '/api/audit/orders/' + id + '/materials/' + file.id }));
  const archiveUrl = order.service === 'Продление' ? order.archive_url || '' : '';
  const archiveFiles = files.some(file => file.role === 'archive');
  return {
    order_id: id, org: order.owner_name || order.object_name || '', object_name: order.object_name || '', address: order.address || '',
    object_category: /табак/.test(type) ? 'tobacco' : /общепит/.test(type) ? 'catering' : /магазин|рознич|торговл/.test(type) ? 'retail' : 'other',
    service: order.service || '', cad_num: order.cad_num || '', region: 'МСК', contacts: order.contacts || '',
    deadline: order.deadline ? new Date(order.deadline).toISOString().slice(0, 10) : '', zones_info: order.zones_info || '',
    video_required: !!order.has_video, has_video: !!order.has_video, archive_url: archiveUrl, materials: files,
    materials_download_url: '/api/audit/orders/' + id + '/materials/download-all',
    archive_download_url: order.service === 'Продление' ? (archiveFiles ? '/api/audit/orders/' + id + '/materials/download-all?role=archive' : archiveUrl ? '/api/audit/orders/' + id + '/archive/download' : '') : '',
  };
}

function createPacketLoader({ getOrder, getMaterials }) {
  return async (orderId, ids) => {
    const order = await getOrder(orderId);
    if (!order) throw Object.assign(new Error('Заявка менеджера не найдена.'), { status: 404 });
    let files = await getMaterials(orderId);
    if (ids != null) {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw Object.assign(new Error('Некорректный комплект документов заявки.'), { status: 400 });
      const wanted = new Set(ids);
      files = files.filter(file => wanted.has(file.id));
      if (files.length !== wanted.size) throw Object.assign(new Error('Документ не относится к этой заявке или больше недоступен. Обновите заявку.'), { status: 409 });
    }
    return packetFromOrder(order, files);
  };
}

async function loadAuditPacket(orderId, ids) {
  return createPacketLoader({ getOrder: require('../db/queries').getOrderById, getMaterials: require('./order-materials').listOrderMaterials })(orderId, ids);
}

module.exports = { packetFromOrder, createPacketLoader, loadAuditPacket };
