import jwt from 'jsonwebtoken';

const mediaAccessType = 'media-access';

function mediaTtlSeconds() {
  const value = Number(process.env.MEDIA_URL_TTL_SECONDS || 24 * 60 * 60);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 24 * 60 * 60;
}

function documentId(value) {
  if (!value) return '';
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id && value._id !== value) return documentId(value._id);
  if (typeof value.toString === 'function') return value.toString();
  return String(value);
}

function signMediaAccess({ scope, id, userId, kind = '', field = '' }) {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  const normalizedId = documentId(id);
  const normalizedUserId = documentId(userId);
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedField = String(field || '').trim().toLowerCase();
  if (!normalizedScope || !normalizedId || !normalizedUserId) return '';
  if (!process.env.JWT_SECRET) return '';
  return jwt.sign({
    type: mediaAccessType,
    scope: normalizedScope,
    id: normalizedId,
    userId: normalizedUserId,
    kind: normalizedKind,
    field: normalizedField
  }, process.env.JWT_SECRET, { expiresIn: mediaTtlSeconds() });
}

function mediaUrl(pathname, payload) {
  const token = signMediaAccess(payload);
  if (!token) return '';
  return `${pathname}?mediaToken=${encodeURIComponent(token)}`;
}

function tryOnMediaUrl({ kind = 'image', scope, id, userId }) {
  const normalizedKind = String(kind || 'image').toLowerCase();
  const normalizedScope = String(scope || '').toLowerCase();
  const normalizedId = documentId(id);
  const field = normalizedKind === 'garment' ? 'garment' : normalizedKind;
  return mediaUrl(`/api/tryons/${normalizedKind}/${normalizedScope}/${encodeURIComponent(normalizedId)}`, {
    scope: normalizedScope,
    id: normalizedId,
    userId,
    kind: normalizedKind,
    field
  });
}

function closetMediaUrl({ kind = 'item', id, userId }) {
  const normalizedKind = String(kind || '').toLowerCase();
  const normalizedId = documentId(id);
  return mediaUrl(`/api/closet/media/${normalizedKind}/${encodeURIComponent(normalizedId)}`, {
    scope: 'closet',
    id: normalizedId,
    userId,
    kind: normalizedKind,
    field: normalizedKind
  });
}

function profileMediaUrl(kind, id, userId) {
  const normalizedKind = String(kind || '').toLowerCase();
  const normalizedId = documentId(id);
  return mediaUrl(`/api/auth/media/${normalizedKind}/${encodeURIComponent(normalizedId)}`, {
    scope: 'profile',
    id: normalizedId,
    userId,
    kind: 'image',
    field: normalizedKind
  });
}

function mediaTokenFromRequest(req) {
  const queryToken = req.query?.mediaToken || req.query?.token || '';
  if (queryToken) return String(queryToken);
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function verifyMediaAccess(token, expected = {}) {
  try {
    if (!token || !process.env.JWT_SECRET) return null;
    const decoded = jwt.verify(String(token), process.env.JWT_SECRET);
    if (decoded?.type !== mediaAccessType) return null;
    for (const key of ['scope', 'id', 'kind', 'field']) {
      if (expected[key] === undefined || expected[key] === null || expected[key] === '') continue;
      if (String(decoded[key] || '').toLowerCase() !== String(expected[key]).toLowerCase()) return null;
    }
    const userId = documentId(decoded.userId);
    if (!userId) return null;
    return { ...decoded, userId };
  } catch {
    return null;
  }
}

export {
  closetMediaUrl,
  documentId,
  mediaTokenFromRequest,
  profileMediaUrl,
  tryOnMediaUrl,
  verifyMediaAccess
};
