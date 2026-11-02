import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FsrarClient } from './runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyUrl = 'http://fixie:TEST_PROXY_SECRET@54.173.229.123:80';
const keyFile = '/private/keys/api-fns-key';
const envelope = { http_status: 200, response: { items: [] }, attempted: true };

test('an explicit single-IP proxy is limited to the API helper child environment', async () => {
  const calls = [];
  const parent = { ...process.env };
  const client = new FsrarClient({ keyFile, proxyUrl, execute: async (...args) => {
    calls.push(args); return { stdout: JSON.stringify(envelope) };
  } });
  assert.deepEqual(await client.request('fsrar', { inn: '9705148570', kpp: '770501001' }), envelope);
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.ok(args[0].endsWith('api-network-helper.mjs'));
  assert.ok(args.includes('--key-file') && args.includes(keyFile));
  assert.ok(!args.some((arg) => /TEST_PROXY_SECRET|fixie:/u.test(arg)));
  assert.equal(new URL(options.env.FSRAR_PROXY_URL).hostname, '54.173.229.123');
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) {
    assert.ok(!Object.hasOwn(options.env, name), `${name} cannot bypass the pinned API route`);
  }
  assert.ok(Object.keys(parent).every((name) => parent[name] === process.env[name]) &&
    Object.keys(process.env).every((name) => parent[name] === process.env[name]), 'Parent environment must remain unchanged');
  assert.ok(!JSON.stringify(client).includes('TEST_PROXY_SECRET'), 'The client does not expose proxy credentials in object logging');
});

test('without an explicit proxy the API helper retains the operating system default route', async () => {
  let options;
  const client = new FsrarClient({ keyFile, execute: async (command, args, o) => {
    assert.equal(command,'python3');assert.ok(args[0].endsWith('network-helper.py'));
    options = o; return { stdout: JSON.stringify(envelope) };
  } });
  await client.request('stat');
  assert.ok(!Object.hasOwn(options, 'env'));
});

test('both API methods use the explicit route and no key or proxy secret is passed as an argument', async () => {
  const calls = [];
  const client = new FsrarClient({ keyFile, proxyUrl, execute: async (_command, args, options) => {
    calls.push({ args, options }); return { stdout: JSON.stringify(envelope) };
  } });
  await client.request('stat');
  await client.request('fsrar', { inn: '9705148570' });
  assert.equal(calls.length, 2);
  for (const { args, options } of calls) {
    assert.ok(options.env.FSRAR_PROXY_URL.includes('54.173.229.123'));
    assert.ok(!JSON.stringify(args).includes('TEST_PROXY_SECRET'));
    assert.equal(args[args.indexOf('--key-file') + 1], keyFile);
  }
  assert.ok(!calls[0].args.includes('--inn'));
});

test('only credentialed HTTP(S) proxies with pinned numeric IPv4 addresses are accepted', () => {
  for (const bad of [
    'http://fixie:TEST_PROXY_SECRET@cluster.usefixie.com:80',
    'socks5://fixie:TEST_PROXY_SECRET@54.173.229.123:1080',
    'http://54.173.229.123:80',
    'http://fixie@54.173.229.123:80',
    'http://fixie:TEST_PROXY_SECRET@[::1]:80',
    'http://fixie:TEST_PROXY_SECRET@999.1.2.3:80',
    'http://fixie:TEST_PROXY_SECRET@54.173.229.123/path',
    'http://fixie:TEST_PROXY_SECRET@54.173.229.123?secret=value',
    'http://fixie:TEST_PROXY_SECRET@54.173.229.123#fragment',
    'http://fixie:bad%zz@54.173.229.123:80',
  ]) {
    assert.throws(() => new FsrarClient({ keyFile, proxyUrl: bad }), (error) =>
      error.message === 'fsrar_proxy_invalid' && !error.message.includes('TEST_PROXY_SECRET'));
  }
  assert.throws(() => new FsrarClient({ keyFile, proxyUrl: 'https://fixie:TEST_PROXY_SECRET@54.173.229.123:443' }),/fsrar_proxy_invalid/u);
  assert.doesNotThrow(() => new FsrarClient({ keyFile, proxyUrl: 'https://fixie:TEST_PROXY_SECRET@54.173.229.123:443',proxyServerName:'criterium.usefixie.com' }));
});

test('execution failures and malformed helper output return a generic transport error', async () => {
  for (const execute of [async () => { throw new Error(`${proxyUrl} SECRET_API_KEY_FROM_STDERR`); },
    async () => ({ stdout: `invalid ${proxyUrl} SECRET_API_KEY_FROM_STDOUT` })]) {
    const client = new FsrarClient({ keyFile, proxyUrl, execute });
    const result = await client.request('stat');
    assert.deepEqual(result, { attempted: true, transport_error: 'fsrar_transport_error' });
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('Python redaction removes raw, percent-decoded and Basic-auth proxy secrets plus the API key', () => {
  const key = 'k'.repeat(40);
  const url = 'http://fixie:TEST%40PROXY%3ASECRET@54.173.229.123:80';
  const password = 'TEST@PROXY:SECRET';
  const basic = Buffer.from(`fixie:${password}`).toString('base64');
  const code = 'import importlib.util,json,sys; p=json.load(sys.stdin); s=importlib.util.spec_from_file_location("helper",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.redact(p["text"],p["key"],[p["proxy"]]))';
  const result = execFileSync('python3', ['-c', code, path.join(here, 'network-helper.py')], {
    input: JSON.stringify({ text: `${url} TEST%40PROXY%3ASECRET ${password} ${basic} ${key}`,
      key, proxy: url }), encoding: 'utf8' });
  for (const secret of [url, 'TEST%40PROXY%3ASECRET', password, basic, key]) assert.ok(!result.includes(secret));
  assert.ok(result.includes('[REDACTED_PROXY]') && result.includes('[REDACTED]'));
});

test('Python transport exception output cannot leak proxy credentials; the test performs no network request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'license-proxy-test-'));
  try {
    const secretFile = path.join(dir, 'api-key');
    await fs.writeFile(secretFile, 'x'.repeat(40), { mode: 0o600 });
    const code = `import importlib.util,json,sys,urllib.error
p=json.load(sys.stdin)
s=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class FakeOpener:
 def open(self,*a,**k):raise urllib.error.URLError(p['proxy'])
m.urllib.request.build_opener=lambda *a:FakeOpener()
sys.argv=['network-helper.py','--key-file',p['keyFile'],'--method','stat']
m.main()`;
    const result = JSON.parse(execFileSync('python3', ['-c', code, path.join(here, 'network-helper.py')], {
      input: JSON.stringify({ proxy: proxyUrl, keyFile: secretFile }), encoding: 'utf8',
      env: { ...process.env, HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl } }));
    assert.equal(result.attempted, true);
    assert.ok(result.transport_error.includes('[REDACTED_PROXY]'));
    assert.ok(!JSON.stringify(result).includes('TEST_PROXY_SECRET'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
