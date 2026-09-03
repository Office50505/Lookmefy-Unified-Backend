import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { publicUrlForKey, publicUrlForStoredFile, readStoredFile, saveBuffer, useBunny } from './storage.js';
import { safeFetchImageBuffer } from './security.js';

const PROCESSING_VERSION = 'subject-isolation-v4';
const DEFAULT_PROVIDER = 'semantic-rembg';
const DEFAULT_THRESHOLD = 48;
const DEFAULT_PADDING = 18;
const DEFAULT_MODEL_CHAIN = 'birefnet-general,isnet-general-use,u2net';
const DEFAULT_INFERENCE_LONG_SIDE = 1024;
const DEFAULT_MASK_FEATHER = 1.2;
const DEFAULT_MASK_CLOSE_SIZE = 3;
const DEBUG_SUBJECT_ISOLATION = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_SUBJECT_ISOLATION || '').toLowerCase());
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..');
const PYTHON_WORKER = path.resolve(PROJECT_ROOT, 'server/services/semantic_background_removal.py');

function extensionFor(mimeType = '') {
  return mimeType.includes('webp') ? '.webp' : '.png';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function publicUrlForPath(storedPath = '') {
  return storedPath ? publicUrlForKey(storedPath) : '';
}

function debugMaskPreviewFor(folder) {
  if (!folder || process.env.NODE_ENV === 'production') return null;
  return {
    source: publicUrlForPath(path.posix.join(folder, 'source.png')),
    rawMask: publicUrlForPath(path.posix.join(folder, 'raw-mask.png')),
    correctedMask: publicUrlForPath(path.posix.join(folder, 'corrected-mask.png')),
    finalTransparent: publicUrlForPath(path.posix.join(folder, 'final-transparent.png'))
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeLocalPath(rootDir, storedPath) {
  const cleanPath = String(storedPath || '').replace(/^\/+/, '');
  const resolved = path.resolve(rootDir, cleanPath);
  if (!resolved.startsWith(rootDir)) throw new Error('Invalid image path');
  return resolved;
}

async function metadataForBuffer(buffer) {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  return {
    width: Number(meta.width || 0),
    height: Number(meta.height || 0),
    hasAlpha: Boolean(meta.hasAlpha)
  };
}

function logIsolation(step, meta = {}) {
  if (!DEBUG_SUBJECT_ISOLATION) return;
  console.log(`[subject-isolation] ${step}`, meta);
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function pythonCommand() {
  return process.env.BACKGROUND_REMOVAL_PYTHON
    || path.join(PROJECT_ROOT, '.venv-rembg', 'bin', 'python')
    || 'python3';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        U2NET_HOME: process.env.U2NET_HOME || path.join(PROJECT_ROOT, '.model-cache', 'rembg'),
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || path.join(PROJECT_ROOT, '.model-cache')
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`));
    });
  });
}

async function alphaStatsForBuffer(buffer) {
  const { data, info } = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  let semiTransparentPixels = 0;
  let opaquePixels = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    const alpha = data[index];
    if (alpha < 255) transparentPixels += 1;
    if (alpha > 0 && alpha < 255) semiTransparentPixels += 1;
    if (alpha === 255) opaquePixels += 1;
  }
  return {
    hasAlpha: true,
    hasTransparentPixels: transparentPixels > 0,
    transparentPixels,
    semiTransparentPixels,
    opaquePixels,
    pixelCount: info.width * info.height
  };
}

async function hasUsableTransparency(buffer) {
  const meta = await metadataForBuffer(buffer);
  if (!meta.hasAlpha) return false;
  const stats = await alphaStatsForBuffer(buffer);
  return stats.hasTransparentPixels && stats.transparentPixels / Math.max(1, stats.pixelCount) > 0.002;
}

async function imageBufferFromInput({ rootDir, imageUrl, imageBuffer, storedImage }) {
  if (Buffer.isBuffer(imageBuffer)) {
    return { bytes: imageBuffer, sourceLabel: 'buffer', sourceImageUrl: imageUrl || '' };
  }

  if (storedImage?.path) {
    const { buffer: bytes } = await readStoredFile(storedImage, 'source image');
    const sourceImageUrl = publicUrlForStoredFile(storedImage) || publicUrlForPath(storedImage.path);
    logIsolation('source stored file loaded', { sourceImageUrl, bytes: bytes.length });
    return { bytes, sourceLabel: storedImage.path, sourceImageUrl };
  }

  const source = String(imageUrl || '').trim();
  if (!source) throw new Error('Image source is missing');
  if (source.startsWith('/uploads/')) {
    const storedPath = source.replace(/^\/+/, '');
    const { buffer: bytes } = await readStoredFile(storedPath, 'source image');
    logIsolation('source stored url loaded', { sourceImageUrl: publicUrlForPath(storedPath), bytes: bytes.length });
    return { bytes, sourceLabel: storedPath, sourceImageUrl: source };
  }

  if (/^https?:\/\//i.test(source)) {
    const { response, buffer: bytes } = await safeFetchImageBuffer(source, {
      maxBytes: 12 * 1024 * 1024,
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 Lookmefy subject isolation fetcher'
      }
    });
    if (!response.ok) throw new Error(`Could not fetch source image (${response.status})`);
    logIsolation('source remote url downloaded', {
      sourceImageUrl: shortSourceUrl(source),
      contentType: response.headers.get('content-type') || '',
      bytes: bytes.length
    });
    return { bytes, sourceLabel: source, sourceImageUrl: source };
  }

  throw new Error('Unsupported image source');
}

function shortSourceUrl(value = '') {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return String(value || '').slice(0, 140);
  }
}

function alphaBoundsFromRaw(raw, width, height, channels = 4, alphaThreshold = 12) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = raw[(y * width + x) * channels + channels - 1];
      if (alpha <= alphaThreshold) continue;
      count += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!count) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    pixelCount: count
  };
}

function zoneBounds(bounds, x1, y1, x2, y2) {
  return {
    x: Math.max(0, Math.floor(bounds.x + bounds.width * x1)),
    y: Math.max(0, Math.floor(bounds.y + bounds.height * y1)),
    width: Math.max(1, Math.ceil(bounds.width * (x2 - x1))),
    height: Math.max(1, Math.ceil(bounds.height * (y2 - y1)))
  };
}

function alphaCoverage(raw, imageWidth, imageHeight, channels, zone, threshold = 32) {
  const left = clamp(zone.x, 0, imageWidth - 1);
  const top = clamp(zone.y, 0, imageHeight - 1);
  const right = clamp(zone.x + zone.width, left + 1, imageWidth);
  const bottom = clamp(zone.y + zone.height, top + 1, imageHeight);
  let visible = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      total += 1;
      if (raw[(y * imageWidth + x) * channels + channels - 1] > threshold) visible += 1;
    }
  }
  return total ? visible / total : 0;
}

function foregroundComponents(raw, width, height, channels = 4, threshold = 32) {
  const pixels = width * height;
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  const components = [];
  const isForeground = (index) => raw[index * channels + channels - 1] > threshold;

  for (let index = 0; index < pixels; index += 1) {
    if (visited[index] || !isForeground(index)) continue;
    let start = 0;
    let end = 0;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    visited[index] = 1;
    queue[end] = index;
    end += 1;

    while (start < end) {
      const current = queue[start];
      start += 1;
      count += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const push = (next) => {
        if (next < 0 || next >= pixels || visited[next] || !isForeground(next)) return;
        visited[next] = 1;
        queue[end] = next;
        end += 1;
      };
      if (x > 0) push(current - 1);
      if (x < width - 1) push(current + 1);
      if (y > 0) push(current - width);
      if (y < height - 1) push(current + width);
    }

    components.push({
      pixelCount: count,
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    });
  }

  components.sort((a, b) => b.pixelCount - a.pixelCount);
  return components;
}

function internalHoleRatio(raw, imageWidth, imageHeight, channels, zone, alphaThreshold = 32) {
  const left = clamp(zone.x, 0, imageWidth - 1);
  const top = clamp(zone.y, 0, imageHeight - 1);
  const width = Math.max(1, Math.min(zone.width, imageWidth - left));
  const height = Math.max(1, Math.min(zone.height, imageHeight - top));
  const pixels = width * height;
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let enclosedTransparent = 0;
  let largestHole = 0;

  const localIndex = (x, y) => y * width + x;
  const isTransparent = (x, y) => raw[((top + y) * imageWidth + (left + x)) * channels + channels - 1] <= alphaThreshold;

  for (let index = 0; index < pixels; index += 1) {
    if (visited[index]) continue;
    const sx = index % width;
    const sy = Math.floor(index / width);
    if (!isTransparent(sx, sy)) {
      visited[index] = 1;
      continue;
    }

    let start = 0;
    let end = 0;
    let count = 0;
    let touchesEdge = false;
    visited[index] = 1;
    queue[end] = index;
    end += 1;

    while (start < end) {
      const current = queue[start];
      start += 1;
      count += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      const push = (nx, ny) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const next = localIndex(nx, ny);
        if (visited[next] || !isTransparent(nx, ny)) return;
        visited[next] = 1;
        queue[end] = next;
        end += 1;
      };
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }

    if (!touchesEdge) {
      enclosedTransparent += count;
      if (count > largestHole) largestHole = count;
    }
  }

  return {
    ratio: enclosedTransparent / Math.max(1, pixels),
    largestHoleRatio: largestHole / Math.max(1, pixels)
  };
}

async function repairInternalTorsoHoles(buffer) {
  const { data, info } = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBoundsFromRaw(data, info.width, info.height, info.channels, 32);
  if (!bounds) return { buffer, repairedPixels: 0 };
  const torso = zoneBounds(bounds, 0.24, 0.20, 0.76, 0.62);
  const left = clamp(torso.x, 0, info.width - 1);
  const top = clamp(torso.y, 0, info.height - 1);
  const width = Math.max(1, Math.min(torso.width, info.width - left));
  const height = Math.max(1, Math.min(torso.height, info.height - top));
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let repairedPixels = 0;
  const localIndex = (x, y) => y * width + x;
  const alphaAt = (x, y) => data[((top + y) * info.width + (left + x)) * info.channels + info.channels - 1];

  for (let index = 0; index < width * height; index += 1) {
    if (visited[index]) continue;
    const sx = index % width;
    const sy = Math.floor(index / width);
    if (alphaAt(sx, sy) > 32) {
      visited[index] = 1;
      continue;
    }
    let start = 0;
    let end = 0;
    let touchesEdge = false;
    const component = [];
    visited[index] = 1;
    queue[end] = index;
    end += 1;

    while (start < end) {
      const current = queue[start];
      start += 1;
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
      const push = (nx, ny) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const next = localIndex(nx, ny);
        if (visited[next] || alphaAt(nx, ny) > 32) return;
        visited[next] = 1;
        queue[end] = next;
        end += 1;
      };
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }

    const ratio = component.length / Math.max(1, width * height);
    if (!touchesEdge && ratio <= 0.55) {
      for (const current of component) {
        const x = current % width;
        const y = Math.floor(current / width);
        data[((top + y) * info.width + (left + x)) * info.channels + info.channels - 1] = 255;
      }
      repairedPixels += component.length;
    }
  }

  if (!repairedPixels) return { buffer, repairedPixels: 0 };
  const repaired = await sharp(data, { raw: info }).png({ compressionLevel: 9 }).toBuffer();
  return { buffer: repaired, repairedPixels };
}

async function analyzeCutoutQuality(buffer) {
  const { data, info } = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBoundsFromRaw(data, info.width, info.height, info.channels, 32);
  if (!bounds) {
    return {
      passed: false,
      score: 0,
      foregroundAreaRatio: 0,
      torsoCoverage: 0,
      footCoverage: 0,
      headCoverage: 0,
      armCoverage: 0,
      legCoverage: 0,
      internalHoleRatio: 1,
      largestInternalHoleRatio: 1,
      connectedComponents: 0,
      largestComponentRatio: 0,
      edgeNoiseRatio: 1,
      reasons: ['empty foreground mask']
    };
  }

  const components = foregroundComponents(data, info.width, info.height, info.channels, 32);
  const largeComponentMin = Math.max(400, bounds.pixelCount * 0.012);
  const largeComponents = components.filter((component) => component.pixelCount >= largeComponentMin);
  const largestComponentRatio = components[0]?.pixelCount ? components[0].pixelCount / Math.max(1, bounds.pixelCount) : 0;
  const foregroundAreaRatio = bounds.pixelCount / Math.max(1, bounds.width * bounds.height);
  const torsoCoverage = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.28, 0.22, 0.72, 0.56));
  const leftFoot = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.08, 0.84, 0.48, 0.995));
  const rightFoot = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.52, 0.84, 0.92, 0.995));
  const footCoverage = (leftFoot + rightFoot) / 2;
  const headCoverage = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.30, 0.00, 0.70, 0.22));
  const leftArm = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.04, 0.22, 0.30, 0.66));
  const rightArm = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.70, 0.22, 0.96, 0.66));
  const armCoverage = (leftArm + rightArm) / 2;
  const legCoverage = alphaCoverage(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.24, 0.56, 0.76, 0.90));
  const holes = internalHoleRatio(data, info.width, info.height, info.channels, zoneBounds(bounds, 0.24, 0.20, 0.76, 0.62));
  const edgeNoiseRatio = components.slice(1).reduce((sum, component) => sum + component.pixelCount, 0) / Math.max(1, bounds.pixelCount);
  const reasons = [];

  if (foregroundAreaRatio < 0.18) reasons.push('foreground area is suspiciously small');
  if (foregroundAreaRatio > 0.88) reasons.push('foreground area is suspiciously large');
  if (largeComponents.length > 3) reasons.push('mask has several large disconnected fragments');
  if (largestComponentRatio < 0.82) reasons.push('head and body are not one coherent subject');
  if (torsoCoverage < 0.46) reasons.push('torso coverage is too low');
  if (footCoverage < 0.14) reasons.push('foot coverage is too low');
  if (headCoverage < 0.18) reasons.push('head region is too incomplete');
  if (legCoverage < 0.16) reasons.push('hip/leg region is too incomplete');
  if (holes.largestHoleRatio > 0.10 || holes.ratio > 0.16) reasons.push('large transparent hole detected through torso');
  if (edgeNoiseRatio > 0.18) reasons.push('too much disconnected edge noise');

  const score = Math.max(0, Math.min(100, Math.round(
    100
    - Math.max(0, 0.46 - torsoCoverage) * 90
    - Math.max(0, 0.14 - footCoverage) * 120
    - Math.max(0, 0.82 - largestComponentRatio) * 80
    - Math.max(0, holes.largestHoleRatio - 0.04) * 260
    - Math.max(0, edgeNoiseRatio - 0.06) * 80
    - reasons.length * 5
  )));

  return {
    passed: reasons.length === 0,
    score,
    foregroundAreaRatio,
    torsoCoverage,
    footCoverage,
    headCoverage,
    armCoverage,
    legCoverage,
    internalHoleRatio: holes.ratio,
    largestInternalHoleRatio: holes.largestHoleRatio,
    connectedComponents: largeComponents.length,
    largestComponentRatio,
    edgeNoiseRatio,
    reasons
  };
}

function assertCutoutQuality(quality) {
  if (quality.passed) return;
  const message = quality.reasons?.length ? quality.reasons.join('; ') : 'cutout quality validation failed';
  throw new Error(`Subject isolation quality failed: ${message}`);
}

function median(values) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function sampleBackgroundColor(raw, width, height) {
  const red = [];
  const green = [];
  const blue = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 96));
  const add = (x, y) => {
    const offset = (y * width + x) * 4;
    if (raw[offset + 3] < 16) return;
    red.push(raw[offset]);
    green.push(raw[offset + 1]);
    blue.push(raw[offset + 2]);
  };

  for (let x = 0; x < width; x += step) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    add(0, y);
    add(width - 1, y);
  }

  return [median(red), median(green), median(blue)];
}

function colorDistance(raw, offset, bg) {
  const dr = raw[offset] - bg[0];
  const dg = raw[offset + 1] - bg[1];
  const db = raw[offset + 2] - bg[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function saturation(raw, offset) {
  const r = raw[offset];
  const g = raw[offset + 1];
  const b = raw[offset + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max ? (max - min) / max : 0;
}

function candidateBackgroundMask(raw, width, height, bg, threshold) {
  const pixels = width * height;
  const candidates = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const alpha = raw[offset + 3];
    if (alpha < 16) {
      candidates[index] = 1;
      continue;
    }
    const distance = colorDistance(raw, offset, bg);
    const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
    const lum = (raw[offset] + raw[offset + 1] + raw[offset + 2]) / 3;
    const softNeutral = saturation(raw, offset) < 0.16 && Math.abs(lum - bgLum) < threshold * 1.5;
    candidates[index] = distance < threshold || softNeutral ? 1 : 0;
  }
  return candidates;
}

function connectedEdgeBackground(candidates, width, height) {
  const pixels = width * height;
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let start = 0;
  let end = 0;
  const push = (index) => {
    if (index < 0 || index >= pixels || visited[index] || !candidates[index]) return;
    visited[index] = 1;
    queue[end] = index;
    end += 1;
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (start < end) {
    const index = queue[start];
    start += 1;
    const x = index % width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (index >= width) push(index - width);
    if (index < pixels - width) push(index + width);
  }

  return visited;
}

async function cropTransparentPng(buffer, padding = DEFAULT_PADDING) {
  const { data, info } = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBoundsFromRaw(data, info.width, info.height, 4, 32);
  if (!bounds) throw new Error('Subject isolation produced an empty mask');
  const left = clamp(bounds.x - padding, 0, info.width - 1);
  const top = clamp(bounds.y - padding, 0, info.height - 1);
  const right = clamp(bounds.x + bounds.width + padding, left + 1, info.width);
  const bottom = clamp(bounds.y + bounds.height + padding, top + 1, info.height);
  const output = await sharp(buffer, { failOn: 'none' })
    .extract({ left, top, width: right - left, height: bottom - top })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return {
    buffer: output,
    bounds: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      subject: bounds
    }
  };
}

async function transparentFromExistingAlpha(inputBuffer, padding) {
  const png = await sharp(inputBuffer, { failOn: 'none' }).rotate().ensureAlpha().png({ compressionLevel: 9 }).toBuffer();
  return cropTransparentPng(png, padding);
}

async function transparentFromEdgeMask(inputBuffer, options = {}) {
  const threshold = Number(options.threshold || DEFAULT_THRESHOLD);
  const padding = Number(options.padding || DEFAULT_PADDING);
  const { data, info } = await sharp(inputBuffer, { failOn: 'none' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const bg = sampleBackgroundColor(data, width, height);
  const candidates = candidateBackgroundMask(data, width, height, bg, threshold);
  const background = connectedEdgeBackground(candidates, width, height);
  const pixels = width * height;
  const rgb = Buffer.alloc(pixels * 3);
  const alpha = Buffer.alloc(pixels);
  let subjectPixels = 0;

  for (let index = 0; index < pixels; index += 1) {
    const sourceOffset = index * 4;
    const rgbOffset = index * 3;
    rgb[rgbOffset] = data[sourceOffset];
    rgb[rgbOffset + 1] = data[sourceOffset + 1];
    rgb[rgbOffset + 2] = data[sourceOffset + 2];
    if (background[index]) {
      alpha[index] = 0;
    } else {
      alpha[index] = data[sourceOffset + 3];
      if (alpha[index] > 12) subjectPixels += 1;
    }
  }

  const subjectRatio = subjectPixels / pixels;
  if (subjectRatio < 0.03 || subjectRatio > 0.92) {
    throw new Error('Subject isolation mask was not confident enough');
  }

  const blurred = await sharp(alpha, { raw: { width, height, channels: 1 } }).blur(0.75).raw().toBuffer({ resolveWithObject: true });
  const featheredAlpha = blurred.info.channels === 1 ? blurred.data : Buffer.allocUnsafe(pixels);
  if (blurred.info.channels !== 1) {
    for (let index = 0; index < pixels; index += 1) {
      featheredAlpha[index] = blurred.data[index * blurred.info.channels];
    }
  }
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(featheredAlpha, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return cropTransparentPng(png, padding);
}

function processingSettings() {
  return {
    models: String(process.env.BACKGROUND_REMOVAL_MODELS || DEFAULT_MODEL_CHAIN)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
    inferenceLongSide: numberFromEnv('BACKGROUND_REMOVAL_INFERENCE_LONG_SIDE', DEFAULT_INFERENCE_LONG_SIDE),
    feather: numberFromEnv('BACKGROUND_REMOVAL_MASK_FEATHER', DEFAULT_MASK_FEATHER),
    closeSize: numberFromEnv('BACKGROUND_REMOVAL_MASK_CLOSE_SIZE', DEFAULT_MASK_CLOSE_SIZE),
    threshold: Number(process.env.BACKGROUND_REMOVAL_EDGE_THRESHOLD || DEFAULT_THRESHOLD),
    padding: Number(process.env.BACKGROUND_REMOVAL_CROP_PADDING || DEFAULT_PADDING)
  };
}

export function backgroundRemovalProviderName() {
  return String(process.env.BACKGROUND_REMOVAL_PROVIDER || DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
}

async function transparentFromSemanticMask(inputBuffer, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(PROJECT_ROOT, '.tmp-cutout-'));
  const inputPath = path.join(tempDir, 'source.png');
  const outputPath = path.join(tempDir, 'cutout.png');
  const configuredPython = pythonCommand();
  const command = await pathExists(configuredPython) ? configuredPython : 'python3';
  const models = Array.isArray(options.models) && options.models.length ? options.models : DEFAULT_MODEL_CHAIN.split(',');
  try {
    await fs.writeFile(inputPath, inputBuffer);
    const { stdout, stderr } = await runCommand(command, [
      PYTHON_WORKER,
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--models',
      models.join(','),
      '--long-side',
      String(options.inferenceLongSide || DEFAULT_INFERENCE_LONG_SIDE),
      '--feather',
      String(options.feather ?? DEFAULT_MASK_FEATHER),
      '--close-size',
      String(options.closeSize || DEFAULT_MASK_CLOSE_SIZE)
    ].concat(options.debugDir ? ['--debug-dir', options.debugDir] : []));
    const workerMeta = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');
    const cutout = await fs.readFile(outputPath);
    const repaired = await repairInternalTorsoHoles(cutout);
    const cropped = await cropTransparentPng(repaired.buffer, options.padding ?? DEFAULT_PADDING);
    const quality = await analyzeCutoutQuality(cropped.buffer);
    assertCutoutQuality(quality);
    logIsolation('semantic worker completed', {
      primaryModel: workerMeta.primaryModel,
      modelsUsed: workerMeta.modelsUsed,
      failedModels: workerMeta.failedModels,
      inferenceResolution: workerMeta.inferenceResolution,
      repairedPixels: repaired.repairedPixels,
      stderr: stderr.trim().slice(0, 600)
    });
    return {
      ...cropped,
      workerMeta,
      quality,
      repairedPixels: repaired.repairedPixels
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function removeBackground(input = {}) {
  const provider = backgroundRemovalProviderName();
  const settings = processingSettings();
  const meta = await metadataForBuffer(input.imageBuffer);
  if (!meta.width || !meta.height) throw new Error('Image dimensions could not be read');
  logIsolation('processing started', {
    provider,
    sourceMimeType: input.mimeType || '',
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    sourceHasAlpha: meta.hasAlpha
  });

  if (await hasUsableTransparency(input.imageBuffer)) {
    const { buffer, bounds } = await transparentFromExistingAlpha(input.imageBuffer, settings.padding);
    const quality = await analyzeCutoutQuality(buffer);
    assertCutoutQuality(quality);
    const outputMeta = await metadataForBuffer(buffer);
    const alpha = await alphaStatsForBuffer(buffer);
    logIsolation('existing transparency reused', {
      outputMimeType: 'image/png',
      outputWidth: outputMeta.width,
      outputHeight: outputMeta.height,
      alphaDetected: alpha.hasTransparentPixels,
      quality
    });
    return {
      outputBuffer: buffer,
      width: outputMeta.width,
      height: outputMeta.height,
      sourceWidth: meta.width,
      sourceHeight: meta.height,
      bounds,
      mimeType: 'image/png',
      provider,
      reusedTransparency: true,
      model: 'existing-alpha',
      settings,
      quality
    };
  }

  if (provider !== DEFAULT_PROVIDER && provider !== 'edge-mask') {
    throw new Error(`Background-removal provider "${provider}" is not configured on this server`);
  }

  const semanticResult = provider === DEFAULT_PROVIDER
    ? await transparentFromSemanticMask(input.imageBuffer, { ...settings, debugDir: input.debugDir || '' })
    : null;
  const edgeResult = provider === 'edge-mask'
    ? await transparentFromEdgeMask(input.imageBuffer, settings)
    : null;
  const { buffer, bounds, workerMeta, repairedPixels } = semanticResult || edgeResult;
  const quality = semanticResult?.quality || await analyzeCutoutQuality(buffer);
  assertCutoutQuality(quality);
  const outputMeta = await metadataForBuffer(buffer);
  const alpha = await alphaStatsForBuffer(buffer);
  if (!alpha.hasTransparentPixels) throw new Error('Subject isolation output did not contain transparent pixels');
  logIsolation('processing completed', {
    outputMimeType: 'image/png',
    outputWidth: outputMeta.width,
    outputHeight: outputMeta.height,
    alphaDetected: alpha.hasTransparentPixels,
    transparentPixels: alpha.transparentPixels,
    quality
  });
  return {
    outputBuffer: buffer,
    width: outputMeta.width,
    height: outputMeta.height,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
    bounds,
    mimeType: 'image/png',
    provider,
    model: workerMeta?.primaryModel || (provider === 'edge-mask' ? 'edge-mask-color-distance' : ''),
    modelsUsed: workerMeta?.modelsUsed || [],
    failedModels: workerMeta?.failedModels || [],
    inferenceResolution: workerMeta?.inferenceResolution || null,
    maskSettings: workerMeta?.maskSettings || settings,
    repairedPixels: repairedPixels || 0,
    quality,
    reusedTransparency: false
  };
}

export async function isolateSubjectAsset({ rootDir, user, imageUrl, imageBuffer, storedImage }) {
  const provider = backgroundRemovalProviderName();
  const settings = processingSettings();
  const startedAt = new Date();
  const source = await imageBufferFromInput({ rootDir, imageUrl, imageBuffer, storedImage });
  const sourceHash = sha256(source.bytes);
  const cacheKey = sha256(JSON.stringify({
    source: sourceHash,
    provider,
    version: PROCESSING_VERSION,
    settings
  }));
  const folder = user?._id
    ? path.posix.join('uploads', 'users', user._id.toString(), 'transparent-cache')
    : path.posix.join('uploads', 'transparent-cache');
  const filename = `subject-${cacheKey.slice(0, 24)}${extensionFor('image/png')}`;
  const storedPath = path.posix.join(folder, filename);
  const storageRef = { path: storedPath, storage: useBunny() ? 'bunny' : 'local' };
  const absolutePath = path.join(rootDir, storedPath);
  const debugFolder = process.env.NODE_ENV === 'production' ? '' : path.posix.join(folder, 'debug', cacheKey.slice(0, 24));
  const debugAbsoluteDir = debugFolder ? path.join(rootDir, debugFolder) : '';
  const sourceMeta = await metadataForBuffer(source.bytes);
  const sourceAlpha = sourceMeta.hasAlpha ? await alphaStatsForBuffer(source.bytes) : { hasTransparentPixels: false };
  logIsolation('cache lookup', {
    sourceImageUrl: shortSourceUrl(source.sourceImageUrl),
    provider,
    processingVersion: PROCESSING_VERSION,
    sourceWidth: sourceMeta.width,
    sourceHeight: sourceMeta.height,
    sourceHasAlpha: sourceMeta.hasAlpha,
    sourceHasTransparentPixels: sourceAlpha.hasTransparentPixels,
    cacheKey: cacheKey.slice(0, 24)
  });

  try {
    const { buffer: cachedBytes } = await readStoredFile(storageRef, 'transparent cache');
    const cachedMeta = await metadataForBuffer(cachedBytes);
    const cachedAlpha = await alphaStatsForBuffer(cachedBytes);
    const cachedQuality = await analyzeCutoutQuality(cachedBytes);
    if (!cachedAlpha.hasTransparentPixels) throw new Error('Cached transparent image did not contain alpha');
    assertCutoutQuality(cachedQuality);
    logIsolation('cache hit', {
      outputPath: storedPath,
      outputWidth: cachedMeta.width,
      outputHeight: cachedMeta.height,
      outputMimeType: 'image/png',
      alphaDetected: cachedAlpha.hasTransparentPixels,
      quality: cachedQuality
    });
    return {
      cached: true,
      image: {
        filename,
        path: storedPath,
        url: useBunny() ? publicUrlForPath(storedPath) : undefined,
        storage: useBunny() ? 'bunny' : 'local',
        mimetype: 'image/png',
        size: cachedBytes.length
      },
      metadata: {
        sourceImageUrl: source.sourceImageUrl,
        transparentImageUrl: publicUrlForPath(storedPath),
        processingStatus: 'completed',
        processingProvider: provider,
        processingVersion: PROCESSING_VERSION,
        processedAt: startedAt,
        sourceWidth: sourceMeta.width,
        sourceHeight: sourceMeta.height,
        transparentWidth: cachedMeta.width,
        transparentHeight: cachedMeta.height,
        processingError: '',
        cached: true,
        segmentationModel: settings.models?.[0] || '',
        inferenceResolution: `${settings.inferenceLongSide}px long side`,
        foregroundAreaRatio: cachedQuality.foregroundAreaRatio,
        connectedComponents: cachedQuality.connectedComponents,
        torsoCoverage: cachedQuality.torsoCoverage,
        footCoverage: cachedQuality.footCoverage,
        headCoverage: cachedQuality.headCoverage,
        armCoverage: cachedQuality.armCoverage,
        legCoverage: cachedQuality.legCoverage,
        internalHoleRatio: cachedQuality.internalHoleRatio,
        largestInternalHoleRatio: cachedQuality.largestInternalHoleRatio,
        edgeNoiseRatio: cachedQuality.edgeNoiseRatio,
        qualityScore: cachedQuality.score,
        qualityPassed: cachedQuality.passed,
        qualityReasons: cachedQuality.reasons || [],
        retryModelUsed: '',
        debugMaskPreview: debugMaskPreviewFor(debugFolder)
      }
    };
  } catch {
    // Cache miss; continue into processing.
  }

  try {
    const result = await removeBackground({
      imageBuffer: source.bytes,
      mimeType: storedImage?.mimetype || '',
      debugDir: debugAbsoluteDir
    });
    const written = await saveBuffer({
      key: storedPath,
      buffer: result.outputBuffer,
      mimetype: result.mimeType,
      filename
    });
    logIsolation('storage write completed', {
      outputPath: storedPath,
      bytes: written.size,
      finalTransparentUrl: publicUrlForStoredFile(written)
    });
    return {
      cached: false,
      image: {
        ...written
      },
      metadata: {
        sourceImageUrl: source.sourceImageUrl,
        transparentImageUrl: publicUrlForStoredFile(written),
        processingStatus: 'completed',
        processingProvider: result.provider,
        processingVersion: PROCESSING_VERSION,
        processedAt: startedAt,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
        transparentWidth: result.width,
        transparentHeight: result.height,
        processingError: '',
        cached: false,
        segmentationModel: result.model || '',
        segmentationModelsUsed: result.modelsUsed || [],
        failedSegmentationModels: result.failedModels || [],
        inferenceResolution: result.inferenceResolution
          ? `${result.inferenceResolution.width}x${result.inferenceResolution.height}${result.inferenceResolution.scaled ? ' scaled' : ''}`
          : `${settings.inferenceLongSide}px long side`,
        maskSettings: result.maskSettings || settings,
        repairedPixels: result.repairedPixels || 0,
        foregroundAreaRatio: result.quality?.foregroundAreaRatio ?? 0,
        connectedComponents: result.quality?.connectedComponents ?? 0,
        torsoCoverage: result.quality?.torsoCoverage ?? 0,
        footCoverage: result.quality?.footCoverage ?? 0,
        headCoverage: result.quality?.headCoverage ?? 0,
        armCoverage: result.quality?.armCoverage ?? 0,
        legCoverage: result.quality?.legCoverage ?? 0,
        internalHoleRatio: result.quality?.internalHoleRatio ?? 0,
        largestInternalHoleRatio: result.quality?.largestInternalHoleRatio ?? 0,
        edgeNoiseRatio: result.quality?.edgeNoiseRatio ?? 0,
        qualityScore: result.quality?.score ?? 0,
        qualityPassed: Boolean(result.quality?.passed),
        qualityReasons: result.quality?.reasons || [],
        retryModelUsed: result.modelsUsed?.slice(1).join(', ') || '',
        debugMaskPreview: debugMaskPreviewFor(debugFolder)
      }
    };
  } catch (error) {
    logIsolation('processing failed', {
      sourceImageUrl: shortSourceUrl(source.sourceImageUrl),
      provider,
      error: error?.message || 'Subject isolation failed'
    });
    return {
      cached: false,
      image: null,
      metadata: {
        sourceImageUrl: source.sourceImageUrl,
        transparentImageUrl: '',
        processingStatus: 'failed',
        processingProvider: provider,
        processingVersion: PROCESSING_VERSION,
        processedAt: startedAt,
        sourceWidth: sourceMeta.width,
        sourceHeight: sourceMeta.height,
        transparentWidth: 0,
        transparentHeight: 0,
        processingError: error?.message || 'Subject isolation failed',
        cached: false,
        segmentationModel: settings.models?.[0] || '',
        segmentationModelsUsed: [],
        failedSegmentationModels: [],
        inferenceResolution: `${settings.inferenceLongSide}px long side`,
        maskSettings: settings,
        foregroundAreaRatio: 0,
        connectedComponents: 0,
        torsoCoverage: 0,
        footCoverage: 0,
        headCoverage: 0,
        armCoverage: 0,
        legCoverage: 0,
        internalHoleRatio: 0,
        largestInternalHoleRatio: 0,
        edgeNoiseRatio: 0,
        qualityScore: 0,
        qualityPassed: false,
        qualityReasons: [error?.message || 'Subject isolation failed'],
        retryModelUsed: '',
        debugMaskPreview: debugMaskPreviewFor(debugFolder)
      }
    };
  }
}

export { alphaBoundsFromRaw, PROCESSING_VERSION };
export { alphaStatsForBuffer, analyzeCutoutQuality, hasUsableTransparency };
