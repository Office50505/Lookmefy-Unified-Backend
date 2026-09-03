import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchImageBuffer } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

function provider() {
  return String(process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
}

function useBunny() {
  return provider() === 'bunny';
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for Bunny storage`);
  return value;
}

function bunnyStorageBaseUrl() {
  if (process.env.BUNNY_STORAGE_ENDPOINT) return String(process.env.BUNNY_STORAGE_ENDPOINT).replace(/\/+$/, '');
  const region = String(process.env.BUNNY_STORAGE_REGION || '').trim().replace(/\.+$/, '');
  const host = region ? `${region}.storage.bunnycdn.com` : 'storage.bunnycdn.com';
  return `https://${host}`;
}

function bunnyCdnBaseUrl() {
  return String(process.env.BUNNY_CDN_BASE_URL || '').trim().replace(/\/+$/, '');
}

function cleanKey(value = '') {
  return String(value || '')
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/^\/+/, '')
    .replace(/^uploads\/+/i, '')
    .replace(/\.\.(\/|\\)/g, '')
    .replace(/\\/g, '/');
}

function pathForKey(key = '') {
  return `uploads/${cleanKey(key)}`;
}

function keyFromStoredPath(value = '') {
  return cleanKey(value);
}

function localPathForKey(key = '') {
  const storedPath = pathForKey(key);
  const resolved = path.resolve(rootDir, storedPath);
  if (!resolved.startsWith(rootDir)) throw new Error('Invalid storage path');
  return resolved;
}

function publicUrlForKey(key = '') {
  const clean = cleanKey(key);
  if (!clean) return '';
  const cdn = bunnyCdnBaseUrl();
  if (cdn) return `${cdn}/${clean}`;
  return `/${pathForKey(clean)}`;
}

function publicUrlForStoredFile(file) {
  if (!file) return null;
  if (typeof file === 'string') {
    if (/^https?:\/\//i.test(file)) return file;
    return publicUrlForKey(file);
  }
  if (file.url) return file.url;
  if (file.remoteUrl) return file.remoteUrl;
  if (file.path) {
    if (/^https?:\/\//i.test(file.path)) return file.path;
    if (file.storage === 'bunny' && bunnyCdnBaseUrl()) return publicUrlForKey(file.path);
    return `/${String(file.path).replace(/^\/+/, '')}`;
  }
  return null;
}

async function bunnyRequest(key, options = {}) {
  const zone = requiredEnv('BUNNY_STORAGE_ZONE');
  const accessKey = requiredEnv('BUNNY_STORAGE_API_KEY');
  const url = `${bunnyStorageBaseUrl()}/${encodeURIComponent(zone)}/${cleanKey(key).split('/').map(encodeURIComponent).join('/')}`;
  return fetch(url, {
    ...options,
    headers: {
      AccessKey: accessKey,
      ...(options.headers || {})
    }
  });
}

async function listBunnyDirectory(prefix = '') {
  if (!useBunny()) throw new Error('Bunny storage is not enabled');
  const clean = cleanKey(prefix).replace(/\/+$/, '');
  const response = await bunnyRequest(clean ? `${clean}/` : '', { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Bunny storage listing failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
  }
  const body = await response.json();
  return (Array.isArray(body) ? body : []).map((item) => {
    const name = cleanKey(item.ObjectName || item.objectName || '');
    const key = clean && (name === clean || name.startsWith(`${clean}/`)) ? name : [clean, name].filter(Boolean).join('/');
    return {
      key,
      name,
      size: Number(item.Length ?? item.length ?? 0),
      isDirectory: Boolean(item.IsDirectory ?? item.isDirectory),
      createdAt: item.DateCreated || item.dateCreated || null,
      updatedAt: item.LastChanged || item.lastChanged || null,
      contentType: item.ContentType || item.contentType || ''
    };
  }).filter((item) => item.name);
}

async function listBunnyInventory({ prefix = '', maxFiles, maxDepth } = {}) {
  const fileLimit = Math.min(Math.max(Number(maxFiles || process.env.BUNNY_RECONCILE_MAX_FILES || 20_000), 1), 100_000);
  const depthLimit = Math.min(Math.max(Number(maxDepth || process.env.BUNNY_RECONCILE_MAX_DEPTH || 8), 1), 20);
  const queue = [{ prefix: cleanKey(prefix).replace(/\/+$/, ''), depth: 0 }];
  const visited = new Set();
  const files = [];
  let truncated = false;

  while (queue.length && files.length < fileLimit) {
    const current = queue.shift();
    if (visited.has(current.prefix)) continue;
    visited.add(current.prefix);
    const items = await listBunnyDirectory(current.prefix);
    for (const item of items) {
      if (item.isDirectory) {
        if (current.depth < depthLimit) queue.push({ prefix: item.key, depth: current.depth + 1 });
        else truncated = true;
      } else {
        files.push(item);
        if (files.length >= fileLimit) {
          truncated = queue.length > 0 || items.indexOf(item) < items.length - 1;
          break;
        }
      }
    }
  }

  return { files, truncated, maxFiles: fileLimit, maxDepth: depthLimit };
}

async function saveBuffer({ key, buffer, mimetype = 'application/octet-stream', filename }) {
  const clean = cleanKey(key || filename);
  if (!clean) throw new Error('Storage key is required');
  if (!Buffer.isBuffer(buffer)) throw new Error('Storage buffer is required');

  if (useBunny()) {
    requiredEnv('BUNNY_CDN_BASE_URL');
    const response = await bunnyRequest(clean, {
      method: 'PUT',
      body: buffer,
      headers: { 'Content-Type': mimetype }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Bunny storage upload failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  } else {
    const localPath = localPathForKey(clean);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
  }

  return {
    filename: filename || path.basename(clean),
    path: pathForKey(clean),
    url: useBunny() ? publicUrlForKey(clean) : undefined,
    storage: useBunny() ? 'bunny' : 'local',
    mimetype,
    size: buffer.length
  };
}

async function readRemoteBuffer(url, label = 'image') {
  const { response, buffer, mimetype } = await safeFetchImageBuffer(url, {
    maxBytes: 12 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': `Mozilla/5.0 Lookmefy ${label} fetcher`
    }
  });
  if (!response.ok) throw new Error(`Could not fetch ${label} (${response.status})`);
  return {
    buffer,
    mimetype
  };
}

async function readStoredFile(file, label = 'image') {
  if (!file) throw new Error(`${label} is missing`);
  if (Buffer.isBuffer(file)) return { buffer: file, mimetype: '' };
  if (typeof file === 'string') {
    if (/^https?:\/\//i.test(file)) return readRemoteBuffer(file, label);
    try {
      return {
        buffer: await fs.readFile(localPathForKey(file)),
        mimetype: ''
      };
    } catch (error) {
      if (!useBunny()) throw error;
      return readRemoteBuffer(publicUrlForKey(file), label);
    }
  }

  const directUrl = file.url || file.remoteUrl || (file.storage === 'bunny' ? publicUrlForStoredFile(file) : '');
  if (directUrl && /^https?:\/\//i.test(directUrl)) {
    const remote = await readRemoteBuffer(directUrl, label);
    return { buffer: remote.buffer, mimetype: file.mimetype || remote.mimetype };
  }

  if (!file.path) throw new Error(`${label} path is missing`);
  return {
    buffer: await fs.readFile(localPathForKey(file.path)),
    mimetype: file.mimetype || ''
  };
}

async function deleteStoredFile(file) {
  if (!file) return;
  const storedFile = typeof file === 'object' ? file : null;
  const storedUrl = String(storedFile?.url || '');
  const cdnBase = bunnyCdnBaseUrl();
  const bunnyCdnUrl = Boolean(cdnBase && storedUrl.startsWith(`${cdnBase}/`));
  const localUploadUrl = /^\/?uploads\//i.test(storedUrl);
  if (storedFile && !storedFile.path && storedFile.remoteUrl) return;
  if (storedFile && !storedFile.path && !bunnyCdnUrl && !localUploadUrl && !['bunny', 'local'].includes(storedFile.storage)) return;

  const key = typeof file === 'string' ? cleanKey(file) : cleanKey(file.path || file.url || '');
  if (!key) return;
  const bunnyBacked = storedFile && (
    storedFile.storage === 'bunny' ||
    bunnyCdnUrl ||
    (!storedFile.storage && useBunny() && Boolean(storedFile.path))
  );

  if (bunnyBacked) {
    const response = await bunnyRequest(key, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Bunny storage delete failed (${response.status})`);
    }
    return;
  }

  await fs.unlink(localPathForKey(key)).catch(() => {});
}

async function deleteStoredPrefix(prefix) {
  const clean = cleanKey(prefix).replace(/\/+$/, '');
  if (!/^users\/[a-f\d]{24}(?:\/|$)/i.test(clean)) throw new Error('Invalid user storage prefix');

  if (useBunny()) {
    const response = await bunnyRequest(`${clean}/`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Bunny storage directory delete failed (${response.status})`);
    }
    return;
  }

  await fs.rm(localPathForKey(clean), { recursive: true, force: true });
}

async function storedFileSignature(file) {
  const url = publicUrlForStoredFile(file);
  if (file?.storage === 'bunny' || /^https?:\/\//i.test(url || '')) {
    return `${url || file.path}:${file.size || ''}:${file.mimetype || ''}`;
  }
  const stat = await fs.stat(localPathForKey(file.path || file));
  return `${file.path || file}:${stat.size}:${stat.mtimeMs}:${file.mimetype || ''}`;
}

export {
  cleanKey,
  deleteStoredFile,
  deleteStoredPrefix,
  keyFromStoredPath,
  listBunnyDirectory,
  listBunnyInventory,
  localPathForKey,
  pathForKey,
  publicUrlForKey,
  publicUrlForStoredFile,
  readStoredFile,
  saveBuffer,
  storedFileSignature,
  useBunny
};
