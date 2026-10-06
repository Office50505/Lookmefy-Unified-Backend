import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

class StorageConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageConfigurationError';
    this.statusCode = 503;
  }
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function storageProvider() {
  const configured = normalizeProvider(process.env.STORAGE_PROVIDER || process.env.UPLOAD_STORAGE || process.env.FILE_STORAGE_PROVIDER);
  if (configured) return configured;
  return 'bunny';
}

function bunnyStorageZone() {
  return String(process.env.BUNNY_STORAGE_ZONE || process.env.BUNNY_STORAGE_ZONE_NAME || '').trim();
}

function bunnyAccessKey() {
  return String(process.env.BUNNY_STORAGE_ACCESS_KEY || process.env.BUNNY_STORAGE_API_KEY || process.env.BUNNY_STORAGE_PASSWORD || '').trim();
}

function bunnyEndpoint() {
  const region = String(process.env.BUNNY_STORAGE_REGION || '').trim().toLowerCase();
  const fallbackEndpoint = region && !['default', 'global', 'de'].includes(region)
    ? `${region}.storage.bunnycdn.com`
    : 'storage.bunnycdn.com';
  return String(process.env.BUNNY_STORAGE_ENDPOINT || fallbackEndpoint)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function bunnyPublicBaseUrl() {
  return String(process.env.BUNNY_CDN_URL || process.env.BUNNY_CDN_BASE_URL || process.env.BUNNY_PULL_ZONE_URL || process.env.BUNNY_PUBLIC_URL || '')
    .trim()
    .replace(/\/+$/, '');
}

function storageBasePath() {
  return cleanObjectPath(process.env.BUNNY_STORAGE_BASE_PATH || process.env.STORAGE_BASE_PATH || 'uploads');
}

function isBunnyStorageConfigured() {
  return Boolean(bunnyStorageZone() && bunnyAccessKey() && bunnyPublicBaseUrl());
}

function storageHealthSnapshot() {
  const provider = storageProvider();
  return {
    provider,
    configured: provider === 'local' ? truthy(process.env.ALLOW_LOCAL_UPLOADS) : isBunnyStorageConfigured(),
    bunny: {
      zoneConfigured: Boolean(bunnyStorageZone()),
      accessKeyConfigured: Boolean(bunnyAccessKey()),
      publicUrlConfigured: Boolean(bunnyPublicBaseUrl()),
      endpoint: bunnyEndpoint()
    }
  };
}

function assertBunnyConfigured() {
  if (isBunnyStorageConfigured()) return;
  const missing = [];
  if (!bunnyStorageZone()) missing.push('BUNNY_STORAGE_ZONE');
  if (!bunnyAccessKey()) missing.push('BUNNY_STORAGE_ACCESS_KEY or BUNNY_STORAGE_API_KEY');
  if (!bunnyPublicBaseUrl()) missing.push('BUNNY_CDN_URL or BUNNY_CDN_BASE_URL');
  throw new StorageConfigurationError(`Bunny storage is not configured. Add ${missing.join(', ')} to .env before uploading photos.`);
}

function assertLocalUploadsAllowed() {
  if (truthy(process.env.ALLOW_LOCAL_UPLOADS)) return;
  throw new StorageConfigurationError('Local photo uploads are disabled. Add Bunny storage credentials to .env, or set ALLOW_LOCAL_UPLOADS=true for temporary local development only.');
}

function extensionForMimetype(mimetype = '') {
  const value = String(mimetype).toLowerCase();
  if (value.includes('mp4')) return '.mp4';
  if (value.includes('quicktime')) return '.mov';
  if (value.includes('png')) return '.png';
  if (value.includes('webp')) return '.webp';
  if (value.includes('gif')) return '.gif';
  if (value.includes('avif')) return '.avif';
  if (value.startsWith('video/')) return '.mp4';
  return '.jpg';
}

function safeName(value = '', fallback = 'file') {
  const parsed = path.parse(String(value || fallback));
  const name = (parsed.base || parsed.name || fallback)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^\.+$/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
  return name;
}

function safeFilename({ filename, prefix = 'file', mimetype }) {
  const parsed = path.parse(String(filename || ''));
  const extension = (parsed.ext || extensionForMimetype(mimetype)).toLowerCase();
  const base = filename ? safeName(parsed.name, prefix) : safeName(prefix, 'file');
  return `${base}-${Date.now()}-${randomUUID().slice(0, 12)}${extension}`;
}

function cleanObjectPath(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeName(part, 'file'))
    .join('/');
}

function objectKeyFor({ userId, folder, filename, prefix, mimetype }) {
  const parts = [storageBasePath()];
  if (userId) parts.push('users', String(userId));
  if (folder) parts.push(folder);
  parts.push(safeFilename({ filename, prefix, mimetype }));
  return cleanObjectPath(path.posix.join(...parts.filter(Boolean)));
}

function encodedObjectKey(key) {
  return cleanObjectPath(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function bunnyStorageUrl(key) {
  assertBunnyConfigured();
  return `https://${bunnyEndpoint()}/${encodeURIComponent(bunnyStorageZone())}/${encodedObjectKey(key)}`;
}

function bunnyPublicUrlForPath(key) {
  const base = bunnyPublicBaseUrl();
  if (!base) return '';
  return `${base}/${cleanObjectPath(key)}`;
}

function isAbsoluteUrl(value = '') {
  return /^https?:\/\//i.test(String(value || ''));
}

function storedFileToClientUrl(file) {
  if (!file) return null;
  if (isAbsoluteUrl(file.url)) return file.url;
  if (isAbsoluteUrl(file.path)) return file.path;
  if (file.storage === 'bunny' && file.path) return bunnyPublicUrlForPath(file.path) || null;
  if (file.path) return `/${cleanObjectPath(file.path)}`;
  return null;
}

function safeLocalPath(storedPath) {
  const relativePath = cleanObjectPath(storedPath);
  const resolved = path.resolve(rootDir, relativePath);
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) throw new Error('Invalid stored file path');
  return resolved;
}

async function putBunnyFile({ key, buffer, mimetype }) {
  const response = await fetch(bunnyStorageUrl(key), {
    method: 'PUT',
    headers: {
      AccessKey: bunnyAccessKey(),
      'Content-Type': mimetype || 'application/octet-stream'
    },
    body: buffer
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Could not upload file to Bunny storage (${response.status}${body ? `: ${body.slice(0, 160)}` : ''})`);
  }
}

async function saveStoredFile({ buffer, filename, mimetype, userId, folder = 'uploads', prefix = 'file' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('File data is missing');
  const key = objectKeyFor({ userId, folder, filename, prefix, mimetype });
  const finalFilename = path.posix.basename(key);

  if (storageProvider() === 'local') {
    assertLocalUploadsAllowed();
    const localPath = safeLocalPath(key);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return {
      filename: finalFilename,
      path: key,
      mimetype,
      size: buffer.length,
      storage: 'local'
    };
  }

  assertBunnyConfigured();
  await putBunnyFile({ key, buffer, mimetype });
  return {
    filename: finalFilename,
    path: key,
    url: bunnyPublicUrlForPath(key),
    mimetype,
    size: buffer.length,
    storage: 'bunny'
  };
}

async function readStoredFile(file) {
  if (!file?.path && !file?.url) throw new Error('Stored file is missing');
  if (file.storage === 'bunny') {
    const response = await fetch(bunnyStorageUrl(file.path), {
      headers: {
        AccessKey: bunnyAccessKey(),
        accept: '*/*'
      }
    });
    if (!response.ok) throw new Error(`Could not read file from Bunny storage (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mimetype: (response.headers.get('content-type') || file.mimetype || 'application/octet-stream').split(';')[0],
      filename: file.filename || path.posix.basename(file.path || '')
    };
  }

  if (isAbsoluteUrl(file.url || file.path)) {
    const response = await fetch(file.url || file.path);
    if (!response.ok) throw new Error(`Could not fetch stored file (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      mimetype: (response.headers.get('content-type') || file.mimetype || 'application/octet-stream').split(';')[0],
      filename: file.filename || path.posix.basename(new URL(file.url || file.path).pathname)
    };
  }

  const bytes = await fs.readFile(safeLocalPath(file.path));
  return {
    bytes,
    mimetype: file.mimetype || 'application/octet-stream',
    filename: file.filename || path.posix.basename(file.path)
  };
}

async function deleteStoredFile(file) {
  if (!file?.path && !file?.url) return;
  if (file.storage === 'bunny') {
    const response = await fetch(bunnyStorageUrl(file.path), {
      method: 'DELETE',
      headers: { AccessKey: bunnyAccessKey() }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not delete file from Bunny storage (${response.status})`);
    }
    return;
  }
  if (!isAbsoluteUrl(file.url || file.path)) {
    await fs.unlink(safeLocalPath(file.path)).catch(() => {});
  }
}

function isStorageConfigurationError(error) {
  return error instanceof StorageConfigurationError || error?.name === 'StorageConfigurationError';
}

export {
  deleteStoredFile,
  isBunnyStorageConfigured,
  isStorageConfigurationError,
  readStoredFile,
  saveStoredFile,
  storageHealthSnapshot,
  storageProvider,
  storedFileToClientUrl
};
