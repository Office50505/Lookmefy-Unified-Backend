import bcrypt from 'bcryptjs';
import express from 'express';
import heicConvert from 'heic-convert';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CreditEvent from '../models/CreditEvent.js';
import CustomTryOn from '../models/CustomTryOn.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import Job from '../models/Job.js';
import TokenOrder from '../models/TokenOrder.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import { getRedisClient, keyPrefix, ttlSeconds, withTimeout } from '../utils/cache.js';
import { userDevModeControlsEnabled } from '../utils/devMode.js';
import { normalizeGenderPreference } from '../utils/genderPreference.js';
import { logger } from '../utils/logger.js';
import { mediaTokenFromRequest, verifyMediaAccess } from '../utils/mediaAccess.js';
import { deleteStoredFile, isStorageConfigurationError, readStoredFile, saveStoredFile } from '../utils/storage.js';

const router = express.Router();
const avifExtensions = new Set(['.avif']);
const avifMimeTypes = new Set(['image/avif', 'image/x-avif']);
const heicExtensions = new Set(['.heic', '.heif']);
const heicMimeTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const pendingOtps = new Map();
const otpFailureBlocks = new Map();
const msg91OtpUrl = 'https://control.msg91.com/api/v5/otp';
const otpPurposes = new Set(['signup', 'password-reset']);

function profileImageModel() {
  return process.env.FAL_PROFILE_IMAGE_MODEL || process.env.FAL_TRYON_MODEL || 'openai/gpt-image-2/edit';
}

function shouldGenerateFullBodyProfile() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.PROFILE_FULL_BODY_GENERATION ?? 'true').toLowerCase());
}

function shouldGenerateFullBodyProfileForRequest(req) {
  const mode = String(req.body?.profilePhotoMode || 'ai-full-body').toLowerCase();
  return shouldGenerateFullBodyProfile() && mode !== 'exact';
}

function extensionForFile(file) {
  return path.extname(file.originalname || file.filename || '').toLowerCase();
}

function extensionForMimetype(mimetype) {
  if (mimetype?.includes('png')) return '.png';
  if (mimetype?.includes('webp')) return '.webp';
  if (mimetype?.includes('gif')) return '.gif';
  return '.jpg';
}

function imageMimeTypeFromBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 12) === 'ftypavif') return 'image/avif';
  return '';
}

function imageMimeTypeFromResponse(response, bytes) {
  const declared = response.headers.get('content-type') || '';
  if (declared.startsWith('image/')) return declared.split(';')[0];
  return imageMimeTypeFromBuffer(bytes) || declared || 'image/png';
}

function isHeicUpload(file) {
  return heicMimeTypes.has(String(file.mimetype || '').toLowerCase()) || heicExtensions.has(extensionForFile(file));
}

function isAvifUpload(file) {
  return avifMimeTypes.has(String(file.mimetype || '').toLowerCase()) || avifExtensions.has(extensionForFile(file));
}

function isAvifBuffer(bytes) {
  return imageMimeTypeFromBuffer(bytes) === 'image/avif';
}

function isAllowedImageUpload(file) {
  return String(file.mimetype || '').startsWith('image/') || isHeicUpload(file) || isAvifUpload(file);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, isAllowedImageUpload(file));
  }
});

function readableProviderError(value, fallback = 'Profile image generation failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
  if (Array.isArray(value)) return value.map((item) => readableProviderError(item, fallback)).filter(Boolean).join(' ') || fallback;
  if (typeof value === 'object') {
    const nested = value.message || value.detail || value.error || value.errors;
    if (nested && nested !== value) return readableProviderError(nested, fallback);
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

function falHeaders() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is missing on the server');
  return {
    Authorization: `Key ${process.env.FAL_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function falJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...falHeaders(), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableProviderError(data.detail || data.error || data.message || data, 'FAL profile image request failed'));
  return data;
}

async function waitForFalProfileResult(submission) {
  const statusUrl = submission.status_url;
  const responseUrl = submission.response_url;
  if (!statusUrl || !responseUrl) throw new Error('FAL did not return queue URLs');

  const maxAttempts = Number(process.env.FAL_PROFILE_POLL_ATTEMPTS || 120);
  const pollMs = Number(process.env.FAL_PROFILE_POLL_MS || 1500);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await falJson(statusUrl);
    if (status.status === 'COMPLETED') return falJson(responseUrl);
    if (status.status === 'FAILED' || status.error) throw new Error(readableProviderError(status.error || status, 'FAL profile image generation failed'));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`FAL profile image generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
}

function firstGeneratedImageUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) || /^data:image\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstGeneratedImageUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'image_url', 'imageUrl']) {
    const found = firstGeneratedImageUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['images', 'image', 'output', 'result', 'data']) {
    const found = firstGeneratedImageUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = firstGeneratedImageUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

async function generatedBytesFromUrl(url) {
  if (/^data:image\//i.test(url)) {
    const [, metadata = '', base64 = ''] = url.match(/^data:([^;]+);base64,(.+)$/i) || [];
    if (!base64) throw new Error('Generated profile image data URI was invalid');
    const bytes = Buffer.from(base64, 'base64');
    return { bytes, mimetype: metadata || imageMimeTypeFromBuffer(bytes) || 'image/png' };
  }

  const response = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy profile image fetcher'
    }
  });
  if (!response.ok) throw new Error('Could not download generated profile image');
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mimetype: imageMimeTypeFromResponse(response, bytes) };
}

function fullBodyProfilePrompt() {
  return [
  "Create one photorealistic, full-body, head-to-toe ecommerce body reference image using the uploaded person as the only identity source. This image will be used for a virtual clothing try-on app.",
"ABSOLUTE FACE RULE: The face must be treated as fixed reference data, not something to regenerate or interpret. Do not redesign, beautify, smooth, slim, age, de-age, re-face, symmetrize, or in any way 'improve' the face. Preserve exactly: face shape, eye shape, eyelid type, eye spacing, gaze direction, eyebrow shape, nose shape, lip shape, natural (unforced) expression, jawline, chin, cheekbones, ears, hairline, hairstyle, hair color and texture, natural skin tone, and visible skin texture including pores and any marks, moles, freckles, or asymmetries. The generated face must be instantly and unmistakably recognizable as the exact same person from the uploaded image, not a smoothed or idealized version of them.",
"IDENTITY PRIORITY OVER POSE: Do not invent a new perfectly front-facing version of the face. If the uploaded face is tilted, angled, three-quarter, or slightly turned, preserve that exact same head angle, facial structure, eye shape, eyelids, and natural head character from the uploaded photo. The body should become a clean catalog standing pose, but the head and face must retain their original angle and character even if it creates slight asymmetry with the body. Exact identity, skin texture, and expression preservation are more important than perfect pose symmetry or a 'cleaner' looking face.",
"BODY & POSE: Exactly one person, complete full body visible from top of head to soles of feet. Straight, relaxed standing pose, body mostly squared to the camera, arms relaxed at the sides, both hands and all fingers visible and anatomically correct, feet slightly apart, weight evenly balanced. If the reference is a selfie, cropped portrait, or half-body photo, infer only the missing body below the visible region, consistent with the person's visible build, apparent age, and skin tone — the body may be inferred, but the face must never be altered or reinterpreted to accommodate this. No cropping at the head, shoulders, arms, hands, waist, hips, knees, ankles, or feet.",
"REALISM REQUIREMENTS: The image must look like a real photograph taken in a studio, not a CGI render, 3D model, or AI-smoothed image. Retain natural skin texture (visible pores, natural texture variation) rather than plastic or waxy-looking skin. Render fabric with realistic folds, weight, and drape rather than a flat painted-on look. Maintain anatomically correct proportions and natural joint positions. Sharp focus throughout the image, no soft-focus or glamour-style blur.",
"CLOTHING & SCENE: Simple fitted neutral clothing: plain fitted t-shirt and plain fitted pants in solid neutral colors, plain simple shoes. Clean even studio lighting, soft natural shadows, sharp focus, realistic true-to-life skin rendering. Plain seamless neutral background, light gray or off-white.",
"DO NOT: Do not modify, beautify, smooth, or reinterpret the face, eyes, eyelids, eyebrows, expression, smile, hairstyle, skin tone, skin texture, or identity in any way. Do not add logos, text, watermarks, accessories, jewelry, hats, sunglasses, bags, or props. No extra people, mirrors, reflections, or duplicated or extra limbs. No stylization, cartoon, illustration, CGI look, or beauty filters. Output must be photorealistic, modest, non-sexualized, and suitable as an ecommerce body reference."  
].join(' ');
}

async function generateFullBodyProfilePhoto(file) {
  if (!shouldGenerateFullBodyProfile()) return file;

  const stored = file.buffer
    ? { bytes: file.buffer, mimetype: file.mimetype || 'image/jpeg', filename: file.filename }
    : await readStoredFile(file);
  const inputBuffer = stored.bytes;
  const inputDataUri = `data:${stored.mimetype || file.mimetype || 'image/jpeg'};base64,${inputBuffer.toString('base64')}`;
  const model = profileImageModel();
  const submission = await falJson(`https://queue.fal.run/${model}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt: fullBodyProfilePrompt(),
      image_urls: [inputDataUri],
      image_size: { width: 1024, height: 1536 },
      quality: process.env.FAL_PROFILE_IMAGE_QUALITY || process.env.FAL_IMAGE_QUALITY || 'low',
      num_images: 1,
      output_format: 'png'
    })
  });
  const result = await waitForFalProfileResult(submission);
  const generatedUrl = firstGeneratedImageUrl(result);
  if (!generatedUrl) throw new Error('FAL did not return a generated full-body profile image');

  const { bytes, mimetype } = await generatedBytesFromUrl(generatedUrl);
  const filename = `profile-fullbody-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionForMimetype(mimetype)}`;
  return {
    ...file,
    filename,
    buffer: bytes,
    mimetype,
    size: bytes.length
  };
}

function isBodyPhotoPreparationError(error) {
  const message = error?.message || '';
  return message.includes('HEIC/HEIF') || /FAL|profile image|full-body profile/i.test(message);
}

async function normalizeBodyPhotoUpload(file) {
  if (!file?.buffer) throw new Error('Profile photo data is missing');
  if (!isHeicUpload(file) && !isAvifUpload(file) && !isAvifBuffer(file.buffer)) {
    return {
      ...file,
      size: file.size || file.buffer.length
    };
  }

  try {
    const outputBuffer = isAvifUpload(file) || isAvifBuffer(file.buffer)
      ? await sharp(file.buffer).jpeg({ quality: 90 }).toBuffer()
      : Buffer.from(await heicConvert({
        buffer: file.buffer,
        format: 'JPEG',
        quality: 0.9
      }));

    return {
      ...file,
      filename: `${path.parse(file.originalname || file.filename || 'profile-photo').name}.jpg`,
      buffer: outputBuffer,
      mimetype: 'image/jpeg',
      size: outputBuffer.length
    };
  } catch (error) {
    throw new Error('Could not convert the AVIF/HEIC/HEIF profile photo. Please try another image.');
  }
}

async function saveProfileUpload(normalized, { user, folder, prefix, extra = {} } = {}) {
  const stored = await saveStoredFile({
    buffer: normalized.buffer,
    filename: normalized.filename,
    mimetype: normalized.mimetype,
    userId: user?._id?.toString?.(),
    folder,
    prefix
  });
  return {
    ...stored,
    ...extra
  };
}

async function avatarPhotoFromNormalized(normalized, { user } = {}) {
  let avatar = normalized;
  try {
    const buffer = await sharp(normalized.buffer)
      .rotate()
      .resize({ width: 640, height: 640, fit: 'cover', position: 'north' })
      .jpeg({ quality: 90 })
      .toBuffer();
    avatar = {
      ...normalized,
      buffer,
      filename: `${path.parse(normalized.originalname || normalized.filename || 'profile-photo').name}-avatar.jpg`,
      mimetype: 'image/jpeg',
      size: buffer.length
    };
  } catch {
    avatar = normalized;
  }

  return saveProfileUpload(avatar, {
    user,
    folder: 'profile/avatar',
    prefix: 'avatar',
    extra: {
      source: 'upload',
      uploadedAt: new Date()
    }
  });
}

async function bodyPhotoFromNormalized(normalized, { generateFullBody = true, user } = {}) {
  const stored = await saveProfileUpload(normalized, {
    user,
    folder: 'profile',
    prefix: 'profile-upload'
  });
  return {
    ...stored,
    status: generateFullBody ? 'generating' : 'ready',
    source: generateFullBody ? 'upload' : 'exact-upload'
  };
}

async function profilePhotosFromUpload(file, { generateFullBody = true, user } = {}) {
  const normalized = await normalizeBodyPhotoUpload(file);
  const [avatarPhoto, bodyPhoto] = await Promise.all([
    avatarPhotoFromNormalized(normalized, { user }),
    bodyPhotoFromNormalized(normalized, { generateFullBody, user })
  ]);
  return { avatarPhoto, bodyPhoto };
}

async function generateFullBodyProfileInBackground(userId, sourceBodyPhoto, { enabled = true } = {}) {
  if (!enabled || !shouldGenerateFullBodyProfile()) return;

  setImmediate(async () => {
    try {
      console.log('[profile-fullbody] start', { userId: userId.toString(), source: sourceBodyPhoto.path });
      const generated = await generateFullBodyProfilePhoto(sourceBodyPhoto);
      const stored = await saveStoredFile({
        buffer: generated.buffer,
        filename: generated.filename,
        mimetype: generated.mimetype,
        userId: userId.toString(),
        folder: 'profile',
        prefix: 'profile-fullbody'
      });
      const generatedBodyPhoto = {
        ...stored,
        status: 'ready',
        source: 'fal-full-body',
        generatedAt: new Date()
      };
      const generatedAvatarPhoto = {
        filename: stored.filename,
        path: stored.path,
        url: stored.url,
        storage: stored.storage,
        mimetype: stored.mimetype,
        size: stored.size,
        source: 'fal-full-body',
        uploadedAt: new Date()
      };

      const updated = await User.findOneAndUpdate(
        { _id: userId, 'bodyPhoto.path': sourceBodyPhoto.path },
        { $set: { bodyPhoto: generatedBodyPhoto, avatarPhoto: generatedAvatarPhoto }, $unset: { avatarCrop: '' } },
        { new: true }
      );

      if (updated) {
        await deleteStoredFile(sourceBodyPhoto).catch(() => {});
        console.log('[profile-fullbody] done', { userId: userId.toString(), path: generatedBodyPhoto.path });
      } else {
        await deleteStoredFile(stored).catch(() => {});
        console.log('[profile-fullbody] skipped stale result', { userId: userId.toString() });
      }
    } catch (error) {
      const message = readableProviderError(error, 'Could not generate full-body profile image');
      await User.findOneAndUpdate(
        { _id: userId, 'bodyPhoto.path': sourceBodyPhoto.path },
        { $set: { 'bodyPhoto.status': 'failed', 'bodyPhoto.error': message } }
      );
      console.error('[profile-fullbody] failed', { userId: userId.toString(), error: message });
    }
  });
}

function sign(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '14d' });
}

function signAuthActionToken({ phone, purpose }) {
  return jwt.sign({ phone, purpose, type: 'auth-action' }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

function verifyAuthActionToken(token, purpose) {
  try {
    const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (decoded?.type !== 'auth-action' || decoded?.purpose !== purpose || !decoded?.phone) return '';
    return normalizePhone(decoded.phone);
  } catch {
    return '';
  }
}

function disableResponseCache(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
}

async function clearCustomTryOnAvatar(user) {
  if (user.avatarPhoto?.source !== 'custom-try-on') return;
  user.avatarPhoto = undefined;
  await user.save();
}

function normalizeUsername(value = '') {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeAvatarCropInput(value = {}) {
  const source = value?.avatarCrop && typeof value.avatarCrop === 'object' ? value.avatarCrop : value;
  return {
    scale: clampNumber(source.scale, 0.8, 5, 1),
    translateX: clampNumber(source.translateX ?? source.x, -160, 160, 0),
    translateY: clampNumber(source.translateY ?? source.y, -160, 160, 0),
    updatedAt: new Date()
  };
}

function normalizePhone(value = '') {
  const trimmed = String(value || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function normalizeOtpPurpose(value = '') {
  const purpose = String(value || 'signup').trim().toLowerCase();
  return otpPurposes.has(purpose) ? purpose : 'signup';
}

function otpKey(phone, purpose = 'signup') {
  return `${normalizeOtpPurpose(purpose)}:${phone}`;
}

function pendingOtpStorageKey(key) {
  return `${keyPrefix()}:auth:otp:${key}`;
}

function pendingOtpIsExpired(pending) {
  return !pending || Number(pending.expiresAt) <= Date.now();
}

async function getPendingOtp(key) {
  const redis = await getRedisClient();
  if (redis) {
    const raw = await withTimeout(redis.get(pendingOtpStorageKey(key))).catch(() => '');
    if (!raw) return null;
    try {
      const pending = JSON.parse(raw);
      if (pendingOtpIsExpired(pending)) {
        pendingOtps.delete(key);
        await withTimeout(redis.del(pendingOtpStorageKey(key))).catch(() => {});
        return null;
      }
      pendingOtps.set(key, pending);
      return pending;
    } catch {
      pendingOtps.delete(key);
      await withTimeout(redis.del(pendingOtpStorageKey(key))).catch(() => {});
      return null;
    }
  }

  const local = pendingOtps.get(key);
  if (local && !pendingOtpIsExpired(local)) return local;
  if (local) pendingOtps.delete(key);
  return null;
}

async function setPendingOtp(key, pending) {
  pendingOtps.set(key, pending);
  const redis = await getRedisClient();
  if (!redis) return;
  const ttlMs = Math.max(1000, Number(pending.expiresAt) - Date.now());
  await withTimeout(redis.set(pendingOtpStorageKey(key), JSON.stringify(pending), { EX: ttlSeconds(ttlMs) })).catch(() => {});
}

async function deletePendingOtp(key) {
  pendingOtps.delete(key);
  const redis = await getRedisClient();
  if (redis) await withTimeout(redis.del(pendingOtpStorageKey(key))).catch(() => {});
}

function validatePassword(password = '') {
  const value = String(password || '');
  if (value.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Use at least one letter and one number in your password';
  return '';
}

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function otpFailureConfig() {
  return {
    max: positiveEnvNumber('AUTH_OTP_FAILURE_MAX', 5),
    windowMs: positiveEnvNumber('AUTH_OTP_FAILURE_WINDOW_MS', 10 * 60 * 1000),
    blockMs: positiveEnvNumber('AUTH_OTP_FAILURE_BLOCK_MS', 15 * 60 * 1000)
  };
}

function otpBlockedUntil(phone) {
  const current = otpFailureBlocks.get(phone);
  const now = Date.now();
  if (!current) return 0;
  if (current.blockedUntil > now) return current.blockedUntil;
  if (current.expiresAt <= now) otpFailureBlocks.delete(phone);
  return 0;
}

function recordOtpFailure(phone) {
  const now = Date.now();
  const config = otpFailureConfig();
  const current = otpFailureBlocks.get(phone);
  const next = current && current.expiresAt > now
    ? current
    : { count: 0, expiresAt: now + config.windowMs, blockedUntil: 0 };
  next.count += 1;
  if (next.count >= config.max) {
    next.blockedUntil = now + config.blockMs;
    next.expiresAt = next.blockedUntil;
  }
  otpFailureBlocks.set(phone, next);
  return next.blockedUntil > now ? next.blockedUntil : 0;
}

function clearOtpFailures(phone) {
  otpFailureBlocks.delete(phone);
}

function sendOtpBlocked(res, blockedUntil) {
  const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).json({ message: 'Too many failed OTP attempts. Please try again later.' });
}

function exposeOtpForCurrentBuild() {
  return parseBoolean(process.env.AUTH_OTP_EXPOSE);
}

function generateOtp() {
  const fixed = exposeOtpForCurrentBuild() ? String(process.env.AUTH_FIXED_OTP || '').trim() : '';
  if (/^\d{4,8}$/.test(fixed)) return fixed;
  return String(randomInt(100000, 1000000));
}

function otpExpiryMinutes() {
  return Math.max(1, Math.round(positiveEnvNumber('AUTH_OTP_EXPIRY_MINUTES', 10)));
}

function otpExpiryMs() {
  return otpExpiryMinutes() * 60 * 1000;
}

function msg91Config() {
  const authKey = String(process.env.MSG91_AUTH_KEY || '').trim();
  const templateId = String(process.env.MSG91_TEMPLATE_ID || '').trim();
  const senderId = String(process.env.MSG91_SENDER_ID || '').trim();
  if (!authKey || !templateId) return null;
  return { authKey, templateId, senderId };
}

function msg91Mobile(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function readableMsg91Error(data, fallback = 'MSG91 OTP send failed') {
  if (!data) return fallback;
  if (typeof data === 'string') return data || fallback;
  if (typeof data === 'object') {
    const nested = data.message || data.error || data.detail || data.description;
    if (nested) return readableMsg91Error(nested, fallback);
  }
  return fallback;
}

async function sendMsg91Otp(phone, otp) {
  const config = msg91Config();
  if (!config) {
    throw new Error('OTP service is not configured. Check MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.');
  }

  const params = new URLSearchParams({
    template_id: config.templateId,
    mobile: msg91Mobile(phone),
    authkey: config.authKey,
    otp,
    otp_expiry: String(otpExpiryMinutes()),
    otp_length: String(otp.length)
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveEnvNumber('MSG91_TIMEOUT_MS', 10000));

  try {
    const response = await fetch(`${msg91OtpUrl}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: config.authKey
      },
      body: JSON.stringify({}),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }

    if (!response.ok || String(data?.type || '').toLowerCase() === 'error') {
      throw new Error(readableMsg91Error(data, `MSG91 OTP send failed (${response.status})`));
    }

    return { provider: 'msg91', data };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('MSG91 OTP send timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyMsg91Otp(phone, otp) {
  const config = msg91Config();
  if (!config) {
    throw new Error('OTP service is not configured. Check MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.');
  }

  const params = new URLSearchParams({
    mobile: msg91Mobile(phone),
    otp
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveEnvNumber('MSG91_TIMEOUT_MS', 10000));

  try {
    const response = await fetch(`${msg91OtpUrl}/verify?${params.toString()}`, {
      method: 'GET',
      headers: { authkey: config.authKey },
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }

    const message = String(data?.message || '').toLowerCase();
    const type = String(data?.type || '').toLowerCase();
    const verified = type === 'success' || message.includes('verified success');
    if (!response.ok || !verified) {
      const error = new Error(readableMsg91Error(data, response.ok ? 'Invalid OTP' : `MSG91 OTP verify failed (${response.status})`));
      error.invalidOtp = response.ok;
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('MSG91 OTP verify timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverOtp(phone, otp) {
  if (msg91Config()) return sendMsg91Otp(phone, otp);
  if (exposeOtpForCurrentBuild()) return { provider: 'local', type: 'success', devOnly: true };
  throw new Error('OTP service is not configured. Check MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.');
}

function phoneEmail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `phone-${digits}@phone.lookmefy.local`;
}

function collectStoredFile(files, seen, file) {
  if (!file?.path && !file?.url) return;
  const key = [file.storage || '', file.path || '', file.url || ''].join('|');
  if (seen.has(key)) return;
  seen.add(key);
  files.push(file);
}

function collectAccountStoredFiles(user, records = {}) {
  const files = [];
  const seen = new Set();
  collectStoredFile(files, seen, user.avatarPhoto);
  collectStoredFile(files, seen, user.bodyPhoto);
  (records.tryOns || []).forEach((item) => {
    collectStoredFile(files, seen, item.image);
    collectStoredFile(files, seen, item.video);
  });
  (records.externalTryOns || []).forEach((item) => collectStoredFile(files, seen, item.image));
  (records.customTryOns || []).forEach((item) => {
    collectStoredFile(files, seen, item.garment);
    collectStoredFile(files, seen, item.image);
  });
  (records.closetItems || []).forEach((item) => collectStoredFile(files, seen, item.image));
  (records.closetOutfits || []).forEach((item) => {
    collectStoredFile(files, seen, item.garment);
    collectStoredFile(files, seen, item.image);
  });
  return files;
}

function usernameFromName(value = '') {
  return normalizeUsername(
    String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );
}

async function uniqueUsername(seed) {
  const base = usernameFromName(seed) || 'lookmefy_user';
  for (let index = 0; index < 20; index += 1) {
    const candidate = index === 0 ? base : `${base}${Math.floor(100 + Math.random() * 9000)}`;
    const existing = await User.exists({ username: candidate });
    if (!existing) return candidate;
  }
  return `${base}${Date.now().toString().slice(-6)}`;
}

async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Authentication required' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.sub);
    if (!user) return res.status(401).json({ message: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired session' });
  }
}

router.post('/otp/send', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const purpose = normalizeOtpPurpose(req.body?.purpose);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number' });
  const blockedUntil = otpBlockedUntil(phone);
  if (blockedUntil) return sendOtpBlocked(res, blockedUntil);

  const existing = await User.findOne({ phone }).select('_id passwordSetAt').lean();
  if (purpose === 'signup' && existing) {
    return res.status(409).json({ message: 'An account already exists for this mobile number. Log in with your password, or reset it with OTP.' });
  }
  if (purpose === 'password-reset' && !existing) {
    return res.status(404).json({ message: 'No account found for this mobile number. Create an account first.' });
  }

  const otp = generateOtp();
  const expiresAt = Date.now() + otpExpiryMs();
  let delivery;
  try {
    delivery = await deliverOtp(phone, otp);
  } catch (error) {
    console.error('[auth:otp] delivery failed', { phone, message: error.message });
    return res.status(502).json({ message: 'Could not send OTP right now. Please try again in a moment.' });
  }

  await setPendingOtp(otpKey(phone, purpose), {
    otp,
    provider: delivery.provider || 'local',
    expiresAt,
    attempts: 0
  });

  console.log('[auth:otp] generated', { phone, purpose, otp: exposeOtpForCurrentBuild() ? otp : '[hidden]' });
  res.json({
    message: purpose === 'password-reset' ? 'OTP sent to reset password' : 'OTP sent',
    expiresInSeconds: Math.round((expiresAt - Date.now()) / 1000),
    devOtp: exposeOtpForCurrentBuild() ? otp : undefined
  });
});

router.post('/otp/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '').trim();
  const purpose = normalizeOtpPurpose(req.body?.purpose);
  if (!phone || !otp) return res.status(400).json({ message: 'Mobile number and OTP are required' });
  const blockedUntil = otpBlockedUntil(phone);
  if (blockedUntil) return sendOtpBlocked(res, blockedUntil);

  const key = otpKey(phone, purpose);
  const pending = await getPendingOtp(key);
  if (!pending || pending.expiresAt <= Date.now()) {
    await deletePendingOtp(key);
    recordOtpFailure(phone);
    return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
  }

  pending.attempts += 1;
  if (pending.attempts > 5) {
    await deletePendingOtp(key);
    const blocked = recordOtpFailure(phone);
    if (blocked) return sendOtpBlocked(res, blocked);
    return res.status(429).json({ message: 'Too many OTP attempts. Please request a new one.' });
  }
  await setPendingOtp(key, pending);
  if (pending.provider === 'msg91') {
    try {
      await verifyMsg91Otp(phone, otp);
    } catch (error) {
      if (!error.invalidOtp) {
        console.error('[auth:otp] verification failed', { phone, message: error.message });
        return res.status(502).json({ message: 'Could not verify OTP right now. Please try again in a moment.' });
      }
      const blocked = recordOtpFailure(phone);
      if (blocked) return sendOtpBlocked(res, blocked);
      return res.status(401).json({ message: 'Invalid OTP' });
    }
  } else if (pending.otp !== otp) {
    const blocked = recordOtpFailure(phone);
    if (blocked) return sendOtpBlocked(res, blocked);
    return res.status(401).json({ message: 'Invalid OTP' });
  }

  await deletePendingOtp(key);
  clearOtpFailures(phone);

  const user = await User.findOne({ phone }).select('_id passwordSetAt').lean();
  if (purpose === 'signup') {
    if (user) return res.status(409).json({ message: 'An account already exists for this mobile number. Log in with your password, or reset it with OTP.' });
    return res.json({
      signupToken: signAuthActionToken({ phone, purpose: 'signup' }),
      phone,
      message: 'Mobile number verified. Set your password to finish signup.'
    });
  }

  if (!user) return res.status(404).json({ message: 'No account found for this mobile number. Create an account first.' });
  res.json({
    resetToken: signAuthActionToken({ phone, purpose: 'password-reset' }),
    phone,
    message: 'Mobile number verified. Set a new password.'
  });
});

router.post('/signup/complete', upload.single('bodyPhoto'), async (req, res) => {
  const phone = verifyAuthActionToken(req.body?.signupToken, 'signup');
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const genderPreference = normalizeGenderPreference(req.body?.genderPreference);
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  const username = await uniqueUsername(req.body?.username || name || `lookmefy_${phone.replace(/\D/g, '').slice(-4)}`);
  const passwordError = validatePassword(password);

  if (!phone) return res.status(401).json({ message: 'Mobile verification expired. Verify OTP again.' });
  if (!name || name.length < 2) return res.status(400).json({ message: 'Enter your full name' });
  if (!genderPreference) return res.status(400).json({ message: 'Choose your gender preference' });
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (confirmPassword && confirmPassword !== password) return res.status(400).json({ message: 'Passwords do not match' });
  if (!req.file) return res.status(400).json({ message: 'Upload a profile photo' });

  const existing = await User.findOne({
    $or: [
      { phone },
      { email: phoneEmail(phone) },
      { username }
    ]
  });
  if (existing?.phone === phone || existing?.email === phoneEmail(phone)) return res.status(409).json({ message: 'An account already exists for this mobile number' });
  if (existing?.username === username) return res.status(409).json({ message: 'This username is already taken' });

  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const user = await User.create({
      name,
      email: phoneEmail(phone),
      phone,
      phoneVerifiedAt: now,
      username,
      genderPreference,
      passwordHash,
      passwordSetAt: now,
      avatarPhoto,
      bodyPhoto
    });

    generateFullBodyProfileInBackground(user._id, bodyPhoto, { enabled: generateFullBody });
    res.status(201).json({ token: sign(user), user: user.toClient(), isNewUser: true });
  } catch (error) {
    if (isStorageConfigurationError(error)) return res.status(error.statusCode || 503).json({ message: error.message });
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    if (error.code === 11000 && error.keyPattern?.username) return res.status(409).json({ message: 'This username is already taken' });
    if (error.code === 11000 && (error.keyPattern?.email || error.keyPattern?.phone)) return res.status(409).json({ message: 'An account already exists for this mobile number' });
    throw error;
  }
});

router.post('/password/reset', async (req, res) => {
  const startedAt = performance.now();
  const phone = verifyAuthActionToken(req.body?.resetToken, 'password-reset');
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  const passwordError = validatePassword(password);

  logger.info('auth_password_reset_start', {
    requestId: req.id,
    tokenValid: Boolean(phone)
  });

  if (!phone) return res.status(401).json({ message: 'Password reset expired. Verify OTP again.' });
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (confirmPassword && confirmPassword !== password) return res.status(400).json({ message: 'Passwords do not match' });

  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ message: 'No account found for this mobile number' });

  const now = new Date();
  const hashStartedAt = performance.now();
  user.passwordHash = await bcrypt.hash(password, 12);
  const hashDurationMs = Math.round(performance.now() - hashStartedAt);
  user.passwordSetAt = now;
  user.phoneVerifiedAt = user.phoneVerifiedAt || now;
  await user.save();
  logger.info('auth_password_reset_done', {
    requestId: req.id,
    userId: user._id.toString(),
    hashDurationMs,
    durationMs: Math.round(performance.now() - startedAt)
  });
  res.json({ token: sign(user), user: user.toClient() });
});

router.post('/signup', upload.single('bodyPhoto'), async (req, res) => {
  if (!parseBoolean(process.env.ALLOW_LEGACY_EMAIL_SIGNUP)) {
    return res.status(410).json({ message: 'Use mobile OTP signup to create an account.' });
  }
  const { name, email, password } = req.body;
  const username = normalizeUsername(req.body.username) || await uniqueUsername(name);
  const genderPreference = normalizeGenderPreference(req.body.genderPreference);
  const passwordError = validatePassword(password);
  if (!name || !email || !password || !username || !genderPreference) return res.status(400).json({ message: 'Name, username, email, gender preference, and password are required' });
  if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters' });
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (!req.file) return res.status(400).json({ message: 'Full-body photo is required' });

  const existing = await User.findOne({
    $or: [
      { email: email.toLowerCase() },
      { username }
    ]
  });
  if (existing?.email === email.toLowerCase()) return res.status(409).json({ message: 'An account already exists for this email' });
  if (existing?.username === username) return res.status(409).json({ message: 'This username is already taken' });

  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name,
      email,
      username,
      genderPreference,
      passwordHash,
      passwordSetAt: new Date(),
      avatarPhoto,
      bodyPhoto
    });

    generateFullBodyProfileInBackground(user._id, bodyPhoto, { enabled: generateFullBody });
    res.status(201).json({ token: sign(user), user: user.toClient(), isNewUser: true });
  } catch (error) {
    if (isStorageConfigurationError(error)) return res.status(error.statusCode || 503).json({ message: error.message });
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    if (error.code === 11000 && error.keyPattern?.username) return res.status(409).json({ message: 'This username is already taken' });
    if (error.code === 11000 && error.keyPattern?.email) return res.status(409).json({ message: 'An account already exists for this email' });
    throw error;
  }
});

router.get('/username-suggestions', async (req, res) => {
  const base = usernameFromName(req.query.name) || 'lookmefy_user';
  const suggestions = [];
  for (let index = 0; suggestions.length < 4 && index < 20; index += 1) {
    const candidate = index === 0 ? base : `${base}${Math.floor(100 + Math.random() * 9000)}`;
    const existing = await User.exists({ username: candidate });
    if (!existing && !suggestions.includes(candidate)) suggestions.push(candidate);
  }
  res.json({ suggestions });
});

router.post('/login', async (req, res) => {
  const submittedIdentifier = String(req.body.email || req.body.username || '').trim().toLowerCase();
  const phone = normalizePhone(req.body?.phone || req.body?.mobile || req.body?.mobileNumber || submittedIdentifier);
  const identifier = phone ? '' : submittedIdentifier;
  const { password } = req.body;
  if ((!phone && !identifier) || !password) return res.status(400).json({ message: 'Mobile number and password are required' });
  const user = phone
    ? await User.findOne({ phone })
    : await User.findOne({
      $or: [
        { email: identifier },
        { username: normalizeUsername(identifier) }
      ]
    });
  if (!user) return res.status(401).json({ message: 'Invalid mobile number or password' });
  if (!user.passwordSetAt && user.phone) {
    return res.status(409).json({ message: 'Set your password with OTP before logging in.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: 'Invalid mobile number or password' });
  res.json({ token: sign(user), user: user.toClient() });
});

router.get('/me', requireUser, async (req, res) => {
  disableResponseCache(res);
  await clearCustomTryOnAvatar(req.user);
  res.json({ user: req.user.toClient() });
});

router.patch('/dev-mode', requireUser, async (req, res) => {
  if (!userDevModeControlsEnabled()) {
    return res.status(403).json({ message: 'Dev mode controls are disabled on this server.' });
  }
  req.user.devMode = parseBoolean(req.body?.devMode);
  await req.user.save();
  res.json({ user: req.user.toClient() });
});

router.get('/media/:kind/:id', async (req, res) => {
  try {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['avatar', 'body'].includes(kind)) return res.status(404).json({ message: 'Profile media not found' });

    const access = verifyMediaAccess(mediaTokenFromRequest(req), {
      scope: 'profile',
      id: req.params.id,
      kind: 'image',
      field: kind
    });
    if (!access) return res.status(401).json({ message: 'Profile media link expired' });

    const user = await User.findById(req.params.id).select('avatarPhoto bodyPhoto').lean();
    if (!user || user._id.toString() !== access.userId) return res.status(404).json({ message: 'Profile media not found' });

    const file = kind === 'avatar' ? user.avatarPhoto : user.bodyPhoto;
    if (!file?.path && !file?.url) return res.status(404).json({ message: 'Profile media not found' });
    const stored = await readStoredFile(file);
    res.set({
      'Content-Type': stored.mimetype || file.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.bytes);
  } catch {
    return res.status(404).json({ message: 'Profile media not found' });
  }
});

router.patch('/profile', requireUser, upload.single('bodyPhoto'), async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const genderPreference = normalizeGenderPreference(req.body?.genderPreference);
  const requireBodyPhoto = parseBoolean(req.body?.requireBodyPhoto);

  if (!name || name.length < 2) return res.status(400).json({ message: 'Enter your full name' });
  if (!genderPreference) return res.status(400).json({ message: 'Choose your gender preference' });
  if (requireBodyPhoto && !req.file && !req.user.bodyPhoto?.path && !req.user.bodyPhoto?.url) {
    return res.status(400).json({ message: 'Upload a profile photo' });
  }

  try {
    req.user.name = name;
    req.user.genderPreference = genderPreference;

    if (req.file) {
      const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
      const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody, user: req.user });
      req.user.avatarPhoto = avatarPhoto;
      req.user.bodyPhoto = bodyPhoto;
      req.user.avatarCrop = undefined;
      await req.user.save();
      generateFullBodyProfileInBackground(req.user._id, bodyPhoto, { enabled: generateFullBody });
    } else {
      await req.user.save();
    }

    res.json({ user: req.user.toClient() });
  } catch (error) {
    if (isStorageConfigurationError(error)) return res.status(error.statusCode || 503).json({ message: error.message });
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    throw error;
  }
});

router.patch('/avatar-crop', requireUser, async (req, res) => {
  req.user.avatarCrop = normalizeAvatarCropInput(req.body?.avatarCrop || req.body);
  await req.user.save();
  res.json({ user: req.user.toClient() });
});

router.delete('/me', requireUser, async (req, res) => {
  const userId = req.user._id;
  const [
    tryOns,
    externalTryOns,
    customTryOns,
    closetItems,
    closetOutfits
  ] = await Promise.all([
    TryOn.find({ user: userId }),
    ExternalTryOn.find({ user: userId }),
    CustomTryOn.find({ user: userId }),
    ClosetItem.find({ user: userId }),
    ClosetOutfit.find({ user: userId })
  ]);

  const storedFiles = collectAccountStoredFiles(req.user, {
    tryOns,
    externalTryOns,
    customTryOns,
    closetItems,
    closetOutfits
  });
  const fileResults = await Promise.allSettled(storedFiles.map((file) => deleteStoredFile(file)));
  const fileFailures = fileResults.filter((result) => result.status === 'rejected');
  if (fileFailures.length) {
    console.warn('[account-delete] stored file cleanup failed', {
      userId: userId.toString(),
      failedFiles: fileFailures.length
    });
  }

  const [
    tryOnResult,
    externalTryOnResult,
    customTryOnResult,
    closetItemResult,
    closetOutfitResult,
    userEventResult,
    userPreferenceResult,
    creditEventResult,
    tokenOrderResult,
    jobResult
  ] = await Promise.all([
    TryOn.deleteMany({ user: userId }),
    ExternalTryOn.deleteMany({ user: userId }),
    CustomTryOn.deleteMany({ user: userId }),
    ClosetItem.deleteMany({ user: userId }),
    ClosetOutfit.deleteMany({ user: userId }),
    UserEvent.deleteMany({ user: userId }),
    UserPreference.deleteMany({ user: userId }),
    CreditEvent.deleteMany({ user: userId }),
    TokenOrder.deleteMany({ user: userId }),
    Job.deleteMany({ user: userId })
  ]);
  await User.deleteOne({ _id: userId });
  clearOtpFailures(req.user.phone);

  res.json({
    deleted: true,
    deletedRecords: {
      tryOns: tryOnResult.deletedCount + externalTryOnResult.deletedCount + customTryOnResult.deletedCount,
      wardrobe: closetItemResult.deletedCount + closetOutfitResult.deletedCount,
      events: userEventResult.deletedCount + creditEventResult.deletedCount,
      preferences: userPreferenceResult.deletedCount,
      orders: tokenOrderResult.deletedCount,
      jobs: jobResult.deletedCount
    },
    fileDeleteFailures: fileFailures.length
  });
});

router.post('/body-photo', requireUser, upload.single('bodyPhoto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload a profile photo first' });
  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody, user: req.user });
    req.user.avatarPhoto = avatarPhoto;
    req.user.bodyPhoto = bodyPhoto;
    req.user.avatarCrop = undefined;
    await req.user.save();
    generateFullBodyProfileInBackground(req.user._id, bodyPhoto, { enabled: generateFullBody });
    res.json({ user: req.user.toClient() });
  } catch (error) {
    if (isStorageConfigurationError(error)) return res.status(error.statusCode || 503).json({ message: error.message });
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    throw error;
  }
});

export default router;
export { requireUser };
