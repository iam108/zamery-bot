(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuditActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function normalizePhone(value) {
    var raw = String(value || '').trim(), digits = raw.replace(/\D/g, '');
    if (!/^\+?[\d() .-]+$/.test(raw) || /\d{1,2}\.\d{1,2}\.\d{4}/.test(raw)) return '';
    if (digits.length === 10) return '+7' + digits;
    if (digits.length === 11 && /^[78]/.test(digits)) return '+7' + digits.slice(1);
    if (raw[0] === '+' && digits.length >= 8 && digits.length <= 15) return '+' + digits;
    return '';
  }
  function findPhone(value) {
    if (Array.isArray(value)) return value.map(findPhone).find(Boolean) || '';
    if (value && typeof value === 'object') return findPhone(value.phone || value.contact_phone || '') || findPhone(value.comment || '');
    var text = String(value || '');
    try { var parsed = JSON.parse(text); if (typeof parsed !== 'string') return findPhone(parsed); } catch (_) {}
    // A date next to a phone must neither become a phone nor consume its tail.
    text = text.replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, ' ');
    var pattern = /(?:^|[^\d+])((?:\+?7|8)?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2})(?!\d)/g;
    var match;
    while ((match = pattern.exec(text))) {
      var phone = normalizePhone(match[1]);
      if (phone) return phone;
    }
    return '';
  }
  function routeAddress(value) {
    var full = String(value || '').replace(/\s+/g, ' ').trim();
    // A floor/room describes the visit, not the point that Maps can geocode.
    // Keep building numbers, corpus, structures and literal street names.
    var at = full.search(/(?:,\s*|\s+)(?:(?:-?\d+\s*(?:-?й\s*)?)?(?:этаж|эт\.?)(?=\s|[.:№\d,]|$)|(?:комната|комн\.?|помещение|помещ\.?|пом\.?|офис|квартира|кв\.?)(?=\s|[.:№\d]|$))/i);
    var address = (at > 0 ? full.slice(0, at) : full).replace(/[\s,;]+$/, '');
    return address;
  }
  function routeUrl(address) {
    var destination = routeAddress(address);
    if (!destination) return '';
    return 'https://yandex.ru/maps/?mode=routes&rtext=~' + encodeURIComponent(destination) + '&rtt=auto';
  }
  function callUrl(origin, value) {
    var phone = normalizePhone(value);
    if (!phone) return '';
    var url;
    try { url = new URL('/audit-call.html', origin); } catch (_) { return ''; }
    if (!/^https?:$/.test(url.protocol)) return '';
    // The private number is kept out of HTTP requests and access logs.
    url.hash = 'phone=' + encodeURIComponent(phone);
    return url.href;
  }
  function openExternal(url, telegram, openWindow) {
    if (!/^https?:\/\//i.test(url || '')) return false;
    if (telegram && telegram.platform && telegram.platform !== 'unknown' && typeof telegram.openLink === 'function') {
      try { telegram.openLink(url, { try_instant_view: false }); return true; } catch (_) {}
    }
    try {
      var opened = openWindow(url, '_blank');
      if (opened) { opened.opener = null; return true; }
    } catch (_) {}
    return false;
  }
  return { normalizePhone: normalizePhone, findPhone: findPhone, routeAddress: routeAddress, routeUrl: routeUrl, callUrl: callUrl, openExternal: openExternal };
});
