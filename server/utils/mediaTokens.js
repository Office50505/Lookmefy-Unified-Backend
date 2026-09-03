import jwt from 'jsonwebtoken';

const MEDIA_TOKEN_AUDIENCE = 'lookmefy-private-media';
const MEDIA_TOKEN_ISSUER = 'lookmefy-api';
const DEFAULT_MEDIA_TOKEN_TTL_SECONDS = 15 * 60;
const MIN_MEDIA_TOKEN_TTL_SECONDS = 60;
const MAX_MEDIA_TOKEN_TTL_SECONDS = 60 * 60;

function mediaTokenTtlSeconds(env = process.env) {
  const configured = Number(env.MEDIA_TOKEN_TTL_SECONDS || DEFAULT_MEDIA_TOKEN_TTL_SECONDS);
  if (!Number.isSafeInteger(configured)) return DEFAULT_MEDIA_TOKEN_TTL_SECONDS;
  return Math.min(Math.max(configured, MIN_MEDIA_TOKEN_TTL_SECONDS), MAX_MEDIA_TOKEN_TTL_SECONDS);
}

function mediaTokenSecret(env = process.env) {
  const secret = String(env.JWT_SECRET || '').trim();
  if (!secret) throw new Error('JWT_SECRET is required for private media access');
  return secret;
}

function signMediaToken({ userId, mediaId, kind }, { env = process.env } = {}) {
  const subject = String(userId || '').trim();
  const id = String(mediaId || '').trim();
  const mediaKind = String(kind || '').trim();
  if (!subject || !id || !mediaKind) throw new Error('Private media token claims are incomplete');
  return jwt.sign(
    { mediaId: id, kind: mediaKind, purpose: 'private-media' },
    mediaTokenSecret(env),
    {
      algorithm: 'HS256',
      audience: MEDIA_TOKEN_AUDIENCE,
      expiresIn: mediaTokenTtlSeconds(env),
      issuer: MEDIA_TOKEN_ISSUER,
      subject
    }
  );
}

function verifiedMediaClaims(token, env = process.env) {
  return jwt.verify(String(token || ''), mediaTokenSecret(env), {
    algorithms: ['HS256'],
    audience: MEDIA_TOKEN_AUDIENCE,
    issuer: MEDIA_TOKEN_ISSUER
  });
}

function verifyMediaToken(token, { mediaId, kind, env = process.env } = {}) {
  const decoded = verifiedMediaClaims(token, env);
  if (decoded?.purpose !== 'private-media') throw new Error('Invalid private media token');
  if (String(decoded.mediaId || '') !== String(mediaId || '')) throw new Error('Private media token does not match this media');
  if (String(decoded.kind || '') !== String(kind || '')) throw new Error('Private media token has the wrong scope');
  return decoded;
}

function signUserMediaToken(userId, options = {}) {
  const id = String(userId || '').trim();
  return signMediaToken({ userId: id, mediaId: id, kind: 'user-media' }, options);
}

function verifyUserMediaToken(token, { env = process.env } = {}) {
  const decoded = verifiedMediaClaims(token, env);
  if (decoded?.purpose !== 'private-media' || decoded?.kind !== 'user-media') {
    throw new Error('Invalid user media token');
  }
  if (!decoded.sub || String(decoded.mediaId || '') !== String(decoded.sub)) {
    throw new Error('Invalid user media token scope');
  }
  return decoded;
}

export {
  DEFAULT_MEDIA_TOKEN_TTL_SECONDS,
  MEDIA_TOKEN_AUDIENCE,
  MEDIA_TOKEN_ISSUER,
  mediaTokenTtlSeconds,
  signMediaToken,
  signUserMediaToken,
  verifyMediaToken,
  verifyUserMediaToken
};
