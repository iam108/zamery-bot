const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRouteGeocoder, createRequestQueue, parseAddress } = require('../src/web/route-geocoder');

// Synthetic addresses and a fake key only; every HTTP request is mocked.
const ADDRESS = 'Москва, Тестовая улица, 12';
const KEY = 'fixture-yandex-key-not-real';
const immediate = task => Promise.resolve().then(task);
function feature(properties = {}, pos = '37.6 55.75') {
  const p = { countrycode: 'RU', state: 'Москва', city: 'Москва', street: 'Тестовая улица', housenumber: '12', kind: 'house', precision: 'exact', ...properties };
  const components = p.components || [
    { kind: 'country', name: 'Россия' }, { kind: 'province', name: 'Центральный федеральный округ' },
    { kind: 'province', name: p.state }, { kind: 'locality', name: p.city },
    { kind: 'street', name: p.street }, { kind: 'house', name: p.housenumber }
  ].filter(item => item.name != null);
  return { GeoObject: {
    metaDataProperty: { GeocoderMetaData: { kind: p.kind, precision: p.precision,
      text: 'Россия, ' + ADDRESS, Address: { country_code: p.countrycode, formatted: ADDRESS, Components: components } } },
    name: 'Тестовая улица, 12', description: 'Москва, Россия', Point: { pos }
  } };
}
function json(features = [feature()]) {
  return new Response(JSON.stringify({ response: { GeoObjectCollection: {
    metaDataProperty: { GeocoderResponseMetaData: { request: ADDRESS, found: String(features.length), results: '8' } }, featureMember: features
  } } }), { headers: { 'content-type': 'application/json' } });
}
function mock(options = {}) {
  const calls = [];
  const resolver = createRouteGeocoder({ queue: immediate, apiKey: KEY, ...options, fetch: async (url, request) => {
    calls.push({ url: new URL(url), request });
    return options.respond ? options.respond(url, request, calls.length) : json(options.features);
  } });
  return { calls, geocode: resolver.geocode };
}

test('invalid addresses and GPS objects never reach the provider', async () => {
  const resolver = mock();
  for (const input of ['', '   ', 'x'.repeat(251), 'Москва\nТестовая 12', { latitude: 55.75, longitude: 37.6 }, '55.75,37.6', 'Москва, Тестовая улица', ADDRESS + ', GPS 55.75,37.6', ADDRESS + ', контакт +7 000 000 00 00', ADDRESS + ', кадастр 77:01:000001:1']) {
    await assert.rejects(resolver.geocode(input), error => error.status === 400);
  }
  assert.equal(resolver.calls.length, 0);
});

test('Yandex request stays server-side and Point.pos is converted from longitude/latitude', async () => {
  const resolver = mock();
  const result = await resolver.geocode(ADDRESS + ', этаж 1, комната 75');
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.point, { latitude: 55.75, longitude: 37.6 });
  assert.equal(result.label, ADDRESS);
  assert.deepEqual(result.attribution, { label: '© Яндекс', url: 'https://yandex.ru/maps/' });
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes('GeocoderResponseMetaData'), false);
  const { url, request } = resolver.calls[0];
  assert.equal(url.origin + url.pathname, 'https://geocode-maps.yandex.ru/v1/');
  assert.equal(url.searchParams.get('apikey'), KEY);
  assert.equal(url.searchParams.get('geocode'), 'Москва, тестовая улица, 12');
  assert.equal(url.searchParams.get('lang'), 'ru_RU');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('rspn'), '1');
  assert.equal(url.searchParams.get('bbox'), '36.75,55.1~38,56.1');
  assert.equal(url.searchParams.has('lat'), false);
  assert.equal(url.searchParams.has('lon'), false);
  assert.equal(url.searchParams.has('kind'), false); // kind is a reverse-geocoding parameter.
  assert.equal(request.redirect, 'error');
  assert.equal(request.signal instanceof AbortSignal, true);
});

test('missing or malformed key returns configuration status before any provider request', async () => {
  for (const apiKey of ['', '   ', null, 'short', 'key\nwith-control', 'https://example.test/key']) {
    const resolver = mock({ apiKey });
    await assert.rejects(resolver.geocode(ADDRESS), error => error.status === 503 && error.code === 'GEOCODER_CONFIG');
    assert.equal(resolver.calls.length, 0);
  }
});

test('key comes from the dedicated server environment setting when not injected', async () => {
  const previous = process.env.YANDEX_GEOCODER_API_KEY;
  try {
    process.env.YANDEX_GEOCODER_API_KEY = KEY;
    const resolver = mock({ apiKey: undefined });
    assert.equal((await resolver.geocode(ADDRESS)).status, 'ok');
    assert.equal(resolver.calls[0].url.searchParams.get('apikey'), KEY);
    delete process.env.YANDEX_GEOCODER_API_KEY;
    const missing = mock({ apiKey: undefined });
    await assert.rejects(missing.geocode(ADDRESS), error => error.code === 'GEOCODER_CONFIG');
    assert.equal(missing.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.YANDEX_GEOCODER_API_KEY;
    else process.env.YANDEX_GEOCODER_API_KEY = previous;
  }
});

test('house normalization preserves corpus, building and slash distinctions', async () => {
  for (const [query, provider] of [
    ['Москва, ул. Тестовая, д. 12, стр. 3', '12с3'],
    ['г. Москва, ул. Тестовая, д. 12с3', '12с3'],
    ['Россия, г. Москва, Тестовая улица, 12 корпус 2', '12к2'],
    ['ул. Тестовая, 12/2', '12/2'], ['Тестовая улица, 12A', '12а']
  ]) assert.equal((await mock({ features: [feature({ housenumber: provider })] }).geocode(query)).status, 'ok', query);
  const ordinal = mock({ features: [feature({ street: 'улица Тридцатилетия 1905 года' })] });
  assert.equal((await ordinal.geocode('Москва, улица Тридцатилетия 1905 года, 12')).status, 'ok');
  assert.equal(parseAddress('Тестовая улица, 12 стр. 3').house.key, '12с3');
});

test('ordinary city, house and corpus abbreviations match the exact Yandex building', async () => {
  for (const [query, housenumber] of [
    ['г Москва, ул. Тестовая, д 12', '12'],
    ['г.Москва,ул.Тестовая,д.12', '12'],
    ['г Москва, ул Тестовая, д 12, к. 2', '12к2'],
    ['Москва, Тестовая улица, дом 12 к 2', '12к2'],
    ['г Москва, ул Тестовая, д 12 с. 3', '12с3'],
    ['Москва,ул.Тестовая,д12к.2', '12к2']
  ]) {
    const resolver = mock({ features: [feature({ housenumber })] });
    const result = await resolver.geocode(query);
    assert.equal(result.status, 'ok', query);
    assert.deepEqual(result.point, { latitude: 55.75, longitude: 37.6 });
    assert.equal(resolver.calls[0].url.searchParams.get('geocode').endsWith(', ' + housenumber), true);
  }
});

test('numeric street names and streets entered without a type retain exact matching', async () => {
  const numeric = mock({ features: [feature({ street: 'улица 1905 года' })] });
  assert.equal((await numeric.geocode('г Москва, улица 1905 года, д 12')).status, 'ok');
  assert.equal(numeric.calls[0].url.searchParams.get('geocode'), 'Москва, улица 1905 года, 12');
  const short = mock({ features: [feature({ street: 'Мясницкая улица', housenumber: '15' })] });
  assert.equal((await short.geocode('Москва, Мясницкая, 15')).status, 'ok');
  assert.equal(short.calls[0].url.searchParams.get('geocode'), 'Москва, мясницкая, 15');
});

test('wrong house, street or explicitly requested corpus is never silently substituted', async () => {
  for (const properties of [{ housenumber: '13' }, { street: 'Другая улица' }, { street: 'Тестовый переулок' }, { housenumber: '12/2' }, { housenumber: '' }]) {
    assert.equal((await mock({ features: [feature(properties)] }).geocode(ADDRESS)).status, 'not_found');
  }
  for (const housenumber of ['12', '12к3', '12с2']) {
    assert.equal((await mock({ features: [feature({ housenumber })] }).geocode(ADDRESS + ' строение 3')).status, 'not_found');
  }
});

test('only house/exact metadata may produce a usable coordinate', async () => {
  for (const precision of ['number', 'near', 'range', 'street', 'other', undefined]) {
    assert.equal((await mock({ features: [feature({ precision })] }).geocode(ADDRESS)).status, 'not_found', String(precision));
  }
  for (const kind of ['street', 'locality', 'district', undefined]) {
    assert.equal((await mock({ features: [feature({ kind })] }).geocode(ADDRESS)).status, 'not_found');
  }
  for (const features of [[], [feature({ housenumber: undefined })], [feature({ street: undefined })]]) {
    assert.equal((await mock({ features }).geocode(ADDRESS)).status, 'not_found');
  }
});

test('unspecified corpus requires confirmation even for one exact provider result', async () => {
  for (const features of [[feature({ housenumber: '12с1' })], [feature({ housenumber: '12с1' }), feature({ housenumber: '12с2' }, '37.601 55.751')]]) {
    const result = await mock({ features }).geocode(ADDRESS);
    assert.equal(result.status, 'needs_choice');
    assert.equal(result.candidates.length, features.length);
    assert.equal('point' in result, false);
  }
});

test('multiple exact points remain a choice, while duplicate features do not add a step', async () => {
  const ambiguous = await mock({ features: [feature(), feature({}, '37.61 55.76')] }).geocode(ADDRESS);
  assert.equal(ambiguous.status, 'needs_choice');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal((await mock({ features: [feature(), feature()] }).geocode(ADDRESS)).status, 'ok');
});

test('street type must agree, and an omitted type cannot choose between two streets', async () => {
  const features = [feature(), feature({ street: 'Тестовая набережная' }, '37.61 55.76')];
  assert.equal((await mock({ features }).geocode('Москва, Тестовая, 12')).status, 'needs_choice');
  assert.equal((await mock({ features }).geocode(ADDRESS)).status, 'ok');
});

test('Russian country, Moscow components and Point.pos are independently validated', async () => {
  const bad = [
    feature({ countrycode: 'DE' }), feature({ countrycode: undefined }),
    feature({ city: 'Москва', state: 'Московская область' }), feature({ city: 'Казань', state: 'Татарстан' }),
    feature({ city: undefined, state: undefined }),
    feature({}, [37.6, 55.75]), feature({}, 'Infinity 55.75'), feature({}, '37.6 null'),
    feature({}, '55.75 37.6'), feature({}, '37.6 56.5'), feature({}, '37.6 55.75 0'),
    feature({}, '37.6.1 55.75'), null
  ];
  for (const item of bad) assert.equal((await mock({ features: [item] }).geocode(ADDRESS)).status, 'not_found');
  assert.equal((await mock({ features: [feature({ city: undefined })] }).geocode(ADDRESS)).status, 'ok');
});

test('requests cannot use another host, provider, path or redirect URL', async () => {
  for (const url of [
    'http://geocode-maps.yandex.ru/v1/', 'https://127.0.0.1/v1/', 'https://geocode-maps.yandex.ru.evil.test/v1/',
    'https://user:pass@geocode-maps.yandex.ru/v1/', 'https://geocode-maps.yandex.ru:444/v1/',
    'https://example.test/api/', 'https://geocode-maps.yandex.ru/1.x/',
    'https://geocode-maps.yandex.ru/v1/?apikey=private', 'https://geocode-maps.yandex.ru/v1/#other'
  ]) {
    const resolver = mock({ url });
    await assert.rejects(resolver.geocode(ADDRESS), error => error.code === 'GEOCODER_CONFIG');
    assert.equal(resolver.calls.length, 0);
  }
});

test('malformed, oversized and non-JSON responses fail without leaking provider details', async () => {
  for (const body of ['not json', '<html>Bad Gateway</html>', '{}', '{"features":[]}', JSON.stringify({ response: { GeoObjectCollection: { featureMember: Array(101).fill(null) } } })]) {
    await assert.rejects(mock({ respond: () => new Response(body) }).geocode(ADDRESS), error => error.status === 502 && error.code === 'GEOCODER_RESPONSE' && !error.message.includes(body));
  }
  await assert.rejects(mock({ respond: () => new Response(' '.repeat(256 * 1024 + 1)) }).geocode(ADDRESS), error => error.code === 'GEOCODER_RESPONSE');
  await assert.rejects(mock({ respond: () => new Response('{}', { headers: { 'content-length': '999999' } }) }).geocode(ADDRESS), error => error.code === 'GEOCODER_RESPONSE');
});

test('provider key errors and HTTP failures never expose URLs, key or provider messages', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const resolver = mock({ respond: url => new Response(JSON.stringify({ message: 'secret ' + url }), { status }) });
    await assert.rejects(resolver.geocode(ADDRESS), error => {
      assert.equal(error.status, status === 401 || status === 403 ? 503 : 502);
      assert.equal(error.code, status === 401 || status === 403 ? 'GEOCODER_CONFIG' : 'GEOCODER_UNAVAILABLE');
      assert.equal(String(error.stack).includes(KEY), false);
      assert.equal(String(error.stack).includes('apikey='), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    await assert.rejects(resolver.geocode(ADDRESS));
    assert.equal(resolver.calls.length, 2);
  }
  await assert.rejects(mock({ respond: url => { throw new Error(url); } }).geocode(ADDRESS), error => !String(error.stack).includes(KEY));
});

test('deadline rejects and aborts even a provider implementation that never settles', async () => {
  let signal;
  const resolver = mock({ timeoutMs: 15, respond: (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(resolver.geocode(ADDRESS), error => error.code === 'GEOCODER_TIMEOUT' && error.status === 504);
  assert.equal(signal.aborted, true);
});

test('concurrent normalized addresses share work, then results are discarded after completion', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const resolver = mock({ respond: async () => { await pending; return json(); } });
  const requests = [resolver.geocode(ADDRESS), resolver.geocode('г. Москва, ул. Тестовая, дом 12'), resolver.geocode(ADDRESS + ', этаж 2')];
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolver.calls.length, 1);
  finish();
  const results = await Promise.all(requests);
  results[0].point.latitude = 0;
  assert.equal(results[1].point.latitude, 55.75);
  assert.equal((await resolver.geocode(ADDRESS)).point.latitude, 55.75);
  assert.equal(resolver.calls.length, 2, 'Settled coordinates must not remain in a server cache.');
});

test('unresolved responses are not retained in a server cache', async () => {
  const resolver = mock({ features: [] });
  assert.equal((await resolver.geocode(ADDRESS)).status, 'not_found');
  await resolver.geocode(ADDRESS);
  assert.equal(resolver.calls.length, 2);
});

test('queued requests are serialized with at least one second between starts, including failures', async () => {
  let now = 10000, active = 0;
  const starts = [], queue = createRequestQueue({ now: () => now, sleep: async delay => { now += delay; } });
  const tasks = [0, 1, 2].map(index => queue(async () => {
    starts.push(now); active++; assert.equal(active, 1);
    await Promise.resolve(); active--;
    if (index === 1) throw new Error('temporary provider failure');
    return index;
  }));
  const results = await Promise.allSettled(tasks);
  assert.deepEqual(starts, [10000, 11000, 12000]);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 2);
});

test('default provider queue is shared by different resolver instances', async () => {
  const starts = [];
  const fetch = async () => { starts.push(Date.now()); return json(); };
  const a = createRouteGeocoder({ fetch, apiKey: KEY }), b = createRouteGeocoder({ fetch, apiKey: KEY });
  await Promise.all([a.geocode(ADDRESS), b.geocode(ADDRESS)]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 990, 'Two instances must not burst requests together.');
});
