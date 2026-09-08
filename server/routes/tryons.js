import express from 'express';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import CreditEvent from '../models/CreditEvent.js';
import CustomTryOn from '../models/CustomTryOn.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import Product, { productToClient } from '../models/Product.js';
import TryOn, { tryOnToClient } from '../models/TryOn.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { accountAccessError } from '../utils/accountState.js';
import { availableStatusClause } from '../utils/productAvailability.js';
import { inferTryOnModel, normalizeTryOnModel } from '../utils/tryOnModel.js';
import { wearableCompatibility } from '../utils/wearable.js';
import { genderCompatibility } from '../utils/genderPreference.js';
import { isolateSubjectAsset } from '../utils/backgroundRemoval.js';
import { recordGenerationMetric } from '../utils/generationMetrics.js';
import { signMediaToken, verifyMediaToken } from '../utils/mediaTokens.js';
import { enqueueJob, enqueueJobAndWait, safeJobId } from '../utils/jobQueue.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { readStoredFile, saveBuffer, storedFileSignature } from '../utils/storage.js';
import {
  developmentBillingBypass,
  isAllowedRasterImageUpload,
  normalizeRasterImageBuffer,
  safeFetchBuffer,
  safeFetchImageBuffer
} from '../utils/security.js';
import {
  createPrunaPrediction,
  downloadPrunaOutput,
  fetchPrunaOutput,
  firstPrunaGenerationUrl,
  imagePrunaCostUsd,
  uploadPrunaFile,
  videoPrunaCostUsd,
  waitForPrunaPrediction
} from '../utils/prunaClient.js';
import { isWatchProduct, promptForKey, promptForProduct, promptKeyForProduct } from '../utils/tryOnPrompts.js';
import { falModelCostEstimate } from '../services/providerIntegrations.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const imageCacheTtlMs = Number(process.env.TRYON_IMAGE_CACHE_TTL_MS || 15 * 60 * 1000);
const imageCacheMaxItems = Number(process.env.TRYON_IMAGE_CACHE_MAX_ITEMS || 80);
const localImageDataUriCache = new Map();
const remoteImageDataUriCache = new Map();
const inFlightImageDataUriCache = new Map();
const avifExtensions = new Set(['.avif']);
const avifMimeTypes = new Set(['image/avif', 'image/x-avif']);
const debugGenerationLogs = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_GENERATION_LOGS || '').toLowerCase());
const debugPrunaVideoLogs = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_PRUNA_VIDEO_LOGS || process.env.DEBUG_GENERATION_LOGS || '').toLowerCase());
const tryOnReadLimiter = createRateLimiter({
  name: 'tryons:read',
  windowMs: 5 * 60 * 1000,
  max: 240,
  keyGenerator: rateLimitKeys.user,
  message: 'Try-on history is temporarily limited. Please try again shortly.'
});
const tryOnImageBurstLimiter = createRateLimiter({
  name: 'tryons:image-burst',
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many AI try-on requests at once. Please wait a minute before generating more.'
});
const tryOnImageHourlyLimiter = createRateLimiter({
  name: 'tryons:image-hour',
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.user,
  message: 'AI try-on generation is temporarily limited for your account. Please try again later.'
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, isAllowedImageUpload(file));
  }
});

function extensionForFile(file) {
  return path.extname(file.originalname || file.filename || '').toLowerCase();
}

function isAvifUpload(file) {
  return avifMimeTypes.has(String(file.mimetype || '').toLowerCase()) || avifExtensions.has(extensionForFile(file));
}

function isAllowedImageUpload(file) {
  return isAllowedRasterImageUpload(file) || isAvifUpload(file);
}

function tokenCost() {
  const value = Number(process.env.TRYON_TOKEN_COST || 1);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

function videoTokenCost() {
  const value = Number(process.env.TRYON_VIDEO_TOKEN_COST || 3);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 3;
}

function devMode(user) {
  return developmentBillingBypass(user);
}

function chargedTokenCost(user) {
  return devMode(user) ? 0 : tokenCost();
}

function chargedVideoTokenCost(user) {
  return devMode(user) ? 0 : videoTokenCost();
}

function ensureTryOnProfileReady(user) {
  if (!user?.bodyPhoto?.path && !user?.bodyPhoto?.url && !user?.bodyPhoto?.remoteUrl) {
    throw new Error('Upload a profile photo before starting an AI try-on.');
  }
  const status = user?.bodyPhoto?.status || 'ready';
  if (status === 'generating') {
    throw new Error('Your full-body try-on profile is still being prepared. You can keep browsing and try again in a minute.');
  }
  if (status === 'failed') {
    throw new Error('Could not prepare your full-body try-on profile. Please upload a clearer selfie or body photo from your profile page.');
  }
}

function redactLargeData(value) {
  if (typeof value === 'string') {
    return value.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]{120,}/gi, '[data image omitted]');
  }
  return value;
}

function readableError(value, fallback = 'Request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') {
    if (/content[_\s-]?policy|safety|flagged|content[_\s-]?policy[_\s-]?violation/i.test(value)) {
      return 'This try-on was blocked by the image provider safety check. Please try again with the fitted/swimwear try-on mode.';
    }
    return redactLargeData(value);
  }
  if (value instanceof Error) return readableError(value.message, fallback);
  if (Array.isArray(value)) {
    const policyError = value.find((item) => /content[_\s-]?policy|safety|flagged/i.test([item?.type, item?.code, item?.msg, item?.message].filter(Boolean).join(' ')));
    if (policyError) {
      return 'This try-on was blocked by the image provider safety check. Lookmefy will use the fitted/swimwear try-on mode for this product.';
    }
    const imageSizeError = value.find((item) => item?.type === 'image_too_small');
    if (imageSizeError) {
      const index = imageSizeError.loc?.[2] ?? imageSizeError.loc?.[1];
      const label = index === 1 ? 'product' : index === 0 ? 'profile' : 'reference';
      return `${label} image is too small for Wan 2.6. Wan requires every reference image to be at least 384x384px. Use a larger product photo.`;
    }
    return value.map((item) => readableError(item, fallback)).filter(Boolean).join(' ') || fallback;
  }
  if (typeof value === 'object') {
    const policyText = [value.type, value.code, value.msg, value.message, value.error].filter((item) => typeof item === 'string').join(' ');
    if (/content[_\s-]?policy|safety|flagged/i.test(policyText)) {
      return 'This try-on was blocked by the image provider safety check. Lookmefy will use the fitted/swimwear try-on mode for this product.';
    }
    if (value.type === 'image_too_small') {
      return 'Reference image is too small for Wan 2.6. Wan requires every reference image to be at least 384x384px.';
    }
    const nested = value.message || value.detail || value.error || value.errors;
    if (nested && nested !== value) return readableError(nested, fallback);
    try {
      return redactLargeData(JSON.stringify(value, null, 2));
    } catch {
      return fallback;
    }
  }
  return redactLargeData(String(value));
}

function createTimer(label, meta = {}) {
  const start = performance.now();
  let last = start;
  const steps = [];
  if (debugGenerationLogs) console.log(`[tryon:${label}] start`, meta);
  const addStep = (name, now, extra = {}) => {
    steps.push({
      step: name,
      stepMs: Math.round(now - last),
      totalMs: Math.round(now - start),
      ...extra
    });
  };
  return {
    mark(step, extra = {}) {
      const now = performance.now();
      addStep(step, now, extra);
      if (debugGenerationLogs) {
        console.log(`[tryon:${label}] ${step}`, {
          stepMs: Math.round(now - last),
          totalMs: Math.round(now - start),
          ...extra
        });
      }
      last = now;
    },
    end(extra = {}) {
      const now = performance.now();
      const totalMs = Math.round(now - start);
      if (debugGenerationLogs) {
        console.log(`[tryon:${label}] done`, {
          totalMs,
          ...extra
        });
      }
      if (label === 'video') {
        const failed = Boolean(extra?.error);
        console.log(JSON.stringify({
          level: failed ? 'warn' : 'info',
          event: 'tryon_video_timeline',
          totalMs,
          ...meta,
          ...extra,
          steps
        }));
      }
    }
  };
}

function imageModel() {
  return process.env.FAL_TRYON_MODEL || 'openai/gpt-image-2/edit';
}

function wanImageToImageModel() {
  return process.env.FAL_WAN_IMAGE_TO_IMAGE_MODEL || 'wan/v2.6/image-to-image';
}

function pixverseImageToVideoModel() {
  return process.env.FAL_TRYON_VIDEO_MODEL || 'fal-ai/pixverse/v6/image-to-video';
}

function pixverseImageToVideoResolution() {
  return process.env.FAL_TRYON_VIDEO_RESOLUTION || '540p';
}

function pixverseImageToVideoDuration() {
  const value = Number(process.env.FAL_TRYON_VIDEO_DURATION || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function pixverseVideoFrameWidth() {
  const value = Number(process.env.FAL_VIDEO_FRAME_WIDTH || process.env.FAL_VIDEO_FRAME_MAX_WIDTH || 864);
  return Number.isFinite(value) && value > 0 ? value : 864;
}

function pixverseVideoFrameHeight() {
  const value = Number(process.env.FAL_VIDEO_FRAME_HEIGHT || process.env.FAL_VIDEO_FRAME_MAX_HEIGHT || 1536);
  return Number.isFinite(value) && value > 0 ? value : 1536;
}

function pixverseImageToVideoCameraMovement() {
  const value = String(process.env.FAL_TRYON_VIDEO_CAMERA_MOVEMENT || 'fix_bg').trim();
  return value && !['0', 'false', 'none', 'off'].includes(value.toLowerCase()) ? value : '';
}

function aiProvider() {
  return String(process.env.AI_PROVIDER || 'pruna').trim().toLowerCase();
}

function usePrunaProvider() {
  return aiProvider() === 'pruna';
}

function videoProvider() {
  return String(process.env.TRYON_VIDEO_PROVIDER || 'pixverse').trim().toLowerCase();
}

function usePrunaVideoProvider() {
  return videoProvider() === 'pruna';
}

function prunaTryOnModel() {
  return process.env.PRUNA_TRYON_MODEL || 'p-image-try-on';
}

function prunaVideoModel() {
  return process.env.PRUNA_VIDEO_MODEL || 'p-video';
}

function prunaTryOnTurbo(product) {
  if (isWatchProduct(product)) return false;
  const value = String(process.env.PRUNA_TRYON_TURBO || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function prunaOutputFormat() {
  const value = String(process.env.PRUNA_TRYON_OUTPUT_FORMAT || 'png').trim().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp'].includes(value) ? value.replace('jpeg', 'jpg') : 'jpg';
}

function prunaOutputQuality() {
  const value = Number(process.env.PRUNA_TRYON_OUTPUT_QUALITY || 100);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : 100;
}

function prunaPreserveInputSize() {
  const value = String(process.env.PRUNA_TRYON_PRESERVE_INPUT_SIZE || 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

function prunaImagePollOptions(timer) {
  return {
    timer,
    maxAttempts: Number(process.env.PRUNA_IMAGE_POLL_ATTEMPTS || 90),
    pollMs: Number(process.env.PRUNA_IMAGE_POLL_MS || 1500)
  };
}

function prunaImageTrySync() {
  const value = String(process.env.PRUNA_IMAGE_TRY_SYNC || 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function prunaVideoDuration() {
  const value = Number(process.env.PRUNA_VIDEO_DURATION || 5);
  return Number.isFinite(value) && value >= 1 && value <= 20 ? Math.round(value) : 5;
}

function prunaVideoResolution() {
  const value = String(process.env.PRUNA_VIDEO_RESOLUTION || '720p').trim().toLowerCase();
  return value === '1080p' ? '1080p' : '720p';
}

function prunaVideoAspectRatio() {
  const value = String(process.env.PRUNA_VIDEO_ASPECT_RATIO || '9:16').trim();
  return new Set(['16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '1:1']).has(value) ? value : '9:16';
}

function prunaVideoFps() {
  const value = Number(process.env.PRUNA_VIDEO_FPS || 24);
  return value === 48 ? 48 : 24;
}

function prunaVideoPollOptions(timer) {
  return {
    timer,
    maxAttempts: Number(process.env.PRUNA_VIDEO_POLL_ATTEMPTS || 180),
    pollMs: Number(process.env.PRUNA_VIDEO_POLL_MS || 2000)
  };
}

function prunaVideoTrySync() {
  const value = String(process.env.PRUNA_VIDEO_TRY_SYNC || 'false').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function tryOnModelForProduct(product = {}) {
  if (shouldUseFalImageEditForProduct(product)) return falSareeVirtualTryOnModel();
  return usePrunaProvider() ? prunaTryOnModel() : 'fitroom/tryon-v2';
}

function shouldUseFalImageEditForProduct(product = {}) {
  return promptKeyForProduct(product, 'full_outfit') === 'saree';
}

function falSareeVirtualTryOnModel() {
  return process.env.FAL_SAREE_TRYON_MODEL || 'fal-ai/cat-vton';
}

function falSareeVirtualTryOnAspectRatio() {
  const value = String(process.env.FAL_SAREE_TRYON_ASPECT_RATIO || process.env.FAL_VTO_ASPECT_RATIO || '3:4').trim();
  return ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(value) ? { ratio: value } : undefined;
}

function falSareeVirtualTryOnPollOptions(timer) {
  return {
    ...timer,
    maxAttempts: Number(process.env.FAL_SAREE_TRYON_POLL_ATTEMPTS || process.env.FAL_VTO_POLL_ATTEMPTS || 120),
    pollMs: Number(process.env.FAL_SAREE_TRYON_POLL_MS || process.env.FAL_VTO_POLL_MS || 1500)
  };
}

function falSareeVirtualTryOnImageSize() {
  const value = String(process.env.FAL_SAREE_TRYON_IMAGE_SIZE || 'portrait_4_3').trim();
  return new Set(['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9']).has(value)
    ? value
    : 'portrait_4_3';
}

function falSareeVirtualTryOnPayload({ endpoint, person, garment }) {
  if (/cat-vton/i.test(endpoint)) {
    return {
      human_image_url: person,
      garment_image_url: garment,
      cloth_type: 'overall',
      image_size: falSareeVirtualTryOnImageSize(),
      num_inference_steps: Number(process.env.FAL_SAREE_TRYON_STEPS || 36),
      guidance_scale: Number(process.env.FAL_SAREE_TRYON_GUIDANCE || 3)
    };
  }

  if (/leffa/i.test(endpoint)) {
    return {
      human_image_url: person,
      garment_image_url: garment,
      garment_type: 'dresses',
      image_size: falSareeVirtualTryOnImageSize(),
      num_inference_steps: Number(process.env.FAL_SAREE_TRYON_STEPS || 50),
      guidance_scale: Number(process.env.FAL_SAREE_TRYON_GUIDANCE || 2.5),
      enable_safety_checker: true,
      output_format: 'png'
    };
  }

  const aspectRatio = falSareeVirtualTryOnAspectRatio();
  const input = {
    person_image_url: person,
    clothing_image_url: garment,
    preserve_pose: true
  };
  if (aspectRatio) input.aspect_ratio = aspectRatio;
  return input;
}

function imageQuality() {
  return process.env.FAL_IMAGE_QUALITY || 'low';
}

function sareeImageQuality() {
  const value = String(process.env.FAL_SAREE_IMAGE_QUALITY || 'high').trim().toLowerCase();
  return new Set(['low', 'medium', 'high']).has(value) ? value : 'high';
}

function imageSize() {
  const width = Number(process.env.FAL_IMAGE_WIDTH || 1024);
  const height = Number(process.env.FAL_IMAGE_HEIGHT || 768);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'auto';
  return { width, height };
}

function wanImageSize() {
  const width = Number(process.env.FAL_WAN_IMAGE_WIDTH || 1024);
  const height = Number(process.env.FAL_WAN_IMAGE_HEIGHT || 1280);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'portrait_4_3';
  return { width, height };
}

function extensionFor(mimetype) {
  if (mimetype?.includes('mp4')) return '.mp4';
  if (mimetype?.includes('quicktime')) return '.mov';
  if (mimetype?.startsWith('video/')) return '.mp4';
  if (mimetype?.includes('png')) return '.png';
  if (mimetype?.includes('webp')) return '.webp';
  if (mimetype?.includes('gif')) return '.gif';
  return '.jpg';
}

function fitRoomHeaders() {
  if (!process.env.FITROOM_API_KEY) throw new Error('FITROOM_API_KEY is missing on the server');
  return { 'X-API-KEY': process.env.FITROOM_API_KEY };
}

function fitRoomBaseUrl() {
  return (process.env.FITROOM_BASE_URL || 'https://platform.fitroom.app').replace(/\/+$/, '');
}

function fitRoomDefaultClothType() {
  return 'full_set';
}

function fitRoomHdMode() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.FITROOM_HD_MODE || '').toLowerCase());
}

function fitRoomPollAttempts() {
  const value = Number(process.env.FITROOM_POLL_ATTEMPTS || 80);
  return Number.isFinite(value) && value > 0 ? value : 80;
}

function fitRoomPollMs() {
  const value = Number(process.env.FITROOM_POLL_MS || 1500);
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

function fitRoomClothTypeForPromptKey(promptKey = '') {
  if (promptKey === 'lower') return 'lower';
  if (promptKey === 'upper') return 'upper';
  return 'full_set';
}

function fitRoomClothTypeForProduct(product = {}) {
  return fitRoomClothTypeForPromptKey(promptKeyForProduct(product, 'upper'));
}

function safeLocalPath(storedPath) {
  const resolved = path.resolve(rootDir, storedPath || '');
  if (!resolved.startsWith(rootDir)) throw new Error('Invalid image path');
  return resolved;
}

function dataUriFromBuffer(file, label, options = {}) {
  if (!file?.buffer) throw new Error(`${label} image is missing`);
  const mimetype = file.mimetype || 'image/jpeg';
  ensureMinimumImageDimensions({
    bytes: file.buffer,
    label,
    minWidth: Number(options.minWidth || 0),
    minHeight: Number(options.minHeight || 0)
  });
  return `data:${mimetype};base64,${file.buffer.toString('base64')}`;
}

function imageDimensionsFromBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) return null;
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (!length || offset + length + 2 > bytes.length) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += length + 2;
    }
  }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (type === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (type === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function imageMimeTypeFromBuffer(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 12) === 'ftypavif') return 'image/avif';
  if (bytes.toString('ascii', 4, 12).startsWith('ftyphei') || bytes.toString('ascii', 4, 12).startsWith('ftypmif')) return 'image/heif';
  if (bytes.toString('ascii', 0, 5) === '<svg ' || bytes.toString('ascii', 0, 5) === '<?xml') return 'image/svg+xml';
  return '';
}

function imageMimeTypeFromResponse(response, bytes) {
  const declared = response.headers.get('content-type') || '';
  if (declared.startsWith('image/')) return declared.split(';')[0];
  return imageMimeTypeFromBuffer(bytes) || declared || 'image/png';
}

function isAvifBytes(bytes, mimetype = '') {
  return avifMimeTypes.has(String(mimetype || '').toLowerCase()) || imageMimeTypeFromBuffer(bytes) === 'image/avif';
}

function filenameWithExtension(filename = '', fallbackName = 'image', extension = '.jpg') {
  const parsed = path.parse(filename || fallbackName);
  return `${parsed.name || fallbackName}${extension}`;
}

async function normalizeAvifImage({ bytes, mimetype, filename, label, timer }) {
  if (!isAvifBytes(bytes, mimetype) && !avifExtensions.has(path.extname(filename || '').toLowerCase())) {
    return { bytes, mimetype, filename };
  }

  const outputBytes = await sharp(bytes).jpeg({ quality: 90 }).toBuffer();
  const outputFilename = filenameWithExtension(filename, label, '.jpg');
  timer?.mark(`${label} avif converted`, {
    inputKb: Math.round(bytes.length / 1024),
    outputKb: Math.round(outputBytes.length / 1024)
  });
  return {
    bytes: outputBytes,
    mimetype: 'image/jpeg',
    filename: outputFilename
  };
}

function ensureMinimumImageDimensions({ bytes, label, minWidth, minHeight }) {
  if (!minWidth && !minHeight) return null;
  const dimensions = imageDimensionsFromBuffer(bytes);
  if (!dimensions) throw new Error(`${label} image dimensions could not be read. Wan 2.6 requires 384x384px or larger reference images.`);
  if (dimensions.width < minWidth || dimensions.height < minHeight) {
    throw new Error(`${label} image is ${dimensions.width}x${dimensions.height}px. Wan 2.6 requires each reference image to be at least ${minWidth}x${minHeight}px. Use a larger product photo.`);
  }
  return dimensions;
}

function highResolutionAmazonImageUrl(value = '') {
  const url = String(value || '').trim();
  if (!/https?:\/\/(?:[^/]+\.)?(?:media-amazon|ssl-images-amazon)\.[^/]+\/images\//i.test(url)) return '';
  return url.replace(/\._[^/]*_\.(jpe?g|png|webp)(?:\?.*)?$/i, '.$1');
}

function getCachedDataUri(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setCachedDataUri(cache, key, value) {
  cache.set(key, { value, expiresAt: Date.now() + imageCacheTtlMs });
  while (cache.size > imageCacheMaxItems) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  return value;
}

async function cachedDataUri({ cache, key, timer, label, load }) {
  const cached = getCachedDataUri(cache, key);
  if (cached) {
    timer?.mark(`${label} cache hit`);
    return cached;
  }

  if (inFlightImageDataUriCache.has(key)) {
    timer?.mark(`${label} cache wait`);
    return inFlightImageDataUriCache.get(key);
  }

  const pending = load()
    .then((value) => setCachedDataUri(cache, key, value))
    .finally(() => inFlightImageDataUriCache.delete(key));
  inFlightImageDataUriCache.set(key, pending);
  return pending;
}

async function dataUriFromUpload(image, label, timer, options = {}) {
  if (!image?.path && !image?.url && !image?.remoteUrl) throw new Error(`${label} image is missing`);
  const mimetype = image.mimetype || 'image/jpeg';
  const minWidth = Number(options.minWidth || 0);
  const minHeight = Number(options.minHeight || 0);
  const key = `stored:${await storedFileSignature(image)}:${mimetype}:${minWidth || ''}x${minHeight || ''}`;
  return cachedDataUri({
    cache: localImageDataUriCache,
    key,
    timer,
    label,
    load: async () => {
      const { buffer: bytes } = await readStoredFile(image, label);
      const normalized = await normalizeAvifImage({
        bytes,
        mimetype,
        filename: image.filename,
        label,
        timer
      });
      const dimensions = ensureMinimumImageDimensions({ bytes: normalized.bytes, label, minWidth, minHeight });
      if (dimensions) timer?.mark(`${label} dimensions checked`, dimensions);
      return `data:${normalized.mimetype};base64,${normalized.bytes.toString('base64')}`;
    }
  });
}

async function dataUriFromProduct(product, timer, options = {}) {
  if (product.image?.path) return dataUriFromUpload(product.image, 'product', timer, options);
  if (!product.image?.remoteUrl) throw new Error('Product image is missing');

  const minWidth = Number(options.minWidth || 0);
  const minHeight = Number(options.minHeight || 0);
  const originalUrl = product.image.remoteUrl;
  const highResUrl = highResolutionAmazonImageUrl(originalUrl);
  const candidateUrls = highResUrl && highResUrl !== originalUrl ? [highResUrl, originalUrl] : [originalUrl];
  const key = `remote:${candidateUrls[0]}:${minWidth || ''}x${minHeight || ''}`;
  return cachedDataUri({
    cache: remoteImageDataUriCache,
    key,
    timer,
    label: 'product',
    load: async () => {
      let lastError;
      for (const url of candidateUrls) {
        try {
          const { response, buffer: bytes, mimetype } = await safeFetchImageBuffer(url, {
            maxBytes: 12 * 1024 * 1024,
            headers: {
              accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
              'user-agent': 'Mozilla/5.0 Lookmefy image fetcher'
            }
          });
          if (!response.ok) throw new Error('Could not fetch product image');
          const normalized = await normalizeAvifImage({
            bytes,
            mimetype,
            filename: path.basename(new URL(url).pathname) || 'product',
            label: 'product',
            timer
          });
          const dimensions = ensureMinimumImageDimensions({ bytes: normalized.bytes, label: 'product', minWidth, minHeight });
          if (dimensions) timer?.mark('product dimensions checked', { ...dimensions, highRes: url !== originalUrl });
          return `data:${normalized.mimetype};base64,${normalized.bytes.toString('base64')}`;
        } catch (error) {
          lastError = error;
          if (url !== candidateUrls[candidateUrls.length - 1]) timer?.mark('product image candidate failed', { error: readableError(error) });
        }
      }
      throw lastError || new Error('Could not fetch product image');
    }
  });
}

async function filePartFromUpload(image, label, timer) {
  if (!image?.path && !image?.url && !image?.remoteUrl) throw new Error(`${label} image is missing`);
  const { buffer: bytes } = await readStoredFile(image, label);
  const mimetype = image.mimetype || 'image/jpeg';
  const normalized = await normalizeAvifImage({
    bytes,
    mimetype,
    filename: image.filename,
    label,
    timer
  });
  timer?.mark(`${label} file prepared`, { kb: Math.round(normalized.bytes.length / 1024), mimetype: normalized.mimetype });
  return {
    bytes: normalized.bytes,
    mimetype: normalized.mimetype,
    filename: normalized.filename || image.filename || `${label}${extensionFor(normalized.mimetype)}`
  };
}

async function filePartFromRemoteUrl(url, label, timer) {
  const { response, buffer: bytes, mimetype } = await safeFetchImageBuffer(url, {
    maxBytes: 12 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy image fetcher'
    }
  });
  if (!response.ok) throw new Error(`Could not fetch ${label} image`);
  const normalized = await normalizeAvifImage({
    bytes,
    mimetype,
    filename: path.basename(new URL(url).pathname) || label,
    label,
    timer
  });
  timer?.mark(`${label} remote file prepared`, { kb: Math.round(normalized.bytes.length / 1024), mimetype: normalized.mimetype });
  return {
    bytes: normalized.bytes,
    mimetype: normalized.mimetype,
    filename: normalized.filename || `${label}${extensionFor(normalized.mimetype)}`
  };
}

async function filePartFromProduct(product, timer) {
  if (product.image?.path) return filePartFromUpload(product.image, 'product', timer);
  if (!product.image?.remoteUrl) throw new Error('Product image is missing');

  const originalUrl = product.image.remoteUrl;
  const highResUrl = highResolutionAmazonImageUrl(originalUrl);
  const candidateUrls = highResUrl && highResUrl !== originalUrl ? [highResUrl, originalUrl] : [originalUrl];
  let lastError;
  for (const url of candidateUrls) {
    try {
      return await filePartFromRemoteUrl(url, 'product', timer);
    } catch (error) {
      lastError = error;
      if (url !== candidateUrls[candidateUrls.length - 1]) timer?.mark('product image candidate failed', { error: readableError(error) });
    }
  }
  throw lastError || new Error('Could not fetch product image');
}

async function filePartFromMemoryFile(file, label, timer) {
  if (!file?.buffer) throw new Error(`${label} image is missing`);
  const normalized = await normalizeRasterImageBuffer({
    buffer: file.buffer,
    filename: file.originalname || `${label}.jpg`
  });
  timer?.mark(`${label} upload file prepared`, { kb: Math.round(normalized.buffer.length / 1024), mimetype: normalized.mimetype });
  return {
    bytes: normalized.buffer,
    mimetype: normalized.mimetype,
    filename: normalized.filename || `${label}${extensionFor(normalized.mimetype)}`
  };
}

function appendFilePart(form, name, file) {
  form.append(name, new Blob([file.bytes], { type: file.mimetype }), file.filename);
}

async function fitRoomJson(pathname, options = {}) {
  const response = await fetch(`${fitRoomBaseUrl()}${pathname}`, {
    ...options,
    headers: { ...fitRoomHeaders(), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.message || data, 'FitRoom try-on request failed'));
  return data;
}

async function waitForFitRoomTask(taskId, timer) {
  const maxAttempts = fitRoomPollAttempts();
  const pollMs = fitRoomPollMs();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await fitRoomJson(`/api/tryon/v2/tasks/${encodeURIComponent(taskId)}`);
    if (attempt === 0 || attempt % 5 === 0 || status.status === 'COMPLETED') {
      timer?.mark('fitroom status poll', { attempt, status: status.status, progress: status.progress });
    }
    if (status.status === 'COMPLETED') {
      if (!status.download_signed_url) throw new Error('FitRoom completed the task without a download URL');
      return status;
    }
    if (status.status === 'FAILED') throw new Error(readableError(status.error || status, 'FitRoom try-on generation failed'));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`FitRoom try-on generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
}

async function callFitRoomTryOn({ user, product, garmentFile, clothType, timer }) {
  const [person, garment] = await Promise.all([
    filePartFromUpload(user.bodyPhoto, 'person', timer),
    garmentFile ? filePartFromMemoryFile(garmentFile, 'garment', timer) : filePartFromProduct(product, timer)
  ]);
  const selectedClothType = clothType || (product ? fitRoomClothTypeForProduct(product) : fitRoomDefaultClothType());
  const form = new FormData();
  appendFilePart(form, 'model_image', person);
  appendFilePart(form, 'cloth_image', garment);
  form.append('cloth_type', selectedClothType);
  if (fitRoomHdMode()) form.append('hd_mode', 'true');

  timer?.mark('fitroom task submit attempt', {
    clothType: selectedClothType,
    hdMode: fitRoomHdMode()
  });
  const submission = await fitRoomJson('/api/tryon/v2/tasks', {
    method: 'POST',
    body: form
  });
  if (!submission.task_id) throw new Error('FitRoom did not return a task id');
  timer?.mark('fitroom task submitted', { taskId: submission.task_id, status: submission.status });

  const result = await waitForFitRoomTask(submission.task_id, timer);
  const { bytes, mimetype } = await generatedBytesFromUrl(result.download_signed_url, timer);
  timer?.mark('fitroom generated image downloaded', { outputKb: Math.round(bytes.length / 1024), mimetype });
  return {
    bytes,
    mimetype,
    prompt: `FitRoom virtual try-on (${selectedClothType})`,
    promptKey: selectedClothType === 'lower' ? 'lower' : selectedClothType === 'upper' ? 'upper' : 'full_outfit',
    provider: 'fitroom',
    model: 'fitroom/tryon-v2',
    quality: fitRoomHdMode() ? 'hd' : 'standard'
  };
}

function tryOnPrompt(product) {
  return [
    'Generate a photorealistic e-commerce fashion try-on image. This is a standard apparel catalog photo, similar to images on Zara, ASOS, or Nordstrom product pages, showing how a real clothing item fits and drapes on a person.',
    'Reference image 1 is the shopper and is the only identity reference. Preserve their exact identity, face, facial features, hair, skin tone, body shape, and natural proportions. Do not beautify, slim, age, sexualize, re-face, or otherwise alter the shopper.',
    `Reference image 2 is only the garment/product reference: "${product.name}" by ${product.brand}. If this product image contains a model, mannequin, face, hair, skin, hands, body, pose, or background, ignore all of those completely. Do not copy, blend, borrow, or average any identity, face, hairstyle, skin tone, body shape, pose, expression, or background from reference image 2.`,
    'Transfer only the visible clothing item from reference image 2 as-is, including its original color, fabric texture, neckline, sleeve length, hemline, cut, seams, buttons, logos, pockets, pattern, and silhouette. Do not modify the garment design.',
    'Fit the garment naturally onto the shopper with correct scale, seams, neckline, sleeve length, hem length, folds, shadows, occlusion, and fabric texture, matching how the garment fits in the original product photo.',
    'The final face must match reference image 1. Keep the shopper eyes, nose, mouth, jawline, facial proportions, hairline, hairstyle, and expression from reference image 1 unchanged.',
    'Create a clean full-body studio catalog image with soft even lighting and a simple neutral light gray or off-white ecommerce background. Do not preserve messy rooms, green screens, curtains, camera equipment, walls, floors, or background clutter from the shopper reference.',
    'This is professional, non-sexualized commercial fashion photography intended for a retail product page. The pose, framing, and styling should remain catalog-appropriate and editorial in tone, consistent with mainstream fashion retail imagery.',
    'Keep the shopper hands, face, legs, footwear, and non-target clothing unchanged unless they must be naturally covered by the new garment.',
    'Do not invent extra accessories, logos, text, patterns, buttons, pockets, or colors that are not present in the product image.',
    'MANDATORY OUTPUT CHECK — the image is invalid unless ALL of these are true: (1) full body visible head-to-toe in one frame, (2) complete face and hair visible and unobstructed, (3) both arms and both hands fully visible, (4) both legs and both feet or footwear fully visible, (5) no cropping at the head, shoulders, waist, knees, or ankles, (6) exactly one person in one single continuous photo. If the input framing does not allow a full body composition, zoom out rather than cropping any body part out of frame.',
    'Return one clean full-body try-on image suitable for a product card, matching standard fashion e-commerce photography conventions.'
  ].join(' ');
}

function wanTryOnPrompt(product) {
  const productName = String(product?.name || 'the selected garment').slice(0, 220);
  const productBrand = String(product?.brand || 'the listed brand').slice(0, 120);
  return [
    'Create one photorealistic virtual try-on image for an ecommerce product page.',
    'Image 1 is the shopper and must remain the identity, face, hair, skin tone, body shape, hands, legs, natural proportions, and expression reference.',
    'Preserve the shopper face, hair, skin tone, body shape, hands, legs, and expression exactly.',
    `Image 2 is only the garment reference for "${productName}" by ${productBrand}.`,
    'Transfer only the garment design, color, fabric, texture, neckline, sleeves, hem, seams, closures, logos, pattern, pockets, and silhouette from image 2.',
    'Ignore any model, mannequin, person, face, body, pose, camera angle, crop, lighting, and background present in image 2.',
    'Fit the garment naturally onto the shopper with correct scale, drape, folds, wrinkles, occlusion, and shadows.',
    'Create a clean full-body studio catalog image with soft even lighting and a simple neutral light gray or off-white ecommerce background. Do not preserve messy rooms, green screens, curtains, camera equipment, walls, floors, or background clutter from image 1.',
    'Keep every non-garment body region from image 1 unchanged. Do not add accessories, styling, text, logos, body changes, or extra skin exposure.',
    'MANDATORY OUTPUT CHECK — the image is invalid unless ALL of these are true: (1) full body visible head-to-toe in one frame, (2) complete face and hair visible and unobstructed, (3) both arms and both hands fully visible, (4) both legs and both feet or footwear fully visible, (5) no cropping at the head, shoulders, waist, knees, or ankles, (6) exactly one person in one single continuous photo. If the input framing does not allow a full body composition, zoom out rather than cropping any body part out of frame.',
    'Return one clean, full-body, non-sexualized, photorealistic retail try-on preview.'
  ].join(' ');
}

function wanCustomTryOnPrompt() {
  return [
    'Create one photorealistic virtual try-on image for an ecommerce clothing preview.',
    'Image 1 is the shopper and must remain the identity, body, pose, camera, lighting, and background reference.',
    'Preserve the shopper face, hair, skin tone, body shape, hands, legs, pose, framing, and expression exactly.',
    'Image 2 is only the uploaded garment reference.',
    'Transfer only the garment design, color, fabric, texture, neckline, sleeves, hem, seams, closures, logos, pattern, pockets, and silhouette from image 2.',
    'Ignore any model, mannequin, person, face, body, pose, camera angle, crop, lighting, and background present in image 2.',
    'Fit the garment naturally onto the shopper with correct scale, drape, folds, wrinkles, occlusion, and shadows.',
    'Keep every non-garment region from image 1 unchanged. Do not add accessories, styling, text, logos, background details, body changes, or extra skin exposure.',
    'MANDATORY OUTPUT CHECK — the image is invalid unless ALL of these are true: (1) full body visible head-to-toe in one frame, (2) complete face and hair visible and unobstructed, (3) both arms and both hands fully visible, (4) both legs and both feet or footwear fully visible, (5) no cropping at the head, shoulders, waist, knees, or ankles, (6) exactly one person in one single continuous photo. If the input framing does not allow a full body composition, zoom out rather than cropping any body part out of frame.',
    'Return one clean, full-body, non-sexualized, photorealistic retail try-on preview.'
  ].join(' ');
}

function wanNegativePrompt() {
  return [
    'low resolution, blurry, distorted face, changed identity, changed pose, changed body, changed skin tone',
    'extra limbs, extra fingers, missing head, missing hands, missing feet',
    'cropped face, cropped head, cropped body, cropped legs, cropped feet, cropped ankles, cropped knees',
    'half body, waist-up, bust shot, close-up crop, portrait crop',
    'copied product model, mannequin identity bleed',
    'text, watermark, logo hallucination, overexposed, low quality',
    'two images, split screen, side by side, diptych, collage, grid, multiple panels, duplicate image, before and after, two people, comparison layout'
  ].join(', ');
}

function customTryOnPrompt() {
  return [
    'Create a photorealistic virtual try-on result for an ecommerce fashion app.',
    'Reference image 1 is the shopper and is the only identity reference. Preserve the shopper exact identity, face, facial features, hair, skin tone, body shape, pose, camera angle, crop, lighting, and background. Do not beautify, slim, age, re-face, or otherwise alter the person.',
    'Reference image 2 is only the clothing reference. If the clothing photo contains a model, mannequin, face, hair, skin, hands, body, pose, or background, ignore all of those completely. Do not copy, blend, borrow, or average any identity, face, hairstyle, skin tone, body shape, expression, pose, or background from reference image 2.',
    'Transfer only the visible garment from reference image 2 onto the shopper, keeping the garment color, fabric texture, neckline, sleeve length, hemline, cut, seams, buttons, logos, pockets, pattern, and silhouette.',
    'Fit the garment naturally with correct scale, seams, neckline, sleeve length, hem length, folds, shadows, occlusion, and fabric texture.',
    'The final face must match reference image 1. Keep the shopper eyes, nose, mouth, jawline, facial proportions, hairline, hairstyle, and expression from reference image 1 unchanged.',
    'Keep the shopper hands, face, legs, footwear, and non-target clothing unchanged unless they must be naturally covered by the uploaded garment.',
    'Do not invent extra accessories, logos, text, patterns, buttons, pockets, or colors that are not present in the clothing reference.',
    'MANDATORY OUTPUT CHECK — the image is invalid unless ALL of these are true: (1) full body visible head-to-toe in one frame, (2) complete face and hair visible and unobstructed, (3) both arms and both hands fully visible, (4) both legs and both feet or footwear fully visible, (5) no cropping at the head, shoulders, waist, knees, or ankles, (6) exactly one person in one single continuous photo. If the input framing does not allow a full body composition, zoom out rather than cropping any body part out of frame.',
    'Return one clean full-body try-on image.'
  ].join(' ');
}

async function callPrunaTryOn({ user, product = {}, garmentFile, promptKey, fallbackPromptKey = 'upper', timer }) {
  const personPart = await filePartFromUpload(user.bodyPhoto, 'person', timer);
  const garmentPart = garmentFile
    ? await filePartFromMemoryFile(garmentFile, 'garment', timer)
    : await filePartFromProduct(product, timer);

  const [personUpload, garmentUpload] = await Promise.all([
    uploadPrunaFile({
      bytes: personPart.bytes,
      mimetype: personPart.mimetype,
      filename: personPart.filename || `person${extensionFor(personPart.mimetype)}`
    }),
    uploadPrunaFile({
      bytes: garmentPart.bytes,
      mimetype: garmentPart.mimetype,
      filename: garmentPart.filename || `garment${extensionFor(garmentPart.mimetype)}`
    })
  ]);

  const promptInfo = promptKey
    ? { key: promptKey, prompt: promptForKey(promptKey, product) }
    : promptForProduct(product, fallbackPromptKey);
  const turbo = prunaTryOnTurbo(product);
  const input = {
    person_image: personUpload.url,
    garment_images: [garmentUpload.url],
    prompt: promptInfo.prompt,
    turbo,
    output_format: prunaOutputFormat(),
    output_quality: prunaOutputQuality(),
    preserve_input_size: prunaPreserveInputSize()
  };

  timer?.mark('pruna try-on submit attempt', {
    model: prunaTryOnModel(),
    promptKey: promptInfo.key,
    turbo,
    standardReason: isWatchProduct(product) ? 'watch' : ''
  });

  const prediction = await createPrunaPrediction({
    model: prunaTryOnModel(),
    input,
    trySync: prunaImageTrySync()
  });
  timer?.mark('pruna try-on submitted', { predictionId: prediction.id || '', status: prediction.status });
  const result = await waitForPrunaPrediction(prediction, prunaImagePollOptions(timer));
  const outputUrl = firstPrunaGenerationUrl(result);
  if (!outputUrl) throw new Error(`Pruna try-on returned no image. Response keys: ${Object.keys(result || {}).join(', ')}`);
  const downloaded = await downloadPrunaOutput(outputUrl, 'image/*,*/*;q=0.8');
  const mimetype = downloaded.mimetype?.startsWith('image/')
    ? downloaded.mimetype
    : imageMimeTypeFromBuffer(downloaded.bytes) || 'image/jpeg';
  timer?.mark('pruna try-on downloaded', { outputKb: Math.round(downloaded.bytes.length / 1024), mimetype });

  return {
    bytes: downloaded.bytes,
    mimetype,
    prompt: promptInfo.prompt,
    promptKey: promptInfo.key,
    provider: 'pruna',
    model: prunaTryOnModel(),
    quality: turbo ? 'turbo' : 'standard',
    turbo,
    garmentCount: 1,
    providerCostUsd: imagePrunaCostUsd({ turbo, garmentCount: 1 }),
    providerPredictionId: result.id || prediction.id || '',
    providerOutputUrl: outputUrl
  };
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
  if (!response.ok) throw new Error(readableError(data.detail || data.error || data.message || data, 'FAL try-on request failed'));
  return data;
}

async function waitForFalResult(submission, timer) {
  const statusUrl = submission.status_url;
  const responseUrl = submission.response_url;
  if (!statusUrl || !responseUrl) throw new Error('FAL did not return queue URLs');

  const configuredAttempts = Number(timer?.maxAttempts || 90);
  const configuredPollMs = Number(timer?.pollMs || 1500);
  const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 90;
  const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 1500;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await falJson(statusUrl);
    if (attempt === 0 || attempt % 5 === 0) timer?.mark('fal status poll', { attempt, status: status.status });
    if (status.status === 'COMPLETED') {
      timer?.mark('fal completed', { attempt });
      return falJson(responseUrl);
    }
    if (status.status === 'FAILED' || status.error) throw new Error(readableError(status.error || status, 'FAL try-on generation failed'));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`FAL try-on generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
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

function firstGeneratedVideoUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value) || /^data:video\//i.test(value) ? value : '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstGeneratedVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'video_url', 'videoUrl']) {
    const found = firstGeneratedVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['video', 'videos', 'output', 'result', 'data']) {
    const found = firstGeneratedVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = firstGeneratedVideoUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function shortUrlForLog(url = '') {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'generated image URL';
  }
}

async function generatedBytesFromUrl(url, timer) {
  if (/^data:image\//i.test(url)) {
    const [, metadata = '', base64 = ''] = url.match(/^data:([^;]+);base64,(.+)$/i) || [];
    if (!base64) throw new Error('Generated image data URI was invalid');
    return {
      bytes: Buffer.from(base64, 'base64'),
      mimetype: metadata || 'image/png'
    };
  }

  let lastStatus = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { response, buffer: bytes, mimetype } = await safeFetchImageBuffer(url, {
      maxBytes: 12 * 1024 * 1024,
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 Lookmefy generated image fetcher'
      }
    });
    if (response.ok) {
      return {
        bytes,
        mimetype: mimetype || imageMimeTypeFromResponse(response, bytes)
      };
    }
    lastStatus = `${response.status} ${response.statusText}`.trim();
    timer?.mark('generated image download retry', {
      attempt,
      status: lastStatus,
      url: shortUrlForLog(url)
    });
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
  }

  throw new Error(`Could not download generated try-on image from ${shortUrlForLog(url)} (${lastStatus || 'request failed'})`);
}

function videoMimeTypeFromResponse(response, bytes) {
  const declared = response.headers.get('content-type') || '';
  if (declared.startsWith('video/')) return declared.split(';')[0];
  if (Buffer.isBuffer(bytes) && bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  return declared || 'video/mp4';
}

async function generatedVideoBytesFromUrl(url, timer) {
  if (/^data:video\//i.test(url)) {
    const [, metadata = '', base64 = ''] = url.match(/^data:([^;]+);base64,(.+)$/i) || [];
    if (!base64) throw new Error('Generated video data URI was invalid');
    return {
      bytes: Buffer.from(base64, 'base64'),
      mimetype: metadata || 'video/mp4'
    };
  }

  const { response, buffer: bytes } = await safeFetchBuffer(url, {
    maxBytes: 120 * 1024 * 1024,
    headers: {
      accept: 'video/mp4,video/quicktime,video/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy generated video fetcher'
    }
  });
  if (!response.ok) throw new Error(`Could not download generated try-on video from ${shortUrlForLog(url)}`);
  return {
    bytes,
    mimetype: videoMimeTypeFromResponse(response, bytes)
  };
}

function tryOnVideoPrompt() {
  return [
    'Create a clean premium ecommerce fashion video using the input image as the master visual reference.',
    'The person remains mostly front-facing and makes a subtle natural fashion-model movement: a small weight shift, a slight shoulder turn about 10 to 20 degrees to one side, then returns to the original front-facing pose. Then make a slight shoulder turn about 10 to 20 degrees to the other side and return to the original front-facing pose.',
    'The face should stay visible and generally facing the camera throughout. Do not turn to the side fully. Do not show the back. Do not perform a 360-degree rotation.',
    'Keep feet nearly planted and arms relaxed. Use only minimal natural body movement and subtle fabric motion. No walking, dancing, dramatic posing, hand gestures, or camera movement.',
    'Preserve the same face, identity, hairstyle, body shape, skin tone, outfit, garment colors, fabric texture, logos, footwear, background, lighting, exposure, and framing throughout the entire video.',
    'The first frame and final frame should match the input image as closely as possible. Smooth premium ecommerce lookbook style.'
  ].join('\n\n');
}

function pixverseTryOnVideoNegativePrompt() {
  return [
    'face change, different face, identity change, re-faced, face swap, beautified face, altered eyes, altered nose, altered mouth, altered jaw, altered hairstyle, altered facial hair, expression change, gender change',
    'close-up, medium shot, upper body only, portrait shot, detail shot, zoom in, camera push in, camera dolly, camera orbit, camera tracking, camera shake, reframing',
    'walking toward camera, approaching camera, static pose, no rotation, partial turn only, cropped hair, cropped head, cut off hair, cut off top of head, cropped feet, cropped body, cropped legs, cut off outfit, cut off hands',
    'dark background, black background, black studio, dark studio, dark room, black void, black floor, black wall, dramatic lighting, cinematic lighting, moody lighting, spotlight, low key lighting, underexposed, darker exposure, dim exposure, increased contrast, vignette, shadowy scene, color grading, darkened video',
    'letterbox, letterboxing, pillarbox, pillarboxing, black bars, black border, dark border, empty black margins, framed video, inset video',
    'clothing change, outfit change, color change, body deformation, extra arms, extra legs, extra fingers, missing fingers, distorted anatomy, flickering, blur, ghosting, warping, melting, AI artifacts, background change, background replacement, studio background, changed floor, changed shadows, scene change, low quality'
  ].join(', ');
}

function safeFalResultForLog(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return redactLargeData(value).slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeFalResultForLog(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (/url/i.test(key) && typeof child === 'string') {
      safe[key] = child.slice(0, 96);
    } else {
      safe[key] = safeFalResultForLog(child, depth + 1);
    }
  }
  return safe;
}

function logPrunaVideo(step, payload = {}) {
  if (!debugPrunaVideoLogs) return;
  console.log(`[tryon:pruna-video] ${step}`, payload);
}

function safePrunaVideoPayloadForLog(input = {}) {
  return {
    ...input,
    image: shortUrlForLog(input.image || ''),
    promptChars: String(input.prompt || '').length,
    promptPreview: String(input.prompt || '').slice(0, 500)
  };
}

function readableVideoError(value, fallback = 'Could not generate video try-on') {
  const text = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return '';
          }
        })();
  if (/content[_\s-]?policy|safety|flagged|content[_\s-]?policy[_\s-]?violation/i.test(text)) {
    return 'The video provider blocked this generated clip. Regenerate the AI try-on image with a neutral full-body result, then try video again.';
  }
  return readableError(value, fallback);
}

async function videoFirstFrameDataUri(image, label, timer) {
  if (!image?.path && !image?.url && !image?.remoteUrl) throw new Error(`${label} image is missing`);
  const { buffer: bytes } = await readStoredFile(image, label);
  const normalized = await normalizeAvifImage({
    bytes,
    mimetype: image.mimetype || 'image/jpeg',
    filename: image.filename,
    label,
    timer
  });
  const frameWidth = pixverseVideoFrameWidth();
  const frameHeight = pixverseVideoFrameHeight();
  const background = '#fffdf8';
  const output = await sharp(normalized.bytes)
    .rotate()
    .flatten({ background })
    .resize({
      width: frameWidth,
      height: frameHeight,
      fit: 'contain',
      background
    })
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();
  const metadata = await sharp(output).metadata();
  timer?.mark(`${label} video first frame prepared`, {
    inputKb: Math.round(normalized.bytes.length / 1024),
    outputKb: Math.round(output.length / 1024),
    width: metadata.width,
    height: metadata.height
  });
  return `data:image/jpeg;base64,${output.toString('base64')}`;
}

async function runVideoAttempt({ endpoint, payload, prompt, label, providerName, timer }) {
  const pixverseTimer = {
    ...timer,
    maxAttempts: Number(process.env.FAL_VIDEO_POLL_ATTEMPTS || 180),
    pollMs: Number(process.env.FAL_VIDEO_POLL_MS || 2000)
  };

  timer?.mark(`${label} submit attempt`, { model: endpoint, resolution: payload.resolution, duration: payload.duration, cameraMovement: payload.camera_movement });
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  timer?.mark(`${label} submitted`, { requestId: submission.request_id });
  const result = await waitForFalResult(submission, pixverseTimer);
  const generatedUrl = firstGeneratedVideoUrl(result);
  if (!generatedUrl) {
    timer?.mark(`${label} returned no video`, { result: safeFalResultForLog(result) });
    throw new Error(`${providerName || 'Video provider'} returned no video. Response keys: ${Object.keys(result || {}).join(', ')}`);
  }
  const { bytes, mimetype } = await generatedVideoBytesFromUrl(generatedUrl, timer);
  const pricing = await falModelCostEstimate({ endpointId: endpoint, duration: payload.duration });
  timer?.mark(`${label} downloaded`, { outputKb: Math.round(bytes.length / 1024), mimetype });
  return {
    bytes,
    mimetype,
    prompt,
    provider: providerName?.toLowerCase?.() || 'fal',
    model: endpoint,
    quality: `${payload.resolution} ${payload.duration}s`,
    duration: payload.duration,
    resolution: payload.resolution,
    providerCostUsd: pricing.cost,
    providerPricingSource: pricing.source,
    providerPredictionId: submission.request_id,
    providerOutputUrl: generatedUrl
  };
}

async function callPixverseTryOnVideo({ tryOn, product, user, timer }) {
  const imageUrl = await videoFirstFrameDataUri(tryOn.image, 'try-on image', timer);
  const prompt = tryOnVideoPrompt(product, user);
  const payload = {
    prompt,
    image_url: imageUrl,
    resolution: pixverseImageToVideoResolution(),
    duration: pixverseImageToVideoDuration(),
    negative_prompt: pixverseTryOnVideoNegativePrompt(),
    generate_audio_switch: false,
    generate_multi_clip_switch: false,
    thinking_type: 'disabled'
  };
  const cameraMovement = pixverseImageToVideoCameraMovement();
  if (cameraMovement) payload.camera_movement = cameraMovement;
  return runVideoAttempt({
    endpoint: pixverseImageToVideoModel(),
    payload,
    prompt,
    label: 'pixverse image-to-video',
    providerName: 'PixVerse',
    timer
  });
}

async function callPrunaTryOnVideo({ tryOn, product, user, timer }) {
  let imageUrl = String(tryOn.providerOutputUrl || '').trim();
  if (imageUrl) {
    timer?.mark('pruna source image reused', {
      source: 'provider_output_url',
      url: shortUrlForLog(imageUrl)
    });
  } else {
    const imagePart = await filePartFromUpload(tryOn.image, 'try-on image', timer);
    const sourceDimensions = imageDimensionsFromBuffer(imagePart.bytes);
    timer?.mark('pruna source image prepared', {
      sourceKb: Math.round(imagePart.bytes.length / 1024),
      sourceDimensions: sourceDimensions || 'unknown'
    });
    logPrunaVideo('source image prepared', {
      tryOnId: tryOn._id?.toString?.() || '',
      imageProvider: tryOn.provider || '',
      imageModel: tryOn.model || '',
      imageQuality: tryOn.quality || '',
      imagePromptKey: tryOn.promptKey || '',
      imageTurbo: tryOn.turbo,
      imageProviderCostUsd: tryOn.providerCostUsd,
      imageStorage: tryOn.image?.storage || '',
      imagePath: tryOn.image?.path || '',
      filename: imagePart.filename,
      mimetype: imagePart.mimetype,
      kb: Math.round(imagePart.bytes.length / 1024),
      dimensions: sourceDimensions || 'unknown'
    });
    const imageUpload = await uploadPrunaFile({
      bytes: imagePart.bytes,
      mimetype: imagePart.mimetype,
      filename: imagePart.filename || `tryon${extensionFor(imagePart.mimetype)}`
    });
    imageUrl = imageUpload.url;
    timer?.mark('pruna source image uploaded', { uploadId: imageUpload.id || '' });
    logPrunaVideo('source image uploaded', {
      uploadId: imageUpload.id || '',
      uploadUrl: shortUrlForLog(imageUpload.url)
    });
  }
  const prompt = tryOnVideoPrompt(product, user);
  const duration = prunaVideoDuration();
  const resolution = prunaVideoResolution();
  const input = {
    image: imageUrl,
    prompt,
    duration,
    resolution,
    fps: prunaVideoFps(),
    aspect_ratio: prunaVideoAspectRatio()
  };
  logPrunaVideo('payload', {
    model: prunaVideoModel(),
    trySync: prunaVideoTrySync(),
    input: safePrunaVideoPayloadForLog(input)
  });

  timer?.mark('pruna video submit attempt', {
    model: prunaVideoModel(),
    resolution,
    duration,
    aspectRatio: input.aspect_ratio
  });
  const prediction = await createPrunaPrediction({
    model: prunaVideoModel(),
    input,
    trySync: prunaVideoTrySync()
  });
  logPrunaVideo('prediction created', {
    predictionId: prediction.id || '',
    status: prediction.status || '',
    keys: Object.keys(prediction || {})
  });
  timer?.mark('pruna video submitted', { predictionId: prediction.id || '', status: prediction.status });
  const result = await waitForPrunaPrediction(prediction, prunaVideoPollOptions(timer));
  logPrunaVideo('prediction completed', {
    predictionId: result.id || prediction.id || '',
    status: result.status || '',
    keys: Object.keys(result || {})
  });
  const outputUrl = firstPrunaGenerationUrl(result);
  if (!outputUrl) throw new Error(`Pruna video returned no output. Response keys: ${Object.keys(result || {}).join(', ')}`);
  timer?.mark('pruna video output ready', { outputUrl: shortUrlForLog(outputUrl) });

  return {
    bytes: null,
    mimetype: 'video/mp4',
    prompt,
    provider: 'pruna',
    model: prunaVideoModel(),
    quality: `${resolution} ${duration}s`,
    duration,
    resolution,
    providerCostUsd: videoPrunaCostUsd({ duration, resolution, draft: false }),
    providerPredictionId: result.id || prediction.id || '',
    providerOutputUrl: outputUrl,
    deferDownload: true
  };
}

async function callFalWanImageToImage({ user, product, garmentDataUri, prompt, timer }) {
  const minReferenceSize = 384;
  const [person, garment] = await Promise.all([
    dataUriFromUpload(user.bodyPhoto, 'person', timer, { minWidth: minReferenceSize, minHeight: minReferenceSize }),
    garmentDataUri ? Promise.resolve(garmentDataUri) : dataUriFromProduct(product, timer, { minWidth: minReferenceSize, minHeight: minReferenceSize })
  ]);
  timer?.mark('wan reference images prepared', {
    personKb: Math.round(person.length / 1024),
    garmentKb: Math.round(garment.length / 1024)
  });

  const endpoint = wanImageToImageModel();
  const finalPrompt = prompt || wanTryOnPrompt(product);
  const payload = {
    prompt: finalPrompt,
    image_urls: [person, garment],
    negative_prompt: wanNegativePrompt(),
    image_size: wanImageSize(),
    num_images: 1,
    enable_prompt_expansion: false,
    enable_safety_checker: true
  };
  const wanTimer = {
    ...timer,
    maxAttempts: Number(process.env.FAL_WAN_POLL_ATTEMPTS || 180),
    pollMs: Number(process.env.FAL_WAN_POLL_MS || 1500)
  };

  timer?.mark('fal wan submit attempt', {
    fields: Object.keys(payload),
    model: endpoint
  });
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  timer?.mark('fal wan submitted', { requestId: submission.request_id });
  const result = await waitForFalResult(submission, wanTimer);
  if (debugGenerationLogs) {
    console.log('[tryon:wan] raw response array lengths', {
      images: Array.isArray(result?.images) ? result.images.length : undefined,
      output: Array.isArray(result?.output) ? result.output.length : undefined,
      data: Array.isArray(result?.data) ? result.data.length : undefined
    });
    console.log('[tryon:wan] raw response json', JSON.stringify(result, null, 2));
  }
  const generatedUrl = firstGeneratedImageUrl(result);
  if (!generatedUrl) throw new Error(`FAL Wan returned no image. Response keys: ${Object.keys(result || {}).join(', ')}`);
  const { bytes, mimetype } = await generatedBytesFromUrl(generatedUrl, timer);
  timer?.mark('wan generated image downloaded', { outputKb: Math.round(bytes.length / 1024) });
  return {
    bytes,
    mimetype,
    prompt: finalPrompt,
    model: endpoint,
    quality: 'wan v2.6 image-to-image'
  };
}

async function callFalImageEdit({ user, product, garmentDataUri, prompt, quality, timer }) {
  const [person, garment] = await Promise.all([
    dataUriFromUpload(user.bodyPhoto, 'person', timer),
    garmentDataUri ? Promise.resolve(garmentDataUri) : dataUriFromProduct(product, timer)
  ]);
  timer?.mark('reference images prepared', {
    personKb: Math.round(person.length / 1024),
    garmentKb: Math.round(garment.length / 1024)
  });
  const promptInfo = prompt
    ? { key: promptKeyForProduct(product, 'full_outfit'), prompt }
    : promptForProduct(product, 'full_outfit');
  const finalPrompt = promptInfo.prompt || tryOnPrompt(product);
  const selectedQuality = quality || imageQuality();
  const endpoint = imageModel();
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt: finalPrompt,
      image_urls: [person, garment],
      image_size: imageSize(),
      quality: selectedQuality,
      num_images: 1,
      output_format: 'png'
    })
  });
  timer?.mark('fal submitted', { requestId: submission.request_id });
  const result = await waitForFalResult(submission, timer);
  timer?.mark('fal result fetched');
  const generated = result.images?.[0];
  if (!generated?.url) throw new Error('FAL did not return an image');
  const { response: imageResponse, buffer: bytes, mimetype: validatedMimetype } = await safeFetchImageBuffer(generated.url, {
    maxBytes: 12 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy generated image fetcher'
    }
  });
  if (!imageResponse.ok) throw new Error('Could not download generated try-on image');
  const mimetype = validatedMimetype || imageMimeTypeFromResponse(imageResponse, bytes);
  timer?.mark('generated image downloaded', { outputKb: Math.round(bytes.length / 1024) });
  return {
    bytes,
    mimetype,
    prompt: finalPrompt,
    promptKey: promptInfo.key,
    provider: 'fal',
    model: endpoint,
    quality: selectedQuality
  };
}

async function callFalSareeVirtualTryOn({ user, product, timer }) {
  const [person, garment] = await Promise.all([
    dataUriFromUpload(user.bodyPhoto, 'person', timer),
    dataUriFromProduct(product, timer)
  ]);
  const endpoint = falSareeVirtualTryOnModel();
  const input = falSareeVirtualTryOnPayload({ endpoint, person, garment });

  timer?.mark('fal saree virtual try-on submitted', {
    model: endpoint,
    clothType: input.cloth_type || input.garment_type || 'auto',
    imageSize: input.image_size || input.aspect_ratio?.ratio || ''
  });
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  const result = await waitForFalResult(submission, falSareeVirtualTryOnPollOptions(timer));
  const generatedUrl = firstGeneratedImageUrl(result);
  if (!generatedUrl) throw new Error('FAL did not return a saree virtual try-on image');
  const { bytes, mimetype } = await generatedBytesFromUrl(generatedUrl, timer);
  timer?.mark('fal saree virtual try-on downloaded', { outputKb: Math.round(bytes.length / 1024) });
  return {
    bytes,
    mimetype,
    prompt: `FAL CAT-VTON saree overall route. Person image plus saree garment image with cloth_type=${input.cloth_type || input.garment_type || 'auto'}.`,
    promptKey: 'saree',
    provider: 'fal',
    model: endpoint,
    quality: `saree virtual try-on ${input.cloth_type || input.garment_type || 'full outfit'}`
  };
}

function sareeReferenceExpansionPrompt(product = {}) {
  const descriptor = [
    product.brand,
    product.name,
    product.category,
    Array.isArray(product.colors) ? product.colors.join(', ') : product.colors,
    Array.isArray(product.tags) ? product.tags.join(', ') : product.tags
  ].filter(Boolean).join(' | ');
  return `Create a single full-body saree garment reference image for a virtual try-on system.

Input image is a catalogue saree photo and may be cropped to the upper body. Do not preserve the crop. Reconstruct the complete saree as a worn full-body traditional outfit from head/shoulder level to feet.

Product context: ${descriptor || 'saree product'}.

Use the exact visible saree fabric, color, border, motif, print, embroidery, texture, shine, and pallu styling from the input. Extend the same saree design into realistic waist pleats and a full lower-body drape to ankles/feet. Include blouse/choli relationship when visible.

Output requirements:
1. One person/mannequin wearing the complete saree, full body visible.
2. Pallu, waist pleats, and lower-body drape must all be present.
3. No jeans, pants, trousers, leggings, shorts, or western bottomwear.
4. Clean ecommerce white or light neutral background.
5. No text, labels, collage, split screen, before/after, duplicate bodies, or extra garments.`;
}

async function expandedSareeReferenceDataUri(product, timer) {
  const original = await dataUriFromProduct(product, timer);
  const quality = sareeImageQuality();
  const key = `saree-expanded:${quality}:${product?._id || product?.id || ''}:${product?.image?.remoteUrl || product?.image?.url || product?.image?.path || ''}`;
  const cached = getCachedDataUri(remoteImageDataUriCache, key);
  if (cached) {
    timer?.mark('saree expanded reference cache hit');
    return cached;
  }

  const endpoint = imageModel();
  const prompt = sareeReferenceExpansionPrompt(product);
  timer?.mark('saree reference expansion submitted', { model: endpoint });
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      image_urls: [original],
      image_size: imageSize(),
      quality,
      num_images: 1,
      output_format: 'png'
    })
  });
  const result = await waitForFalResult(submission, timer);
  const generatedUrl = firstGeneratedImageUrl(result);
  if (!generatedUrl) throw new Error('FAL did not return a full saree reference image');
  const { bytes, mimetype } = await generatedBytesFromUrl(generatedUrl, timer);
  timer?.mark('saree expanded reference downloaded', { outputKb: Math.round(bytes.length / 1024) });
  const dataUri = `data:${mimetype || 'image/png'};base64,${bytes.toString('base64')}`;
  return setCachedDataUri(remoteImageDataUriCache, key, dataUri);
}

async function saveUserCacheFile({ user, bytes, filename, mimetype }) {
  const userId = user._id.toString();
  return saveBuffer({
    key: path.posix.join('users', userId, 'tryons', filename),
    buffer: bytes,
    filename,
    mimetype
  });
}

function videoMediaUrl(tryOnId) {
  return `/api/tryons/${tryOnId}/video/media?v=${Date.now()}`;
}

function mediaTokenFromRequest(req) {
  const queryToken = String(req.query?.mediaToken || req.query?.token || '').trim();
  if (queryToken) return queryToken;
  const authorization = String(req.headers.authorization || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function documentId(value) {
  if (!value) return '';
  if (value._id) return value._id.toString();
  return value.toString?.() || String(value);
}

function storedFileToClientUrl(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.url || (file.path ? `/${file.path}` : '') || file.remoteUrl || file.sourceUrl || '';
}

function generatedImageModelForScope(scope) {
  if (scope === 'product') return TryOn;
  if (scope === 'external') return ExternalTryOn;
  if (scope === 'custom') return CustomTryOn;
  return null;
}

function generatedVideoModelForScope(scope) {
  if (scope === 'product') return TryOn;
  return null;
}

function tryOnMediaTokenKind({ kind, scope, field }) {
  return `tryon:${scope}:${kind}:${field}`;
}

function tryOnMediaProxyUrl({ kind, scope, id, userId, field }) {
  const mediaId = String(id || '').trim();
  const ownerId = String(userId || '').trim();
  if (!mediaId || !ownerId) return '';
  try {
    const token = signMediaToken({
      userId: ownerId,
      mediaId,
      kind: tryOnMediaTokenKind({ kind, scope, field })
    });
    return `/api/tryons/${encodeURIComponent(kind)}/${encodeURIComponent(scope)}/${encodeURIComponent(mediaId)}?mediaToken=${encodeURIComponent(token)}`;
  } catch {
    return '';
  }
}

function generatedTryOnImageUrl(tryOn, scope, fallback = '') {
  const image = tryOn?.image;
  if (image?.storage === 'remote-pending' && !image?.sourceUrl) return '';
  if (!image?.path && !image?.url && !image?.sourceUrl && !image?.remoteUrl) return fallback || '';
  return tryOnMediaProxyUrl({
    kind: 'image',
    scope,
    id: documentId(tryOn),
    userId: documentId(tryOn?.user),
    field: 'image'
  }) || fallback || storedFileToClientUrl(image);
}

function generatedTryOnVideoUrl(tryOn, scope, fallback = '') {
  const video = tryOn?.video;
  if (!video?.path && !video?.url && !video?.providerOutputUrl) return fallback || '';
  return tryOnMediaProxyUrl({
    kind: 'video',
    scope,
    id: documentId(tryOn),
    userId: documentId(tryOn?.user),
    field: 'video'
  }) || fallback || storedFileToClientUrl(video);
}

function generatedTryOnGarmentUrl(tryOn, scope, fallback = '') {
  const garment = tryOn?.garment;
  if (!garment?.path && !garment?.url && !garment?.sourceUrl && !garment?.remoteUrl) return fallback || '';
  return tryOnMediaProxyUrl({
    kind: 'garment',
    scope,
    id: documentId(tryOn),
    userId: documentId(tryOn?.user),
    field: 'garment'
  }) || fallback || storedFileToClientUrl(garment);
}

function sendVideoBytes(req, res, { bytes, mimetype }) {
  const size = bytes.length;
  const contentType = mimetype?.startsWith('video/') ? mimetype : 'video/mp4';
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300'
  });

  const range = String(req.headers.range || '');
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.set('Content-Length', String(size));
    return res.status(200).send(bytes);
  }

  const requestedStart = match[1] ? Number(match[1]) : 0;
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const start = Math.max(0, requestedStart);
  const end = Math.min(size - 1, requestedEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.set('Content-Range', `bytes */${size}`);
    return res.sendStatus(416);
  }

  const chunk = bytes.subarray(start, end + 1);
  res.set({
    'Content-Length': String(chunk.length),
    'Content-Range': `bytes ${start}-${end}/${size}`
  });
  return res.status(206).send(chunk);
}

function historyDate(record) {
  return record?.updatedAt || record?.createdAt || new Date();
}

function productHistoryItem(tryOn) {
  const product = tryOn.product && typeof tryOn.product === 'object' ? tryOn.product : null;
  const productId = documentId(product || tryOn.product);
  const productClient = product ? productToClient(product) : null;
  const client = tryOnToClient(tryOn);
  return {
    id: `product-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'product',
    label: client.videoUrl ? 'Video Try-On' : 'AI Try-On',
    title: productClient?.name || 'Product try-on',
    subtitle: productClient?.brand || 'Catalog product',
    imageUrl: generatedTryOnImageUrl(tryOn, 'product', client.imageUrl || ''),
    transparentImageUrl: client.transparentImageUrl || '',
    videoUrl: generatedTryOnVideoUrl(tryOn, 'product', client.videoUrl || ''),
    sourceImageUrl: productClient?.imageUrl || '',
    productId,
    product: productClient,
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
}

function customTryOnToClient(tryOn) {
  if (typeof tryOn?.toClient === 'function') return tryOn.toClient();
  return new CustomTryOn(tryOn).toClient();
}

function isStaleSareeTryOnRecord(tryOn, product) {
  if (!tryOn) return false;
  const prompt = String(tryOn?.prompt || '');
  return product
    && promptKeyForProduct(product, 'full_outfit') === 'saree'
    && (tryOn?.promptKey !== 'saree'
      || tryOn?.provider !== 'fal'
      || !/FAL CAT-VTON saree overall route/i.test(prompt));
}

function customHistoryItem(tryOn) {
  const client = customTryOnToClient(tryOn);
  return {
    id: `custom-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'custom',
    label: 'Custom Try-On',
    title: tryOn.garment?.filename || 'Uploaded garment',
    subtitle: 'Custom upload',
    imageUrl: generatedTryOnImageUrl(tryOn, 'custom', client.imageUrl || ''),
    transparentImageUrl: client.transparentImageUrl || '',
    sourceImageUrl: generatedTryOnGarmentUrl(tryOn, 'custom', client.garmentUrl || storedFileToClientUrl(tryOn.garment)),
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
}

function externalTryOnToClient(tryOn) {
  if (typeof tryOn?.toClient === 'function') return tryOn.toClient();
  return new ExternalTryOn(tryOn).toClient();
}

function externalHistoryItem(tryOn) {
  const client = externalTryOnToClient(tryOn);
  const productName = String(tryOn.productName || 'External product').trim();
  return {
    id: `external-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'external',
    label: 'AI Try-On',
    title: productName,
    subtitle: tryOn.brand || 'External product',
    imageUrl: generatedTryOnImageUrl(tryOn, 'external', client.imageUrl || ''),
    transparentImageUrl: client.transparentImageUrl || '',
    sourceImageUrl: tryOn.imageUrl || '',
    sourceUrl: tryOn.sourceUrl,
    affiliateLink: tryOn.affiliateLink,
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
}

function creditEventToClient(event) {
  if (typeof event?.toClient === 'function') return event.toClient();
  return {
    id: documentId(event),
    action: event.action,
    productId: documentId(event.product),
    productTitle: event.productTitle || 'Product',
    productImageUrl: event.productImageUrl || '',
    tokens: Number(event.tokens) || 0,
    balanceAfter: Number(event.balanceAfter) || 0,
    direction: event.direction || (Number(event.tokens) >= 0 ? 'credit' : 'debit'),
    source: event.source || 'system',
    sourceId: event.sourceId || '',
    metadata: event.metadata || null,
    createdAt: event.createdAt
  };
}

function backgroundSavePrunaVideo({ tryOnId, user, outputUrl, filename, mimetype = 'video/mp4' }) {
  setImmediate(async () => {
    const startedAt = performance.now();
    try {
      const downloaded = await downloadPrunaOutput(outputUrl, 'video/mp4,video/*,*/*;q=0.8');
      const saved = await saveUserCacheFile({
        user,
        bytes: downloaded.bytes,
        filename,
        mimetype: downloaded.mimetype?.startsWith('video/') ? downloaded.mimetype : mimetype
      });
      const set = {
        'video.filename': saved.filename,
        'video.path': saved.path,
        'video.storage': saved.storage,
        'video.mimetype': saved.mimetype,
        'video.size': saved.size,
        'video.storageStatus': 'stored'
      };
      const update = saved.url
        ? { $set: { ...set, 'video.url': saved.url } }
        : { $set: set, $unset: { 'video.url': '' } };
      await TryOn.findByIdAndUpdate(tryOnId, update);
      console.log(JSON.stringify({
        level: 'info',
        event: 'tryon_video_background_saved',
        tryOnId: tryOnId.toString(),
        durationMs: Math.round(performance.now() - startedAt),
        path: saved.path,
        storage: saved.storage,
        size: saved.size
      }));
    } catch (error) {
      await TryOn.findByIdAndUpdate(tryOnId, {
        $set: {
          'video.storageStatus': 'save_failed'
        }
      }).catch(() => {});
      console.error(JSON.stringify({
        level: 'error',
        event: 'tryon_video_background_save_failed',
        tryOnId: tryOnId.toString(),
        durationMs: Math.round(performance.now() - startedAt),
        error: readableError(error)
      }));
    }
  });
}

async function isolateGeneratedImage(user, image, timer) {
  const isolation = await isolateSubjectAsset({ rootDir, user, storedImage: image });
  if (isolation.metadata.processingStatus === 'completed') {
    timer?.mark('subject isolation completed', { cached: isolation.cached, path: isolation.image?.path });
  } else {
    timer?.mark('subject isolation failed', { error: isolation.metadata.processingError });
  }
  return isolation;
}

async function generateProductTryOnImage({ user, product, tryOnModel, timer }) {
  const selectedModel = tryOnModel || tryOnModelForProduct(product);
  const productPromptKey = promptKeyForProduct(product, 'full_outfit');
  timer?.mark('image generator selected', { tryOnModel: selectedModel, promptKey: productPromptKey });
  if (productPromptKey === 'saree') {
    timer?.mark('fal virtual try-on forced for saree full outfit', { promptKey: productPromptKey });
    return callFalSareeVirtualTryOn({ user, product, timer });
  }
  if (usePrunaProvider()) {
    return callPrunaTryOn({ user, product, timer });
  }
  if (selectedModel === 'fitroom/tryon-v2') {
    const clothType = fitRoomClothTypeForProduct(product);
    timer?.mark('fitroom cloth type selected', { clothType });
    return callFitRoomTryOn({ user, product, clothType, timer });
  }
  const falModel = normalizeTryOnModel(selectedModel);
  if (falModel === 'wan-v2.6-image-to-image') {
    return callFalWanImageToImage({ user, product, timer });
  }
  if (falModel === 'gpt-image-2') {
    return callFalImageEdit({ user, product, timer });
  }
  const clothType = fitRoomClothTypeForProduct(product);
  timer?.mark('fitroom cloth type selected', { clothType });
  return callFitRoomTryOn({ user, product, clothType, timer });
}

async function saveGeneratedTryOn({ user, product, tryOnModel, timer }) {
  const generated = await generateProductTryOnImage({ user, product, tryOnModel, timer });
  const filename = `tryon-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const image = await saveUserCacheFile({ user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
  timer?.mark('generated image saved', { path: image.path });
  const isolation = await isolateGeneratedImage(user, image, timer);

  return TryOn.create({
    user: user._id,
    product: product._id,
    provider: generated.provider || (generated.model?.includes('fitroom') ? 'fitroom' : 'fal'),
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    promptKey: generated.promptKey,
    providerPredictionId: generated.providerPredictionId,
    providerOutputUrl: generated.providerOutputUrl,
    providerCostUsd: generated.providerCostUsd,
    turbo: generated.turbo,
    garmentCount: generated.garmentCount,
    tokenCost: chargedTokenCost(user),
    image,
    transparentImage: isolation.image || undefined,
    imageProcessing: isolation.metadata
  });
}

async function replaceGeneratedTryOn({ user, product, tryOnModel, timer }) {
  const generated = await generateProductTryOnImage({ user, product, tryOnModel, timer });
  const filename = `tryon-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const image = await saveUserCacheFile({ user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
  timer?.mark('generated image replaced', { path: image.path });
  const isolation = await isolateGeneratedImage(user, image, timer);

  return TryOn.findOneAndUpdate(
    { user: user._id, product: product._id },
    {
      $set: {
        provider: generated.provider || (generated.model?.includes('fitroom') ? 'fitroom' : 'fal'),
        model: generated.model,
        quality: generated.quality,
        prompt: generated.prompt,
        promptKey: generated.promptKey,
        providerPredictionId: generated.providerPredictionId,
        providerOutputUrl: generated.providerOutputUrl,
        providerCostUsd: generated.providerCostUsd,
        turbo: generated.turbo,
        garmentCount: generated.garmentCount,
        tokenCost: chargedTokenCost(user),
        image,
        transparentImage: isolation.image || undefined,
        imageProcessing: isolation.metadata
      },
      $unset: {
        video: ''
      },
      $setOnInsert: {
        user: user._id,
        product: product._id
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

function cleanUrl(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function externalProductFromBody(value = {}) {
  const sourceUrl = cleanUrl(value.sourceUrl || value.affiliateLink);
  const imageUrl = cleanUrl(value.imageUrl || value.remoteImageUrl);
  if (!sourceUrl) throw new Error('External product link is missing');
  if (!imageUrl) throw new Error('External product image is missing');
  return {
    sourceUrl,
    affiliateLink: cleanUrl(value.affiliateLink || sourceUrl),
    name: String(value.name || 'Amazon product').trim(),
    brand: String(value.brand || 'Amazon').trim(),
    category: String(value.category || 'clothing').trim(),
    description: String(value.description || '').trim(),
    tags: Array.isArray(value.tags) ? value.tags : [],
    tryOnModel: inferTryOnModel(value),
    imageUrl,
    image: { remoteUrl: imageUrl }
  };
}

async function generateExternalTryOnImage({ user, product, timer }) {
  if (shouldUseFalImageEditForProduct(product)) {
    timer?.mark('external fal image edit forced for garment', { promptKey: promptKeyForProduct(product, 'full_outfit') });
    return callFalImageEdit({ user, product, timer });
  }
  if (usePrunaProvider()) {
    return callPrunaTryOn({ user, product, timer });
  }
  const clothType = fitRoomClothTypeForProduct(product);
  timer?.mark('external fitroom cloth type selected', { clothType });
  return callFitRoomTryOn({ user, product, clothType, timer });
}

async function saveGeneratedExternalTryOn({ user, product, timer }) {
  const generated = await generateExternalTryOnImage({ user, product, timer });
  const filename = `tryon-external-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const image = await saveUserCacheFile({ user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
  timer?.mark('external try-on saved', { path: image.path });
  const isolation = await isolateGeneratedImage(user, image, timer);

  return ExternalTryOn.create({
    user: user._id,
    sourceUrl: product.sourceUrl,
    affiliateLink: product.affiliateLink,
    productName: product.name,
    brand: product.brand,
    category: product.category,
    imageUrl: product.imageUrl,
    provider: generated.provider || 'fitroom',
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    promptKey: generated.promptKey,
    providerPredictionId: generated.providerPredictionId,
    providerCostUsd: generated.providerCostUsd,
    turbo: generated.turbo,
    garmentCount: generated.garmentCount,
    tokenCost: chargedTokenCost(user),
    image,
    transparentImage: isolation.image || undefined,
    imageProcessing: isolation.metadata
  });
}

async function replaceGeneratedExternalTryOn({ user, product, timer }) {
  const generated = await generateExternalTryOnImage({ user, product, timer });
  const filename = `tryon-external-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const image = await saveUserCacheFile({ user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
  timer?.mark('external try-on replaced', { path: image.path });
  const isolation = await isolateGeneratedImage(user, image, timer);

  return ExternalTryOn.findOneAndUpdate(
    { user: user._id, sourceUrl: product.sourceUrl },
    {
      $set: {
        affiliateLink: product.affiliateLink,
        productName: product.name,
        brand: product.brand,
        category: product.category,
        imageUrl: product.imageUrl,
        provider: generated.provider || 'fitroom',
        model: generated.model,
        quality: generated.quality,
        prompt: generated.prompt,
        promptKey: generated.promptKey,
        providerPredictionId: generated.providerPredictionId,
        providerOutputUrl: generated.providerOutputUrl,
        providerCostUsd: generated.providerCostUsd,
        turbo: generated.turbo,
        garmentCount: generated.garmentCount,
        tokenCost: chargedTokenCost(user),
        image,
        transparentImage: isolation.image || undefined,
        imageProcessing: isolation.metadata
      },
      $setOnInsert: {
        user: user._id,
        sourceUrl: product.sourceUrl
      }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function normalizeMemoryImageFile(file, label, timer) {
  if (!file?.buffer) return file;
  const normalized = await normalizeRasterImageBuffer({
    buffer: file.buffer,
    filename: file.originalname || `${label}.jpg`
  });
  timer?.mark(`${label} normalized`, { inputKb: Math.round(file.buffer.length / 1024), outputKb: Math.round(normalized.buffer.length / 1024) });
  return {
    ...file,
    buffer: normalized.buffer,
    mimetype: normalized.mimetype,
    originalname: normalized.filename || file.originalname,
    size: normalized.buffer.length
  };
}

async function saveUploadFile(file, prefix, user) {
  const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(file.mimetype)}`;
  const key = user
    ? path.posix.join('users', user._id.toString(), 'garments', filename)
    : filename;
  return saveBuffer({
    key,
    buffer: file.buffer,
    filename,
    mimetype: file.mimetype,
  });
}

async function saveGeneratedCustomTryOn({ user, garmentFile, promptKey, category, timer }) {
  const customProduct = {
    name: garmentFile?.originalname || 'Custom uploaded garment',
    brand: 'Custom',
    category: category || promptKey || garmentFile?.originalname || 'full outfit'
  };
  let generated;
  if (usePrunaProvider()) {
    const selectedPromptKey = promptKey || promptKeyForProduct(customProduct, 'full_outfit');
    generated = await callPrunaTryOn({
      user,
      product: customProduct,
      garmentFile,
      promptKey: selectedPromptKey,
      fallbackPromptKey: 'full_outfit',
      timer
    });
  } else {
    const selectedPromptKey = promptKey || promptKeyForProduct(customProduct, 'full_outfit');
    const clothType = fitRoomClothTypeForPromptKey(selectedPromptKey);
    timer?.mark('custom fitroom cloth type selected', { clothType });
    generated = await callFitRoomTryOn({ user, garmentFile, clothType, timer });
  }
  const filename = `tryon-custom-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const image = await saveUserCacheFile({ user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
  const garment = await saveUploadFile(garmentFile, 'garment', user);
  timer?.mark('custom try-on saved', { path: image.path });
  const isolation = await isolateGeneratedImage(user, image, timer);

  return CustomTryOn.create({
    user: user._id,
    provider: generated.provider || 'fitroom',
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    promptKey: generated.promptKey,
    providerPredictionId: generated.providerPredictionId,
    providerCostUsd: generated.providerCostUsd,
    turbo: generated.turbo,
    garmentCount: generated.garmentCount,
    tokenCost: chargedTokenCost(user),
    garment,
    image,
    transparentImage: isolation.image || undefined,
    imageProcessing: isolation.metadata
  });
}

async function reserveToken(user, timer, cost = tokenCost()) {
  if (devMode(user)) {
    timer.mark('dev mode token bypass', { tokensRemaining: user.tokens, cost: 0 });
    return user;
  }
  const chargedUser = await User.findOneAndUpdate(
    {
      _id: user._id,
      tokens: { $gte: cost },
      $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }]
    },
    { $inc: { tokens: -cost } },
    { new: true }
  );
  if (!chargedUser) return null;
  timer.mark('token reserved', { tokensRemaining: chargedUser.tokens, cost });
  return chargedUser;
}

async function refundToken(user, timer, cost = tokenCost()) {
  if (devMode(user)) {
    timer.mark('dev mode refund skipped', { tokensRemaining: user.tokens, cost: 0 });
    return user;
  }
  const refundedUser = await User.findOneAndUpdate(
    { _id: user._id, accountStatus: { $ne: 'deleted' } },
    { $inc: { tokens: cost } },
    { new: true }
  );
  if (refundedUser) timer.mark('token refunded', { cost, tokensRemaining: refundedUser.tokens });
  return refundedUser || user;
}

function tryOnQueueMode() {
  return String(process.env.TRYON_QUEUE_MODE || 'off').toLowerCase();
}

async function runProductTryOnJob({ userId, productId, requestedModel = '', forceGenerate = false }) {
  const analyticsStartedAt = Date.now();
  const timer = createTimer('generate', {
    userId: userId.toString(),
    productId,
    requestedModel,
    forceGenerate,
    queued: true
  });
  let reserved = false;
  let user = await User.findById(userId);

  try {
    if (!user) return { status: 401, body: { message: 'User not found' } };
    const accessError = accountAccessError(user);
    if (accessError) {
      await recordGenerationMetric({ user: user._id, product: productId, type: 'product_image', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: accessError.message });
      return { status: accessError.statusCode, body: { message: accessError.message } };
    }
    const requested = normalizeTryOnModel(requestedModel);
    const hasRequestedModel = Boolean(requestedModel);
    const product = await Product.findOne({ _id: productId, isActive: true, $and: [availableStatusClause()] });
    if (!product) {
      await recordGenerationMetric({ user: user._id, type: 'product_image', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'Product not found' });
      return { status: 404, body: { message: 'Product not found' } };
    }
    const existing = await TryOn.findOne({ user: user._id, product: productId });
    const productPromptKey = promptKeyForProduct(product, 'full_outfit');
    const isSareeTryOn = productPromptKey === 'saree';
    const selectedModel = isSareeTryOn ? imageModel() : (hasRequestedModel ? requested : tryOnModelForProduct(product));
    timer.mark('product loaded', {
      tryOnModel: selectedModel,
      promptKey: productPromptKey,
      existingModel: existing?.model || ''
    });

    const staleSareeTryOn = Boolean(existing) && isSareeTryOn && isStaleSareeTryOnRecord(existing, product);
    if (existing && !forceGenerate && !staleSareeTryOn) {
      timer.end({ reused: true });
      await recordGenerationMetric({ user: user._id, product: product._id, type: 'product_image', status: 'reused', provider: existing.provider, model: existing.model, durationMs: Date.now() - analyticsStartedAt });
      return { status: 200, body: { tryOn: existing.toClient(), user: user.toClient(), reused: true } };
    }

    ensureTryOnProfileReady(user);
    const chargedUser = await reserveToken(user, timer);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      await recordGenerationMetric({ user: user._id, product: product._id, type: 'product_image', status: 'rejected', model: selectedModel, durationMs: Date.now() - analyticsStartedAt, error: 'insufficient tokens' });
      return { status: 402, body: { message: 'Not enough tokens for AI try-on' } };
    }
    reserved = true;
    user = chargedUser;

    const generationModel = isSareeTryOn ? '' : (hasRequestedModel ? selectedModel : '');
    const shouldReplaceExisting = forceGenerate || staleSareeTryOn;
    const tryOn = shouldReplaceExisting
      ? await replaceGeneratedTryOn({ user, product, tryOnModel: generationModel, timer })
      : await saveGeneratedTryOn({ user, product, tryOnModel: generationModel, timer });
    timer.end({ reused: false, tokensRemaining: user.tokens });
    await recordGenerationMetric({ user: user._id, product: product._id, type: 'product_image', status: 'succeeded', provider: tryOn.provider, model: tryOn.model, providerCostUsd: tryOn.providerCostUsd, tokensCharged: chargedTokenCost(user), durationMs: Date.now() - analyticsStartedAt });

    return { status: 201, body: { tryOn: tryOn.toClient(), user: user.toClient(), reused: false } };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await TryOn.findOne({ user: user?._id, product: productId });
      if (existing) {
        const duplicateRefund = reserved ? chargedTokenCost(user) : 0;
        if (reserved) {
          user = await refundToken(user, timer);
          reserved = false;
        }
        timer.end({ reused: true, duplicate: true });
        await recordGenerationMetric({ user: user._id, product: productId, type: 'product_image', status: 'reused', provider: existing.provider, model: existing.model, tokensCharged: duplicateRefund, tokensRefunded: duplicateRefund, durationMs: Date.now() - analyticsStartedAt });
        return { status: 200, body: { tryOn: existing.toClient(), user: user.toClient(), reused: true } };
      }
    }
    const tokensRefunded = reserved ? chargedTokenCost(user) : 0;
    if (reserved) user = await refundToken(user, timer);
    const message = readableError(error, 'Could not generate AI try-on');
    timer.end({ error: message });
    await recordGenerationMetric({ user: user?._id || userId, product: productId, type: 'product_image', status: 'failed', model: requestedModel, durationMs: Date.now() - analyticsStartedAt, tokensCharged: tokensRefunded, tokensRefunded, error: message });
    return { status: 400, body: { message } };
  }
}

router.get('/', requireUser, tryOnReadLimiter, async (req, res) => {
  const ids = String(req.query.productIds || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 96);
  const filter = { user: req.user._id };
  if (ids.length) filter.product = { $in: ids };
  const tryOns = await TryOn.find(filter).sort({ createdAt: -1 }).lean();
  const productIds = [...new Set(tryOns.map((tryOn) => documentId(tryOn.product)).filter(Boolean))];
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('name brand category garmentPlacement').lean()
    : [];
  const productsById = new Map(products.map((product) => [documentId(product), product]));
  const visibleTryOns = tryOns.filter((tryOn) => !isStaleSareeTryOnRecord(tryOn, productsById.get(documentId(tryOn.product))));
  res.json({ tryOns: visibleTryOns.map(tryOnToClient) });
});

router.get('/history', requireUser, tryOnReadLimiter, async (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const queryLimit = Math.min(80, Math.max(limit, 24));
  const userFilter = { user: req.user._id };

  const [
    productTryOns,
    customTryOns,
    externalTryOns,
    productCount,
    customCount,
    externalCount
  ] = await Promise.all([
    TryOn.find(userFilter)
      .select('user product provider model quality tokenCost image transparentImage imageProcessing video createdAt updatedAt')
      .populate('product', 'name brand category gender image affiliateLink sourceUrl price compareAtPrice currency rating ratingCount badge description tags colors sizes sizeNotes tryOnModel isFeatured isNewArrival availabilityStatus availabilityCheckedAt availabilitySource sourceProvider sourceProductId')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    CustomTryOn.find(userFilter)
      .select('user provider model quality tokenCost garment image transparentImage imageProcessing createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    ExternalTryOn.find(userFilter)
      .select('user sourceUrl affiliateLink productName brand category imageUrl provider model quality tokenCost image transparentImage imageProcessing createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    TryOn.countDocuments(userFilter),
    CustomTryOn.countDocuments(userFilter),
    ExternalTryOn.countDocuments(userFilter)
  ]);

  const visibleProductTryOns = productTryOns.filter((tryOn) => !isStaleSareeTryOnRecord(tryOn, tryOn.product));
  const items = [
    ...visibleProductTryOns.map(productHistoryItem),
    ...customTryOns.map(customHistoryItem),
    ...externalTryOns.map(externalHistoryItem)
  ]
    .filter((item) => item.imageUrl || item.videoUrl)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  res.json({
    items,
    total: productCount + customCount + externalCount
  });
});

router.get('/credit-history', requireUser, tryOnReadLimiter, async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const events = await CreditEvent.find({ user: req.user._id })
    .select('action product productTitle productImageUrl tokens balanceAfter direction source sourceId metadata createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ events: events.map(creditEventToClient) });
});

router.get('/custom/latest', requireUser, tryOnReadLimiter, async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  const tryOns = await CustomTryOn.find({
    user: req.user._id,
    'image.storage': { $ne: 'remote-pending' }
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(10);
  const latest = tryOns
    .map((tryOn) => tryOn.toClient())
    .find((tryOn) => Boolean(tryOn.imageUrl));
  res.json({ tryOn: latest || null });
});

async function requireTryOnMediaAccess(req, { scope, kind, field }) {
  let claims;
  try {
    claims = verifyMediaToken(mediaTokenFromRequest(req), {
      mediaId: req.params.id,
      kind: tryOnMediaTokenKind({ kind, scope, field })
    });
  } catch {
    return null;
  }
  const Model = kind === 'video' ? generatedVideoModelForScope(scope) : generatedImageModelForScope(scope);
  if (!Model) return null;
  const record = await Model.findById(req.params.id).select(`${field} user`).lean();
  if (!record || documentId(record.user) !== documentId(claims.sub)) return null;
  return record;
}

router.get('/image/:scope/:id', async (req, res) => {
  const scope = String(req.params.scope || '').toLowerCase();
  try {
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'image', field: 'image' });
    if (!record) return res.status(401).json({ message: 'Generated image link expired' });
    const image = record.image;
    if (!image) return res.status(404).json({ message: 'Generated image not found' });

    if (image.sourceUrl) {
      const { bytes, mimetype } = await generatedBytesFromUrl(image.sourceUrl);
      res.set({
        'Content-Type': mimetype || image.mimetype || 'image/jpeg',
        'Cache-Control': 'private, max-age=300'
      });
      return res.send(bytes);
    }

    if (!image.path && !image.url && !image.remoteUrl) {
      return res.status(404).json({ message: 'Generated image is not available yet' });
    }
    const stored = await readStoredFile(image, 'generated try-on image');
    res.set({
      'Content-Type': stored.mimetype || image.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.buffer);
  } catch (error) {
    console.error('tryon_image_proxy_failed', { scope, id: req.params.id, error });
    return res.status(502).json({ message: 'Generated image is temporarily unavailable' });
  }
});

router.get('/video/:scope/:id', async (req, res) => {
  const scope = String(req.params.scope || '').toLowerCase();
  try {
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'video', field: 'video' });
    if (!record) return res.status(401).json({ message: 'Generated video link expired' });
    const video = record.video;
    if (!video) return res.status(404).json({ message: 'Generated video not found' });

    if (video.providerOutputUrl && !video.path && !video.url) {
      const upstream = await fetchPrunaOutput(video.providerOutputUrl, {
        accept: 'video/mp4,video/*,*/*;q=0.8',
        range: req.headers.range || ''
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel?.().catch?.(() => {});
        return res.status(502).json({ message: 'Could not stream video' });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(upstream.status);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (!res.getHeader('content-type')) res.setHeader('content-type', 'video/mp4');
      return Readable.fromWeb(upstream.body).pipe(res);
    }

    if (!video.path && !video.url && !video.remoteUrl) {
      return res.status(404).json({ message: 'Generated video not found' });
    }
    const stored = await readStoredFile(video, 'generated try-on video');
    return sendVideoBytes(req, res, {
      bytes: stored.buffer,
      mimetype: stored.mimetype || video.mimetype || 'video/mp4'
    });
  } catch (error) {
    console.error('tryon_video_proxy_failed', { scope, id: req.params.id, error });
    return res.status(502).json({ message: 'Generated video is temporarily unavailable' });
  }
});

router.get('/garment/:scope/:id', async (req, res) => {
  const scope = String(req.params.scope || '').toLowerCase();
  try {
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'garment', field: 'garment' });
    if (!record) return res.status(401).json({ message: 'Garment media link expired' });
    const garment = record.garment;
    if (!garment?.path && !garment?.url && !garment?.remoteUrl) {
      return res.status(404).json({ message: 'Garment media not found' });
    }
    const stored = await readStoredFile(garment, 'try-on garment');
    res.set({
      'Content-Type': stored.mimetype || garment.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.buffer);
  } catch (error) {
    console.error('tryon_garment_proxy_failed', { scope, id: req.params.id, error });
    return res.status(502).json({ message: 'Garment media is temporarily unavailable' });
  }
});

router.get('/:tryOnId/video/media', async (req, res) => {
  try {
    let claims;
    try {
      claims = verifyMediaToken(req.query?.mediaToken, { mediaId: req.params.tryOnId, kind: 'tryon-video' });
    } catch {
      return res.status(401).json({ message: 'Invalid or expired media access' });
    }
    const tryOn = await TryOn.findOne({ _id: req.params.tryOnId, user: claims.sub }).select('video').lean();
    const outputUrl = String(tryOn?.video?.providerOutputUrl || '').trim();
    if (!outputUrl) return res.status(404).json({ message: 'Video is not available' });

    const upstream = await fetchPrunaOutput(outputUrl, {
      accept: 'video/mp4,video/*,*/*;q=0.8',
      range: req.headers.range || ''
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel?.().catch?.(() => {});
      return res.status(502).json({ message: 'Could not stream video' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.status(upstream.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'video/mp4');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.status(400).json({ message: readableVideoError(error, 'Could not stream video try-on') });
  }
});

router.post('/custom', requireUser, tryOnImageBurstLimiter, tryOnImageHourlyLimiter, upload.single('garment'), async (req, res) => {
  const analyticsStartedAt = Date.now();
  const timer = createTimer('custom', { userId: req.user._id.toString() });
  let reserved = false;

  try {
    if (!req.file) {
      await recordGenerationMetric({ user: req.user._id, type: 'custom_image', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'Upload a clothing image first' });
      return res.status(400).json({ message: 'Upload a clothing image first' });
    }
    ensureTryOnProfileReady(req.user);
    const garmentFile = await normalizeMemoryImageFile(req.file, 'garment', timer);
    const chargedUser = await reserveToken(req.user, timer);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      await recordGenerationMetric({ user: req.user._id, type: 'custom_image', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'insufficient tokens' });
      return res.status(402).json({ message: 'Not enough tokens for AI try-on' });
    }
    reserved = true;
    req.user = chargedUser;

    const tryOn = await saveGeneratedCustomTryOn({
      user: req.user,
      garmentFile,
      promptKey: String(req.body?.promptKey || '').trim(),
      category: String(req.body?.category || '').trim(),
      timer
    });
    timer.end({ tokensRemaining: req.user.tokens });
    await recordGenerationMetric({ user: req.user._id, type: 'custom_image', status: 'succeeded', provider: tryOn.provider, model: tryOn.model, providerCostUsd: tryOn.providerCostUsd, tokensCharged: chargedTokenCost(req.user), durationMs: Date.now() - analyticsStartedAt });
    res.status(201).json({ tryOn: tryOn.toClient(), user: req.user.toClient() });
  } catch (error) {
    const tokensRefunded = reserved ? chargedTokenCost(req.user) : 0;
    if (reserved) req.user = await refundToken(req.user, timer);
    const message = readableError(error, 'Could not generate custom AI try-on');
    timer.end({ error: message });
    await recordGenerationMetric({ user: req.user._id, type: 'custom_image', status: 'failed', durationMs: Date.now() - analyticsStartedAt, tokensCharged: tokensRefunded, tokensRefunded, error: message });
    res.status(400).json({ message });
  }
});

router.post('/external', requireUser, tryOnImageBurstLimiter, tryOnImageHourlyLimiter, async (req, res) => {
  const analyticsStartedAt = Date.now();
  const forceGenerate = Boolean(req.body?.force || req.body?.refresh);
  let product;
  try {
    product = externalProductFromBody(req.body?.product);
  } catch (error) {
    return res.status(400).json({ message: readableError(error, 'External product is missing') });
  }

  const compatibility = wearableCompatibility(product);
  if (!compatibility.compatible) {
    return res.status(400).json({ message: compatibility.reason });
  }
  const genderMatch = genderCompatibility(product, req.user.genderPreference);
  if (!genderMatch.compatible) {
    return res.status(400).json({ message: genderMatch.reason });
  }

  const timer = createTimer('external', {
    userId: req.user._id.toString(),
    sourceUrl: product.sourceUrl,
    forceGenerate
  });
  let reserved = false;

  try {
    const existing = await ExternalTryOn.findOne({ user: req.user._id, sourceUrl: product.sourceUrl });
    if (existing && !forceGenerate) {
      timer.end({ reused: true });
      await recordGenerationMetric({ user: req.user._id, type: 'external_image', status: 'reused', provider: existing.provider, model: existing.model, durationMs: Date.now() - analyticsStartedAt });
      return res.json({ tryOn: existing.toClient(), user: req.user.toClient(), reused: true });
    }

    ensureTryOnProfileReady(req.user);
    const chargedUser = await reserveToken(req.user, timer);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      await recordGenerationMetric({ user: req.user._id, type: 'external_image', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'insufficient tokens' });
      return res.status(402).json({ message: 'Not enough tokens for AI try-on' });
    }
    reserved = true;
    req.user = chargedUser;

    const tryOn = forceGenerate
      ? await replaceGeneratedExternalTryOn({ user: req.user, product, timer })
      : await saveGeneratedExternalTryOn({ user: req.user, product, timer });
    timer.end({ reused: false, tokensRemaining: req.user.tokens });
    await recordGenerationMetric({ user: req.user._id, type: 'external_image', status: 'succeeded', provider: tryOn.provider, model: tryOn.model, providerCostUsd: tryOn.providerCostUsd, tokensCharged: chargedTokenCost(req.user), durationMs: Date.now() - analyticsStartedAt });
    res.status(201).json({ tryOn: tryOn.toClient(), user: req.user.toClient(), reused: false });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await ExternalTryOn.findOne({ user: req.user._id, sourceUrl: product.sourceUrl });
      if (existing) {
        const duplicateRefund = reserved ? chargedTokenCost(req.user) : 0;
        if (reserved) {
          req.user = await refundToken(req.user, timer);
          reserved = false;
        }
        timer.end({ reused: true, duplicate: true });
        await recordGenerationMetric({ user: req.user._id, type: 'external_image', status: 'reused', provider: existing.provider, model: existing.model, tokensCharged: duplicateRefund, tokensRefunded: duplicateRefund, durationMs: Date.now() - analyticsStartedAt });
        return res.json({ tryOn: existing.toClient(), user: req.user.toClient(), reused: true });
      }
    }
    const tokensRefunded = reserved ? chargedTokenCost(req.user) : 0;
    if (reserved) req.user = await refundToken(req.user, timer);
    const message = readableError(error, 'Could not generate external AI try-on');
    timer.end({ error: message });
    await recordGenerationMetric({ user: req.user._id, type: 'external_image', status: 'failed', durationMs: Date.now() - analyticsStartedAt, tokensCharged: tokensRefunded, tokensRefunded, error: message });
    res.status(400).json({ message });
  }
});

router.post('/:productId/video', requireUser, async (req, res) => {
  const analyticsStartedAt = Date.now();
  const forceGenerate = Boolean(req.body?.force || req.body?.refresh);
  const timer = createTimer('video', {
    userId: req.user._id.toString(),
    productId: req.params.productId,
    forceGenerate
  });
  const cost = videoTokenCost();
  let reserved = false;

  try {
    const [product, existing] = await Promise.all([
      Product.findOne({ _id: req.params.productId, isActive: true, $and: [availableStatusClause()] }),
      TryOn.findOne({ user: req.user._id, product: req.params.productId })
    ]);
    timer.mark('video prerequisites loaded', {
      productFound: Boolean(product),
      tryOnFound: Boolean(existing),
      hasImage: Boolean(existing?.image?.path),
      hasVideo: Boolean(existing?.video?.path || existing?.video?.url || existing?.video?.providerOutputUrl)
    });
    if (!product) {
      timer.end({ error: 'product not found' });
      await recordGenerationMetric({ user: req.user._id, type: 'product_video', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'product not found' });
      return res.status(404).json({ message: 'Product not found' });
    }
    if (!existing?.image?.path) {
      timer.end({ error: 'missing try-on image' });
      await recordGenerationMetric({ user: req.user._id, product: product._id, type: 'product_video', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'missing try-on image' });
      return res.status(400).json({ message: 'Generate the AI clothing try-on image before creating a video.' });
    }
    if ((existing.video?.path || existing.video?.url || existing.video?.providerOutputUrl) && !forceGenerate) {
      logPrunaVideo('reusing existing video', {
        tryOnId: existing._id?.toString?.() || '',
        videoModel: existing.video?.model || '',
        videoQuality: existing.video?.quality || '',
        videoGeneratedAt: existing.video?.generatedAt || null,
        videoPath: existing.video?.path || '',
        videoStorageStatus: existing.video?.storageStatus || ''
      });
      timer.end({ reused: true });
      await recordGenerationMetric({ user: req.user._id, product: product._id, type: 'product_video', status: 'reused', provider: existing.video?.provider, model: existing.video?.model, durationMs: Date.now() - analyticsStartedAt });
      return res.json({ tryOn: existing.toClient(), user: req.user.toClient(), reused: true });
    }
    logPrunaVideo('generating video', {
      productId: req.params.productId,
      forceGenerate,
      existingTryOnId: existing._id?.toString?.() || '',
      existingImageProvider: existing.provider || '',
      existingImageModel: existing.model || '',
      existingImageQuality: existing.quality || '',
      existingImagePromptKey: existing.promptKey || '',
      existingImageTurbo: existing.turbo,
      existingImagePath: existing.image?.path || '',
      existingVideoPath: existing.video?.path || ''
    });

    const chargedUser = await reserveToken(req.user, timer, cost);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      await recordGenerationMetric({ user: req.user._id, product: product._id, type: 'product_video', status: 'rejected', durationMs: Date.now() - analyticsStartedAt, error: 'insufficient tokens' });
      return res.status(402).json({ message: 'Not enough tokens for video try-on' });
    }
    reserved = true;
    req.user = chargedUser;

    const generated = usePrunaVideoProvider()
      ? await callPrunaTryOnVideo({ tryOn: existing, product, user: req.user, timer })
      : await callPixverseTryOnVideo({ tryOn: existing, product, user: req.user, timer });
    const filename = `tryon-video-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
    let video;
    if (generated.deferDownload && generated.providerOutputUrl) {
      video = {
        filename,
        path: '',
        url: videoMediaUrl(existing._id),
        storage: 'pruna-proxy',
        mimetype: generated.mimetype || 'video/mp4',
        size: 0,
        providerOutputUrl: generated.providerOutputUrl,
        storageStatus: 'saving'
      };
      timer.mark('video provider url ready', {
        outputUrl: shortUrlForLog(generated.providerOutputUrl),
        proxyUrl: video.url
      });
    } else {
      video = await saveUserCacheFile({ user: req.user, bytes: generated.bytes, filename, mimetype: generated.mimetype });
      timer.mark('video file saved', {
        outputKb: Math.round(generated.bytes.length / 1024),
        mimetype: generated.mimetype,
        path: video.path
      });
    }
    const updated = await TryOn.findOneAndUpdate(
      { user: req.user._id, product: req.params.productId },
      {
        $set: {
          video: {
            ...video,
            model: generated.model,
            prompt: generated.prompt,
            provider: generated.provider,
            providerPredictionId: generated.providerPredictionId,
            providerOutputUrl: generated.providerOutputUrl,
            providerCostUsd: generated.providerCostUsd,
            storageStatus: video.storageStatus || 'stored',
            draft: generated.draft,
            duration: generated.duration,
            resolution: generated.resolution,
            quality: generated.quality,
            tokenCost: chargedVideoTokenCost(req.user),
            generatedAt: new Date()
          }
        }
      },
      { new: true }
    );
    timer.mark('video metadata saved', {
      provider: generated.provider,
      predictionId: generated.providerPredictionId || '',
      cost: generated.providerCostUsd,
      storageStatus: video.storageStatus || 'stored'
    });
    if (generated.deferDownload && generated.providerOutputUrl) {
      backgroundSavePrunaVideo({
        tryOnId: existing._id,
        user: req.user,
        outputUrl: generated.providerOutputUrl,
        filename,
        mimetype: generated.mimetype || 'video/mp4'
      });
      timer.mark('video background save queued', { filename });
    }
    timer.end({ reused: false, tokensRemaining: req.user.tokens, path: video.path || '', proxyUrl: video.url || '' });
    await recordGenerationMetric({ user: req.user._id, product: product._id, type: 'product_video', status: 'succeeded', provider: generated.provider, model: generated.model, providerCostUsd: generated.providerCostUsd, tokensCharged: chargedVideoTokenCost(req.user), durationMs: Date.now() - analyticsStartedAt });
    res.status(201).json({ tryOn: updated.toClient(), user: req.user.toClient(), reused: false });
  } catch (error) {
    const tokensRefunded = reserved ? chargedVideoTokenCost(req.user) : 0;
    if (reserved) req.user = await refundToken(req.user, timer, cost);
    const message = readableVideoError(error, 'Could not generate video try-on');
    timer.end({ error: message });
    await recordGenerationMetric({ user: req.user._id, product: req.params.productId, type: 'product_video', status: 'failed', durationMs: Date.now() - analyticsStartedAt, tokensCharged: tokensRefunded, tokensRefunded, error: message });
    res.status(400).json({ message });
  }
});

router.post('/:productId', requireUser, tryOnImageBurstLimiter, tryOnImageHourlyLimiter, async (req, res) => {
  const requestedModel = String(req.body?.tryOnModel || '');
  const forceGenerate = Boolean(req.body?.force || req.body?.refresh);

  try {
    if (tryOnQueueMode() === 'async') {
      const job = await enqueueJob('tryon', 'product-generate', {
        userId: req.user._id.toString(),
        productId: req.params.productId,
        requestedModel,
        forceGenerate
      }, {
        jobId: safeJobId('tryon', req.user._id, req.params.productId, forceGenerate ? Date.now() : 'reuse')
      });
      if (!job) return res.status(503).json({ message: 'Try-on queue is not available' });
      return res.status(202).json({
        queued: true,
        queue: 'tryon',
        jobId: job.id,
        statusUrl: `/api/jobs/tryon/${encodeURIComponent(job.id)}`,
        statusPath: `/jobs/tryon/${encodeURIComponent(job.id)}`
      });
    }

    if (tryOnQueueMode() === 'wait') {
      const queued = await enqueueJobAndWait('tryon', 'product-generate', {
        userId: req.user._id.toString(),
        productId: req.params.productId,
        requestedModel,
        forceGenerate
      }, {
        jobId: safeJobId('tryon', req.user._id, req.params.productId, forceGenerate ? Date.now() : 'reuse'),
        waitTimeoutMs: Number(process.env.TRYON_QUEUE_WAIT_TIMEOUT_MS || 180_000)
      });
      if (!queued) return res.status(503).json({ message: 'Try-on queue is not available' });
      return res.status(queued.result.status || 200).json(queued.result.body);
    }

    const result = await runProductTryOnJob({
      userId: req.user._id.toString(),
      productId: req.params.productId,
      requestedModel,
      forceGenerate
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    const message = readableError(error, 'Could not generate AI try-on');
    res.status(400).json({ message });
  }
});

export default router;
export {
  creditEventToClient,
  customHistoryItem,
  externalHistoryItem,
  fitRoomClothTypeForProduct,
  fitRoomClothTypeForPromptKey,
  productHistoryItem,
  runProductTryOnJob,
  sareeImageQuality,
  shouldUseFalImageEditForProduct,
  tryOnMediaTokenKind
};
