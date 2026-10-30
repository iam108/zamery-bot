(function () {
  'use strict';
  var phone = window.AuditActions.normalizePhone(new URLSearchParams(location.hash.slice(1)).get('phone'));
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
})();
