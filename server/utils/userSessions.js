import { createHash, randomBytes } from 'node:crypto';
import UserSession from '../models/UserSession.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_TOKEN_DAYS = 14;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function sessionHeartbeatMaxGapMs() {
  return positiveNumber(process.env.SESSION_HEARTBEAT_MAX_GAP_MS, 60_000);
}

export function sessionInactiveMs() {
  return positiveNumber(process.env.SESSION_INACTIVE_MS, 15 * 60_000);
}

export function hashSessionId(sessionId = '') {
  return createHash('sha256').update(String(sessionId)).digest('hex');
}

export function normalizeSessionPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://lookmefy.invalid');
    return parsed.pathname.slice(0, 200) || '/';
  } catch {
    return raw.split(/[?#]/)[0].slice(0, 200);
  }
}

export function sessionActivityIncrement(lastSeenAt, now = new Date(), maxGapMs = sessionHeartbeatMaxGapMs()) {
  const previous = new Date(lastSeenAt || 0).getTime();
  const current = new Date(now).getTime();
  const elapsed = current - previous;
  if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > sessionInactiveMs()) return 0;
  return Math.min(elapsed, maxGapMs);
}

export function sessionDisplayState(session, now = new Date()) {
  if (!session) return 'not_tracked';
  if (session.status === 'logged_out') return 'logged_out';
  if (session.status === 'revoked') return 'revoked';
  if (new Date(session.expiresAt || 0).getTime() <= new Date(now).getTime()) return 'expired';
  const idleMs = new Date(now).getTime() - new Date(session.lastSeenAt || session.loginAt || 0).getTime();
  if (idleMs > sessionInactiveMs()) return 'inactive';
  if (idleMs > 90_000) return 'recent';
  return 'online';
}

export function clientSummary(userAgent = '') {
  const value = String(userAgent || '').slice(0, 500);
  let deviceType = 'desktop';
  if (!value) deviceType = 'unknown';
  else if (/bot|crawler|spider|headless/i.test(value)) deviceType = 'bot';
  else if (/ipad|tablet|kindle|silk/i.test(value)) deviceType = 'tablet';
  else if (/mobile|iphone|ipod|android/i.test(value)) deviceType = 'mobile';

  let browser = 'Unknown';
  if (/edg\//i.test(value)) browser = 'Edge';
  else if (/firefox\//i.test(value)) browser = 'Firefox';
  else if (/chrome\//i.test(value)) browser = 'Chrome';
  else if (/safari\//i.test(value)) browser = 'Safari';

  let platform = 'unknown';
  if (/iphone|ipad|ipod/i.test(value)) platform = 'ios';
  else if (/android/i.test(value)) platform = 'android';
  else if (/macintosh|mac os x/i.test(value)) platform = 'macos';
  else if (/windows/i.test(value)) platform = 'windows';
  else if (/linux/i.test(value)) platform = 'linux';
  return { deviceType, platform, browser };
}

export async function createUserSession({ userId, authMethod, userAgent = '' }) {
  const sessionId = randomBytes(32).toString('hex');
  const now = new Date();
  const client = clientSummary(userAgent);
  await UserSession.create({
    user: userId,
    sessionHash: hashSessionId(sessionId),
    authMethod,
    loginAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + (SESSION_TOKEN_DAYS * DAY_MS)),
    ...client
  });
  return sessionId;
}

export async function findActiveUserSession({ userId, sessionId }) {
  if (!sessionId) return null;
  return UserSession.findOne({
    user: userId,
    sessionHash: hashSessionId(sessionId),
    status: 'active',
    expiresAt: { $gt: new Date() }
  });
}

export async function touchUserSession({ userId, sessionId, path = '', eventType = '' }) {
  if (!sessionId) return null;
  const now = new Date();
  const normalizedPath = normalizeSessionPath(path);
  const maxGapMs = sessionHeartbeatMaxGapMs();
  const activeCutoff = new Date(now.getTime() - sessionInactiveMs());
  const set = {
    activeDurationMs: {
      $add: [
        { $ifNull: ['$activeDurationMs', 0] },
        {
          $cond: [
            { $and: [{ $gt: ['$lastSeenAt', activeCutoff] }, { $lt: ['$lastSeenAt', now] }] },
            { $min: [{ $subtract: [now, '$lastSeenAt'] }, maxGapMs] },
            0
          ]
        }
      ]
    },
    lastSeenAt: now
  };
  if (normalizedPath) set.lastPath = normalizedPath;
  if (eventType) {
    set.eventCount = { $add: [{ $ifNull: ['$eventCount', 0] }, 1] };
    if (eventType === 'page_view') set.pageViewCount = { $add: [{ $ifNull: ['$pageViewCount', 0] }, 1] };
  }
  return UserSession.findOneAndUpdate(
    {
      user: userId,
      sessionHash: hashSessionId(sessionId),
      status: 'active',
      expiresAt: { $gt: now }
    },
    [{ $set: set }],
    { new: true }
  );
}

export async function endUserSession({ userId, sessionId, path = '' }) {
  const session = await touchUserSession({ userId, sessionId, path });
  if (!session) return null;
  const now = new Date();
  session.status = 'logged_out';
  session.logoutAt = now;
  session.endedAt = now;
  await session.save();
  return session;
}

export async function revokeUserSessions(userId) {
  const now = new Date();
  return UserSession.updateMany(
    { user: userId, status: 'active' },
    { $set: { status: 'revoked', endedAt: now } }
  );
}

export function sessionToAdmin(session, now = new Date()) {
  if (!session) return null;
  return {
    id: String(session._id),
    authMethod: session.authMethod,
    status: sessionDisplayState(session, now),
    storedStatus: session.status,
    loginAt: session.loginAt,
    lastSeenAt: session.lastSeenAt,
    logoutAt: session.logoutAt || null,
    endedAt: session.endedAt || null,
    expiresAt: session.expiresAt,
    activeDurationMs: Number(session.activeDurationMs || 0),
    pageViewCount: Number(session.pageViewCount || 0),
    eventCount: Number(session.eventCount || 0),
    lastPath: session.lastPath || '',
    deviceType: session.deviceType || 'unknown',
    platform: session.platform || 'unknown',
    browser: session.browser || 'Unknown'
  };
}
