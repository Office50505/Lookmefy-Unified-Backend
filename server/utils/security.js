import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import User from '../models/User.js';
import { accountAccessError } from './accountState.js';
import { verifyUserMediaToken } from './mediaTokens.js';

const ALLOWED_RASTER_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/x-avif',
  'image/heic',
  'image/heif'
]);
const ALLOWED_RASTER_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif']);
const FORBIDDEN_IMAGE_MIME_TYPES = new Set(['image/svg+xml', 'image/gif']);
const FORBIDDEN_IMAGE_EXTENSIONS = new Set(['.svg', '.svgz', '.gif']);
const ALLOWED_RASTER_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'heif']);
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_INPUT_PIXELS = 40_000_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function cleanKey(value = '') {
  return String(value || '')
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^\/+/, '')
    .replace(/^uploads\/+/i, '')
    .replace(/\.\.(\/|\\)/g, '')
    .replace(/\\/g, '/');
}

function localPathForKey(key = '') {
  const resolved = path.resolve(rootDir, 'uploads', cleanKey(key));
  if (!resolved.startsWith(path.resolve(rootDir, 'uploads'))) throw new Error('Invalid media path');
  return resolved;
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function developmentBillingBypass(user) {
  return !isProduction() && envFlag('ENABLE_DEV_MODE') && Boolean(user?.devMode);
}

function isDevelopmentModeAllowed() {
  return !isProduction() && envFlag('ENABLE_DEV_MODE');
}

function isAllowedRasterImageUpload(file) {
  const mimetype = String(file?.mimetype || '').toLowerCase().split(';')[0];
  const ext = path.extname(file?.originalname || file?.filename || '').toLowerCase();
  if (FORBIDDEN_IMAGE_MIME_TYPES.has(mimetype) || FORBIDDEN_IMAGE_EXTENSIONS.has(ext)) return false;
  if (mimetype && mimetype !== 'application/octet-stream') return ALLOWED_RASTER_MIME_TYPES.has(mimetype);
  return ALLOWED_RASTER_EXTENSIONS.has(ext);
}

async function normalizeRasterImageBuffer({ buffer, filename = 'image.jpg', quality = 90 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Image buffer is required');
  const parsed = path.parse(filename || 'image.jpg');
  const output = await sharp(buffer, {
    failOn: 'none',
    limitInputPixels: MAX_IMAGE_INPUT_PIXELS
  })
    .rotate()
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return {
    buffer: output,
    filename: `${parsed.name || 'image'}.jpg`,
    mimetype: 'image/jpeg',
    size: output.length
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' https:",
      "form-action 'self'"
    ].join('; ')
  );
  if (isProduction()) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function assertSafeOutboundUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (url.port && url.port !== '443') throw new Error('Only HTTPS port 443 is allowed');
  if (!url.hostname) throw new Error('URL host is required');
  return url;
}

function ipv4ToNumber(address) {
  return address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isBlockedIp(address) {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ].some(([base, bits]) => inCidr4(address, base, bits));
  }
  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    const dottedIpv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
    if (dottedIpv4 && net.isIP(dottedIpv4) === 4 && isBlockedIp(dottedIpv4)) return true;
    const mappedHex = normalized.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      const mapped = `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
      if (isBlockedIp(mapped)) return true;
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.includes('169.254.') ||
      normalized.includes('127.0.0.1')
    );
  }
  return true;
}

async function assertPublicHostname(hostname) {
  const normalizedHost = String(hostname || '').replace(/^\[|\]$/g, '');
  const literalVersion = net.isIP(normalizedHost);
  if (literalVersion) {
    if (isBlockedIp(normalizedHost)) throw new Error('Private or reserved IP addresses are not allowed');
    return;
  }
  const lowered = normalizedHost.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) throw new Error('Localhost is not allowed');
  const records = await dns.lookup(normalizedHost, { all: true, verbatim: true });
  if (!records.length) throw new Error('URL host could not be resolved');
  if (records.some((record) => isBlockedIp(record.address))) {
    throw new Error('URL resolves to a private or reserved network');
  }
}

async function safeOutboundFetch(inputUrl, options = {}) {
  const {
    maxRedirects = 3,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
    ...fetchOptions
  } = options;
  let url = assertSafeOutboundUrl(inputUrl);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertPublicHostname(url.hostname);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url.toString(), {
        ...fetchOptions,
        redirect: 'manual',
        signal: controller.signal,
        headers: fetchOptions.headers || {}
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return { response, finalUrl: url.toString() };
      url = assertSafeOutboundUrl(new URL(location, url).toString());
      continue;
    }

    if (response.body && maxBytes > 0) {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('Response is too large');
      }
    }
    return { response, finalUrl: url.toString() };
  }

  throw new Error('Too many redirects');
}

async function responseBuffer(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error('Response is too large');
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function safeFetchBuffer(url, options = {}) {
  const { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, ...fetchOptions } = options;
  const { response, finalUrl } = await safeOutboundFetch(url, { ...fetchOptions, maxBytes });
  return { response, finalUrl, buffer: await responseBuffer(response, maxBytes) };
}

async function validateRasterImageResponse(response, buffer) {
  if (!response?.ok) return '';
  const declared = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (FORBIDDEN_IMAGE_MIME_TYPES.has(declared)) throw new Error('Remote image type is not allowed');
  if (declared && declared !== 'application/octet-stream' && !ALLOWED_RASTER_MIME_TYPES.has(declared)) {
    throw new Error('Remote URL did not return a supported image');
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_IMAGE_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error('Remote URL did not return a valid raster image');
  }
  if (!ALLOWED_RASTER_FORMATS.has(String(metadata.format || '').toLowerCase())) {
    throw new Error('Remote image format is not allowed');
  }
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_INPUT_PIXELS) {
    throw new Error('Remote image dimensions are not allowed');
  }
  if (Number(metadata.pages || 1) > 1) throw new Error('Animated remote images are not allowed');
  return declared && declared !== 'application/octet-stream'
    ? declared
    : metadata.format === 'jpeg'
      ? 'image/jpeg'
      : `image/${metadata.format}`;
}

async function safeFetchImageBuffer(url, options = {}) {
  const result = await safeFetchBuffer(url, options);
  const mimetype = await validateRasterImageResponse(result.response, result.buffer);
  return { ...result, mimetype };
}

async function safeFetchText(url, options = {}) {
  const { buffer, response, finalUrl } = await safeFetchBuffer(url, {
    maxBytes: options.maxBytes || DEFAULT_MAX_RESPONSE_BYTES,
    ...options
  });
  return { response, finalUrl, text: buffer.toString('utf8') };
}

function mediaToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return String(req.query?.mediaToken || req.query?.token || '');
}

function sameStoredPath(stored, clean) {
  return cleanKey(stored?.path || stored?.url || '') === clean;
}

function isPublicUploadKey(key) {
  return /^product-[^/]+\.(?:jpe?g|png|webp|avif)$/i.test(key);
}

async function authorizeUploadRequest(req, clean) {
  if (isPublicUploadKey(clean)) return { public: true };
  const token = mediaToken(req);
  if (!token) {
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = verifyUserMediaToken(token);
  } catch {
    try {
      // Temporary compatibility for media URLs created before scoped tokens shipped.
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      const error = new Error('Invalid or expired media access');
      error.status = 401;
      throw error;
    }
  }
  const user = await User.findById(decoded.sub);
  if (!user) {
    const error = new Error('User not found');
    error.status = 401;
    throw error;
  }
  const accessError = accountAccessError(user);
  if (accessError) {
    const error = new Error(accessError.message);
    error.status = accessError.statusCode;
    throw error;
  }
  const userId = user._id.toString();
  const allowed = clean.startsWith(`users/${userId}/`) ||
    sameStoredPath(user.bodyPhoto, clean) ||
    sameStoredPath(user.bodyPhoto?.original, clean);
  if (!allowed) {
    const error = new Error('This media does not belong to the current user');
    error.status = 403;
    throw error;
  }
  return { public: false, user };
}

function contentDispositionFor(clean) {
  if (/\.(?:jpe?g|png|webp|avif|gif|mp4|mov)$/i.test(clean)) return '';
  return `attachment; filename="${path.basename(clean).replace(/"/g, '') || 'download'}"`;
}

function serveUploadedMedia() {
  return async function uploadedMediaHandler(req, res) {
    try {
      const clean = cleanKey(decodeURIComponent(req.path || ''));
      if (!clean) return res.status(404).end();
      const auth = await authorizeUploadRequest(req, clean);
      const disposition = contentDispositionFor(clean);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', auth.public ? 'public, max-age=86400' : 'private, no-store');
      if (disposition) res.setHeader('Content-Disposition', disposition);
      return res.sendFile(localPathForKey(clean), (error) => {
        if (!error || res.headersSent) return;
        res.status(error.statusCode || 404).end();
      });
    } catch (error) {
      return res.status(error.status || 400).json({ message: error.message || 'Could not read media' });
    }
  };
}

export {
  developmentBillingBypass,
  envFlag,
  isAllowedRasterImageUpload,
  isBlockedIp,
  isDevelopmentModeAllowed,
  isProduction,
  normalizeRasterImageBuffer,
  safeOutboundFetch,
  safeFetchBuffer,
  safeFetchImageBuffer,
  safeFetchText,
  securityHeaders,
  serveUploadedMedia,
  validateRasterImageResponse
};
