import { safeFetchBuffer, safeOutboundFetch } from './security.js';

const DEFAULT_BASE_URL = 'https://api.pruna.ai';

function prunaBaseUrl() {
  return String(process.env.PRUNA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function prunaApiKey() {
  const key = String(process.env.PRUNA_API_KEY || '').trim();
  if (!key) throw new Error('PRUNA_API_KEY is missing on the server');
  return key;
}

function prunaHeaders(extra = {}) {
  return {
    apikey: prunaApiKey(),
    ...extra
  };
}

async function prunaJson(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error || data?.message || data?.detail || data;
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(`${fallback} (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`);
  }
  return data;
}

function absolutizePrunaUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return `${prunaBaseUrl()}${text.startsWith('/') ? text : `/${text}`}`;
}

async function uploadPrunaFile({ bytes, mimetype = 'application/octet-stream', filename = 'input.jpg' }) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Pruna upload requires a buffer');
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimetype || 'application/octet-stream' });
  form.append('content', blob, filename);

  const response = await fetch(`${prunaBaseUrl()}/v1/files`, {
    method: 'POST',
    headers: prunaHeaders(),
    body: form
  });
  const data = await prunaJson(response, 'Pruna file upload failed');
  const url = data?.urls?.get || data?.url || data?.get_url;
  if (!url) throw new Error('Pruna file upload did not return a file URL');
  return {
    id: data.id || '',
    url: absolutizePrunaUrl(url),
    raw: data
  };
}

async function createPrunaPrediction({ model, input, trySync = false }) {
  const headers = prunaHeaders({
    'Content-Type': 'application/json',
    Model: model
  });
  if (trySync) headers['Try-Sync'] = 'true';

  const response = await fetch(`${prunaBaseUrl()}/v1/predictions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input })
  });
  return prunaJson(response, 'Pruna prediction request failed');
}

function firstPrunaGenerationUrl(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) || /^\/v1\/predictions\/delivery\//i.test(value)) return absolutizePrunaUrl(value);
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPrunaGenerationUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['generation_url', 'url', 'output_url', 'video_url', 'image_url']) {
    const found = firstPrunaGenerationUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const key of ['output', 'outputs', 'result', 'results', 'data', 'image', 'video', 'images', 'videos']) {
    const found = firstPrunaGenerationUrl(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = firstPrunaGenerationUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

async function waitForPrunaPrediction(prediction, options = {}) {
  if (prediction?.status === 'succeeded') return prediction;
  const statusUrl = prediction?.get_url || prediction?.status_url || (prediction?.id ? `/v1/predictions/status/${prediction.id}` : '');
  if (!statusUrl) throw new Error('Pruna did not return a prediction status URL');

  const maxAttempts = Number.isFinite(Number(options.maxAttempts)) && Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : 90;
  const pollMs = Number.isFinite(Number(options.pollMs)) && Number(options.pollMs) > 0 ? Number(options.pollMs) : 1500;
  const url = absolutizePrunaUrl(statusUrl);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(url, { headers: prunaHeaders() });
    const data = await prunaJson(response, 'Pruna prediction status request failed');
    if (attempt === 0 || attempt % 5 === 0) options.timer?.mark?.('pruna status poll', { attempt, status: data.status });
    if (data.status === 'succeeded') return data;
    if (data.status === 'failed' || data.error) {
      throw new Error(data.error || data.message || 'Pruna prediction failed');
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Pruna prediction timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
}

async function downloadPrunaOutput(url, accept = '*/*') {
  const { response, buffer } = await safeFetchBuffer(absolutizePrunaUrl(url), {
    maxBytes: 120 * 1024 * 1024,
    headers: prunaHeaders({ accept })
  });
  if (!response.ok) {
    const detail = buffer.toString('utf8');
    throw new Error(`Could not download Pruna output (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  return {
    bytes: buffer,
    mimetype: response.headers.get('content-type')?.split(';')[0] || ''
  };
}

async function fetchPrunaOutput(url, { accept = '*/*', range = '' } = {}) {
  const headers = prunaHeaders({ accept });
  if (range) headers.Range = range;
  const { response } = await safeOutboundFetch(absolutizePrunaUrl(url), {
    maxBytes: 120 * 1024 * 1024,
    headers
  });
  return response;
}

function imagePrunaCostUsd({ turbo = true, garmentCount = 1 } = {}) {
  const count = Math.max(1, Number(garmentCount) || 1);
  if (turbo) return Number((count * 0.008).toFixed(4));
  return Number((0.015 + Math.max(0, count - 1) * 0.008).toFixed(4));
}

function videoPrunaCostUsd({ duration = 5, resolution = '720p', draft = true } = {}) {
  const seconds = Math.max(1, Number(duration) || 5);
  const rate = String(resolution).toLowerCase() === '1080p'
    ? draft ? 0.01 : 0.04
    : draft ? 0.005 : 0.02;
  return Number((seconds * rate).toFixed(4));
}

export {
  createPrunaPrediction,
  downloadPrunaOutput,
  fetchPrunaOutput,
  firstPrunaGenerationUrl,
  imagePrunaCostUsd,
  uploadPrunaFile,
  videoPrunaCostUsd,
  waitForPrunaPrediction
};
