import express from 'express';
import heicConvert from 'heic-convert';
import multer from 'multer';
import path from 'node:path';
import sharp from 'sharp';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CreditEvent from '../models/CreditEvent.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { effectiveDevMode } from '../utils/devMode.js';
import { documentId, mediaTokenFromRequest, verifyMediaAccess } from '../utils/mediaAccess.js';
import { deleteStoredFile, isStorageConfigurationError, readStoredFile, saveStoredFile } from '../utils/storage.js';

const router = express.Router();
const imageMimeTypes = new Set(['image/avif', 'image/x-avif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, isAllowedImageUpload(file))
});

const categoryKeywords = [
  ['dresses', ['dress', 'gown', 'frock', 'onepiece', 'one piece']],
  ['suits', ['suit', 'blazer set', 'co-ord', 'coord', 'tuxedo', 'sherwani']],
  ['bottoms', ['pant', 'pants', 'trouser', 'jean', 'denim', 'short', 'skirt', 'legging', 'palazzo']],
  ['tops', ['shirt', 'tshirt', 't-shirt', 'tee', 'top', 'kurti', 'blouse', 'hoodie', 'sweater', 'polo']],
  ['outerwear', ['jacket', 'coat', 'blazer', 'cardigan', 'shrug']],
  ['shoes', ['shoe', 'sneaker', 'boot', 'loafer', 'heel', 'sandal', 'slipper']],
  ['accessories', ['watch', 'bag', 'belt', 'cap', 'hat', 'sunglass', 'necklace', 'scarf', 'tie']],
  ['activewear', ['gym', 'track', 'jersey', 'sports', 'active']],
  ['ethnic', ['saree', 'lehenga', 'kurta', 'dupatta', 'ethnic']]
];

const colors = ['black', 'white', 'cream', 'beige', 'brown', 'tan', 'grey', 'gray', 'blue', 'navy', 'green', 'olive', 'red', 'pink', 'purple', 'yellow', 'orange', 'maroon', 'gold', 'silver'];
const formalWords = ['office', 'work', 'formal', 'interview', 'meeting', 'business'];
const partyWords = ['party', 'date', 'wedding', 'function', 'celebration', 'night'];
const activeWords = ['gym', 'run', 'sports', 'walk', 'training'];
function isAllowedImageUpload(file) {
  const type = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  return type.startsWith('image/') || imageMimeTypes.has(type) || /\.(avif|heic|heif)$/i.test(name);
}

function extensionFor(mimetype) {
  if (mimetype?.includes('png')) return '.png';
  if (mimetype?.includes('webp')) return '.webp';
  if (mimetype?.includes('gif')) return '.gif';
  return '.jpg';
}

function cleanWord(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function titleCase(value = '') {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function cleanList(value, limit = 12) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((item) => cleanWord(item).toLowerCase()).filter(Boolean))].slice(0, limit);
}

function envFlag(value, defaultValue = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function cleanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function normalizeCategory(value, sourceText = '') {
  const given = cleanWord(value).toLowerCase();
  const known = categoryKeywords.map(([category]) => category);
  if (known.includes(given)) return given;
  const haystack = `${given} ${sourceText}`.toLowerCase();
  const match = categoryKeywords.find(([, words]) => words.some((word) => haystack.includes(word)));
  return match?.[0] || 'other';
}

function inferColor(value, sourceText = '') {
  const given = cleanWord(value).toLowerCase();
  if (given) return given;
  const haystack = sourceText.toLowerCase();
  return colors.find((color) => haystack.includes(color)) || '';
}

function inferFormality(value, sourceText = '') {
  const given = cleanWord(value).toLowerCase();
  if (['casual', 'smart-casual', 'formal', 'party', 'active', 'any'].includes(given)) return given;
  const haystack = sourceText.toLowerCase();
  if (formalWords.some((word) => haystack.includes(word))) return 'formal';
  if (partyWords.some((word) => haystack.includes(word))) return 'party';
  if (activeWords.some((word) => haystack.includes(word))) return 'active';
  return 'any';
}

function closetVisionEnabled() {
  return envFlag(process.env.CLOSET_VISION_ANALYSIS, true) && Boolean(process.env.FAL_KEY);
}

function closetVisionEndpoint() {
  return String(process.env.FAL_CLOSET_VISION_ENDPOINT || 'openrouter/router/vision').replace(/^\/+|\/+$/g, '');
}

function closetVisionModel() {
  return process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash-lite';
}

function falHeaders() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is missing on the server');
  return {
    Authorization: `Key ${process.env.FAL_KEY}`,
    'Content-Type': 'application/json'
  };
}

function flattenText(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  for (const key of ['output_text', 'text', 'content', 'message', 'response']) {
    const found = flattenText(value[key], depth + 1);
    if (found) return found;
  }
  if (value.choices) return flattenText(value.choices, depth + 1);
  if (value.output) return flattenText(value.output, depth + 1);
  return Object.values(value).map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
}

function parseJsonFromText(value = '') {
  const cleaned = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Vision response did not include JSON');
  }
}

function normalizeDetectedFields(value = {}, fallback = {}) {
  const sourceText = [
    value.name,
    value.category,
    value.type,
    value.color,
    value.tags,
    fallback.sourceText
  ].filter(Boolean).join(' ');
  const category = normalizeCategory(value.category || value.type || fallback.category, sourceText);
  const color = inferColor(value.color || value.primaryColor || fallback.color, sourceText);
  return {
    name: cleanWord(value.name || value.itemName || fallback.name || `${titleCase(category).replace(/s$/, '')} item`, 'Closet item'),
    category,
    color,
    fabric: cleanWord(value.fabric || value.material || fallback.fabric),
    pattern: cleanWord(value.pattern || fallback.pattern),
    season: cleanWord(value.season || fallback.season || 'all-season').toLowerCase(),
    formality: inferFormality(value.formality || value.vibe || fallback.formality, sourceText),
    occasions: cleanList(value.occasions || value.occasion || fallback.occasions, 6),
    tags: cleanList(value.tags || fallback.tags, 8)
  };
}

async function analyzeClosetItemWithVision(file, sourceText = '', timer) {
  const imageBuffer = await sharp(file.buffer)
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const imageDataUri = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  const prompt = [
    'You are Lookmefy wardrobe item detection.',
    'Analyze only the clothing/accessory item in the image.',
    'Return strict JSON only with keys: name, category, color, fabric, pattern, season, formality, occasions, tags, confidence.',
    'Allowed category values: tops, bottoms, dresses, suits, outerwear, shoes, accessories, activewear, ethnic, other.',
    'Allowed formality values: casual, smart-casual, formal, party, active, any.',
    'Use short ecommerce-friendly values. If unsure, use empty string or other.',
    sourceText ? `Manual hint: ${sourceText}` : ''
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CLOSET_VISION_TIMEOUT_MS || 20_000));
  try {
    const response = await fetch(`https://fal.run/${closetVisionEndpoint()}`, {
      method: 'POST',
      headers: falHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model: closetVisionModel(),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUri } }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readableError(data.error || data.detail || data.message || data, 'Vision analysis failed'));
    timer?.mark('vision analysis complete');
    const parsed = parseJsonFromText(flattenText(data));
    return {
      fields: normalizeDetectedFields(parsed, { sourceText }),
      confidence: Number(parsed.confidence) || 0.72,
      raw: parsed
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function detectClosetItem(file, sourceText = '', timer) {
  if (!closetVisionEnabled()) {
    const disabled = ['0', 'false', 'no', 'off'].includes(String(process.env.CLOSET_VISION_ANALYSIS ?? '').toLowerCase());
    throw Object.assign(
      new Error(disabled ? 'AI item detection is disabled on the server.' : 'AI item detection needs FAL_KEY on the server.'),
      { statusCode: 503 }
    );
  }

  try {
    const vision = await analyzeClosetItemWithVision(file, sourceText, timer);
    return {
      source: 'vision',
      confidence: Math.max(0.5, Math.min(Number(vision.confidence) || 0.72, 0.98)),
      message: 'Detected by AI. Review and edit before saving.',
      fields: normalizeDetectedFields(vision.fields, { sourceText })
    };
  } catch (error) {
    timer?.mark('vision analysis failed', { error: readableError(error) });
    throw Object.assign(error, { statusCode: error.statusCode || 503 });
  }
}

function tokenCost() {
  const value = Number(process.env.TRYON_TOKEN_COST || 1);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

function chargedTokenCost(user) {
  return effectiveDevMode(user) ? 0 : tokenCost();
}

async function recordCreditEvent({ user, action, tokens, balanceAfter, metadata = {} }) {
  try {
    return await CreditEvent.create({
      user: user._id,
      action,
      productTitle: 'Wardrobe',
      tokens: Number(tokens) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      metadata
    });
  } catch (error) {
    console.error('[credit-history] could not record closet event', { error: error.message });
    return null;
  }
}

function fitRoomHeaders() {
  if (!process.env.FITROOM_API_KEY) throw new Error('FITROOM_API_KEY is missing on the server');
  return { 'X-API-KEY': process.env.FITROOM_API_KEY };
}

function fitRoomBaseUrl() {
  return (process.env.FITROOM_BASE_URL || 'https://platform.fitroom.app').replace(/\/+$/, '');
}

function fitRoomHdMode() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.FITROOM_HD_MODE || '').toLowerCase());
}

function readableError(value, fallback = 'Request failed') {
  if (!value) return fallback;
  if (value instanceof Error) return readableError(value.message, fallback);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => readableError(item, fallback)).filter(Boolean).join(' ') || fallback;
  if (typeof value === 'object') {
    const nested = value.message || value.detail || value.error || value.errors;
    if (nested && nested !== value) return readableError(nested, fallback);
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

function isImageDecodeError(error) {
  return /(heic|heif|avif|unsupported image|invalid input|corrupt header|security limit|input buffer)/i.test(readableError(error, ''));
}

function isHeicUpload(file) {
  const type = String(file?.mimetype || '').toLowerCase();
  const name = String(file?.originalname || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(name);
}

function createTimer(label, meta = {}) {
  const start = performance.now();
  let last = start;
  console.log(`[closet:${label}] start`, meta);
  return {
    mark(step, extra = {}) {
      const now = performance.now();
      console.log(`[closet:${label}] ${step}`, {
        stepMs: Math.round(now - last),
        totalMs: Math.round(now - start),
        ...extra
      });
      last = now;
    },
    end(extra = {}) {
      console.log(`[closet:${label}] done`, { totalMs: Math.round(performance.now() - start), ...extra });
    }
  };
}

function ensureTryOnProfileReady(user) {
  const status = user?.bodyPhoto?.status || 'ready';
  if (status === 'generating') throw new Error('Your full-body try-on profile is still preparing. Try again in a minute.');
  if (status === 'failed') throw new Error('Your full-body try-on profile failed. Upload a clearer profile photo first.');
  if (!user?.bodyPhoto?.path) throw new Error('Upload a try-on profile photo before generating closet looks.');
}

async function normalizeUpload(file, label, timer) {
  if (!file?.buffer) throw new Error(`${label} image is missing`);
  try {
    const output = await sharp(file.buffer).rotate().jpeg({ quality: 90 }).toBuffer();
    timer?.mark(`${label} normalized`, { inputKb: Math.round(file.buffer.length / 1024), outputKb: Math.round(output.length / 1024) });
    return {
      buffer: output,
      mimetype: 'image/jpeg',
      originalname: `${path.parse(file.originalname || label).name || label}.jpg`,
      size: output.length
    };
  } catch (error) {
    if (isHeicUpload(file)) {
      try {
        const converted = await heicConvert({ buffer: file.buffer, format: 'JPEG', quality: 0.9 });
        const output = await sharp(Buffer.from(converted)).rotate().jpeg({ quality: 90 }).toBuffer();
        timer?.mark(`${label} heic converted`, { inputKb: Math.round(file.buffer.length / 1024), outputKb: Math.round(output.length / 1024) });
        return {
          buffer: output,
          mimetype: 'image/jpeg',
          originalname: `${path.parse(file.originalname || label).name || label}.jpg`,
          size: output.length
        };
      } catch (conversionError) {
        timer?.mark(`${label} heic conversion failed`, { error: readableError(conversionError) });
      }
    }
    if (isImageDecodeError(error)) {
      throw new Error(`This ${label} photo cannot be processed. Please upload a JPG, PNG, or WebP image. If it came from an iPhone, switch Camera Format to Most Compatible or export the photo as JPG first.`);
    }
    throw error;
  }
}

async function saveUploadFile(file, prefix, user, folder = 'closet') {
  const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(file.mimetype)}`;
  return saveStoredFile({
    buffer: file.buffer,
    filename,
    mimetype: file.mimetype,
    userId: user._id.toString(),
    folder,
    prefix
  });
}

async function filePartFromStoredImage(image, label, timer) {
  if (!image?.path) throw new Error(`${label} image is missing`);
  const { bytes } = await readStoredFile(image);
  const normalized = await sharp(bytes).rotate().jpeg({ quality: 90 }).toBuffer();
  timer?.mark(`${label} file prepared`, { kb: Math.round(normalized.length / 1024) });
  return {
    bytes: normalized,
    mimetype: 'image/jpeg',
    filename: `${path.parse(image.filename || label).name || label}.jpg`
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
  if (!response.ok) throw new Error(readableError(data.error || data.message || data, 'FitRoom request failed'));
  return data;
}

async function waitForFitRoomTask(taskId, timer) {
  const maxAttempts = Number(process.env.FITROOM_POLL_ATTEMPTS || 80);
  const pollMs = Number(process.env.FITROOM_POLL_MS || 1500);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await fitRoomJson(`/api/tryon/v2/tasks/${encodeURIComponent(taskId)}`);
    if (attempt === 0 || attempt % 5 === 0 || status.status === 'COMPLETED') timer?.mark('fitroom status poll', { attempt, status: status.status, progress: status.progress });
    if (status.status === 'COMPLETED') {
      if (!status.download_signed_url) throw new Error('FitRoom completed without a download URL');
      return status;
    }
    if (status.status === 'FAILED') throw new Error(readableError(status.error || status, 'FitRoom outfit generation failed'));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`FitRoom outfit generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
}

async function generatedBytesFromUrl(url, timer) {
  const response = await fetch(url, {
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy closet generated image fetcher'
    }
  });
  if (!response.ok) throw new Error('Could not download generated closet outfit');
  const bytes = Buffer.from(await response.arrayBuffer());
  const mimetype = (response.headers.get('content-type') || '').split(';')[0] || 'image/jpeg';
  timer?.mark('generated image downloaded', { kb: Math.round(bytes.length / 1024), mimetype });
  return { bytes, mimetype };
}

async function combinedGarmentFromItems(items, timer) {
  if (items.length === 1) return filePartFromStoredImage(items[0].image, 'closet item', timer);

  const width = 1024;
  const height = 1280;
  const slots = items.slice(0, 5);
  const slotHeight = Math.floor(height / slots.length);
  const composites = [];
  for (let index = 0; index < slots.length; index += 1) {
    const item = slots[index];
    const { bytes } = await readStoredFile(item.image);
    const thumb = await sharp(bytes)
      .rotate()
      .resize({ width: 820, height: Math.max(160, slotHeight - 44), fit: 'contain', background: '#fffdf8' })
      .jpeg({ quality: 92 })
      .toBuffer();
    composites.push({ input: thumb, top: index * slotHeight + 22, left: 102 });
  }

  const canvas = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#fffdf8'
    }
  })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();

  timer?.mark('closet combo image composed', { itemCount: slots.length, kb: Math.round(canvas.length / 1024) });
  return { bytes: canvas, mimetype: 'image/jpeg', filename: `closet-combo-${Date.now()}.jpg` };
}

async function callFitRoomTryOn({ user, garment, timer }) {
  const person = await filePartFromStoredImage(user.bodyPhoto, 'person', timer);
  const form = new FormData();
  appendFilePart(form, 'model_image', person);
  appendFilePart(form, 'cloth_image', garment);
  form.append('cloth_type', 'full_set');
  if (fitRoomHdMode()) form.append('hd_mode', 'true');

  const submission = await fitRoomJson('/api/tryon/v2/tasks', { method: 'POST', body: form });
  if (!submission.task_id) throw new Error('FitRoom did not return a task id');
  timer?.mark('fitroom task submitted', { taskId: submission.task_id, status: submission.status });
  const result = await waitForFitRoomTask(submission.task_id, timer);
  return generatedBytesFromUrl(result.download_signed_url, timer);
}

async function reserveToken(user, timer) {
  if (effectiveDevMode(user)) {
    timer.mark('dev mode token bypass', { cost: 0, tokensRemaining: user.tokens });
    return user;
  }
  const cost = tokenCost();
  const chargedUser = await User.findOneAndUpdate({ _id: user._id, tokens: { $gte: cost } }, { $inc: { tokens: -cost } }, { new: true });
  if (chargedUser) timer.mark('token reserved', { cost, tokensRemaining: chargedUser.tokens });
  return chargedUser;
}

async function refundToken(user, timer) {
  if (effectiveDevMode(user)) return user;
  const refundedUser = await User.findByIdAndUpdate(user._id, { $inc: { tokens: tokenCost() } }, { new: true });
  if (refundedUser) timer.mark('token refunded', { tokensRemaining: refundedUser.tokens });
  return refundedUser || user;
}

function itemToClient(item) {
  return typeof item.toClient === 'function' ? item.toClient() : new ClosetItem(item).toClient();
}

function outfitToClient(outfit, items = []) {
  const itemsById = new Map(items.map((item) => [item._id.toString(), itemToClient(item)]));
  return typeof outfit.toClient === 'function' ? outfit.toClient(itemsById) : new ClosetOutfit(outfit).toClient(itemsById);
}

async function closetMediaRecord(kind, id) {
  if (kind === 'item') {
    const record = await ClosetItem.findById(id).select('image user').lean();
    return record ? { record, file: record.image } : null;
  }
  if (kind === 'outfit') {
    const record = await ClosetOutfit.findById(id).select('image user').lean();
    return record ? { record, file: record.image } : null;
  }
  if (kind === 'garment') {
    const record = await ClosetOutfit.findById(id).select('garment user').lean();
    return record ? { record, file: record.garment } : null;
  }
  return null;
}

router.get('/media/:kind/:id', async (req, res) => {
  try {
    const kind = String(req.params.kind || '').toLowerCase();
    const access = verifyMediaAccess(mediaTokenFromRequest(req), {
      scope: 'closet',
      id: req.params.id,
      kind,
      field: kind
    });
    if (!access) return res.status(401).json({ message: 'Closet media link expired' });

    const result = await closetMediaRecord(kind, req.params.id);
    if (!result || documentId(result.record.user) !== access.userId) return res.status(404).json({ message: 'Closet media not found' });
    if (!result.file?.path && !result.file?.url) return res.status(404).json({ message: 'Closet media not found' });

    const stored = await readStoredFile(result.file);
    res.set({
      'Content-Type': stored.mimetype || result.file.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.bytes);
  } catch {
    return res.status(404).json({ message: 'Closet media not found' });
  }
});

function closetStats(items) {
  const byCategory = {};
  const colorsOwned = new Set();
  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    if (item.color) colorsOwned.add(item.color);
  }
  return {
    total: items.length,
    favorites: items.filter((item) => item.favorite).length,
    generatedLooks: 0,
    byCategory,
    colors: [...colorsOwned].slice(0, 12)
  };
}

function scoreItem(item, context) {
  const text = `${context.occasion} ${context.weather} ${context.mood}`.toLowerCase();
  let score = item.favorite ? 3 : 0;
  if (item.occasions?.some((occasion) => text.includes(occasion))) score += 5;
  if (item.tags?.some((tag) => text.includes(tag))) score += 3;
  if (text.includes(item.formality)) score += 3;
  if (/rain|cold|winter|chill/i.test(text) && ['outerwear', 'shoes'].includes(item.category)) score += 3;
  if (/hot|summer|sun/i.test(text) && ['tops', 'dresses'].includes(item.category)) score += 2;
  if (!item.lastWornAt) score += 1;
  return score;
}

function bestByCategory(items, categories, context) {
  return categories
    .map((category) => items.filter((item) => item.category === category).sort((a, b) => scoreItem(b, context) - scoreItem(a, context) || new Date(b.updatedAt) - new Date(a.updatedAt))[0])
    .filter(Boolean);
}

function buildSuggestions(items, context = {}) {
  const source = [...items];
  if (!source.length) return [];
  const base = cleanWord(`${context.occasion || 'today'} ${context.weather || ''} ${context.mood || ''}`, 'today');
  const suggestions = [];
  const add = (title, cats, reason) => {
    const selected = bestByCategory(source, cats, context);
    if (selected.length >= Math.min(2, cats.length)) {
      const key = selected.map((item) => item._id.toString()).sort().join(':');
      if (!suggestions.some((suggestion) => suggestion.key === key)) {
        suggestions.push({
          key,
          title,
          reason,
          itemIds: selected.map((item) => item._id.toString()),
          items: selected.map(itemToClient)
        });
      }
    }
  };

  add(`Best for ${base}`, ['tops', 'bottoms', 'shoes', 'outerwear'], 'Balanced color/formality match from your closet.');
  add('One-piece easy win', ['dresses', 'shoes', 'outerwear'], 'Fast outfit with fewer decisions and a polished silhouette.');
  add('Formal-ready combo', ['suits', 'tops', 'shoes', 'accessories'], 'Cleaner structure for office, meetings, interviews, or events.');
  add('Relaxed daily fit', ['tops', 'bottoms', 'shoes', 'accessories'], 'Comfort-first combination using versatile pieces.');
  add('Ethnic occasion look', ['ethnic', 'bottoms', 'shoes', 'accessories'], 'Good for festive, family, or traditional occasions.');

  return suggestions.slice(0, 5);
}

function fallbackStylistReply(message, items, suggestions) {
  const selected = suggestions[0];
  if (!items.length) return 'Upload a few closet items first, then I can suggest real combinations from your wardrobe.';
  if (!selected) return 'I need at least two matching closet items to make a strong outfit. Add a top and bottom, or a dress/suit plus shoes.';
  const names = selected.items.map((item) => item.name).join(', ');
  return `Wear ${names}. ${selected.reason} If you want the preview, select this combo and generate it on your profile.`;
}

async function openAiStylistReply(message, items, suggestions) {
  if (!process.env.OPENAI_API_KEY) return '';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_STYLIST_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: 'You are Lookmefy stylist AI. Recommend outfits only from the user closet data. Be concise, practical, and mention exact item names.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: message,
            closet: items.map(({ name, category, color, fabric, formality, occasions, tags }) => ({ name, category, color, fabric, formality, occasions, tags })).slice(0, 80),
            suggestions: suggestions.map(({ title, reason, items: suggestionItems }) => ({ title, reason, items: suggestionItems.map((item) => item.name) }))
          })
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.message || data, 'AI stylist request failed'));
  return data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text).filter(Boolean).join('\n') || '';
}

router.get('/', requireUser, async (req, res) => {
  const items = await ClosetItem.find({ user: req.user._id }).sort({ favorite: -1, updatedAt: -1 });
  const outfits = await ClosetOutfit.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(24);
  const stats = closetStats(items);
  stats.generatedLooks = outfits.length;
  res.json({
    items: items.map(itemToClient),
    outfits: outfits.map((outfit) => outfitToClient(outfit, items)),
    stats,
    suggestions: buildSuggestions(items, { occasion: 'today' })
  });
});

router.post('/items/analyze', requireUser, upload.single('item'), async (req, res) => {
  const timer = createTimer('analyze-item', { userId: req.user._id.toString() });
  try {
    if (!req.file) return res.status(400).json({ message: 'Upload a clothing image first' });
    const normalized = await normalizeUpload(req.file, 'closet item', timer);
    const sourceText = `${req.body?.name || ''} ${req.body?.tags || ''}`;
    const detection = await detectClosetItem(normalized, sourceText, timer);
    timer.end({ source: detection.source, confidence: detection.confidence });
    res.json({ detection });
  } catch (error) {
    const message = readableError(error, 'Could not analyze closet item');
    timer.end({ error: message });
    res.status(error.statusCode || 400).json({ message });
  }
});

router.post('/items', requireUser, upload.single('item'), async (req, res) => {
  const timer = createTimer('upload-item', { userId: req.user._id.toString() });
  try {
    if (!req.file) return res.status(400).json({ message: 'Upload a clothing image first' });
    const normalized = await normalizeUpload(req.file, 'closet item', timer);
    const sourceText = `${req.file.originalname || ''} ${req.body?.name || ''} ${req.body?.tags || ''}`;
    const image = await saveUploadFile(normalized, 'closet-item', req.user, 'closet');
    const item = await ClosetItem.create({
      user: req.user._id,
      name: cleanWord(req.body?.name, path.parse(req.file.originalname || 'Closet item').name || 'Closet item'),
      category: normalizeCategory(req.body?.category, sourceText),
      color: inferColor(req.body?.color, sourceText),
      fabric: cleanWord(req.body?.fabric),
      pattern: cleanWord(req.body?.pattern),
      season: cleanWord(req.body?.season, 'all-season').toLowerCase(),
      formality: inferFormality(req.body?.formality, sourceText),
      occasions: cleanList(req.body?.occasions),
      tags: cleanList(req.body?.tags),
      favorite: ['1', 'true', 'yes', 'on'].includes(String(req.body?.favorite || '').toLowerCase()),
      image
    });
    timer.end({ itemId: item._id.toString() });
    res.status(201).json({ item: item.toClient() });
  } catch (error) {
    const message = readableError(error, 'Could not save closet item');
    timer.end({ error: message });
    res.status(isStorageConfigurationError(error) ? error.statusCode || 503 : 400).json({ message });
  }
});

router.patch('/items/:id', requireUser, async (req, res) => {
  const updates = {};
  for (const key of ['name', 'color', 'fabric', 'pattern', 'season']) {
    if (req.body?.[key] !== undefined) updates[key] = cleanWord(req.body[key]);
  }
  if (req.body?.category !== undefined) updates.category = normalizeCategory(req.body.category);
  if (req.body?.formality !== undefined) updates.formality = inferFormality(req.body.formality);
  if (req.body?.occasions !== undefined) updates.occasions = cleanList(req.body.occasions);
  if (req.body?.tags !== undefined) updates.tags = cleanList(req.body.tags);
  if (req.body?.favorite !== undefined) updates.favorite = ['1', 'true', 'yes', 'on'].includes(String(req.body.favorite || '').toLowerCase());
  const item = await ClosetItem.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: updates }, { new: true });
  if (!item) return res.status(404).json({ message: 'Closet item not found' });
  res.json({ item: item.toClient() });
});

router.delete('/items/:id', requireUser, async (req, res) => {
  const item = await ClosetItem.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!item) return res.status(404).json({ message: 'Closet item not found' });
  if (item.image?.path) deleteStoredFile(item.image).catch(() => {});
  res.json({ ok: true });
});

router.post('/suggest', requireUser, async (req, res) => {
  const items = await ClosetItem.find({ user: req.user._id }).sort({ favorite: -1, updatedAt: -1 });
  const context = {
    occasion: cleanWord(req.body?.occasion, 'today'),
    weather: cleanWord(req.body?.weather),
    mood: cleanWord(req.body?.mood)
  };
  res.json({ suggestions: buildSuggestions(items, context) });
});

router.post('/chat', requireUser, async (req, res) => {
  const message = cleanWord(req.body?.message).slice(0, 600);
  if (!message) return res.status(400).json({ message: 'Ask the stylist what you want to wear.' });
  const items = await ClosetItem.find({ user: req.user._id }).sort({ favorite: -1, updatedAt: -1 });
  const context = { occasion: message, weather: message, mood: message };
  const suggestions = buildSuggestions(items, context);
  let reply = '';
  try {
    reply = await openAiStylistReply(message, items, suggestions);
  } catch (error) {
    console.warn('[closet:chat] OpenAI stylist fallback', readableError(error));
  }
  res.json({ reply: reply || fallbackStylistReply(message, items, suggestions), suggestions });
});

router.post('/outfits/generate', requireUser, async (req, res) => {
  const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 5);
  const timer = createTimer('generate-outfit', { userId: req.user._id.toString(), itemCount: itemIds.length });
  let reserved = false;
  try {
    if (!itemIds.length) return res.status(400).json({ message: 'Select at least one closet item.' });
    ensureTryOnProfileReady(req.user);
    const items = await ClosetItem.find({ user: req.user._id, _id: { $in: itemIds } });
    if (items.length !== itemIds.length) return res.status(404).json({ message: 'One or more closet items were not found.' });
    const chargedUser = await reserveToken(req.user, timer);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      return res.status(402).json({ message: 'Not enough tokens for AI outfit generation' });
    }
    reserved = true;
    req.user = chargedUser;

    const garment = await combinedGarmentFromItems(items, timer);
    const generated = await callFitRoomTryOn({ user: req.user, garment, timer });
    const garmentFile = await saveUploadFile({ buffer: garment.bytes, mimetype: garment.mimetype, size: garment.bytes.length }, 'closet-combo', req.user, 'closet-outfits');
    const imageFile = await saveUploadFile({ buffer: generated.bytes, mimetype: generated.mimetype, size: generated.bytes.length }, 'closet-outfit', req.user, 'closet-outfits');
    const outfit = await ClosetOutfit.create({
      user: req.user._id,
      title: cleanWord(req.body?.title, `Closet look for ${cleanWord(req.body?.occasion, 'today')}`),
      occasion: cleanWord(req.body?.occasion),
      weather: cleanWord(req.body?.weather),
      mood: cleanWord(req.body?.mood),
      backdrop: cleanWord(req.body?.backdrop),
      pose: cleanWord(req.body?.pose),
      lighting: cleanWord(req.body?.lighting),
      notes: cleanWord(req.body?.notes).slice(0, 500),
      plannedFor: cleanDate(req.body?.plannedFor),
      itemIds: items.map((item) => item._id),
      provider: 'fitroom',
      model: 'fitroom/tryon-v2',
      quality: fitRoomHdMode() ? 'hd' : 'standard',
      tokenCost: chargedTokenCost(req.user),
      garment: garmentFile,
      image: imageFile
    });
    await recordCreditEvent({
      user: req.user,
      action: 'Wardrobe outfit',
      tokens: chargedTokenCost(req.user),
      balanceAfter: req.user.tokens,
      metadata: { direction: 'debit', outfitId: outfit._id.toString() }
    });
    timer.end({ outfitId: outfit._id.toString(), tokensRemaining: req.user.tokens });
    res.status(201).json({ outfit: outfitToClient(outfit, items), user: req.user.toClient() });
  } catch (error) {
    if (reserved) req.user = await refundToken(req.user, timer);
    const message = readableError(error, 'Could not generate closet outfit');
    timer.end({ error: message });
    res.status(isStorageConfigurationError(error) ? error.statusCode || 503 : 400).json({ message });
  }
});

router.patch('/outfits/:id', requireUser, async (req, res) => {
  const updates = {};
  if (req.body?.favorite !== undefined) updates.favorite = ['1', 'true', 'yes', 'on'].includes(String(req.body.favorite || '').toLowerCase());
  if (req.body?.title !== undefined) updates.title = cleanWord(req.body.title, 'Generated outfit');
  if (req.body?.plannedFor !== undefined) updates.plannedFor = cleanDate(req.body.plannedFor);
  const outfit = await ClosetOutfit.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: updates }, { new: true });
  if (!outfit) return res.status(404).json({ message: 'Closet outfit not found' });
  const items = await ClosetItem.find({ user: req.user._id, _id: { $in: outfit.itemIds } });
  res.json({ outfit: outfitToClient(outfit, items) });
});

export default router;
