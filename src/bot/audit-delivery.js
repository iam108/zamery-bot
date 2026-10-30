// Telegram limits message text separately from media captions. Keep each HTML
// message conservatively below the text limit, balancing tags at each boundary.
function splitTelegramHtml(html, limit = 3500) {
  const tokens = String(html).match(/<\/?[a-zA-Z][^>]*>|&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);|[^]/gu) || [];
  const chunks = [];
  let stack = [];
  let current = '';
  const close = tags => tags.slice().reverse().map(tag => '</' + tag.name + '>').join('');
  const open = tags => tags.map(tag => tag.source).join('');
  function flush() {
    if (!current) return;
    chunks.push(current + close(stack));
    current = open(stack);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let nextStack = stack.slice();
    if (token.charAt(0) === '<') {
      const tag = token.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b/);
      const name = tag[2].toLowerCase();
      if (tag[1]) {
        if (!nextStack.length || nextStack[nextStack.length - 1].name !== name) throw new Error('Некорректная разметка отчёта');
        nextStack.pop();
      } else if (!/\/\s*>$/.test(token) && name !== 'br') nextStack.push({ name, source: token });
    }
    if (current.length + token.length + close(nextStack).length > limit) flush();
    if (current.length + token.length + close(nextStack).length > limit) throw new Error('Слишком длинный элемент разметки отчёта');
    current += token;
    stack = nextStack;
    // Prefer whole lines instead of splitting the next paragraph across messages.
    if (token === '\n' && i + 1 < tokens.length) {
      let nextLineLength = 0;
      for (let n = i + 1; n < tokens.length && tokens[n] !== '\n'; n++) nextLineLength += tokens[n].length;
      if (current.length + nextLineLength + close(stack).length > limit) flush();
    }
  }
  if (current && current !== open(stack)) chunks.push(current + close(stack));
  return chunks;
}

function photoCaption(photo, orderId) {
  const label = { plan: 'План с разметкой', 'plan-source': 'Оригинал плана', map: 'Карта и входы', photo: 'Фото объекта', entrance: 'Вход объекта', exterior: 'Фасад и адресная табличка', zone: 'Соседняя организация', interior: 'Внутри помещения', act: 'Акт выездной оценки', document: 'Документ объекта' }[photo.role] || 'Материалы объекта';
  const title = photo.role === 'plan' && photo.subject_id === 'source' ? 'Оригинал представленного плана' : label;
  return title + (orderId ? ' · отчёт по заявке #' + String(orderId).slice(0, 30) : ' · отчёт аудитора');
}

// Preserve original bytes for the lawyer. Telegram previews are additional
// views, never replacements for the originals retained by the draft/handoff.
function deliveryMedia(data) {
  const documents = data.documents || [];
  if (data.ui_version !== 5) return { photos: data.photos || [], documents };
  const rank = file => file.role === 'map' ? 0 : file.role === 'plan' ? 1 : file.role === 'entrance' ? 2 : file.role === 'zone' ? 3 : 4;
  const inline = documents.filter(file =>
    /^(image\/(jpeg|png))$/.test(file.mime) &&
    ['map', 'plan', 'entrance', 'zone', 'interior'].includes(file.role) &&
    !['source', 'original'].includes(file.subject_id) &&
    (file.source ? file.source.length : Buffer.byteLength(file.data || '', 'base64')) <= 10 * 1024 * 1024
  ).sort((a, b) => rank(a) - rank(b));
  return { photos: inline.map(file => ({ ...file, data: file.data || file.source.toString('base64') })), documents };
}

module.exports = { splitTelegramHtml, photoCaption, deliveryMedia };
