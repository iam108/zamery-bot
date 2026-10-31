// Only forward geocoding of Moscow street addresses. GPS stays on the device.
const DEFAULT_URL = 'https://geocode-maps.yandex.ru/v1/';
const MOSCOW_BOUNDS = [36.75, 55.1, 38, 56.1]; // min longitude/latitude, max longitude/latitude
const ATTRIBUTION = Object.freeze({ label: '© Яндекс', url: 'https://yandex.ru/maps/' });

class RouteGeocoderError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new RouteGeocoderError(status, code, message); }
function text(value) { return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim() : ''; }
function endpoint(value) {
  let url;
  try { url = new URL(value || DEFAULT_URL); } catch (_) { fail(503, 'GEOCODER_CONFIG', 'Поиск адреса временно недоступен.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'geocode-maps.yandex.ru' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/v1/') fail(503, 'GEOCODER_CONFIG', 'Поиск адреса временно недоступен.');
  return url;
}
function apiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-zA-Z0-9_-]{8,256}$/.test(key)) fail(503, 'GEOCODER_CONFIG', 'Поиск адреса не настроен. Администратору нужно подключить ключ Геокодера Яндекса.');
  return key;
}
function house(value) {
  const normalized = text(value).replace(/^(?:дом|д\.?)\s*/u, '')
    .replace(/(?:строение|строен\.?|стр\.?)/gu, 'с').replace(/(?:корпус|корп\.?)/gu, 'к')
    .replace(/[.,\s]/g, '').replace(/[abcehkmoptxy]/g, letter => ({ a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' })[letter]);
  const match = /^(\d+[а-я]?(?:\/\d+[а-я]?)?)((?:[кс]\d+[а-я]?){0,2})$/u.exec(normalized);
  return match ? { key: match[1] + match[2], base: match[1], suffix: match[2] } : null;
}
const STREET_TYPES = [
  ['улица', ['улица', 'ул']], ['переулок', ['переулок', 'пер', 'п-к']],
  ['проспект', ['проспект', 'просп', 'пр-т', 'пр-кт']], ['проезд', ['проезд', 'пр-д', 'прзд']],
  ['шоссе', ['шоссе', 'ш']], ['набережная', ['набережная', 'наб']],
  ['бульвар', ['бульвар', 'бул', 'б-р']], ['площадь', ['площадь', 'пл']],
  ['тупик', ['тупик', 'туп']], ['аллея', ['аллея', 'ал']]
];
function street(value) {
  let name = text(value).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim(), kind = '';
  for (const [type, aliases] of STREET_TYPES) {
    const pattern = new RegExp('(^|\\s)(?:' + aliases.join('|') + ')(?=\\s|$)', 'gu');
    if (pattern.test(name)) {
      if (kind && kind !== type) return null;
      kind = type; name = name.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  name = name.replace(/[«»"']/g, '').replace(/\s*-\s*/g, '-');
  return /[а-яa-z]/u.test(name) ? { name, kind } : null;
}
function parseAddress(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_ADDRESS', 'Укажите адрес длиной до 250 символов.');
  let address = text(value);
  // Do not send floor, room, cadastral identifiers or contacts to the provider.
  const detail = address.search(/(?:,\s*|\s+)(?:(?:-?\d+\s*(?:-?й\s*)?)?(?:этаж|эт\.?)(?=\s|[.:№\d,]|$)|(?:комната|комн\.?|помещение|помещ\.?|пом\.?|офис|квартира|кв\.?)(?=\s|[.:№\d]|$))/u);
  if (detail >= 0) address = address.slice(0, detail);
  if (/[+@:]|\d+\.\d+|(?:^|[\s,])(?:gps|latitude|longitude|широта|долгота)(?=[\s,:]|$)/u.test(address)) fail(400, 'INVALID_ADDRESS', 'Укажите только улицу и номер дома, без контактов или координат.');
  address = address.replace(/^(?:\d{6}\s*,\s*)?/, '').replace(/^(?:россия|российская федерация)\s*,?\s*/u, '')
    .replace(/^(?:(?:город|г\.?)\s*)?москва(?:\s*,\s*|\s+|$)/u, '').replace(/[\s,;]+$/, '');
  const match = /^(.*?)(?:,\s*|\s+)(?:(?:дом|д\.?)\s*)?(\d+[а-яa-z]?(?:\/\d+[а-яa-z]?)?(?:(?:\s*,?\s*)(?:корпус|корп\.?|к\.?|строение|строен\.?|стр\.?|с\.?)\s*\d+[а-яa-z]?){0,2})$/u.exec(address);
  const requestedStreet = match && street(match[1]), requestedHouse = match && house(match[2]);
  if (!requestedStreet || !requestedHouse) fail(400, 'INCOMPLETE_ADDRESS', 'Укажите московский адрес с улицей и номером дома.');
  return { street: requestedStreet, house: requestedHouse, query: 'Москва, ' + match[1].replace(/[,\s]+$/, '') + ', ' + requestedHouse.key,
    key: [requestedStreet.name, requestedStreet.kind, requestedHouse.key].join('|') };
}
function moscow(address) {
  const components = address.Components;
  if (text(address.country_code) !== 'ru' || !Array.isArray(components)) return false;
  const regions = components.filter(item => item?.kind === 'province' || item?.kind === 'locality').map(item => text(item.name));
  return !regions.includes('московская область') && regions.some(name => /^(?:(?:город|г\.?)\s*)?москва$/u.test(name));
}
function candidate(member, request) {
  const object = member?.GeoObject, metadata = object?.metaDataProperty?.GeocoderMetaData, address = metadata?.Address;
  // Reject near/range/number/street matches, even if their coordinates look valid.
  if (metadata?.kind !== 'house' || metadata.precision !== 'exact' || !address || !moscow(address)) return null;
  const components = address.Components;
  const streets = components.filter(item => item?.kind === 'street'), houses = components.filter(item => item?.kind === 'house');
  if (streets.length !== 1 || houses.length !== 1 || typeof object.Point?.pos !== 'string' || !/^\s*[+-]?\d+(?:\.\d+)?\s+[+-]?\d+(?:\.\d+)?\s*$/.test(object.Point.pos)) return null;
  // Yandex Point.pos is longitude first; the public contract remains latitude/longitude.
  const [longitude, latitude] = object.Point.pos.trim().split(/\s+/).map(Number);
  if (![latitude, longitude].every(Number.isFinite)) return null;
  if (longitude < MOSCOW_BOUNDS[0] || longitude > MOSCOW_BOUNDS[2] || latitude < MOSCOW_BOUNDS[1] || latitude > MOSCOW_BOUNDS[3]) return null;
  const foundStreet = street(streets[0].name), foundHouse = house(houses[0].name);
  if (!foundStreet || !foundHouse || request.street.name !== foundStreet.name || request.street.kind && request.street.kind !== foundStreet.kind) return null;
  // Never silently pick a corpus/building when the request names a different one.
  const exact = foundHouse.key === request.house.key;
  if (!exact && (request.house.suffix || request.house.base !== foundHouse.base || !foundHouse.suffix)) return null;
  const label = 'Москва, ' + String(streets[0].name).slice(0, 160) + ', ' + String(houses[0].name).slice(0, 40);
  return { label, point: { latitude, longitude }, exact, key: [foundStreet.name, foundStreet.kind, foundHouse.key, latitude.toFixed(6), longitude.toFixed(6)].join('|') };
}
function resultFromCollection(body, request) {
  const members = body?.response?.GeoObjectCollection?.featureMember;
  if (!Array.isArray(members) || members.length > 100) fail(502, 'GEOCODER_RESPONSE', 'Поиск адреса вернул некорректный ответ.');
  const seen = new Set(), candidates = [];
  for (const member of members) {
    const match = candidate(member, request);
    if (match && !seen.has(match.key)) { seen.add(match.key); candidates.push(match); }
  }
  const attribution = { ...ATTRIBUTION };
  if (!candidates.length) return { status: 'not_found', message: 'Точный дом в Москве не найден. Откройте адрес в Картах и проверьте его.', attribution };
  const visible = candidates.map(({ label, point }) => ({ label, point }));
  if (candidates.length === 1 && candidates[0].exact) return { status: 'ok', ...visible[0], attribution };
  return { status: 'needs_choice', candidates: visible, message: 'Выберите точный дом или строение.', attribution };
}

function createRequestQueue(options = {}) {
  const now = options.now || Date.now, sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let tail = Promise.resolve(), nextStart = 0;
  return task => {
    const operation = tail.catch(() => {}).then(async () => {
      const delay = Math.max(0, nextStart - now());
      if (delay) await sleep(delay);
      nextStart = now() + 1000;
      return task();
    });
    // The scheduler retains only completion, never the last geocoder result.
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
}
// Shared across resolver instances in this Node process, including failed requests.
const providerQueue = createRequestQueue();
async function readJson(response) {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > 256 * 1024) fail(502, 'GEOCODER_RESPONSE', 'Поиск адреса вернул некорректный ответ.');
  if (!response.body) fail(502, 'GEOCODER_RESPONSE', 'Поиск адреса вернул пустой ответ.');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) fail(502, 'GEOCODER_RESPONSE', 'Поиск адреса вернул некорректный ответ.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
  catch (_) { fail(502, 'GEOCODER_RESPONSE', 'Поиск адреса вернул некорректный ответ.'); }
}
function createRouteGeocoder(options = {}) {
  const fetcher = options.fetch || global.fetch, queue = options.queue || providerQueue;
  const timeout = Math.min(8000, Math.max(1, options.timeoutMs || 8000));
  // Only share work while a route is actively being prepared. No result cache or DB writes.
  const inflight = new Map();
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  async function request(parsed, key) {
    const url = endpoint(options.url);
    // apikey is sent only by this server request. Never return the URL/provider error text.
    url.search = new URLSearchParams({ apikey: key, geocode: parsed.query, lang: 'ru_RU', format: 'json',
      bbox: MOSCOW_BOUNDS.slice(0, 2).join(',') + '~' + MOSCOW_BOUNDS.slice(2).join(','), rspn: '1', results: '8' }).toString();
    const controller = new AbortController(); let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RouteGeocoderError(504, 'GEOCODER_TIMEOUT', 'Поиск адреса не ответил вовремя. Повторите попытку.')); }, timeout);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetcher(url.href, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', 'Accept-Language': 'ru', 'User-Agent': 'zamery-bot/1.0 (Moscow audit route lookup)' } });
        if (response.status === 401 || response.status === 403) fail(503, 'GEOCODER_CONFIG', 'Ключ Геокодера Яндекса не принят. Администратору нужно проверить подключение.');
        if (!response.ok) fail(502, 'GEOCODER_UNAVAILABLE', 'Поиск адреса временно недоступен. Повторите попытку.');
        return resultFromCollection(await readJson(response), parsed);
      })()]);
    } catch (error) {
      if (error instanceof RouteGeocoderError) throw error;
      if (controller.signal.aborted) fail(504, 'GEOCODER_TIMEOUT', 'Поиск адреса не ответил вовремя. Повторите попытку.');
      fail(502, 'GEOCODER_UNAVAILABLE', 'Поиск адреса временно недоступен. Повторите попытку.');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function geocode(address) {
    const parsed = parseAddress(address);
    const key = apiKey(options.apiKey === undefined ? process.env.YANDEX_GEOCODER_API_KEY : options.apiKey);
    if (!inflight.has(parsed.key)) {
      if (inflight.size >= 50) fail(429, 'GEOCODER_BUSY', 'Поиск адресов занят. Повторите попытку через несколько секунд.');
      const work = queue(() => request(parsed, key)).finally(() => { inflight.delete(parsed.key); });
      inflight.set(parsed.key, work);
    }
    return clone(await inflight.get(parsed.key));
  }
  return { geocode };
}
let defaultGeocoder;
function geocodeRouteAddress(address) { return (defaultGeocoder ||= createRouteGeocoder()).geocode(address); }

module.exports = { createRouteGeocoder, geocodeRouteAddress, RouteGeocoderError, createRequestQueue, parseAddress };
