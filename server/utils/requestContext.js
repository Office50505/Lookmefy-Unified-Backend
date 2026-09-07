import crypto from 'node:crypto';

const REQUEST_ID_HEADER = 'X-Request-Id';
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,120}$/;

function requestIdFromHeader(value = '') {
  const id = String(value || '').trim();
  return REQUEST_ID_PATTERN.test(id) ? id : '';
}

function createRequestId() {
  return `req_${crypto.randomUUID()}`;
}

function requestContext(req, res, next) {
  const requestId = requestIdFromHeader(req.get?.(REQUEST_ID_HEADER)) || createRequestId();
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}

export { REQUEST_ID_HEADER, createRequestId, requestContext, requestIdFromHeader };
