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
  function routeOrigin(value) {
    if (value && typeof value === 'object') {
      var lat = value.latitude, lon = value.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return '';
      return Number(lat.toFixed(6)) + ',' + Number(lon.toFixed(6));
    }
    var text = String(value || '').trim().replace(/\s+/g, ' ');
    return text.length <= 250 ? text : '';
  }
  function routeUrl(address, origin) {
    var numeric = address && typeof address === 'object';
    var destination = numeric ? routeOrigin(address) : routeAddress(address);
    if (!destination) return '';
    // Native iOS Maps accepts coordinate pairs, not address strings. Never
    // mix a prepared destination with a textual starting point.
    if (numeric && origin != null && (typeof origin !== 'object' || !origin)) return '';
    var start = routeOrigin(origin);
    if (origin != null && !start) return '';
    return 'https://yandex.ru/maps/?mode=routes&rtext=' + encodeURIComponent(start) + '~' + encodeURIComponent(destination) + '&rtt=auto';
  }
  function searchUrl(address) {
    var text = routeAddress(address);
    return text ? 'https://yandex.ru/maps/?text=' + encodeURIComponent(text) : '';
  }
  function callUrl(origin, value, autoDial) {
    var phone = normalizePhone(value);
    if (!phone) return '';
    var base, url;
    try {
      base = new URL(origin);
      if (!/^https?:$/.test(base.protocol) || base.username || base.password) return '';
      base.search = ''; base.hash = '';
      // Accept both an origin and a static project directory, including a
      // directory without its trailing slash. Preserve the existing /audit
      // page input as a page, rather than treating it as a new directory.
      if (base.pathname === '/audit' || base.pathname === '/audit/legacy') base.pathname = '/';
      else if (/\/[^/]+\.[^/]+$/.test(base.pathname)) base = new URL('./', base);
      else if (!base.pathname.endsWith('/')) base.pathname += '/';
      url = new URL('audit-call.html', base);
    } catch (_) { return ''; }
    // The private number is kept out of HTTP requests and access logs.
    url.hash = 'phone=' + encodeURIComponent(phone) + (autoDial ? '&dial=1' : '');
    return url.href;
  }
  function hasTelegramBridge(environment) {
    if (!environment) return false;
    try {
      return !!(environment.TelegramWebviewProxy && typeof environment.TelegramWebviewProxy.postEvent === 'function' || environment.external && typeof environment.external.notify === 'function' || environment.parent && environment.parent !== environment && typeof environment.parent.postMessage === 'function');
    } catch (_) { return false; }
  }
  function openExternal(url, telegram, openWindow, environment) {
    if (!/^https?:\/\//i.test(url || '')) return false;
    if (hasTelegramBridge(environment) && telegram && typeof telegram.openLink === 'function') {
      // The SDK acknowledges dispatch only; it cannot confirm the external app opened.
      try { telegram.openLink(url, { try_instant_view: false }); return true; } catch (_) {}
    }
    try {
      var opened = openWindow(url, '_blank');
      if (opened) { opened.opener = null; return true; }
    } catch (_) {}
    return false;
  }
  return { normalizePhone: normalizePhone, findPhone: findPhone, routeAddress: routeAddress, routeOrigin: routeOrigin, routeUrl: routeUrl, searchUrl: searchUrl, callUrl: callUrl, hasTelegramBridge: hasTelegramBridge, openExternal: openExternal };
});
