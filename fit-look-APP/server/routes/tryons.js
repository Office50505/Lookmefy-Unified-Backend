import express from 'express';
import heicConvert from 'heic-convert';
import multer from 'multer';
import path from 'node:path';
import sharp from 'sharp';
import CustomTryOn from '../models/CustomTryOn.js';
import CreditEvent, { creditEventToClient } from '../models/CreditEvent.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import Product from '../models/Product.js';
import TryOn, { tryOnToClient } from '../models/TryOn.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { effectiveDevMode } from '../utils/devMode.js';
import { inlineOrQueue, registerJobHandler } from '../utils/jobs.js';
import { logger } from '../utils/logger.js';
import { mediaTokenFromRequest, tryOnMediaUrl, verifyMediaAccess } from '../utils/mediaAccess.js';
import { fetchPublicImage, remoteImageMaxBytes, remoteImageTimeoutMs } from '../utils/remoteFetch.js';
import { deleteStoredFile, isStorageConfigurationError, readStoredFile, saveStoredFile, storedFileToClientUrl } from '../utils/storage.js';
import { inferTryOnModel, normalizeTryOnModel } from '../utils/tryOnModel.js';
import { wearableCompatibility } from '../utils/wearable.js';
import { genderCompatibility } from '../utils/genderPreference.js';

const router = express.Router();
const imageCacheTtlMs = Number(process.env.TRYON_IMAGE_CACHE_TTL_MS || 15 * 60 * 1000);
const imageCacheMaxItems = Number(process.env.TRYON_IMAGE_CACHE_MAX_ITEMS || 80);
const localImageDataUriCache = new Map();
const remoteImageDataUriCache = new Map();
const inFlightImageDataUriCache = new Map();
const avifExtensions = new Set(['.avif']);
const avifMimeTypes = new Set(['image/avif', 'image/x-avif']);
const heicExtensions = new Set(['.heic', '.heif']);
const heicMimeTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
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
  return String(file.mimetype || '').startsWith('image/') || isAvifUpload(file) || heicExtensions.has(extensionForFile(file));
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
  return effectiveDevMode(user);
}

function chargedTokenCost(user) {
  return devMode(user) ? 0 : tokenCost();
}

function chargedVideoTokenCost(user) {
  return devMode(user) ? 0 : videoTokenCost();
}

function ensureTryOnProfileReady(user) {
  if (!user?.bodyPhoto?.path) {
    throw new Error('Upload a profile photo from your profile before generating AI try-ons.');
  }
  const status = user?.bodyPhoto?.status || 'ready';
  if (status === 'generating') {
    throw new Error('Your full-body try-on profile is still being prepared. You can keep browsing and try again in a minute.');
  }
  if (status === 'failed') {
    throw new Error('Could not prepare your full-body try-on profile. Please upload a clearer selfie or body photo from your profile page.');
  }
}

function creditProductTitle(product) {
  return String(product?.name || product?.title || product?.productName || product?.brand || 'Product').trim() || 'Product';
}

function creditProductImageUrl(product) {
  if (product?.image?.path) return storedFileToClientUrl(product.image);
  return product?.imageUrl || product?.image?.remoteUrl || '';
}

async function recordCreditEvent({ user, action, product, tokens, balanceAfter, metadata = {} }) {
  try {
    return await CreditEvent.create({
      user: user._id,
      action,
      product: product?._id,
      productTitle: creditProductTitle(product),
      productImageUrl: creditProductImageUrl(product),
      tokens: Number(tokens) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      metadata
    });
  } catch (error) {
    console.error('[credit-history] could not record event', { error: error.message });
    return null;
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
      return 'This try-on was blocked by the image provider safety check. Try another product image or upload a clearer profile photo.';
    }
    return redactLargeData(value);
  }
  if (value instanceof Error) return readableError(value.message, fallback);
  if (Array.isArray(value)) {
    const policyError = value.find((item) => /content[_\s-]?policy|safety|flagged/i.test([item?.type, item?.code, item?.msg, item?.message].filter(Boolean).join(' ')));
    if (policyError) {
      return 'This try-on was blocked by the image provider safety check. Try another product image or upload a clearer profile photo.';
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
      return 'This try-on was blocked by the image provider safety check. Try another product image or upload a clearer profile photo.';
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
  console.log(`[tryon:${label}] start`, meta);
  return {
    mark(step, extra = {}) {
      const now = performance.now();
      console.log(`[tryon:${label}] ${step}`, {
        stepMs: Math.round(now - last),
        totalMs: Math.round(now - start),
        ...extra
      });
      last = now;
    },
    end(extra = {}) {
      const now = performance.now();
      console.log(`[tryon:${label}] done`, {
        totalMs: Math.round(now - start),
        ...extra
      });
    }
  };
}

function imageModel() {
  return process.env.FAL_TRYON_MODEL || 'openai/gpt-image-2/edit';
}

function wanImageToImageModel() {
  return process.env.FAL_WAN_IMAGE_TO_IMAGE_MODEL || 'wan/v2.6/image-to-image';
}

function prunaVideoModel() {
  return process.env.PRUNA_VIDEO_MODEL || process.env.PRUNA_TRYON_VIDEO_MODEL || 'p-video';
}

function prunaVideoResolution() {
  return process.env.PRUNA_VIDEO_RESOLUTION || process.env.PRUNA_TRYON_VIDEO_RESOLUTION || '720p';
}

function prunaVideoDuration() {
  const value = Number(process.env.PRUNA_VIDEO_DURATION || process.env.PRUNA_TRYON_VIDEO_DURATION || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function prunaVideoFps() {
  const value = Number(process.env.PRUNA_VIDEO_FPS || process.env.PRUNA_TRYON_VIDEO_FPS || 24);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function prunaVideoDraft() {
  return /^(1|true|yes)$/i.test(String(process.env.PRUNA_VIDEO_DRAFT || process.env.PRUNA_TRYON_VIDEO_DRAFT || '').trim());
}

function prunaVideoAspectRatio() {
  return String(process.env.PRUNA_VIDEO_ASPECT_RATIO || process.env.PRUNA_TRYON_VIDEO_ASPECT_RATIO || '').trim();
}

function prunaBaseUrl() {
  const raw = String(process.env.PRUNA_BASE_URL || 'https://api.pruna.ai/v1').trim() || 'https://api.pruna.ai/v1';
  const clean = raw.replace(/\/+$/, '');
  try {
    const url = new URL(clean);
    if (url.origin === 'https://api.pruna.ai' && (!url.pathname || url.pathname === '/')) {
      url.pathname = '/v1';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return clean;
  }
  return clean;
}

function prunaTryOnModel() {
  return process.env.PRUNA_TRYON_MODEL || 'p-image-try-on';
}

function prunaGlassesModel() {
  return process.env.PRUNA_GLASSES_MODEL || 'p-try-on-glasses';
}

function prunaTrySync() {
  const value = process.env.PRUNA_TRYON_SYNC ?? process.env.PRUNA_IMAGE_TRY_SYNC ?? '';
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function prunaOutputFormat() {
  return process.env.PRUNA_TRYON_OUTPUT_FORMAT || 'jpg';
}

function prunaOutputMimetype() {
  const format = String(prunaOutputFormat() || '').toLowerCase();
  if (format.includes('png')) return 'image/png';
  if (format.includes('webp')) return 'image/webp';
  if (format.includes('avif')) return 'image/avif';
  return 'image/jpeg';
}

function prunaOutputQuality() {
  const value = Number(process.env.PRUNA_TRYON_OUTPUT_QUALITY || 95);
  return Number.isFinite(value) && value > 0 ? Math.min(100, Math.round(value)) : 95;
}

function prunaPreserveInputSize() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.PRUNA_TRYON_PRESERVE_INPUT_SIZE ?? 'true').toLowerCase());
}

function tryOnModelForProduct() {
  return 'pruna/p-image-try-on';
}

function imageQuality() {
  return process.env.FAL_IMAGE_QUALITY || 'low';
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

function fitRoomClothTypeForProduct() {
  return 'full_set';
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

function isHeicBytes(bytes, mimetype = '') {
  return heicMimeTypes.has(String(mimetype || '').toLowerCase()) || imageMimeTypeFromBuffer(bytes) === 'image/heif';
}

function filenameWithExtension(filename = '', fallbackName = 'image', extension = '.jpg') {
  const parsed = path.parse(filename || fallbackName);
  return `${parsed.name || fallbackName}${extension}`;
}

async function normalizeAvifImage({ bytes, mimetype, filename, label, timer }) {
  const extension = path.extname(filename || '').toLowerCase();
  const needsAvifConversion = isAvifBytes(bytes, mimetype) || avifExtensions.has(extension);
  const needsHeicConversion = isHeicBytes(bytes, mimetype) || heicExtensions.has(extension);
  if (!needsAvifConversion && !needsHeicConversion) return { bytes, mimetype, filename };

  const outputBytes = needsHeicConversion
    ? Buffer.from(await heicConvert({ buffer: bytes, format: 'JPEG', quality: 0.92 }))
    : await sharp(bytes).jpeg({ quality: 90 }).toBuffer();
  const outputFilename = filenameWithExtension(filename, label, '.jpg');
  timer?.mark(`${label} ${needsHeicConversion ? 'heic/heif' : 'avif'} converted`, {
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

function isMissingStoredImageError(error) {
  return /Bunny storage \(404\)|ENOENT|no such file or directory|Stored file is missing/i.test(readableError(error, ''));
}

function storedImageUnavailableMessage(label) {
  if (label === 'person') {
    return 'Your saved try-on profile photo is unavailable. Upload a new profile photo from Profile, then try again.';
  }
  if (label === 'product') {
    return 'This product image is unavailable for AI try-on. Try another product.';
  }
  const readableLabel = String(label || 'Uploaded').replace(/[-_]+/g, ' ').replace(/^\w/, (char) => char.toUpperCase());
  return `${readableLabel} image is unavailable. Upload it again and try once more.`;
}

async function readRequiredStoredImage(image, label) {
  try {
    return await readStoredFile(image);
  } catch (error) {
    if (isMissingStoredImageError(error)) throw new Error(storedImageUnavailableMessage(label));
    throw error;
  }
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
  if (!image?.path) throw new Error(`${label} image is missing`);
  const mimetype = image.mimetype || 'image/jpeg';
  const minWidth = Number(options.minWidth || 0);
  const minHeight = Number(options.minHeight || 0);
  const key = `stored:${image.storage || 'local'}:${image.path}:${image.url || ''}:${image.size || ''}:${mimetype}:${minWidth || ''}x${minHeight || ''}`;
  return cachedDataUri({
    cache: localImageDataUriCache,
    key,
    timer,
    label,
    load: async () => {
      const stored = await readRequiredStoredImage(image, label);
      const normalized = await normalizeAvifImage({
        bytes: stored.bytes,
        mimetype: stored.mimetype || mimetype,
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
          const { bytes, mimetype } = await fetchPublicImage(url, {
            label: 'Product image',
            timeoutMs: remoteImageTimeoutMs(),
            maxBytes: remoteImageMaxBytes(),
            headers: {
              accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'user-agent': 'Mozilla/5.0 Lookmefy image fetcher'
            }
          });
          const normalized = await normalizeAvifImage({
            bytes,
            mimetype: mimetype || 'image/jpeg',
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
  if (!image?.path) throw new Error(`${label} image is missing`);
  const mimetype = image.mimetype || 'image/jpeg';
  const stored = await readRequiredStoredImage(image, label);
  const normalized = await normalizeAvifImage({
    bytes: stored.bytes,
    mimetype: stored.mimetype || mimetype,
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
  const remote = await fetchPublicImage(url, {
    label: `${label} image`,
    timeoutMs: remoteImageTimeoutMs(),
    maxBytes: remoteImageMaxBytes(),
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy image fetcher'
    }
  });
  const normalized = await normalizeAvifImage({
    bytes: remote.bytes,
    mimetype: remote.mimetype || 'image/jpeg',
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
  const mimetype = file.mimetype || 'image/jpeg';
  const normalized = await normalizeAvifImage({
    bytes: file.buffer,
    mimetype,
    filename: file.originalname,
    label,
    timer
  });
  timer?.mark(`${label} upload file prepared`, { kb: Math.round(normalized.bytes.length / 1024), mimetype: normalized.mimetype });
  return {
    bytes: normalized.bytes,
    mimetype: normalized.mimetype,
    filename: normalized.filename || file.originalname || `${label}${extensionFor(normalized.mimetype)}`
  };
}

function appendFilePart(form, name, file) {
  form.append(name, new Blob([file.bytes], { type: file.mimetype }), file.filename);
}

function prunaHeaders(extra = {}) {
  const apiKey = process.env.PRUNA_API_KEY || process.env.PRUNA_KEY || process.env.PRUNA_TOKEN;
  if (!apiKey) throw new Error('PRUNA_API_KEY is missing on the server');
  return {
    apikey: apiKey,
    ...extra
  };
}

function prunaApiUrl(pathname = '') {
  return `${prunaBaseUrl()}${String(pathname || '').startsWith('/') ? pathname : `/${pathname}`}`;
}

function envPositiveNumber(names, fallback) {
  const keys = Array.isArray(names) ? names : [names];
  const raw = keys.map((key) => process.env[key]).find((value) => value !== undefined && value !== '');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000, label = 'Request') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function prunaUploadTimeoutMs() {
  return envPositiveNumber(['PRUNA_UPLOAD_TIMEOUT_MS', 'PRUNA_IMAGE_UPLOAD_TIMEOUT_MS'], 30_000);
}

function prunaSubmitTimeoutMs() {
  return envPositiveNumber(['PRUNA_SUBMIT_TIMEOUT_MS', 'PRUNA_IMAGE_SUBMIT_TIMEOUT_MS'], prunaTrySync() ? 25_000 : 15_000);
}

function prunaStatusTimeoutMs() {
  return envPositiveNumber(['PRUNA_STATUS_TIMEOUT_MS', 'PRUNA_IMAGE_STATUS_TIMEOUT_MS'], 12_000);
}

function prunaDownloadTimeoutMs() {
  return envPositiveNumber(['PRUNA_DOWNLOAD_TIMEOUT_MS', 'PRUNA_IMAGE_DOWNLOAD_TIMEOUT_MS'], 30_000);
}

function prunaAbsoluteUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(?:https?:|data:(?:image|video)\/)/i.test(raw)) return raw;
  if (/^file-[a-z0-9_-]+$/i.test(raw)) return prunaApiUrl(`/files/${raw}`);
  if (raw.startsWith('/')) {
    const origin = new URL(prunaBaseUrl()).origin;
    return `${origin}${raw}`;
  }
  if (/^predictions\/delivery\//i.test(raw) || /^v1\/predictions\/delivery\//i.test(raw)) {
    const origin = new URL(prunaBaseUrl()).origin;
    return `${origin}/${raw.replace(/^\/+/, '')}`;
  }
  return '';
}

function prunaGeneratedImageUrl(value = '') {
  const url = prunaAbsoluteUrl(value);
  if (!url) return '';
  if (/^data:image\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (/\/predictions\/(?:status|cancel)\//i.test(parsed.pathname)) return '';
    if (/\/predictions\/delivery\//i.test(parsed.pathname)) return url;
    if (/\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)/i.test(parsed.pathname + parsed.search)) return url;
    if (/^https?:$/i.test(parsed.protocol)) return url;
  } catch {
    return '';
  }
  return '';
}

function firstPrunaAssetUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return prunaAbsoluteUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPrunaAssetUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'get', 'file_url', 'fileUrl', 'download_url', 'downloadUrl', 'content', 'href']) {
    const found = firstPrunaAssetUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['urls', 'file', 'asset', 'data', 'result']) {
    const found = firstPrunaAssetUrl(value[key], depth + 1);
    if (found) return found;
  }
  const id = value.id || value.file_id || value.fileId;
  if (id) {
    const direct = prunaAbsoluteUrl(String(id));
    if (direct) return direct;
    return prunaApiUrl(`/files/${encodeURIComponent(String(id).trim())}`);
  }
  return Object.values(value).map((item) => firstPrunaAssetUrl(item, depth + 1)).find(Boolean) || '';
}

function firstPrunaImageUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return prunaGeneratedImageUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPrunaImageUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['generation_url', 'generationUrl', 'output_url', 'outputUrl', 'image_url', 'imageUrl', 'url']) {
    const found = firstPrunaImageUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['images', 'image', 'output', 'outputs', 'result', 'results', 'data']) {
    const found = firstPrunaImageUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(input|person|person_image|garment|garment_images|glass|urls?|status_url|cancel_url|response_url)$/i.test(key)) continue;
    const found = firstPrunaImageUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function prunaGeneratedVideoUrl(value = '') {
  const url = prunaAbsoluteUrl(value);
  if (!url) return '';
  if (/^data:video\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (/\/predictions\/(?:status|cancel)\//i.test(parsed.pathname)) return '';
    if (/\/predictions\/delivery\//i.test(parsed.pathname)) return url;
    if (/\.(?:mp4|mov|webm|m4v)(?:$|\?)/i.test(parsed.pathname + parsed.search)) return url;
    if (/^https?:$/i.test(parsed.protocol) && /(?:video|generation|output|delivery)/i.test(parsed.pathname + parsed.search)) return url;
  } catch {
    return '';
  }
  return '';
}

function firstPrunaVideoUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return prunaGeneratedVideoUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPrunaVideoUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['generation_url', 'generationUrl', 'output_url', 'outputUrl', 'video_url', 'videoUrl', 'url']) {
    const found = firstPrunaVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['videos', 'video', 'output', 'outputs', 'result', 'results', 'data', 'urls']) {
    const found = firstPrunaVideoUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(input|image|image_url|person|person_image|garment|garment_images|glass|status_url|cancel_url|response_url)$/i.test(key)) continue;
    const found = firstPrunaVideoUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function prunaPredictionId(value = {}) {
  return String(value.id || value.prediction_id || value.predictionId || value.request_id || value.requestId || '').trim();
}

function prunaPredictionStatus(value = {}) {
  return String(value.status || value.state || value.prediction_status || '').trim().toLowerCase();
}

function isPrunaSucceeded(value = {}) {
  const status = prunaPredictionStatus(value);
  return ['succeeded', 'success', 'completed', 'complete', 'done'].includes(status) || Boolean(firstPrunaImageUrl(value) || firstPrunaVideoUrl(value));
}

function isPrunaFailed(value = {}) {
  const status = prunaPredictionStatus(value);
  return ['failed', 'error', 'canceled', 'cancelled'].includes(status) || Boolean(value.error);
}

async function uploadPrunaFile(file, label, timer) {
  const form = new FormData();
  appendFilePart(form, 'content', file);
  timer?.mark(`pruna ${label} upload start`, { kb: Math.round(file.bytes.length / 1024), mimetype: file.mimetype });
  const response = await fetchWithTimeout(prunaApiUrl('/files'), {
    method: 'POST',
    headers: prunaHeaders(),
    body: form
  }, prunaUploadTimeoutMs(), `Pruna ${label} upload`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.detail || data.message || data, `Could not upload ${label} image to Pruna`));
  const fileUrl = firstPrunaAssetUrl(data);
  if (!fileUrl) throw new Error(`Pruna uploaded ${label} image but did not return a file URL`);
  timer?.mark(`pruna ${label} uploaded`);
  return fileUrl;
}

async function prunaPredictionStatusRequest(predictionId) {
  const response = await fetchWithTimeout(prunaApiUrl(`/predictions/status/${encodeURIComponent(predictionId)}`), {
    headers: prunaHeaders()
  }, prunaStatusTimeoutMs(), 'Pruna status request');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.detail || data.message || data, 'Pruna prediction status request failed'));
  return data;
}

async function waitForPrunaPrediction(initial, timer) {
  if (isPrunaSucceeded(initial)) return initial;
  if (isPrunaFailed(initial)) throw new Error(readableError(initial.error || initial, 'Pruna try-on generation failed'));
  const predictionId = prunaPredictionId(initial);
  if (!predictionId) throw new Error('Pruna did not return a prediction id or generated image');

  const configuredAttempts = envPositiveNumber(['PRUNA_POLL_ATTEMPTS', 'PRUNA_IMAGE_POLL_ATTEMPTS'], 45);
  const configuredPollMs = envPositiveNumber(['PRUNA_POLL_MS', 'PRUNA_IMAGE_POLL_MS'], 1000);
  const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? Math.round(configuredAttempts) : 45;
  const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? Math.max(250, configuredPollMs) : 1000;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const status = await prunaPredictionStatusRequest(predictionId);
    if (attempt === 0 || attempt % 5 === 0 || isPrunaSucceeded(status)) {
      timer?.mark('pruna status poll', { attempt, status: prunaPredictionStatus(status) });
    }
    if (isPrunaSucceeded(status)) return status;
    if (isPrunaFailed(status)) throw new Error(readableError(status.error || status, 'Pruna try-on generation failed'));
  }
  throw new Error(`Pruna try-on generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
}

async function callPrunaPrediction({ model, input, timer, label = 'pruna' }) {
  const modelName = String(model || prunaTryOnModel()).replace(/^pruna\//, '');
  const headers = prunaHeaders({
    'Content-Type': 'application/json',
    Model: modelName
  });
  if (prunaTrySync()) headers['Try-Sync'] = 'true';
  timer?.mark(`${label} prediction submit`, { model: modelName, sync: prunaTrySync(), fields: Object.keys(input || {}) });
  const response = await fetchWithTimeout(prunaApiUrl('/predictions'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ input })
  }, prunaSubmitTimeoutMs(), 'Pruna prediction submit');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.detail || data.message || data, 'Pruna try-on request failed'));
  timer?.mark(`${label} prediction submitted`, { status: prunaPredictionStatus(data) || 'submitted', predictionId: prunaPredictionId(data) });
  return waitForPrunaPrediction(data, timer);
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
    model: 'fitroom/tryon-v2',
    quality: fitRoomHdMode() ? 'hd' : 'standard'
  };
}

function tryOnText(product = {}) {
  return [
    product.name,
    product.productName,
    product.brand,
    product.category,
    product.gender,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ').toLowerCase();
}

function tryOnIntentForProduct(product = {}, options = {}) {
  const text = tryOnText(product);
  const category = String(product.category || '').toLowerCase();
  const source = `${category} ${text}`;

  if (/\b(wallets?|card\s*holders?|key\s*chains?|keychains?|umbrellas?|phone\s*cases?)\b/i.test(source)) {
    return {
      key: 'unsupported',
      label: 'handheld accessory',
      unsupportedMessage: 'This accessory is not supported for AI try-on yet. Try clothing, shoes, bags, watches, eyewear, or wearable jewelry.'
    };
  }
  if (/\b(sunglasses?|sun\s*glasses|eye\s*glasses|eyeglasses|spectacles?|optical\s*frames?|goggles?|eyewear)\b/i.test(source)) {
    return { key: 'eyewear', label: 'glasses', action: 'place only the glasses or sunglasses on the face' };
  }
  if (/\b(watches?|smart\s*watches?|smartwatches?|bracelets?|wristwear|chronograph)\b/i.test(source)) {
    return { key: 'wristwear-single', label: 'watch or bracelet', action: 'apply one watch or bracelet to the visible wrist only' };
  }
  if (/\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?|socks?)\b/i.test(source)) {
    return { key: 'feet', label: 'footwear', action: 'replace only the footwear' };
  }
  if (/\b(handbags?|bags?|backpacks?|totes?|sling\s*bags?|crossbody|duffels?|clutches?|purses?)\b/i.test(source)) {
    return { key: 'bags', label: 'bag', action: 'place only the bag naturally on or near the person' };
  }
  if (/\b(caps?|hats?|beanies?|headwear|face\s*masks?)\b/i.test(source)) {
    return { key: 'headwear', label: 'headwear', action: 'apply only the headwear' };
  }
  if (/\b(scarves?|ties?|necklaces?|chokers?|neckwear)\b/i.test(source)) {
    return { key: 'neckwear', label: 'neckwear', action: 'apply only the neckwear accessory' };
  }
  if (/\b(rings?|earrings?|jewellery|jewelry)\b/i.test(source)) {
    return { key: 'jewelry-single', label: 'jewelry', action: 'apply only the visible single jewelry item' };
  }
  if (/\b(accessories|accessory)\b/i.test(source)) {
    return { key: 'accessory', label: 'accessory', action: 'apply only the wearable accessory' };
  }
  if (/\b(dresses?|gowns?|frocks?|jumpsuits?|rompers?|robes?|bodycon|maxi|midi|mini\s*dress|one\s*piece)\b/i.test(source)) {
    return { key: 'dresses', label: 'dress or one-piece garment', action: 'replace only the one-piece dress or jumpsuit' };
  }
  if (/\b(pants?|trousers?|jeans?|denims?|joggers?|trackpants?|leggings?|chinos?|shorts?|skirts?|skorts?|bottomwear|belt)\b/i.test(source)) {
    return { key: 'bottoms', label: 'bottoms', action: 'replace only the bottoms' };
  }
  if (/\b(coats?|jackets?|parkas?|fleeces?|outerwear)\b/i.test(source)) {
    return { key: 'outerwear', label: 'outerwear', action: 'replace only the outerwear layer' };
  }
  if (/\b(hoodies?|sweatshirts?|sweaters?|cardigans?|pullovers?|jumpers?|blazers?|vests?|waistcoats?|top\s*layers?)\b/i.test(source)) {
    return { key: 'top-layers', label: 'top layer', action: 'replace only the top layer' };
  }
  if (/\b(shirts?|t\s*-?\s*shirts?|tshirts?|tees?|polo\s*shirts?|tops?|blouses?|tunics?|crop\s*tops?|tank\s*tops?|kurtas?|kurtis?)\b/i.test(source)) {
    return { key: 'tops', label: 'shirt or top', action: 'replace only the shirt or top' };
  }
  if (/\b(underwear|innerwear|lingerie|bras?|bralettes?|swimwear|bikinis?|swimsuits?|nightwear|sleepwear|pajamas?|pyjamas?)\b/i.test(source)) {
    return { key: 'underwear', label: 'fitted garment', action: 'replace only the fitted garment' };
  }
  return {
    key: options.custom ? 'custom-garment' : 'garment',
    label: options.custom ? 'uploaded garment' : 'wearable item',
    action: 'use only the primary wearable item from the garment image'
  };
}

function prunaTurboForIntent(intent) {
  if (intent?.key === 'wristwear-single') return false;
  const configured = process.env.PRUNA_TRYON_TURBO;
  if (configured === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(String(configured).toLowerCase());
}

function prunaTryOnPrompt(product = {}, intent = tryOnIntentForProduct(product), options = {}) {
  const productName = String(product.name || product.productName || options.fallbackName || intent.label || 'the selected item').replace(/\s+/g, ' ').trim().slice(0, 180);
  const brand = String(product.brand || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const identityRule = 'Preserve the person, face, hair, skin tone, pose, body shape, hands, background, lighting, and all non-target clothing exactly.';
  const targetRule = `${intent.action} from garment image 1${productName ? ` (${productName}${brand ? ` by ${brand}` : ''})` : ''}.`;
  const accessoryRule = intent.key === 'wristwear-single'
    ? 'Do not add stacked bracelets, extra watches, changed sleeves, altered hands, or new jewelry.'
    : intent.key === 'feet'
      ? 'Do not change pants, legs, socks, background, or body shape; only update the shoes or footwear.'
      : intent.key === 'bags'
        ? 'Do not change clothing, hands, face, hair, or body; keep the bag as the only added accessory.'
        : intent.key === 'accessory'
          ? 'Do not change clothing, face, hair, body shape, shoes, background, or unrelated accessories.'
          : 'Do not alter unrelated garments, accessories, face, hair, hands, shoes, body, or background.';
  return [
    targetRule,
    identityRule,
    accessoryRule,
    'Keep the product color, fabric, texture, silhouette, pattern, logos, seams, and details faithful to the reference.',
    'Generate one realistic retail virtual try-on image.'
  ].join(' ');
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
    const headers = {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy generated image fetcher'
    };
    try {
      if (new URL(url).origin === new URL(prunaBaseUrl()).origin) {
        Object.assign(headers, prunaHeaders());
      }
    } catch {
      // Non-URL data has already been handled above.
    }
    const response = await fetchWithTimeout(url, {
      headers
    }, prunaDownloadTimeoutMs(), 'Generated image download');
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        bytes,
        mimetype: imageMimeTypeFromResponse(response, bytes)
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

  const downloadHeaders = {
    accept: 'video/mp4,video/quicktime,video/*,*/*;q=0.8',
    'user-agent': 'Mozilla/5.0 Lookmefy generated video fetcher'
  };
  try {
    const requestedUrl = new URL(url);
    const prunaUrl = new URL(prunaBaseUrl());
    if (requestedUrl.origin === prunaUrl.origin) Object.assign(downloadHeaders, prunaHeaders());
  } catch {
    // Let fetch surface malformed URL errors below.
  }
  const response = await fetchWithTimeout(url, {
    headers: downloadHeaders
  }, prunaDownloadTimeoutMs(), 'Generated try-on video download');
  if (!response.ok) {
    throw new Error(`Could not download generated try-on video from ${shortUrlForLog(url)} (${response.status})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimetype: videoMimeTypeFromResponse(response, bytes)
  };
}

async function videoFirstFrameFile(image, label, timer) {
  if (!image?.path && !image?.sourceUrl) throw new Error(`${label} image is missing`);
  const stored = image.sourceUrl
    ? await generatedBytesFromUrl(image.sourceUrl, timer)
    : await readStoredFile(image);
  const normalized = await normalizeAvifImage({
    bytes: stored.bytes,
    mimetype: stored.mimetype || image.mimetype || 'image/jpeg',
    filename: image.filename,
    label,
    timer
  });
  const maxWidth = Number(process.env.VIDEO_FRAME_MAX_WIDTH || process.env.FAL_VIDEO_FRAME_MAX_WIDTH || 1024);
  const maxHeight = Number(process.env.VIDEO_FRAME_MAX_HEIGHT || process.env.FAL_VIDEO_FRAME_MAX_HEIGHT || 1536);
  const output = await sharp(normalized.bytes)
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 92 })
    .toBuffer();
  const metadata = await sharp(output).metadata();
  timer?.mark(`${label} video first frame prepared`, {
    inputKb: Math.round(normalized.bytes.length / 1024),
    outputKb: Math.round(output.length / 1024),
    width: metadata.width,
    height: metadata.height
  });
  return {
    bytes: output,
    mimetype: 'image/jpeg',
    filename: 'tryon-video-frame.jpg'
  };
}

function modelGenderForVideo(user, product) {
  const preference = String(user?.genderPreference || '').toLowerCase();
  const productGender = String(product?.gender || '').toLowerCase();
  if (preference === 'male' || /\b(men|man|male|boys?)\b/.test(productGender)) return 'male';
  if (preference === 'female' || /\b(women|woman|female|girls?)\b/.test(productGender)) return 'female';
  return 'neutral';
}

function tryOnVideoPrompt(product, user) {
  const gender = modelGenderForVideo(user, product);
  const expression = gender === 'male'
    ? 'calm masculine expression'
    : gender === 'female'
      ? 'calm elegant expression'
      : 'calm natural expression';
  return [
    'Animate the exact input photograph with minimal visual change.',

    'Maintain the original image exposure, brightness, white balance, background brightness, garment colors, skin tone, and overall illumination throughout the entire video.',

    'The person remains the exact same person with the same face, hairstyle, body proportions, outfit, fabric appearance, and skin tone.',

    `Maintain a ${expression}.`,

    'The person performs one slow, smooth in-place rotation while keeping both feet near the same floor position.',

    'Use natural subtle body movement only. Arms remain relaxed.',

    'Camera remains completely stationary with the original wide framing.',

    'Keep the entire person visible from the top of the hair to below both feet throughout the video.',

    'Maintain the existing light ecommerce background continuously without regenerating, replacing, stylizing, or relighting it.',

    'Keep the visual appearance consistent with the original input photo throughout the animation.',

    'No scene transition or stylistic transformation.'
  ].join(' ');
}

function safeProviderResultForLog(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return redactLargeData(value).slice(0, 240);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => safeProviderResultForLog(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, child] of Object.entries(value)) {
    if (/url/i.test(key) && typeof child === 'string') {
      safe[key] = child.slice(0, 96);
    } else {
      safe[key] = safeProviderResultForLog(child, depth + 1);
    }
  }
  return safe;
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

async function callPrunaTryOnVideo({ tryOn, product, user, timer }) {
  const frameFile = await videoFirstFrameFile(tryOn.image, 'try-on image', timer);
  const imageUrl = await uploadPrunaFile(frameFile, 'try-on video frame', timer);
  const prompt = tryOnVideoPrompt(product, user);
  const input = {
    image: imageUrl,
    prompt,
    duration: prunaVideoDuration(),
    resolution: prunaVideoResolution(),
    fps: prunaVideoFps(),
    draft: prunaVideoDraft()
  };
  const aspectRatio = prunaVideoAspectRatio();
  if (aspectRatio) input.aspect_ratio = aspectRatio;

  const model = prunaVideoModel();
  timer?.mark('pruna video submit start', {
    model,
    resolution: input.resolution,
    duration: input.duration,
    fps: input.fps
  });
  const result = await callPrunaPrediction({
    model,
    input,
    timer,
    label: 'pruna p-video'
  });
  const generatedUrl = firstPrunaVideoUrl(result);
  if (!generatedUrl) {
    timer?.mark('pruna video returned no video', { result: safeProviderResultForLog(result) });
    throw new Error(`Pruna returned no video. Response keys: ${Object.keys(result || {}).join(', ')}`);
  }
  const { bytes, mimetype } = await generatedVideoBytesFromUrl(generatedUrl, timer);
  timer?.mark('pruna video downloaded', { outputKb: Math.round(bytes.length / 1024), mimetype });
  return {
    bytes,
    mimetype,
    prompt,
    model: `pruna/${model}`,
    quality: `${input.resolution} ${input.duration}s ${input.fps}fps`
  };
}

async function callPrunaGlassesTryOn({ user, product, garmentFile, timer, intent }) {
  const [personFile, glassFile] = await Promise.all([
    filePartFromUpload(user.bodyPhoto, 'person', timer),
    garmentFile ? filePartFromMemoryFile(garmentFile, 'garment', timer) : filePartFromProduct(product, timer)
  ]);
  const [person, glass] = await Promise.all([
    uploadPrunaFile(personFile, 'person', timer),
    uploadPrunaFile(glassFile, 'glasses', timer)
  ]);
  const result = await callPrunaPrediction({
    model: prunaGlassesModel(),
    input: {
      person,
      glass,
      disable_safety_checker: ['1', 'true', 'yes', 'on'].includes(String(process.env.PRUNA_DISABLE_SAFETY_CHECKER || '').toLowerCase())
    },
    timer,
    label: 'pruna glasses try-on'
  });
  const generatedUrl = firstPrunaImageUrl(result);
  if (!generatedUrl) {
    timer?.mark('pruna glasses returned no image', { keys: Object.keys(result || {}) });
    throw new Error(`Pruna glasses try-on returned no image. Response keys: ${Object.keys(result || {}).join(', ')}`);
  }
  timer?.mark('pruna glasses image ready', { url: shortUrlForLog(generatedUrl) });
  return {
    remoteUrl: generatedUrl,
    mimetype: prunaOutputMimetype(),
    prompt: prunaTryOnPrompt(product, intent),
    provider: 'pruna',
    model: prunaGlassesModel(),
    quality: 'glasses'
  };
}

async function callPrunaTryOn({ user, product = {}, garmentFile, timer, custom = false }) {
  const intent = tryOnIntentForProduct(product, { custom });
  if (intent.key === 'unsupported') throw new Error(intent.unsupportedMessage);
  if (intent.key === 'eyewear') return callPrunaGlassesTryOn({ user, product, garmentFile, timer, intent });

  const [personFile, garment] = await Promise.all([
    filePartFromUpload(user.bodyPhoto, 'person', timer),
    garmentFile ? filePartFromMemoryFile(garmentFile, 'garment', timer) : filePartFromProduct(product, timer)
  ]);
  const [personImage, garmentImage] = await Promise.all([
    uploadPrunaFile(personFile, 'person', timer),
    uploadPrunaFile(garment, 'garment', timer)
  ]);
  const prompt = prunaTryOnPrompt(product, intent, { custom, fallbackName: garmentFile?.originalname || '' });
  const turbo = prunaTurboForIntent(intent);
  const input = {
    person_image: personImage,
    garment_images: [garmentImage],
    prompt,
    turbo,
    preserve_input_size: prunaPreserveInputSize(),
    output_format: prunaOutputFormat(),
    output_quality: prunaOutputQuality()
  };
  const result = await callPrunaPrediction({
    model: prunaTryOnModel(),
    input,
    timer,
    label: `pruna ${turbo ? 'turbo' : 'standard'} try-on`
  });
  const generatedUrl = firstPrunaImageUrl(result);
  if (!generatedUrl) {
    timer?.mark('pruna returned no image', { keys: Object.keys(result || {}) });
    throw new Error(`Pruna try-on returned no image. Response keys: ${Object.keys(result || {}).join(', ')}`);
  }
  timer?.mark('pruna generated image ready', { intent: intent.key, turbo, url: shortUrlForLog(generatedUrl) });
  return {
    remoteUrl: generatedUrl,
    mimetype: prunaOutputMimetype(),
    prompt,
    provider: 'pruna',
    model: prunaTryOnModel(),
    quality: turbo ? 'turbo' : 'standard'
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
  timer?.mark('fal wan response summary', {
    images: Array.isArray(result?.images) ? result.images.length : undefined,
    output: Array.isArray(result?.output) ? result.output.length : undefined,
    data: Array.isArray(result?.data) ? result.data.length : undefined,
    keys: Object.keys(result || {}).slice(0, 20)
  });
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

async function callFalImageEdit({ user, product, garmentDataUri, prompt, timer }) {
  const [person, garment] = await Promise.all([
    dataUriFromUpload(user.bodyPhoto, 'person', timer),
    garmentDataUri ? Promise.resolve(garmentDataUri) : dataUriFromProduct(product, timer)
  ]);
  timer?.mark('reference images prepared', {
    personKb: Math.round(person.length / 1024),
    garmentKb: Math.round(garment.length / 1024)
  });
  const finalPrompt = prompt || tryOnPrompt(product);
  const endpoint = imageModel();
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({
      prompt: finalPrompt,
      image_urls: [person, garment],
      image_size: imageSize(),
      quality: imageQuality(),
      num_images: 1,
      output_format: 'png'
    })
  });
  timer?.mark('fal submitted', { requestId: submission.request_id });
  const result = await waitForFalResult(submission, timer);
  timer?.mark('fal result fetched');
  const generated = result.images?.[0];
  if (!generated?.url) throw new Error('FAL did not return an image');
  const imageResponse = await fetch(generated.url);
  if (!imageResponse.ok) throw new Error('Could not download generated try-on image');
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  const mimetype = imageMimeTypeFromResponse(imageResponse, bytes);
  timer?.mark('generated image downloaded', { outputKb: Math.round(bytes.length / 1024) });
  return {
    bytes,
    mimetype,
    prompt: finalPrompt,
    model: endpoint,
    quality: imageQuality()
  };
}

async function saveUserCacheFile({ user, bytes, filename, mimetype }) {
  return saveStoredFile({
    buffer: bytes,
    filename,
    mimetype,
    userId: user._id.toString(),
    folder: 'tryons',
    prefix: 'tryon'
  });
}

function tryOnImageProxyPath(scope, id) {
  return `/api/tryons/image/${encodeURIComponent(scope)}/${encodeURIComponent(String(id))}`;
}

function documentId(value) {
  if (!value) return '';
  if (value._id) return value._id.toString();
  return value.toString();
}

function storedOrRemoteImageUrl(image) {
  return storedFileToClientUrl(image) || image?.remoteUrl || image?.sourceUrl || image?.url || '';
}

function generatedTryOnImageUrl(tryOn, scope = 'product') {
  const image = tryOn?.image;
  if (image?.storage === 'remote-pending' && !image?.sourceUrl) return '';
  if (!image?.path && !image?.url && !image?.sourceUrl) return '';
  return tryOnMediaUrl({ kind: 'image', scope, id: documentId(tryOn), userId: documentId(tryOn?.user) });
}

function historyDate(record) {
  return record?.updatedAt || record?.createdAt || new Date();
}

function productHistoryItem(tryOn) {
  const product = tryOn.product && typeof tryOn.product === 'object' ? tryOn.product : null;
  const productId = documentId(product || tryOn.product);
  const productImageUrl = storedOrRemoteImageUrl(product?.image);
  const productName = String(product?.name || 'Product try-on').trim();
  const productBrand = String(product?.brand || '').trim();
  return {
    id: `product-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'product',
    label: tryOn.video?.url || tryOn.video?.path ? 'Video Try-On' : 'AI Try-On',
    title: productName,
    subtitle: productBrand || 'Catalog product',
    imageUrl: generatedTryOnImageUrl(tryOn, 'product'),
    videoUrl: storedFileToClientUrl(tryOn.video) ? tryOnMediaUrl({ kind: 'video', scope: 'product', id: documentId(tryOn), userId: documentId(tryOn?.user) }) : '',
    sourceImageUrl: productImageUrl,
    productId,
    product: product ? {
      id: productId,
      name: productName,
      brand: productBrand,
      category: product.category,
      imageUrl: productImageUrl,
      affiliateLink: product.affiliateLink,
      sourceUrl: product.sourceUrl
    } : null,
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
}

function customHistoryItem(tryOn) {
  return {
    id: `custom-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'custom',
    label: 'Custom Try-On',
    title: tryOn.garment?.filename || 'Uploaded garment',
    subtitle: 'Custom upload',
    imageUrl: generatedTryOnImageUrl(tryOn, 'custom'),
    sourceImageUrl: storedFileToClientUrl(tryOn.garment) ? tryOnMediaUrl({ kind: 'garment', scope: 'custom', id: documentId(tryOn), userId: documentId(tryOn?.user) }) : '',
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
}

function externalHistoryItem(tryOn) {
  const productName = String(tryOn.productName || 'External product').trim();
  return {
    id: `external-${documentId(tryOn)}`,
    tryOnId: documentId(tryOn),
    type: 'external',
    label: 'AI Try-On',
    title: productName,
    subtitle: tryOn.brand || 'External product',
    imageUrl: generatedTryOnImageUrl(tryOn, 'external'),
    sourceImageUrl: tryOn.imageUrl || '',
    sourceUrl: tryOn.sourceUrl,
    affiliateLink: tryOn.affiliateLink,
    provider: tryOn.provider,
    model: tryOn.model,
    tokenCost: tryOn.tokenCost,
    createdAt: historyDate(tryOn)
  };
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

function sendVideoBytes(req, res, { bytes, mimetype }) {
  const size = bytes.length;
  const contentType = mimetype?.startsWith('video/') ? mimetype : 'video/mp4';
  res.set({
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=300'
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

function canUseRemoteFirstImage(generated = {}) {
  return /^https?:\/\//i.test(String(generated.remoteUrl || ''));
}

function pendingRemoteImage({ scope, id, filename, sourceUrl, mimetype }) {
  return {
    filename,
    path: tryOnImageProxyPath(scope, id),
    sourceUrl,
    storage: 'remote-pending',
    mimetype: mimetype || 'image/jpeg',
    size: 0
  };
}

async function generatedImageForResponse({ user, generated, filename, scope, id, timer }) {
  if (canUseRemoteFirstImage(generated)) {
    const image = pendingRemoteImage({
      scope,
      id,
      filename,
      sourceUrl: generated.remoteUrl,
      mimetype: generated.mimetype
    });
    timer?.mark('generated image queued for background storage', { scope, imageUrl: image.path });
    persistGeneratedImageInBackground({
      scope,
      id,
      userId: user._id.toString(),
      sourceUrl: generated.remoteUrl,
      filename,
      mimetype: generated.mimetype
    });
    return image;
  }

  let bytes = generated.bytes;
  let mimetype = generated.mimetype;
  if (!bytes && generated.remoteUrl) {
    const downloaded = await generatedBytesFromUrl(generated.remoteUrl, timer);
    bytes = downloaded.bytes;
    mimetype = downloaded.mimetype || mimetype;
  }
  return saveUserCacheFile({ user, bytes, filename, mimetype });
}

function persistGeneratedImageInBackground({ scope, id, userId, sourceUrl, filename, mimetype }) {
  setImmediate(() => {
    persistGeneratedImage({ scope, id, userId, sourceUrl, filename, mimetype })
      .catch((error) => logger.error('tryon_background_image_persist_failed', {
        scope,
        id: String(id),
        error
      }));
  });
}

async function persistGeneratedImage({ scope, id, userId, sourceUrl, filename, mimetype }) {
  const Model = generatedImageModelForScope(scope);
  if (!Model) throw new Error(`Unknown try-on image scope: ${scope}`);
  const pendingPath = tryOnImageProxyPath(scope, id);
  const { bytes, mimetype: downloadedMimetype } = await generatedBytesFromUrl(sourceUrl);
  const image = await saveStoredFile({
    buffer: bytes,
    filename,
    mimetype: downloadedMimetype || mimetype || 'image/jpeg',
    userId,
    folder: 'tryons',
    prefix: 'tryon'
  });
  let updated = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    updated = await Model.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { 'image.sourceUrl': sourceUrl },
          { 'image.storage': 'remote-pending', 'image.path': pendingPath }
        ]
      },
      { $set: { image } }
    );
    if (updated) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!updated) {
    logger.warn('tryon_background_image_persist_update_missed', {
      scope,
      id: String(id)
    });
  }
  logger.info('tryon_background_image_persisted', {
    scope,
    id: String(id),
    storage: image.storage,
    size: image.size
  });
}

async function generateProductTryOnImage({ user, product, tryOnModel, timer }) {
  const selectedModel = tryOnModel || tryOnModelForProduct(product);
  timer?.mark('image generator selected', { tryOnModel: selectedModel });
  if (selectedModel === 'pruna/p-image-try-on' || selectedModel === 'pruna/p-try-on-glasses' || selectedModel === prunaTryOnModel() || selectedModel === prunaGlassesModel()) {
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
  const tryOn = new TryOn({
    user: user._id,
    product: product._id,
    provider: generated.provider || (generated.model?.includes('fitroom') ? 'fitroom' : 'fal'),
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    tokenCost: chargedTokenCost(user)
  });
  tryOn.image = await generatedImageForResponse({
    user,
    generated,
    filename,
    scope: 'product',
    id: tryOn._id,
    timer
  });
  timer?.mark('generated image record ready', { path: tryOn.image.path, storage: tryOn.image.storage });
  return tryOn.save();
}

async function replaceGeneratedTryOn({ user, product, tryOnModel, timer }) {
  const generated = await generateProductTryOnImage({ user, product, tryOnModel, timer });
  const filename = `tryon-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const tryOn = await TryOn.findOne({ user: user._id, product: product._id }) || new TryOn({
    user: user._id,
    product: product._id
  });
  tryOn.provider = generated.provider || (generated.model?.includes('fitroom') ? 'fitroom' : 'fal');
  tryOn.model = generated.model;
  tryOn.quality = generated.quality;
  tryOn.prompt = generated.prompt;
  tryOn.tokenCost = chargedTokenCost(user);
  tryOn.image = await generatedImageForResponse({
    user,
    generated,
    filename,
    scope: 'product',
    id: tryOn._id,
    timer
  });
  tryOn.video = undefined;
  timer?.mark('generated image replacement ready', { path: tryOn.image.path, storage: tryOn.image.storage });
  return tryOn.save();
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

async function saveGeneratedExternalTryOn({ user, product, timer }) {
  const generated = await callPrunaTryOn({ user, product, timer });
  const filename = `tryon-external-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const tryOn = new ExternalTryOn({
    user: user._id,
    sourceUrl: product.sourceUrl,
    affiliateLink: product.affiliateLink,
    productName: product.name,
    brand: product.brand,
    category: product.category,
    imageUrl: product.imageUrl,
    provider: generated.provider || 'pruna',
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    tokenCost: chargedTokenCost(user)
  });
  tryOn.image = await generatedImageForResponse({
    user,
    generated,
    filename,
    scope: 'external',
    id: tryOn._id,
    timer
  });
  timer?.mark('external try-on record ready', { path: tryOn.image.path, storage: tryOn.image.storage });
  return tryOn.save();
}

async function replaceGeneratedExternalTryOn({ user, product, timer }) {
  const generated = await callPrunaTryOn({ user, product, timer });
  const filename = `tryon-external-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const tryOn = await ExternalTryOn.findOne({ user: user._id, sourceUrl: product.sourceUrl }) || new ExternalTryOn({
    user: user._id,
    sourceUrl: product.sourceUrl
  });
  tryOn.affiliateLink = product.affiliateLink;
  tryOn.productName = product.name;
  tryOn.brand = product.brand;
  tryOn.category = product.category;
  tryOn.imageUrl = product.imageUrl;
  tryOn.provider = generated.provider || 'pruna';
  tryOn.model = generated.model;
  tryOn.quality = generated.quality;
  tryOn.prompt = generated.prompt;
  tryOn.tokenCost = chargedTokenCost(user);
  tryOn.image = await generatedImageForResponse({
    user,
    generated,
    filename,
    scope: 'external',
    id: tryOn._id,
    timer
  });
  timer?.mark('external try-on replacement ready', { path: tryOn.image.path, storage: tryOn.image.storage });
  return tryOn.save();
}

async function normalizeMemoryImageFile(file, label, timer) {
  if (!file?.buffer) return file;
  const normalized = await normalizeAvifImage({
    bytes: file.buffer,
    mimetype: file.mimetype || 'image/jpeg',
    filename: file.originalname,
    label,
    timer
  });
  if (normalized.bytes === file.buffer && normalized.mimetype === file.mimetype) return file;
  return {
    ...file,
    buffer: normalized.bytes,
    mimetype: normalized.mimetype,
    originalname: normalized.filename || file.originalname,
    size: normalized.bytes.length
  };
}

async function saveUploadFile(file, prefix, user) {
  const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(file.mimetype)}`;
  return saveStoredFile({
    buffer: file.buffer,
    filename,
    mimetype: file.mimetype,
    userId: user?._id?.toString?.(),
    folder: 'garments',
    prefix
  });
}

async function storedGarmentToMemoryFile(garment, timer) {
  const stored = await readStoredFile(garment);
  const buffer = stored.bytes;
  const mimetype = stored.mimetype || garment?.mimetype || 'image/jpeg';
  timer?.mark('stored garment prepared', { kb: Math.round(buffer.length / 1024), mimetype });
  return {
    buffer,
    mimetype,
    originalname: stored.filename || garment?.filename || `garment${extensionFor(mimetype)}`,
    size: buffer.length
  };
}

async function saveGeneratedCustomTryOn({ user, garmentFile, storedGarment, timer }) {
  const generated = await callPrunaTryOn({
    user,
    product: {
      name: garmentFile?.originalname || 'Uploaded garment',
      category: 'clothing'
    },
    garmentFile,
    timer,
    custom: true
  });
  const filename = `tryon-custom-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
  const garment = storedGarment || await saveUploadFile(garmentFile, 'garment', user);
  let bytes = generated.bytes;
  let mimetype = generated.mimetype;
  if (!bytes && generated.remoteUrl) {
    const downloaded = await generatedBytesFromUrl(generated.remoteUrl, timer);
    bytes = downloaded.bytes;
    mimetype = downloaded.mimetype || mimetype;
  }
  const tryOn = new CustomTryOn({
    user: user._id,
    provider: generated.provider || 'pruna',
    model: generated.model,
    quality: generated.quality,
    prompt: generated.prompt,
    tokenCost: chargedTokenCost(user),
    garment
  });
  tryOn.image = await saveUserCacheFile({ user, bytes, filename, mimetype });
  timer?.mark('custom try-on record ready', { path: tryOn.image.path, storage: tryOn.image.storage });
  return tryOn.save();
}

async function reserveToken(user, timer, cost = tokenCost()) {
  if (devMode(user)) {
    timer.mark('dev mode token bypass', { tokensRemaining: user.tokens, cost: 0 });
    return user;
  }
  const chargedUser = await User.findOneAndUpdate(
    { _id: user._id, tokens: { $gte: cost } },
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
  const refundedUser = await User.findByIdAndUpdate(user._id, { $inc: { tokens: cost } }, { new: true });
  if (refundedUser) timer.mark('token refunded', { cost, tokensRemaining: refundedUser.tokens });
  return refundedUser || user;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function tryOnErrorStatus(error) {
  return isStorageConfigurationError(error) ? error.statusCode || 503 : error.statusCode || 400;
}

async function customTryOnService({ userId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) throw httpError(401, 'User not found');

  const timer = createTimer('custom', { userId: user._id.toString() });
  const storedGarment = body?.garment;
  let reserved = false;
  let workingUser = user;
  let tryOn = null;

  try {
    if (!storedGarment?.path && !storedGarment?.url) throw httpError(400, 'Upload a clothing image first');
    ensureTryOnProfileReady(workingUser);
    const garmentFile = await storedGarmentToMemoryFile(storedGarment, timer);
    const chargedUser = await reserveToken(workingUser, timer);
    if (!chargedUser) throw httpError(402, 'Not enough tokens for AI try-on');
    reserved = true;
    workingUser = chargedUser;

    tryOn = await saveGeneratedCustomTryOn({
      user: workingUser,
      garmentFile,
      storedGarment,
      timer
    });
    await recordCreditEvent({
      user: workingUser,
      action: 'Custom try-on',
      product: { name: 'Custom upload' },
      tokens: chargedTokenCost(workingUser),
      balanceAfter: workingUser.tokens,
      metadata: { tryOnId: tryOn._id.toString() }
    });
    timer.end({ tokensRemaining: workingUser.tokens });
    return { statusCode: 201, body: { tryOn: tryOn.toClient(), user: workingUser.toClient() } };
  } catch (error) {
    if (reserved) workingUser = await refundToken(workingUser, timer);
    if (!tryOn && storedGarment) {
      await deleteStoredFile(storedGarment).catch((cleanupError) => {
        logger.warn('custom_tryon_garment_cleanup_failed', {
          userId: user._id.toString(),
          error: readableError(cleanupError)
        });
      });
    }
    const message = readableError(error, 'Could not generate custom AI try-on');
    timer.end({ error: message });
    throw httpError(tryOnErrorStatus(error), message);
  }
}

async function productTryOnService({ userId, productId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) throw httpError(401, 'User not found');

  const requestedModel = normalizeTryOnModel(body?.tryOnModel);
  const hasRequestedModel = Boolean(body?.tryOnModel);
  const forceGenerate = Boolean(body?.force || body?.refresh);
  const timer = createTimer('generate', {
    userId: user._id.toString(),
    productId,
    requestedModel: body?.tryOnModel || '',
    forceGenerate
  });
  let reserved = false;
  let workingUser = user;

  try {
    const product = await Product.findOne({ _id: productId, isActive: true });
    if (!product) throw httpError(404, 'Product not found');
    const existing = await TryOn.findOne({ user: workingUser._id, product: productId });
    const selectedModel = hasRequestedModel
      ? requestedModel
      : tryOnModelForProduct(product);
    timer.mark('product loaded', {
      tryOnModel: selectedModel,
      existingModel: existing?.model || ''
    });

    if (existing && !forceGenerate) {
      timer.end({ reused: true });
      return { statusCode: 200, body: { tryOn: existing.toClient(), user: workingUser.toClient(), reused: true } };
    }

    ensureTryOnProfileReady(workingUser);
    const chargedUser = await reserveToken(workingUser, timer);
    if (!chargedUser) throw httpError(402, 'Not enough tokens for AI try-on');
    reserved = true;
    workingUser = chargedUser;

    const tryOn = forceGenerate
      ? await replaceGeneratedTryOn({ user: workingUser, product, tryOnModel: selectedModel, timer })
      : await saveGeneratedTryOn({ user: workingUser, product, tryOnModel: selectedModel, timer });
    await recordCreditEvent({
      user: workingUser,
      action: forceGenerate ? 'Regenerated try-on' : 'AI try-on',
      product,
      tokens: chargedTokenCost(workingUser),
      balanceAfter: workingUser.tokens,
      metadata: { tryOnId: tryOn._id.toString(), model: selectedModel }
    });
    timer.end({ reused: false, tokensRemaining: workingUser.tokens });

    return { statusCode: 201, body: { tryOn: tryOn.toClient(), user: workingUser.toClient(), reused: false } };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await TryOn.findOne({ user: workingUser._id, product: productId });
      if (existing) {
        if (reserved) {
          workingUser = await refundToken(workingUser, timer);
          reserved = false;
        }
        timer.end({ reused: true, duplicate: true });
        return { statusCode: 200, body: { tryOn: existing.toClient(), user: workingUser.toClient(), reused: true } };
      }
    }
    if (reserved) workingUser = await refundToken(workingUser, timer);
    const message = readableError(error, 'Could not generate AI try-on');
    timer.end({ error: message });
    throw httpError(tryOnErrorStatus(error), message);
  }
}

async function externalTryOnService({ userId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) throw httpError(401, 'User not found');

  let product;
  try {
    product = externalProductFromBody(body?.product);
  } catch (error) {
    throw httpError(400, readableError(error, 'External product is missing'));
  }

  const compatibility = wearableCompatibility(product);
  if (!compatibility.compatible) throw httpError(400, compatibility.reason);
  const genderMatch = genderCompatibility(product, user.genderPreference);
  if (!genderMatch.compatible) throw httpError(400, genderMatch.reason);

  const forceGenerate = Boolean(body?.force || body?.refresh);
  const timer = createTimer('external', {
    userId: user._id.toString(),
    sourceUrl: product.sourceUrl,
    forceGenerate
  });
  let reserved = false;
  let workingUser = user;

  try {
    const existing = await ExternalTryOn.findOne({ user: workingUser._id, sourceUrl: product.sourceUrl });
    if (existing && !forceGenerate) {
      timer.end({ reused: true });
      return { statusCode: 200, body: { tryOn: existing.toClient(), user: workingUser.toClient(), reused: true } };
    }

    ensureTryOnProfileReady(workingUser);
    const chargedUser = await reserveToken(workingUser, timer);
    if (!chargedUser) throw httpError(402, 'Not enough tokens for AI try-on');
    reserved = true;
    workingUser = chargedUser;

    const tryOn = forceGenerate
      ? await replaceGeneratedExternalTryOn({ user: workingUser, product, timer })
      : await saveGeneratedExternalTryOn({ user: workingUser, product, timer });
    await recordCreditEvent({
      user: workingUser,
      action: forceGenerate ? 'Regenerated external try-on' : 'External try-on',
      product,
      tokens: chargedTokenCost(workingUser),
      balanceAfter: workingUser.tokens,
      metadata: { tryOnId: tryOn._id.toString(), sourceUrl: product.sourceUrl }
    });
    timer.end({ reused: false, tokensRemaining: workingUser.tokens });
    return { statusCode: 201, body: { tryOn: tryOn.toClient(), user: workingUser.toClient(), reused: false } };
  } catch (error) {
    if (error.code === 11000) {
      const existing = await ExternalTryOn.findOne({ user: workingUser._id, sourceUrl: product.sourceUrl });
      if (existing) {
        if (reserved) {
          workingUser = await refundToken(workingUser, timer);
          reserved = false;
        }
        timer.end({ reused: true, duplicate: true });
        return { statusCode: 200, body: { tryOn: existing.toClient(), user: workingUser.toClient(), reused: true } };
      }
    }
    if (reserved) workingUser = await refundToken(workingUser, timer);
    const message = readableError(error, 'Could not generate external AI try-on');
    timer.end({ error: message });
    throw httpError(tryOnErrorStatus(error), message);
  }
}

async function tryOnVideoService({ userId, productId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) throw httpError(401, 'User not found');

  const forceGenerate = Boolean(body?.force || body?.refresh);
  const timer = createTimer('video', {
    userId: user._id.toString(),
    productId,
    forceGenerate
  });
  const cost = videoTokenCost();
  let reserved = false;
  let workingUser = user;

  try {
    const [product, existing] = await Promise.all([
      Product.findOne({ _id: productId, isActive: true }),
      TryOn.findOne({ user: workingUser._id, product: productId })
    ]);
    if (!product) throw httpError(404, 'Product not found');
    if (!existing?.image?.path) throw httpError(400, 'Generate the AI clothing try-on image before creating a video.');
    if (existing.video?.path && !forceGenerate) {
      timer.end({ reused: true });
      return { statusCode: 200, body: { tryOn: existing.toClient(), user: workingUser.toClient(), reused: true } };
    }

    const chargedUser = await reserveToken(workingUser, timer, cost);
    if (!chargedUser) throw httpError(402, 'Not enough tokens for video try-on');
    reserved = true;
    workingUser = chargedUser;

    const generated = await callPrunaTryOnVideo({ tryOn: existing, product, user: workingUser, timer });
    const filename = `tryon-video-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(generated.mimetype)}`;
    const video = await saveUserCacheFile({ user: workingUser, bytes: generated.bytes, filename, mimetype: generated.mimetype });
    const updated = await TryOn.findOneAndUpdate(
      { user: workingUser._id, product: productId },
      {
        $set: {
          video: {
            ...video,
            model: generated.model,
            prompt: generated.prompt,
            tokenCost: chargedVideoTokenCost(workingUser),
            generatedAt: new Date()
          }
        }
      },
      { new: true }
    );
    await recordCreditEvent({
      user: workingUser,
      action: 'Video try-on',
      product,
      tokens: chargedVideoTokenCost(workingUser),
      balanceAfter: workingUser.tokens,
      metadata: { tryOnId: updated?._id?.toString?.() || existing._id.toString() }
    });
    timer.end({ reused: false, tokensRemaining: workingUser.tokens, path: video.path });
    return { statusCode: 201, body: { tryOn: updated.toClient(), user: workingUser.toClient(), reused: false } };
  } catch (error) {
    if (reserved) workingUser = await refundToken(workingUser, timer, cost);
    const message = readableVideoError(error, 'Could not generate video try-on');
    timer.end({ error: message });
    throw httpError(tryOnErrorStatus(error), message);
  }
}

router.get('/', requireUser, async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  const ids = String(req.query.productIds || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 96);
  const rawLimit = Number(req.query.limit);
  const limit = Math.min(96, Math.max(1, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 48));
  const filter = { user: req.user._id };
  if (ids.length) filter.product = { $in: ids };
  const tryOns = await TryOn.find(filter)
    .select('user product provider model quality tokenCost image video createdAt updatedAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ tryOns: tryOns.map(tryOnToClient) });
});

router.get('/history', requireUser, async (req, res) => {
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
      .select('user product provider model quality tokenCost image video createdAt updatedAt')
      .populate('product', 'name brand category image affiliateLink sourceUrl')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    CustomTryOn.find(userFilter)
      .select('user provider model quality tokenCost garment image createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    ExternalTryOn.find(userFilter)
      .select('user sourceUrl affiliateLink productName brand category imageUrl provider model quality tokenCost image createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(queryLimit)
      .lean(),
    TryOn.countDocuments(userFilter),
    CustomTryOn.countDocuments(userFilter),
    ExternalTryOn.countDocuments(userFilter)
  ]);

  const items = [
    ...productTryOns.map(productHistoryItem),
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

router.get('/credit-history', requireUser, async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const events = await CreditEvent.find({ user: req.user._id })
    .select('action product productTitle productImageUrl tokens balanceAfter metadata createdAt')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ events: events.map(creditEventToClient) });
});

router.get('/custom/latest', requireUser, async (req, res) => {
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
  const access = verifyMediaAccess(mediaTokenFromRequest(req), {
    scope,
    id: req.params.id,
    kind,
    field
  });
  if (!access) return null;
  const Model = kind === 'video' ? generatedVideoModelForScope(scope) : generatedImageModelForScope(scope);
  if (!Model) return null;
  const record = await Model.findById(req.params.id).select(`${field} user`).lean();
  if (!record || documentId(record.user) !== access.userId) return null;
  return record;
}

router.get('/image/:scope/:id', async (req, res) => {
  try {
    const scope = String(req.params.scope || '').toLowerCase();
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'image', field: 'image' });
    if (!record) return res.status(401).json({ message: 'Generated image link expired' });
    const image = record?.image;
    if (!image) return res.status(404).json({ message: 'Generated image not found' });

    if (image.sourceUrl) {
      const { bytes, mimetype } = await generatedBytesFromUrl(image.sourceUrl);
      res.set({
        'Content-Type': mimetype || image.mimetype || 'image/jpeg',
        'Cache-Control': 'private, max-age=300'
      });
      return res.send(bytes);
    }

    if (!image.path && !image.url) return res.status(404).json({ message: 'Generated image is not available yet' });
    const stored = await readStoredFile(image);
    res.set({
      'Content-Type': stored.mimetype || image.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.bytes);
  } catch (error) {
    logger.error('tryon_image_proxy_failed', {
      scope: req.params.scope,
      id: req.params.id,
      error
    });
    return res.status(502).json({ message: 'Generated image is temporarily unavailable' });
  }
});

router.get('/video/:scope/:id', async (req, res) => {
  try {
    const scope = String(req.params.scope || '').toLowerCase();
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'video', field: 'video' });
    if (!record) return res.status(401).json({ message: 'Generated video link expired' });
    const video = record?.video;
    if (!video?.path && !video?.url) return res.status(404).json({ message: 'Generated video not found' });

    const stored = await readStoredFile(video);
    return sendVideoBytes(req, res, {
      bytes: stored.bytes,
      mimetype: stored.mimetype || video.mimetype || 'video/mp4'
    });
  } catch (error) {
    logger.error('tryon_video_proxy_failed', {
      scope: req.params.scope,
      id: req.params.id,
      error
    });
    return res.status(502).json({ message: 'Generated video is temporarily unavailable' });
  }
});

router.get('/garment/:scope/:id', async (req, res) => {
  try {
    const scope = String(req.params.scope || '').toLowerCase();
    const record = await requireTryOnMediaAccess(req, { scope, kind: 'garment', field: 'garment' });
    if (!record) return res.status(401).json({ message: 'Garment media link expired' });
    const garment = record?.garment;
    if (!garment?.path && !garment?.url) return res.status(404).json({ message: 'Garment media not found' });
    const stored = await readStoredFile(garment);
    res.set({
      'Content-Type': stored.mimetype || garment.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.bytes);
  } catch (error) {
    logger.error('tryon_garment_proxy_failed', {
      scope: req.params.scope,
      id: req.params.id,
      error
    });
    return res.status(502).json({ message: 'Garment media is temporarily unavailable' });
  }
});

router.post('/custom', requireUser, upload.single('garment'), async (req, res) => {
  const timer = createTimer('custom-upload', { userId: req.user._id.toString() });
  let garment = null;
  let timerEnded = false;
  const endTimer = (extra = {}) => {
    if (timerEnded) return;
    timerEnded = true;
    timer.end(extra);
  };

  try {
    if (!req.file) return res.status(400).json({ message: 'Upload a clothing image first' });
    ensureTryOnProfileReady(req.user);
    const garmentFile = await normalizeMemoryImageFile(req.file, 'garment', timer);
    garment = await saveUploadFile(garmentFile, 'garment', req.user);
    endTimer({ queued: true, garment: garment.path || garment.url || '' });
    return await inlineOrQueue({
      req,
      res,
      type: 'tryon-custom',
      key: `${req.user._id}:custom:${garment.path || garment.url || Date.now()}`,
      payload: { body: { garment } },
      maxAttempts: 1,
      priority: 5,
      runInline: async () => customTryOnService({ userId: req.user._id, body: { garment } })
    });
  } catch (error) {
    if (garment) await deleteStoredFile(garment).catch(() => {});
    const message = readableError(error, 'Could not generate custom AI try-on');
    endTimer({ error: message });
    res.status(isStorageConfigurationError(error) ? error.statusCode || 503 : 400).json({ message });
  }
});

router.post('/external', requireUser, async (req, res) => {
  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'tryon-external',
      key: `${req.user._id}:${String(req.body?.product?.sourceUrl || req.body?.product?.affiliateLink || '').trim()}:${Boolean(req.body?.force || req.body?.refresh) ? 'force' : 'cached'}`,
      payload: { body: { product: req.body?.product, force: req.body?.force, refresh: req.body?.refresh } },
      maxAttempts: 1,
      priority: 5,
      runInline: async () => externalTryOnService({ userId: req.user._id, body: req.body })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableError(error, 'Could not generate external AI try-on') });
  }
});

router.post('/:productId/video', requireUser, async (req, res) => {
  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'tryon-video',
      key: `${req.user._id}:${req.params.productId}:video:${Boolean(req.body?.force || req.body?.refresh) ? 'force' : 'cached'}`,
      payload: {
        productId: req.params.productId,
        body: { force: req.body?.force, refresh: req.body?.refresh }
      },
      maxAttempts: 1,
      priority: 4,
      runInline: async () => tryOnVideoService({ userId: req.user._id, productId: req.params.productId, body: req.body })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableVideoError(error, 'Could not generate video try-on') });
  }
});

router.post('/:productId', requireUser, async (req, res) => {
  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'tryon-product',
      key: `${req.user._id}:${req.params.productId}:${req.body?.tryOnModel || ''}:${Boolean(req.body?.force || req.body?.refresh) ? 'force' : 'cached'}`,
      payload: {
        productId: req.params.productId,
        body: {
          tryOnModel: req.body?.tryOnModel,
          force: req.body?.force,
          refresh: req.body?.refresh
        }
      },
      maxAttempts: 1,
      priority: 5,
      runInline: async () => productTryOnService({ userId: req.user._id, productId: req.params.productId, body: req.body })
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readableError(error, 'Could not generate AI try-on') });
  }
});

function registerTryOnJobHandlers() {
  registerJobHandler('tryon-product', async ({ payload, job }) => (
    (await productTryOnService({ userId: job.user, productId: payload.productId, body: payload.body })).body
  ));
  registerJobHandler('tryon-external', async ({ payload, job }) => (
    (await externalTryOnService({ userId: job.user, body: payload.body })).body
  ));
  registerJobHandler('tryon-custom', async ({ payload, job }) => (
    (await customTryOnService({ userId: job.user, body: payload.body })).body
  ));
  registerJobHandler('tryon-video', async ({ payload, job }) => (
    (await tryOnVideoService({ userId: job.user, productId: payload.productId, body: payload.body })).body
  ));
}

export default router;
export { registerTryOnJobHandlers };
