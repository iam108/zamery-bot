(function () {
  'use strict';
  var parameters = new URLSearchParams(location.hash.slice(1));
  var phone = window.AuditActions.normalizePhone(parameters.get('phone'));
  var autoDial = parameters.get('dial') === '1';
  var field = document.getElementById('phone'), dial = document.getElementById('dial'), copy = document.getElementById('copy'), status = document.getElementById('status');
  if (!phone) { status.textContent = 'Номер не передан. Откройте контакт из заявки в боте.'; return; }
  field.value = phone; field.hidden = dial.hidden = copy.hidden = false; dial.href = 'tel:' + phone;
  copy.onclick = async function () {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(phone);
      else { field.select(); if (!document.execCommand('copy')) throw new Error('copy'); }
      status.textContent = 'Номер скопирован.';
    } catch (_) { field.focus(); field.select(); status.textContent = 'Номер выделен. Выберите «Копировать».'; }
  };
  if (autoDial) {
    // Consume the explicit call action before asking the OS to open Phone.
    // Refresh/back must never start another attempt.
    parameters.delete('dial');
    try { history.replaceState(null, '', location.pathname + location.search + '#' + parameters.toString()); }
    catch (_) { status.textContent = 'Нажмите «Набрать номер», чтобы открыть приложение «Телефон».'; return; }
    status.textContent = 'Подтвердите открытие приложения «Телефон». Если запрос не появился, нажмите «Набрать номер».';
    dial.click();
  }
})();
