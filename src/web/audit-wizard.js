const fs = require('fs');
const path = require('path');

function auditWizard() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <title>Выезд аудитора</title>
  <script src="https://telegram.org/js/telegram-web-app.js"><\/script>
  <script src="/auth.js"><\/script>
  <link rel="stylesheet" href="/audit-wizard.css?v=20261030-actions3">
  <link rel="stylesheet" href="/audit-plan-editor.css?v=20261030-actions3">
</head>
<body>
  <div class="ambient-layer" aria-hidden="true">
    <div class="ambient ambient-one"></div>
    <div class="ambient ambient-two"></div>
    <div class="ambient ambient-three"></div>
  </div>
  <div class="audit-app" id="audit-app">
    <header class="app-header glass">
      <div class="header-top"><a class="back-link" href="/requests">← Заявки</a><span class="draft-pill" id="draft-id">Проверка</span></div>
      <div class="title-row"><div><h1>Проверка объекта</h1><p id="object-title">Загружаю заявку менеджера…</p></div></div>
      <div class="save-row"><span id="save-state" role="status" aria-live="polite">Открываю черновик…</span><button type="button" class="text-button" id="save-now">Сохранить</button></div>
    </header>
    <section class="conflict-panel glass" id="conflict-panel" hidden role="alert"><h2>На сервере появилась другая версия</h2><p>Ваши изменения остались на этом устройстве. Сначала сохраните свою копию, затем загрузите серверную версию и перенесите нужные правки.</p><div class="action-row"><button type="button" class="button secondary" id="download-copy">Скачать мою копию</button><button type="button" class="button secondary" id="reload-server">Загрузить серверную</button></div></section>
    <section class="notice glass" id="app-notice" hidden role="status"></section>
    <nav class="steps" id="steps" aria-label="Этапы проверки"></nav>
    <main class="step-content glass" id="step-content" aria-busy="true"><div class="loading"><span class="loading-dot"></span><h2>Загружаю заявку</h2><p>Адрес, задача и документы придут от менеджера.</p></div></main>
    <div class="app-footnote">Черновик сохраняется. Можно продолжить после выезда.</div>
  </div>
  <footer class="bottom-bar glass"><div class="bottom-inner"><button type="button" class="button secondary" id="previous-step">← Назад</button><span id="step-counter">1 из 3</span><button type="button" class="button primary" id="next-step">Далее →</button></div></footer>
  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <script src="/audit-editor-geometry.js"><\/script>
  <script src="/audit-plan-editor.js?v=20261030-actions3"><\/script>
  <script src="/audit-actions.js?v=20261030-actions3"><\/script>
  <script src="/audit-wizard-client.js?v=20261030-actions3"><\/script>
</body>
</html>`;
}

// Separate source files keep the page readable and allow ordinary static routes.
auditWizard.client = () => fs.readFileSync(path.join(__dirname, 'audit-wizard-client.js'), 'utf8');
auditWizard.css = () => fs.readFileSync(path.join(__dirname, 'audit-wizard.css'), 'utf8');
module.exports = auditWizard;
