Run the browser regression suite with Node.js 20 or newer:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The pinned Playwright and PGlite versions are development dependencies. Chromium must be installed once; the test run itself uses only a server bound to `127.0.0.1`, a temporary in-memory PostgreSQL database, generated images/PDFs, and fake Telegram, object storage and EGRN services. Browser requests outside the local server are blocked; the Telegram SDK is supplied by a local route fixture.

The three cases cover:

- Android-sized Chromium: JPG/PNG/PDF uploads with a generic MIME type, real PDF page rendering, plan annotations, exact stored original bytes, and reopening an existing draft in fresh browser storage.
- The real manager form: a stale edit receives `409`; a lost successful acknowledgement retries the same fields and original file, preserves a newer manager's packet, and offers an explicit reload.
- A new manager document appearing during inspection: delivery stops until the auditor reviews the changed packet, with observations preserved.

This is browser emulation, not a physical Android/Telegram test. It does not exercise real Telegram delivery, paid EGRN, Yandex Maps or production storage. Failed cases save synthetic screenshots under `test-results/e2e/` (override with `E2E_ARTIFACTS_DIR`). No application token or database URL is needed.
