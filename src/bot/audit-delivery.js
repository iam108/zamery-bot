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
  const label = { plan: 'План с разметкой', map: 'Карта и входы', photo: 'Фото объекта' }[photo.role] || 'Фото объекта';
  return label + (orderId ? ' · отчёт по заявке #' + String(orderId).slice(0, 30) : ' · отчёт аудитора');
}

module.exports = { splitTelegramHtml, photoCaption };
