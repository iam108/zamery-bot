'use strict';

module.exports = function caseReworkUI(caseId, actorId) {
  const panel = document.getElementById('rework-panel');
  const status = document.getElementById('rework-state');
  const content = document.getElementById('rework-content');
  const focused = new URLSearchParams(location.search).get('rework') === '1';
  const key = 'case-rework:' + actorId + ':' + caseId;
  let pending;
  let editing = false;
  let loading = false;
  let autoOpen = focused;
  try { pending = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) {}

  function node(tag, text, parent = content) {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    parent.appendChild(result);
    return result;
  }
  function action(label, run, parent = content) {
    const button = node('button', label, parent);
    button.type = 'button';
    button.className = 'pbtn';
    button.onclick = run;
    return button;
  }
  function documents(parent) {
    const link = node('a', 'Документы клиента', parent);
    link.href = '/handoff?case_id=' + caseId + '&view=documents&rework=1';
    link.className = 'pbtn';
    const credentials = new URLSearchParams(location.search);
    if (credentials.has('u') && credentials.has('k')) {
      link.href += '&u=' + encodeURIComponent(credentials.get('u')) + '&k=' + encodeURIComponent(credentials.get('k'));
    }
    link.href += location.hash;
  }
  function remember(value) {
    pending = value;
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch (_) {}
  }
  async function call(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/checklist/request', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({case_id:caseId,...body}), signal:controller.signal,
      });
      let data;
      try { data = await response.json(); } catch (_) { throw new Error('Связь с ботом прервалась. Повторите проверку.'); }
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || 'Не удалось подтвердить действие.');
      return data.rework;
    } finally { clearTimeout(timer); }
  }
  function form(view, item) {
    editing = true;
    const resolving = !!item;
    const section = node('div', '');
    const label = node('label', resolving ? 'Что уточнили или приложили' : 'Что нужно доработать', section);
    label.htmlFor = 'rework-message';
    const message = node('textarea', '', section);
    message.id = label.htmlFor;
    message.maxLength = 1500;
    message.required = true;
    if (pending && pending.action === (resolving ? 'resolve_rework' : 'return_for_rework')) {
      message.value = resolving ? pending.response : pending.reason;
    }
    const error = node('p', '', section);
    error.setAttribute('role', 'alert');
    message.setAttribute('aria-describedby', 'rework-form-error');
    error.id = 'rework-form-error';
    message.addEventListener('input', () => {
      error.textContent = '';
      message.removeAttribute('aria-invalid');
    });
    const buttons = node('div', '', section);
    buttons.className = 'rework-actions';
    const submit = action(resolving ? 'Вернуть юристу' : 'Отправить менеджеру', async () => {
      const value = message.value.trim();
      if (!value) { error.textContent = 'Заполните это поле.'; message.setAttribute('aria-invalid', 'true'); message.focus(); return; }
      const kind = resolving ? 'resolve_rework' : 'return_for_rework';
      const requestId = pending?.action === kind && (resolving ? pending.response === value && pending.rework_id === item.id : pending.reason === value)
        ? pending.request_id : uuid();
      const payload = resolving ? {action:kind,request_id:requestId,rework_id:item.id,response:value} : {action:kind,request_id:requestId,reason:value};
      remember(payload);
      submit.disabled = cancel.disabled = message.disabled = true;
      error.textContent = '';
      try { const next = await call(payload); remember(null); render(next); }
      catch (failure) { error.textContent = failure.name === 'AbortError' ? 'Сервер не ответил. Повторите отправку этого же текста.' : failure.message; }
      finally { submit.disabled = cancel.disabled = message.disabled = false; }
    }, buttons);
    submit.classList.add('rework-primary');
    const cancel = action('Отмена', () => { remember(null); render(view); }, buttons);
    message.focus();
  }
  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
    return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
  }
  function renderItem(view, item, parent) {
    const block = node('article', '', parent);
    block.className = 'rework-history';
    node('strong', item.status === 'open' ? 'На доработке у менеджера' : 'Доработка завершена', block);
    const requested = new Date(item.requested_at);
    if (item.requested_at && Number.isFinite(requested.getTime())) {
      node('p', [item.lawyer_name, requested.toLocaleString('ru-RU', {dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'})].filter(Boolean).join(' · '), block);
    }
    node('p', item.reason, block);
    if (item.response) {
      const resolved = new Date(item.resolved_at);
      const when = item.resolved_at && Number.isFinite(resolved.getTime()) ? resolved.toLocaleString('ru-RU', {dateStyle:'short',timeStyle:'short',timeZone:'Europe/Moscow'}) : '';
      node('p', [item.manager_name || 'Менеджер', when, item.response].filter(Boolean).join(' · '), block);
    }
    const kind = view.role === 'lawyer' && item.status === 'open' ? 'return_for_rework' :
      view.role === 'manager' && item.status === 'resolved' ? 'resolve_rework' : '';
    if (!kind) return;
    const delivery = kind === 'resolve_rework' ? item.resolution_delivery : item.return_delivery;
    if (delivery === 'confirmed') node('p', 'Уведомление доставлено в Telegram.', block);
    else if (['retryable','pending','blocked'].includes(delivery)) {
      node('p', 'Задача сохранена. Уведомление пока не доставлено.', block);
      if (!view.unavailable_reason) action('Повторить уведомление', async function () {
        const button = this;
        button.disabled = true;
        status.textContent = '';
        const payload = kind === 'resolve_rework' ? {action:kind,request_id:item.resolution_id,rework_id:item.id,response:item.response} : {action:kind,request_id:item.id,reason:item.reason};
        try { render(await call(payload)); } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      }, block);
    } else if (['unknown','sending'].includes(delivery)) {
      node('p', 'Задача сохранена. Доставка уведомления не подтверждена.', block);
    }
  }
  function render(view) {
    editing = false;
    content.replaceChildren();
    status.textContent = '';
    panel.hidden = !view && !focused;
    if (!view) { if (focused) status.textContent = 'Доработка доступна назначенному юристу и менеджеру клиента.'; return; }
    const requests = Array.isArray(view.requests) ? view.requests : [];
    if (pending && requests.some(item => pending.action === 'return_for_rework' && pending.request_id === item.id ||
        pending.action === 'resolve_rework' && pending.request_id === item.resolution_id)) remember(null);
    const active = requests.find(item => item.status === 'open');
    if (active) renderItem(view, active, content);
    const buttons = node('div', '');
    buttons.className = 'rework-actions';
    documents(buttons);
    if (view.can_return) action('Вернуть на доработку', () => { buttons.hidden = true; form(view); }, buttons);
    if (view.can_resolve && active) action('Сообщить о доработке', () => { buttons.hidden = true; form(view, active); }, buttons);
    if (view.unavailable_reason) node('p', view.unavailable_reason);
    const past = requests.filter(item => item !== active);
    if (past.length) {
      const history = node('details', '');
      node('summary', 'История доработок · ' + past.length, history);
      for (const item of past) renderItem(view, item, history);
    }
    if (view.can_return && (pending?.action === 'return_for_rework' || autoOpen && !requests.length)) {
      buttons.hidden = true;
      form(view);
    } else if (view.can_resolve && active && pending?.action === 'resolve_rework' && pending.rework_id === active.id) {
      buttons.hidden = true;
      form(view, active);
    }
    autoOpen = false;
    if (focused) panel.scrollIntoView({block:'start'});
  }
  async function load() {
    if (loading || editing) return;
    loading = true;
    if (focused) { panel.hidden = false; status.textContent = 'Загружаю задачу…'; }
    try { render(await call({action:'get_rework'})); }
    catch (error) {
      panel.hidden = false;
      status.textContent = error.message;
      content.replaceChildren();
      action('Повторить загрузку', load);
    } finally { loading = false; }
  }
  void load();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing) void load(); });
};
