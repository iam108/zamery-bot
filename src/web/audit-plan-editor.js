(function () {
  'use strict';
  const TOOLS = {
    boundary: { label: 'Заявляемые границы', color: '#a75bda', polygon: true },
    lease: { label: 'Границы аренды', color: '#ba9300', polygon: true },
    hall: { label: 'Зал обслуживания', color: '#d84053', polygon: true },
    bar: { label: 'Бар', color: '#188854', polygon: true },
    partition: { label: 'Перегородка', color: '#167ab0' },
    structural: { label: 'Стена: назначение уточнить', color: '#d17317' },
    opening: { label: 'Проём / вход', color: '#a64b66' },
  };
  function mount(container, options) {
    container.replaceChildren();
    const controller = new AbortController();
    const signal = controller.signal;
    let image = null, imageEvidence = null, current = [], tool = 'boundary', loading = 0;
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
    const note = el('p', 'Оригинал сохраняется отдельно. Выберите изображение и отмечайте точки по порядку. Для PDF приложите также изображение нужной страницы.', 'help');
    const select = el('select'); select.setAttribute('aria-label', 'Изображение плана для разметки');
    const toolSelect = el('select'); toolSelect.setAttribute('aria-label', 'Что отметить на плане');
    Object.entries(TOOLS).forEach(([key, item]) => { const o = el('option', item.label); o.value = key; toolSelect.append(o); });
    const toolbar = el('div', null, 'plan-toolbar');
    const finish = el('button', 'Завершить отметку', 'button secondary'); finish.type = 'button';
    const undoPoint = el('button', 'Убрать точку', 'button secondary'); undoPoint.type = 'button';
    const undo = el('button', 'Отменить отметку', 'button secondary'); undo.type = 'button';
    toolbar.append(finish, undoPoint, undo);
    const zoomLabel = el('label', 'Масштаб плана', 'field');
    const zoom = el('input'); zoom.type = 'range'; zoom.min = '100'; zoom.max = '250'; zoom.value = '100'; zoom.setAttribute('aria-label', 'Масштаб плана'); zoomLabel.append(zoom);
    const viewport = el('div', null, 'plan-viewport');
    viewport.style.cssText = 'overflow:auto;max-height:65vh;border:1px solid var(--line, #aab7c7);border-radius:16px;background:#fff';
    const canvas = el('canvas'); canvas.setAttribute('aria-label', 'Разметка плана: коснитесь изображения, чтобы добавить точку');
    canvas.style.cssText = 'display:block;width:100%;height:auto;touch-action:pan-x pan-y';
    viewport.append(canvas);
    const status = el('p', '', 'help'); status.setAttribute('aria-live', 'polite');
    const list = el('ol', null, 'plan-marks');
    const basisLabel = el('label', 'Основание определения стен', 'field');
    const basis = el('textarea'); basis.rows = 2; basis.maxLength = 1500; basis.placeholder = 'Документ и страница; визуальное предположение; назначение не установлено'; basisLabel.append(basis);
    const legend = el('p', 'Сиреневый — заявляемые границы; жёлтый — аренда; красный — зал; зелёный — бар. Голубой — перегородка; оранжевый — стена, назначение уточнить.', 'help');
    container.append(note, select, toolSelect, toolbar, zoomLabel, viewport, status, list, basisLabel, legend);
    function plan() { const p = options.getState() || {}; return { ...p, annotations: Array.isArray(p.annotations) ? p.annotations : [] }; }
    function emit(next) { options.onChange(next); draw(); }
    function drawShape(ctx, shape, pending) {
      const t = TOOLS[shape.tool]; if (!t || !shape.points?.length) return;
      ctx.beginPath(); shape.points.forEach((p, i) => { const x = p.x * canvas.width, y = p.y * canvas.height; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (t.polygon && shape.points.length >= 3 && !pending) { ctx.closePath(); ctx.fillStyle = t.color + '20'; ctx.fill(); }
      ctx.strokeStyle = t.color; ctx.lineWidth = Math.max(3, canvas.width / 280); ctx.lineJoin = 'round';
      ctx.setLineDash(pending ? [10, 7] : []); ctx.stroke(); ctx.setLineDash([]);
      shape.points.forEach(p => { ctx.beginPath(); ctx.arc(p.x * canvas.width, p.y * canvas.height, Math.max(4, canvas.width / 180), 0, Math.PI * 2); ctx.fillStyle = t.color; ctx.fill(); });
    }
    function draw() {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const p = plan(); p.annotations.forEach(mark => drawShape(ctx, mark, false));
      if (current.length) drawShape(ctx, { tool, points: current }, true);
      list.replaceChildren();
      p.annotations.forEach((mark, i) => { const item = el('li', (TOOLS[mark.tool]?.label || 'Отметка') + ' · ' + mark.points.length + ' точек'); const b = el('button', 'Удалить', 'button secondary'); b.type = 'button'; b.setAttribute('aria-label', 'Удалить отметку ' + (i + 1)); b.addEventListener('click', () => { const next = plan(); next.annotations = next.annotations.filter((_, n) => n !== i); emit(next); }, { signal }); item.append(' ', b); list.append(item); });
      finish.disabled = !image || current.length < (TOOLS[tool].polygon ? 3 : 2);
      undoPoint.disabled = !current.length; undo.disabled = !p.annotations.length;
      if (image) status.textContent = current.length ? 'Точек: ' + current.length + '. Нажмите «Завершить отметку».' : 'Отметок: ' + p.annotations.length + '. Нажмите на план для первой точки.';
      viewport.hidden = !image; toolbar.hidden = !image; zoomLabel.hidden = !image; toolSelect.hidden = !image;
    }
    async function load(id) {
      const run = ++loading; current = []; image = null; imageEvidence = null; draw();
      if (!id) { status.textContent = 'Прикрепите изображение плана на этом этапе.'; return; }
      status.textContent = 'Открываю оригинал плана…';
      try {
        const src = await options.evidenceUrl(id);
        const nextImage = new Image();
        await new Promise((resolve, reject) => { nextImage.onload = resolve; nextImage.onerror = reject; nextImage.src = src; });
        if (run !== loading || signal.aborted) return;
        image = nextImage; imageEvidence = (options.evidence || []).find(e => e.id === id);
        const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
        draw();
      } catch (e) { if (run === loading && !signal.aborted) status.textContent = 'Не удалось открыть изображение. Проверьте связь или выберите другой файл.'; }
    }
    async function refresh() {
      const p = plan(); basis.value = p.wall_basis || '';
      select.replaceChildren(el('option', 'Выберите изображение плана'));
      select.firstChild.value = '';
      const files = (options.evidence || []).filter(e => /^image\/(jpeg|png|webp)$/.test(e.mime) && ['plan', 'plan-source'].includes(e.role) && e.subject_id !== 'annotation');
      files.forEach(e => { const o = el('option', e.name); o.value = e.id; select.append(o); });
      const selected = files.some(e => e.id === p.evidence_id) ? p.evidence_id : '';
      select.value = selected; await load(selected);
    }
    select.addEventListener('change', () => { const next = plan(); if (next.annotations.length && next.evidence_id !== select.value) { select.value = next.evidence_id || ''; status.textContent = 'Сначала удалите отметки предыдущего плана или верните его. Они привязаны к выбранному изображению.'; return; } next.evidence_id = select.value; next.annotations = []; emit(next); load(select.value); }, { signal });
    toolSelect.addEventListener('change', () => { tool = toolSelect.value; current = []; draw(); }, { signal });
    basis.addEventListener('input', () => { const next = plan(); next.wall_basis = basis.value; options.onChange(next); }, { signal });
    let pointerStart = null;
    canvas.addEventListener('pointerdown', e => { pointerStart = { x: e.clientX, y: e.clientY }; }, { signal });
    canvas.addEventListener('pointerup', e => {
      if (!image || !pointerStart || Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 8) return;
      pointerStart = null; const r = canvas.getBoundingClientRect();
      current.push({ x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }); draw();
    }, { signal });
    finish.addEventListener('click', () => { const next = plan(); next.annotations = next.annotations.concat({ tool, points: current.slice() }); current = []; emit(next); }, { signal });
    undoPoint.addEventListener('click', () => { current.pop(); draw(); }, { signal });
    undo.addEventListener('click', () => { const next = plan(); next.annotations = next.annotations.slice(0, -1); emit(next); }, { signal });
    zoom.addEventListener('input', () => { canvas.style.width = zoom.value + '%'; }, { signal });
    refresh();
    return {
      refresh,
      destroy() { loading++; controller.abort(); image = null; container.replaceChildren(); },
      async exportPreview() {
        if (!image || !plan().annotations.length) return null;
        if (current.length) throw new Error('Завершите отметку на плане перед отправкой.');
        draw();
        return { name: 'Разметка-' + (imageEvidence?.name || 'план').replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.92).split(',')[1], role: 'plan', subject_id: 'annotation' };
      },
    };
  }
  window.AuditPlanEditor = { mount };
})();
