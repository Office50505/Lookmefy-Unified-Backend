import { logger, redactString, requestId } from './logger.js';

function safeRequestPath(req) {
  const raw = String(req.originalUrl || req.url || '');
  if (!raw) return raw;
  try {
    const parsed = new URL(raw, 'http://lookmefy.local');
    for (const key of parsed.searchParams.keys()) {
      if (/password|token|secret|authorization|cookie|otp|signature|signed|client[_-]?secret/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return redactString(raw);
  }
}

function requestLogger(req, res, next) {
  const id = req.headers['x-request-id'] || requestId();
  const start = performance.now();
  let finished = false;
  req.id = String(id);
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    finished = true;
    const durationMs = Math.round(performance.now() - start);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http_request', {
      requestId: req.id,
      method: req.method,
      path: safeRequestPath(req),
      statusCode: res.statusCode,
      durationMs,
      userId: req.user?._id?.toString?.(),
      ip: req.ip
    });
  });

  res.on('close', () => {
    if (finished) return;
    const durationMs = Math.round(performance.now() - start);
    logger.warn('http_request_closed', {
      requestId: req.id,
      method: req.method,
      path: safeRequestPath(req),
      statusCode: res.statusCode,
      durationMs,
      userId: req.user?._id?.toString?.(),
      ip: req.ip
    });
  });

  next();
}

function errorLogger(error, req, res, _next) {
  logger.error('unhandled_request_error', {
    requestId: req.id,
    method: req.method,
    path: safeRequestPath(req),
    userId: req.user?._id?.toString?.(),
    error
  });
  if (res.headersSent) return;
  const statusCode = error.statusCode || 500;
  const message = statusCode >= 500 && process.env.NODE_ENV === 'production'
    ? 'Something went wrong'
    : error.message || 'Something went wrong';
  res.status(statusCode).json({ message });
}

export { errorLogger, requestLogger };
