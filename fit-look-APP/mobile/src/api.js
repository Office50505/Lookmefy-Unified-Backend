import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';

const defaultProductionApi = 'https://api.lookmefy.in/api';
const developmentApi = Platform.OS === 'android' ? 'http://10.0.2.2:5050/api' : 'http://localhost:5050/api';
const isDevelopmentRuntime = typeof __DEV__ !== 'undefined' && __DEV__;
function normalizeApiUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function runtimeHost() {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.hostname) {
    return window.location.hostname;
  }
  const scriptURL = NativeModules?.SourceCode?.scriptURL || '';
  const match = scriptURL.match(/^[a-z]+:\/\/([^/:]+)/i);
  return match?.[1] || '';
}

function normalizeLocalHost(host) {
  if (!host) return '';
  if (Platform.OS === 'android' && (host === 'localhost' || host === '127.0.0.1')) return '10.0.2.2';
  if ((Platform.OS === 'ios' || Platform.OS === 'web') && host === '10.0.2.2') return 'localhost';
  return host;
}

function localRuntimeApiUrl(url) {
  const normalized = normalizeApiUrl(url);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const localHostnames = new Set(['localhost', '127.0.0.1', '10.0.2.2', '0.0.0.0']);
    if (!localHostnames.has(parsed.hostname)) return '';
    const host = normalizeLocalHost(runtimeHost() || parsed.hostname);
    if (!host) return '';
    parsed.hostname = host;
    return normalizeApiUrl(parsed.toString());
  } catch {
    return '';
  }
}

function platformApiUrl(url) {
  const normalized = normalizeApiUrl(url);
  if (!normalized) return '';
  if (Platform.OS === 'android') {
    return normalized.replace('://localhost:', '://10.0.2.2:').replace('://127.0.0.1:', '://10.0.2.2:');
  }
  if (Platform.OS === 'web' || Platform.OS === 'ios') {
    return normalized.replace('://10.0.2.2:', '://localhost:');
  }
  return normalized;
}

function isLocalApiUrl(url) {
  const normalized = normalizeApiUrl(url);
  if (!normalized) return false;
  try {
    const { hostname } = new URL(normalized);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '10.0.2.2' ||
      hostname === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

function requireSecureProductionApiUrl(url) {
  const normalized = normalizeApiUrl(url);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'https:') return normalized;
  } catch {
    // Fall through to the production error below.
  }
  throw new Error('Production API URL must be an HTTPS URL. Set EXPO_PUBLIC_API_URL before building.');
}

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL || '';
const configuredFallbackApiUrls = String(process.env.EXPO_PUBLIC_API_FALLBACK_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const productionConfiguredApiUrl = configuredApiUrl && !isLocalApiUrl(configuredApiUrl) ? configuredApiUrl : '';
const productionConfiguredFallbackApiUrls = configuredFallbackApiUrls.filter((url) => !isLocalApiUrl(url));

export const API_URL = isDevelopmentRuntime
  ? platformApiUrl(productionConfiguredApiUrl || localRuntimeApiUrl(configuredApiUrl) || developmentApi)
  : platformApiUrl(requireSecureProductionApiUrl(productionConfiguredApiUrl || defaultProductionApi));
const runtimeApiUrl = isDevelopmentRuntime
  ? (productionConfiguredApiUrl ? '' : localRuntimeApiUrl(configuredApiUrl || developmentApi))
  : '';
const fallbackApiUrls = isDevelopmentRuntime
  ? configuredFallbackApiUrls.map((url) => (isLocalApiUrl(url) ? localRuntimeApiUrl(url) : platformApiUrl(url))).filter(Boolean)
  : productionConfiguredFallbackApiUrls.map(platformApiUrl).filter(Boolean);
const preferredApiUrl = runtimeApiUrl || API_URL;
const apiUrls = [...new Set([preferredApiUrl, API_URL, runtimeApiUrl, ...fallbackApiUrls].map(normalizeApiUrl).filter(Boolean))];
let activeApiUrl = preferredApiUrl;

export const API_ORIGIN = preferredApiUrl.replace(/\/api\/?$/, '');
const TOKEN_KEY = 'lookmefy_token';
const DEFAULT_TIMEOUT_MS = 15000;
const FORM_TIMEOUT_MS = 60000;
const JOB_TIMEOUT_MS = 180000;
const JOB_POLL_INTERVAL_MS = 1400;

function shouldBypassCache(path, explicitNoCache) {
  return Boolean(explicitNoCache) || /^\/(?:auth\/me|tryons)(?:[/?]|$)/i.test(String(path || ''));
}

function cacheBustedPath(path) {
  const separator = String(path || '').includes('?') ? '&' : '?';
  return `${path}${separator}_=${Date.now()}`;
}

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = details.status || 0;
    this.code = details.code || '';
    this.path = details.path || '';
    this.detail = details.detail || '';
    this.baseUrl = details.baseUrl || '';
  }
}

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function saveToken(token) {
  if (!token) return AsyncStorage.removeItem(TOKEN_KEY);
  return AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken() {
  return AsyncStorage.removeItem(TOKEN_KEY);
}

export function imageUrl(url) {
  if (!url) return '';
  if (/^(?:https?:|data:(?:image|video))/i.test(url)) return url;
  const activeOrigin = activeApiUrl.replace(/\/api\/?$/, '');
  return `${activeOrigin}${url.startsWith('/') ? url : `/${url}`}`;
}

export function formatMoney(value, currency = 'INR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Price unavailable';
  const formatOptions = {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
  };
  try {
    return new Intl.NumberFormat('en-IN', formatOptions).format(amount);
  } catch {
    return `${formatOptions.currency} ${amount.toLocaleString('en-IN', { maximumFractionDigits: formatOptions.maximumFractionDigits })}`;
  }
}

function readableError(value, fallback = 'Request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return readableError(value.message, fallback);
  if (typeof value === 'object') {
    const nested = value.message || value.detail || value.error || value.errors;
    if (nested && nested !== value) return readableError(nested, fallback);
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

function featureNameForPath(path = '') {
  if (/\/auth\/otp/i.test(path)) return 'OTP';
  if (/\/auth\/login/i.test(path)) return 'login';
  if (/\/auth\/password\/reset/i.test(path)) return 'password reset';
  if (/\/auth\/(?:profile|body-photo|avatar-crop|me)/i.test(path)) return 'profile';
  if (/\/recommendations\/(?:studio-chat|stylist-chat)/i.test(path)) return 'AI Studio';
  if (/\/products\/amazon-search/i.test(path)) return 'AI product search';
  if (/\/tryons/i.test(path)) return 'AI try-on';
  if (/\/closet/i.test(path)) return 'wardrobe';
  if (/\/products/i.test(path)) return 'catalog';
  if (/\/payments/i.test(path)) return 'checkout';
  return 'Lookmefy';
}

function networkHelpSuffix() {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    return Platform.OS === 'android'
      ? ' Make sure the backend is running and your API URL uses 10.0.2.2 or your LAN IP from the emulator.'
      : ' Make sure the backend is running and EXPO_PUBLIC_API_URL points to it.';
  }
  return ' Please check your connection and try again.';
}

function friendlyHttpError({ status, path, detail }) {
  const feature = featureNameForPath(path);
  const cleanDetail = String(detail || '').trim();
  const detailText = /^Request failed \(\d+\)$/i.test(cleanDetail) ? '' : cleanDetail;

  if (status === 400) return detailText || `${feature} needs a little more information. Check the details and try again.`;
  if (status === 401 && /\/auth\/(?:login|password\/reset|otp\/verify)/i.test(path)) {
    return detailText || `${feature} could not be completed. Try again.`;
  }
  if (status === 401) return 'Your session expired. Please log in again.';
  if (status === 403) return `You do not have access to this ${feature} action.`;
  if (status === 404) return detailText || `${feature} is not available on the running backend. Restart the backend with the latest code, then try again.`;
  if (status === 408) return `${feature} took too long to respond. Try again in a moment.`;
  if (status === 409 && detailText) return detailText;
  if (status === 413) return 'That upload is too large. Choose a smaller image and try again.';
  if (status === 415) return 'That file type is not supported. Upload a JPG, PNG, or WebP image.';
  if (status === 422 && detailText) return detailText;
  if (status === 429) return detailText || 'Too many requests. Wait a moment, then try again.';
  if (status >= 500) {
    if (/FAL_KEY|OPENAI_API_KEY|PRUNA_API_KEY|PRUNA_KEY|PRUNA_TOKEN|FITROOM_API_KEY|BUNNY|REDIS|MONGODB|storage|missing/i.test(cleanDetail)) {
      return `${feature} is not configured on the backend yet. Check the server .env and restart it.`;
    }
    if (/profile photo|body photo|try-on profile|not enough tokens|blocked|safety|too small|upload|unsupported|HEIC|HEIF|AVIF/i.test(cleanDetail)) return detailText;
    return `${feature} is temporarily unavailable. Try again in a moment.`;
  }
  return detailText || `${feature} request could not be completed.`;
}

function networkErrorMessage(path, timeoutMs, aborted = false) {
  const feature = featureNameForPath(path);
  if (aborted) return `${feature} took longer than ${Math.round(timeoutMs / 1000)}s. Try again, or check the backend logs if this keeps happening.`;
  return `Cannot reach the ${feature} service.${networkHelpSuffix()}`;
}

function isNetworkErrorMessage(message = '') {
  return /network request failed|failed to fetch|load failed|networkerror|timed out|unable to connect|connection refused|abort/i.test(String(message || ''));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollJob(baseUrl, jobId, headers, timeoutMs, originalPath = '') {
  const startedAt = Date.now();
  const limitMs = Math.max(JOB_TIMEOUT_MS, Number(timeoutMs) || 0);
  const featurePath = originalPath || `/jobs/${jobId}`;

  while (Date.now() - startedAt < limitMs) {
    await sleep(JOB_POLL_INTERVAL_MS);
    const response = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, { headers });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = readableError(data, `Job status failed (${response.status})`);
      throw new ApiError(friendlyHttpError({ status: response.status, path: `/jobs/${jobId}`, detail }), {
        status: response.status,
        path: `/jobs/${jobId}`,
        detail,
        baseUrl
      });
    }
    const status = data?.job?.status;
    if (status === 'succeeded') return data.result;
    if (status === 'failed') {
      const detail = data?.job?.error || 'Background task failed';
      throw new ApiError(friendlyHttpError({ status: 500, path: featurePath, detail }), {
        status: 500,
        code: 'job_failed',
        path: featurePath,
        detail,
        baseUrl
      });
    }
  }

  throw new ApiError(`${featureNameForPath(featurePath)} is still processing. Please try again in a moment.`, {
    code: 'job_timeout',
    path: featurePath,
    baseUrl
  });
}

export async function api(path, options = {}) {
  const { timeoutMs, pollJob: shouldPollJob = true, jobTimeoutMs, noCache = false, ...fetchOptions } = options;
  const token = await getToken();
  const isForm = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;
  const headers = isForm ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (isDevelopmentRuntime && /^\/tryons(?:\/|$)/i.test(path)) headers['x-fitlook-sync'] = '1';
  const bypassCache = shouldBypassCache(path, noCache);
  const requestPath = bypassCache ? cacheBustedPath(path) : path;
  if (bypassCache) {
    headers['Cache-Control'] = 'no-cache';
    headers.Pragma = 'no-cache';
  }
  const requestTimeout = Number(timeoutMs || (isForm ? FORM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));

  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const canRetryAcrossHosts = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const orderedUrls = canRetryAcrossHosts
    ? [...new Set([activeApiUrl, ...apiUrls])]
    : [activeApiUrl];
  let networkError = null;
  for (const baseUrl of orderedUrls) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && Number.isFinite(requestTimeout) && requestTimeout > 0
      ? setTimeout(() => controller.abort(), requestTimeout)
      : null;
    try {
      const requestOptions = {
        ...fetchOptions,
        headers: { ...headers, ...fetchOptions.headers },
        signal: controller?.signal || fetchOptions.signal
      };
      if (bypassCache) requestOptions.cache = 'no-store';
      const response = await fetch(`${baseUrl}${requestPath}`, requestOptions);
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = readableError(data, '');
        throw new ApiError(friendlyHttpError({ status: response.status, path, detail }), {
          status: response.status,
          code: data?.code || '',
          path,
          detail,
          baseUrl
        });
      }
      activeApiUrl = baseUrl;
      if (response.status === 202 && data?.jobId && shouldPollJob) {
        return pollJob(baseUrl, data.jobId, headers, jobTimeoutMs || requestTimeout, path);
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const aborted = error?.name === 'AbortError';
      const message = aborted ? networkErrorMessage(path, requestTimeout, true) : error?.message || '';
      if (!aborted && !isNetworkErrorMessage(message)) throw error;
      networkError = new ApiError(aborted ? message : networkErrorMessage(path, requestTimeout), {
        code: aborted ? 'timeout' : 'network_unreachable',
        path,
        detail: error?.message || '',
        baseUrl
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw networkError || new ApiError(networkErrorMessage(path, requestTimeout), { code: 'network_unreachable', path });
}

const IMAGE_MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  avif: 'image/avif',
};

function filenameFromUri(uri) {
  const value = String(uri || '').split(/[?#]/)[0];
  const filename = value.split('/').pop() || '';

  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

export function filePart(asset, fallbackName = 'upload.jpg') {
  if (!asset?.uri) return null;

  const candidateName = asset.fileName || filenameFromUri(asset.uri);
  const name = candidateName && /\.[a-z0-9]+$/i.test(candidateName)
    ? candidateName
    : fallbackName;
  const extension = name.split('.').pop()?.toLowerCase() || 'jpg';
  const mimeType = String(asset.mimeType || '').toLowerCase();
  const type = mimeType === 'image/jpg'
    ? 'image/jpeg'
    : mimeType || IMAGE_MIME_TYPES[extension] || 'image/jpeg';

  return { uri: asset.uri, name, type };
}
