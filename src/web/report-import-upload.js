'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const multer = require('multer');

async function cleanupReportImport(req) {
  const work = req.reportImportWork;
  if (!work) return;
  if (work.cleanup) return work.cleanup;
  work.cleanup = Promise.resolve().then(async () => {
    for (const entry of [...work.active]) entry.abort(Object.assign(new Error('Импорт прерван.'), { code: 'UPLOAD_ABORTED' }));
    await Promise.allSettled([...work.closing]);
    if (work.directory) await fsp.rm(work.directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
  }).finally(() => {
    req.removeListener('aborted', work.abort); req.removeListener('error', work.abort);
    if (work.response && typeof work.response.removeListener === 'function') work.response.removeListener('close', work.responseClosed);
    work.release();
  });
  return work.cleanup;
}

function createReportImportUpload(options = {}) {
  const fileBytes = options.fileBytes || 50 * 1024 * 1024, maxFiles = options.maxFiles || 50;
  const sendError = options.sendError || ((req, res, message, status) => res.status(status).send(message));
  let active = false;
  const storage = {
    _handleFile(req, file, callback) {
      const work = req.reportImportWork, filename = randomUUID(), destination = work.directory, target = path.join(destination, filename);
      const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
      let finished = false, sourceFailed = false;
      const closed = new Promise(resolve => output.once('close', resolve)); work.closing.add(closed);
      closed.finally(() => { work.closing.delete(closed); work.active.delete(entry); });
      function detach() { file.stream.removeListener('limit', limit); file.stream.removeListener('error', sourceError); }
      function finish(error, sourceError = false) {
        if (finished) return;
        finished = true; detach();
        if (error) {
          file.stream.unpipe(output); file.stream.resume(); output.destroy();
          if (!sourceError) callback(error);
        } else callback(null, { destination, filename, path: target, size: output.bytesWritten });
      }
      const entry = { abort(error) { finish(error); } }; work.active.add(entry);
      function sourceError(error) { sourceFailed = true; finish(error, true); }
      function limit() { file.stream.unpipe(output); output.destroy(); if (!finished) { finished = true; detach(); callback(null, { destination, filename, path: target, size: output.bytesWritten }); } }
      output.once('error', error => finish(error, sourceFailed)); output.once('finish', () => finish());
      file.stream.once('limit', limit); file.stream.prependOnceListener('error', sourceError);
      if (work.aborted) entry.abort(Object.assign(new Error('Импорт прерван.'), { code: 'UPLOAD_ABORTED' }));
      else file.stream.pipe(output);
    },
    _removeFile(req, file, callback) { if (!file.path) return callback(); fs.unlink(file.path, error => callback(error && error.code !== 'ENOENT' ? error : null)); },
  };
  const parse = multer({ storage, limits: { fileSize: fileBytes, files: maxFiles, fields: 4, fieldSize: 64 * 1024, parts: maxFiles + 5 } }).array('files', maxFiles);
  return async function reportImportUpload(req, res, next) {
    if (active) { if (!req.destroyed) req.resume(); if (typeof res.set === 'function') res.set('Retry-After', '30'); return sendError(req, res, 'Другой импорт уже выполняется. Дождитесь его завершения и повторите загрузку.', 503); }
    active = true;
    let released = false;
    const work = req.reportImportWork = { active: new Set(), closing: new Set(), aborted: false, response: res,
      release() { if (!released) { released = true; active = false; } },
    };
    work.abort = () => { work.aborted = true; for (const entry of [...work.active]) entry.abort(Object.assign(new Error('Импорт прерван.'), { code: 'UPLOAD_ABORTED' })); };
    work.responseClosed = () => { if (!res.writableFinished) work.abort(); };
    req.once('aborted', work.abort); req.once('error', work.abort); if (typeof res.once === 'function') res.once('close', work.responseClosed);
    try {
      work.directory = await fsp.mkdtemp(path.join(options.parentDirectory || os.tmpdir(), 'zamery-report-import-')); await fsp.chmod(work.directory, 0o700);
      if (work.aborted) { await cleanupReportImport(req); return; }
      parse(req, res, error => {
        Promise.resolve().then(async () => {
          if (!error && !work.aborted) { next(); return; }
          await cleanupReportImport(req);
          if (!req.destroyed) req.resume();
          if (work.aborted || res.destroyed) return;
          const message = /^LIMIT_/.test(error && error.code || '') ? 'Можно загрузить до 50 файлов, каждый не больше 50 МБ. Проверьте выбранные файлы и поля формы.' : 'Не удалось загрузить файлы импорта. Повторите загрузку.';
          sendError(req, res, message, /^LIMIT_/.test(error && error.code || '') ? 413 : 400);
        }).catch(error => {
          console.error('import upload cleanup:', error.code || 'error'); work.release();
          if (!work.aborted && !res.destroyed) sendError(req, res, 'Не удалось завершить загрузку импорта. Повторите позже.', 503);
        });
      });
    } catch (error) {
      await cleanupReportImport(req).catch(cleanupError => console.error('import upload cleanup:', cleanupError.code || 'error'));
      if (!req.destroyed) req.resume();
      if (!work.aborted && !res.destroyed) sendError(req, res, 'Не удалось подготовить загрузку импорта. Повторите позже.', 503);
    }
  };
}

module.exports = { createReportImportUpload, cleanupReportImport };
