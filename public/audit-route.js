(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuditRoute = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (environment) {
  'use strict';

  function locationPoint(value) {
    if (!value || typeof value.latitude !== 'number' || typeof value.longitude !== 'number' ||
        !Number.isFinite(value.latitude) || !Number.isFinite(value.longitude) ||
        Math.abs(value.latitude) > 90 || Math.abs(value.longitude) > 180) return null;
    return { latitude: value.latitude, longitude: value.longitude };
  }
  function locationError(code) {
    var messages = {
      denied: 'Доступ к местоположению не разрешён. Введите адрес отправления или выберите начало в Картах.',
      timeout: 'Местоположение не удалось получить вовремя. Введите адрес отправления или повторите попытку.',
      unavailable: 'Местоположение недоступно. Введите адрес отправления или выберите начало в Картах.',
      invalid: 'Устройство не передало корректное местоположение. Введите адрес отправления.'
    };
    var error = new Error(messages[code] || messages.unavailable); error.code = code; return error;
  }
  function requestLocation(options) {
    options = options || {};
    var telegram = options.telegram, navigator = options.navigator || environment.navigator;
    var timeout = options.locationTimeout || 10000;
    var schedule = options.setTimeout || environment.setTimeout, cancel = options.clearTimeout || environment.clearTimeout;
    return new Promise(function (resolve, reject) {
      var finished = false, timer = schedule(function () { complete(null, 'timeout'); }, timeout);
      function complete(value, errorCode) {
        if (finished) return;
        finished = true; cancel(timer);
        var point = locationPoint(value);
        if (point) resolve(point); else reject(locationError(errorCode || 'invalid'));
      }
      function browserLocation() {
        if (finished) return;
        if (!navigator || !navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') { complete(null, 'unavailable'); return; }
        try {
          navigator.geolocation.getCurrentPosition(function (position) { complete(position && position.coords); }, function (error) {
            complete(null, error && error.code === 1 ? 'denied' : error && error.code === 3 ? 'timeout' : 'unavailable');
          }, { enableHighAccuracy: false, maximumAge: 0, timeout: timeout });
        } catch (_) { complete(null, 'unavailable'); }
      }
      var manager = telegram && telegram.LocationManager, supported = false;
      try { supported = !!(manager && typeof manager.init === 'function' && typeof manager.getLocation === 'function' &&
        (typeof telegram.isVersionAtLeast === 'function' ? telegram.isVersionAtLeast('8.0') : parseFloat(telegram.version || '0') >= 8)); } catch (_) {}
      if (!supported) { browserLocation(); return; }
      try {
        manager.init(function () {
          if (finished) return;
          if (!manager.isLocationAvailable) { browserLocation(); return; }
          try { manager.getLocation(function (value) { complete(value, value ? 'invalid' : 'denied'); }); }
          catch (_) { complete(null, 'unavailable'); }
        });
      } catch (_) { browserLocation(); }
    });
  }

  function open(options) {
    options = options || {};
    var document = options.document || environment.document, actions = options.actions || environment.AuditActions;
    if (!document || !actions || typeof actions.routeUrl !== 'function') throw new Error('Не удалось открыть маршрут.');
    var existing = document.getElementById('route-dialog');
    if (existing && existing._auditRouteController) return existing._auditRouteController;
    var previous = document.activeElement, destination = actions.routeAddress ? actions.routeAddress(options.address) : String(options.address || '').trim();
    var closed = false, point = null, generation = 0, pending = null;
    function node(tag, text, attributes) {
      var element = document.createElement(tag);
      if (text != null) element.textContent = text;
      Object.keys(attributes || {}).forEach(function (name) { element.setAttribute(name, attributes[name]); });
      return element;
    }
    var dialog = node('dialog', null, { id: 'route-dialog', 'class': 'contact-dialog route-dialog', 'aria-labelledby': 'route-title' });
    var heading = node('div', null, { 'class': 'contact-heading' });
    var title = node('h2', 'Маршрут до объекта', { id: 'route-title' });
    var closeButton = node('button', 'Закрыть', { type: 'button', 'class': 'button secondary', 'aria-label': 'Закрыть маршрут' });
    heading.appendChild(title); heading.appendChild(closeButton); dialog.appendChild(heading);
    dialog.appendChild(node('p', destination || 'Адрес объекта не указан.', { 'class': 'route-destination' }));
    var label = node('label', 'Откуда', { 'for': 'route-origin', 'class': 'field-label' });
    var origin = node('input', null, { id: 'route-origin', type: 'text', 'aria-label': 'Откуда начать маршрут', placeholder: 'Адрес отправления', autocomplete: 'street-address' });
    var location = node('button', 'Моё местоположение', { type: 'button', 'class': 'button secondary', 'data-route-location': '' });
    var status = node('p', 'Укажите адрес отправления или выберите своё местоположение.', { 'class': 'field-note', role: 'status', 'aria-live': 'polite' });
    var primary = node('button', 'Построить маршрут ↗', { type: 'button', 'class': 'button primary', 'data-build-route': '' });
    var fallback = node('a', 'Выбрать начало в Картах', { 'class': 'button secondary', target: '_blank', rel: 'noopener', href: actions.routeUrl(destination) });
    var controls = node('div', null, { 'class': 'contact-actions route-actions' });
    primary.disabled = true;
    if (!destination) { origin.disabled = true; location.disabled = true; fallback.removeAttribute('href'); fallback.setAttribute('aria-disabled', 'true'); status.textContent = 'В заявке нет адреса объекта. Вернитесь к данным заявки.'; }
    dialog.appendChild(label); dialog.appendChild(origin); dialog.appendChild(location); dialog.appendChild(status);
    controls.appendChild(primary); controls.appendChild(fallback); dialog.appendChild(controls);

    function updatePrimary() { primary.disabled = !destination || !(point || origin.value.trim()); }
    function cleanup() {
      if (closed) return;
      closed = true; generation++; dialog.remove();
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    }
    function close() {
      if (closed) return;
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      cleanup();
    }
    function beforeLeave() {
      if (typeof options.onBeforeLeave !== 'function') return;
      try { var saved = options.onBeforeLeave(); if (saved && typeof saved.catch === 'function') saved.catch(function () {}); } catch (_) {}
    }
    function dispatch(url) {
      if (!url || typeof options.openExternal !== 'function') { status.textContent = 'Не удалось открыть Карты. Используйте ссылку ниже.'; return false; }
      beforeLeave();
      try {
        if (options.openExternal(url) === false) { status.textContent = 'Карты не открылись. Повторите попытку или используйте ссылку ниже.'; return false; }
      } catch (_) { status.textContent = 'Карты не открылись. Повторите попытку или используйте ссылку ниже.'; return false; }
      status.textContent = 'Запрос на открытие отправлен. Для продолжения отчёта вернитесь в Telegram.'; return true;
    }
    origin.oninput = function () {
      generation++; point = null; updatePrimary();
      status.textContent = primary.disabled ? 'Укажите адрес отправления или выберите своё местоположение.' : 'Начало маршрута указано. Нажмите «Построить маршрут».';
    };
    location.onclick = async function () {
      if (closed || pending || !destination) return;
      var token = ++generation, operation = {}; pending = operation; point = null; origin.value = ''; primary.disabled = true;
      location.disabled = true; location.textContent = 'Определяю местоположение…'; status.textContent = 'Разрешите доступ к местоположению в окне устройства.';
      try {
        var result = await requestLocation(options);
        if (!closed && token === generation) { point = result; origin.value = 'Моё местоположение'; updatePrimary(); status.textContent = 'Местоположение получено. Нажмите «Построить маршрут».'; }
      } catch (error) { if (!closed && token === generation) { status.textContent = error.message; updatePrimary(); } }
      finally { if (!closed && pending === operation) { pending = null; location.disabled = false; location.textContent = 'Моё местоположение'; } }
    };
    primary.onclick = function () {
      if (closed) return;
      updatePrimary(); if (primary.disabled) return;
      dispatch(actions.routeUrl(destination, point || origin.value.trim()));
    };
    origin.onkeydown = function (event) {
      if (event.key === 'Enter' && !event.isComposing && !primary.disabled) { event.preventDefault(); primary.onclick(); }
    };
    fallback.onclick = function (event) {
      if (!destination) { event.preventDefault(); return; }
      if (typeof options.openExternal === 'function') { event.preventDefault(); dispatch(actions.routeUrl(destination)); }
      else beforeLeave();
    };
    closeButton.onclick = close;
    dialog.addEventListener('cancel', function (event) { event.preventDefault(); close(); });
    dialog.addEventListener('close', cleanup);
    dialog.addEventListener('click', function (event) { if (event.target === dialog) close(); });
    var controller = { dialog: dialog, close: close }; dialog._auditRouteController = controller;
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch (_) { dialog.setAttribute('open', ''); dialog.className += ' route-dialog-fallback'; }
    } else { dialog.setAttribute('open', ''); dialog.className += ' route-dialog-fallback'; }
    if (dialog.className.indexOf('route-dialog-fallback') >= 0) { dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
    return controller;
  }
  return { open: open, requestLocation: requestLocation, locationPoint: locationPoint };
});
