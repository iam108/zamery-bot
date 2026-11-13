'use strict';

const { isGenericAudit } = require('../bot/audit-generic');

function handoffReadiness(data, { videoUrl, videoRequired } = {}) {
  const workflow = data.workflow || {};
  const zones = Array.isArray(data.zones) ? data.zones.filter(Boolean) : [];
  const issues = [];
  let territory = '';

  if (workflow.conclusion_status === 'insufficient') {
    issues.push('Аудитор отметил, что данных для вывода недостаточно.');
  }
  if (!isGenericAudit(data)) {
    const result = workflow.territory_result;
    const measurements = Array.isArray(data.map?.annotations) ? data.map.annotations : [];
    const measured = zone => measurements.some(mark => mark?.toObjectId === zone.id &&
      ['route', 'straight'].includes(mark.tool) && Number(String(mark.distance).replace(',', '.')) > 0);
    const unclear = zones.filter(zone => ['pending', 'disputed'].includes(zone.status) ||
      zone.dist === 'Не проверено' && !measured(zone));
    if (unclear.length) {
      territory = 'Нужно уточнить ограничения или расстояния';
      for (const zone of unclear) {
        const name = typeof zone.name === 'string' && zone.name.trim() ? zone.name.trim().slice(0, 180) : 'Объект поблизости';
        issues.push(name + (['pending', 'disputed'].includes(zone.status)
          ? ' — уточните, действует ли ограничение.' : ' — проверьте расстояние.'));
      }
    } else if (result === 'clear' && (zones.length || data.map?.evidence_id || measurements.length) ||
        result === 'findings' && !zones.length || !result && data.schema_version === 3 && ['Нет', 'Не проверено'].includes(data.inspection?.zones_checked)) {
      territory = 'Проверка территории требует уточнения';
      issues.push('Уточните итог проверки территории у аудитора.');
    } else if (result === 'clear') {
      territory = 'Зоны запрета и спорные объекты не выявлены';
    } else if (zones.some(zone => zone.status === 'confirmed')) {
      territory = 'В отчёте отмечено ограничение';
    } else if (result === 'findings') {
      territory = 'Организации и наблюдения указаны в отчёте';
    }
  }
  if (videoRequired || data.request_packet?.video_required === true) {
    if (!videoUrl) issues.push('Приложите ссылку на видео, указанное в задании.');
    else if (!isGenericAudit(data) && ['Снято — загрузить позже','Не сделано','Не проверено'].includes(data.inspection?.video_status)) {
      issues.push('Подтвердите, что видео из задания загружено.');
    }
  }
  return { blocking: issues.length > 0, issues, territory };
}

module.exports = { handoffReadiness };
