import dns from 'node:dns/promises';
import net from 'node:net';
import { isProductionRuntime } from './devMode.js';

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const defaultTimeoutMs = 15_000;
const defaultMaxBytes = 8 * 1024 * 1024;

function envPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function remoteImageTimeoutMs() {
  return envPositiveNumber('REMOTE_IMAGE_TIMEOUT_MS', defaultTimeoutMs);
}

function remoteImageMaxBytes() {
  return envPositiveNumber('REMOTE_IMAGE_MAX_BYTES', defaultMaxBytes);
}

function isBlockedHostname(hostname = '') {
  const value = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!value) return true;
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (!value.includes('.') && !net.isIP(value)) return true;
  return false;
}

function isBlockedIp(address = '') {
  const version = net.isIP(address);
  if (!version) return false;

  if (version === 4) {
    const parts = address.split('.').map((part) => Number(part));
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab][0-9a-f]?:/i.test(value) || value.startsWith('fe80:')) return true;
  if (value.startsWith('ff')) return true;
  const maybeMappedV4 = value.split(':').pop();
  if (net.isIP(maybeMappedV4) === 4) return isBlockedIp(maybeMappedV4);
  return false;
}

function parsePublicUrl(value, { label = 'Remote URL', allowHttpInDevelopment = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label} is missing`);
  const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }

  const allowedProtocols = new Set(['https:']);
  if (allowHttpInDevelopment && !isProductionRuntime()) allowedProtocols.add('http:');
  if (!allowedProtocols.has(url.protocol)) {
    throw new Error(`${label} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (isBlockedHostname(url.hostname)) {
    throw new Error(`${label} host is not allowed`);
  }
  return url;
}

async function assertPublicHost(url, label) {
  if (net.isIP(url.hostname)) {
    if (isBlockedIp(url.hostname)) throw new Error(`${label} host is not allowed`);
    return;
  }

  let records;
  try {
    records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`${label} host could not be resolved`);
  }
  if (!records.length) throw new Error(`${label} host could not be resolved`);
  if (records.some((record) => isBlockedIp(record.address))) {
    throw new Error(`${label} host resolves to a private network`);
  }
}

async function publicUrl(value, options = {}) {
  const url = parsePublicUrl(value, options);
  await assertPublicHost(url, options.label || 'Remote URL');
  return url.toString();
}

async function readLimitedBytes(response, { label = 'Remote file', maxBytes = remoteImageMaxBytes() } = {}) {
  const limit = Math.max(1, Number(maxBytes) || remoteImageMaxBytes());
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > limit) {
    throw new Error(`${label} is too large`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error(`${label} is too large`);
    return bytes;
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`${label} is too large`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function contentTypeMatches(contentType, allowedPrefixes) {
  if (!allowedPrefixes?.length) return true;
  const value = String(contentType || '').toLowerCase();
  return allowedPrefixes.some((prefix) => value.startsWith(prefix));
}

async function fetchPublicResource(value, options = {}) {
  const {
    label = 'Remote file',
    headers = {},
    timeoutMs = remoteImageTimeoutMs(),
    maxBytes = remoteImageMaxBytes(),
    maxRedirects = 3,
    allowedContentTypePrefixes = ['image/'],
    allowHttpInDevelopment = false
  } = options;

  let current = value;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const url = parsePublicUrl(current, { label, allowHttpInDevelopment });
    await assertPublicHost(url, label);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || defaultTimeoutMs));
    try {
      const response = await fetch(url, {
        headers,
        redirect: 'manual',
        signal: controller.signal
      });

      if (redirectStatuses.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`${label} redirected without a location`);
        current = new URL(location, url).toString();
        continue;
      }

      if (!response.ok) throw new Error(`Could not fetch ${label}`);
      const mimetype = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!contentTypeMatches(mimetype, allowedContentTypePrefixes)) {
        throw new Error(`${label} URL is not an allowed file type`);
      }
      const bytes = await readLimitedBytes(response, { label, maxBytes });
      return {
        bytes,
        mimetype,
        response,
        url: response.url || url.toString()
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${label} timed out after ${Math.round((Number(timeoutMs) || defaultTimeoutMs) / 1000)} seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} redirected too many times`);
}

async function fetchPublicImage(value, options = {}) {
  return fetchPublicResource(value, {
    ...options,
    allowedContentTypePrefixes: options.allowedContentTypePrefixes || ['image/']
  });
}

export {
  fetchPublicImage,
  fetchPublicResource,
  publicUrl,
  remoteImageMaxBytes,
  remoteImageTimeoutMs
};
