'use strict';

// Multer's fileSize limit is per file. Reserve bytes across the whole request
// before retaining a chunk, including files that are still being streamed.
function boundedMemoryStorage(options) {
  const totalBytes = options && options.totalBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error('A positive aggregate upload limit is required.');
  const states = new WeakMap();
  function changed(state) {
    state.peakBytes = Math.max(state.peakBytes, state.retainedBytes);
    if (typeof options.onChange === 'function') options.onChange({ retainedBytes: state.retainedBytes, peakBytes: state.peakBytes });
  }
  function uploadError(code) { return Object.assign(new Error(code === 'LIMIT_TOTAL_FILE_SIZE' ? 'Общий объём файлов превышает допустимый.' : 'Загрузка файлов прервалась.'), { code }); }
  function attachedFiles(req) {
    const files = Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
    return req.file ? files.concat(req.file) : files;
  }
  function removeBuffers(req, state) {
    for (const buffer of state.buffers) state.retainedBytes -= buffer.length;
    state.buffers.clear();
    for (const file of attachedFiles(req)) {
      if (!Buffer.isBuffer(file.buffer)) continue;
      delete file.buffer;
    }
    changed(state);
  }
  function fail(req, state, error) {
    state.error = state.error || error;
    // Finish every pending storage callback exactly once. Resuming the input
    // streams discards subsequent bytes instead of adding more buffers.
    for (const entry of [...state.active]) entry.finish(state.error);
    removeBuffers(req, state);
  }
  function detach(req, state) {
    req.removeListener('aborted', state.aborted);
    req.removeListener('error', state.requestError);
    req.removeListener('close', state.closed);
  }
  function stateFor(req) {
    if (!states.has(req)) {
      const state = { active: new Set(), buffers: new Set(), receivedBytes: 0, retainedBytes: 0, peakBytes: 0, error: null };
      state.aborted = () => fail(req, state, uploadError('UPLOAD_ABORTED'));
      state.requestError = () => fail(req, state, uploadError('UPLOAD_ABORTED'));
      state.closed = () => detach(req, state);
      req.once('aborted', state.aborted); req.once('error', state.requestError);
      req.once('close', state.closed);
      states.set(req, state);
    }
    return states.get(req);
  }
  return {
    _handleFile(req, file, callback) {
      const state = stateFor(req), stream = file.stream;
      if (state.error) { stream.resume(); callback(state.error); return; }
      let chunks = [], size = 0, finished = false;
      function discard() { state.retainedBytes -= size; chunks = []; size = 0; changed(state); }
      function detachStream() {
        stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('limit', limit); stream.removeListener('error', streamError);
      }
      const entry = { finish(error, fromStreamError = false) {
        if (finished) return;
        finished = true; state.active.delete(entry); detachStream();
        if (error) {
          discard(); stream.resume();
          // Multer has its own stream-error listener and decrements its pending
          // counter there; calling its callback too would decrement it twice.
          if (!fromStreamError) callback(error);
        } else {
          const buffer = Buffer.concat(chunks, size); chunks = []; state.buffers.add(buffer);
          callback(null, { buffer, size });
        }
      } };
      function data(chunk) {
        if (state.receivedBytes + chunk.length > totalBytes) { fail(req, state, uploadError('LIMIT_TOTAL_FILE_SIZE')); return; }
        state.receivedBytes += chunk.length; state.retainedBytes += chunk.length; size += chunk.length; chunks.push(chunk); changed(state);
      }
      function end() { entry.finish(state.error); }
      function limit() { fail(req, state, uploadError('LIMIT_FILE_SIZE')); }
      function streamError(error) { entry.finish(error, true); fail(req, state, error); }
      state.active.add(entry);
      stream.on('data', data); stream.once('end', end); stream.once('limit', limit);
      // Mark this entry finished before Multer's error listener can complete
      // the middleware and invoke cleanup for the request.
      stream.prependOnceListener('error', streamError);
    },
    _removeFile(req, file, callback) {
      const state = states.get(req), buffer = file.buffer;
      if (state && Buffer.isBuffer(buffer)) {
        // Multer copies file info into separate array/fields placeholders.
        // Removing only its uploadedFiles copy leaves the original aliased.
        if (state.buffers.delete(buffer)) state.retainedBytes -= buffer.length;
        for (const attached of attachedFiles(req)) if (attached.buffer === buffer) delete attached.buffer;
        changed(state);
      }
      delete file.buffer; callback(null);
    },
    cleanup(req, error) {
      const state = states.get(req);
      if (!state) return;
      fail(req, state, error || uploadError('UPLOAD_ABORTED'));
      // Keep the failed state for any remaining Busboy events in this tick.
      // WeakMap ownership releases it with the request, with no buffers retained.
    },
    complete(req) {
      const state = states.get(req);
      if (!state) return;
      detach(req, state); state.buffers.clear(); states.delete(req);
      // After successful parsing the handler owns req.files and its originals.
    },
  };
}

module.exports = { boundedMemoryStorage };
