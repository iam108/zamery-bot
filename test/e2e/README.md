Run the browser regression suite with Node.js 20 or newer:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The pinned Playwright and PGlite versions are development dependencies. Chromium must be installed once; the test run itself uses only a server bound to `127.0.0.1`, a temporary in-memory PostgreSQL database, generated images/PDFs, and fake Telegram, object storage and EGRN services. Browser requests outside the local server are blocked; the Telegram SDK is supplied by a local route fixture.

The browser cases cover:

- Android-sized Chromium: JPG/PNG/PDF uploads with a generic MIME type, real PDF page rendering, plan annotations, exact stored original bytes, and reopening an existing draft in fresh browser storage.
- The real manager form: a stale edit receives `409`; a lost successful acknowledgement retries the same fields and original file, preserves a newer manager's packet, and offers an explicit reload.
- A new manager document appearing during inspection: delivery stops until the auditor reviews the changed packet, with observations preserved.
- A failed sheet save or lost acknowledgement: the selected PDF page and visible graphic remain aligned through closing, zooming, retrying, reopening and restoring the previous sheet.
- Partial photo batches: successfully saved originals appear immediately; retrying the failed file, deleting a photo and adding another entrance preserve the correct files and subjects.
- A source upload finishing after a newer chooser selection, cancel/reopen or editor navigation: its original is retained without replacing the newer selection.
- A delayed manager PDF import after a newer sheet choice: the new sheet and geometry remain active, and the downloaded original stays selectable.
- A committed evidence POST with a lost acknowledgement: exact original hash recovery keeps notes typed during upload and avoids a false revision conflict.
- A confirmed attached-scheme deletion followed by a failed metadata save: the visible card clears immediately and retry saves the cleared reference.
- Telegram accepting a photo album before its acknowledgement is lost: reopening keeps the same durable attempt, ordinary retry is disabled, cancellation sends nothing, and explicit duplicate-risk consent repeats only that unknown album.

The supported “Other” category also has a complete browser case: optional legacy answers, nearby organizations and exact PNG/PDF originals survive fresh reopening; its general report uses the same durable delivery and explicit unknown-part retry. A changed manager category stops submission and opens source review, without redirect loops or invented alcohol checks.

The master case creates a new request in the manager form, uses its actual PDF in the auditor form, records photos and annotations, submits truthful findings, and assigns the same request to a lawyer through the handoff UI. It verifies every original's hash in the privately delivered ZIPs, intentional document deduplication, idempotent replay, and the actual workspace snapshot, note save/read and logout endpoints.

This is browser emulation, not a physical Android/Telegram test. It does not exercise real Telegram delivery, paid EGRN, Yandex Maps or production storage. Failed cases save synthetic screenshots under `test-results/e2e/` (override with `E2E_ARTIFACTS_DIR`). No application token or database URL is needed.
