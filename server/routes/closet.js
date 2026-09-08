import express from 'express';
import fs from 'node:fs/promises';
import heicConvert from 'heic-convert';
import multer from 'multer';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { isolateSubjectAsset } from '../utils/backgroundRemoval.js';
import { recordGenerationMetric } from '../utils/generationMetrics.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { signMediaToken, verifyMediaToken } from '../utils/mediaTokens.js';
import { deleteStoredFile, publicUrlForStoredFile, readStoredFile, saveBuffer } from '../utils/storage.js';
import { developmentBillingBypass, isAllowedRasterImageUpload, safeFetchBuffer } from '../utils/security.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const debugGenerationLogs = ['1', 'true', 'yes', 'on'].includes(String(process.env.DEBUG_GENERATION_LOGS || '').toLowerCase());
const imageMimeTypes = new Set(['image/avif', 'image/x-avif', 'image/heic', 'image/heif']);
const closetReadLimiter = createRateLimiter({
  name: 'closet:read',
  windowMs: 5 * 60 * 1000,
  max: 240,
  keyGenerator: rateLimitKeys.user,
  message: 'Wardrobe requests are temporarily limited. Please try again shortly.'
});
const closetUploadLimiter = createRateLimiter({
  name: 'closet:upload',
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many wardrobe image uploads. Please wait a few minutes before uploading more.'
});
const closetChatLimiter = createRateLimiter({
  name: 'closet:chat',
  windowMs: 5 * 60 * 1000,
  max: 30,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many stylist requests. Please slow down for a moment.'
});


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
const fitRoomUpperCategories = new Set(['tops', 'outerwear', 'activewear', 'ethnic']);
const fitRoomLowerCategories = new Set(['bottoms']);
const fitRoomFullSetCategories = new Set(['dresses', 'suits']);

function isAllowedImageUpload(file) {
  const type = String(file.mimetype || '').toLowerCase();
  const name = String(file.originalname || '').toLowerCase();
  return isAllowedRasterImageUpload(file) || imageMimeTypes.has(type) || /\.(avif|heic|heif)$/i.test(name);
}

function extensionFor(mimetype) {
  if (mimetype?.includes('png')) return '.png';
  if (mimetype?.includes('webp')) return '.webp';
  if (mimetype?.includes('gif')) return '.gif';
  return '.jpg';
}

function safeLocalPath(storedPath) {
  const resolved = path.resolve(rootDir, storedPath || '');
  if (!resolved.startsWith(rootDir)) throw new Error('Invalid image path');
  return resolved;
}

function cleanWord(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function cleanList(value, limit = 12) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(raw.map((item) => cleanWord(item).toLowerCase()).filter(Boolean))].slice(0, limit);
}

function cleanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function textForClosetItem(item = {}) {
  const visualProfile = item.visualProfile || {};
  return [
    item.name,
    item.category,
    item.color,
    item.fabric,
    item.pattern,
    item.season,
    item.formality,
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.occasions) ? item.occasions : []),
    visualProfile.subcategory,
    visualProfile.fabricGuess,
    visualProfile.fit,
    visualProfile.silhouette,
    visualProfile.rawDescription,
    visualProfile.nameSuggestion,
    ...(Array.isArray(visualProfile.styleTags) ? visualProfile.styleTags : [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isFullSetClosetItem(item) {
  if (fitRoomFullSetCategories.has(item?.category)) return true;
  return /\b(dress|gown|jumpsuit|romper|saree|sari|lehenga|sherwani|kurta set|co-ord|coord|one[-\s]?piece)\b/i.test(textForClosetItem(item));
}

function isUpperClosetItem(item) {
  return !isFullSetClosetItem(item) && fitRoomUpperCategories.has(item?.category);
}

function isLowerClosetItem(item) {
  return fitRoomLowerCategories.has(item?.category);
}

function closetItemId(item) {
  return item?._id?.toString?.() || item?.id || '';
}

function fitRoomPlanWithSelectedItems(plan, selected) {
  const renderedIds = new Set(plan.renderedItemIds || []);
  const ignoredItems = selected.filter((item) => !renderedIds.has(closetItemId(item)));
  return {
    ...plan,
    items: selected,
    ignoredItems,
    requiresWan: selected.length > 1 || ignoredItems.length > 0
  };
}

function selectFitRoomClosetPlan(items = []) {
  const selected = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!selected.length) throw new Error('Select at least one closet item.');
  const upperItem = selected.find(isUpperClosetItem);
  const lowerItem = selected.find(isLowerClosetItem);
  const fullSetItem = selected.find(isFullSetClosetItem);

  if (upperItem && lowerItem) {
    return fitRoomPlanWithSelectedItems({
      clothType: 'combo',
      upperItem,
      lowerItem,
      renderedItemIds: [upperItem._id?.toString?.(), lowerItem._id?.toString?.()].filter(Boolean)
    }, selected);
  }
  if (fullSetItem) {
    return fitRoomPlanWithSelectedItems({
      clothType: 'full_set',
      garmentItem: fullSetItem,
      renderedItemIds: [fullSetItem._id?.toString?.()].filter(Boolean)
    }, selected);
  }
  if (upperItem) {
    return fitRoomPlanWithSelectedItems({
      clothType: 'upper',
      garmentItem: upperItem,
      renderedItemIds: [upperItem._id?.toString?.()].filter(Boolean)
    }, selected);
  }
  if (lowerItem) {
    return fitRoomPlanWithSelectedItems({
      clothType: 'lower',
      garmentItem: lowerItem,
      renderedItemIds: [lowerItem._id?.toString?.()].filter(Boolean)
    }, selected);
  }

  return {
    clothType: 'wardrobe_multi',
    items: selected,
    ignoredItems: [],
    renderedItemIds: [],
    requiresWan: true
  };
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

function tokenCost() {
  const value = Number(process.env.TRYON_TOKEN_COST || 1);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 1;
}

function chargedTokenCost(user) {
  return developmentBillingBypass(user) ? 0 : tokenCost();
}

function shouldAnalyzeClosetUploads() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.CLOSET_VISION_ANALYSIS ?? 'true').toLowerCase());
}

function closetVisionModel() {
  return process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash';
}

function closetVisionEndpoint() {
  return process.env.FAL_CLOSET_VISION_ENDPOINT || 'openrouter/router/vision';
}

function falHeaders() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is missing on the server');
  return {
    Authorization: `Key ${process.env.FAL_KEY}`,
    'Content-Type': 'application/json'
  };
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

function imageMimeTypeFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const gifHeader = bytes.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif';
  return '';
}

function wanImageToImageModel() {
  return process.env.FAL_WAN_IMAGE_TO_IMAGE_MODEL || 'wan/v2.6/image-to-image';
}

function wanImageSize() {
  const width = Number(process.env.FAL_WAN_IMAGE_WIDTH || 1024);
  const height = Number(process.env.FAL_WAN_IMAGE_HEIGHT || 1280);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1024, height: 1280 };
  return { width, height };
}

function closetNoOpFallbackEnabled() {
  return !['0', 'false', 'no', 'off'].includes(String(process.env.CLOSET_NOOP_WAN_FALLBACK ?? 'true').toLowerCase());
}

function closetNoOpDiffThreshold() {
  const value = Number(process.env.CLOSET_NOOP_DIFF_THRESHOLD || 3);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function closetWanPrompt(plan) {
  const hasComplexSelection = Boolean(plan?.requiresWan || plan?.clothType === 'wardrobe_multi');
  const target = hasComplexSelection
    ? 'correct corresponding body areas'
    : plan?.clothType === 'combo'
      ? 'upper- and lower-body garment areas'
      : plan?.clothType === 'lower'
        ? 'lower-body garment area only'
        : plan?.clothType === 'upper'
          ? 'upper-body garment area only'
          : 'selected garment areas';
  const selectedItems = Array.isArray(plan?.items) ? plan.items : [];
  const itemSummary = selectedItems
    .map((item) => `${cleanWord(item.name || item.category || 'wardrobe item')} (${cleanWord(item.category || 'item')})`)
    .join(', ');
  return [
    'Create one photorealistic virtual try-on image for an ecommerce wardrobe preview.',
    'Image 1 is the shopper and must remain the identity, face, hair, skin tone, body shape, hands, legs, natural proportions, and expression reference.',
    itemSummary ? `Selected wardrobe pieces: ${itemSummary}.` : '',
    `Image 2 is the wardrobe reference. Transfer every visible selected clothing, footwear, and accessory item from image 2 onto the shopper's ${target}.`,
    'For tops, replace upper-body clothing. For bottoms, replace lower-body clothing. For dresses, suits, and co-ords, replace the full outfit. For shoes, replace the footwear on both feet. For hats/caps, place the item on the head. For sunglasses/eyewear, place the item on the eyes. For bags, belts, scarves, and jewelry, place the item naturally in the corresponding area.',
    'If image 2 contains multiple wardrobe pieces arranged on a plain canvas, treat them as separate references and apply all selected pieces together in one complete outfit.',
    'If image 2 is swimwear or innerwear, render it as a non-sexualized retail catalog try-on with accurate coverage and no nudity.',
    'Do not ignore image 2 and do not keep the original garment in the target area when it conflicts with the clothing reference.',
    'Preserve non-target clothing and body regions from image 1 unless they must be naturally covered or replaced by the uploaded garment.',
    'Fit the garment naturally with correct scale, folds, occlusion, shadows, and fabric texture.',
    'Use a clean full-body studio catalog composition with soft even lighting and a simple neutral light gray or off-white background.',
    'Keep exactly one person in frame, full body visible head to toe, complete face and hair visible, both arms and hands visible, both legs and feet visible.',
    'Do not add extra accessories, logos, text, people, duplicated limbs, body changes, beauty edits, or a comparison layout.'
  ].filter(Boolean).join(' ');
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
  if (debugGenerationLogs) console.log(`[closet:${label}] start`, meta);
  return {
    mark(step, extra = {}) {
      const now = performance.now();
      if (debugGenerationLogs) {
        console.log(`[closet:${label}] ${step}`, {
          stepMs: Math.round(now - last),
          totalMs: Math.round(now - start),
          ...extra
        });
      }
      last = now;
    },
    end(extra = {}) {
      if (debugGenerationLogs) console.log(`[closet:${label}] done`, { totalMs: Math.round(performance.now() - start), ...extra });
    }
  };
}

function ensureTryOnProfileReady(user) {
  const status = user?.bodyPhoto?.status || 'ready';
  if (status === 'generating') throw new Error('Your full-body try-on profile is still preparing. Try again in a minute.');
  if (status === 'failed') throw new Error('Your full-body try-on profile failed. Upload a clearer profile photo first.');
  if (!user?.bodyPhoto?.path && !user?.bodyPhoto?.url && !user?.bodyPhoto?.remoteUrl) throw new Error('Upload a try-on profile photo before generating closet looks.');
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

function closetVisionPrompt() {
  return [
    'Analyze this single clothing, footwear, or accessory image for a wardrobe app.',
    'Return only valid compact JSON with no markdown and no commentary.',
    'Use this exact schema:',
    '{"nameSuggestion":"","category":"","subcategory":"","primaryColor":"","secondaryColors":[],"pattern":"","fabricGuess":"","texture":"","fit":"","silhouette":"","formality":"","occasions":[],"seasons":[],"styleTags":[],"pairingNotes":"","rawDescription":"","confidence":0}',
    'Allowed category values: tops, bottoms, dresses, suits, outerwear, shoes, accessories, activewear, ethnic, other.',
    'Allowed formality values: casual, smart-casual, formal, party, active, any.',
    'Allowed season values: summer, winter, monsoon, spring, autumn, all-season.',
    'Choose practical ecommerce wardrobe labels. Infer visual attributes from the image only. If uncertain, use an empty string, empty array, "other", "any", or lower confidence.',
    'For pairingNotes, give one concise sentence about what colors or item types this would pair with.'
  ].join(' ');
}

function extractJsonObject(text = '') {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function cleanScalar(value, limit = 120) {
  return cleanWord(value).slice(0, limit);
}

function normalizedDetectedCategory(value) {
  return normalizeCategory(value);
}

function normalizedDetectedFormality(value) {
  return inferFormality(value);
}

function normalizedDetectedSeason(value) {
  const season = cleanWord(value, 'all-season').toLowerCase();
  if (['summer', 'winter', 'monsoon', 'spring', 'autumn', 'all-season'].includes(season)) return season;
  return 'all-season';
}

function normalizeVisualProfile(value = {}, meta = {}) {
  const profile = value && typeof value === 'object' ? value : {};
  const seasons = cleanList(profile.seasons, 6).map(normalizedDetectedSeason);
  return {
    source: 'fal-openrouter-vision',
    model: meta.model || '',
    analyzedAt: new Date(),
    cost: Number(meta.cost || 0),
    confidence: Math.max(0, Math.min(1, Number(profile.confidence || 0))),
    subcategory: cleanScalar(profile.subcategory),
    primaryColor: cleanScalar(profile.primaryColor || profile.color).toLowerCase(),
    secondaryColors: cleanList(profile.secondaryColors, 6),
    pattern: cleanScalar(profile.pattern).toLowerCase(),
    fabricGuess: cleanScalar(profile.fabricGuess || profile.fabric).toLowerCase(),
    texture: cleanScalar(profile.texture).toLowerCase(),
    fit: cleanScalar(profile.fit).toLowerCase(),
    silhouette: cleanScalar(profile.silhouette).toLowerCase(),
    formality: normalizedDetectedFormality(profile.formality),
    occasions: cleanList(profile.occasions, 10),
    seasons: [...new Set(seasons.length ? seasons : ['all-season'])],
    styleTags: cleanList(profile.styleTags || profile.tags, 12),
    pairingNotes: cleanScalar(profile.pairingNotes, 500),
    rawDescription: cleanScalar(profile.rawDescription || profile.description, 700),
    nameSuggestion: cleanScalar(profile.nameSuggestion || profile.name),
    category: normalizedDetectedCategory(profile.category)
  };
}

function visualProfileFromBody(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return normalizeVisualProfile(parsed, { model: parsed?.model, cost: parsed?.cost });
  } catch {
    return null;
  }
}

function detailsFromVisualProfile(profile) {
  if (!profile) return null;
  const detectedTags = [
    ...(profile.styleTags || []),
    profile.subcategory,
    profile.fit,
    profile.silhouette
  ].filter(Boolean);
  return {
    name: profile.nameSuggestion || '',
    category: profile.category || 'other',
    color: profile.primaryColor || '',
    fabric: profile.fabricGuess || '',
    pattern: profile.pattern || '',
    season: profile.seasons?.[0] || 'all-season',
    formality: profile.formality || 'any',
    occasions: profile.occasions || [],
    tags: [...new Set(detectedTags)].slice(0, 12),
    pairingNotes: profile.pairingNotes || ''
  };
}

async function analyzeClosetItemImage(file, timer) {
  if (!shouldAnalyzeClosetUploads()) {
    timer?.mark('closet vision skipped', { reason: 'disabled' });
    return { unavailable: true, reason: 'Closet vision analysis is disabled on the server.' };
  }
  if (!process.env.FAL_KEY) {
    timer?.mark('closet vision skipped', { reason: 'missing FAL_KEY' });
    return { unavailable: true, reason: 'FAL_KEY is missing on the server.' };
  }

  const model = closetVisionModel();
  const imageDataUri = `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`;
  const response = await fetch(`https://fal.run/${closetVisionEndpoint()}`, {
    method: 'POST',
    headers: falHeaders(),
    body: JSON.stringify({
      image_urls: [imageDataUri],
      model,
      temperature: 0,
      max_tokens: 600,
      system_prompt: 'You extract structured wardrobe metadata from clothing images. Output only valid JSON.',
      prompt: closetVisionPrompt()
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.error || data.message || data, 'Closet image analysis failed'));
  const parsed = extractJsonObject(data.output || data.results || '');
  if (!parsed) throw new Error('Closet image analysis returned invalid JSON');
  const visualProfile = normalizeVisualProfile(parsed, { model, cost: data.usage?.cost });
  timer?.mark('closet vision analyzed', {
    model,
    category: visualProfile.category,
    color: visualProfile.primaryColor,
    cost: visualProfile.cost
  });
  return visualProfile;
}

async function falJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...falHeaders(), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readableError(data.detail || data.error || data.message || data, 'FAL closet try-on request failed'));
  return data;
}

async function waitForFalResult(submission, timer) {
  const statusUrl = submission.status_url;
  const responseUrl = submission.response_url;
  if (!statusUrl || !responseUrl) throw new Error('FAL did not return queue URLs');

  const maxAttempts = Number(process.env.FAL_WAN_POLL_ATTEMPTS || 180);
  const pollMs = Number(process.env.FAL_WAN_POLL_MS || 1500);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await falJson(statusUrl);
    if (attempt === 0 || attempt % 5 === 0 || status.status === 'COMPLETED') timer?.mark('fal wan status poll', { attempt, status: status.status });
    if (status.status === 'COMPLETED') return falJson(responseUrl);
    if (status.status === 'FAILED' || status.error) throw new Error(readableError(status.error || status, 'FAL Wan closet try-on generation failed'));
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`FAL Wan closet try-on generation timed out after ${Math.round((maxAttempts * pollMs) / 1000)} seconds`);
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

async function saveUploadFile(file, prefix, user, folder = 'closet') {
  const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(file.mimetype)}`;
  return saveBuffer({
    key: path.posix.join('users', user._id.toString(), folder, filename),
    buffer: file.buffer,
    filename,
    mimetype: file.mimetype
  });
}

async function greyStudioOutfitFromTransparent(transparentImage, user, timer) {
  if (!transparentImage?.path) return null;
  const { buffer: subjectBytes } = await readStoredFile(transparentImage, 'transparent outfit');
  const metadata = await sharp(subjectBytes, { failOn: 'none' }).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) return null;

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#d7d7d5'
    }
  })
    .composite([{ input: subjectBytes, left: 0, top: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  timer?.mark('grey studio wardrobe composite created', { kb: Math.round(buffer.length / 1024), width, height });
  return saveUploadFile({ buffer, mimetype: 'image/jpeg', size: buffer.length }, 'closet-outfit-grey', user, 'closet-outfits');
}

async function filePartFromStoredImage(image, label, timer) {
  if (!image?.path && !image?.url && !image?.remoteUrl) throw new Error(`${label} image is missing`);
  const { buffer: bytes } = await readStoredFile(image, label);
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
  if (/^data:image\//i.test(url)) {
    const [, metadata = '', base64 = ''] = url.match(/^data:([^;]+);base64,(.+)$/i) || [];
    if (!base64) throw new Error('Generated closet image data URI was invalid');
    const bytes = Buffer.from(base64, 'base64');
    return {
      bytes,
      mimetype: imageMimeTypeFromBytes(bytes) || metadata || 'image/png'
    };
  }

  const { response, buffer: bytes } = await safeFetchBuffer(url, {
    maxBytes: 12 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy closet generated image fetcher'
    }
  });
  if (!response.ok) throw new Error('Could not download generated closet outfit');
  const responseMimeType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const mimetype = imageMimeTypeFromBytes(bytes) || (responseMimeType.startsWith('image/') ? responseMimeType : '');
  if (!mimetype) throw new Error('Generated closet outfit download was not an image');
  timer?.mark('generated image downloaded', { kb: Math.round(bytes.length / 1024), mimetype });
  return { bytes, mimetype };
}

async function imageDataUriFromBuffer(file, label, timer, options = {}) {
  const bytes = file?.bytes || file?.buffer;
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} image is missing`);
  const metadata = await sharp(bytes, { failOn: 'none' }).metadata();
  const minWidth = Number(options.minWidth || 0);
  const minHeight = Number(options.minHeight || 0);
  const outputWidth = Math.max(Number(metadata.width || 0), minWidth);
  const outputHeight = Math.max(Number(metadata.height || 0), minHeight);
  const shouldResize = outputWidth && outputHeight && (outputWidth !== metadata.width || outputHeight !== metadata.height);
  let pipeline = sharp(bytes, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#fffdf8' });
  if (shouldResize) {
    pipeline = pipeline.resize({
      width: outputWidth,
      height: outputHeight,
      fit: 'contain',
      background: '#fffdf8',
      withoutEnlargement: false
    });
  }
  const output = await pipeline
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer();
  timer?.mark(`${label} data uri prepared`, {
    inputWidth: metadata.width,
    inputHeight: metadata.height,
    outputKb: Math.round(output.length / 1024),
    outputWidth: shouldResize ? outputWidth : metadata.width,
    outputHeight: shouldResize ? outputHeight : metadata.height
  });
  return `data:image/jpeg;base64,${output.toString('base64')}`;
}

async function imageDataUriFromStoredImage(image, label, timer, options = {}) {
  const { buffer: bytes } = await readStoredFile(image, label);
  return imageDataUriFromBuffer({ bytes }, label, timer, options);
}

async function meanAbsoluteImageDifference(leftBytes, rightBytes) {
  const width = 128;
  const height = 192;
  const [left, right] = await Promise.all([
    sharp(leftBytes, { failOn: 'none' }).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    sharp(rightBytes, { failOn: 'none' }).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  ]);
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index] - right[index]);
  }
  return total / left.length;
}

async function generatedLooksUnchanged(user, generated, timer) {
  if (!closetNoOpFallbackEnabled()) return false;
  const { buffer: personBytes } = await readStoredFile(user.bodyPhoto, 'person');
  const meanDiff = await meanAbsoluteImageDifference(personBytes, generated.bytes);
  const unchanged = meanDiff <= closetNoOpDiffThreshold();
  timer?.mark('generated outfit similarity checked', { meanDiff: Number(meanDiff.toFixed(2)), unchanged });
  return unchanged;
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
    const { buffer: bytes } = await readStoredFile(item.image, 'closet item');
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

async function callFitRoomTryOn({ user, plan, timer }) {
  const person = await filePartFromStoredImage(user.bodyPhoto, 'person', timer);
  const form = new FormData();
  appendFilePart(form, 'model_image', person);
  if (plan.clothType === 'combo') {
    const [upperGarment, lowerGarment] = await Promise.all([
      filePartFromStoredImage(plan.upperItem.image, 'upper closet item', timer),
      filePartFromStoredImage(plan.lowerItem.image, 'lower closet item', timer)
    ]);
    appendFilePart(form, 'cloth_image', upperGarment);
    appendFilePart(form, 'lower_cloth_image', lowerGarment);
  } else {
    const selectedGarment = await filePartFromStoredImage(plan.garmentItem.image, 'closet item', timer);
    appendFilePart(form, 'cloth_image', selectedGarment);
  }
  form.append('cloth_type', plan.clothType);
  if (fitRoomHdMode()) form.append('hd_mode', 'true');

  timer?.mark('fitroom task submit attempt', {
    clothType: plan.clothType,
    renderedItemIds: plan.renderedItemIds
  });
  const submission = await fitRoomJson('/api/tryon/v2/tasks', { method: 'POST', body: form });
  if (!submission.task_id) throw new Error('FitRoom did not return a task id');
  timer?.mark('fitroom task submitted', { taskId: submission.task_id, status: submission.status });
  const result = await waitForFitRoomTask(submission.task_id, timer);
  const generated = await generatedBytesFromUrl(result.download_signed_url, timer);
  return {
    ...generated,
    provider: 'fitroom',
    model: 'fitroom/tryon-v2',
    quality: fitRoomHdMode() ? 'hd' : 'standard',
    prompt: `FitRoom virtual try-on (${plan.clothType})`
  };
}

async function callFalWanClosetTryOn({ user, plan, garment, timer }) {
  const minReferenceSize = 384;
  const [person, garmentReference] = await Promise.all([
    imageDataUriFromStoredImage(user.bodyPhoto, 'person', timer, { minWidth: minReferenceSize, minHeight: minReferenceSize }),
    garment?.bytes
      ? imageDataUriFromBuffer(garment, 'closet item', timer, { minWidth: minReferenceSize, minHeight: minReferenceSize })
      : imageDataUriFromStoredImage(plan.garmentItem.image, 'closet item', timer, { minWidth: minReferenceSize, minHeight: minReferenceSize })
  ]);
  const endpoint = wanImageToImageModel();
  const prompt = closetWanPrompt(plan);
  const payload = {
    prompt,
    image_urls: [person, garmentReference],
    negative_prompt: wanNegativePrompt(),
    image_size: wanImageSize(),
    num_images: 1,
    enable_prompt_expansion: false,
    enable_safety_checker: true
  };

  timer?.mark('fal wan closet submit attempt', { model: endpoint, clothType: plan.clothType });
  const submission = await falJson(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  timer?.mark('fal wan closet submitted', { requestId: submission.request_id });
  const result = await waitForFalResult(submission, timer);
  const generatedUrl = firstGeneratedImageUrl(result);
  if (!generatedUrl) throw new Error(`FAL Wan returned no image. Response keys: ${Object.keys(result || {}).join(', ')}`);
  const generated = await generatedBytesFromUrl(generatedUrl, timer);
  timer?.mark('fal wan closet generated image downloaded', { outputKb: Math.round(generated.bytes.length / 1024) });
  return {
    ...generated,
    provider: 'fal',
    model: endpoint,
    quality: 'wan v2.6 image-to-image',
    prompt
  };
}

async function generateClosetTryOn({ user, plan, garment, timer }) {
  if (plan.requiresWan) {
    timer?.mark('complex wardrobe selection using wan', {
      selectedItemCount: plan.items?.length || 0,
      fitRoomIgnoredItemCount: plan.ignoredItems?.length || 0
    });
    const wanGenerated = await callFalWanClosetTryOn({ user, plan, garment, timer });
    if (await generatedLooksUnchanged(user, wanGenerated, timer)) {
      throw new Error('The AI provider returned an unchanged preview. Try uploading clearer garment-only photos with each item laid flat on a plain background.');
    }
    return wanGenerated;
  }

  const fitRoomGenerated = await callFitRoomTryOn({ user, plan, timer });
  if (!(await generatedLooksUnchanged(user, fitRoomGenerated, timer))) return fitRoomGenerated;

  timer?.mark('fitroom output unchanged, retrying with wan', { clothType: plan.clothType });
  const wanGenerated = await callFalWanClosetTryOn({ user, plan, garment, timer });
  if (await generatedLooksUnchanged(user, wanGenerated, timer)) {
    throw new Error('The AI provider returned an unchanged preview. Try uploading a clearer garment-only photo with the item laid flat on a plain background.');
  }
  return wanGenerated;
}

async function reserveToken(user, timer) {
  if (developmentBillingBypass(user)) {
    timer.mark('dev mode token bypass', { cost: 0, tokensRemaining: user.tokens });
    return user;
  }
  const cost = tokenCost();
  const chargedUser = await User.findOneAndUpdate(
    {
      _id: user._id,
      tokens: { $gte: cost },
      $or: [{ accountStatus: 'active' }, { accountStatus: { $exists: false } }]
    },
    { $inc: { tokens: -cost } },
    { new: true }
  );
  if (chargedUser) timer.mark('token reserved', { cost, tokensRemaining: chargedUser.tokens });
  return chargedUser;
}

async function refundToken(user, timer) {
  if (developmentBillingBypass(user)) return user;
  const refundedUser = await User.findOneAndUpdate(
    { _id: user._id, accountStatus: { $ne: 'deleted' } },
    { $inc: { tokens: tokenCost() } },
    { new: true }
  );
  if (refundedUser) timer.mark('token refunded', { tokensRemaining: refundedUser.tokens });
  return refundedUser || user;
}

function mediaTokenFromRequest(req) {
  const queryToken = String(req.query?.mediaToken || req.query?.token || '').trim();
  if (queryToken) return queryToken;
  const authorization = String(req.headers.authorization || '');
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function documentId(value) {
  if (!value) return '';
  if (value._id) return value._id.toString();
  return value.toString?.() || String(value);
}

function closetMediaTokenKind(kind) {
  return `closet:${kind}`;
}

function closetMediaProxyUrl({ kind, id, userId }) {
  const mediaId = String(id || '').trim();
  const ownerId = String(userId || '').trim();
  if (!mediaId || !ownerId) return '';
  try {
    const token = signMediaToken({
      userId: ownerId,
      mediaId,
      kind: closetMediaTokenKind(kind)
    });
    return `/api/closet/media/${encodeURIComponent(kind)}/${encodeURIComponent(mediaId)}?mediaToken=${encodeURIComponent(token)}`;
  } catch {
    return '';
  }
}

function directClosetMediaUrl(file) {
  const url = publicUrlForStoredFile(file);
  return /^https?:\/\//i.test(url || '') ? url : '';
}

function itemToClient(item) {
  const client = typeof item.toClient === 'function' ? item.toClient() : new ClosetItem(item).toClient();
  const directImageUrl = directClosetMediaUrl(item.image);
  return {
    ...client,
    imageUrl: directImageUrl || closetMediaProxyUrl({ kind: 'item', id: documentId(item), userId: documentId(item.user) }) || client.imageUrl
  };
}

function outfitToClient(outfit, items = []) {
  const itemsById = new Map(items.map((item) => [item._id.toString(), itemToClient(item)]));
  const client = typeof outfit.toClient === 'function' ? outfit.toClient(itemsById) : new ClosetOutfit(outfit).toClient(itemsById);
  const directGarmentUrl = directClosetMediaUrl(outfit.garment);
  const directImageUrl = directClosetMediaUrl(outfit.image);
  return {
    ...client,
    garmentUrl: directGarmentUrl || closetMediaProxyUrl({ kind: 'garment', id: documentId(outfit), userId: documentId(outfit.user) }) || client.garmentUrl,
    imageUrl: directImageUrl || closetMediaProxyUrl({ kind: 'outfit', id: documentId(outfit), userId: documentId(outfit.user) }) || client.imageUrl
  };
}

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
          content: 'You are Lookmefy stylist AI. Recommend outfits only from the user closet data. Use visualProfile details such as color, pattern, fabric, silhouette, formality, occasions, seasons, style tags, and pairing notes when available. Be concise, practical, and mention exact item names.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: message,
            closet: items.map(({ name, category, color, fabric, pattern, season, formality, occasions, tags, visualProfile }) => ({
              name,
              category,
              color,
              fabric,
              pattern,
              season,
              formality,
              occasions,
              tags,
              visualProfile: visualProfile ? {
                subcategory: visualProfile.subcategory,
                primaryColor: visualProfile.primaryColor,
                secondaryColors: visualProfile.secondaryColors,
                pattern: visualProfile.pattern,
                fabricGuess: visualProfile.fabricGuess,
                texture: visualProfile.texture,
                fit: visualProfile.fit,
                silhouette: visualProfile.silhouette,
                formality: visualProfile.formality,
                occasions: visualProfile.occasions,
                seasons: visualProfile.seasons,
                styleTags: visualProfile.styleTags,
                pairingNotes: visualProfile.pairingNotes
              } : null
            })).slice(0, 80),
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

async function requireClosetMediaAccess(req, kind) {
  let claims;
  try {
    claims = verifyMediaToken(mediaTokenFromRequest(req), {
      mediaId: req.params.id,
      kind: closetMediaTokenKind(kind)
    });
  } catch {
    return null;
  }

  if (kind === 'item') {
    const item = await ClosetItem.findById(req.params.id).select('image user').lean();
    if (!item || documentId(item.user) !== documentId(claims.sub)) return null;
    return { file: item.image, label: 'closet item' };
  }

  if (kind === 'outfit' || kind === 'garment') {
    const outfit = await ClosetOutfit.findById(req.params.id).select('image garment user').lean();
    if (!outfit || documentId(outfit.user) !== documentId(claims.sub)) return null;
    return {
      file: kind === 'garment' ? outfit.garment : outfit.image,
      label: kind === 'garment' ? 'closet garment' : 'closet outfit'
    };
  }

  return null;
}

router.get('/media/:kind/:id', async (req, res) => {
  const kind = String(req.params.kind || '').toLowerCase();
  try {
    const result = await requireClosetMediaAccess(req, kind);
    if (!result) return res.status(401).json({ message: 'Closet media link expired' });
    if (!result.file?.path && !result.file?.url && !result.file?.remoteUrl) {
      return res.status(404).json({ message: 'Closet media not found' });
    }
    const stored = await readStoredFile(result.file, result.label);
    res.set({
      'Content-Type': stored.mimetype || result.file.mimetype || 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    });
    return res.send(stored.buffer);
  } catch (error) {
    console.error('closet_media_proxy_failed', { kind, id: req.params.id, error });
    return res.status(502).json({ message: 'Closet media is temporarily unavailable' });
  }
});

router.get('/', requireUser, closetReadLimiter, async (req, res) => {
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

router.post('/items/analyze', requireUser, closetUploadLimiter, upload.single('item'), async (req, res) => {
  const timer = createTimer('analyze-item', { userId: req.user._id.toString() });
  try {
    if (!req.file) return res.status(400).json({ message: 'Upload a clothing image first' });
    const normalized = await normalizeUpload(req.file, 'closet item', timer);
    const visualProfile = await analyzeClosetItemImage(normalized, timer);
    if (!visualProfile || visualProfile.unavailable) {
      return res.status(503).json({ message: visualProfile?.reason || 'Closet image analysis is not available right now.' });
    }
    timer.end({ category: visualProfile.category, color: visualProfile.primaryColor, cost: visualProfile.cost });
    res.json({
      details: detailsFromVisualProfile(visualProfile),
      visualProfile
    });
  } catch (error) {
    const message = readableError(error, 'Could not analyze closet item');
    timer.end({ error: message });
    res.status(400).json({ message });
  }
});

router.post('/items', requireUser, closetUploadLimiter, upload.single('item'), async (req, res) => {
  const timer = createTimer('upload-item', { userId: req.user._id.toString() });
  try {
    if (!req.file) return res.status(400).json({ message: 'Upload a clothing image first' });
    const normalized = await normalizeUpload(req.file, 'closet item', timer);
    const sourceText = `${req.file.originalname || ''} ${req.body?.name || ''} ${req.body?.tags || ''}`;
    let visualProfile = visualProfileFromBody(req.body?.visualProfile);
    if (!visualProfile) {
      try {
        visualProfile = await analyzeClosetItemImage(normalized, timer);
        if (visualProfile?.unavailable) visualProfile = null;
      } catch (error) {
        timer.mark('closet vision fallback', { error: readableError(error) });
      }
    } else {
      timer.mark('closet vision reused', {
        category: visualProfile.category,
        color: visualProfile.primaryColor,
        cost: visualProfile.cost
      });
    }
    const image = await saveUploadFile(normalized, 'closet-item', req.user, 'closet');
    const detectedDetails = detailsFromVisualProfile(visualProfile) || {};
    const detectedOccasions = detectedDetails.occasions || [];
    const detectedTags = detectedDetails.tags || [];
    const userOccasions = cleanList(req.body?.occasions);
    const userTags = cleanList(req.body?.tags);
    const season = cleanWord(req.body?.season)
      || detectedDetails.season
      || 'all-season';
    const item = await ClosetItem.create({
      user: req.user._id,
      name: cleanWord(req.body?.name, detectedDetails.name || path.parse(req.file.originalname || 'Closet item').name || 'Closet item'),
      category: cleanWord(req.body?.category) ? normalizeCategory(req.body.category, sourceText) : (detectedDetails.category || normalizeCategory('', sourceText)),
      color: cleanWord(req.body?.color) || detectedDetails.color || inferColor('', sourceText),
      fabric: cleanWord(req.body?.fabric) || detectedDetails.fabric || '',
      pattern: cleanWord(req.body?.pattern) || detectedDetails.pattern || '',
      season: season.toLowerCase(),
      formality: cleanWord(req.body?.formality) ? inferFormality(req.body.formality, sourceText) : (detectedDetails.formality || inferFormality('', sourceText)),
      occasions: [...new Set([...userOccasions, ...detectedOccasions])].slice(0, 12),
      tags: [...new Set([...userTags, ...detectedTags])].slice(0, 12),
      favorite: ['1', 'true', 'yes', 'on'].includes(String(req.body?.favorite || '').toLowerCase()),
      image,
      visualProfile
    });
    timer.end({ itemId: item._id.toString() });
    res.status(201).json({ item: item.toClient() });
  } catch (error) {
    const message = readableError(error, 'Could not save closet item');
    timer.end({ error: message });
    res.status(400).json({ message });
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
  if (req.body?.favorite !== undefined) updates.favorite = Boolean(req.body.favorite);
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

router.post('/suggest', requireUser, closetChatLimiter, async (req, res) => {
  const items = await ClosetItem.find({ user: req.user._id }).sort({ favorite: -1, updatedAt: -1 });
  const context = {
    occasion: cleanWord(req.body?.occasion, 'today'),
    weather: cleanWord(req.body?.weather),
    mood: cleanWord(req.body?.mood)
  };
  res.json({ suggestions: buildSuggestions(items, context) });
});

router.post('/chat', requireUser, closetChatLimiter, async (req, res) => {
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
  const analyticsStartedAt = Date.now();
  const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 5);
  const timer = createTimer('generate-outfit', { userId: req.user._id.toString(), itemCount: itemIds.length });
  let reserved = false;
  try {
    if (!itemIds.length) {
      await recordGenerationMetric({ user: req.user._id, type: 'closet_image', status: 'rejected', provider: 'fitroom', model: 'fitroom/tryon-v2', durationMs: Date.now() - analyticsStartedAt, error: 'Select at least one closet item' });
      return res.status(400).json({ message: 'Select at least one closet item.' });
    }
    ensureTryOnProfileReady(req.user);
    const foundItems = await ClosetItem.find({ user: req.user._id, _id: { $in: itemIds } });
    if (foundItems.length !== itemIds.length) return res.status(404).json({ message: 'One or more closet items were not found.' });
    const itemsById = new Map(foundItems.map((item) => [item._id.toString(), item]));
    const items = itemIds.map((id) => itemsById.get(id)).filter(Boolean);
    const fitRoomPlan = selectFitRoomClosetPlan(items);
    const chargedUser = await reserveToken(req.user, timer);
    if (!chargedUser) {
      timer.end({ error: 'insufficient tokens' });
      await recordGenerationMetric({ user: req.user._id, type: 'closet_image', status: 'rejected', provider: 'fitroom', model: 'fitroom/tryon-v2', durationMs: Date.now() - analyticsStartedAt, error: 'insufficient tokens' });
      return res.status(402).json({ message: 'Not enough tokens for AI outfit generation' });
    }
    reserved = true;
    req.user = chargedUser;

    const garment = await combinedGarmentFromItems(items, timer);
    const generated = await generateClosetTryOn({ user: req.user, plan: fitRoomPlan, garment, timer });
    const garmentFile = await saveUploadFile({ buffer: garment.bytes, mimetype: garment.mimetype, size: garment.bytes.length }, 'closet-combo', req.user, 'closet-outfits');
    const imageFile = await saveUploadFile({ buffer: generated.bytes, mimetype: generated.mimetype, size: generated.bytes.length }, 'closet-outfit', req.user, 'closet-outfits');
    const isolation = await isolateSubjectAsset({ rootDir, user: req.user, storedImage: imageFile });
    if (isolation.metadata.processingStatus === 'completed') timer.mark('subject isolation completed', { cached: isolation.cached, path: isolation.image?.path });
    else timer.mark('subject isolation failed', { error: isolation.metadata.processingError });
    let displayImageFile = imageFile;
    if (isolation.metadata.processingStatus === 'completed' && isolation.image) {
      try {
        displayImageFile = await greyStudioOutfitFromTransparent(isolation.image, req.user, timer) || imageFile;
      } catch (error) {
        timer.mark('grey studio wardrobe composite failed', { error: readableError(error) });
      }
    }
    const outfit = await ClosetOutfit.create({
      user: req.user._id,
      title: cleanWord(req.body?.title, `Closet look for ${cleanWord(req.body?.occasion, 'today')}`),
      occasion: cleanWord(req.body?.occasion),
      weather: cleanWord(req.body?.weather),
      mood: cleanWord(req.body?.mood),
      backdrop: 'neutral grey studio',
      pose: cleanWord(req.body?.pose),
      lighting: cleanWord(req.body?.lighting),
      notes: cleanWord(req.body?.notes, 'Use a seamless neutral grey studio background. No room or lifestyle scene.').slice(0, 500),
      plannedFor: cleanDate(req.body?.plannedFor),
      itemIds: items.map((item) => item._id),
      provider: generated.provider || 'fitroom',
      model: generated.model || 'fitroom/tryon-v2',
      quality: generated.quality || (fitRoomHdMode() ? 'hd' : 'standard'),
      tokenCost: chargedTokenCost(req.user),
      garment: garmentFile,
      image: displayImageFile,
      transparentImage: isolation.image || undefined,
      imageProcessing: isolation.metadata
    });
    await ClosetItem.updateMany({ _id: { $in: items.map((item) => item._id) }, user: req.user._id }, { $inc: { wearCount: 1 }, $set: { lastWornAt: new Date() } });
    timer.end({ outfitId: outfit._id.toString(), tokensRemaining: req.user.tokens });
    await recordGenerationMetric({ user: req.user._id, type: 'closet_image', status: 'succeeded', provider: outfit.provider, model: outfit.model, tokensCharged: chargedTokenCost(req.user), durationMs: Date.now() - analyticsStartedAt });
    res.status(201).json({ outfit: outfitToClient(outfit, items), user: req.user.toClient() });
  } catch (error) {
    const tokensRefunded = reserved ? chargedTokenCost(req.user) : 0;
    if (reserved) req.user = await refundToken(req.user, timer);
    const message = readableError(error, 'Could not generate closet outfit');
    timer.end({ error: message });
    await recordGenerationMetric({ user: req.user._id, type: 'closet_image', status: 'failed', provider: 'fitroom', model: 'fitroom/tryon-v2', durationMs: Date.now() - analyticsStartedAt, tokensCharged: tokensRefunded, tokensRefunded, error: message });
    res.status(400).json({ message });
  }
});

router.patch('/outfits/:id', requireUser, async (req, res) => {
  const updates = {};
  if (req.body?.favorite !== undefined) updates.favorite = Boolean(req.body.favorite);
  if (req.body?.title !== undefined) updates.title = cleanWord(req.body.title, 'Generated outfit');
  if (req.body?.plannedFor !== undefined) updates.plannedFor = cleanDate(req.body.plannedFor);
  const outfit = await ClosetOutfit.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: updates }, { new: true });
  if (!outfit) return res.status(404).json({ message: 'Closet outfit not found' });
  const items = await ClosetItem.find({ user: req.user._id, _id: { $in: outfit.itemIds } });
  res.json({ outfit: outfitToClient(outfit, items) });
});

export { closetMediaTokenKind, imageMimeTypeFromBytes, itemToClient, outfitToClient, selectFitRoomClosetPlan };
export default router;
