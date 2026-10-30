const { randomUUID } = require('node:crypto');
const { normalizeWorkflow } = require('../../src/bot/audit-workflow');

function compactVisit(category = 'catering', service = 'Получение') {
  const evidence = [
    { id: randomUUID(), name: 'Поэтажный план.pdf', mime: 'application/pdf', role: 'plan-source', subject_id: 'plan' },
    { id: randomUUID(), name: 'Карта.png', mime: 'image/png', role: 'map-source', subject_id: 'map' },
    { id: randomUUID(), name: 'Вход.jpg', mime: 'image/jpeg', role: 'entrance', subject_id: 'entrance-1' },
    { id: randomUUID(), name: 'Размеченный план.png', mime: 'image/png', role: 'plan', subject_id: 'annotation' },
    { id: randomUUID(), name: 'Схема.png', mime: 'image/png', role: 'map', subject_id: 'annotation' },
  ];
  const archive = { id: randomUUID(), name: 'Архивная графика.pdf', mime: 'application/pdf', role: 'archive' };
  return normalizeWorkflow({
    schema_version: 3, ui_version: 5, order_id: 58, object_category: category,
    building_type: 'Жилое', bti: 'Да', to: 'Не нужно', conclusion: '',
    request_packet: { org: 'ООО Пример', address: 'Москва, Никольская, 1', service, object_category: category,
      contacts: 'Клиент +7 900 000-00-00', zones_info: 'Проверить план и окружение', video_required: false,
      materials: service === 'Продление' ? [archive] : [] },
    inspection: { org: 'ООО Пример', address: 'Москва, Никольская, 1', service, floor_plan: '1', floor_actual: '1 этаж',
      cadastral_count: '1', rooms_complete: 'Да', within_cadastral: 'Да', kkt_count: '1', kkt_ip: 'Нет', plan_note: '',
      ...(category === 'tobacco' ? { tobacco_display: 'Закрытая', tobacco_price_list: 'Есть', tobacco_advertising: 'Нет' } : { alcohol_present: 'Нет' }) },
    workflow: { step: 2, conclusion_status: 'ready', video_url: '' },
    entrances: [{ id: 'entrance-1', label: 'Главный вход', access: 'Осмотрен' }], zones: [],
    map: { evidence_id: evidence[1].id, page: 1, annotations: [{ id: 'entrance-1', code: 'В1', tool: 'entrance', points: [{ x: 0.2, y: 0.3 }], distance: '' }] },
    plan: { evidence_id: evidence[0].id, page: 2, annotations: [{ id: 'boundary-1', code: 'Г1', tool: 'boundary', points: [{ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.1 }, { x: 0.7, y: 0.8 }] }] },
    additional_plans: [], evidence,
  });
}

function addOrganization(data, { id = 'org-4', code = 'О4', status = 'clear', source = '', note = '', name = 'Соседняя организация' } = {}) {
  data.map.annotations.push({ id, code, tool: 'hazard', label: name, status, source, note, points: [{ x: 0.8, y: 0.4 }] });
  data.zones.push({ id, name, status, source, note });
  data.evidence.push({ id: randomUUID(), name: code + '.jpg', mime: 'image/jpeg', role: 'zone', subject_id: id });
  return data;
}

module.exports = { compactVisit, addOrganization };
