import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { developmentRateLimitBypass } from './rateLimit.js';

const OTP_DIGITS = 6;
const DEFAULT_MAX_ATTEMPTS = 5;

function otpSecret() {
  return process.env.JWT_SECRET || 'fitlook-dev-secret';
}

function createOtpCode() {
  const fixedOtp = fixedOtpCode();
  if (fixedOtp) return fixedOtp;
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

function normalizeOtp(value = '') {
  const candidate = String(value || '').trim();
  return /^\d{6}$/.test(candidate) ? candidate : '';
}

function fixedOtpCode(env = process.env) {
  const code = normalizeOtp(env.OTP_FIXED_CODE);
  if (!code) return '';
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const provider = String(env.OTP_DELIVERY_PROVIDER || '').trim().toLowerCase();
  const allowProductionFixedOtp = ['1', 'true', 'yes', 'on'].includes(String(env.ALLOW_FIXED_OTP_IN_PRODUCTION || '').trim().toLowerCase());
  if (nodeEnv === 'production' && !allowProductionFixedOtp) return '';
  if (provider && provider !== 'mock' && provider !== 'disabled') return '';
  return code;
}

function otpDigest(purpose, otpSession, otp) {
  return createHmac('sha256', otpSecret())
    .update(`${purpose}:${otpSession}:${otp}`)
    .digest('hex');
}

function phoneScopeId(purpose, phone) {
  return createHmac('sha256', otpSecret())
    .update(`${purpose}:${phone}`)
    .digest('hex');
}

function secureDigestEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'hex');
  const rightBuffer = Buffer.from(String(right || ''), 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function createOtpChallenge({ sessions, currentSessions, purpose, phone, metadata = {}, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const otp = createOtpCode();
  const { id: otpSession } = await sessions.create({
    ...metadata,
    phone,
    purpose,
    otpHash: '',
    verified: false,
    attempts: 0,
    maxAttempts
  });

  await sessions.update(otpSession, (session) => ({
    ...session,
    otpHash: otpDigest(purpose, otpSession, otp)
  }));
  await currentSessions.create({ otpSession, phone }, phoneScopeId(purpose, phone));

  const session = await sessions.get(otpSession);
  return { otpSession, otp, expiresAt: session?.expiresAt };
}

async function currentSessionMatches({ currentSessions, purpose, phone, otpSession }) {
  const current = await currentSessions.get(phoneScopeId(purpose, phone));
  return Boolean(current && current.phone === phone && current.otpSession === otpSession);
}

async function removeCurrentSession({ currentSessions, purpose, phone }) {
  await currentSessions.remove(phoneScopeId(purpose, phone));
}

async function cancelOtpChallenge({ sessions, currentSessions, purpose, phone, otpSession }) {
  const session = await sessions.get(otpSession);
  if (!phone || !otpSession || !session || session.phone !== phone) return false;
  const isCurrent = await currentSessionMatches({ currentSessions, purpose, phone, otpSession });
  await sessions.remove(otpSession);
  if (isCurrent) await removeCurrentSession({ currentSessions, purpose, phone });
  return true;
}

async function rejectAttempt({ sessions, currentSessions, purpose, otpSession, session, message = 'Incorrect OTP' }) {
  const attempts = Number(session.attempts || 0) + 1;
  if (!developmentRateLimitBypass('DISABLE_AUTH_OTP_RATE_LIMITS') && attempts >= Number(session.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
    await sessions.remove(otpSession);
    await removeCurrentSession({ currentSessions, purpose, phone: session.phone });
    return { ok: false, status: 429, message: 'Too many incorrect OTP attempts. Please request a new code.' };
  }

  await sessions.set(otpSession, { ...session, attempts });
  return { ok: false, status: 400, message };
}

async function verifyOtpChallenge({ sessions, currentSessions, purpose, phone, otpSession, otp }) {
  const session = await sessions.get(otpSession);
  if (!phone || !otpSession || !session || session.phone !== phone) {
    return { ok: false, status: 400, message: 'Request a new OTP' };
  }

  if (!(await currentSessionMatches({ currentSessions, purpose, phone, otpSession }))) {
    return { ok: false, status: 400, message: 'Request a new OTP' };
  }

  if (session.expiresAt <= Date.now()) {
    await sessions.remove(otpSession);
    await removeCurrentSession({ currentSessions, purpose, phone });
    return { ok: false, status: 400, message: 'OTP expired. Request a new code' };
  }

  if (session.verified || !session.otpHash) {
    return { ok: false, status: 400, message: 'This OTP has already been used. Request a new code.' };
  }

  const normalizedOtp = normalizeOtp(otp);
  if (!normalizedOtp) {
    return rejectAttempt({
      sessions,
      currentSessions,
      purpose,
      otpSession,
      session,
      message: 'Enter the 6-digit OTP'
    });
  }

  if (!secureDigestEqual(session.otpHash, otpDigest(purpose, otpSession, normalizedOtp))) {
    return rejectAttempt({ sessions, currentSessions, purpose, otpSession, session });
  }

  const verifiedSession = {
    ...session,
    verified: true,
    verifiedAt: new Date().toISOString(),
    otpHash: '',
    attempts: 0
  };
  await sessions.set(otpSession, verifiedSession);
  return { ok: true, session: verifiedSession };
}

export {
  cancelOtpChallenge,
  createOtpChallenge,
  createOtpCode,
  currentSessionMatches,
  fixedOtpCode,
  normalizeOtp,
  otpDigest,
  phoneScopeId,
  removeCurrentSession,
  verifyOtpChallenge
};
