const vm = require('node:vm');
const { miniAppForm } = require('../../src/web/index');
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const html = miniAppForm(), nodes = new Map(), alerts = [], requests = [], waits = [], timers = new Map();
  let serial = 0, now = 0;
  function element(tag = 'div') {
    return { tagName: tag.toUpperCase(), value: '', checked: false, disabled: false, hidden: false, style: {}, options: [], children: [],
      classList: { add() {}, remove() {}, toggle() {} }, appendChild(child) { this.children.push(child); if (child.tagName === 'OPTION') this.options.push(child); }, setAttribute() {} };
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) nodes.set(match[2], element(match[1]));
  const context = { window: {}, location: { search: '' }, URLSearchParams, URL, console, Date: options.virtualClock ? class extends Date { static now() { return now; } } : Date, Math, AbortController, alert: text => alerts.push(text),
    FormData: class { constructor() { this.entries = []; } append(...entry) { this.entries.push(entry); } },
    setTimeout(fn, delay) { const id = ++serial; waits.push(delay); timers.set(id, { fn, at: now + delay }); if (!options.virtualClock && delay < 30000) queueMicrotask(() => { if (timers.delete(id)) fn(); }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { getElementById: id => nodes.get(id), querySelectorAll: () => [...nodes.values()].filter(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), createElement: element },
    fetch: async (url, requestOptions) => { requests.push({ url, options: requestOptions }); return context.respond(url, requestOptions); },
  };
  vm.createContext(context);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  for (const [field, value] of Object.entries({ address: 'Москва, адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', cad_num: '77:01:0000001:12' })) nodes.get(field).value = value;
  nodes.get('egrn_order').checked = true;
  return { c: context, nodes, alerts, requests, waits, timers,
    async tick(ms) { const target = now + ms; for (;;) { const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle(); } now = target; await settle(); },
  };
}
function response(body, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body }; }
function savedPacket(revision = 1) { return { ok: true, can_edit: true, order: { id: 58, packet_revision: revision, address: 'Москва, адрес', owner_name: 'Клиент', object_type: 'Общепит алкоголь', service: 'Получение', cad_num: '77:01:0000001:12' }, materials: [{ id: 'saved-plan', name: 'План.pdf', role: 'plan', bytes: 4 }] }; }

module.exports = { harness, response, savedPacket, settle };
