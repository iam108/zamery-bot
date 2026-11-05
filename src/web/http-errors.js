function asyncHandler(handler) {
  return function (req, res, next) {
    return Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error('web request failed:', error.code || error.name || 'error');
  const status = error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE' ? 413 :
    Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  const message = status === 413 ? 'Файл или запрос слишком большой.' :
    status < 500 ? 'Не удалось прочитать запрос. Проверьте данные и повторите.' :
      'Не удалось выполнить действие. Повторите попытку.';
  res.status(status).json({ ok: false, error: message });
}

module.exports = { asyncHandler, errorHandler };
