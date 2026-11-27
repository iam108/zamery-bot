'use strict';

function client(caseId) {
  const status = document.getElementById('checklist-boot-status'), retry = document.getElementById('checklist-boot-retry');
  let busy = false, generation = 0;
  try { window.Telegram?.WebApp?.ready(); window.Telegram?.WebApp?.expand(); } catch (_) {}
  async function load() {
    if (busy) return;
    busy = true; const current = ++generation;
    retry.hidden = true; retry.disabled = true; status.textContent = 'Загружаю чек-лист…';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer, timedOut = false;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller?.abort(); reject(new Error('deadline')); }, 20000);
      });
      const request = fetch('/checklist/view?case_id=' + encodeURIComponent(caseId), {
        method: 'POST', cache: 'no-store', ...(controller ? { signal: controller.signal } : {})
      }).then(async response => ({ response, body: await response.text() }));
      const { response, body } = await Promise.race([request, deadline]);
      if (current !== generation || timedOut) return;
      const type = String(response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok || !type.includes('text/html') || response.headers.get('X-LRS-Checklist-View') !== '1') {
        let message = '';
        if (type.includes('application/json')) {
          try { const result = JSON.parse(body); if (typeof result.error === 'string') message = result.error.slice(0, 400); } catch (_) {}
        }
        throw new Error(message || (response.status === 401 ? 'Не удалось подтвердить вход. Откройте чек-лист свежей кнопкой бота.' :
          response.status === 403 ? 'Этот клиент недоступен вашему аккаунту.' : 'Не удалось загрузить чек-лист. Повторите загрузку.'));
      }
      // Only HTML explicitly identified by our authenticated route may replace
      // the loader. Hosting challenges and error pages must not execute here.
      document.open(); document.write(body); document.close();
    } catch (error) {
      if (current !== generation) return;
      status.textContent = timedOut ? 'Сервер долго не ответил. Повторите загрузку.' :
        error instanceof TypeError ? 'Нет связи с сервером. Повторите загрузку.' : error.message || 'Не удалось загрузить чек-лист.';
      retry.hidden = false;
    } finally {
      clearTimeout(timer);
      if (current === generation) { busy = false; retry.disabled = false; }
    }
  }
  retry.addEventListener('click', load);
  load();
}

function page(caseId) {
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Чек-лист клиента</title>' +
    '<script async src="https://telegram.org/js/telegram-web-app.js"></script><script>' + require('./auth').clientScript() + '</script>' +
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#223248;background:#e8eef6}main{width:min(100%,420px);text-align:center}h1{font-size:23px;line-height:1.25}p{color:#5b6b82;white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;min-height:48px;max-width:100%;padding:12px 20px;border:0;border-radius:14px;background:#2f6bff;color:white;font-weight:600;cursor:pointer}button:focus-visible{outline:3px solid #1753df;outline-offset:3px}[hidden]{display:none!important}@media(prefers-color-scheme:dark){body{background:#070b16;color:#eef2f8}p{color:#b5c2d5}}</style>' +
    '</head><body><main><h1>Чек-лист клиента</h1><p id="checklist-boot-status" role="status" aria-live="polite">Загружаю чек-лист…</p>' +
    '<button type="button" id="checklist-boot-retry" hidden>Повторить загрузку</button></main><script>(' + client.toString() + ')(' + (parseInt(caseId) || 0) + ');</script></body></html>';
}

module.exports = { page };
