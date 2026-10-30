(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('../../public/audit-editor-geometry') : root.AuditEditorGeometry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuditPlanEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G) {
  'use strict';
  const TOOLS = {
    boundary: { label: 'Помещение', color: '#7550b8', polygon: true, prefix: 'Г' },
    licensed: { label: 'Лицензируемая зона', color: '#128675', polygon: true, prefix: 'Л' },
    cadastral: { label: 'Кадастр', color: '#365bce', polygon: true, prefix: 'К' },
    partition: { label: 'Перегородка', color: '#327b96', prefix: 'П' },
    removed: { label: 'Убрана перегородка', color: '#ca5a50', prefix: 'П', dashed: true },
    bar: { label: 'Барная стойка', color: '#a87927', polygon: true, prefix: 'Б' },
    opening: { label: 'Проём', color: '#16816c', prefix: 'П', point: true },
    text: { label: 'Подпись', color: '#496b89', prefix: 'Т', point: true },
    entrance: { label: 'Вход', color: '#d64750', prefix: 'В', point: true },
    hazard: { label: 'Организация', color: '#286b9b', prefix: 'О', point: true },
    route: { label: 'Путь замера', color: '#7550b8', prefix: 'М', freehand: true },
    straight: { label: 'Прямой замер', color: '#327b96', prefix: 'М' },
    lease: { label: 'Границы аренды', color: '#ba9300', polygon: true, prefix: 'А' },
    hall: { label: 'Зал обслуживания', color: '#d84053', polygon: true, prefix: 'З' },
    structural: { label: 'Стена: назначение уточнить', color: '#d17317', prefix: 'П' },
  };
  const copy = value => JSON.parse(JSON.stringify(value));
  const uid = () => globalThis.crypto?.randomUUID?.() || 'mark-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const point = p => ({ x: Math.max(0, Math.min(1, Number(p?.x) || 0)), y: Math.max(0, Math.min(1, Number(p?.y) || 0)) });
  function normalise(value) {
    const state = copy(value || {}); state.annotations = Array.isArray(state.annotations) ? state.annotations : [];
    state.page = Math.max(1, Math.floor(Number(state.page) || 1)); state.sequence = state.sequence || {};
    const codes = new Set();
    // Reserve every existing code before filling legacy gaps; a real code never
    // changes merely because an older unnumbered mark appears before it.
    for (const [key, value] of Object.entries(state.sequence)) state.sequence[key] = Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
    state.annotations.forEach(m => { const match = /^([^0-9]+)([0-9]+)$/.exec(m.code || ''); if (match) state.sequence[match[1]] = Math.max(state.sequence[match[1]] || 0, Number(match[2])); });
    state.annotations.forEach((m, i) => {
      m.id ||= 'legacy-' + (state.evidence_id || 'source') + '-' + state.page + '-' + i;
      m.tool ||= 'text'; m.points = (Array.isArray(m.points) ? m.points : Number.isFinite(m.x) ? [m] : []).map(point);
      const prefix = (TOOLS[m.tool] || TOOLS.text).prefix;
      if (m.code) { const match = /^([^0-9]+)([0-9]+)$/.exec(m.code); if (match) state.sequence[match[1]] = Math.max(state.sequence[match[1]] || 0, Number(match[2])); }
      if (!m.code || codes.has(m.code)) { state.sequence[prefix] = (state.sequence[prefix] || 0) + 1; m.code = prefix + state.sequence[prefix]; }
      codes.add(m.code);
    });
    if (state.pending?.points?.length) state.pending = { ...state.pending, points: state.pending.points.map(point) };
    else state.pending = null;
    return state;
  }
  function addMark(value, tool, points, fields) {
    const state = normalise(value), config = TOOLS[tool];
    if (!config) throw new Error('Выберите инструмент.');
    const ps = points.map(point);
    if (config.polygon && !G.closedContour(ps)) throw new Error('Для контура нужны хотя бы три разных угла без пересечения линий.');
    if (!config.polygon && ps.length < (config.point ? 1 : 2)) throw new Error('Добавьте ещё одну точку.');
    const n = (state.sequence[config.prefix] || 0) + 1; state.sequence[config.prefix] = n;
    const mark = { ...fields, id: fields?.id || uid(), tool, code: config.prefix + n, points: ps };
    if (tool === 'entrance' && !mark.label) mark.label = 'Вход ' + n;
    if (tool === 'hazard' && !mark.status) mark.status = 'pending';
    if (['route', 'straight'].includes(tool)) {
      const entrances = state.annotations.filter(m => m.tool === 'entrance'), objects = state.annotations.filter(m => m.tool === 'hazard');
      if (entrances.length === 1 && objects.length === 1) { mark.fromEntranceId = entrances[0].id; mark.toObjectId = objects[0].id; }
    }
    state.annotations.push(mark); state.pending = null; return state;
  }
  function selectSource(value, evidenceId, page) {
    const state = normalise(value), nextPage = Math.max(1, Number(page) || 1);
    if (state.pending) throw new Error('Сначала замкните контур или отмените его точки.');
    if (String(state.evidence_id || '') === String(evidenceId) && state.page === nextPage) return state;
    if (state.evidence_id) {
      state.versions ||= [];
      state.versions.push({ evidence_id: state.evidence_id, page: state.page, annotations: copy(state.annotations), sequence: copy(state.sequence), at: new Date().toISOString() });
    }
    state.evidence_id = evidenceId; state.page = nextPage; state.annotations = []; state.pending = null;
    return state;
  }
  function restoreSource(value) {
    const state = normalise(value);
    if (state.pending) throw new Error('Сначала замкните контур или отмените его точки.');
    if (!state.versions?.length) return state;
    const previous = state.versions.pop();
    state.versions.push({ evidence_id: state.evidence_id, page: state.page, annotations: copy(state.annotations), sequence: copy(state.sequence), at: new Date().toISOString() });
    const sequence = { ...state.sequence }; for (const [key, value] of Object.entries(previous.sequence || {})) sequence[key] = Math.max(sequence[key] || 0, value);
    return { ...state, ...previous, versions: state.versions, pending: null, sequence };
  }
  function assertExportable(state) { if (state.pending?.points?.length) throw new Error('Замкните контур или отмените его точки перед экспортом.'); }
  function isPDF(evidence, data) {
    return /pdf/i.test(evidence?.mime || '') || /\.pdf$/i.test(evidence?.name || '') || (data && String.fromCharCode(...new Uint8Array(data).slice(0, 5)) === '%PDF-');
  }
  function eligible(evidence, kind) {
    if (!evidence?.id || evidence.subject_id === 'annotation' || ['plan', 'map'].includes(evidence.role) && evidence.subject_id || evidence.role === 'video') return false;
    if (kind === 'map') return /^image\//.test(evidence.mime || '') && ['map-source', 'map'].includes(evidence.role);
    return isPDF(evidence) || /^image\//.test(evidence.mime || '') && ['plan-source', 'plan', 'egrn', 'bti', 'lease', 'document'].includes(evidence.role);
  }
  function toolNames(kind, service) {
    const keys = kind === 'map' ? ['entrance', 'hazard', 'route', 'straight', 'text'] : ['boundary', ...(service === 'tobacco' ? [] : ['licensed']), 'cadastral', 'partition', 'removed', 'bar', 'opening', 'text'];
    return keys.map(key => [key, key === 'bar' && service === 'tobacco' ? 'Прилавок' : TOOLS[key].label]).concat([['edit', 'Изменить'], ['pan', 'Переместить']]);
  }
  function markColor(mark) { return mark.tool === 'hazard' ? (['disputed', 'confirmed'].includes(mark.status) ? '#b87819' : ['clear', 'checked'].includes(mark.status) ? '#16816c' : '#286b9b') : (TOOLS[mark.tool] || TOOLS.text).color; }
  function legendEntries(state, kind) {
    return state.annotations.map(m => {
      let text = m.label || (TOOLS[m.tool] || TOOLS.text).label;
      if (m.distance) text += ' · ' + m.distance + ' м';
      if (kind === 'map' && m.tool === 'hazard') text += ' · ' + ({ clear: 'без замечаний', checked: 'без замечаний', licensed: 'сведения о лицензии', disputed: 'спорный результат', confirmed: 'подтверждённый риск', other: 'наблюдение' }[m.status] || 'результат не указан');
      if (m.source || m.sourceUrl) text += ' · ' + (m.source || m.sourceUrl);
      if (m.note) text += ' · ' + m.note;
      return { code: m.code, text, color: markColor(m) };
    });
  }
  function wrapText(ctx, text, width) {
    const rows = []; let row = '';
    for (const word of String(text).split(/\s+/)) {
      if (row && ctx.measureText(row + ' ' + word).width > width) { rows.push(row); row = ''; }
      if (ctx.measureText(word).width > width) {
        for (const letter of word) { if (row && ctx.measureText(row + letter).width > width) { rows.push(row); row = ''; } row += letter; }
      } else row += (row ? ' ' : '') + word;
    }
    if (row) rows.push(row); return rows;
  }
  function renderScene(canvas, source, state, opts) {
    const settings = { kind: 'plan', scale: 1, artifact: false, selection: null, vertex: -1, ...opts };
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    const unit = 1 / Math.max(.01, settings.scale), ctx = canvas.getContext('2d'), entries = legendEntries(state, settings.kind), font = 13 * unit, rowHeight = 19 * unit, pad = 16 * unit;
    ctx.font = font + 'px sans-serif';
    const rows = settings.artifact ? entries.flatMap(e => wrapText(ctx, e.code + ' — ' + e.text, Math.max(40, w - pad * 2)).map(text => ({ text, color: e.color }))) : [];
    const footer = settings.artifact ? pad * 2 + rowHeight * (rows.length + 1) : 0;
    canvas.width = w; canvas.height = Math.ceil(h + footer);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    for (const mark of state.annotations) {
      if (!mark.points?.length) continue;
      const config = TOOLS[mark.tool] || TOOLS.text, color = markColor(mark), anchor = mark.points[0];
      ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2 * unit; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (config.dashed) ctx.setLineDash([7 * unit, 5 * unit]);
      ctx.beginPath(); mark.points.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h));
      if (config.polygon && mark.points.length >= 3) { ctx.closePath(); ctx.save(); ctx.globalAlpha = .06; ctx.fill(); ctx.restore(); }
      ctx.stroke(); ctx.setLineDash([]);
      if (config.point || mark.points.length === 1) {
        const x = anchor.x * w, y = anchor.y * h;
        if (mark.tool === 'opening') ctx.strokeRect(x - 5 * unit, y - 3 * unit, 10 * unit, 6 * unit);
        else { ctx.beginPath(); ctx.arc(x, y, 4 * unit, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.font = '600 ' + 11 * unit + 'px sans-serif';
      const bw = ctx.measureText(mark.code).width + 8 * unit, bh = 17 * unit;
      const badge = G.badgeBounds({ x: anchor.x * w + 7 * unit, y: anchor.y * h - 20 * unit }, { width: bw, height: bh }, { width: w, height: h }, 2 * unit);
      ctx.fillStyle = 'rgba(255,255,255,.94)'; ctx.fillRect(badge.x, badge.y, badge.width, badge.height);
      ctx.fillStyle = color; ctx.fillText(mark.code, badge.x + 4 * unit, badge.y + 12 * unit);
      if (!settings.artifact && mark.id === settings.selection) mark.points.forEach((p, i) => {
        ctx.beginPath(); ctx.arc(p.x * w, p.y * h, (i === settings.vertex ? 5 : 3.5) * unit, 0, Math.PI * 2); ctx.fillStyle = i === settings.vertex ? color : '#fff'; ctx.fill(); ctx.stroke();
      });
      ctx.restore();
    }
    if (!settings.artifact && state.pending?.points?.length) {
      const config = TOOLS[state.pending.tool] || TOOLS.boundary; ctx.strokeStyle = config.color; ctx.fillStyle = config.color; ctx.lineWidth = 2 * unit; ctx.setLineDash([6 * unit, 4 * unit]); ctx.beginPath();
      state.pending.points.forEach((p, i) => i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)); ctx.stroke(); ctx.setLineDash([]);
      state.pending.points.forEach(p => { ctx.beginPath(); ctx.arc(p.x * w, p.y * h, 3 * unit, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.restore();
    if (settings.artifact) { ctx.font = font + 'px sans-serif'; ctx.fillStyle = '#3a536d'; ctx.fillText('Легенда ' + (settings.kind === 'map' ? 'схемы' : 'плана'), pad, h + pad + font); rows.forEach((r, i) => { ctx.fillStyle = r.color; ctx.fillText(r.text, pad, h + pad + font + (i + 1) * rowHeight); }); }
    return { width: canvas.width, height: canvas.height, drawingHeight: h };
  }
  function hitTest(state, p, width, height, tolerance) {
    const px = p.x * width, py = p.y * height;
    for (let i = state.annotations.length - 1; i >= 0; i--) {
      const m = state.annotations[i];
      for (let j = 0; j < m.points.length; j++) if (Math.hypot(m.points[j].x * width - px, m.points[j].y * height - py) <= tolerance) return { id: m.id, vertex: j };
      if (TOOLS[m.tool]?.polygon && G.pointInPolygon(p, m.points)) return { id: m.id, vertex: -1 };
      for (let j = 1; j < m.points.length; j++) {
        const a = m.points[j - 1], b = m.points[j], dx = (b.x - a.x) * width, dy = (b.y - a.y) * height;
        const t = Math.max(0, Math.min(1, ((px - a.x * width) * dx + (py - a.y * height) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(px - a.x * width - t * dx, py - a.y * height - t * dy) <= tolerance) return { id: m.id, vertex: -1 };
      }
    }
    return null;
  }
  // A slow network must not turn a typed organization name into dozens of
  // queued PUTs. Each acknowledged write is followed by the newest snapshot.
  function createSaveQueue(write) {
    let pending = null, running = null, lastError = null;
    function enqueue(value) {
      pending = value;
      if (!running) {
        lastError = null;
        running = (async () => {
          await Promise.resolve();
          while (pending) {
            const next = pending; pending = null;
            try { await write(next); lastError = null; }
            catch (error) { lastError = error; if (!pending) throw error; }
          }
        })().finally(() => { running = null; });
        running.catch(() => {});
      }
      return running;
    }
    return { enqueue, flush: () => running || (lastError ? Promise.reject(lastError) : Promise.resolve()) };
  }
  let pdfModule;
  async function pdfJS() {
    if (!pdfModule) pdfModule = import('/vendor/pdfjs/pdf.mjs').then(lib => { lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'; return lib; }).catch(e => { pdfModule = null; throw e; });
    return pdfModule;
  }
  function mount(container, options) {
    if (!G) throw new Error('Не загружен модуль геометрии редактора.');
    const kind = options.kind === 'map' ? 'map' : 'plan', service = options.service || 'alcohol';
    const controller = new AbortController(), signal = controller.signal;
    let state = normalise(options.getState?.()), image = null, alive = true, loadToken = 0, sourceLoading = false;
    let activeTool = kind === 'map' ? 'entrance' : 'boundary', selected = null, selectedVertex = -1, zoom = 1, fitScale = 1;
    let past = [], future = [], saveTail = Promise.resolve(), saveError = null, revision = 0, pointer = null;
    let chooserToken = 0, candidate = null, renderTask = null;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text; if (cls) n.className = cls; return n; };
    const on = (node, event, fn) => node.addEventListener(event, fn, { signal });
    const button = (text, cls, fn) => { const b = el('button', text, 'ape-button ' + (cls || '')); b.type = 'button'; if (fn) on(b, 'click', fn); return b; };
    const panel = el('section', null, 'ape-editor'); panel.dataset.kind = kind;
    const top = el('div', null, 'ape-top'), sourceLabel = el('span', '', 'ape-source');
    const chooseSource = button(kind === 'map' ? 'Выбрать скриншот' : 'Выбрать лист PDF / изображение', 'ape-secondary', () => openChooser());
    top.append(sourceLabel, chooseSource);
    const toolbar = el('div', null, 'ape-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Инструменты разметки');
    const toolSelect = el('select'); toolSelect.setAttribute('aria-label', 'Инструмент разметки'); toolNames(kind, service).forEach(([value, text]) => { const o = el('option', text); o.value = value; toolSelect.append(o); });
    const pan = button('Переместить', '', () => setTool('pan'));
    const minus = button('−', '', () => setZoom(zoom / 1.25)), plus = button('+', '', () => setZoom(zoom * 1.25)), fit = button('Вписать', '', () => fitImage());
    minus.setAttribute('aria-label', 'Уменьшить масштаб'); plus.setAttribute('aria-label', 'Увеличить масштаб');
    const zoomText = el('span', '100%', 'ape-zoom-value'), zoomGroup = el('div', null, 'ape-zoom'); zoomGroup.append(minus, zoomText, plus, fit); toolbar.append(toolSelect, pan, zoomGroup);
    const guidance = el('div', null, 'ape-guidance'), message = el('span', '', 'ape-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    const undo = button('↶', '', () => undoChange()), redo = button('↷', '', () => redoChange()); undo.setAttribute('aria-label', 'Отменить действие'); redo.setAttribute('aria-label', 'Вернуть действие');
    guidance.append(message, undo, redo);
    const actionSlot = el('div', null, 'ape-actions'), actionText = el('span');
    const removePoint = button('Отменить точку', '', () => { if (!state.pending) return; mutate(next => { next.pending.points.pop(); if (!next.pending.points.length) next.pending = null; }); });
    const finish = button('Замкнуть контур', 'ape-primary', () => finishPending());
    const addVertex = button('Добавить угол', '', () => { const m = state.annotations.find(m => m.id === selected); if (!m || !TOOLS[m.tool]?.polygon) return; const at = selectedVertex < 0 ? 0 : selectedVertex, a = m.points[at], b = m.points[(at + 1) % m.points.length]; mutate(next => { next.annotations.find(m => m.id === selected).points.splice(at + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }); selectedVertex = at + 1; draw(); });
    const deleteVertex = button('Удалить угол', '', () => { const m = state.annotations.find(m => m.id === selected); if (!m || selectedVertex < 0) return; try { const next = G.removeVertex({ ...m, isClosed: !!TOOLS[m.tool]?.polygon }, selectedVertex); mutate(s => { s.annotations[s.annotations.findIndex(m => m.id === selected)] = next; }); selectedVertex = -1; } catch (_) { notice('В замкнутом контуре должны оставаться хотя бы три угла.', true); } });
    const deleteMark = button('Удалить отметку', '', () => removeMark(selected)); actionSlot.append(actionText, removePoint, finish, addVertex, deleteVertex, deleteMark);
    const viewport = el('div', null, 'ape-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Рабочая область графики');
    const canvas = el('canvas'); canvas.setAttribute('aria-label', kind === 'map' ? 'Схема территории для разметки' : 'План помещения для разметки'); viewport.append(canvas);
    const legend = el('div', null, 'ape-legend'); legend.setAttribute('aria-label', 'Легенда графики');
    const drawer = el('details', null, 'ape-drawer'), drawerSummary = el('summary', 'Отметки и названия'), markList = el('div', null, 'ape-marks'); drawer.append(drawerSummary, markList);
    const footer = el('div', null, 'ape-footer'), saveStatus = el('span', 'Черновик'), retry = button('Повторить', '', () => persist()), download = button('Скачать PNG', 'ape-secondary', () => downloadPreview()), save = button('Сохранить разметку', 'ape-primary', async () => { try { assertExportable(state); await flush(); notice('Разметка сохранена.'); } catch (e) { notice(e.message, true); } });
    retry.hidden = true; footer.append(saveStatus, retry, download, save);
    const sourceNote = el('p', kind === 'map' ? (service === 'tobacco' ? 'Прямую отмечайте вручную. Масштаб скриншота не определяет расстояние автоматически.' : 'Отметьте входы, проверенные организации и путь замера. Расстояние укажите вручную.') : 'Оригинал хранится отдельно. Полные подписи — в легенде под планом.', 'ape-note');
    panel.append(top, sourceNote, toolbar, guidance, actionSlot, viewport, legend, drawer, footer); container.replaceChildren(panel);
    const chooser = el('dialog', null, 'ape-sheet-dialog'), chooserHead = el('div', null, 'ape-sheet-head'); chooserHead.append(el('strong', kind === 'map' ? 'Скриншот территории' : 'Страница исходного документа'), button('Закрыть', '', () => chooser.close()));
    const sourceSelect = el('select'); sourceSelect.setAttribute('aria-label', 'Исходный документ');
    const uploadInput = el('input'); uploadInput.type = 'file'; uploadInput.accept = kind === 'map' ? 'image/*' : 'image/*,application/pdf'; uploadInput.hidden = true;
    const upload = button('Добавить файл', 'ape-secondary', () => uploadInput.click()); upload.hidden = typeof options.onUpload !== 'function';
    const chooserControls = el('div', null, 'ape-sheet-controls'); chooserControls.append(sourceSelect, upload, uploadInput);
    const pageControls = el('div', null, 'ape-pages'), prev = button('←', '', () => candidatePage((candidate?.page || 1) - 1)), next = button('→', '', () => candidatePage((candidate?.page || 1) + 1)), pageLabel = el('span', 'Страница —'); prev.setAttribute('aria-label', 'Предыдущая страница'); next.setAttribute('aria-label', 'Следующая страница'); pageControls.append(prev, pageLabel, next);
    const chooserStatus = el('p', 'Выберите исходный файл.', 'ape-sheet-status'); chooserStatus.setAttribute('aria-live', 'polite');
    const preview = el('div', null, 'ape-sheet-preview'), previewCanvas = el('canvas'); preview.append(previewCanvas);
    const chooserFoot = el('div', null, 'ape-sheet-foot'), selectPage = button('Использовать этот лист', 'ape-primary', async () => { await useCandidate(); }); selectPage.disabled = true; chooserFoot.append(selectPage);
    chooser.append(chooserHead, chooserControls, pageControls, chooserStatus, preview, chooserFoot); container.append(chooser);
    function notice(text, error) { if (!alive) return; message.textContent = text; message.classList.toggle('ape-error', !!error); }
    function snapshot() { return { annotations: copy(state.annotations), pending: copy(state.pending), sequence: copy(state.sequence) }; }
    function pushHistory(before) { past.push(before); if (past.length > 60) past.shift(); future = []; }
    function mutate(fn, refreshList = true) { const before = snapshot(); fn(state); pushHistory(before); persist(); draw(refreshList); }
    const saveQueue = createSaveQueue(async nextState => { const result = await options.onChange(nextState); if (result === false) throw new Error('Изменения не приняты. Повторите сохранение.'); });
    function persist() {
      const rev = ++revision, nextState = copy(state); saveStatus.textContent = 'Сохраняю…'; retry.hidden = true;
      const job = saveQueue.enqueue(nextState);
      saveTail = job;
      job.then(() => { if (!alive || rev !== revision) return; saveError = null; saveStatus.textContent = 'Сохранено'; retry.hidden = true; }).catch(e => { if (!alive || rev !== revision) return; saveError = e; saveStatus.textContent = 'Не сохранено'; retry.hidden = false; notice(e.message || 'Не удалось сохранить. Повторите.', true); });
      return job;
    }
    async function flush() { await saveTail; if (saveError) throw saveError; }
    function applySnapshot(s) { const high = { ...state.sequence }; state.annotations = copy(s.annotations); state.pending = copy(s.pending); for (const [key, value] of Object.entries(s.sequence || {})) high[key] = Math.max(high[key] || 0, value); state.sequence = high; selected = null; selectedVertex = -1; persist(); draw(); }
    function undoChange() { if (!past.length) return; future.push(snapshot()); applySnapshot(past.pop()); }
    function redoChange() { if (!future.length) return; past.push(snapshot()); applySnapshot(future.pop()); }
    function setTool(value) { if (state.pending && state.pending.tool !== value && !['pan', 'edit'].includes(value)) { notice('Сначала завершите контур или отмените его точки.', true); toolSelect.value = activeTool; return; } activeTool = value; toolSelect.value = value; updateControls(); draw(false); }
    function finishPending() { if (!state.pending) return; try { const before = snapshot(); state = addMark(state, state.pending.tool, state.pending.points); selected = state.annotations.at(-1).id; selectedVertex = -1; activeTool = 'edit'; toolSelect.value = activeTool; pushHistory(before); persist(); draw(); notice('Контур ' + state.annotations.at(-1).code + ' готов. Углы можно перетащить.'); } catch (e) { notice(e.message, true); } }
    function removeMark(id) { if (!id) return; mutate(next => { next.annotations = next.annotations.filter(m => m.id !== id); }); if (selected === id) { selected = null; selectedVertex = -1; } draw(); }
    function updateControls() {
      const ready = !!image && !sourceLoading, pending = state.pending?.points?.length || 0, mark = state.annotations.find(m => m.id === selected);
      toolSelect.value = activeTool; pan.classList.toggle('selected', activeTool === 'pan'); canvas.dataset.tool = activeTool;
      toolbar.hidden = !ready; actionSlot.hidden = !ready; viewport.hidden = !ready; legend.hidden = !ready; drawer.hidden = !ready;
      undo.disabled = !past.length; redo.disabled = !future.length; download.disabled = save.disabled = !ready;
      removePoint.hidden = finish.hidden = !pending; finish.disabled = pending < 3; addVertex.hidden = deleteVertex.hidden = !mark || !TOOLS[mark.tool]?.polygon || !!pending; deleteVertex.disabled = selectedVertex < 0; deleteMark.hidden = !mark || !!pending;
      actionText.textContent = pending ? 'Углов: ' + pending : mark ? mark.code : kind === 'map' ? 'Короткие коды на схеме, полные названия ниже' : 'Отметьте углы помещения';
      if (!message.classList.contains('ape-error')) message.textContent = activeTool === 'pan' ? 'Перетаскивайте лист для перемещения.' : activeTool === 'edit' ? 'Выберите отметку. Точки можно перетаскивать.' : TOOLS[activeTool]?.polygon ? 'Нажимайте на углы, затем замкните контур.' : 'Нанесите отметку на изображение.';
      zoomText.textContent = Math.round(fitScale * zoom * 100) + '%';
      sourceLabel.textContent = state.evidence_id ? ((options.evidence || []).find(e => String(e.id) === String(state.evidence_id))?.name || 'Исходный файл') + ' · лист ' + state.page : 'Исходник не выбран';
    }
    function fitImage() { if (!image) return; const w = image.naturalWidth || image.width, h = image.naturalHeight || image.height; fitScale = Math.min(1, Math.max(80, viewport.clientWidth - 24) / w, Math.max(100, viewport.clientHeight - 24) / h); zoom = 1; draw(false); viewport.scrollTop = viewport.scrollLeft = 0; }
    function setZoom(value) { if (!image) return; const old = zoom, cx = viewport.scrollLeft + viewport.clientWidth / 2, cy = viewport.scrollTop + viewport.clientHeight / 2; zoom = Math.max(.5, Math.min(8, value)); draw(false); viewport.scrollLeft = cx * zoom / old - viewport.clientWidth / 2; viewport.scrollTop = cy * zoom / old - viewport.clientHeight / 2; }
    function draw(refreshList = true) {
      if (!alive) return; updateControls(); if (!image) return;
      const scale = fitScale * zoom; renderScene(canvas, image, state, { kind, scale, selection: selected, vertex: selectedVertex }); canvas.style.width = Math.round(canvas.width * scale) + 'px'; canvas.style.height = Math.round(canvas.height * scale) + 'px';
      legend.replaceChildren(); legendEntries(state, kind).forEach(entry => { const row = el('div'), code = el('b', entry.code), text = el('span', entry.text); code.style.color = entry.color; row.append(code, text); legend.append(row); });
      drawerSummary.textContent = 'Отметки и названия · ' + state.annotations.length;
      if (refreshList) renderMarks();
    }
    function editField(id, key, value) { mutate(next => { const m = next.annotations.find(m => m.id === id); if (m) m[key] = value; }, false); }
    function field(labelText, tag, value, handler) { const label = el('label', labelText), input = el(tag); input.setAttribute('aria-label', labelText); input.value = value || ''; on(input, tag === 'select' ? 'change' : 'input', e => handler(e.target.value)); label.append(input); return { label, input }; }
    function renderMarks() {
      markList.replaceChildren();
      state.annotations.forEach(m => {
        const item = el('div', null, 'ape-mark'), row = el('div', null, 'ape-mark-row'); item.classList.toggle('selected', selected === m.id);
        const choose = button(m.code, '', () => { selected = m.id; selectedVertex = -1; activeTool = 'edit'; draw(); }); choose.setAttribute('aria-label', 'Выбрать отметку ' + m.code);
        const name = el('input'); name.value = m.label || ''; name.placeholder = m.tool === 'hazard' ? 'Название организации' : (TOOLS[m.tool] || TOOLS.text).label; name.setAttribute('aria-label', (m.tool === 'hazard' ? 'Название организации ' : 'Название отметки ') + m.code); on(name, 'input', () => editField(m.id, 'label', name.value)); on(name, 'change', refreshEndpointLabels);
        const remove = button('×', '', () => removeMark(m.id)); remove.setAttribute('aria-label', 'Удалить отметку ' + m.code); row.append(choose, name, remove); item.append(row);
        if (TOOLS[m.tool]?.polygon) { const corners = el('div', null, 'ape-corners'); m.points.forEach((p, i) => { const b = button('Угол ' + (i + 1), '', () => { selected = m.id; selectedVertex = i; activeTool = 'edit'; draw(); }); b.classList.toggle('selected', selected === m.id && selectedVertex === i); corners.append(b); }); item.append(corners); }
        if (kind === 'map' && ['route', 'straight'].includes(m.tool)) {
          const links = el('div', null, 'ape-links'), distance = field('Замер ' + m.code + ', м', 'input', m.distance, v => editField(m.id, 'distance', v)); distance.input.inputMode = 'decimal'; links.append(distance.label);
          for (const [key, label, filter] of [['fromEntranceId', 'От входа', 'entrance'], ['toObjectId', 'До организации', 'hazard']]) {
            const f = field(label + ' · ' + m.code, 'select', m[key], v => editField(m.id, key, v)); f.input.dataset.endpoint = filter; f.input.append(new Option('Выбрать точку', '')); state.annotations.filter(x => x.tool === filter).forEach(x => f.input.append(new Option(x.code + ' · ' + (x.label || TOOLS[x.tool].label), x.id))); f.input.value = m[key] || ''; links.append(f.label);
          } item.append(links);
        }
        if (kind === 'map' && m.tool === 'hazard') {
          const result = field('Результат проверки ' + m.code, 'select', m.status, v => { editField(m.id, 'status', v); source.label.hidden = v !== 'licensed'; });
          [['pending', 'Выберите результат'], ['clear', 'Без замечаний'], ['licensed', 'Есть сведения о лицензии'], ['disputed', 'Спорный результат'], ['confirmed', 'Подтверждённый риск']].forEach(([value, text]) => result.input.append(new Option(text, value))); result.input.value = m.status === 'checked' ? 'clear' : m.status || 'pending';
          const source = field('Источник сведений о лицензии ' + m.code, 'input', m.source || m.sourceUrl, v => editField(m.id, 'source', v)); source.label.hidden = m.status !== 'licensed';
          const note = field('Наблюдение по организации ' + m.code, 'textarea', m.note, v => editField(m.id, 'note', v)); item.append(result.label, source.label, note.label);
        }
        markList.append(item);
      });
      if (state.versions?.length) markList.append(button(kind === 'map' ? 'Вернуть предыдущий скриншот' : 'Вернуть предыдущий лист', 'ape-secondary', async () => { try { state = restoreSource(state); past = []; future = []; await persist(); await (ready = loadSelected()); } catch (e) { notice(e.message, true); } }));
    }
    function refreshEndpointLabels() { markList.querySelectorAll('[data-endpoint]').forEach(select => Array.from(select.options).forEach(option => { const m = state.annotations.find(m => String(m.id) === option.value); if (m) option.textContent = m.code + ' · ' + (m.label || TOOLS[m.tool].label); })); }
    async function sourceResource(evidence, page) {
      const url = await options.evidenceUrl(evidence.id);
      const response = await fetch(url, { credentials: 'same-origin' }); if (!response.ok) throw new Error('Исходный файл недоступен.');
      const bytes = await response.arrayBuffer();
      if (isPDF(evidence, bytes)) { const lib = await pdfJS(), pdf = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise; if ((page || 1) > pdf.numPages) { pdf.destroy(); throw new Error('В исходнике нет сохранённой страницы ' + page + '. Выберите лист заново.'); } return { evidence, pdf, page: page || 1, pages: pdf.numPages }; }
      const blob = new Blob([bytes], { type: evidence.mime || 'application/octet-stream' }), objectUrl = URL.createObjectURL(blob), img = new Image();
      try { await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Не удалось прочитать изображение.')); img.src = objectUrl; }); } finally { URL.revokeObjectURL(objectUrl); }
      const resized = document.createElement('canvas'), ratio = Math.min(1, 2600 / Math.max(img.naturalWidth, img.naturalHeight)); resized.width = Math.max(1, Math.round(img.naturalWidth * ratio)); resized.height = Math.max(1, Math.round(img.naturalHeight * ratio)); resized.getContext('2d').drawImage(img, 0, 0, resized.width, resized.height);
      return { evidence, image: resized, page: 1, pages: 1 };
    }
    async function pageImage(resource, page, setTask) {
      if (resource.image) return resource.image;
      const pdfPage = await resource.pdf.getPage(page), base = pdfPage.getViewport({ scale: 1 }), scale = Math.min(2, 2600 / Math.max(base.width, base.height)), bounds = pdfPage.getViewport({ scale });
      const output = document.createElement('canvas'); output.width = Math.ceil(bounds.width); output.height = Math.ceil(bounds.height);
      const task = pdfPage.render({ canvasContext: output.getContext('2d'), viewport: bounds, background: '#fff' }); if (setTask) setTask(task); await task.promise; return output;
    }
    async function loadSelected() {
      const token = ++loadToken; sourceLoading = true; image = null; draw();
      if (!state.evidence_id) { sourceLoading = false; notice(kind === 'map' ? 'Выберите скриншот Яндекс Карт.' : 'Выберите страницу с графикой помещения.'); return; }
      const evidence = (options.evidence || []).find(e => String(e.id) === String(state.evidence_id));
      if (!evidence) { sourceLoading = false; notice('Исходник не найден в комплекте. Разметка сохранена; добавьте исходный документ.', true); return; }
      notice('Открываю исходный файл…');
      let resource;
      try { resource = await sourceResource(evidence, state.page); const rendered = await pageImage(resource, resource.page); if (token !== loadToken || !alive) return; image = rendered; sourceLoading = false; notice(''); draw(); requestAnimationFrame(() => { if (alive && token === loadToken) fitImage(); }); }
      catch (e) { if (token === loadToken && alive) { sourceLoading = false; notice('Не удалось открыть исходник. Выберите файл повторно. ' + (e.message || ''), true); } }
      finally { resource?.pdf?.destroy(); }
    }
    function availableEvidence() { return (options.evidence || []).filter(e => eligible(e, kind) || String(e.id) === String(state.evidence_id)); }
    async function openChooser() {
      if (state.pending) { notice('Сначала замкните контур или отмените его точки.', true); return; }
      sourceSelect.replaceChildren(new Option('Выберите файл', '')); availableEvidence().forEach(e => sourceSelect.append(new Option(e.name || 'Документ', e.id))); sourceSelect.value = state.evidence_id || '';
      chooser.showModal(); if (state.evidence_id) await loadCandidate(state.evidence_id, state.page);
    }
    async function loadCandidate(id, page) {
      const token = ++chooserToken; renderTask?.cancel(); renderTask = null; candidate?.pdf?.destroy(); candidate = null; selectPage.disabled = true; prev.disabled = next.disabled = true; previewCanvas.width = previewCanvas.height = 1;
      if (!id) { chooserStatus.textContent = 'Выберите исходный файл.'; return; }
      const evidence = (options.evidence || []).find(e => String(e.id) === String(id)); if (!evidence) return;
      chooserStatus.textContent = 'Открываю файл…';
      try { const resource = await sourceResource(evidence, page || 1); if (!alive || token !== chooserToken || !chooser.open) { resource.pdf?.destroy(); return; } candidate = resource; await candidatePage(resource.page); }
      catch (e) { if (alive && token === chooserToken) chooserStatus.textContent = 'Файл не открывается. Попробуйте другой PDF или изображение.'; }
    }
    async function candidatePage(page) {
      if (!candidate || page < 1 || page > candidate.pages) return;
      const token = ++chooserToken, resource = candidate; resource.page = page; resource.rendered = null; renderTask?.cancel(); selectPage.disabled = true;
      prev.disabled = page <= 1; next.disabled = page >= resource.pages; pageLabel.textContent = 'Страница ' + page + ' из ' + resource.pages; chooserStatus.textContent = 'Загружаю страницу…';
      try { const output = await pageImage(resource, page, task => { renderTask = task; }); if (!alive || token !== chooserToken || !chooser.open || resource !== candidate) return;
        resource.rendered = output; resource.renderedPage = page; previewCanvas.width = output.width; previewCanvas.height = output.height; previewCanvas.getContext('2d').drawImage(output, 0, 0); selectPage.disabled = false; chooserStatus.textContent = 'Выберите читаемый лист. Оригинал останется в комплекте.';
      } catch (e) { if (token === chooserToken && e.name !== 'RenderingCancelledException') chooserStatus.textContent = 'Не удалось отобразить страницу. Выберите другую.'; }
    }
    async function useCandidate() {
      if (!candidate?.rendered || candidate.renderedPage !== candidate.page) return;
      const chosen = candidate, nextState = selectSource(state, chosen.evidence.id, chosen.page), changed = String(state.evidence_id) !== String(nextState.evidence_id) || state.page !== nextState.page;
      state = nextState; selectPage.disabled = true;
      try { await persist(); image = chosen.rendered; sourceLoading = false; if (changed) { past = []; future = []; selected = null; selectedVertex = -1; } chooser.close(); draw(); requestAnimationFrame(fitImage); notice('Лист выбран; исходный документ сохранён отдельно.'); }
      catch (e) { chooserStatus.textContent = 'Не удалось сохранить выбранный лист. Повторите.'; selectPage.disabled = false; }
    }
    on(sourceSelect, 'change', () => loadCandidate(sourceSelect.value, 1));
    on(uploadInput, 'change', async () => { const file = uploadInput.files?.[0]; if (!file) return; chooserStatus.textContent = 'Загружаю оригинал…'; upload.disabled = true; try {
      const result = await options.onUpload(file, { role: kind === 'map' ? 'map-source' : 'plan-source' });
      const evidence = Array.isArray(result) ? result.at(-1) : result?.id ? result : Array.isArray(result?.evidence) ? result.evidence.at(-1) : result?.evidence;
      if (!evidence?.id) throw new Error('Загрузка не вернула исходный файл.'); options.evidence = [...(options.evidence || []).filter(e => String(e.id) !== String(evidence.id)), evidence]; sourceSelect.append(new Option(evidence.name || file.name, evidence.id)); sourceSelect.value = evidence.id; await loadCandidate(evidence.id, 1);
    } catch (e) { chooserStatus.textContent = e.message || 'Файл не загружен.'; } finally { upload.disabled = false; uploadInput.value = ''; } });
    on(chooser, 'close', () => { chooserToken++; renderTask?.cancel(); renderTask = null; candidate?.pdf?.destroy(); candidate = null; });
    on(toolSelect, 'change', () => setTool(toolSelect.value));
    function eventPoint(e) { const rect = canvas.getBoundingClientRect(); return point({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }); }
    on(canvas, 'pointerdown', e => {
      if (!image || sourceLoading || e.button > 0) return; e.preventDefault(); canvas.setPointerCapture(e.pointerId); const p = eventPoint(e), rect = canvas.getBoundingClientRect();
      pointer = { id: e.pointerId, start: p, clientX: e.clientX, clientY: e.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, before: snapshot(), points: [p], moved: false };
      if (activeTool === 'edit') { const hit = hitTest(state, p, rect.width, rect.height, 13); selected = hit?.id || null; selectedVertex = hit?.vertex ?? -1; pointer.mark = selected ? copy(state.annotations.find(m => m.id === selected)) : null; draw(false); }
    });
    on(canvas, 'pointermove', e => {
      if (!pointer || pointer.id !== e.pointerId) return; e.preventDefault(); const p = eventPoint(e); pointer.moved ||= Math.hypot(e.clientX - pointer.clientX, e.clientY - pointer.clientY) > 3;
      if (activeTool === 'pan') { viewport.scrollLeft = pointer.scrollLeft - (e.clientX - pointer.clientX); viewport.scrollTop = pointer.scrollTop - (e.clientY - pointer.clientY); return; }
      if (activeTool === 'edit' && pointer.mark) {
        try { const mark = { ...pointer.mark, isClosed: !!TOOLS[pointer.mark.tool]?.polygon }; const moved = selectedVertex >= 0 ? G.moveVertex(mark, selectedVertex, p) : G.moveContour(mark, p.x - pointer.start.x, p.y - pointer.start.y); delete moved.isClosed; state.annotations[state.annotations.findIndex(m => m.id === selected)] = moved; draw(false); } catch (_) { /* Keep the last valid geometry while a corner crosses another edge. */ } return;
      }
      if (activeTool === 'route') { if (G.distance(pointer.points.at(-1), p) > .002) pointer.points.push(p); state.pending = { tool: activeTool, points: pointer.points }; draw(false); }
      else if (TOOLS[activeTool] && !TOOLS[activeTool].polygon && !TOOLS[activeTool].point) { state.pending = { tool: activeTool, points: [pointer.start, p] }; draw(false); }
    });
    function endPointer(e, cancelled) {
      if (!pointer || pointer.id !== e.pointerId) return; const gesture = pointer; pointer = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (cancelled) { state.annotations = gesture.before.annotations; state.pending = gesture.before.pending; draw(); return; }
      const p = eventPoint(e), config = TOOLS[activeTool];
      if (activeTool === 'pan') return;
      if (activeTool === 'edit') { if (gesture.mark && gesture.moved) { pushHistory(gesture.before); persist(); } draw(); return; }
      if (!config) return;
      if (config.polygon) { mutate(next => { next.pending ||= { tool: activeTool, points: [] }; next.pending.points.push(p); }); return; }
      const points = config.point ? [p] : activeTool === 'route' ? [...gesture.points, p] : [gesture.start, p];
      if (!config.point && G.distance(points[0], points.at(-1)) < .001 && points.length < 3) { state.pending = gesture.before.pending; draw(); return; }
      try { state = addMark(state, activeTool, points); pushHistory(gesture.before); persist(); selected = state.annotations.at(-1).id; selectedVertex = -1; draw(); if (activeTool === 'hazard' || activeTool === 'text') { drawer.open = true; markList.querySelector('.ape-mark:last-of-type input')?.focus({ preventScroll: true }); } }
      catch (error) { state.pending = gesture.before.pending; draw(); notice(error.message, true); }
    }
    on(canvas, 'pointerup', e => endPointer(e, false)); on(canvas, 'pointercancel', e => endPointer(e, true));
    async function exportPreview() { assertExportable(state); await flush(); if (sourceLoading) await ready; if (!image || !state.evidence_id) return null; const output = document.createElement('canvas'), w = image.naturalWidth || image.width; renderScene(output, image, state, { kind, artifact: true, scale: Math.min(1, 900 / w) }); const original = (options.evidence || []).find(e => String(e.id) === String(state.evidence_id)); return { name: (kind === 'map' ? 'Схема-' : 'План-') + (original?.name || 'объект').replace(/\.[^.]+$/, '') + '-лист-' + state.page + '.png', mime: 'image/png', data: output.toDataURL('image/png').split(',')[1], role: kind, subject_id: 'annotation' }; }
    async function downloadPreview() { try { const result = await exportPreview(); if (!result) return; const binary = atob(result.data), bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: result.mime })), a = document.createElement('a'); a.href = url; a.download = result.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); } catch (e) { notice(e.message, true); } }
    let ready = loadSelected();
    return {
      refresh(nextOptions) { if (nextOptions) Object.assign(options, nextOptions); return ready = saveTail.catch(() => {}).then(() => { state = normalise(options.getState?.() || state); return loadSelected(); }); },
      flush, exportPreview,
      destroy() { alive = false; loadToken++; chooserToken++; renderTask?.cancel(); candidate?.pdf?.destroy(); controller.abort(); if (chooser.open) chooser.close(); container.replaceChildren(); image = null; },
    };
  }
  return { mount, helpers: { normalise, addMark, selectSource, restoreSource, assertExportable, eligible, isPDF, toolNames, legendEntries, hitTest, renderScene, wrapText, createSaveQueue }, tools: TOOLS };
});
