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
import { callPrunaTryOn } from './tryons.js';
import { effectiveDevMode } from '../utils/devMode.js';
import { inlineOrQueue, registerJobHandler } from '../utils/jobs.js';
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
const focusedSingleTryOnSlots = new Set(['footwear', 'goggles', 'watch', 'cap', 'accessories']);
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

const closetTryOnSlotOrder = new Map([
  ['topwear', 10],
  ['upper', 10],
  ['dresses', 12],
  ['suits', 12],
  ['outerwear', 14],
  ['bottomwear', 20],
  ['lower', 20],
  ['footwear', 30],
  ['feet', 30],
  ['goggles', 40],
  ['eyewear', 40],
  ['watch', 42],
  ['wristwear', 42],
  ['cap', 45],
  ['headwear', 45],
  ['accessories', 50]
]);

const closetTryOnCategoryOrder = new Map([
  ['tops', 10],
  ['dresses', 12],
  ['suits', 12],
  ['outerwear', 14],
  ['activewear', 16],
  ['ethnic', 18],
  ['bottoms', 20],
  ['shoes', 30],
  ['accessories', 40],
  ['other', 90]
]);

function normalizeTryOnSlot(value = '') {
  const normalized = cleanWord(value).toLowerCase().replace(/[\s_]+/g, '-');
  if (/top|shirt|upper|dress|suit|ethnic|active/.test(normalized)) return 'topwear';
  if (/outer|jacket|coat|blazer/.test(normalized)) return 'outerwear';
  if (/bottom|pant|trouser|jean|lower/.test(normalized)) return 'bottomwear';
  if (/shoe|foot|sneaker|boot|loafer|heel/.test(normalized)) return 'footwear';
  if (/glass|goggle|eyewear|sun/.test(normalized)) return 'goggles';
  if (/watch|wrist/.test(normalized)) return 'watch';
  if (/cap|hat|head/.test(normalized)) return 'cap';
  if (/access/.test(normalized)) return 'accessories';
  return normalized || 'selection';
}

function itemPlacementKey(item, fallbackSlot = '') {
  const category = String(item?.category || '').toLowerCase();
  const text = `${item?.name || ''} ${category} ${item?.tags?.join(' ') || ''}`.toLowerCase();
  if (category === 'shoes') return 'footwear';
  if (category === 'bottoms') return 'bottomwear';
  if (category === 'outerwear') return 'outerwear';
  if (category === 'accessories') {
    if (/\b(watches?|wrist\s*watches?|wristwear)\b/.test(text)) return 'watch';
    if (/\b(glasses?|goggles?|sunglasses?|eyewear|spectacles?)\b/.test(text)) return 'goggles';
    if (/\b(caps?|hats?|headwear)\b/.test(text)) return 'cap';
    return 'accessories';
  }
  if (category === 'dresses' || category === 'suits') return category;
  if (['tops', 'activewear', 'ethnic'].includes(category)) return 'topwear';
  return normalizeTryOnSlot(fallbackSlot);
}

function orderedClosetItemsForTryOn(items, itemIds, itemSlots = []) {
  const itemById = new Map(items.map((item) => [item._id.toString(), item]));
  const slotRankById = new Map();
  itemSlots.forEach((entry, index) => {
    const itemId = String(entry?.itemId || entry?.id || '').trim();
    if (!itemId || slotRankById.has(itemId)) return;
    const slot = normalizeTryOnSlot(entry?.slot || entry?.label || '');
    const rank = closetTryOnSlotOrder.get(slot) ?? 80;
    slotRankById.set(itemId, { slot, rank, index });
  });

  return itemIds
    .map((id, index) => {
      const item = itemById.get(id);
      if (!item) return null;
      const explicit = slotRankById.get(id);
      const slot = explicit?.slot || itemPlacementKey(item);
      const rank = explicit?.rank ?? closetTryOnSlotOrder.get(slot) ?? closetTryOnCategoryOrder.get(item.category) ?? 80;
      return { item, slot, rank, index: explicit?.index ?? index };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item, slot }) => {
      item.tryOnSlot = slot;
      return item;
    });
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
        image_urls: [imageDataUri],
        prompt,
        system_prompt: 'Return only strict JSON. Do not include markdown or commentary.',
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

function closetCanvasLayoutForSlot(slot, duplicateIndex = 0) {
  const offset = duplicateIndex * 26;
  if (slot === 'dresses' || slot === 'suits') return { width: 560, height: 760, left: 232 + offset, top: 130 + offset };
  if (slot === 'outerwear') return { width: 560, height: 500, left: 232 + offset, top: 108 + offset };
  if (slot === 'topwear') return { width: 520, height: 430, left: 252 + offset, top: 140 + offset };
  if (slot === 'bottomwear') return { width: 500, height: 430, left: 262 + offset, top: 535 + offset };
  if (slot === 'footwear') return { width: 440, height: 230, left: 292 + offset, top: 1002 + offset };
  if (slot === 'goggles') return { width: 300, height: 180, left: 650 - offset, top: 130 + offset };
  if (slot === 'watch') return { width: 220, height: 220, left: 642 - offset, top: 486 + offset };
  if (slot === 'cap') return { width: 280, height: 190, left: 372 + offset, top: 24 + offset };
  if (slot === 'accessories') return { width: 320, height: 260, left: 650 - offset, top: 360 + offset };
  return { width: 420, height: 300, left: 302 + offset, top: 360 + offset };
}

function shouldComposeSingleClosetItem(item) {
  const slot = itemPlacementKey(item, item?.tryOnSlot);
  return ['footwear', 'goggles', 'watch', 'cap', 'accessories'].includes(slot);
}

function shouldUseFocusedSingleTryOn(items = []) {
  if (items.length !== 1) return false;
  const slot = itemPlacementKey(items[0], items[0]?.tryOnSlot);
  return focusedSingleTryOnSlots.has(slot);
}

function selectedTryOnSlots(items = []) {
  return items.map((item) => itemPlacementKey(item, item?.tryOnSlot));
}

function shouldUseLayeredTryOn(items = []) {
  if (items.length < 2) return false;
  const slots = new Set(selectedTryOnSlots(items));
  return slots.has('topwear') && slots.has('outerwear');
}

function shouldUseSequentialTryOn(items = []) {
  if (items.length < 2) return false;
  const slots = selectedTryOnSlots(items);
  return slots.some((slot) => focusedSingleTryOnSlots.has(slot)) || shouldUseLayeredTryOn(items);
}

function layeredTryOnReferenceItems(items = []) {
  const rank = {
    topwear: 1,
    outerwear: 2,
    dresses: 3,
    suits: 3,
    bottomwear: 4,
    footwear: 5,
    goggles: 6,
    watch: 7,
    cap: 8,
    accessories: 9
  };
  return [...items].sort((a, b) => {
    const slotA = itemPlacementKey(a, a.tryOnSlot);
    const slotB = itemPlacementKey(b, b.tryOnSlot);
    return (rank[slotA] || 20) - (rank[slotB] || 20);
  });
}

function closetItemProductForTryOn(item) {
  const descriptors = [
    item.color,
    item.fabric,
    item.pattern,
    item.formality,
    ...(item.tags || []),
    ...(item.occasions || [])
  ].filter(Boolean);
  return {
    _id: item._id,
    name: item.name,
    productName: item.name,
    brand: 'Lookmefy wardrobe',
    category: item.category,
    description: descriptors.join(' '),
    tags: item.tags || [],
    image: item.image
  };
}

function layeredClosetProductForTryOn(items = []) {
  const itemNames = items.map((item) => cleanWord(item.name, item.category)).filter(Boolean);
  return {
    name: `Layered wardrobe look: ${itemNames.join(' + ')}`,
    productName: `Layered wardrobe look: ${itemNames.join(' + ')}`,
    brand: 'Lookmefy wardrobe',
    category: 'layered tops outerwear outfit',
    description: items.map((item) => `${titleCase(itemPlacementKey(item, item.tryOnSlot))}: ${cleanWord(item.name, item.category)}`).join('; '),
    tags: ['layered outfit', 'topwear', 'outerwear']
  };
}

function layeredClosetPrompt(items = []) {
  const referenceItems = layeredTryOnReferenceItems(items);
  const references = referenceItems
    .map((item, index) => `garment image ${index + 1} is ${cleanWord(item.name, item.category)} (${titleCase(itemPlacementKey(item, item.tryOnSlot))})`)
    .join('; ');
  const topItems = referenceItems.filter((item) => itemPlacementKey(item, item.tryOnSlot) === 'topwear');
  const outerItems = referenceItems.filter((item) => itemPlacementKey(item, item.tryOnSlot) === 'outerwear');
  const topNames = topItems.map((item) => cleanWord(item.name, 'top')).join(', ');
  const outerNames = outerItems.map((item) => cleanWord(item.name, 'outerwear')).join(', ');
  const firstTopIndex = referenceItems.findIndex((item) => itemPlacementKey(item, item.tryOnSlot) === 'topwear') + 1;
  const firstOuterIndex = referenceItems.findIndex((item) => itemPlacementKey(item, item.tryOnSlot) === 'outerwear') + 1;
  return [
    'Generate one realistic full-body fashion try-on image using every selected wardrobe reference.',
    references ? `Reference map: ${references}.` : '',
    `Layering is mandatory: garment image ${firstTopIndex || 1} (${topNames || 'the selected top'}) is the INNER layer and garment image ${firstOuterIndex || 2} (${outerNames || 'the selected jacket or outerwear'}) is the OUTER layer.`,
    'The inner top must be visibly worn under the jacket. Show it at the neckline, chest opening, jacket opening, hem, or sleeves whenever the outerwear allows any opening.',
    'Do not replace the inner top with bare skin, a bra, lingerie, a crop panel, or a random dark fabric. No exposed chest where the T-shirt should be.',
    'Wear the outerwear open or partially open if needed so the selected T-shirt is clearly visible underneath, with natural occlusion, folds, shadows, and correct scale.',
    'Also apply any selected bottoms, footwear, eyewear, watch, bag, or hat in their correct body positions.',
    'Preserve the person, face, hair, skin tone, pose, body shape, hands, background, and lighting as much as possible.',
    'Keep each wardrobe item faithful to its original color, fabric, silhouette, pattern, logos, and details. Do not drop any selected item.'
  ].filter(Boolean).join(' ');
}

async function closetItemGarmentFiles(items = [], timer) {
  return Promise.all(items.slice(0, 5).map(async (item, index) => {
    const file = await filePartFromStoredImage(item.image, `closet item ${index + 1}`, timer);
    const slot = itemPlacementKey(item, item.tryOnSlot);
    return {
      ...file,
      buffer: file.bytes,
      originalname: `${index + 1}-${slot}-${file.filename || 'closet-item.jpg'}`
    };
  }));
}

async function generatedClosetImageBytes(generated, timer) {
  if (generated?.bytes) return { bytes: generated.bytes, mimetype: generated.mimetype || 'image/jpeg' };
  if (generated?.remoteUrl) return generatedBytesFromUrl(generated.remoteUrl, timer);
  throw new Error('The try-on provider did not return an image');
}

function closetStepIntentForItem(item) {
  const slot = itemPlacementKey(item, item?.tryOnSlot);
  if (slot === 'goggles') return { key: 'goggles-step', label: 'glasses or sunglasses', action: 'place only the glasses or sunglasses on the face' };
  if (slot === 'watch') return { key: 'wristwear-single', label: 'watch or bracelet', action: 'apply one watch or bracelet to the visible wrist only' };
  if (slot === 'footwear') return { key: 'feet', label: 'footwear', action: 'replace only the footwear' };
  if (slot === 'outerwear') return { key: 'outerwear', label: 'outerwear', action: 'apply only the outerwear layer' };
  if (slot === 'bottomwear') return { key: 'bottoms', label: 'bottoms', action: 'replace only the bottoms' };
  if (slot === 'dresses') return { key: 'dresses', label: 'dress or one-piece garment', action: 'replace only the one-piece dress or jumpsuit' };
  if (slot === 'suits') return { key: 'suits', label: 'suit or matching set', action: 'replace only the suit or matching set' };
  if (slot === 'cap') return { key: 'headwear', label: 'headwear', action: 'apply only the headwear' };
  if (slot === 'accessories') return { key: 'accessory', label: 'accessory', action: 'apply only the wearable accessory' };
  return { key: 'tops', label: 'shirt or top', action: 'replace only the shirt or top' };
}

function closetStepPrompt(item, step, total) {
  const slot = itemPlacementKey(item, item?.tryOnSlot);
  const name = cleanWord(item.name, item.category);
  const preserve = 'Preserve the person, face, hair, skin tone, pose, body shape, background, lighting, and every already-applied wardrobe item exactly.';
  const base = [
    `Step ${step} of ${total}: apply "${name}" to the current model image.`,
    preserve,
    'Do not remove or replace any clothing, shoes, glasses, watches, bags, hats, or accessories that are already visible unless this step explicitly targets that same body area.',
    'Keep the selected item faithful to its original color, fabric, silhouette, pattern, logos, and details.'
  ];
  const slotRule = {
    topwear: 'Replace only the shirt/top area. Keep pants, shoes, eyewear, accessories, hands, face, hair, and background unchanged.',
    outerwear: 'Apply only the jacket/outerwear as an outside layer. If a top is already visible underneath, keep that inner top visible through the jacket opening, neckline, hem, or sleeves.',
    bottomwear: 'Replace only the pants/bottoms area. Keep the top, shoes, accessories, face, hands, and background unchanged.',
    footwear: 'Replace only the shoes/footwear on both feet. The selected footwear must be visibly worn on the model. Do not change pants, legs, top, glasses, accessories, or background.',
    goggles: 'Place only the selected glasses/sunglasses on the face, aligned with the eyes. The glasses must be clearly visible. Do not change the shirt, pants, shoes, hair, face identity, pose, or background.',
    watch: 'Apply only the selected watch/bracelet to one visible wrist. Do not add extra jewelry or change clothing, shoes, face, hands, or background.',
    cap: 'Apply only the selected hat/cap/headwear. Do not change clothing, shoes, glasses, face identity, hair shape beyond natural occlusion, or background.',
    accessories: 'Apply only the selected wearable accessory. Do not change clothing, shoes, glasses, face, body, or background.'
  }[slot] || 'Apply only this selected wearable item and keep all unrelated body areas unchanged.';
  return [...base, slotRule, 'Generate one realistic full-body retail try-on image.'].join(' ');
}

function generatedImageAsPersonFile(image, label = 'previous-step') {
  return {
    buffer: image.bytes,
    mimetype: image.mimetype || 'image/jpeg',
    originalname: `${label}-${Date.now()}.jpg`
  };
}

async function callClosetTryOnStep({ user, item, personImage, step, total, timer }) {
  const [garmentFile] = await closetItemGarmentFiles([item], timer);
  const slot = itemPlacementKey(item, item.tryOnSlot);
  timer.mark('sequential try-on step selected', { step, total, slot, itemId: item._id.toString() });
  const generated = await callPrunaTryOn({
    user,
    personImageFile: personImage ? generatedImageAsPersonFile(personImage, `step-${step - 1}`) : undefined,
    product: closetItemProductForTryOn(item),
    garmentFile,
    prompt: closetStepPrompt(item, step, total),
    intent: closetStepIntentForItem(item),
    timer,
    custom: true
  });
  const image = await generatedClosetImageBytes(generated, timer);
  timer.mark('sequential try-on step ready', { step, total, slot, kb: Math.round(image.bytes.length / 1024), mimetype: image.mimetype });
  return { generated, image };
}

async function callSequentialClosetTryOn({ user, items, timer }) {
  const referenceItems = layeredTryOnReferenceItems(items);
  let currentImage = null;
  let lastGenerated = null;
  for (let index = 0; index < referenceItems.length; index += 1) {
    const result = await callClosetTryOnStep({
      user,
      item: referenceItems[index],
      personImage: currentImage,
      step: index + 1,
      total: referenceItems.length,
      timer
    });
    currentImage = result.image;
    lastGenerated = result.generated;
  }
  return {
    ...lastGenerated,
    bytes: currentImage.bytes,
    mimetype: currentImage.mimetype,
    quality: `${referenceItems.length}-step sequential`
  };
}

function innerTopLayerPrompt(item) {
  return [
    `Apply ${cleanWord(item.name, 'the selected T-shirt or top')} to the person as the visible inner top layer.`,
    'The top must cover the torso naturally like a real shirt. Preserve the face, hair, body shape, pose, pants, shoes, background, and lighting.',
    'Do not add a jacket, coat, exposed chest, lingerie, or random extra layers in this first pass.',
    'Keep the selected top faithful to its color, neckline, sleeves, fabric, and silhouette.'
  ].join(' ');
}

function outerLayerPrompt(items = []) {
  const referenceItems = layeredTryOnReferenceItems(items);
  const outerItems = referenceItems.filter((item) => itemPlacementKey(item, item.tryOnSlot) === 'outerwear');
  const otherItems = referenceItems.filter((item) => itemPlacementKey(item, item.tryOnSlot) !== 'topwear');
  const references = otherItems
    .map((item, index) => `garment image ${index + 1} is ${cleanWord(item.name, item.category)} (${titleCase(itemPlacementKey(item, item.tryOnSlot))})`)
    .join('; ');
  return [
    'The person image already shows the selected inner T-shirt/top. Preserve that inner top exactly and keep it visibly worn.',
    references ? `Reference map for this pass: ${references}.` : '',
    `Apply ${outerItems.map((item) => cleanWord(item.name, 'outerwear')).join(', ') || 'the selected jacket or outerwear'} as the OUTER layer over the existing T-shirt/top.`,
    'The jacket must be worn open or partially open enough that the inner T-shirt/top remains clearly visible at the neckline, chest opening, jacket opening, hem, or sleeves.',
    'Do not replace the T-shirt/top with bare skin, a bra, lingerie, a dark triangle panel, or a random shirt.',
    'Apply any selected bottoms, footwear, eyewear, watches, bags, or hats from the remaining garment images without changing the visible inner top.',
    'Preserve the person, face, hair, skin tone, pose, body shape, hands, background, and lighting as much as possible.'
  ].filter(Boolean).join(' ');
}

async function callLayeredClosetTryOn({ user, items, timer }) {
  const referenceItems = layeredTryOnReferenceItems(items);
  const topItem = referenceItems.find((item) => itemPlacementKey(item, item.tryOnSlot) === 'topwear');
  if (!topItem) throw new Error('Select a top item for layered try-on.');

  timer.mark('layered inner top pass selected', { itemId: topItem._id.toString() });
  const [topFile] = await closetItemGarmentFiles([topItem], timer);
  const innerTop = await callPrunaTryOn({
    user,
    product: closetItemProductForTryOn(topItem),
    garmentFile: topFile,
    prompt: innerTopLayerPrompt(topItem),
    intent: { key: 'tops', label: 'shirt or top', action: 'replace only the shirt or top' },
    timer,
    custom: true
  });
  const innerTopImage = await generatedClosetImageBytes(innerTop, timer);
  timer.mark('layered inner top pass ready', { kb: Math.round(innerTopImage.bytes.length / 1024), mimetype: innerTopImage.mimetype });

  const remainingItems = referenceItems.filter((item) => item._id.toString() !== topItem._id.toString());
  const remainingFiles = await closetItemGarmentFiles(remainingItems, timer);
  return callPrunaTryOn({
    user,
    personImageFile: {
      buffer: innerTopImage.bytes,
      mimetype: innerTopImage.mimetype,
      originalname: `inner-top-${Date.now()}.jpg`
    },
    product: layeredClosetProductForTryOn(referenceItems),
    garmentFiles: remainingFiles,
    prompt: outerLayerPrompt(referenceItems),
    intent: { key: 'layered-outfit', label: 'layered outfit', action: 'apply the selected outerwear over the visible inner top' },
    timer,
    custom: true
  });
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
  if (items.length === 1 && !shouldComposeSingleClosetItem(items[0])) return filePartFromStoredImage(items[0].image, 'closet item', timer);

  const width = 1024;
  const height = 1280;
  const slots = items.slice(0, 5);
  const composites = [];
  const slotCounts = {};
  for (let index = 0; index < slots.length; index += 1) {
    const item = slots[index];
    const slot = itemPlacementKey(item, item.tryOnSlot);
    const duplicateIndex = slotCounts[slot] || 0;
    slotCounts[slot] = duplicateIndex + 1;
    const layout = closetCanvasLayoutForSlot(slot, duplicateIndex);
    const { bytes } = await readStoredFile(item.image);
    const thumb = await sharp(bytes)
      .rotate()
      .resize({ width: layout.width, height: layout.height, fit: 'contain', background: '#fffdf8' })
      .jpeg({ quality: 92 })
      .toBuffer();
    composites.push({ input: thumb, top: layout.top, left: layout.left });
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

  timer?.mark('closet combo image composed', { itemCount: slots.length, slots: slots.map((item) => itemPlacementKey(item, item.tryOnSlot)), kb: Math.round(canvas.length / 1024) });
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

async function generateClosetOutfitService({ userId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 401;
    throw error;
  }
  const itemIds = [...new Set((Array.isArray(body?.itemIds) ? body.itemIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 5);
  const itemSlots = Array.isArray(body?.itemSlots) ? body.itemSlots.slice(0, 5) : [];
  const timer = createTimer('generate-outfit', { userId: user._id.toString(), itemCount: itemIds.length });
  let reserved = false;
  let chargedUser = user;
  try {
    if (!itemIds.length) {
      const error = new Error('Select at least one closet item.');
      error.statusCode = 400;
      throw error;
    }
    ensureTryOnProfileReady(chargedUser);
    const items = await ClosetItem.find({ user: chargedUser._id, _id: { $in: itemIds } });
    if (items.length !== itemIds.length) {
      const error = new Error('One or more closet items were not found.');
      error.statusCode = 404;
      throw error;
    }
    const orderedItems = orderedClosetItemsForTryOn(items, itemIds, itemSlots);
    const reservedUser = await reserveToken(chargedUser, timer);
    if (!reservedUser) {
      timer.end({ error: 'insufficient tokens' });
      const error = new Error('Not enough tokens for AI outfit generation');
      error.statusCode = 402;
      throw error;
    }
    reserved = true;
    chargedUser = reservedUser;

    const layeredTryOn = shouldUseLayeredTryOn(orderedItems);
    const sequentialTryOn = shouldUseSequentialTryOn(orderedItems);
    const focusedSingleTryOn = !sequentialTryOn && shouldUseFocusedSingleTryOn(orderedItems);
    const garment = focusedSingleTryOn
      ? await filePartFromStoredImage(orderedItems[0].image, 'closet item', timer)
      : await combinedGarmentFromItems(orderedItems, timer);
    if (focusedSingleTryOn) {
      timer.mark('focused single try-on selected', {
        slot: itemPlacementKey(orderedItems[0], orderedItems[0].tryOnSlot),
        itemId: orderedItems[0]._id.toString()
      });
    }
    if (layeredTryOn) {
      timer.mark('layered try-on selected', {
        slots: selectedTryOnSlots(orderedItems),
        itemIds: orderedItems.map((item) => item._id.toString())
      });
    }
    if (sequentialTryOn) {
      timer.mark('sequential combo try-on selected', {
        slots: selectedTryOnSlots(orderedItems),
        itemIds: orderedItems.map((item) => item._id.toString())
      });
    }
    const generated = focusedSingleTryOn
      ? await callPrunaTryOn({
        user: chargedUser,
        product: closetItemProductForTryOn(orderedItems[0]),
        garmentFile: garment,
        prompt: closetStepPrompt(orderedItems[0], 1, 1),
        intent: closetStepIntentForItem(orderedItems[0]),
        timer,
        custom: true
      })
      : sequentialTryOn
        ? await callSequentialClosetTryOn({ user: chargedUser, items: orderedItems, timer })
      : await callFitRoomTryOn({ user: chargedUser, garment, timer });
    const generatedImage = await generatedClosetImageBytes(generated, timer);
    const garmentFile = await saveUploadFile({ buffer: garment.bytes, mimetype: garment.mimetype, size: garment.bytes.length }, 'closet-combo', chargedUser, 'closet-outfits');
    const imageFile = await saveUploadFile({ buffer: generatedImage.bytes, mimetype: generatedImage.mimetype, size: generatedImage.bytes.length }, 'closet-outfit', chargedUser, 'closet-outfits');
    const outfit = await ClosetOutfit.create({
      user: chargedUser._id,
      title: cleanWord(body?.title, `Closet look for ${cleanWord(body?.occasion, 'today')}`),
      occasion: cleanWord(body?.occasion),
      weather: cleanWord(body?.weather),
      mood: cleanWord(body?.mood),
      backdrop: cleanWord(body?.backdrop),
      pose: cleanWord(body?.pose),
      lighting: cleanWord(body?.lighting),
      notes: cleanWord(body?.notes).slice(0, 500),
      plannedFor: cleanDate(body?.plannedFor),
      itemIds: orderedItems.map((item) => item._id),
      provider: generated.provider || (focusedSingleTryOn || sequentialTryOn ? 'pruna' : 'fitroom'),
      model: generated.model || 'fitroom/tryon-v2',
      quality: generated.quality || (fitRoomHdMode() ? 'hd' : 'standard'),
      tokenCost: chargedTokenCost(chargedUser),
      garment: garmentFile,
      image: imageFile
    });
    await recordCreditEvent({
      user: chargedUser,
      action: 'Wardrobe outfit',
      tokens: chargedTokenCost(chargedUser),
      balanceAfter: chargedUser.tokens,
      metadata: { direction: 'debit', outfitId: outfit._id.toString() }
    });
    timer.end({ outfitId: outfit._id.toString(), tokensRemaining: chargedUser.tokens });
    return { outfit: outfitToClient(outfit, orderedItems), user: chargedUser.toClient() };
  } catch (error) {
    const message = readableError(error, 'Could not generate closet outfit');
    if (reserved) chargedUser = await refundToken(chargedUser, timer);
    timer.end({ error: message });
    throw error;
  }
}

router.post('/outfits/generate', requireUser, async (req, res) => {
  const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 5);
  if (!itemIds.length) return res.status(400).json({ message: 'Select at least one closet item.' });
  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'closet-outfit-generate',
      key: `${req.user._id}:${itemIds.join(',')}:${JSON.stringify(req.body?.itemSlots || [])}`,
      payload: {
        body: {
          itemIds,
          itemSlots: Array.isArray(req.body?.itemSlots) ? req.body.itemSlots.slice(0, 5) : [],
          occasion: req.body?.occasion,
          weather: req.body?.weather,
          mood: req.body?.mood,
          backdrop: req.body?.backdrop,
          pose: req.body?.pose,
          lighting: req.body?.lighting,
          notes: req.body?.notes,
          plannedFor: req.body?.plannedFor,
          title: req.body?.title
        }
      },
      maxAttempts: 1,
      priority: 2,
      runInline: async () => ({
        statusCode: 201,
        body: await generateClosetOutfitService({ userId: req.user._id, body: req.body })
      })
    });
  } catch (error) {
    const message = readableError(error, 'Could not generate closet outfit');
    res.status(isStorageConfigurationError(error) ? error.statusCode || 503 : error.statusCode || 400).json({ message });
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

function registerClosetJobHandlers() {
  registerJobHandler('closet-outfit-generate', async ({ payload, job }) => (
    generateClosetOutfitService({ userId: job.user, body: payload.body })
  ));
}

export default router;
export { registerClosetJobHandlers };
