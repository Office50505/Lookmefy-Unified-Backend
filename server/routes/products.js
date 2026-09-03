import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import multer from 'multer';
import path from 'node:path';
import Product, { productToAdminClient, productToClient } from '../models/Product.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import { requireUser } from './auth.js';
import { clearRecommendationCaches } from './recommendations.js';
import { inferTryOnModel, normalizeTryOnModel } from '../utils/tryOnModel.js';
import { createHybridCache } from '../utils/cache.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { wearableCompatibility } from '../utils/wearable.js';
import { genderCompatibility, genderedSearchQuery, genderPreferenceForQuery } from '../utils/genderPreference.js';
import { enqueueJob, safeJobId } from '../utils/jobQueue.js';
import { recordAdminAudit } from '../utils/adminAudit.js';
import { requireAdmin, requireAdminSection } from '../utils/adminAccess.js';
import { ADMIN_SECTIONS } from '../utils/adminPermissions.js';
import { deleteStoredFile, saveBuffer, useBunny } from '../utils/storage.js';
import { isAllowedRasterImageUpload, normalizeRasterImageBuffer, safeFetchImageBuffer, safeFetchText } from '../utils/security.js';
import {
  MAX_QUANTITY as SMART_IMPORT_DEFAULT_MAX,
  amazonAsin,
  catalogIntentCompatibility,
  parseCatalogCommand
} from '../services/catalogAutomation.js';
import { catalogSearchProviderName, searchSerpApiAmazon } from '../services/catalogSearchProvider.js';
import {
  PRODUCT_AVAILABILITY_STATUSES,
  adminAvailabilityClause,
  availabilityUpdate,
  availableStatusClause,
  normalizeAvailabilityStatus
} from '../utils/productAvailability.js';

const router = express.Router();
const requireUserOperationsAdmin = requireAdminSection(ADMIN_SECTIONS.USER_OPERATIONS);
const readCacheTtlMs = Number(process.env.PRODUCT_READ_CACHE_TTL_MS || 5 * 60 * 1000);
const productListCache = createHybridCache('products:list', { ttlMs: readCacheTtlMs, maxItems: 150 });
const productDetailCache = createHybridCache('products:detail', { ttlMs: readCacheTtlMs, maxItems: 300 });
const productReadLimiter = createRateLimiter({
  name: 'products:read',
  windowMs: 5 * 60 * 1000,
  max: 600,
  keyGenerator: rateLimitKeys.clientIp,
  message: 'Catalog browsing is temporarily limited from this network. Please try again shortly.'
});
const amazonSearchLimiter = createRateLimiter({
  name: 'products:amazon-search',
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many style bot searches. Please wait a few minutes before searching again.'
});
const adminProductWriteLimiter = createRateLimiter({
  name: 'products:admin-write',
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Too many product admin actions. Please pause briefly and try again.'
});

async function clearProductReadCaches() {
  await Promise.all([
    productListCache.clear(),
    productDetailCache.clear()
  ]);
}

async function clearReadCachesAfterProductWrite() {
  await Promise.all([
    clearProductReadCaches(),
    clearRecommendationCaches()
  ]);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '');
      cb(null, `product-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, isAllowedRasterImageUpload(file));
  }
});

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 'on' || value === '1';
}

function normalizeGarmentPlacement(value, product = {}) {
  const explicit = String(value || '').trim().toLowerCase();
  if (explicit === 'accessory' || explicit === 'accessories') return 'accessory';
  if (explicit === 'full-body' || explicit === 'full_body' || explicit === 'full body' || explicit === 'full' || explicit === 'outfit' || explicit === 'one-piece' || explicit === 'one piece') return 'full-body';
  if (explicit === 'bottom' || explicit === 'bottomwear' || explicit === 'lower') return 'bottom';
  if (explicit === 'top' || explicit === 'topwear' || explicit === 'upper') return 'top';
  const text = [
    product.name,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(outfits?|sets?|co-?ords?|coordinated|tracksuits?|suits?|jumpsuits?|rompers?|playsuits?|dress(?:es)?|gowns?|sarees?|saris?|lehenga(?:s)?|kurta\s?sets?)\b/.test(text)) return 'full-body';
  if (/\b(pants?|trousers?|jeans?|denim|shorts?|skirts?|leggings?|joggers?|palazzos?|bottoms?|lower)\b/.test(text)) return 'bottom';
  return 'top';
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

function cleanUrl(value) {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function highResolutionAmazonImageUrl(value) {
  const url = cleanUrl(value);
  if (!url || !/(?:m\.media-amazon\.(?:com|in)|images-(?:na|eu|fe)\.ssl-images-amazon\.com)\/images\//i.test(url)) return url;
  if (/\._[^.]*_\.(?=(?:avif|jpe?g|png|webp)(?:[?#]|$))/i.test(url)) {
    return url.replace(/\._[^.]*_\.(?=(?:avif|jpe?g|png|webp)(?:[?#]|$))/i, '._AC_SL1500_.');
  }
  return url.replace(/\.((?:avif|jpe?g|png|webp)(?:[?#].*)?)$/i, '._AC_SL1500_.$1');
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function getTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/<[^>]+>/g, '')) : '';
}

function getMeta(html, keys) {
  const tags = html.match(/<meta\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)=["']([^"']*)["']/g)) attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
    const metaKey = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (keys.includes(metaKey) && attrs.content) return attrs.content;
  }
  return '';
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getElementTextById(html, ids) {
  for (const id of ids) {
    const safeId = escapeRegExp(id);
    const match = html.match(new RegExp(`<([a-z0-9-]+)[^>]*id=["']${safeId}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'));
    if (match) {
      const text = stripTags(match[2]);
      if (text) return text;
    }
  }
  return '';
}

function uniqueList(items, limit = 16) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const value = decodeHtml(item || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function getFeatureBulletList(html) {
  const section = html.match(/<[^>]+id=["']feature-bullets["'][^>]*>([\s\S]*?)(?:<\/div>|<\/ul>)/i)?.[1] || '';
  if (!section) return [];
  return [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripTags(match[1]))
    .map((item) => item.replace(/^[-•\s]+/, '').trim())
    .filter((item) => item && !/make sure this fits/i.test(item))
    .slice(0, 5);
}

function getFeatureBullets(html) {
  return getFeatureBulletList(html).join(' ');
}

function normalizedFactKey(value = '') {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProductFacts(html) {
  const facts = new Map();
  const remember = (label, value) => {
    const key = normalizedFactKey(label).replace(/\b(?:item|product)\b/g, '').trim();
    const cleanValue = decodeHtml(value)
      .replace(/^[\s:;,-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!key || !cleanValue || cleanValue.length > 180) return;
    if (looksLikeSizeChartText(label) || looksLikeSizeChartText(cleanValue)) return;
    if (/customer reviews|best sellers rank|date first available|asin|dimensions|weight/i.test(key)) return;
    if (!facts.has(key)) facts.set(key, cleanValue);
  };

  for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => stripTags(cell[1]));
    if (cells.length >= 2) remember(cells[0], cells.slice(1).join(' '));
  }

  for (const match of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = stripTags(match[1]).replace(/[\u200e\u200f\u202a-\u202e]/g, ' ');
    const parts = text.split(/\s*[:：]\s*/);
    if (parts.length >= 2) remember(parts[0], parts.slice(1).join(': '));
  }

  for (const match of html.matchAll(/<span[^>]+class=["'][^"']*a-text-bold[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/gi)) {
    remember(match[1], match[2]);
  }

  return facts;
}

function factValue(facts, keys) {
  for (const key of keys) {
    const normalized = normalizedFactKey(key);
    if (facts.has(normalized)) return facts.get(normalized);
    for (const [factKey, value] of facts.entries()) {
      if (factKey === normalized || factKey.endsWith(` ${normalized}`) || factKey.includes(normalized)) return value;
    }
  }
  return '';
}

function looksLikeSizeChartText(value = '') {
  const text = decodeHtml(value)
    .toLowerCase()
    .replace(/[\u200e\u200f\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  if (/\blabel\s+size\b/.test(text)) return true;
  const hits = ['bust', 'waist', 'hip', 'hips', 'chest', 'shoulder', 'sleeve', 'length', 'inseam']
    .filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(text)).length;
  return hits >= 2 && /\b(size|cm|in|inch|inches)\b/i.test(text);
}

function cleanBrand(value = '') {
  let brand = decodeHtml(value)
    .replace(/\s+/g, ' ')
    .replace(/^brand\s*[:：]\s*/i, '')
    .replace(/^by\s+/i, '')
    .replace(/^visit\s+the\s+(.+?)\s+store$/i, '$1')
    .replace(/^visit\s+(.+?)\s+store$/i, '$1')
    .replace(/^shop\s+/i, '')
    .replace(/\s+official\s+store$/i, '')
    .replace(/\s+store$/i, '')
    .trim();
  brand = brand.replace(/^[^\w]+|[^\w&'. -]+$/g, '').trim();
  if (!brand || brand.length > 60) return '';
  if (looksLikeSizeChartText(brand)) return '';
  if (/^(amazon|amazon\.com|www\.amazon\.com)$/i.test(brand)) return '';
  return brand;
}

function getBylineBrand(html) {
  return cleanBrand(getElementTextById(html, ['bylineInfo', 'brand', 'brandBylineWrapper']));
}

function getSchemaBrand(product) {
  return cleanBrand(typeof product?.brand === 'string' ? product.brand : product?.brand?.name);
}

function titleBrandCandidate(title = '') {
  const cleaned = decodeHtml(title).replace(/[|–-].*$/, '').trim();
  const match =
    cleaned.match(/^([A-Z][A-Za-z0-9&'.-]{1,}(?:\s+[A-Z][A-Za-z0-9&'.-]{1,})?)\s+(?:women'?s|men'?s|girls?|boys?|unisex)\b/i) ||
    cleaned.match(/^([A-Z0-9][A-Za-z0-9&'.-]{2,})\s+(?:shirt|dress|jeans|jacket|kurta|saree|sunglasses|watch|shoes|sneakers)\b/i) ||
    cleaned.match(/^([A-Z0-9][A-Za-z0-9&'.-]{2,})\s+.+\b(?:shirt|dress|jeans|jacket|kurta|saree|sunglasses|watch|shoes|sneakers)\b/i);
  const candidate = cleanBrand(match?.[1] || '');
  if (!candidate || /^(women|woman|men|man|girls|boys|unisex|casual|fashion|generic|black|white|blue|green|red|pink|beige|brown|grey|gray|solid)$/i.test(candidate)) return '';
  return candidate;
}

function getBestBrand({ product, facts, html, finalUrl, title }) {
  const candidates = [
    getSchemaBrand(product),
    getBylineBrand(html),
    cleanBrand(getMeta(html, ['product:brand'])),
    titleBrandCandidate(title),
    cleanBrand(factValue(facts, ['brand'])),
    cleanBrand(factValue(facts, ['manufacturer'])),
    cleanBrand(hostBrand(finalUrl))
  ];
  return candidates.find(Boolean) || 'Brand unavailable';
}

function getAttributeFromId(html, id, attrs) {
  const safeId = escapeRegExp(id);
  const tag = html.match(new RegExp(`<[^>]+id=["']${safeId}["'][^>]*>`, 'i'))?.[0] || '';
  if (!tag) return '';
  for (const attr of attrs) {
    const safeAttr = escapeRegExp(attr);
    const match = tag.match(new RegExp(`${safeAttr}=["']([^"']+)["']`, 'i'));
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function getDynamicImage(html) {
  const raw =
    getAttributeFromId(html, 'landingImage', ['data-a-dynamic-image', 'data-old-hires', 'src']) ||
    getAttributeFromId(html, 'imgTagWrapperId', ['data-a-dynamic-image', 'data-old-hires', 'src']);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) return highResolutionAmazonImageUrl(raw);
  try {
    const images = JSON.parse(decodeHtml(raw));
    const [bestUrl = ''] = Object.entries(images)
      .filter(([url]) => /^https?:\/\//i.test(url))
      .sort(([, a], [, b]) => {
        const [aw = 0, ah = 0] = Array.isArray(a) ? a : [];
        const [bw = 0, bh = 0] = Array.isArray(b) ? b : [];
        return (Number(bw) * Number(bh)) - (Number(aw) * Number(ah));
      })[0] || [];
    return highResolutionAmazonImageUrl(bestUrl) || '';
  } catch {
    return '';
  }
}

function getVisibleImage(html) {
  return (
    getDynamicImage(html) ||
    getAttributeFromId(html, 'landingImage', ['data-old-hires', 'src']) ||
    html.match(/<img[^>]+itemprop=["']image["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
    ''
  );
}

function getLink(html, rel) {
  const tags = html.match(/<link\s+[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(/([\w:-]+)=["']([^"']*)["']/g)) attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
    if ((attrs.rel || '').toLowerCase().split(/\s+/).includes(rel) && attrs.href) return attrs.href;
  }
  return '';
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function schemaTypes(value) {
  return toArray(value?.['@type'] || value?.type).map((item) => String(item).toLowerCase());
}

function hasProductShape(value) {
  if (!value || typeof value !== 'object') return false;
  const keys = Object.keys(value).map((key) => key.toLowerCase());
  const hasName = typeof value.name === 'string' || typeof value.title === 'string';
  const hasCommercialData = keys.some((key) => ['offers', 'price', 'saleprice', 'compareatprice', 'brand', 'image', 'images'].includes(key));
  return hasName && hasCommercialData;
}

function findProductSchema(value, depth = 0) {
  if (!value) return null;
  if (depth > 10) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductSchema(item, depth + 1);
      if (found) return found;
    }
  }
  if (typeof value !== 'object') return null;
  const type = schemaTypes(value);
  if (type.includes('product') || hasProductShape(value)) return value;

  const priorityKeys = ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'product', 'products', 'props', 'pageProps', 'initialState'];
  for (const key of priorityKeys) {
    const found = findProductSchema(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findProductSchema(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseJsonLdProduct(html) {
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const json = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const product = findProductSchema(JSON.parse(decodeHtml(json)));
      if (product) return product;
    } catch {
      // Some storefronts emit malformed JSON-LD; meta tags still give us a useful draft.
    }
  }
  return null;
}

function parseEmbeddedProduct(html) {
  const scripts = html.match(/<script[^>]*(?:id=["']__NEXT_DATA__["']|type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const script of scripts) {
    const json = script.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    if (!json || json.length > 2_000_000) continue;
    try {
      const product = findProductSchema(JSON.parse(decodeHtml(json)));
      if (product) return product;
    } catch {
      // Embedded storefront state is useful when valid, but many sites include non-JSON scripts.
    }
  }
  return null;
}

function firstImage(value) {
  const image = toArray(value)[0];
  if (!image) return '';
  if (typeof image === 'string') return highResolutionAmazonImageUrl(image);
  return highResolutionAmazonImageUrl(image.url || image.contentUrl) || '';
}

function productOffer(product) {
  const offer = toArray(product?.offers || product?.offer || product?.priceSpecification)[0];
  if (!offer) return {};
  if (offer.offers) return toArray(offer.offers)[0] || offer;
  if (offer.priceSpecification) return toArray(offer.priceSpecification)[0] || offer;
  return offer;
}

function hostBrand(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    return '';
  }
}

const categoryRules = [
  ['ethnic wear', /\b(sarees?|saris?|lehenga(?:s)?|dupatta(?:s)?|kurta(?:s)?|kurtis?|salwar(?:s)?|churidar(?:s)?|anarkali|palazzo(?:s)?|ethnic|traditional|sharara(?:s)?)\b/i, 28],
  ['eyewear', /\b(sun\s*glasses|sunglasses|eye\s*glasses|eyeglasses|glasses|spectacles?|optical\s*frames?|frames?|lenses?|goggles?|aviator|wayfarer)\b/i, 30],
  ['innerwear', /\b(underwear|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear|bikinis?|swimsuits?|swimwear|monokinis?|tankinis?)\b/i, 30],
  ['sleepwear', /\b(night(?:y|ie|wear|gown|suit|dress)|sleepwear|pajamas?|pyjamas?|loungewear|robe)\b/i, 26],
  ['dresses', /\b(dress(?:es)?|gowns?|bodycon|maxi|midi|mini\s*dress|a-line\s*dress|wrap\s*dress|party\s*dress)\b/i, 24],
  ['skirts', /\b(skirts?|skorts?)\b/i, 24],
  ['watches', /\b(watches?|smart\s*watches?|smartwatch(?:es)?|chronograph)\b/i, 24],
  ['shoes', /\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?)\b/i, 24],
  ['bags', /\b(wallets?|purses?|backpacks?|handbags?|totes?|sling\s*bags?|crossbody|duffels?|clutches?)\b/i, 24],
  ['accessories', /\b(belts?|caps?|hats?|scarves?|ties?|jewellery|jewelry|necklaces?|bracelets?|earrings?|accessor(?:y|ies))\b/i, 18],
  ['jeans', /\b(jeans?|denim\s*(?:jeans|pants|trousers)?)\b/i, 23],
  ['shorts', /\b(shorts?|bermudas?)\b/i, 23],
  ['pants', /\b(pants?|trousers?|joggers?|leggings?|chinos?|cargo\s*pants?|track\s*pants?|bottomwear)\b/i, 21],
  ['sweatshirts', /\b(hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?)\b/i, 20],
  ['jackets', /\b(jackets?|overshirts?|blazers?|coats?|windcheaters?|parkas?|shrugs?)\b/i, 20],
  ['t-shirts', /\b(t\s*-?\s*shirts?|tshirts?|tees?|polo\s*(?:shirts?)?)\b/i, 19],
  ['shirts', /\b(shirts?|button\s*(?:down|up)|formal\s*shirt|casual\s*shirt)\b/i, 16],
  ['tops', /\b(tops?|blouses?|tunics?|crop\s*tops?|tank\s*tops?|camis?)\b/i, 16]
];

function categoryScore(text = '', weight = 1) {
  const scores = new Map();
  for (const [category, pattern, points] of categoryRules) {
    if (pattern.test(text)) scores.set(category, (scores.get(category) || 0) + points * weight);
  }
  return scores;
}

function inferCategory(input = '') {
  const parts = typeof input === 'object' && input ? input : { title: input };
  const scores = new Map();
  const apply = (text, weight) => {
    for (const [category, points] of categoryScore(String(text || ''), weight)) {
      scores.set(category, (scores.get(category) || 0) + points);
    }
  };

  apply(parts.title, 3);
  apply(parts.facts, 2);
  apply(parts.bullets, 1.4);
  apply(parts.description, 1);
  apply(parts.query, 1.6);

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] || 'clothing';
}

function inferGender(text = '') {
  const value = text.toLowerCase();
  if (/\b(women|woman|female|girls|ladies|maternity)\b/.test(value)) return 'women';
  if (/\b(men|man|male|boys|gentlemen)\b/.test(value)) return 'men';
  return 'unisex';
}

function collectKeywordTags(text = '') {
  const value = ` ${text.toLowerCase()} `;
  const keywords = [
    ['cotton', /\bcotton\b/],
    ['linen', /\blinen\b/],
    ['denim', /\bdenim\b/],
    ['leather', /\bleather\b/],
    ['silk', /\bsilk\b/],
    ['satin', /\bsatin\b/],
    ['wool', /\bwool\b/],
    ['fleece', /\bfleece\b/],
    ['chiffon', /\bchiffon\b/],
    ['rayon', /\brayon\b/],
    ['polyester', /\bpolyester\b/],
    ['spandex', /\b(spandex|elastane|stretch)\b/],
    ['slim fit', /\bslim\s+fit\b/],
    ['regular fit', /\bregular\s+fit\b/],
    ['relaxed fit', /\brelaxed\s+fit\b/],
    ['oversized', /\boversized\b/],
    ['cropped', /\bcropped\b/],
    ['sleeveless', /\bsleeveless\b/],
    ['long sleeve', /\blong\s+sleeve\b/],
    ['short sleeve', /\bshort\s+sleeve\b/],
    ['v-neck', /\bv\s*-?\s*neck\b/],
    ['crew neck', /\bcrew\s+neck\b/],
    ['collared', /\bcollar(?:ed)?\b/],
    ['button down', /\bbutton\s+down\b/],
    ['zipper', /\bzip(?:per)?\b/],
    ['casual', /\bcasual\b/],
    ['formal', /\bformal\b/],
    ['party', /\bparty\b/],
    ['office', /\boffice\b/],
    ['workwear', /\bwork\s*wear\b/],
    ['summer', /\bsummer\b/],
    ['winter', /\bwinter\b/],
    ['black', /\bblack\b/],
    ['white', /\bwhite\b/],
    ['blue', /\bblue\b/],
    ['green', /\bgreen\b/],
    ['red', /\bred\b/],
    ['pink', /\bpink\b/],
    ['beige', /\bbeige|cream|ivory\b/],
    ['brown', /\bbrown|tan|camel\b/],
    ['grey', /\bgr[ae]y\b/],
    ['gold', /\bgold(?:en)?\b/],
    ['silver', /\bsilver\b/],
    ['printed', /\b(print|printed|pattern|floral|striped|checked|plaid)\b/],
    ['solid', /\bsolid\b/]
  ];
  return keywords.filter(([, pattern]) => pattern.test(value)).map(([tag]) => tag);
}

function factTags(facts) {
  const entries = [
    factValue(facts, ['material', 'fabric type', 'outer material', 'sole material']),
    factValue(facts, ['fit type']),
    factValue(facts, ['neck style']),
    factValue(facts, ['sleeve type', 'sleeve length']),
    factValue(facts, ['closure type']),
    factValue(facts, ['pattern']),
    factValue(facts, ['color', 'colour'])
  ];
  return entries
    .flatMap((value) => String(value || '').split(/[,/|;]/))
    .map((value) => value.toLowerCase().replace(/\s+/g, ' ').trim())
    .filter((value) => value && value.length <= 28 && !/care instructions|machine wash|hand wash/i.test(value));
}

function buildProductTags({ title, description, bullets, brand, category, gender, facts }) {
  const text = [title, description, bullets.join(' '), [...facts.values()].join(' ')].join(' ');
  const tags = [
    category,
    gender !== 'unisex' ? gender : '',
    cleanBrand(brand),
    ...factTags(facts),
    ...collectKeywordTags(text)
  ];
  return uniqueList(
    tags
      .map((tag) => String(tag || '').toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((tag) => tag && !['amazon', 'amazon.com', 'brand unavailable', 'clothing'].includes(tag)),
    14
  );
}

const colorKeywords = [
  'black',
  'white',
  'pink',
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'violet',
  'orange',
  'brown',
  'beige',
  'cream',
  'ivory',
  'grey',
  'gray',
  'gold',
  'silver',
  'maroon',
  'navy',
  'teal',
  'olive',
  'khaki'
];

function normalizeColorWord(value = '') {
  const text = String(value || '').toLowerCase().trim();
  if (text === 'gray') return 'grey';
  if (text === 'off white' || text === 'off-white') return 'white';
  return text;
}

function colorWordsFromText(value = '') {
  const text = ` ${String(value || '').toLowerCase().replace(/[-_/]+/g, ' ')} `;
  return uniqueList(
    colorKeywords
      .filter((color) => new RegExp(`\\b${escapeRegExp(color)}\\b`, 'i').test(text))
      .map(normalizeColorWord),
    8
  );
}

function colorsFromFacts(facts) {
  const explicit = factValue(facts, ['color', 'colour']);
  return uniqueList(
    String(explicit || '')
      .split(/[,/|;&]+|\band\b/i)
      .flatMap((item) => colorWordsFromText(item).length ? colorWordsFromText(item) : [decodeHtml(item).toLowerCase().trim()])
      .map(normalizeColorWord)
      .filter((item) => item && item.length <= 24 && !looksLikeSizeChartText(item)),
    8
  );
}

function normalizeSizeOption(value = '') {
  const raw = decodeHtml(value).replace(/\s+/g, ' ').trim();
  if (/^(?:free|one)\s+size$/i.test(raw)) return raw.toUpperCase();
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/\b(?:select|choose|size|size name|please select|one size fits all)\b/gi, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .trim()
    .toUpperCase();
  if (!text || text.length > 18 || looksLikeSizeChartText(text)) return '';
  if (/^(?:XS|S|M|L|XL|XXL|XXXL|[2-9]XL|FREE SIZE|ONE SIZE)$/.test(text)) return text;
  if (/^(?:UK|US|EU|IND)?\s*\d{1,2}(?:\.\d)?(?:\s*[-/]\s*\d{1,2}(?:\.\d)?)?$/.test(text)) return text.replace(/\s+/g, ' ');
  if (/^\d{1,2}\s*-\s*\d{1,2}\s*(?:Y|YEARS?)$/.test(text)) return text.replace(/\s+/g, ' ');
  return '';
}

function sizesFromText(value = '') {
  const text = decodeHtml(value);
  if (!text || looksLikeSizeChartText(text)) return [];
  return uniqueList(
    text
      .split(/[,/|;&]+|\s{2,}|\band\b/i)
      .map(normalizeSizeOption)
      .filter(Boolean),
    18
  );
}

function getSelectOptionsById(html, ids) {
  const options = [];
  for (const id of ids) {
    const safeId = escapeRegExp(id);
    const match = html.match(new RegExp(`<select[^>]+id=["']${safeId}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
    if (!match) continue;
    for (const option of match[1].matchAll(/<option[^>]*>([\s\S]*?)<\/option>/gi)) {
      const size = normalizeSizeOption(stripTags(option[1]));
      if (size) options.push(size);
    }
  }
  return uniqueList(options, 18);
}

function extractAvailableSizes(html, facts) {
  const fromSelect = getSelectOptionsById(html, [
    'native_dropdown_selected_size_name',
    'dropdown_selected_size_name',
    'size_name',
    'variation_size_name'
  ]);
  const fromFacts = sizesFromText(factValue(facts, ['size', 'sizes', 'available sizes', 'available size']));
  const fromSwatches = [...html.matchAll(/(?:data-a-html-content|title|aria-label)=["']([^"']{1,80})["']/gi)]
    .flatMap((match) => sizesFromText(match[1]));
  return uniqueList([...fromSelect, ...fromFacts, ...fromSwatches], 18);
}

function sizeNotesFromFacts(facts) {
  const note = factValue(facts, ['fit type', 'size chart', 'size guide']);
  if (!note || looksLikeSizeChartText(note)) return '';
  return decodeHtml(note).replace(/\s+/g, ' ').trim().slice(0, 140);
}

function polishedDescription(value = '', { title = '' } = {}) {
  let text = cleanDescription(value)
    .replace(/^buy\s+/i, '')
    .replace(/\s+(?:online|from\s+amazon)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text && title) text = normalizeProductTitle(title);
  return text;
}

function fieldWarning(field, title, detail, level = 'warning') {
  return { field, title, detail, level };
}

function refineProductDraft(draft = {}, context = {}) {
  const warnings = [];
  const titleColors = colorWordsFromText(draft.name);
  const descriptionColors = colorWordsFromText(draft.description);
  const factColors = colorsFromFacts(context.facts || new Map());
  const colors = uniqueList([...factColors, ...titleColors, ...descriptionColors], 8);
  const explicitColorSet = new Set([...factColors, ...descriptionColors]);
  const titleConflict = titleColors.filter((color) => explicitColorSet.size && !explicitColorSet.has(color));

  if (titleConflict.length) {
    warnings.push(fieldWarning(
      'colors',
      'Color conflict',
      `Title mentions ${titleConflict.join(', ')}, but product details mention ${[...explicitColorSet].join(', ')}. Check the selected variant before publishing.`
    ));
  }

  const rating = Number(draft.rating);
  const ratingCount = Number(draft.ratingCount);
  const hasRating = Number.isFinite(rating) && rating > 0;
  const hasRatingCount = Number.isFinite(ratingCount) && ratingCount > 0;
  let safeRating = draft.rating;
  let safeRatingCount = draft.ratingCount;
  if (hasRating && !hasRatingCount) {
    safeRating = '';
    safeRatingCount = '';
    warnings.push(fieldWarning(
      'rating',
      'Rating count missing',
      'The source exposed a star rating without a review count, so rating fields were left blank.'
    ));
  }

  if (draft.remoteImageUrl) {
    warnings.push(fieldWarning(
      'remoteImageUrl',
      'Image will be cached',
      'Publishing with the fetched image now saves a copy into Lookmefy storage instead of relying on the source URL.',
      'info'
    ));
  }

  const explicitPlacement = String(draft.garmentPlacement || '').trim().toLowerCase();
  const placement = explicitPlacement === 'accessory' || explicitPlacement === 'accessories'
    ? 'accessory'
    : ['full-body', 'full_body', 'full body', 'outfit', 'one-piece', 'one piece'].includes(explicitPlacement)
      ? 'full-body'
    : normalizeGarmentPlacement('', draft);
  if (placement === 'full-body') {
    warnings.push(fieldWarning(
      'garmentPlacement',
      'Full-body fit detected',
      'This product looks like a dress, one-piece, or complete outfit and will use full-body try-on prompts.',
      'info'
    ));
  }

  const sizes = uniqueList([...(draft.sizes || []), ...extractAvailableSizes(context.html || '', context.facts || new Map())]
    .map(normalizeSizeOption)
    .filter(Boolean), 18);
  const sizeNotes = String(draft.sizeNotes || sizeNotesFromFacts(context.facts || new Map())).trim();
  if (!sizes.length && /size\s*chart|label\s+size|dropdown_selected_size_name|variation_size_name/i.test(context.html || '')) {
    warnings.push(fieldWarning(
      'sizes',
      'Size options need review',
      'The source had size-related markup, but only chart/noisy size data was found. Add available sizes manually if needed.'
    ));
  }

  return {
    ...draft,
    description: polishedDescription(draft.description, { title: draft.name }),
    rating: safeRating,
    ratingCount: safeRatingCount,
    colors,
    sizes,
    sizeNotes,
    tags: uniqueList(
      (draft.tags || [])
        .map((tag) => String(tag || '').toLowerCase().replace(/\s+/g, ' ').trim())
        .filter((tag) => tag && tag.length <= 32 && !/^(?:cc|care instructions|machine wash|hand wash|\d+(?:\.\d+)?%\s+\w+)$/.test(tag)),
      14
    ),
    garmentPlacement: placement,
    warnings
  };
}

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = priceFromText(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function priceFromText(value) {
  const text = stripTags(value).replace(/,/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const compactCurrency = text.match(/(?:₹|Rs\.?|INR|\$|USD|€|£)\s*(\d{1,8})(\d{2})\b/i);
  if (compactCurrency && compactCurrency[1].length > 2) {
    const parsed = Number(`${compactCurrency[1]}.${compactCurrency[2]}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  const amounts = [...text.matchAll(/\d+(?:\.\d{1,2})?/g)].map((match) => match[0]);
  if (amounts.length === 0) return undefined;
  const [whole, maybeCents] = amounts;
  const valueText = !whole.includes('.') && maybeCents && /^\d{2}$/.test(maybeCents) ? `${whole}.${maybeCents}` : whole;
  const parsed = Number(valueText);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getElementHtmlById(html, ids, length = 8000) {
  for (const id of ids) {
    const safeId = escapeRegExp(id);
    const match = html.match(new RegExp(`<[^>]+id=["']${safeId}["'][^>]*>`, 'i'));
    if (match?.index !== undefined) return html.slice(match.index, match.index + length);
  }
  return '';
}

function pricesFromAmazonMarkup(html = '') {
  const prices = [];
  const remember = (value) => {
    const parsed = priceFromText(value);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 10_000_000) prices.push(parsed);
  };

  const regions = [
    getElementHtmlById(html, ['corePriceDisplay_desktop_feature_div', 'corePrice_feature_div', 'apex_desktop', 'price']),
    html
  ].filter(Boolean);

  for (const region of regions) {
    for (const match of region.matchAll(/<span[^>]+class=["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>(?:\s*<span[^>]+class=["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>)?/gi)) {
      const whole = stripTags(match[1]).replace(/[^\d]/g, '');
      const fraction = stripTags(match[2] || '').replace(/[^\d]/g, '');
      if (!whole) continue;
      remember(fraction ? `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}` : whole);
    }

    for (const match of region.matchAll(/(?:displayPrice|priceToPay|priceAmount|dealPrice|salePrice|currentPrice)["']?\s*[:=]\s*["']([^"']{1,80})["']/gi)) {
      remember(match[1]);
    }

    for (const match of region.matchAll(/(?:priceAmount|amount|salePrice|currentPrice)["']?\s*[:=]\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi)) {
      remember(match[1]);
    }

    for (const match of region.matchAll(/(?:₹|Rs\.?|INR|\$|USD|€|£)\s*[0-9][0-9,]*(?:\.\d{1,2})?/gi)) {
      remember(match[0]);
    }

    if (prices.length) break;
  }

  return [...new Set(prices)];
}

function visiblePrice(html) {
  const priceText =
    getElementTextById(html, ['priceblock_dealprice', 'priceblock_ourprice', 'price_inside_buybox', 'corePriceDisplay_desktop_feature_div', 'corePrice_feature_div']) ||
    getMeta(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1']);
  return numberFrom(priceText) || pricesFromAmazonMarkup(html)[0];
}

function visibleComparePrice(html) {
  const text = getElementTextById(html, ['listPrice', 'basisPrice', 'corePriceDisplay_desktop_feature_div']);
  if (!text) return undefined;
  const amounts = [
    ...pricesFromAmazonMarkup(getElementHtmlById(html, ['listPrice', 'basisPrice', 'corePriceDisplay_desktop_feature_div'])),
    ...stripTags(text).replace(/,/g, '').matchAll(/\d+(?:\.\d{1,2})?/g)
  ].map((match) => Array.isArray(match) ? Number(match[0]) : Number(match)).filter(Number.isFinite);
  return amounts.length > 1 ? Math.max(...amounts) : amounts[0];
}

function normalizeCurrency(value = '') {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].includes(text)) return text;
  if (/₹|RS\.?|INR|RUPEE/.test(text)) return 'INR';
  if (/\$|USD/.test(text)) return 'USD';
  if (/€|EUR/.test(text)) return 'EUR';
  if (/£|GBP/.test(text)) return 'GBP';
  if (/CAD/.test(text)) return 'CAD';
  if (/AUD/.test(text)) return 'AUD';
  if (/¥|JPY/.test(text)) return 'JPY';
  return '';
}

function currencyFromUrl(url = '') {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.in')) return 'INR';
    if (host.endsWith('.co.uk')) return 'GBP';
    if (host.endsWith('.ca')) return 'CAD';
    if (host.endsWith('.com.au')) return 'AUD';
    if (host.endsWith('.co.jp')) return 'JPY';
  } catch {
    // Keep currency detection best-effort.
  }
  return '';
}

function visibleCurrency(html, finalUrl) {
  const priceText =
    getElementTextById(html, ['priceblock_dealprice', 'priceblock_ourprice', 'price_inside_buybox', 'corePriceDisplay_desktop_feature_div', 'corePrice_feature_div']) ||
    getMeta(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1']);
  return (
    normalizeCurrency(getMeta(html, ['product:price:currency', 'og:price:currency', 'pricecurrency'])) ||
    normalizeCurrency(priceText) ||
    currencyFromUrl(finalUrl) ||
    'INR'
  );
}

function ratingFrom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value >= 0 && value <= 5 ? Math.round(value * 10) / 10 : undefined;
  const text = stripTags(value).replace(/,/g, '').trim();
  const explicit = text.match(/([0-5](?:\.\d+)?)\s*(?:out\s+of|\/)\s*5/i);
  const starText = text.match(/([0-5](?:\.\d+)?)\s*(?:stars?|rating)/i);
  const parsed = Number((explicit || starText)?.[1]);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) return undefined;
  return Math.round(parsed * 10) / 10;
}

function ratingCountFrom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value >= 0 ? Math.round(value) : undefined;
  const text = stripTags(value).replace(/,/g, '').trim();
  const explicit = text.match(/(\d+)\s*(?:ratings?|reviews?|customer reviews?)/i);
  const parsed = Number(explicit?.[1] || text.match(/^\d+$/)?.[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
}

function productAggregateRating(product) {
  const aggregate = product?.aggregateRating || product?.aggregate_rating || product?.rating;
  if (!aggregate || typeof aggregate !== 'object') return {};
  return {
    rating: ratingFrom(aggregate.ratingValue || aggregate.rating || aggregate.value),
    ratingCount: ratingCountFrom(aggregate.reviewCount || aggregate.ratingCount || aggregate.count)
  };
}

function visibleRating(html) {
  return ratingFrom(
    getAttributeFromId(html, 'acrPopover', ['title', 'aria-label']) ||
      getElementTextById(html, ['acrPopover', 'averageCustomerReviews']) ||
      getMeta(html, ['og:rating', 'product:rating:value', 'rating'])
  );
}

function visibleRatingCount(html) {
  return ratingCountFrom(
    getElementTextById(html, ['acrCustomerReviewText', 'averageCustomerReviews']) ||
      getMeta(html, ['product:rating:count', 'rating_count', 'review_count'])
  );
}

function absoluteUrl(value, base) {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed || /^data:/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed, base).toString();
  } catch {
    return cleanUrl(trimmed);
  }
}

function amazonProductUrl(value, base = 'https://www.amazon.com') {
  if (!value) return '';
  try {
    let url = new URL(decodeHtml(value), base);
    const nested = url.searchParams.get('url') || url.searchParams.get('u');
    if (nested && /\/(?:dp|gp\/product)\//i.test(nested)) url = new URL(decodeURIComponent(nested), base);
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (!match) return '';
    return `${url.origin}/dp/${match[1].toUpperCase()}`;
  } catch {
    return '';
  }
}

function withAmazonAssociateTag(value) {
  const tag = process.env.AMAZON_ASSOCIATE_TAG;
  if (!tag || !value) return value;
  try {
    const url = new URL(value);
    url.searchParams.set('tag', tag);
    return url.toString();
  } catch {
    return value;
  }
}

function extractAmazonSearchResults(html, baseUrl) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/\shref=["']([^"']+)["']/gi)) {
    const productUrl = amazonProductUrl(match[1], baseUrl);
    if (!productUrl || seen.has(productUrl)) continue;
    seen.add(productUrl);
    const region = html.slice(Math.max(0, match.index - 4500), Math.min(html.length, match.index + 6500));
    const image =
      region.match(/<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
      region.match(/<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*s-image[^"']*["']/i)?.[1] ||
      '';
    results.push({
      link: productUrl,
      price: pricesFromAmazonMarkup(region)[0],
      currency: visibleCurrency(region, baseUrl),
      remoteImageUrl: highResolutionAmazonImageUrl(absoluteUrl(image, baseUrl))
    });
  }
  return results;
}

function amazonSearchBaseUrl() {
  const configured = cleanUrl(process.env.AMAZON_SEARCH_BASE_URL || process.env.AMAZON_BASE_URL || 'https://www.amazon.in');
  try {
    const url = new URL(configured);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return 'https://www.amazon.in';
  }
}

function normalizeProductTitle(value = '') {
  return decodeHtml(value)
    .replace(/^amazon\.[a-z.]+\s*:\s*/i, '')
    .replace(/\s*:\s*(?:clothing|shoes|fashion|electronics|home\s*&?\s*kitchen).*$/i, '')
    .replace(/\s+[|–-]\s+(?:amazon\.[a-z.]+|buy online|online shopping).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDescription(value = '', bullets = []) {
  const text = decodeHtml(value || bullets.join(' '))
    .replace(/\b(?:make sure this fits|enter your model number).*?(?:\.|$)/gi, ' ')
    .replace(/\b(?:product details|about this item|from the manufacturer)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 520) return text;
  const clipped = text.slice(0, 520);
  return `${clipped.slice(0, Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf(' '))).trim()}...`;
}

async function buildProductDraft(affiliateLink, { itemType = 'auto', timeoutMs } = {}) {
  const url = cleanUrl(affiliateLink);
  if (!url) throw new Error('Affiliate link is required');
  const { response, text: html, finalUrl } = await safeFetchText(url, {
    maxBytes: 5 * 1024 * 1024,
    timeoutMs,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 Lookmefy product importer'
    }
  });
  if (!response.ok) throw new Error('Could not open that affiliate link');
  const product = parseJsonLdProduct(html) || parseEmbeddedProduct(html) || {};
  const offer = productOffer(product);
  const aggregateRating = productAggregateRating(product);
  const facts = getProductFacts(html);
  const bullets = getFeatureBulletList(html);
  const rawTitle = getElementTextById(html, ['productTitle']) || product.name || product.title || getMeta(html, ['og:title', 'twitter:title', 'name']) || getTitle(html);
  const title = normalizeProductTitle(rawTitle);
  const rawDescription =
    product.description ||
    product.shortDescription ||
    getElementTextById(html, ['productDescription']) ||
    bullets.join(' ') ||
    getMeta(html, ['og:description', 'twitter:description', 'description']);
  const description = cleanDescription(rawDescription, bullets);
  const brand = getBestBrand({ product, facts, html, finalUrl, title });
  const category = inferCategory({ title, description, bullets: bullets.join(' '), facts: [...facts.values()].join(' ') });
  const gender = inferGender(`${title} ${description} ${factValue(facts, ['department', 'target gender'])}`);
  const image = firstImage(product.image || product.images) || getVisibleImage(html) || getMeta(html, ['og:image:secure_url', 'og:image', 'twitter:image', 'image']) || getLink(html, 'image_src');
  const price = numberFrom(
    offer.price ||
      offer.lowPrice ||
      product.price ||
      product.salePrice ||
      getMeta(html, ['product:price:amount', 'og:price:amount', 'price', 'twitter:data1'])
  ) || visiblePrice(html);
  const compareAtPrice = numberFrom(
    offer.highPrice ||
      product.compareAtPrice ||
      product.listPrice ||
      getMeta(html, ['product:original_price:amount', 'product:sale_price:amount', 'compare_at_price'])
  ) || visibleComparePrice(html);
  const currency = normalizeCurrency(offer.priceCurrency || offer.priceCurrencyCode || product.priceCurrency || product.currency) || visibleCurrency(html, finalUrl);
  const rating = aggregateRating.rating || visibleRating(html);
  const ratingCount = aggregateRating.ratingCount || visibleRatingCount(html);
  const canonicalUrl = absoluteUrl(getLink(html, 'canonical'), finalUrl) || finalUrl;
  const garmentPlacement = String(itemType || '').trim().toLowerCase() === 'accessory'
    ? 'accessory'
    : normalizeGarmentPlacement('', { name: title, category, description, tags: bullets });

  return refineProductDraft({
    affiliateLink: url,
    sourceUrl: canonicalUrl,
    name: title,
    brand,
    category,
    gender,
    garmentPlacement,
    price,
    compareAtPrice,
    currency,
    rating,
    ratingCount,
    description,
    tags: buildProductTags({ title, description, bullets, brand, category, gender, facts }),
    remoteImageUrl: absoluteUrl(image, finalUrl)
  }, { facts, bullets, html, finalUrl });
}

function externalProductId(value) {
  return `external:${Buffer.from(value || `${Date.now()}-${Math.random()}`).toString('base64url')}`;
}

function draftToExternalProduct(draft, fallbackQuery = '') {
  const sourceUrl = cleanUrl(draft.sourceUrl || draft.affiliateLink);
  const affiliateLink = cleanUrl(withAmazonAssociateTag(draft.affiliateLink || draft.sourceUrl));
  const imageUrl = cleanUrl(draft.remoteImageUrl);
  if (!sourceUrl || !imageUrl) throw new Error('Product link or image was not found');
  const price = Number(draft.price);
  const compareAtPrice = Number(draft.compareAtPrice);
  const currency = normalizeCurrency(draft.currency) || 'INR';
  const rating = Number(draft.rating);
  const ratingCount = Number(draft.ratingCount);

  return {
    id: externalProductId(sourceUrl),
    external: true,
    sourceUrl,
    affiliateLink,
    name: draft.name || fallbackQuery,
    brand: cleanBrand(draft.brand) || 'Brand unavailable',
    category: draft.category || inferCategory({ title: draft.name || fallbackQuery, description: draft.description || '', query: fallbackQuery }),
    gender: draft.gender || 'unisex',
    price: Number.isFinite(price) ? price : null,
    compareAtPrice: Number.isFinite(compareAtPrice) ? compareAtPrice : null,
    currency,
    rating: Number.isFinite(rating) ? rating : 0,
    ratingCount: Number.isFinite(ratingCount) ? ratingCount : 0,
    badge: 'Amazon',
    description: cleanDescription(draft.description),
    tags: draft.tags || [],
    tryOnModel: inferTryOnModel(draft),
    colors: [],
    imageUrl,
    isNewArrival: true
  };
}

async function cachedRemoteProductImage(remoteImageUrl) {
  const url = cleanUrl(remoteImageUrl);
  if (!url) return null;
  const { response, buffer } = await safeFetchImageBuffer(url, {
    maxBytes: 8 * 1024 * 1024,
    headers: {
      accept: 'image/avif,image/webp,image/apng,image/png,image/jpeg,*/*;q=0.8',
      'user-agent': 'Mozilla/5.0 Lookmefy product image importer'
    }
  });
  if (!response.ok) throw new Error(`Fetched image returned HTTP ${response.status}`);
  const normalized = await normalizeRasterImageBuffer({
    buffer,
    filename: `product-remote-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`
  });
  return saveBuffer({
    key: normalized.filename,
    buffer: normalized.buffer,
    mimetype: normalized.mimetype,
    filename: normalized.filename
  });
}

function textForIntent(product = {}) {
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ');
}

function queryIntentCompatibility(product = {}, query = '') {
  const prompt = String(query || '');
  const text = textForIntent(product);
  const braIntent = /\b(bras?|bralettes?|sports?\s+bras?)\b/i.test(prompt);
  const swimIntent = /\b(bikinis?|swimsuits?|swimwear|monokinis?|one\s*piece\s+swimsuits?)\b/i.test(prompt);

  if (braIntent && !/\b(bras?|bralettes?|sports?\s+bras?|lingerie)\b/i.test(text)) return false;
  if (swimIntent && !/\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|one\s*piece)\b/i.test(text)) return false;
  return true;
}

function sortFor(value) {
  if (value === 'price-asc') return { price: 1 };
  if (value === 'price-desc') return { price: -1 };
  if (value === 'newest') return { createdAt: -1 };
  return { isFeatured: -1, createdAt: -1 };
}

function temporaryExternalAmazonFilter() {
  return {
    catalogApproved: { $ne: true },
    badge: 'Amazon',
    availabilityStatus: { $ne: 'draft' },
    $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }]
  };
}

function optionalNumber(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a number`);
  return parsed;
}

function requireTextField(body, name, label) {
  if (body[name] === undefined) return undefined;
  const value = String(body[name] || '').trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function applyProductUpdate(product, body = {}) {
  const name = requireTextField(body, 'name', 'Name');
  const brand = requireTextField(body, 'brand', 'Brand');
  const category = requireTextField(body, 'category', 'Category');
  const price = optionalNumber(body.price, 'Price');
  const compareAtPrice = optionalNumber(body.compareAtPrice, 'Compare price');
  const rating = optionalNumber(body.rating, 'Rating');
  const ratingCount = optionalNumber(body.ratingCount, 'Rating count');

  if (name !== undefined) product.name = name;
  if (brand !== undefined) product.brand = brand;
  if (category !== undefined) product.category = category;
  if (body.gender !== undefined) product.gender = String(body.gender || 'unisex').trim() || 'unisex';
  if (body.garmentPlacement !== undefined) product.garmentPlacement = normalizeGarmentPlacement(body.garmentPlacement, body);
  if (price !== undefined) {
    if (price === null || price < 0) throw new Error('Price is required');
    product.price = price;
  }
  if (compareAtPrice !== undefined) product.compareAtPrice = compareAtPrice === null ? undefined : compareAtPrice;
  if (body.currency !== undefined) product.currency = normalizeCurrency(body.currency) || product.currency || 'INR';
  if (rating !== undefined) product.rating = rating === null ? 4.5 : rating;
  if (ratingCount !== undefined) product.ratingCount = ratingCount === null ? 0 : ratingCount;
  if (body.badge !== undefined) product.badge = String(body.badge || '').trim() || undefined;
  if (body.affiliateLink !== undefined) product.affiliateLink = cleanUrl(body.affiliateLink);
  if (body.sourceUrl !== undefined) product.sourceUrl = cleanUrl(body.sourceUrl);
  if (body.description !== undefined) product.description = String(body.description || '').trim();
  if (body.tags !== undefined) product.tags = splitList(body.tags);
  if (body.colors !== undefined) product.colors = splitList(body.colors);
  if (body.sizes !== undefined) product.sizes = splitList(body.sizes);
  if (body.sizeNotes !== undefined) product.sizeNotes = String(body.sizeNotes || '').trim();
  if (body.tryOnModel !== undefined) product.tryOnModel = normalizeTryOnModel(body.tryOnModel);
  if (body.isFeatured !== undefined) product.isFeatured = toBoolean(body.isFeatured);
  if (body.isNewArrival !== undefined) product.isNewArrival = toBoolean(body.isNewArrival);
  if (body.availabilityStatus !== undefined) {
    const availability = availabilityUpdate(body.availabilityStatus, {
      source: 'manual',
      notes: body.inventoryNotes
    });
    Object.assign(product, availability);
    if (availability.availabilityStatus === 'available') product.catalogApproved = true;
  } else if (body.inventoryNotes !== undefined) {
    product.inventoryNotes = String(body.inventoryNotes || '').trim();
  }
  if (body.remoteImageUrl !== undefined && String(body.remoteImageUrl || '').trim()) {
    product.image = { remoteUrl: cleanUrl(body.remoteImageUrl) };
  }
}

router.get('/', productReadLimiter, async (req, res) => {
  const cacheKey = req.originalUrl;
  const payload = await productListCache.remember(cacheKey, async () => {
    const { q, tag, category, brand, gender, featured, newArrival, sort, discounted, sale } = req.query;
    const limit = Math.min(Number(req.query.limit) || 48, 96);
    const minPrice = Number(req.query.minPrice);
    const maxPrice = Number(req.query.maxPrice);
    const botAmazonRecord = temporaryExternalAmazonFilter();
    const filter = { isActive: true, $and: [availableStatusClause()], $nor: [botAmazonRecord] };

    if (q) filter.$text = { $search: q };
    if (tag) filter.tags = new RegExp(`^${escapeRegExp(String(tag).trim())}$`, 'i');
    if (category) filter.category = new RegExp(`^${String(category).trim()}$`, 'i');
    if (brand) filter.brand = new RegExp(`^${String(brand).trim()}$`, 'i');
    if (gender) filter.gender = new RegExp(`^${String(gender).trim()}$`, 'i');
    if (featured === 'true') filter.isFeatured = true;
    if (newArrival === 'true') filter.isNewArrival = true;
    if (Number.isFinite(minPrice) || Number.isFinite(maxPrice)) {
      filter.price = {};
      if (Number.isFinite(minPrice)) filter.price.$gte = minPrice;
      if (Number.isFinite(maxPrice)) filter.price.$lte = maxPrice;
    }
    if (discounted === 'true' || sale === 'true') {
      filter.$expr = { $gt: ['$compareAtPrice', '$price'] };
    }

    const projection = q ? { score: { $meta: 'textScore' } } : {};
    const query = Product.find(filter, projection).limit(limit).lean();
    if (q && !sort) query.sort({ score: { $meta: 'textScore' }, createdAt: -1 });
    else query.sort(sortFor(sort));

    const [products, total, brands, categories, categoryCounts] = await Promise.all([
      query,
      Product.countDocuments(filter),
      Product.distinct('brand', { isActive: true, $and: [availableStatusClause()], $nor: [botAmazonRecord] }),
      Product.distinct('category', { isActive: true, $and: [availableStatusClause()], $nor: [botAmazonRecord] }),
      Product.aggregate([
        { $match: filter },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } }
      ])
    ]);

    return {
      products: products.map(productToClient),
      total,
      facets: {
        brands: brands.filter(Boolean).sort(),
        categories: categories.filter(Boolean).sort(),
        categoryCounts: categoryCounts.map((item) => ({ category: item._id || 'uncategorized', count: item.count }))
      }
    };
  });
  res.json(payload);
});

router.get('/admin/catalog', requireAdmin, requireUserOperationsAdmin, productReadLimiter, async (req, res) => {
  const { q, tag, category, brand, gender, featured, newArrival, sort, availability } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 96, 1), 150);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 10_000);
  const offset = (page - 1) * limit;
  const filter = { $nor: [temporaryExternalAmazonFilter()] };
  const availabilityClause = adminAvailabilityClause(availability);
  if (availability && !availabilityClause) {
    return res.status(400).json({ message: `Availability must be one of: ${PRODUCT_AVAILABILITY_STATUSES.join(', ')}` });
  }
  if (availabilityClause) filter.$and = [availabilityClause];
  if (q) filter.$text = { $search: String(q).trim() };
  if (tag) filter.tags = new RegExp(`^${escapeRegExp(String(tag).trim())}$`, 'i');
  if (category) filter.category = new RegExp(`^${escapeRegExp(String(category).trim())}$`, 'i');
  if (brand) filter.brand = new RegExp(`^${escapeRegExp(String(brand).trim())}$`, 'i');
  if (gender) filter.gender = new RegExp(`^${escapeRegExp(String(gender).trim())}$`, 'i');
  if (featured === 'true') filter.isFeatured = true;
  if (newArrival === 'true') filter.isNewArrival = true;

  const projection = q ? { score: { $meta: 'textScore' } } : {};
  const query = Product.find(filter, projection).skip(offset).limit(limit).lean();
  if (q && !sort) query.sort({ score: { $meta: 'textScore' }, createdAt: -1 });
  else query.sort(sortFor(sort));

  const [products, total, brands, categories, categoryCounts, availabilityCounts] = await Promise.all([
    query,
    Product.countDocuments(filter),
    Product.distinct('brand', { $nor: [temporaryExternalAmazonFilter()] }),
    Product.distinct('category', { $nor: [temporaryExternalAmazonFilter()] }),
    Product.aggregate([
      { $match: filter },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } }
    ]),
    Product.aggregate([
      { $match: { $nor: [temporaryExternalAmazonFilter()] } },
      {
        $group: {
          _id: {
            $ifNull: [
              '$availabilityStatus',
              { $cond: [{ $eq: ['$isActive', false] }, 'archived', 'available'] }
            ]
          },
          count: { $sum: 1 }
        }
      }
    ])
  ]);

  res.json({
    products: products.map(productToAdminClient),
    total,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
    facets: {
      brands: brands.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      categoryCounts: categoryCounts.map((item) => ({ category: item._id || 'uncategorized', count: item.count }))
    },
    availabilityCounts: Object.fromEntries(availabilityCounts.map((item) => [item._id, item.count]))
  });
});

router.post('/amazon-search', requireUser, amazonSearchLimiter, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  const limit = Math.min(Math.max(Number(req.body?.limit) || 2, 1), 2);
  const genderPreference = genderPreferenceForQuery(query, req.body?.genderPreference || req.user.genderPreference);
  if (!query) return res.status(400).json({ message: 'Tell the style bot what you want first' });

  try {
    const queryCompatibility = wearableCompatibility({ name: query }, { query });
    if (!queryCompatibility.compatible) throw new Error(queryCompatibility.reason);

    const searchQuery = genderedSearchQuery(query, genderPreference);
    const searchUrl = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(searchQuery)}`;
    const { response, text: html, finalUrl } = await safeFetchText(searchUrl, {
      maxBytes: 5 * 1024 * 1024,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error('Amazon search did not respond');

    const searchResults = extractAmazonSearchResults(html, finalUrl || searchUrl).slice(0, Math.max(limit * 2, 6));
    if (searchResults.length === 0) throw new Error('Amazon did not expose product results for this search');

    const settled = await Promise.allSettled(searchResults.map(async (searchResult) => {
      const draft = await buildProductDraft(withAmazonAssociateTag(searchResult.link));
      return draftToExternalProduct({
        ...draft,
        price: draft.price ?? searchResult.price,
        currency: draft.currency || searchResult.currency,
        remoteImageUrl: draft.remoteImageUrl || searchResult.remoteImageUrl
      }, query);
    }));
    const products = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      if (products.some((product) => product.sourceUrl === result.value.sourceUrl)) continue;
      if (!queryIntentCompatibility(result.value, query)) continue;
      if (!wearableCompatibility(result.value, { query }).compatible) continue;
      if (!genderCompatibility(result.value, genderPreference).compatible) continue;
      products.push(result.value);
      if (products.length >= limit) break;
    }
    if (products.length === 0) throw new Error('Amazon results were found, but none were compatible with AI try-on. Try a clothing item, shoes, watch, bag, eyewear, or accessory.');

    res.json({ products });
  } catch (error) {
    res.status(400).json({ message: readableError(error, 'Could not search Amazon right now') });
  }
});

function smartImportMaxQuantity() {
  const configured = Number(process.env.SMART_CATALOG_IMPORT_MAX || SMART_IMPORT_DEFAULT_MAX);
  if (!Number.isInteger(configured)) return SMART_IMPORT_DEFAULT_MAX;
  return Math.min(Math.max(configured, 1), 25);
}

function smartImportSearchPageCount() {
  const configured = Number(process.env.SMART_CATALOG_SEARCH_PAGES || 2);
  if (!Number.isInteger(configured)) return 2;
  return Math.min(Math.max(configured, 1), 3);
}

function smartImportIssue(sourceUrl, reason, type = 'rejected') {
  return {
    type,
    sourceUrl: cleanUrl(sourceUrl),
    reason: String(reason || 'Product could not be imported').replace(/\s+/g, ' ').trim().slice(0, 220)
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function smartImportRecord(draft, searchResult, intent, batchId) {
  const sourceUrl = amazonProductUrl(draft.sourceUrl || searchResult.link, searchResult.link);
  const affiliateLink = cleanUrl(withAmazonAssociateTag(sourceUrl));
  const sourceProductId = amazonAsin(sourceUrl);
  const remoteImageUrl = cleanUrl(draft.remoteImageUrl || searchResult.remoteImageUrl);
  const price = Number(draft.price ?? searchResult.price);
  const category = String(draft.category || intent.category || '').trim();
  const name = String(draft.name || '').replace(/\s+/g, ' ').trim();
  const brand = String(draft.brand || '').replace(/\s+/g, ' ').trim();
  const errors = [];

  if (!sourceUrl || !sourceProductId) errors.push('Amazon product identifier is missing');
  if (!name) errors.push('Product name is missing');
  if (!brand) errors.push('Product brand is missing');
  if (!category || category === 'clothing') errors.push('Product category needs manual review');
  if (!Number.isFinite(price) || price <= 0) errors.push('Product price is missing');
  if (!remoteImageUrl || !/^https:\/\//i.test(remoteImageUrl)) errors.push('Secure product image is missing');
  if (errors.length) throw new Error(errors.join('; '));

  const compareAtPrice = Number(draft.compareAtPrice);
  const requestedGender = intent.gender === 'unisex' ? '' : intent.gender;
  const gender = requestedGender || draft.gender || 'unisex';
  const tags = uniqueList([
    ...(draft.tags || []),
    category,
    gender,
    ...intent.colors,
    'smart-import'
  ], 24);

  return {
    name,
    brand,
    category,
    gender,
    garmentPlacement: intent.itemType === 'accessory'
      ? 'accessory'
      : normalizeGarmentPlacement(draft.garmentPlacement || intent.garmentPlacement, draft),
    price,
    compareAtPrice: Number.isFinite(compareAtPrice) && compareAtPrice > price ? compareAtPrice : undefined,
    currency: normalizeCurrency(draft.currency || searchResult.currency) || 'INR',
    rating: Math.min(numberOrZero(draft.rating), 5),
    ratingCount: Math.round(numberOrZero(draft.ratingCount)),
    badge: 'Amazon',
    affiliateLink,
    sourceUrl,
    description: cleanDescription(draft.description),
    tags,
    colors: uniqueList([
      ...(Array.isArray(draft.colors) ? draft.colors : []),
      ...(!Array.isArray(draft.colors) || draft.colors.length === 0 ? intent.colors : [])
    ], 8),
    sizes: uniqueList(draft.sizes || [], 18),
    sizeNotes: String(draft.sizeNotes || '').trim(),
    tryOnModel: inferTryOnModel({ ...draft, category, gender, tags }),
    image: { remoteUrl: remoteImageUrl },
    sourceProvider: 'amazon',
    sourceProductId,
    importBatchId: batchId,
    catalogApproved: false,
    isFeatured: false,
    isNewArrival: true,
    lastSyncedAt: new Date(),
    inventoryNotes: `Smart import request: ${intent.command}`.slice(0, 300),
    ...availabilityUpdate('draft', { source: 'smart-import' })
  };
}

function smartImportDraftFromSearchResult(searchResult, intent) {
  const name = normalizeProductTitle(searchResult.name);
  const description = cleanDescription(searchResult.description || name);
  const inferredCategory = inferCategory({ title: name, description, query: intent.query });
  const category = inferredCategory === 'clothing' ? intent.category : inferredCategory;
  const gender = intent.gender === 'unisex' ? inferGender(`${name} ${description}`) : intent.gender;
  const brand = cleanBrand(searchResult.brand) || titleBrandCandidate(name) || 'Brand unavailable';
  const colors = uniqueList([
    ...colorWordsFromText(name),
    ...colorWordsFromText(description)
  ], 8);
  const tags = uniqueList([
    category,
    gender,
    brand,
    ...colors,
    ...collectKeywordTags(`${name} ${description}`)
  ].map((tag) => String(tag || '').toLowerCase()), 14);

  return {
    affiliateLink: searchResult.link,
    sourceUrl: searchResult.link,
    name,
    brand,
    category,
    gender,
    garmentPlacement: intent.itemType === 'accessory'
      ? 'accessory'
      : normalizeGarmentPlacement(intent.garmentPlacement, { name, category, description, tags }),
    price: searchResult.price,
    compareAtPrice: searchResult.compareAtPrice,
    currency: searchResult.currency || 'INR',
    rating: searchResult.rating,
    ratingCount: searchResult.ratingCount,
    description,
    tags,
    colors,
    sizes: [],
    sizeNotes: '',
    remoteImageUrl: searchResult.remoteImageUrl
  };
}

async function fetchSmartImportRecord(searchResult, intent, batchId) {
  const draft = searchResult.provider === 'serpapi'
    ? smartImportDraftFromSearchResult(searchResult, intent)
    : await buildProductDraft(withAmazonAssociateTag(searchResult.link), {
      itemType: intent.itemType,
      timeoutMs: 7_000
    });
  const merged = {
    ...draft,
    price: draft.price ?? searchResult.price,
    currency: draft.currency || searchResult.currency,
    remoteImageUrl: draft.remoteImageUrl || searchResult.remoteImageUrl
  };
  const wearable = wearableCompatibility(merged, { query: intent.query });
  if (!wearable.compatible) throw new Error(wearable.reason);
  const gender = genderCompatibility(merged, intent.genderPreference);
  if (!gender.compatible) throw new Error(gender.reason);
  if (!queryIntentCompatibility(merged, intent.query)) throw new Error('Result did not match the requested product type');
  const intentMatch = catalogIntentCompatibility(merged, intent, {
    allowUnverifiedColor: searchResult.provider === 'serpapi'
  });
  if (!intentMatch.compatible) throw new Error(intentMatch.reason);
  if (intentMatch.unverifiedColors?.length) {
    merged.colors = uniqueList([...(merged.colors || []), ...intentMatch.unverifiedColors], 8);
  }
  return smartImportRecord(merged, searchResult, intent, batchId);
}

router.post('/smart-import', requireAdmin, requireUserOperationsAdmin, async (req, res) => {
  let intent;
  try {
    intent = parseCatalogCommand(req.body?.command, { maxQuantity: smartImportMaxQuantity() });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  const batchId = `smart-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const searchQuery = genderedSearchQuery(intent.query, intent.genderPreference);
  const searchUrl = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(searchQuery)}`;
  const searchResults = [];
  const seenSearchLinks = new Set();
  const desiredCandidateCount = Math.min(intent.quantity + 8, 18);
  const searchProvider = catalogSearchProviderName();
  let searchError = null;
  let searchedPages = 0;
  for (let page = 1; page <= smartImportSearchPageCount() && searchResults.length < desiredCandidateCount; page += 1) {
    try {
      let pageResults;
      if (searchProvider === 'serpapi') {
        pageResults = await searchSerpApiAmazon(searchQuery, { page });
      } else if (['amazon', 'amazon-html'].includes(searchProvider)) {
        const pageUrl = new URL(searchUrl);
        if (page > 1) pageUrl.searchParams.set('page', String(page));
        const { response, text: html, finalUrl } = await safeFetchText(pageUrl.toString(), {
          maxBytes: 5 * 1024 * 1024,
          timeoutMs: 10_000,
          headers: {
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-IN,en;q=0.9',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
          }
        });
        if (!response.ok) throw new Error(`Amazon search returned HTTP ${response.status}`);
        pageResults = extractAmazonSearchResults(html, finalUrl || pageUrl.toString());
      } else {
        throw new Error(`Unsupported catalog search provider: ${searchProvider}`);
      }
      searchedPages += 1;
      for (const result of pageResults) {
        if (seenSearchLinks.has(result.link)) continue;
        seenSearchLinks.add(result.link);
        searchResults.push(result);
      }
    } catch (error) {
      searchError = error;
      break;
    }
  }
  if (!searchResults.length && searchError) {
    return res.status(502).json({ message: readableError(searchError, 'Could not search Amazon right now') });
  }

  const candidateLimit = Math.min(searchResults.length, desiredCandidateCount);
  const candidates = searchResults.slice(0, candidateLimit);
  if (!candidates.length) {
    return res.status(422).json({ message: 'Amazon did not expose product links for that request. Try a more specific fashion description.' });
  }

  const candidateAsins = candidates.map((candidate) => amazonAsin(candidate.link)).filter(Boolean);
  const existing = await Product.find({
    $or: [
      { sourceProvider: 'amazon', sourceProductId: { $in: candidateAsins } },
      { sourceUrl: { $in: candidates.map((candidate) => candidate.link) } }
    ]
  }).select('sourceProductId sourceUrl affiliateLink').lean();
  const existingAsins = new Set(existing.flatMap((product) => [
    product.sourceProductId,
    amazonAsin(product.sourceUrl),
    amazonAsin(product.affiliateLink)
  ]).filter(Boolean));

  const records = [];
  const issues = [];
  const seenAsins = new Set(existingAsins);
  let duplicateCount = 0;
  let rejectedCount = 0;
  let failedCount = 0;
  let inspectedCount = 0;
  const concurrency = 3;

  for (let offset = 0; offset < candidates.length && records.length < intent.quantity; offset += concurrency) {
    const chunk = candidates.slice(offset, offset + concurrency);
    inspectedCount += chunk.length;
    const eligible = chunk.filter((candidate) => {
      const asin = amazonAsin(candidate.link);
      if (!asin || seenAsins.has(asin)) {
        duplicateCount += 1;
        issues.push(smartImportIssue(candidate.link, asin ? 'Product already exists in the catalog' : 'Amazon product identifier is missing', 'duplicate'));
        return false;
      }
      return true;
    });
    const settled = await Promise.allSettled(eligible.map((candidate) => fetchSmartImportRecord(candidate, intent, batchId)));
    settled.forEach((result, index) => {
      const candidate = eligible[index];
      if (result.status === 'rejected') {
        const reason = readableError(result.reason, 'Could not fetch product details');
        const networkFailure = /could not open|fetch|timeout|abort|http\s+\d+/i.test(reason);
        if (networkFailure) failedCount += 1;
        else rejectedCount += 1;
        issues.push(smartImportIssue(candidate?.link, reason, networkFailure ? 'failed' : 'rejected'));
        return;
      }
      const asin = result.value.sourceProductId;
      if (seenAsins.has(asin) || records.length >= intent.quantity) return;
      seenAsins.add(asin);
      records.push(result.value);
    });
  }

  const created = [];
  for (const record of records) {
    try {
      created.push(await Product.create(record));
    } catch (error) {
      if (error?.code === 11000) {
        duplicateCount += 1;
        issues.push(smartImportIssue(record.sourceUrl, 'Product was added by another import', 'duplicate'));
      } else {
        failedCount += 1;
        issues.push(smartImportIssue(record.sourceUrl, readableError(error, 'Could not save product'), 'failed'));
      }
    }
  }

  if (created.length) await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'smart_catalog_imported',
    entityType: 'product',
    label: intent.command,
    detail: {
      batchId,
      requested: intent.quantity,
      discovered: searchResults.length,
      created: created.length,
      duplicates: duplicateCount,
      rejected: rejectedCount,
      failed: failedCount,
      searchedPages,
      searchProvider,
      query: intent.query
    }
  });

  return res.status(created.length ? 201 : 200).json({
    batch: {
      id: batchId,
      command: intent.command,
      intent,
      requested: intent.quantity,
      discovered: searchResults.length,
      searchedPages,
      searchProvider,
      inspected: inspectedCount,
      created: created.length,
      duplicates: duplicateCount,
      rejected: rejectedCount,
      failed: failedCount,
      issues: issues.slice(0, 12),
      products: created.map(productToAdminClient)
    }
  });
});

async function runProductRecategorizationJob() {
  const botAmazonRecord = temporaryExternalAmazonFilter();
  const products = await Product.find({ isActive: true, $nor: [botAmazonRecord] });
  let updated = 0;
  const changes = [];

  for (const product of products) {
    const nextCategory = inferCategory({
      title: product.name,
      description: product.description,
      facts: [...(product.tags || []), ...(product.colors || []), product.brand, product.gender].join(' ')
    });
    if (!nextCategory || nextCategory === 'clothing' || nextCategory === product.category) continue;
    changes.push({ id: product._id.toString(), name: product.name, from: product.category, to: nextCategory });
    product.category = nextCategory;
    await product.save();
    updated += 1;
  }

  if (updated) await clearReadCachesAfterProductWrite();
  return { updated, checked: products.length, changes };
}

router.post('/recategorize', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  if (req.body?.async || req.query.async === '1') {
    const job = await enqueueJob('maintenance', 'product-recategorize', {}, {
      jobId: safeJobId('product-recategorize', Date.now())
    });
    if (!job) return res.status(503).json({ message: 'Job queue is not available' });
    await recordAdminAudit(req, {
      action: 'categories_rebuild_queued',
      entityType: 'product',
      label: 'Product categories',
      detail: { jobId: job.id }
    });
    return res.status(202).json({ queued: true, jobId: job.id });
  }

  const result = await runProductRecategorizationJob();
  await recordAdminAudit(req, {
    action: 'categories_rebuilt',
    entityType: 'product',
    label: 'Product categories',
    detail: { updated: result.updated, checked: result.checked }
  });
  res.json(result);
});

router.get('/:id', productReadLimiter, async (req, res) => {
  try {
    const payload = await productDetailCache.remember(req.params.id, async () => {
      const product = await Product.findOne({
        _id: req.params.id,
        isActive: true,
        $and: [availableStatusClause()]
      }).lean();
      if (!product) {
        const error = new Error('Product not found');
        error.statusCode = 404;
        throw error;
      }
      return { product: productToClient(product) };
    });
    res.json(payload);
  } catch {
    res.status(404).json({ message: 'Product not found' });
  }
});

router.post('/preview-link', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  try {
    const draft = await buildProductDraft(req.body.affiliateLink, { itemType: req.body.itemType });
    res.json({ draft });
  } catch (error) {
    res.status(400).json({ message: readableError(error, 'Could not preview affiliate link') });
  }
});

router.post('/', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, upload.single('image'), async (req, res) => {
  const { name, brand, category, gender, price } = req.body;
  if (!name || !brand || !category || !price) {
    return res.status(400).json({ message: 'Name, brand, category, and price are required' });
  }

  let image;
  if (req.file) {
    const normalized = await normalizeRasterImageBuffer({
      buffer: await fs.readFile(req.file.path),
      filename: req.file.filename
    });
    image = await saveBuffer({
      key: normalized.filename,
      buffer: normalized.buffer,
      mimetype: normalized.mimetype,
      filename: normalized.filename
    });
    if (useBunny() || normalized.filename !== req.file.filename) await fs.unlink(req.file.path).catch(() => {});
  } else if (req.body.remoteImageUrl) {
    try {
      image = await cachedRemoteProductImage(req.body.remoteImageUrl);
    } catch {
      image = { remoteUrl: cleanUrl(req.body.remoteImageUrl) };
    }
  }

  if (!image) return res.status(400).json({ message: 'Product image or fetched image URL is required' });

  const product = await Product.create({
    name,
    brand,
    category,
    gender: gender || 'unisex',
    garmentPlacement: normalizeGarmentPlacement(req.body.garmentPlacement, req.body),
    price: Number(price),
    compareAtPrice: req.body.compareAtPrice ? Number(req.body.compareAtPrice) : undefined,
    currency: normalizeCurrency(req.body.currency) || 'INR',
    rating: req.body.rating ? Number(req.body.rating) : 4.5,
    ratingCount: req.body.ratingCount ? Number(req.body.ratingCount) : 0,
    badge: req.body.badge,
    affiliateLink: cleanUrl(req.body.affiliateLink),
    sourceUrl: cleanUrl(req.body.sourceUrl),
    description: req.body.description,
    tags: splitList(req.body.tags),
    colors: splitList(req.body.colors),
    sizes: splitList(req.body.sizes),
    sizeNotes: req.body.sizeNotes,
    tryOnModel: normalizeTryOnModel(req.body.tryOnModel),
    isFeatured: toBoolean(req.body.isFeatured),
    isNewArrival: toBoolean(req.body.isNewArrival),
    ...availabilityUpdate(normalizeAvailabilityStatus(req.body.availabilityStatus, 'available'), {
      source: 'manual',
      notes: req.body.inventoryNotes
    }),
    image
  });

  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_added',
    entityType: 'product',
    entityId: product._id.toString(),
    label: product.name,
    detail: { brand: product.brand, category: product.category, price: product.price }
  });
  res.status(201).json({ product: productToAdminClient(product) });
});

router.patch('/admin/inventory', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
  if (!ids.length || ids.length > 150 || ids.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
    return res.status(400).json({ message: 'Provide between 1 and 150 valid product ids' });
  }
  let update;
  try {
    update = availabilityUpdate(req.body?.availabilityStatus, {
      source: 'manual',
      notes: req.body?.inventoryNotes
    });
    if (update.availabilityStatus === 'available') update.catalogApproved = true;
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  const result = await Product.updateMany({ _id: { $in: ids } }, { $set: update }, { runValidators: true });
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_availability_bulk_changed',
    entityType: 'product',
    label: `${ids.length} catalog products`,
    detail: { availabilityStatus: update.availabilityStatus, matched: result.matchedCount || 0, updated: result.modifiedCount || 0 }
  });
  res.json({
    matched: result.matchedCount || 0,
    updated: result.modifiedCount || 0,
    availabilityStatus: update.availabilityStatus
  });
});

router.patch('/:id', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    applyProductUpdate(product, req.body || {});
    await product.save();
    await clearReadCachesAfterProductWrite();
    await recordAdminAudit(req, {
      action: 'product_updated',
      entityType: 'product',
      entityId: product._id.toString(),
      label: product.name,
      detail: { brand: product.brand, category: product.category, price: product.price }
    });
    res.json({ product: productToAdminClient(product) });
  } catch (error) {
    res.status(400).json({ message: readableError(error, 'Could not update product') });
  }
});

router.patch('/:id/garment-placement', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { garmentPlacement: normalizeGarmentPlacement(req.body.garmentPlacement) },
    { new: true }
  );
  if (!product) return res.status(404).json({ message: 'Product not found' });
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_fit_area_changed',
    entityType: 'product',
    entityId: product._id.toString(),
    label: product.name,
    detail: { garmentPlacement: product.garmentPlacement }
  });
  res.json({ product: product.toClient() });
});

router.patch('/:id/tryon-model', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { tryOnModel: normalizeTryOnModel(req.body.tryOnModel) },
    { new: true }
  );
  if (!product) return res.status(404).json({ message: 'Product not found' });
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_tryon_model_changed',
    entityType: 'product',
    entityId: product._id.toString(),
    label: product.name,
    detail: { tryOnModel: product.tryOnModel }
  });
  res.json({ product: product.toClient() });
});

router.delete('/', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  const result = await Product.updateMany(
    { isActive: true },
    { $set: availabilityUpdate('archived', { source: 'manual' }) },
    { runValidators: true }
  );
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'all_products_removed',
    entityType: 'product',
    label: 'All active products',
    detail: { removed: result.modifiedCount || 0 }
  });
  res.json({ removed: result.modifiedCount || 0 });
});

router.delete('/:id/permanent', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  if (req.body?.confirmation !== 'DELETE') {
    return res.status(400).json({ message: 'Type DELETE to permanently remove this product' });
  }
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ message: 'Invalid product id' });
  }

  const product = await Product.findById(req.params.id).lean();
  if (!product) return res.status(404).json({ message: 'Product not found' });

  const tryOns = await TryOn.find({ product: product._id }).select('image transparentImage video').lean();
  const storedFiles = [
    product.image,
    ...tryOns.flatMap((tryOn) => [tryOn.image, tryOn.transparentImage, tryOn.video])
  ].filter(Boolean);

  const [tryOnResult, wishlistResult, eventResult] = await Promise.all([
    TryOn.deleteMany({ product: product._id }),
    User.updateMany({ wishlistProducts: product._id }, { $pull: { wishlistProducts: product._id } }),
    UserEvent.updateMany({ product: product._id }, { $unset: { product: 1 } })
  ]);
  await Product.deleteOne({ _id: product._id });

  const storageResults = await Promise.allSettled(storedFiles.map((file) => deleteStoredFile(file)));
  const storageFailures = storageResults.filter((result) => result.status === 'rejected').length;
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_deleted',
    entityType: 'product',
    entityId: product._id.toString(),
    label: product.name,
    detail: {
      tryOnsDeleted: tryOnResult.deletedCount || 0,
      wishlistsUpdated: wishlistResult.modifiedCount || 0,
      eventsDetached: eventResult.modifiedCount || 0,
      storageFailures
    }
  });

  res.json({
    deleted: true,
    tryOnsDeleted: tryOnResult.deletedCount || 0,
    storageCleanupComplete: storageFailures === 0
  });
});

router.delete('/:id', requireAdmin, requireUserOperationsAdmin, adminProductWriteLimiter, async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { $set: availabilityUpdate('archived', { source: 'manual' }) },
    { new: true, runValidators: true }
  );
  if (!product) return res.status(404).json({ message: 'Product not found' });
  await clearReadCachesAfterProductWrite();
  await recordAdminAudit(req, {
    action: 'product_removed',
    entityType: 'product',
    entityId: product._id.toString(),
    label: product.name,
    detail: { brand: product.brand, category: product.category }
  });
  res.json({ product: productToAdminClient(product) });
});

export default router;
export {
  buildProductDraft,
  cleanBrand,
  clearReadCachesAfterProductWrite,
  getBestBrand,
  getProductFacts,
  normalizeGarmentPlacement,
  refineProductDraft,
  runProductRecategorizationJob,
  smartImportDraftFromSearchResult,
  smartImportRecord,
  temporaryExternalAmazonFilter
};
