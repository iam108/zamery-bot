(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuditReportIssues = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  // Recorded observations and required evidence only; no legal thresholds.
  var catalog = {
    'floor-mismatch': ['inspection.floor_actual', 'Этаж на плане и фактический этаж различаются.'],
    'cadastral-boundaries': ['inspection.within_cadastral', 'Аудитор отметил нарушение внешних границ помещения.'],
    'inter-cadastral': ['inspection.inter_cadastral_boundary', 'Граница между кадастровыми помещениями убрана.'],
    'rooms-incomplete': ['inspection.rooms_complete', 'Указано «Часть не входит»: не вся площадь по выбранному плану входит в объект.'],
    'plan-mismatch': ['bti', 'Планировка отличается от представленного плана.'],
    'technical-description': ['to', 'Аудитор указал, что требуется техническое описание (ТО).'],
    'archive-skipped': ['workflow.archive_skipped', 'Архив не предоставлен; сверка с архивом не выполнена.', 'unverified', 0],
    'archive-mismatch': ['inspection.archive_match', 'Аудитор отметил расхождения с архивом.'],
    'archive-unchecked': ['inspection.archive_match', 'Сверка с архивом не выполнена.', 'unverified'],
    'licensed-boundaries': ['inspection.licensed_boundaries_match', 'Аудитор отметил расхождение лицензированных границ.'],
    'licensed-boundaries-unchecked': ['inspection.licensed_boundaries_match', 'Соблюдение лицензированных границ не подтверждено.', 'unverified'],
    'tobacco-display': ['inspection.tobacco_display', 'Зафиксирована открытая выкладка табачной продукции.'],
    'tobacco-prices': ['inspection.tobacco_price_list', 'Перечень продукции с ценами отсутствует.'],
    'tobacco-ads': ['inspection.tobacco_advertising', 'Зафиксирована реклама табака.'],
    'alcohol-unknown': ['inspection.alcohol_present', 'Наличие алкоголя не установлено.', 'unverified'],
    'alcohol-new': ['inspection.alcohol_present', 'Для получения отмечено наличие алкоголя; по рабочему правилу команды его нужно убрать.'],
    'alcohol-zone': ['inspection.alcohol_within_licensed', 'Алкоголь находится за пределами лицензированной зоны.'],
    'video-status': ['inspection.video_status', 'Готовность видео из задания менеджера не подтверждена.', 'unverified', 2],
    'unverified:floor_plan': ['inspection.floor_plan', 'Этаж на плане не проверен.', 'unverified'],
    'unverified:floor_actual': ['inspection.floor_actual', 'Фактический этаж не проверен.', 'unverified'],
  };
  var sections = ['territory', 'premises', 'report'];
  function isUnverifiedFloor(value) {
    return typeof value === 'string' && value.trim().replace(/\s+/g, ' ').toLowerCase() === 'не проверено';
  }
  function requiredStep(control) {
    if (/^(?:map\.|entrances(?:\.|$)|zones(?:\.|$)|evidence\.(?:entrance|zone)\.|building_type$|workflow\.(?:territory_result|archive_skipped)$|inspection\.(?:org|address|service)$)/.test(control)) return 0;
    return /^(?:workflow\.(?:video_url|conclusion_status)|conclusion$|inspection\.video_status$)/.test(control) ? 2 : 1;
  }
  function describe(data, task) {
    if (!task || typeof task.id !== 'string') return null;
    var p = data && data.inspection || {}, id = task.id, entry = catalog[id], control, kind, step, reason;
    var zones = data && Array.isArray(data.zones) ? data.zones : [], entrances = data && Array.isArray(data.entrances) ? data.entrances : [];
    var zone = zones.find(function (item) { return item && (id === 'zone:' + item.id || id === 'zone-distance:' + item.id); });
    var entrance = entrances.find(function (item) { return item && id === 'entrance:' + item.id; });
    if (id.startsWith('required:')) {
      control = id.slice('required:'.length); if (!control) return null;
      kind = 'missing_required'; step = requiredStep(control); reason = task.label || 'Дополните обязательные сведения.';
    } else if (entry) {
      control = entry[0]; reason = entry[1]; kind = entry[2] || 'adverse'; step = entry[3] == null ? 1 : entry[3];
      if (id === 'floor-mismatch') reason = 'Этаж на плане: «' + String(p.floor_plan || 'не указан') + '»; фактически: «' + String(p.floor_actual || 'не указан') + '». Значения различаются.';
      if (id === 'floor-mismatch' && (isUnverifiedFloor(p.floor_plan) || isUnverifiedFloor(p.floor_actual))) { kind = 'unverified'; reason = 'Этаж на плане или фактический этаж не проверен; сравнение не выполнено.'; }
      if (id === 'inter-cadastral') reason = 'Помещения из ' + String(p.cadastral_count || 'нескольких') + ' кадастров объединены.';
      if (id === 'plan-mismatch' && p.plan_note) reason += ' Аудитор указал: ' + p.plan_note;
      if (id === 'alcohol-zone' && p.alcohol_within_licensed !== 'Нет') { kind = 'unverified'; reason = 'Размещение алкоголя в лицензированной зоне не подтверждено.'; }
      if (id.startsWith('tobacco-') && p[control.split('.')[1]] === 'Не проверено') {
        kind = 'unverified'; reason = ({ 'tobacco-display': 'Выкладка табака', 'tobacco-prices': 'Перечень продукции с ценами', 'tobacco-ads': 'Реклама табака' })[id] + ' не проверен' + (id === 'tobacco-prices' ? '.' : 'а.');
      }
    } else if (zone) {
      step = 0; control = 'zones.' + zone.id + (id.startsWith('zone-distance:') ? '.dist' : '.status');
      kind = id.startsWith('zone-distance:') || zone.status !== 'confirmed' ? 'unverified' : 'adverse';
      reason = (zone.name || 'Организация') + ': ' + (id.startsWith('zone-distance:') ? 'расстояние не проверено.' : ({ pending: 'требует уточнения.', disputed: 'спорное место.', confirmed: 'ограничение отмечено аудитором.' })[zone.status] || 'результат требует уточнения.');
      if (!id.startsWith('zone-distance:') && (zone.resolution || zone.note)) reason += ' ' + (zone.resolution || zone.note);
    } else if (entrance) {
      step = 0; control = 'entrances.' + entrance.id + '.access'; kind = 'unverified'; reason = (entrance.label || 'Вход') + ': ' + (entrance.access || 'осмотр не подтверждён') + '.';
    } else return null;
    var action = kind === 'missing_required' ? reason : kind === 'unverified' ? 'Проверьте указанные сведения либо сохраните их как непроверенные и выберите «Недостаточно данных».' : 'Если ответ верен, сохраните замечание и выберите «Нужны действия». Если ответ выбран ошибочно, исправьте его в указанном разделе.';
    if (id === 'rooms-incomplete') action = 'Проверьте ответ «Вся площадь по плану входит в объект». Если часть площади не входит, сохраните этот факт и выберите «Нужны действия». Убранная внутренняя перегородка описывается как изменение планировки.';
    return { id: id, label: task.label || reason, kind: kind, section: sections[step], step: step, control: control, reason: reason, action: action,
      suggested_conclusion: kind === 'missing_required' ? null : kind === 'unverified' ? 'insufficient' : 'actions', blocks_submission: kind === 'missing_required' };
  }
  return { describe: describe, isUnverifiedFloor: isUnverifiedFloor };
});
