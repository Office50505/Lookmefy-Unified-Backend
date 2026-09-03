import express from 'express';
import heicConvert from 'heic-convert';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import AdminAuditLog from '../models/AdminAuditLog.js';
import AdminUser from '../models/AdminUser.js';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CustomTryOn from '../models/CustomTryOn.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import GenerationMetric from '../models/GenerationMetric.js';
import Product, { productToClient } from '../models/Product.js';
import TokenOrder from '../models/TokenOrder.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import UserSession from '../models/UserSession.js';
import { recordAdminAudit } from '../utils/adminAudit.js';
import { requireAdmin, requireAdminSection, signAdminSession } from '../utils/adminAccess.js';
import { adminPasswordError, normalizeAdminName } from '../utils/adminCredentials.js';
import { ADMIN_SECTIONS, adminToClient, normalizeAdminEmail } from '../utils/adminPermissions.js';
import { buildAdminUserSearchFilter, buildAdminUserTokenFilter } from '../utils/adminUserSearch.js';
import { normalizeGenderPreference } from '../utils/genderPreference.js';
import { enqueueJob, safeJobId } from '../utils/jobQueue.js';
import { signUserMediaToken, verifyUserMediaToken } from '../utils/mediaTokens.js';
import { normalizeIndianMobile } from '../utils/phone.js';
import { hashPassword, verifyPassword } from '../utils/passwordHashing.js';
import { createRateLimiter, developmentRateLimitBypass, rateLimitKeys } from '../utils/rateLimit.js';
import { deleteStoredFile, deleteStoredPrefix, publicUrlForStoredFile, readStoredFile, saveBuffer, useBunny } from '../utils/storage.js';
import {
  accountAccessError,
  accountStatusFor,
  anonymizedIdentity,
  tokenBalanceAfter
} from '../utils/accountState.js';
import { availableStatusClause } from '../utils/productAvailability.js';
import { adminMediaUsage, deleteBunnyOrphans, reconcileBunnyInventory } from '../services/adminMediaUsage.js';
import {
  cancelOtpChallenge,
  createOtpChallenge,
  currentSessionMatches,
  phoneScopeId,
  removeCurrentSession,
  verifyOtpChallenge
} from '../utils/otp.js';
import { deliverOtp, otpDeliveryProvider } from '../utils/otpDelivery.js';
import { mockOtpStorePath } from '../utils/otpProviders.js';
import {
  isAllowedRasterImageUpload,
  isDevelopmentModeAllowed,
  normalizeRasterImageBuffer,
  safeFetchImageBuffer
} from '../utils/security.js';
import { createTempSessionStore } from '../utils/tempSessions.js';
import {
  authenticationVersion,
  tokenAuthenticationVersionMatches,
  userPasswordError
} from '../utils/userCredentials.js';
import {
  createUserSession,
  endUserSession,
  findActiveUserSession,
  normalizeSessionPath,
  revokeUserSessions,
  sessionDisplayState,
  sessionToAdmin,
  touchUserSession
} from '../utils/userSessions.js';

const router = express.Router();
const avifExtensions = new Set(['.avif']);
const avifMimeTypes = new Set(['image/avif', 'image/x-avif']);
const heicExtensions = new Set(['.heic', '.heif']);
const heicMimeTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const debugGenerationLogs = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_GENERATION_LOGS || '').toLowerCase());
const signupOtpTtlMs = 5 * 60 * 1000;
const signupOtpSessions = createTempSessionStore('otp:signup', { ttlMs: signupOtpTtlMs });
const loginOtpSessions = createTempSessionStore('otp:login', { ttlMs: signupOtpTtlMs });
const passwordResetOtpSessions = createTempSessionStore('otp:password-reset', { ttlMs: signupOtpTtlMs });
const signupOtpCurrentSessions = createTempSessionStore('otp:signup-current', { ttlMs: signupOtpTtlMs });
const loginOtpCurrentSessions = createTempSessionStore('otp:login-current', { ttlMs: signupOtpTtlMs });
const passwordResetOtpCurrentSessions = createTempSessionStore('otp:password-reset-current', { ttlMs: signupOtpTtlMs });
const requireUserOperationsAdmin = requireAdminSection(ADMIN_SECTIONS.USER_OPERATIONS);
const requireSystemAdmin = requireAdminSection(ADMIN_SECTIONS.SYSTEM_MANAGEMENT);
const otpRateLimitBypass = () => developmentRateLimitBypass('DISABLE_AUTH_OTP_RATE_LIMITS');
const bypassableOtpLimiter = (limiter) => (req, res, next) => (
  otpRateLimitBypass() ? next() : limiter(req, res, next)
);
const authIpLimiter = createRateLimiter({
  name: 'auth:ip',
  windowMs: 15 * 60 * 1000,
  max: 80,
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Too many auth requests from this network. Please wait a few minutes and try again.'
});
const otpRequestIpLimiter = createRateLimiter({
  name: 'auth:otp-request-ip',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_OTP_REQUEST_IP_MAX || 12),
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Too many OTP requests from this network. Please wait before requesting another code.',
  skip: otpRateLimitBypass
});
const otpRequestPhoneLimiter = createRateLimiter({
  name: 'auth:otp-request-phone',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_OTP_REQUEST_PHONE_MAX || 3),
  keyGenerator: rateLimitKeys.bodyPhone,
  message: 'Too many OTP requests for this phone number. Please wait before requesting another code.',
  skip: otpRateLimitBypass
});
const otpRequestPhoneHourlyLimiter = createRateLimiter({
  name: 'auth:otp-request-phone-hour',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH_OTP_REQUEST_PHONE_HOURLY_MAX || 10),
  keyGenerator: rateLimitKeys.bodyPhone,
  message: 'OTP requests are temporarily limited for this phone number. Please try again later.',
  skip: otpRateLimitBypass
});
const otpVerifyLimiter = createRateLimiter({
  name: 'auth:otp-verify-session',
  windowMs: signupOtpTtlMs,
  max: 5,
  keyGenerator: rateLimitKeys.otpSession,
  message: 'Too many OTP attempts. Please request a new code and try again.',
  skip: otpRateLimitBypass
});
const otpAuthIpLimiter = bypassableOtpLimiter(authIpLimiter);
const loginAttemptLimiter = createRateLimiter({
  name: 'auth:login-identifier',
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: rateLimitKeys.bodyIdentifier,
  message: 'Too many login attempts. Please wait before trying again.'
});
const usernameSuggestionLimiter = createRateLimiter({
  name: 'auth:username-suggestions',
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Username suggestions are temporarily limited. Please try again shortly.'
});
const profilePhotoLimiter = createRateLimiter({
  name: 'auth:profile-photo',
  windowMs: 30 * 60 * 1000,
  max: 5,
  keyGenerator: rateLimitKeys.user,
  message: 'Profile photo generation is temporarily limited. Please wait before trying again.'
});
const accountDeleteLimiter = createRateLimiter({
  name: 'auth:account-delete',
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many account deletion attempts. Please wait before trying again.'
});
const adminReadLimiter = createRateLimiter({
  name: 'auth:admin-read',
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Admin data requests are temporarily limited. Please try again shortly.'
});
const adminWriteLimiter = createRateLimiter({
  name: 'auth:admin-write',
  windowMs: 10 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Too many admin changes. Please pause briefly and try again.'
});
const sessionHeartbeatLimiter = createRateLimiter({
  name: 'auth:session-heartbeat',
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.user,
  message: 'Session activity is temporarily limited.'
});

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

function normalizePhone(value = '') {
  return normalizeIndianMobile(value);
}

function testOtpHelperEnabled() {
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  const disabled = ['0', 'false', 'no', 'off'].includes(String(process.env.ENABLE_TEST_OTP_HELPER || '').toLowerCase());
  return nodeEnv !== 'production' && !disabled && otpDeliveryProvider(process.env) === 'mock';
}

async function latestMockOtp({ phone, purpose, otpSession }) {
  const storePath = mockOtpStorePath(process.env);
  const raw = await fs.readFile(storePath, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean).reverse();
  const match = entries.find((entry) => (
    normalizePhone(entry.phone) === phone
    && entry.purpose === purpose
    && (!otpSession || entry.otpSession === otpSession)
    && /^\d{6}$/.test(String(entry.otp || ''))
  ));
  return match?.otp || '';
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
  return isAllowedRasterImageUpload(file) || isHeicUpload(file) || isAvifUpload(file);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
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

  const { response, buffer: bytes, mimetype } = await safeFetchImageBuffer(url, {
    maxBytes: 12 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy profile image fetcher'
    }
  });
  if (!response.ok) throw new Error('Could not download generated profile image');
  return { bytes, mimetype: mimetype || imageMimeTypeFromResponse(response, bytes) };
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

  const inputBuffer = file.buffer || (file.url || file.storage === 'bunny'
    ? (await readStoredFile(file, 'profile photo')).buffer
    : await fs.readFile(file.path));
  const inputDataUri = `data:${file.mimetype || 'image/jpeg'};base64,${inputBuffer.toString('base64')}`;
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
  if (!file || (!isHeicUpload(file) && !isAvifUpload(file))) return file;

  const inputPath = file.path;
  const parsed = path.parse(file.filename);
  const filename = `${parsed.name}.jpg`;
  const outputPath = path.join(path.dirname(inputPath), filename);

  try {
    const inputBuffer = await fs.readFile(inputPath);
    const outputBuffer = isAvifUpload(file) || isAvifBuffer(inputBuffer)
      ? await sharp(inputBuffer).jpeg({ quality: 90 }).toBuffer()
      : Buffer.from(await heicConvert({
        buffer: inputBuffer,
        format: 'JPEG',
        quality: 0.9
      }));

    await fs.writeFile(outputPath, outputBuffer);
    await fs.unlink(inputPath).catch(() => {});
    const stats = await fs.stat(outputPath);
    return {
      ...file,
      filename,
      path: outputPath,
      mimetype: 'image/jpeg',
      size: stats.size
    };
  } catch (error) {
    await fs.unlink(outputPath).catch(() => {});
    throw new Error('Could not convert the AVIF/HEIC/HEIF profile photo. Please try another image.');
  }
}

async function normalizedProfileUpload(file) {
  const normalized = await normalizeBodyPhotoUpload(file);
  const bytes = await fs.readFile(normalized.path);
  const image = await normalizeRasterImageBuffer({
    buffer: bytes,
    filename: normalized.filename || file.originalname || 'profile.jpg'
  });
  return { normalized, image };
}

async function avatarPhotoFromImage(image) {
  let avatarBuffer = image.buffer;
  try {
    avatarBuffer = await sharp(image.buffer)
      .rotate()
      .resize({ width: 640, height: 640, fit: 'cover', position: 'north' })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    avatarBuffer = image.buffer;
  }
  const filename = `avatar-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
  const stored = await saveBuffer({
    key: `profile/avatar/${filename}`,
    buffer: avatarBuffer,
    mimetype: 'image/jpeg',
    filename
  });
  return {
    ...stored,
    source: 'upload',
    uploadedAt: new Date()
  };
}

async function bodyPhotoFromImage(image, { generateFullBody = true } = {}) {
  const stored = await saveBuffer({
    key: `profile/${image.filename}`,
    buffer: image.buffer,
    mimetype: image.mimetype,
    filename: image.filename
  });
  return {
    ...stored,
    status: generateFullBody ? 'generating' : 'ready',
    source: generateFullBody ? 'upload' : 'exact-upload',
    original: stored
  };
}

async function profilePhotosFromUpload(file, { generateFullBody = true } = {}) {
  const { normalized, image } = await normalizedProfileUpload(file);
  try {
    const [avatarPhoto, bodyPhoto] = await Promise.all([
      avatarPhotoFromImage(image),
      bodyPhotoFromImage(image, { generateFullBody })
    ]);
    return { avatarPhoto, bodyPhoto };
  } finally {
    await fs.unlink(normalized.path).catch(() => {});
  }
}

async function bodyPhotoFromUpload(file, { generateFullBody = true } = {}) {
  const { bodyPhoto } = await profilePhotosFromUpload(file, { generateFullBody });
  return bodyPhoto;
}

async function runProfileFullBodyJob({ userId, sourceBodyPhoto }) {
  try {
    if (debugGenerationLogs) console.log('[profile-fullbody] start', { userId: userId.toString(), source: sourceBodyPhoto.path });
    const generated = await generateFullBodyProfilePhoto(sourceBodyPhoto);
    const generatedBodyPhoto = {
      ...await saveBuffer({
        key: generated.filename,
        buffer: generated.buffer,
        mimetype: generated.mimetype,
        filename: generated.filename
      }),
      status: 'ready',
      source: 'fal-full-body',
      generatedAt: new Date(),
      original: sourceBodyPhoto.original || {
        filename: sourceBodyPhoto.filename,
        path: sourceBodyPhoto.path,
        url: sourceBodyPhoto.url,
        storage: sourceBodyPhoto.storage,
        mimetype: sourceBodyPhoto.mimetype,
        size: sourceBodyPhoto.size
      }
    };
    const generatedAvatarPhoto = {
      filename: generatedBodyPhoto.filename,
      path: generatedBodyPhoto.path,
      url: generatedBodyPhoto.url,
      storage: generatedBodyPhoto.storage,
      mimetype: generatedBodyPhoto.mimetype,
      size: generatedBodyPhoto.size,
      source: 'fal-full-body',
      uploadedAt: new Date()
    };

    const updated = await User.findOneAndUpdate(
      { _id: userId, 'bodyPhoto.path': sourceBodyPhoto.path },
      { $set: { bodyPhoto: generatedBodyPhoto, avatarPhoto: generatedAvatarPhoto }, $unset: { avatarCrop: '' } },
      { new: true }
    );

    if (updated) {
      if (generatedBodyPhoto.original?.path !== sourceBodyPhoto.path && generatedBodyPhoto.original?.url !== sourceBodyPhoto.url) {
        await deleteStoredFile(sourceBodyPhoto).catch(() => {});
      }
      if (debugGenerationLogs) console.log('[profile-fullbody] done', { userId: userId.toString(), path: generatedBodyPhoto.path });
      return { updated: true, path: generatedBodyPhoto.path };
    }

    await deleteStoredFile(generatedBodyPhoto).catch(() => {});
    if (debugGenerationLogs) console.log('[profile-fullbody] skipped stale result', { userId: userId.toString() });
    return { updated: false, stale: true };
  } catch (error) {
    const message = readableProviderError(error, 'Could not generate full-body profile image');
    await User.findOneAndUpdate(
      { _id: userId, 'bodyPhoto.path': sourceBodyPhoto.path },
      { $set: { 'bodyPhoto.status': 'failed', 'bodyPhoto.error': message } }
    );
    console.error('[profile-fullbody] failed', { userId: userId.toString(), error: message });
    throw error;
  }
}

async function generateFullBodyProfileInBackground(userId, sourceBodyPhoto, { enabled = true } = {}) {
  if (!enabled || !shouldGenerateFullBodyProfile()) return;

  const queueMode = String(process.env.PROFILE_FULL_BODY_QUEUE_MODE || 'inline').toLowerCase();
  if (['inline', 'local', 'api', 'off'].includes(queueMode)) {
    setImmediate(() => {
      runProfileFullBodyJob({ userId, sourceBodyPhoto }).catch(() => {});
    });
    return;
  }

  const job = await enqueueJob('profile', 'full-body', {
    userId: userId.toString(),
    sourceBodyPhoto
  }, {
    jobId: safeJobId('profile-full-body', userId, sourceBodyPhoto.path || sourceBodyPhoto.url || Date.now())
  }).catch((error) => {
    console.warn('[profile-fullbody] queue unavailable, using local fallback', { error: error.message });
    return null;
  });

  if (job) return;
  setImmediate(() => {
    runProfileFullBodyJob({ userId, sourceBodyPhoto }).catch(() => {});
  });
}

function sign(user, sessionId) {
  return jwt.sign({
    sub: user._id.toString(),
    ver: authenticationVersion(user.authVersion),
    ...(sessionId ? { sid: sessionId } : {})
  }, process.env.JWT_SECRET, { expiresIn: '14d' });
}

async function authenticatedUserPayload(user, req, authMethod) {
  const sessionId = await createUserSession({
    userId: user._id,
    authMethod,
    userAgent: req.headers?.['user-agent'] || ''
  });
  return { token: sign(user, sessionId), mediaToken: signUserMediaToken(user._id), user: user.toClient() };
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

function phoneEmail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `phone-${digits}@phone.lookmefy.local`;
}

function signAuthActionToken({ phone, purpose, otpSession }) {
  return jwt.sign({
    phone,
    purpose,
    otpSession,
    type: 'auth-action',
    ver: 1
  }, process.env.JWT_SECRET, { expiresIn: '20m' });
}

function verifyAuthActionToken(token, purpose) {
  try {
    const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (decoded?.type !== 'auth-action' || decoded?.purpose !== purpose || !decoded?.phone) return null;
    const phone = normalizePhone(decoded.phone);
    if (!phone) return null;
    return {
      phone,
      otpSession: String(decoded.otpSession || '')
    };
  } catch {
    return null;
  }
}

function normalizeMobileOtpPurpose(value = '') {
  const purpose = String(value || 'signup').trim().toLowerCase();
  if (['signup', 'login', 'password-reset'].includes(purpose)) return purpose;
  return '';
}

function mobileOtpStores(purpose) {
  if (purpose === 'signup') return { sessions: signupOtpSessions, currentSessions: signupOtpCurrentSessions };
  if (purpose === 'login') return { sessions: loginOtpSessions, currentSessions: loginOtpCurrentSessions };
  if (purpose === 'password-reset') return { sessions: passwordResetOtpSessions, currentSessions: passwordResetOtpCurrentSessions };
  return null;
}

async function currentOtpSession({ currentSessions, purpose, phone }) {
  const current = await currentSessions.get(phoneScopeId(purpose, phone));
  return current?.phone === phone ? String(current.otpSession || '') : '';
}

function mobileOtpMessage(purpose) {
  if (purpose === 'password-reset') return 'OTP sent to reset password';
  if (purpose === 'login') return 'OTP sent to log in';
  return 'OTP sent';
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

function mediaTokenFromRequest(req) {
  const queryToken = String(req.query?.token || req.query?.mediaToken || '').trim();
  if (queryToken) return queryToken;
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function profileMediaFileForKind(user, kind) {
  if (kind === 'avatar') return user.avatarPhoto;
  if (kind === 'body') return user.bodyPhoto;
  if (kind === 'body-original') return user.bodyPhoto?.original;
  return null;
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
  const base = usernameFromName(seed) || 'fitlook_user';
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
    const [user, session] = await Promise.all([
      User.findById(decoded.sub),
      decoded.sid ? findActiveUserSession({ userId: decoded.sub, sessionId: decoded.sid }) : null
    ]);
    if (!user) return res.status(401).json({ message: 'User not found' });
    if (!tokenAuthenticationVersionMatches(user, decoded)) {
      return res.status(401).json({ message: 'Session has ended. Please sign in again.' });
    }
    if (decoded.sid && !session) return res.status(401).json({ message: 'Session has ended. Please sign in again.' });
    const accessError = accountAccessError(user);
    if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });
    req.user = user;
    req.userSession = session;
    req.sessionId = decoded.sid || '';
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired session' });
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function accountExistsPayload(identifier, message = 'An account already exists. Please sign in.') {
  return {
    message,
    code: 'ACCOUNT_EXISTS',
    identifier: String(identifier || '').trim()
  };
}

router.post('/otp/send', otpRequestIpLimiter, otpRequestPhoneLimiter, otpRequestPhoneHourlyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const purpose = normalizeMobileOtpPurpose(req.body?.purpose);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' });
  if (!purpose) return res.status(400).json({ message: 'Invalid OTP purpose.' });

  const user = await User.findOne({ phone }).select('_id email phone accountStatus bannedAt deletedAt').lean();
  if (purpose === 'signup' && user) {
    return res.status(409).json(accountExistsPayload(user.email || user.phone || phone, 'An account already exists for this mobile number. Log in with your password, or reset it with OTP.'));
  }
  if (['login', 'password-reset'].includes(purpose)) {
    if (!user) return res.status(404).json({ message: 'No Lookmefy account found for this phone number' });
    const accessError = accountAccessError(user);
    if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });
  }

  const stores = mobileOtpStores(purpose);
  const { otpSession, otp, expiresAt } = await createOtpChallenge({
    ...stores,
    purpose,
    phone,
    metadata: user ? { userId: user._id.toString() } : {}
  });

  try {
    await deliverOtp({ phone, otp, purpose, otpSession, expiresAt });
  } catch (error) {
    await stores.sessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: stores.currentSessions, purpose, phone });
    throw error;
  }

  res.json({
    otpSession,
    phone,
    message: mobileOtpMessage(purpose)
  });
}));

router.post('/otp/verify', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const purpose = normalizeMobileOtpPurpose(req.body?.purpose);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' });
  if (!purpose) return res.status(400).json({ message: 'Invalid OTP purpose.' });

  const stores = mobileOtpStores(purpose);
  const otpSession = String(req.body?.otpSession || '') || await currentOtpSession({
    currentSessions: stores.currentSessions,
    purpose,
    phone
  });

  const result = await verifyOtpChallenge({
    ...stores,
    purpose,
    phone,
    otpSession,
    otp: req.body?.otp
  });
  if (!result.ok) return res.status(result.status).json({ message: result.message });

  if (purpose === 'signup') {
    const existing = await User.findOne({ phone }).select('email phone').lean();
    if (existing) return res.status(409).json(accountExistsPayload(existing.email || existing.phone || phone, 'An account already exists for this mobile number. Please sign in.'));
    return res.json({
      signupToken: signAuthActionToken({ phone, purpose, otpSession }),
      phone,
      message: 'Mobile number verified. Set your password to finish signup.'
    });
  }

  const user = await User.findById(result.session.userId);
  if (!user) return res.status(404).json({ message: 'No Lookmefy account found for this phone number' });
  const accessError = accountAccessError(user);
  if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });

  if (purpose === 'login') {
    await stores.sessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: stores.currentSessions, purpose, phone });
    return res.json(await authenticatedUserPayload(user, req, 'otp'));
  }

  res.json({
    resetToken: signAuthActionToken({ phone, purpose, otpSession }),
    phone,
    message: 'Mobile number verified. Set a new password.'
  });
}));

router.post('/signup/request-otp', otpRequestIpLimiter, otpRequestPhoneLimiter, otpRequestPhoneHourlyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' });
  const existing = await User.findOne({ phone }).select('email phone').lean();
  if (existing) return res.status(409).json(accountExistsPayload(existing.email || existing.phone || phone, 'An account already exists for this phone number. Please sign in.'));

  const { otpSession, otp, expiresAt } = await createOtpChallenge({
    sessions: signupOtpSessions,
    currentSessions: signupOtpCurrentSessions,
    purpose: 'signup',
    phone
  });
  try {
    await deliverOtp({ phone, otp, purpose: 'signup', otpSession, expiresAt });
  } catch (error) {
    await signupOtpSessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: signupOtpCurrentSessions, purpose: 'signup', phone });
    throw error;
  }

  res.json({
    otpSession,
    phone,
    message: 'OTP sent'
  });
}));

router.get('/test-otp', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  if (!testOtpHelperEnabled()) return res.status(404).json({ message: 'Not found' });
  const purpose = String(req.query?.purpose || '').trim();
  if (!['signup', 'login', 'password-reset'].includes(purpose)) return res.status(400).json({ message: 'Invalid OTP purpose.' });
  const phone = normalizePhone(req.query?.phone);
  const otpSession = String(req.query?.otpSession || '').trim();
  if (!phone || !otpSession) return res.status(400).json({ message: 'Missing OTP request details.' });
  const otp = await latestMockOtp({ phone, purpose, otpSession });
  if (!otp) return res.status(404).json({ message: 'No local code found for this request.' });
  res.json({ otp });
}));

router.post('/signup/verify-otp', otpAuthIpLimiter, otpVerifyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  const result = await verifyOtpChallenge({
    sessions: signupOtpSessions,
    currentSessions: signupOtpCurrentSessions,
    purpose: 'signup',
    phone,
    otpSession,
    otp: req.body?.otp
  });
  if (!result.ok) return res.status(result.status).json({ message: result.message });
  res.json({ verified: true, otpSession, phone });
}));

router.post('/signup/cancel-otp', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  await cancelOtpChallenge({
    sessions: signupOtpSessions,
    currentSessions: signupOtpCurrentSessions,
    purpose: 'signup',
    phone,
    otpSession
  });
  res.json({ cancelled: true });
}));

router.post('/signup/complete', upload.single('bodyPhoto'), asyncRoute(async (req, res) => {
  const verifiedAction = verifyAuthActionToken(req.body?.signupToken, 'signup');
  const phone = verifiedAction?.phone || '';
  const otpSession = verifiedAction?.otpSession || String(req.body?.otpSession || '');
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const username = normalizeUsername(req.body.username) || await uniqueUsername(name || `lookmefy_${phone.replace(/\D/g, '').slice(-4)}`);
  const genderPreference = normalizeGenderPreference(req.body.genderPreference);
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  if (!phone || !otpSession) return res.status(401).json({ message: 'Mobile verification expired. Verify OTP again.' });
  const phoneSession = await signupOtpSessions.get(otpSession);
  const isCurrentSignupSession = await currentSessionMatches({
    currentSessions: signupOtpCurrentSessions,
    purpose: 'signup',
    phone,
    otpSession
  });
  if (!phoneSession?.verified || phoneSession.phone !== phone || phoneSession.expiresAt <= Date.now() || !isCurrentSignupSession) {
    return res.status(400).json({ message: 'Verify your phone number first' });
  }
  if (!name || name.length < 2) return res.status(400).json({ message: 'Enter your full name' });
  if (!password || !username || !genderPreference) return res.status(400).json({ message: 'Name, username, gender preference, and password are required' });
  const passwordError = userPasswordError(password);
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (confirmPassword && confirmPassword !== password) return res.status(400).json({ message: 'Passwords do not match' });
  if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters' });
  if (!req.file) return res.status(400).json({ message: 'Upload a profile photo' });

  const email = phoneEmail(phone);
  const existing = await User.findOne({
    $or: [
      { email },
      { phone },
      { username }
    ]
  });
  if (existing?.email === email || existing?.phone === phone) return res.status(409).json(accountExistsPayload(existing.email || existing.phone || phone, 'An account already exists for this mobile number. Please sign in.'));
  if (existing?.username === username) return res.status(409).json({ message: 'This username is already taken' });

  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
    const now = new Date();
    const user = await User.create({
      name,
      email,
      phone,
      phoneVerifiedAt: now,
      username,
      genderPreference,
      passwordHash: await hashPassword(password),
      passwordSetAt: now,
      avatarPhoto,
      bodyPhoto
    });

    await generateFullBodyProfileInBackground(user._id, bodyPhoto, { enabled: generateFullBody });
    await signupOtpSessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: signupOtpCurrentSessions, purpose: 'signup', phone });
    res.status(201).json({ ...await authenticatedUserPayload(user, req, 'signup'), isNewUser: true });
  } catch (error) {
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    if (error.code === 11000 && error.keyPattern?.username) return res.status(409).json({ message: 'This username is already taken' });
    if (error.code === 11000 && (error.keyPattern?.email || error.keyPattern?.phone)) return res.status(409).json(accountExistsPayload(phone, 'An account already exists for this mobile number. Please sign in.'));
    throw error;
  }
}));

router.post('/signup', upload.single('bodyPhoto'), asyncRoute(async (req, res) => {
  const { name, email, password } = req.body;
  const phone = normalizePhone(req.body.phone);
  const otpSession = String(req.body.otpSession || '');
  const username = normalizeUsername(req.body.username) || await uniqueUsername(name);
  const genderPreference = normalizeGenderPreference(req.body.genderPreference);
  const phoneSession = await signupOtpSessions.get(otpSession);
  const isCurrentSignupSession = phone && otpSession
    ? await currentSessionMatches({
      currentSessions: signupOtpCurrentSessions,
      purpose: 'signup',
      phone,
      otpSession
    })
    : false;
  if (!phone || !phoneSession || phoneSession.phone !== phone || !phoneSession.verified || phoneSession.expiresAt <= Date.now() || !isCurrentSignupSession) return res.status(400).json({ message: 'Verify your phone number first' });
  if (!name || !email || !password || !username || !genderPreference) return res.status(400).json({ message: 'Name, username, email, gender preference, and password are required' });
  const passwordError = userPasswordError(password);
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters' });
  if (!req.file) return res.status(400).json({ message: 'Full-body photo is required' });

  const existing = await User.findOne({
    $or: [
      { email: email.toLowerCase() },
      { phone },
      { username }
    ]
  });
  if (existing?.email === email.toLowerCase()) return res.status(409).json(accountExistsPayload(existing.email, 'An account already exists for this email. Please sign in.'));
  if (existing?.phone === phone) return res.status(409).json(accountExistsPayload(existing.email || existing.phone || phone, 'An account already exists for this phone number. Please sign in.'));
  if (existing?.username === username) return res.status(409).json({ message: 'This username is already taken' });

  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
    const passwordHash = await hashPassword(password);
    const now = new Date();
    const user = await User.create({
      name,
      email,
      phone,
      phoneVerifiedAt: now,
      username,
      genderPreference,
      passwordHash,
      passwordSetAt: now,
      devMode: isDevelopmentModeAllowed() && parseBoolean(req.body.devMode),
      avatarPhoto,
      bodyPhoto
    });

    await generateFullBodyProfileInBackground(user._id, bodyPhoto, { enabled: generateFullBody });
    await signupOtpSessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: signupOtpCurrentSessions, purpose: 'signup', phone });
    res.status(201).json(await authenticatedUserPayload(user, req, 'signup'));
  } catch (error) {
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    if (error.code === 11000 && error.keyPattern?.username) return res.status(409).json({ message: 'This username is already taken' });
    if (error.code === 11000 && error.keyPattern?.email) return res.status(409).json(accountExistsPayload(email, 'An account already exists for this email. Please sign in.'));
    if (error.code === 11000 && error.keyPattern?.phone) return res.status(409).json(accountExistsPayload(phone, 'An account already exists for this phone number. Please sign in.'));
    throw error;
  }
}));

router.get('/username-suggestions', usernameSuggestionLimiter, async (req, res) => {
  const base = usernameFromName(req.query.name) || 'fitlook_user';
  const suggestions = [];
  for (let index = 0; suggestions.length < 4 && index < 20; index += 1) {
    const candidate = index === 0 ? base : `${base}${Math.floor(100 + Math.random() * 9000)}`;
    const existing = await User.exists({ username: candidate });
    if (!existing && !suggestions.includes(candidate)) suggestions.push(candidate);
  }
  res.json({ suggestions });
});

router.post('/login', authIpLimiter, loginAttemptLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const identifier = String(req.body.email || req.body.username || '').trim().toLowerCase();
  const { password } = req.body;
  if ((!phone && !identifier) || !password) return res.status(400).json({ message: 'Mobile number or email and password are required' });
  const user = await User.findOne({
    $or: [
      ...(phone ? [{ phone }] : []),
      ...(identifier ? [{ email: identifier }, { username: normalizeUsername(identifier) }] : [])
    ]
  }).select('+passwordHash');
  if (!user) return res.status(401).json({ message: 'Invalid mobile number or password' });
  const passwordVerification = await verifyPassword(password, user.passwordHash);
  if (!passwordVerification.valid) return res.status(401).json({ message: 'Invalid mobile number or password' });
  const accessError = accountAccessError(user);
  if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });
  if (passwordVerification.needsUpgrade) {
    const previousHash = user.passwordHash;
    const upgradedHash = await hashPassword(password);
    await User.updateOne(
      { _id: user._id, passwordHash: previousHash },
      { $set: { passwordHash: upgradedHash } }
    );
  }
  res.json(await authenticatedUserPayload(user, req, 'password'));
}));

router.post('/login/request-otp', otpRequestIpLimiter, otpRequestPhoneLimiter, otpRequestPhoneHourlyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' });
  const user = await User.findOne({ phone });
  if (!user) return res.status(404).json({ message: 'No Lookmefy account found for this phone number' });
  const accessError = accountAccessError(user);
  if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });

  const { otpSession, otp, expiresAt } = await createOtpChallenge({
    sessions: loginOtpSessions,
    currentSessions: loginOtpCurrentSessions,
    purpose: 'login',
    phone,
    metadata: { userId: user._id.toString() }
  });
  try {
    await deliverOtp({ phone, otp, purpose: 'login', otpSession, expiresAt });
  } catch (error) {
    await loginOtpSessions.remove(otpSession);
    await removeCurrentSession({ currentSessions: loginOtpCurrentSessions, purpose: 'login', phone });
    throw error;
  }

  res.json({
    otpSession,
    phone,
    message: 'OTP sent'
  });
}));

router.post('/login/verify-otp', otpAuthIpLimiter, otpVerifyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  const result = await verifyOtpChallenge({
    sessions: loginOtpSessions,
    currentSessions: loginOtpCurrentSessions,
    purpose: 'login',
    phone,
    otpSession,
    otp: req.body?.otp
  });
  if (!result.ok) return res.status(result.status).json({ message: result.message });

  const user = await User.findById(result.session.userId);
  await loginOtpSessions.remove(otpSession);
  await removeCurrentSession({ currentSessions: loginOtpCurrentSessions, purpose: 'login', phone });
  if (!user) return res.status(401).json({ message: 'Account not found. Please sign up again.' });
  const accessError = accountAccessError(user);
  if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });
  res.json(await authenticatedUserPayload(user, req, 'otp'));
}));

router.post('/session/heartbeat', requireUser, sessionHeartbeatLimiter, asyncRoute(async (req, res) => {
  if (!req.sessionId) return res.json({ tracked: false, legacySession: true });
  const session = await touchUserSession({
    userId: req.user._id,
    sessionId: req.sessionId,
    path: normalizeSessionPath(req.body?.path)
  });
  res.json({ tracked: Boolean(session), lastSeenAt: session?.lastSeenAt || null });
}));

router.post('/logout', requireUser, asyncRoute(async (req, res) => {
  const session = req.sessionId
    ? await endUserSession({ userId: req.user._id, sessionId: req.sessionId, path: req.body?.path })
    : null;
  res.json({ loggedOut: true, tracked: Boolean(session), logoutAt: session?.logoutAt || null });
}));

router.post('/login/cancel-otp', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  await cancelOtpChallenge({
    sessions: loginOtpSessions,
    currentSessions: loginOtpCurrentSessions,
    purpose: 'login',
    phone,
    otpSession
  });
  res.json({ cancelled: true });
}));

router.post('/password-reset/request-otp', otpRequestIpLimiter, otpRequestPhoneLimiter, otpRequestPhoneHourlyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ message: 'Enter a valid mobile number.' });

  const user = await User.findOne({ phone });
  const accessError = user ? accountAccessError(user) : null;
  const eligibleUser = user && !accessError ? user : null;

  const { otpSession, otp, expiresAt } = await createOtpChallenge({
    sessions: passwordResetOtpSessions,
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    metadata: eligibleUser ? { userId: eligibleUser._id.toString() } : {}
  });
  if (eligibleUser) {
    try {
      await deliverOtp({ phone, otp, purpose: 'password-reset', otpSession, expiresAt });
    } catch (error) {
      await passwordResetOtpSessions.remove(otpSession);
      await removeCurrentSession({ currentSessions: passwordResetOtpCurrentSessions, purpose: 'password-reset', phone });
      throw error;
    }
  }

  res.json({
    otpSession,
    phone,
    message: 'If an active account exists for this number, an OTP has been sent.'
  });
}));

router.post('/password-reset/verify-otp', otpAuthIpLimiter, otpVerifyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  const result = await verifyOtpChallenge({
    sessions: passwordResetOtpSessions,
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    otpSession,
    otp: req.body?.otp
  });
  if (!result.ok || !result.session?.userId) {
    return res.status(result.status || 400).json({ message: result.message || 'Request a new OTP' });
  }
  res.json({ verified: true, otpSession, phone });
}));

router.post('/password-reset/cancel-otp', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  await cancelOtpChallenge({
    sessions: passwordResetOtpSessions,
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    otpSession
  });
  res.json({ cancelled: true });
}));

router.post('/password-reset', otpAuthIpLimiter, otpVerifyLimiter, asyncRoute(async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otpSession = String(req.body?.otpSession || '');
  const password = String(req.body?.password || '');
  const passwordError = userPasswordError(password);
  if (passwordError) return res.status(400).json({ message: passwordError });

  const pendingSession = await passwordResetOtpSessions.get(otpSession);
  const isCurrent = phone && otpSession
    ? await currentSessionMatches({
      currentSessions: passwordResetOtpCurrentSessions,
      purpose: 'password-reset',
      phone,
      otpSession
    })
    : false;
  if (!pendingSession?.verified || pendingSession.phone !== phone || !pendingSession.userId || !isCurrent) {
    return res.status(400).json({ message: 'Verify your mobile number again before resetting the password.' });
  }

  const passwordHash = await hashPassword(password);
  const resetSession = await passwordResetOtpSessions.consume(otpSession);
  const isStillCurrent = await currentSessionMatches({
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    otpSession
  });
  if (!resetSession?.verified || resetSession.phone !== phone || resetSession.userId !== pendingSession.userId || !isStillCurrent) {
    return res.status(400).json({ message: 'This password reset has expired or already been used.' });
  }
  await removeCurrentSession({ currentSessions: passwordResetOtpCurrentSessions, purpose: 'password-reset', phone });

  const user = await User.findOneAndUpdate(
    { _id: resetSession.userId, phone, $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }] },
    { $set: { passwordHash, passwordSetAt: new Date(), phoneVerifiedAt: new Date() }, $inc: { authVersion: 1 } },
    { new: true }
  );
  if (!user) return res.status(400).json({ message: 'This password reset is no longer available.' });
  await revokeUserSessions(user._id);

  res.json({ reset: true, message: 'Password reset successfully. Sign in with your new password.' });
}));

router.post('/password/reset', otpAuthIpLimiter, asyncRoute(async (req, res) => {
  const verifiedAction = verifyAuthActionToken(req.body?.resetToken, 'password-reset');
  const phone = verifiedAction?.phone || '';
  const otpSession = verifiedAction?.otpSession || String(req.body?.otpSession || '');
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  const passwordError = userPasswordError(password);
  if (!phone || !otpSession) return res.status(401).json({ message: 'Password reset expired. Verify OTP again.' });
  if (passwordError) return res.status(400).json({ message: passwordError });
  if (confirmPassword && confirmPassword !== password) return res.status(400).json({ message: 'Passwords do not match' });

  const pendingSession = await passwordResetOtpSessions.get(otpSession);
  const isCurrent = await currentSessionMatches({
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    otpSession
  });
  if (!pendingSession?.verified || pendingSession.phone !== phone || !pendingSession.userId || !isCurrent) {
    return res.status(400).json({ message: 'Verify your mobile number again before resetting the password.' });
  }

  const resetSession = await passwordResetOtpSessions.consume(otpSession);
  const isStillCurrent = await currentSessionMatches({
    currentSessions: passwordResetOtpCurrentSessions,
    purpose: 'password-reset',
    phone,
    otpSession
  });
  if (!resetSession?.verified || resetSession.phone !== phone || resetSession.userId !== pendingSession.userId || !isStillCurrent) {
    return res.status(400).json({ message: 'This password reset has expired or already been used.' });
  }
  await removeCurrentSession({ currentSessions: passwordResetOtpCurrentSessions, purpose: 'password-reset', phone });

  const now = new Date();
  const user = await User.findOneAndUpdate(
    { _id: resetSession.userId, phone, $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }] },
    {
      $set: {
        passwordHash: await hashPassword(password),
        passwordSetAt: now,
        phoneVerifiedAt: now
      },
      $inc: { authVersion: 1 }
    },
    { new: true }
  );
  if (!user) return res.status(400).json({ message: 'This password reset is no longer available.' });
  await revokeUserSessions(user._id);
  res.json(await authenticatedUserPayload(user, req, 'password-reset'));
}));

router.post('/admin-request-access', asyncRoute(async (req, res) => {
  const email = normalizeAdminEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const name = normalizeAdminName(req.body?.name, email);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'A valid admin email is required' });
  const passwordError = adminPasswordError(password);
  if (passwordError) return res.status(400).json({ message: passwordError });

  const existing = await AdminUser.findOne({ email }).lean();
  if (existing) {
    const message = existing.status === 'pending'
      ? 'Your access request is already waiting for Master approval'
      : 'An administrator account already exists for this email. Sign in instead.';
    return res.status(409).json({ message });
  }

  let admin;
  try {
    admin = await AdminUser.create({
      name,
      email,
      credentialHash: await hashPassword(password),
      role: 'developer',
      sectionAccess: [],
      status: 'pending'
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: 'An access request already exists for this email' });
    throw error;
  }

  await recordAdminAudit(req, {
    action: 'admin_access_requested',
    entityType: 'admin_user',
    entityId: String(admin._id),
    label: admin.email,
    detail: { status: admin.status }
  });
  res.status(201).json({
    admin: adminToClient(admin),
    message: 'Access request received. You currently have no permissions; a Master must approve your account.'
  });
}));

router.post('/admin-login', asyncRoute(async (req, res) => {
  const email = normalizeAdminEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'A valid admin email is required' });
  if (!password) return res.status(400).json({ message: 'Password is required' });

  const admin = await AdminUser.findOne({ email }).select('+credentialHash');
  if (!admin) return res.status(401).json({ message: 'Invalid admin email or password' });
  const passwordVerification = await verifyPassword(password, admin.credentialHash || '');
  if (!passwordVerification.valid) return res.status(401).json({ message: 'Invalid admin email or password' });
  if (admin.status === 'pending') {
    return res.status(403).json({ message: 'Your account has no permissions yet. A Master must approve your access.' });
  }
  if (admin.status !== 'active') return res.status(403).json({ message: 'This admin account is disabled' });

  if (passwordVerification.needsUpgrade) {
    const previousHash = admin.credentialHash;
    const upgradedHash = await hashPassword(password);
    await AdminUser.updateOne(
      { _id: admin._id, credentialHash: previousHash },
      { $set: { credentialHash: upgradedHash } }
    );
  }

  admin.lastLoginAt = new Date();
  await admin.save();
  const token = await signAdminSession(admin);
  res.json({ token, admin: adminToClient(admin) });
}));

router.get('/admin-session', requireAdmin, (req, res) => {
  res.json({ admin: adminToClient(req.admin) });
});

const userOwnedModels = [
  ['closetItems', ClosetItem],
  ['closetOutfits', ClosetOutfit],
  ['customTryOns', CustomTryOn],
  ['externalTryOns', ExternalTryOn],
  ['generationMetrics', GenerationMetric],
  ['tryOns', TryOn],
  ['events', UserEvent],
  ['preferences', UserPreference],
  ['sessions', UserSession]
];

function userAccountFilter(status) {
  if (status === 'active') return { $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }] };
  if (['banned', 'deleted'].includes(status)) return { accountStatus: status };
  return null;
}

function adminUserPayload(user, lastOrder = null, activity = {}) {
  const latestSession = activity.latestSession || null;
  const lastSeenCandidates = [latestSession?.lastSeenAt, activity.latestEventAt]
    .map((value) => value ? new Date(value) : null)
    .filter((value) => value && Number.isFinite(value.getTime()));
  const lastActiveAt = lastSeenCandidates.sort((left, right) => right - left)[0] || null;
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    username: user.username,
    genderPreference: user.genderPreference || 'other',
    tokens: user.tokens || 0,
    accountStatus: accountStatusFor(user),
    bannedAt: user.bannedAt || null,
    banReason: user.banReason || '',
    deletedAt: user.deletedAt || null,
    devMode: Boolean(user.devMode),
    subscription: {
      planId: user.subscription?.planId || null,
      status: user.subscription?.status || 'none',
      tokensPerMonth: user.subscription?.tokensPerMonth || 0,
      currentPeriodStart: user.subscription?.currentPeriodStart || null,
      currentPeriodEnd: user.subscription?.currentPeriodEnd || null
    },
    bodyPhotoStatus: user.bodyPhoto?.status || (accountStatusFor(user) === 'deleted' ? 'removed' : 'uploaded'),
    joinedAt: user.createdAt,
    lastLoginAt: activity.lastLoginAt || latestSession?.loginAt || null,
    lastActiveAt,
    sessionStatus: latestSession ? sessionDisplayState(latestSession) : (activity.latestEventAt ? 'legacy_activity' : 'not_tracked'),
    totalActiveMs: Number(activity.totalActiveMs || 0),
    sessionCount: Number(activity.sessionCount || 0),
    activityCount: Number(activity.activityCount || 0),
    lastOrder: lastOrder ? {
      id: String(lastOrder._id),
      planName: lastOrder.planName,
      tokens: lastOrder.tokens,
      amount: lastOrder.amount,
      currency: lastOrder.currency,
      status: lastOrder.status,
      createdAt: lastOrder.createdAt
    } : null
  };
}

function preferenceEntries(preference, bucket, limit = 12) {
  const value = preference?.[bucket];
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value || {});
  return entries
    .map(([key, weight]) => ({ key, label: String(key).replace(/_/g, ' '), weight: Math.round(Number(weight || 0) * 10) / 10 }))
    .filter((item) => item.key && item.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
}

function activitySummaryFor(userId, sessionByUser, eventByUser) {
  const key = String(userId);
  const session = sessionByUser.get(key) || {};
  const event = eventByUser.get(key) || {};
  return {
    latestSession: session.latestSession || null,
    lastLoginAt: session.lastLoginAt || null,
    latestEventAt: event.latestEventAt || null,
    totalActiveMs: session.totalActiveMs || 0,
    sessionCount: session.sessionCount || 0,
    activityCount: event.activityCount || 0
  };
}

async function removeUserOwnedData(userId) {
  const results = await Promise.all(userOwnedModels.map(async ([label, model]) => {
    const result = await model.deleteMany({ user: userId });
    return [label, result.deletedCount || 0];
  }));
  return Object.fromEntries(results);
}

async function deleteUserMedia(userId, bodyPhoto) {
  const files = [bodyPhoto, bodyPhoto?.original].filter(Boolean);
  const results = await Promise.allSettled([
    ...files.map((file) => deleteStoredFile(file)),
    deleteStoredPrefix(`users/${userId}`)
  ]);
  return results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || 'Storage cleanup failed');
}

function storedFieldClause(field) {
  return {
    $or: [
      { [`${field}.path`]: { $type: 'string', $ne: '' } },
      { [`${field}.storage`]: { $in: ['bunny', 'local'] } }
    ]
  };
}

function anyStoredFieldClause(fields) {
  return { $or: fields.flatMap((field) => storedFieldClause(field).$or) };
}

function mediaOwner(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    name: user.name || '',
    email: user.email || '',
    accountStatus: accountStatusFor(user)
  };
}

function appendAdminMedia(items, file, metadata) {
  const url = publicUrlForStoredFile(file);
  if (!url) return;
  items.push({
    id: metadata.id,
    group: metadata.group,
    kind: metadata.kind,
    title: metadata.title,
    url,
    path: file?.path || '',
    storage: file?.storage || (file?.path ? (useBunny() ? 'bunny' : 'local') : 'linked'),
    mimetype: file?.mimetype || '',
    size: Number(file?.size || 0),
    mediaType: metadata.group === 'video' || String(file?.mimetype || '').startsWith('video/') ? 'video' : 'image',
    owner: metadata.owner || null,
    related: metadata.related || null,
    createdAt: metadata.createdAt || null
  });
}

async function findStoredMediaRecords(Model, fields, { userId, userField = 'user', limit, populate = [] } = {}) {
  const clauses = [anyStoredFieldClause(fields)];
  if (userId) clauses.push({ [userField]: new mongoose.Types.ObjectId(userId) });
  let query = Model.find(clauses.length === 1 ? clauses[0] : { $and: clauses })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(limit);
  populate.forEach((entry) => {
    query = query.populate(entry);
  });
  return query.lean();
}

async function loadAdminMedia({ type = 'all', userId = '', page = 1, limit = 24 } = {}) {
  const offset = (page - 1) * limit;
  const sourceLimit = offset + limit;
  const include = (group) => type === 'all' || type === group;
  const tasks = [];

  if (include('profile')) {
    tasks.push(findStoredMediaRecords(User, ['bodyPhoto', 'bodyPhoto.original'], {
      userId,
      userField: '_id',
      limit: sourceLimit
    }).then((records) => records.flatMap((user) => {
      const items = [];
      const owner = mediaOwner(user);
      appendAdminMedia(items, user.bodyPhoto, { id: `profile:${user._id}:full`, group: 'profile', kind: 'Full body', title: 'Full-body profile', owner, createdAt: user.bodyPhoto?.generatedAt || user.updatedAt });
      appendAdminMedia(items, user.bodyPhoto?.original, { id: `profile:${user._id}:original`, group: 'profile', kind: 'Original upload', title: 'Original profile upload', owner, createdAt: user.updatedAt });
      return items;
    })));
  }

  if (include('tryon')) {
    tasks.push(findStoredMediaRecords(TryOn, ['image', 'transparentImage'], {
      userId,
      limit: sourceLimit,
      populate: [{ path: 'user', select: 'name email accountStatus' }, { path: 'product', select: 'name brand' }]
    }).then((records) => records.flatMap((record) => {
      const items = [];
      const owner = mediaOwner(record.user);
      const related = record.product ? { id: String(record.product._id), label: record.product.name || record.product.brand || 'Catalog product' } : null;
      appendAdminMedia(items, record.image, { id: `tryon:${record._id}:image`, group: 'tryon', kind: 'Catalog try-on', title: related?.label || 'Catalog try-on', owner, related, createdAt: record.createdAt });
      appendAdminMedia(items, record.transparentImage, { id: `tryon:${record._id}:cutout`, group: 'tryon', kind: 'Try-on cutout', title: `${related?.label || 'Catalog try-on'} cutout`, owner, related, createdAt: record.updatedAt });
      return items;
    })));
    tasks.push(findStoredMediaRecords(CustomTryOn, ['image', 'transparentImage'], {
      userId,
      limit: sourceLimit,
      populate: [{ path: 'user', select: 'name email accountStatus' }]
    }).then((records) => records.flatMap((record) => {
      const items = [];
      const owner = mediaOwner(record.user);
      appendAdminMedia(items, record.image, { id: `custom:${record._id}:image`, group: 'tryon', kind: 'Custom try-on', title: 'Custom garment try-on', owner, createdAt: record.createdAt });
      appendAdminMedia(items, record.transparentImage, { id: `custom:${record._id}:cutout`, group: 'tryon', kind: 'Try-on cutout', title: 'Custom try-on cutout', owner, createdAt: record.updatedAt });
      return items;
    })));
    tasks.push(findStoredMediaRecords(ExternalTryOn, ['image', 'transparentImage'], {
      userId,
      limit: sourceLimit,
      populate: [{ path: 'user', select: 'name email accountStatus' }]
    }).then((records) => records.flatMap((record) => {
      const items = [];
      const owner = mediaOwner(record.user);
      const related = { id: String(record._id), label: record.productName || record.brand || 'External product' };
      appendAdminMedia(items, record.image, { id: `external:${record._id}:image`, group: 'tryon', kind: 'External try-on', title: related.label, owner, related, createdAt: record.createdAt });
      appendAdminMedia(items, record.transparentImage, { id: `external:${record._id}:cutout`, group: 'tryon', kind: 'Try-on cutout', title: `${related.label} cutout`, owner, related, createdAt: record.updatedAt });
      return items;
    })));
    tasks.push(findStoredMediaRecords(ClosetOutfit, ['image', 'transparentImage'], {
      userId,
      limit: sourceLimit,
      populate: [{ path: 'user', select: 'name email accountStatus' }]
    }).then((records) => records.flatMap((record) => {
      const items = [];
      const owner = mediaOwner(record.user);
      appendAdminMedia(items, record.image, { id: `outfit:${record._id}:image`, group: 'tryon', kind: 'Closet outfit', title: record.title || 'Generated outfit', owner, createdAt: record.createdAt });
      appendAdminMedia(items, record.transparentImage, { id: `outfit:${record._id}:cutout`, group: 'tryon', kind: 'Outfit cutout', title: `${record.title || 'Generated outfit'} cutout`, owner, createdAt: record.updatedAt });
      return items;
    })));
  }

  if (include('video')) {
    tasks.push(findStoredMediaRecords(TryOn, ['video'], {
      userId,
      limit: sourceLimit,
      populate: [{ path: 'user', select: 'name email accountStatus' }, { path: 'product', select: 'name brand' }]
    }).then((records) => records.map((record) => {
      const items = [];
      const related = record.product ? { id: String(record.product._id), label: record.product.name || record.product.brand || 'Catalog product' } : null;
      appendAdminMedia(items, record.video, {
        id: `tryon:${record._id}:video`,
        group: 'video',
        kind: 'Generated video',
        title: related?.label || 'Try-on video',
        owner: mediaOwner(record.user),
        related,
        createdAt: record.video?.generatedAt || record.updatedAt
      });
      return items[0];
    }).filter(Boolean)));
  }

  if (include('closet')) {
    tasks.push(findStoredMediaRecords(CustomTryOn, ['garment'], { userId, limit: sourceLimit, populate: [{ path: 'user', select: 'name email accountStatus' }] }).then((records) => records.map((record) => {
      const items = [];
      appendAdminMedia(items, record.garment, { id: `custom:${record._id}:garment`, group: 'closet', kind: 'Custom garment', title: 'Custom garment upload', owner: mediaOwner(record.user), createdAt: record.createdAt });
      return items[0];
    }).filter(Boolean)));
    tasks.push(findStoredMediaRecords(ClosetOutfit, ['garment'], { userId, limit: sourceLimit, populate: [{ path: 'user', select: 'name email accountStatus' }] }).then((records) => records.map((record) => {
      const items = [];
      appendAdminMedia(items, record.garment, { id: `outfit:${record._id}:garment`, group: 'closet', kind: 'Outfit garment', title: `${record.title || 'Generated outfit'} garment`, owner: mediaOwner(record.user), createdAt: record.createdAt });
      return items[0];
    }).filter(Boolean)));
    tasks.push(findStoredMediaRecords(ClosetItem, ['image'], { userId, limit: sourceLimit, populate: [{ path: 'user', select: 'name email accountStatus' }] }).then((records) => records.map((record) => {
      const items = [];
      appendAdminMedia(items, record.image, { id: `closet:${record._id}:image`, group: 'closet', kind: 'Closet item', title: record.name || 'Closet item', owner: mediaOwner(record.user), createdAt: record.createdAt });
      return items[0];
    }).filter(Boolean)));
  }

  if (!userId && include('product')) {
    tasks.push(findStoredMediaRecords(Product, ['image'], { limit: sourceLimit }).then((records) => records.map((record) => {
      const items = [];
      appendAdminMedia(items, record.image, { id: `product:${record._id}:image`, group: 'product', kind: 'Product image', title: record.name || 'Catalog product', related: { id: String(record._id), label: record.brand || record.category || 'Catalog product' }, createdAt: record.createdAt });
      return items[0];
    }).filter(Boolean)));
  }

  const [sourceItems, mediaUsage] = await Promise.all([Promise.all(tasks), adminMediaUsage(userId)]);
  const { counts, usage } = mediaUsage;
  const items = sourceItems.flat().sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
  const total = type === 'all' ? counts.all : counts[type] || 0;
  return {
    items: items.slice(offset, offset + limit),
    counts,
    usage,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    provider: useBunny() ? 'bunny' : 'local'
  };
}

router.get('/admin/users', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 150);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 10_000);
  const offset = (page - 1) * limit;
  const sortName = String(req.query.sort || 'newest').trim().toLowerCase();
  const sorts = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    name: { name: 1, createdAt: -1 },
    tokens_desc: { tokens: -1, createdAt: -1 },
    tokens_asc: { tokens: 1, createdAt: -1 }
  };
  if (!sorts[sortName]) return res.status(400).json({ message: 'Invalid user sort' });
  if (status && !['active', 'banned', 'deleted'].includes(status)) return res.status(400).json({ message: 'Invalid account status' });
  const clauses = [];
  const statusFilter = userAccountFilter(status);
  if (statusFilter) clauses.push(statusFilter);
  const searchFilter = buildAdminUserSearchFilter(q);
  if (searchFilter) clauses.push(searchFilter);
  try {
    const tokenFilter = buildAdminUserTokenFilter(req.query.minTokens, req.query.maxTokens);
    if (tokenFilter) clauses.push(tokenFilter);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  const filter = clauses.length ? { $and: clauses } : {};

  const [users, filteredTotal] = await Promise.all([
    User.find(filter).sort(sorts[sortName]).skip(offset).limit(limit).lean(),
    User.countDocuments(filter)
  ]);
  const userIds = users.map((user) => user._id);
  const [orders, sessionRollups, eventRollups] = await Promise.all([
    TokenOrder.find({ user: { $in: userIds } }).sort({ createdAt: -1 }).lean(),
    UserSession.aggregate([
      { $match: { user: { $in: userIds } } },
      { $sort: { lastSeenAt: -1 } },
      {
        $group: {
          _id: '$user',
          latestSession: { $first: '$$ROOT' },
          lastLoginAt: { $max: '$loginAt' },
          totalActiveMs: { $sum: '$activeDurationMs' },
          sessionCount: { $sum: 1 }
        }
      }
    ]),
    UserEvent.aggregate([
      { $match: { user: { $in: userIds } } },
      { $group: { _id: '$user', latestEventAt: { $max: '$createdAt' }, activityCount: { $sum: 1 } } }
    ])
  ]);
  const latestOrderByUser = new Map();
  orders.forEach((order) => {
    const key = String(order.user);
    if (!latestOrderByUser.has(key)) latestOrderByUser.set(key, order);
  });
  const sessionByUser = new Map(sessionRollups.map((item) => [String(item._id), item]));
  const eventByUser = new Map(eventRollups.map((item) => [String(item._id), item]));

  const [totalUsers, activeUsers, bannedUsers, deletedUsers, tokenTotal] = await Promise.all([
    User.countDocuments(),
    User.countDocuments(userAccountFilter('active')),
    User.countDocuments(userAccountFilter('banned')),
    User.countDocuments(userAccountFilter('deleted')),
    User.aggregate([
      { $match: { accountStatus: { $ne: 'deleted' } } },
      { $group: { _id: null, total: { $sum: '$tokens' } } }
    ])
  ]);

  res.json({
    users: users.map((user) => adminUserPayload(
      user,
      latestOrderByUser.get(String(user._id)),
      activitySummaryFor(user._id, sessionByUser, eventByUser)
    )),
    totals: {
      users: totalUsers,
      loaded: users.length,
      tokens: tokenTotal[0]?.total || 0,
      active: activeUsers,
      banned: bannedUsers,
      deleted: deletedUsers
    },
    pagination: { page, limit, total: filteredTotal, pages: Math.max(1, Math.ceil(filteredTotal / limit)), sort: sortName }
  });
});

function escapedSearch(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function orderToAdmin(order) {
  return {
    id: String(order._id),
    merchantOrderId: order.merchantOrderId,
    planName: order.planName,
    tokens: order.tokens,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt,
    creditedAt: order.creditedAt,
    user: order.user ? {
      id: String(order.user._id),
      name: order.user.name,
      email: order.user.email,
      username: order.user.username
    } : null
  };
}

router.get('/admin/search', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ products: [], users: [] });
  const expression = new RegExp(escapedSearch(q.slice(0, 120)), 'i');
  const userFilter = buildAdminUserSearchFilter(q);
  const [products, users] = await Promise.all([
    Product.find({ $or: [{ name: expression }, { brand: expression }, { category: expression }, { tags: expression }] }).sort({ createdAt: -1 }).limit(8).lean(),
    User.find(userFilter || {}).sort({ createdAt: -1 }).limit(8).lean()
  ]);
  res.json({
    products: products.map((product) => ({ id: String(product._id), name: product.name, brand: product.brand, category: product.category, imageUrl: publicUrlForStoredFile(product.image) })),
    users: users.map((user) => adminUserPayload(user))
  });
});

router.get('/admin/users/:id/insights', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid user id' });
  const activityPage = Math.min(Math.max(Number(req.query.activityPage) || 1, 1), 200);
  const activityLimit = Math.min(Math.max(Number(req.query.activityLimit) || 24, 1), 50);
  const activityOffset = (activityPage - 1) * activityLimit;
  const userId = new mongoose.Types.ObjectId(req.params.id);
  const user = await User.findById(userId).lean();
  if (!user) return res.status(404).json({ message: 'User not found' });

  const [sessions, sessionTotal, sessionTotals, events, eventTotals, preference, topProducts] = await Promise.all([
    UserSession.find({ user: userId }).sort({ loginAt: -1 }).limit(30).lean(),
    UserSession.countDocuments({ user: userId }),
    UserSession.aggregate([
      { $match: { user: userId } },
      { $group: { _id: null, activeDurationMs: { $sum: '$activeDurationMs' }, pageViews: { $sum: '$pageViewCount' }, eventCount: { $sum: '$eventCount' } } }
    ]),
    UserEvent.find({ user: userId })
      .sort({ createdAt: -1 })
      .skip(activityOffset)
      .limit(activityLimit)
      .populate('product', 'name brand category image')
      .lean(),
    UserEvent.aggregate([
      { $match: { user: userId } },
      { $group: { _id: null, activityCount: { $sum: 1 }, latestEventAt: { $max: '$createdAt' } } }
    ]),
    UserPreference.findOne({ user: userId }).lean(),
    UserEvent.aggregate([
      { $match: { user: userId, product: { $exists: true, $ne: null }, type: { $in: ['product_view', 'product_click', 'wishlist', 'try_on', 'shop_click'] } } },
      { $group: { _id: '$product', interactions: { $sum: 1 }, weight: { $sum: '$weight' }, lastAt: { $max: '$createdAt' } } },
      { $sort: { weight: -1, interactions: -1, lastAt: -1 } },
      { $limit: 10 },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $project: { interactions: 1, weight: 1, lastAt: 1, name: '$product.name', brand: '$product.brand', category: '$product.category', image: '$product.image' } }
    ])
  ]);

  const latestLoginSession = sessions[0] || null;
  const latestSession = [...sessions].sort((left, right) => new Date(right.lastSeenAt || 0) - new Date(left.lastSeenAt || 0))[0] || null;
  const latestEventAt = eventTotals[0]?.latestEventAt || null;
  const eventTotal = Number(eventTotals[0]?.activityCount || 0);
  const summary = activitySummaryFor(userId, new Map([[String(userId), {
    latestSession,
    lastLoginAt: latestLoginSession?.loginAt || null,
    totalActiveMs: sessionTotals[0]?.activeDurationMs || 0,
    sessionCount: sessionTotal
  }]]), new Map([[String(userId), { latestEventAt, activityCount: eventTotal }]]));
  const averagePreferredPrice = Number(preference?.priceCount || 0) > 0
    ? Math.round(Number(preference.priceTotal || 0) / Number(preference.priceCount || 1))
    : 0;

  res.json({
    user: adminUserPayload(user, null, summary),
    summary: {
      lastLoginAt: latestLoginSession?.loginAt || null,
      lastActiveAt: adminUserPayload(user, null, summary).lastActiveAt,
      sessionStatus: latestSession ? sessionDisplayState(latestSession) : (latestEventAt ? 'legacy_activity' : 'not_tracked'),
      totalActiveMs: Number(sessionTotals[0]?.activeDurationMs || 0),
      sessionCount: sessionTotal,
      activityCount: eventTotal,
      pageViews: Number(sessionTotals[0]?.pageViews || 0)
    },
    sessions: sessions.map((session) => sessionToAdmin(session)),
    activity: events.map((event) => ({
      id: String(event._id),
      type: event.type,
      query: event.query || '',
      path: event.path || '',
      source: event.source || '',
      metadata: event.metadata || {},
      weight: Number(event.weight || 0),
      sessionId: event.session ? String(event.session) : null,
      product: event.product ? {
        id: String(event.product._id),
        name: event.product.name,
        brand: event.product.brand,
        category: event.product.category,
        imageUrl: publicUrlForStoredFile(event.product.image)
      } : null,
      createdAt: event.createdAt
    })),
    activityPagination: {
      page: activityPage,
      pages: Math.max(1, Math.ceil(eventTotal / activityLimit)),
      total: eventTotal
    },
    preferences: {
      explicitGender: user.genderPreference || 'other',
      averagePreferredPrice,
      categories: preferenceEntries(preference, 'categories'),
      brands: preferenceEntries(preference, 'brands'),
      tags: preferenceEntries(preference, 'tags'),
      genders: preferenceEntries(preference, 'genders'),
      updatedAt: preference?.updatedAt || null
    },
    topProducts: topProducts.map((item) => ({
      id: String(item._id),
      name: item.name,
      brand: item.brand,
      category: item.category,
      imageUrl: publicUrlForStoredFile(item.image),
      interactions: item.interactions,
      weight: Math.round(Number(item.weight || 0) * 10) / 10,
      lastAt: item.lastAt
    }))
  });
});

router.get('/admin/users/:id/media', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid user id' });
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 100);
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 48);
  const user = await User.findById(req.params.id).lean();
  if (!user) return res.status(404).json({ message: 'User not found' });
  const media = await loadAdminMedia({ type: 'all', userId: req.params.id, page, limit });
  res.json({ user: adminUserPayload(user), ...media });
});

router.get('/admin/storage', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  const type = String(req.query.type || 'all').trim().toLowerCase();
  if (!['all', 'profile', 'tryon', 'video', 'closet', 'product'].includes(type)) {
    return res.status(400).json({ message: 'Invalid storage media type' });
  }
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 100);
  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 48);
  res.json(await loadAdminMedia({ type, page, limit }));
});

router.get('/admin/storage/reconciliation', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (_req, res) => {
  res.json(await reconcileBunnyInventory());
});

router.delete('/admin/storage/orphans', requireAdmin, requireUserOperationsAdmin, adminWriteLimiter, async (req, res) => {
  if (String(req.body?.confirmation || '') !== 'DELETE') {
    return res.status(400).json({ message: 'Type DELETE to confirm orphan deletion' });
  }
  const result = await deleteBunnyOrphans(Array.isArray(req.body?.keys) ? req.body.keys : []);
  await recordAdminAudit(req, {
    action: 'storage_orphans_deleted',
    entityType: 'bunny_storage',
    label: `${result.deleted.length} orphan files`,
    detail: result
  });
  res.json(result);
});

router.get('/admin/operations', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (_req, res) => {
  const [orders, orderTotals] = await Promise.all([
    TokenOrder.find({}).sort({ createdAt: -1 }).limit(12).populate('user', 'name email username').lean(),
    TokenOrder.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, tokens: { $sum: '$tokens' }, amount: { $sum: '$amount' } } }])
  ]);

  res.json({
    orders: orders.map(orderToAdmin),
    orderTotals: orderTotals.reduce((acc, item) => {
      acc[item._id || 'unknown'] = { count: item.count || 0, tokens: item.tokens || 0, amount: item.amount || 0 };
      return acc;
    }, {})
  });
});

router.get('/admin/orders', requireAdmin, requireUserOperationsAdmin, adminReadLimiter, async (req, res) => {
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 10_000);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const status = String(req.query.status || '').trim().toLowerCase();
  const q = String(req.query.q || '').trim();
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const expression = new RegExp(escapedSearch(q.slice(0, 120)), 'i');
    const users = await User.find({ $or: [{ name: expression }, { email: expression }, { username: expression }, { phone: expression }] }).select('_id').limit(500).lean();
    filter.$or = [{ merchantOrderId: expression }, { planName: expression }, { user: { $in: users.map((user) => user._id) } }];
  }
  const [orders, total, orderTotals] = await Promise.all([
    TokenOrder.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('user', 'name email username').lean(),
    TokenOrder.countDocuments(filter),
    TokenOrder.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, tokens: { $sum: '$tokens' }, amount: { $sum: '$amount' } } }])
  ]);
  res.json({
    orders: orders.map(orderToAdmin),
    orderTotals: orderTotals.reduce((acc, item) => {
      acc[item._id || 'unknown'] = { count: item.count || 0, tokens: item.tokens || 0, amount: item.amount || 0 };
      return acc;
    }, {}),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  });
});

router.get('/admin/audit-log', requireAdmin, requireSystemAdmin, adminReadLimiter, async (req, res) => {
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 10_000);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const action = String(req.query.action || '').trim();
  const actor = String(req.query.actor || '').trim();
  const q = String(req.query.q || '').trim();
  const from = req.query.from ? new Date(req.query.from) : null;
  const filter = {};
  if (action) filter.action = action;
  if (actor) filter.actorEmail = actor;
  if (q) {
    const expression = new RegExp(escapedSearch(q.slice(0, 120)), 'i');
    filter.$or = [{ action: expression }, { actorEmail: expression }, { entityType: expression }, { entityId: expression }, { label: expression }];
  }
  if (from && !Number.isNaN(from.getTime())) filter.createdAt = { $gte: from };
  const [auditLogs, total, actions, actors] = await Promise.all([
    AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AdminAuditLog.countDocuments(filter),
    AdminAuditLog.distinct('action'),
    AdminAuditLog.distinct('actorEmail')
  ]);
  res.json({
    auditLogs: auditLogs.map((log) => ({
      id: String(log._id),
      actorAdminId: log.actorAdmin ? String(log.actorAdmin) : null,
      actorEmail: log.actorEmail,
      actorRole: log.actorRole || '',
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      label: log.label,
      detail: log.detail,
      createdAt: log.createdAt
    })),
    facets: { actions: actions.filter(Boolean).sort(), actors: actors.filter(Boolean).sort() },
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  });
});

router.patch('/admin/users/:id/tokens', requireAdmin, requireUserOperationsAdmin, adminWriteLimiter, async (req, res) => {
  const mode = String(req.body?.mode || 'set').toLowerCase();
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid user id' });

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (accountStatusFor(user) === 'deleted') return res.status(409).json({ message: 'Cannot change tokens for a deleted account' });
  const amount = Number(req.body?.amount);
  const previousTokens = Number(user.tokens || 0);
  try {
    user.tokens = tokenBalanceAfter({ current: previousTokens, mode, amount });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  await user.save();
  await recordAdminAudit(req, {
    action: mode === 'add' ? 'tokens_added' : 'tokens_set',
    entityType: 'user',
    entityId: user._id.toString(),
    label: user.email,
    detail: { amount, previousTokens, nextTokens: user.tokens }
  });

  res.json({ user: adminUserPayload(user) });
});

router.patch('/admin/users/:id/status', requireAdmin, requireUserOperationsAdmin, adminWriteLimiter, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid user id' });
  const status = String(req.body?.status || '').trim().toLowerCase();
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!['active', 'banned'].includes(status)) return res.status(400).json({ message: 'Account status must be active or banned' });
  if (status === 'banned' && !reason) return res.status(400).json({ message: 'A ban reason is required' });

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  if (accountStatusFor(user) === 'deleted') return res.status(409).json({ message: 'A deleted account cannot be restored' });

  const previousStatus = accountStatusFor(user);
  user.accountStatus = status;
  if (status === 'banned') {
    user.bannedAt = new Date();
    user.banReason = reason;
    user.bannedBy = req.admin?.email || 'admin';
  } else {
    user.bannedAt = undefined;
    user.banReason = undefined;
    user.bannedBy = undefined;
  }
  await user.save();
  if (status === 'banned') await revokeUserSessions(user._id);
  await recordAdminAudit(req, {
    action: status === 'banned' ? 'user_banned' : 'user_unbanned',
    entityType: 'user',
    entityId: user._id.toString(),
    label: user.email,
    detail: { previousStatus, status, reason: status === 'banned' ? reason : undefined }
  });
  res.json({ user: adminUserPayload(user) });
});

router.delete('/admin/users/:id', requireAdmin, requireUserOperationsAdmin, adminWriteLimiter, async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: 'Invalid user id' });
  if (String(req.body?.confirmation || '') !== 'ANONYMIZE') {
    return res.status(400).json({ message: 'Type ANONYMIZE to confirm account removal' });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const userId = user._id.toString();
  const bodyPhoto = user.bodyPhoto?.toObject ? user.bodyPhoto.toObject() : user.bodyPhoto;

  if (accountStatusFor(user) !== 'deleted') {
    const identity = anonymizedIdentity(userId);
    user.name = identity.name;
    user.email = identity.email;
    user.username = identity.username;
    user.phone = undefined;
    user.passwordHash = await hashPassword(randomBytes(48).toString('hex'));
    user.genderPreference = 'other';
    user.tokens = 0;
    user.devMode = false;
    user.wishlistProducts = [];
    user.subscription = { status: 'none', tokensPerMonth: 0 };
    user.bodyPhoto = undefined;
    user.onboardingSeenAt = undefined;
    user.accountStatus = 'deleted';
    user.deletedAt = new Date();
    user.bannedAt = undefined;
    user.banReason = undefined;
    user.bannedBy = undefined;
    await user.save();
  }

  const removedData = await removeUserOwnedData(user._id);
  await AdminAuditLog.updateMany(
    { entityType: 'user', entityId: userId },
    { $set: { label: `Deleted user ${userId.slice(-6)}` } }
  );
  const storageWarnings = await deleteUserMedia(userId, bodyPhoto);
  await recordAdminAudit(req, {
    action: 'user_anonymized',
    entityType: 'user',
    entityId: userId,
    label: `Deleted user ${userId.slice(-6)}`,
    detail: { removedData, paymentRecordsPreserved: true, storageWarnings: storageWarnings.length }
  });
  res.json({
    user: adminUserPayload(user),
    removedData,
    paymentRecordsPreserved: true,
    storageCleanupComplete: storageWarnings.length === 0,
    storageWarnings
  });
});

router.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user.toClient(), mediaToken: signUserMediaToken(req.user._id) });
});

router.get('/media-token', requireUser, (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ mediaToken: signUserMediaToken(req.user._id) });
});

router.get('/media/:kind/:id', asyncRoute(async (req, res) => {
  const kind = String(req.params.kind || '').trim().toLowerCase();
  if (!['avatar', 'body', 'body-original'].includes(kind)) return res.status(404).json({ message: 'Profile media not found' });

  let decoded;
  try {
    decoded = verifyUserMediaToken(mediaTokenFromRequest(req));
  } catch {
    return res.status(401).json({ message: 'Profile media link expired' });
  }

  const userId = String(req.params.id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(userId) || String(decoded.sub) !== userId) {
    return res.status(404).json({ message: 'Profile media not found' });
  }

  const user = await User.findById(userId).select('avatarPhoto bodyPhoto accountStatus').lean();
  if (!user) return res.status(404).json({ message: 'Profile media not found' });
  const accessError = accountAccessError(user);
  if (accessError) return res.status(accessError.statusCode).json({ message: accessError.message });

  const file = profileMediaFileForKind(user, kind);
  if (!file?.path && !file?.url) return res.status(404).json({ message: 'Profile media not found' });
  const stored = await readStoredFile(file, 'profile media');
  res.set({
    'Content-Type': stored.mimetype || file.mimetype || 'image/jpeg',
    'Cache-Control': 'private, max-age=300'
  });
  res.send(stored.buffer);
}));

router.patch('/profile', requireUser, profilePhotoLimiter, upload.single('bodyPhoto'), asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const genderPreference = normalizeGenderPreference(req.body?.genderPreference);
  const requireBodyPhoto = parseBoolean(req.body?.requireBodyPhoto);

  if (Object.hasOwn(req.body || {}, 'name') && (!name || name.length < 2)) return res.status(400).json({ message: 'Enter your full name' });
  if (Object.hasOwn(req.body || {}, 'genderPreference') && !genderPreference) return res.status(400).json({ message: 'Choose your gender preference' });
  if (requireBodyPhoto && !req.file && !req.user.bodyPhoto?.path && !req.user.bodyPhoto?.url) {
    return res.status(400).json({ message: 'Upload a profile photo' });
  }

  try {
    if (name) req.user.name = name;
    if (genderPreference) req.user.genderPreference = genderPreference;

    if (req.file) {
      const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
      const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
      req.user.avatarPhoto = avatarPhoto;
      req.user.bodyPhoto = bodyPhoto;
      req.user.avatarCrop = undefined;
      await req.user.save();
      await generateFullBodyProfileInBackground(req.user._id, bodyPhoto, { enabled: generateFullBody });
    } else {
      await req.user.save();
    }

    res.json({ user: req.user.toClient() });
  } catch (error) {
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    throw error;
  }
}));

router.patch('/avatar-crop', requireUser, asyncRoute(async (req, res) => {
  req.user.avatarCrop = normalizeAvatarCropInput(req.body?.avatarCrop || req.body);
  await req.user.save();
  res.json({ user: req.user.toClient() });
}));

function addStoredFile(files, file) {
  if (!file) return;
  const value = file.toObject ? file.toObject() : file;
  if (value.path || value.url || value.storage) files.push(value);
}

function collectAccountMediaFiles(user, records) {
  const files = [];
  addStoredFile(files, user.avatarPhoto);
  const bodyPhoto = user.bodyPhoto?.toObject ? user.bodyPhoto.toObject() : user.bodyPhoto;
  addStoredFile(files, bodyPhoto);
  addStoredFile(files, bodyPhoto?.original);

  records.tryOns.forEach((item) => {
    addStoredFile(files, item.image);
    addStoredFile(files, item.transparentImage);
    addStoredFile(files, item.video);
  });
  records.customTryOns.forEach((item) => {
    addStoredFile(files, item.garment);
    addStoredFile(files, item.image);
    addStoredFile(files, item.transparentImage);
  });
  records.externalTryOns.forEach((item) => {
    addStoredFile(files, item.image);
    addStoredFile(files, item.transparentImage);
  });
  records.closetItems.forEach((item) => addStoredFile(files, item.image));
  records.closetOutfits.forEach((item) => {
    addStoredFile(files, item.garment);
    addStoredFile(files, item.image);
    addStoredFile(files, item.transparentImage);
  });

  return files;
}

router.delete('/me', requireUser, accountDeleteLimiter, asyncRoute(async (req, res) => {
  if (String(req.body?.confirmation || '') !== 'DELETE') {
    return res.status(400).json({ message: 'Type DELETE to confirm account deletion.' });
  }

  const userId = req.user._id;
  const [tryOns, customTryOns, externalTryOns, closetItems, closetOutfits] = await Promise.all([
    TryOn.find({ user: userId }).select('image transparentImage video').lean(),
    CustomTryOn.find({ user: userId }).select('garment image transparentImage').lean(),
    ExternalTryOn.find({ user: userId }).select('image transparentImage').lean(),
    ClosetItem.find({ user: userId }).select('image').lean(),
    ClosetOutfit.find({ user: userId }).select('garment image transparentImage').lean()
  ]);

  const mediaFiles = collectAccountMediaFiles(req.user, { tryOns, customTryOns, externalTryOns, closetItems, closetOutfits });
  await Promise.allSettled(mediaFiles.map((file) => deleteStoredFile(file)));

  const [
    deletedTryOns,
    deletedCustomTryOns,
    deletedExternalTryOns,
    deletedClosetItems,
    deletedClosetOutfits,
    deletedTokenOrders,
    deletedEvents,
    deletedPreferences,
    deletedUser
  ] = await Promise.all([
    TryOn.deleteMany({ user: userId }),
    CustomTryOn.deleteMany({ user: userId }),
    ExternalTryOn.deleteMany({ user: userId }),
    ClosetItem.deleteMany({ user: userId }),
    ClosetOutfit.deleteMany({ user: userId }),
    TokenOrder.deleteMany({ user: userId }),
    UserEvent.deleteMany({ user: userId }),
    UserPreference.deleteMany({ user: userId }),
    User.deleteOne({ _id: userId })
  ]);

  res.json({
    deleted: Boolean(deletedUser.deletedCount),
    counts: {
      tryOns: deletedTryOns.deletedCount || 0,
      customTryOns: deletedCustomTryOns.deletedCount || 0,
      externalTryOns: deletedExternalTryOns.deletedCount || 0,
      closetItems: deletedClosetItems.deletedCount || 0,
      closetOutfits: deletedClosetOutfits.deletedCount || 0,
      tokenOrders: deletedTokenOrders.deletedCount || 0,
      events: deletedEvents.deletedCount || 0,
      preferences: deletedPreferences.deletedCount || 0
    }
  });
}));

router.patch('/onboarding', requireUser, async (req, res) => {
  if (!req.user.onboardingSeenAt) {
    req.user.onboardingSeenAt = new Date();
    await req.user.save();
  }
  res.json({ user: req.user.toClient() });
});

function validWishlistProductIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => mongoose.Types.ObjectId.isValid(value)))];
}

async function wishlistPayload(user) {
  const productIds = validWishlistProductIds(user.wishlistProducts || []);
  if (!productIds.length) return { productIds: [], products: [] };

  const products = await Product.find({ _id: { $in: productIds }, isActive: true, $and: [availableStatusClause()] }).lean();
  const productsById = new Map(products.map((product) => [product._id.toString(), product]));
  const activeProductIds = productIds.filter((id) => productsById.has(id));

  if (activeProductIds.length !== productIds.length) {
    user.wishlistProducts = activeProductIds;
    await user.save();
  }

  return {
    productIds: activeProductIds,
    products: activeProductIds.map((id) => productToClient(productsById.get(id)))
  };
}

router.get('/wishlist', requireUser, async (req, res) => {
  res.json(await wishlistPayload(req.user));
});

router.post('/wishlist/sync', requireUser, async (req, res) => {
  const localProductIds = validWishlistProductIds(req.body?.productIds);
  const existingProductIds = validWishlistProductIds(req.user.wishlistProducts || []);
  const requestedProductIds = [...new Set([...localProductIds, ...existingProductIds])];
  const activeProducts = requestedProductIds.length
    ? await Product.find({ _id: { $in: requestedProductIds }, isActive: true, $and: [availableStatusClause()] }).select('_id').lean()
    : [];
  const activeIds = new Set(activeProducts.map((product) => product._id.toString()));

  req.user.wishlistProducts = requestedProductIds.filter((id) => activeIds.has(id));
  await req.user.save();
  res.json(await wishlistPayload(req.user));
});

router.put('/wishlist/:productId', requireUser, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(productId)) return res.status(400).json({ message: 'Invalid product' });
  const product = await Product.findOne({ _id: productId, isActive: true, $and: [availableStatusClause()] }).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });

  await User.updateOne({ _id: req.user._id }, { $addToSet: { wishlistProducts: product._id } });
  res.json({ saved: true, product: productToClient(product) });
});

router.delete('/wishlist/:productId', requireUser, async (req, res) => {
  const productId = String(req.params.productId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(productId)) return res.status(400).json({ message: 'Invalid product' });

  await User.updateOne({ _id: req.user._id }, { $pull: { wishlistProducts: productId } });
  res.json({ saved: false, productId });
});

router.patch('/dev-mode', requireUser, async (req, res) => {
  if (!isDevelopmentModeAllowed()) return res.status(404).json({ message: 'Not found' });
  req.user.devMode = parseBoolean(req.body?.devMode);
  await req.user.save();
  res.json({ user: req.user.toClient() });
});

router.post('/body-photo', requireUser, profilePhotoLimiter, upload.single('bodyPhoto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Upload a profile photo first' });
  try {
    const generateFullBody = shouldGenerateFullBodyProfileForRequest(req);
    const { avatarPhoto, bodyPhoto } = await profilePhotosFromUpload(req.file, { generateFullBody });
    req.user.avatarPhoto = avatarPhoto;
    req.user.bodyPhoto = bodyPhoto;
    req.user.avatarCrop = undefined;
    await req.user.save();
    await generateFullBodyProfileInBackground(req.user._id, bodyPhoto, { enabled: generateFullBody });
    res.json({ user: req.user.toClient() });
  } catch (error) {
    if (isBodyPhotoPreparationError(error)) return res.status(400).json({ message: error.message });
    throw error;
  }
});

router.post('/body-photo/generate-full-body', requireUser, profilePhotoLimiter, asyncRoute(async (req, res) => {
  if (!shouldGenerateFullBodyProfile()) return res.status(400).json({ message: 'AI full-body profile generation is disabled' });
  const currentBodyPhoto = req.user.bodyPhoto?.toObject ? req.user.bodyPhoto.toObject() : req.user.bodyPhoto;
  const sourceBodyPhoto = currentBodyPhoto?.original || currentBodyPhoto;
  if (!sourceBodyPhoto?.path && !sourceBodyPhoto?.url) return res.status(400).json({ message: 'Upload a profile photo first' });

  if (currentBodyPhoto?.status === 'generating') {
    return res.json({ user: req.user.toClient() });
  }

  req.user.bodyPhoto = {
    ...sourceBodyPhoto,
    status: 'generating',
    source: 'upload',
    error: undefined,
    original: sourceBodyPhoto
  };
  await req.user.save();
  await generateFullBodyProfileInBackground(req.user._id, req.user.bodyPhoto.toObject ? req.user.bodyPhoto.toObject() : req.user.bodyPhoto, { enabled: true });
  res.json({ user: req.user.toClient() });
}));

export default router;
export {
  phoneEmail,
  normalizeAvatarCropInput,
  profileMediaFileForKind,
  requireUser,
  runProfileFullBodyJob,
  signAuthActionToken,
  verifyAuthActionToken
};
