'use strict';

// Synthetic provider body: only small chunks ever exist in memory. The child
// heap is smaller than both the PDF and its base64 JSON representation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readStatusResponse } = require('../../src/bot/egrn-source');

(async () => {
  const directory = await fs.mkdtemp(path.join(process.argv[2] || os.tmpdir(), 'egrn-stream-memory-test-'));
  const expected = createHash('sha256'), bytes = 300 * 1024 * 1024, chunkBytes = 48 * 1024;
  let result;
  async function* body() {
    yield Buffer.from('{"status":[{"file":"');
    for (let i = 0; i < bytes / chunkBytes; i++) {
      const chunk = Buffer.alloc(chunkBytes, (i * 31 + 7) % 251);
      if (!i) chunk.write('%PDF-1.7\n'); chunk.writeUInt32LE(i, 64); expected.update(chunk);
      yield Buffer.from(chunk.toString('base64'));
    }
    yield Buffer.from('"}],"id_req":77}');
  }
  try {
    result = await readStatusResponse(body(), { idReq: 77, root: directory });
    const docs = await result.documents('77:01:0000000:1'); assert.equal(docs.length, 1);
    const actual = createHash('sha256'); let received = 0;
    for await (const chunk of docs[0].open()) { received += chunk.length; actual.update(chunk); }
    const expectedHash = expected.digest('hex'), actualHash = actual.digest('hex');
    assert.equal(received, bytes); assert.equal(actualHash, expectedHash); assert.equal(docs[0].sha256, expectedHash);
    await result.cleanup(); result = null;
    assert.deepEqual(await fs.readdir(directory), []);
    process.stdout.write(JSON.stringify({ bytes: received, hashMatches: true, cleaned: true }));
  } finally { if (result) await result.cleanup(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(() => { process.stderr.write('The synthetic streaming fixture failed.\n'); process.exitCode = 1; });
