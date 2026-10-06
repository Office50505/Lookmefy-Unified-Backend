import express from 'express';
import multer from 'multer';
import Product, { productToClient } from '../models/Product.js';
import User from '../models/User.js';
import { requireUser } from './auth.js';
import { clearRecommendationCaches } from './recommendations.js';
import { requireAdmin } from '../utils/adminAuth.js';
import { inferTryOnModel, normalizeTryOnModel } from '../utils/tryOnModel.js';
import { createHybridCache } from '../utils/cache.js';
import { inlineOrQueue, registerJobHandler } from '../utils/jobs.js';
import { fetchPublicResource } from '../utils/remoteFetch.js';
import { isStorageConfigurationError, saveStoredFile } from '../utils/storage.js';
import { wearableCompatibility } from '../utils/wearable.js';
import { genderCompatibility, genderedSearchQuery, genderPreferenceForQuery } from '../utils/genderPreference.js';

const router = express.Router();
const readCacheTtlMs = Number(process.env.PRODUCT_READ_CACHE_TTL_MS || 30 * 1000);
const amazonSearchCacheTtlMs = Number(process.env.AMAZON_SEARCH_CACHE_TTL_MS || 5 * 60 * 1000);
const productListCache = createHybridCache('products:list', { ttlMs: readCacheTtlMs, maxItems: 150 });
const productDetailCache = createHybridCache('products:detail', { ttlMs: readCacheTtlMs, maxItems: 300 });
const amazonSearchCache = createHybridCache('products:amazon-search', { ttlMs: amazonSearchCacheTtlMs, maxItems: 120 });
const productListProjectionFields = [
  'name',
  'brand',
  'category',
  'gender',
  'price',
  'compareAtPrice',
  'currency',
  'rating',
  'ratingCount',
  'badge',
  'affiliateLink',
  'sourceUrl',
  'description',
  'tags',
  'colors',
  'tryOnModel',
  'image',
  'isFeatured',
  'isNewArrival',
  'createdAt'
];

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
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

function extensionFor(mimetype) {
  if (mimetype?.includes('png')) return '.png';
  if (mimetype?.includes('webp')) return '.webp';
  if (mimetype?.includes('gif')) return '.gif';
  return '.jpg';
}

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

function queryFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
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

function exactTextRegex(value) {
  return new RegExp(`^${escapeRegExp(String(value).trim())}$`, 'i');
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
    cleaned.match(/^([A-Z0-9][A-Za-z0-9&'.-]{2,})\s+(?:shirt|dress|jeans|jacket|kurta|saree|sunglasses|watch|shoes|sneakers)\b/i);
  const candidate = cleanBrand(match?.[1] || '');
  if (!candidate || /^(women|woman|men|man|girls|boys|unisex|casual|fashion|generic)$/i.test(candidate)) return '';
  return candidate;
}

function getBestBrand({ product, facts, html, finalUrl, title }) {
  const candidates = [
    getSchemaBrand(product),
    cleanBrand(factValue(facts, ['brand'])),
    getBylineBrand(html),
    titleBrandCandidate(title),
    cleanBrand(factValue(facts, ['manufacturer'])),
    cleanBrand(getMeta(html, ['product:brand'])),
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
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) return raw;
  try {
    const images = JSON.parse(decodeHtml(raw));
    return Object.keys(images).find((url) => /^https?:\/\//i.test(url)) || '';
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
  if (typeof image === 'string') return image;
  return image.url || image.contentUrl || '';
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
  ['costumes', /\b(halloween|costumes?|cosplay|fancy\s*dress)\b/i, 30],
  ['innerwear', /\b(underwear|undergarments?|undegarments?|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear|bikinis?|swimsuits?|swimwear|monokinis?|tankinis?)\b/i, 30],
  ['sleepwear', /\b(night(?:y|ie|wear|gown|suit|dress)|sleepwear|pajamas?|pyjamas?|loungewear|robe)\b/i, 26],
  ['dresses', /\b(dresses?|gowns?|bodycon|maxi|midi|mini\s*dress|a-line\s*dress|wrap\s*dress|party\s*dress)\b/i, 24],
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

function numberFrom(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = priceFromText(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function priceFromText(value) {
  const text = stripTags(value).replace(/,/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const explicitDecimal = text.match(/(?:₹|Rs\.?|INR|\$|USD|€|£)\s*(\d{1,8})\.(\d{1,2})\b/i);
  if (explicitDecimal) {
    const parsed = Number(`${explicitDecimal[1]}.${explicitDecimal[2].padEnd(2, '0')}`);
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

function amazonSearchPageProblem(html = '') {
  const text = stripTags(html).replace(/\s+/g, ' ').trim();
  if (/robot check|enter the characters|captcha|automated access|unusual traffic|sorry, we just need to make sure/i.test(text)) {
    return 'Amazon blocked the search request. Try again later or use a different search phrase.';
  }
  if (/no results for|did not match any products|try checking your spelling|no results found/i.test(text)) {
    return 'Amazon did not find dress results for this search. Try another colour, budget, or occasion.';
  }
  return '';
}

function firstAttr(html = '', attrs = []) {
  for (const attr of attrs) {
    const safeAttr = escapeRegExp(attr);
    const match = html.match(new RegExp(`\\s${safeAttr}=["']([^"']+)["']`, 'i'));
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function imageFromAmazonRegion(region = '', baseUrl = '') {
  const direct =
    region.match(/<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+(?:src|data-src)=["']([^"']+)["']/i)?.[1] ||
    region.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]+class=["'][^"']*s-image[^"']*["']/i)?.[1] ||
    region.match(/<img[^>]+(?:src|data-src)=["']([^"']*media-amazon[^"']*)["']/i)?.[1] ||
    '';
  if (direct) return absoluteUrl(direct, baseUrl);

  const srcset = region.match(/\s(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1] || '';
  const first = srcset.split(',').map((entry) => entry.trim().split(/\s+/)[0]).find(Boolean);
  return absoluteUrl(first, baseUrl);
}

function titleFromAmazonRegion(region = '') {
  const h2 = region.match(/<h2[\s\S]*?<\/h2>/i)?.[0] || '';
  const aria = firstAttr(h2, ['aria-label', 'title']);
  const spanTitles = [...h2.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((text) => text && text.length > 2);
  const title = [
    aria ||
    '',
    ...spanTitles,
    stripTags(region.match(/<span[^>]+class=["'][^"']*a-size-base-plus[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''),
    stripTags(region.match(/<span[^>]+class=["'][^"']*a-size-medium[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
  ].filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  return normalizeProductTitle(stripTags(title));
}

function ratingFromAmazonRegion(region = '') {
  return ratingFrom(
    region.match(/<span[^>]+class=["'][^"']*a-icon-alt[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
      firstAttr(region.match(/<i[^>]+class=["'][^"']*a-icon-star[^"']*["'][^>]*>/i)?.[0] || '', ['aria-label'])
  );
}

function ratingCountFromAmazonRegion(region = '') {
  return ratingCountFrom(
    region.match(/<span[^>]+class=["'][^"']*a-size-base[^"']*s-underline-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
      region.match(/<a[^>]+href=["'][^"']*customerReviews[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
  );
}

function draftFromAmazonSearchResult(searchResult, fallbackQuery = '') {
  const name = normalizeProductTitle(searchResult.title || fallbackQuery);
  const category = inferCategory({ title: name, query: fallbackQuery });
  const gender = inferGender(`${name} ${fallbackQuery}`);
  const brand = cleanBrand(searchResult.brand || titleBrandCandidate(name)) || 'Amazon';
  const facts = new Map();
  return {
    affiliateLink: searchResult.link,
    sourceUrl: searchResult.link,
    name,
    brand,
    category,
    gender,
    price: searchResult.price,
    compareAtPrice: searchResult.compareAtPrice,
    currency: searchResult.currency,
    rating: searchResult.rating,
    ratingCount: searchResult.ratingCount,
    description: searchResult.description || '',
    tags: buildProductTags({ title: name, description: searchResult.description || '', bullets: [], brand, category, gender, facts }),
    remoteImageUrl: searchResult.remoteImageUrl
  };
}

function resultFromAmazonRegion({ asin, region, baseUrl, fallbackLink = '' }) {
  const link = fallbackLink || `${amazonSearchBaseUrl()}/dp/${asin}`;
  const title = titleFromAmazonRegion(region);
  const image = imageFromAmazonRegion(region, baseUrl);
  if (!link || !image) return null;
  return {
    asin,
    link,
    title,
    brand: titleBrandCandidate(title),
    price: pricesFromAmazonMarkup(region)[0],
    currency: visibleCurrency(region, baseUrl),
    rating: ratingFromAmazonRegion(region),
    ratingCount: ratingCountFromAmazonRegion(region),
    remoteImageUrl: image
  };
}

function extractAmazonSearchResults(html, baseUrl) {
  const results = [];
  const seen = new Set();
  const push = (result) => {
    if (!result?.link || seen.has(result.link)) return;
    seen.add(result.link);
    results.push(result);
  };

  const asinMatches = [...html.matchAll(/\bdata-asin=["']([A-Z0-9]{10})["']/gi)]
    .filter((match) => match[1] && match[1] !== '0000000000');
  asinMatches.forEach((match, index) => {
    const nextIndex = asinMatches[index + 1]?.index ?? Math.min(html.length, match.index + 22000);
    const region = html.slice(Math.max(0, match.index - 900), Math.min(html.length, nextIndex));
    const href = region.match(/\shref=["']([^"']*(?:\/dp\/|\/gp\/product\/)[^"']+)["']/i)?.[1] || '';
    const productUrl = amazonProductUrl(href, baseUrl) || `${new URL(baseUrl).origin}/dp/${match[1].toUpperCase()}`;
    push(resultFromAmazonRegion({ asin: match[1].toUpperCase(), region, baseUrl, fallbackLink: productUrl }));
  });

  for (const match of html.matchAll(/\shref=["']([^"']+)["']/gi)) {
    const productUrl = amazonProductUrl(match[1], baseUrl);
    if (!productUrl) continue;
    const region = html.slice(Math.max(0, match.index - 4500), Math.min(html.length, match.index + 6500));
    const asin = productUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || '';
    push(resultFromAmazonRegion({ asin, region, baseUrl, fallbackLink: productUrl }));
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
    .replace(/^sponsored\s+ad\s*[-:]\s*/i, '')
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

async function buildProductDraft(affiliateLink) {
  const url = cleanUrl(affiliateLink);
  if (!url) throw new Error('Affiliate link is required');
  const { response, bytes } = await fetchPublicResource(url, {
    label: 'Affiliate product page',
    timeoutMs: Math.max(1000, Number(process.env.AMAZON_PRODUCT_TIMEOUT_MS) || 15000),
    maxBytes: Math.max(64 * 1024, Number(process.env.AMAZON_PRODUCT_MAX_BYTES) || 2 * 1024 * 1024),
    allowedContentTypePrefixes: ['text/html', 'application/xhtml+xml'],
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 Lookmefy product importer'
    }
  });
  const html = bytes.toString('utf8');
  const finalUrl = response.url || url;
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

  return {
    affiliateLink: url,
    sourceUrl: canonicalUrl,
    name: title,
    brand,
    category,
    gender,
    price,
    compareAtPrice,
    currency,
    rating,
    ratingCount,
    description,
    tags: buildProductTags({ title, description, bullets, brand, category, gender, facts }),
    remoteImageUrl: absoluteUrl(image, finalUrl)
  };
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
    currency: draft.currency || 'INR',
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
  const kurtaIntent = /\b(kurtas?|kurtis?)\b/i.test(prompt);
  const ethnicIntent = /\b(ethnic|sarees?|saris?|lehengas?|salwars?|anarkali|churidar|sharara)\b/i.test(prompt);
  const shoeIntent = /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/i.test(prompt);

  if (braIntent && !/\b(bras?|bralettes?|sports?\s+bras?|lingerie)\b/i.test(text)) return false;
  if (swimIntent && !/\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|one\s*piece)\b/i.test(text)) return false;
  if (kurtaIntent && !/\b(kurtas?|kurtis?)\b/i.test(text)) return false;
  if (ethnicIntent && !/\b(kurtas?|kurtis?|ethnic|sarees?|saris?|lehengas?|salwars?|anarkali|churidar|sharara)\b/i.test(text)) return false;
  if (shoeIntent && !/\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/i.test(text)) return false;
  return true;
}

function hasUsableProductTitle(product = {}, query = '') {
  const name = normalizeProductTitle(product.name || '');
  if (!name) return false;
  if (normalizeProductTitle(query).toLowerCase() === name.toLowerCase()) return false;
  if (cleanBrand(name).toLowerCase() === cleanBrand(product.brand || '').toLowerCase()) return false;
  const tokens = name.toLowerCase().match(/[a-z0-9]+/g) || [];
  const productSignal = /\b(dresses?|shirts?|tops?|tees?|sweaters?|hoodies?|jackets?|jeans|pants?|trousers?|skirts?|shoes?|sneakers?|sandals?|heels?|boots?|footwear|bags?|watches?|bras?|lingerie|underwear|bikinis?|swimsuits?|costumes?|caps?|hats?|kurtas?|kurtis?|sarees?|saris?|lehengas?|salwars?)\b/i;
  if (!productSignal.test(name)) return false;
  if (tokens.length >= 3) return true;
  return productSignal.test(name);
}

function sortFor(value) {
  if (value === 'price-asc') return { price: 1, _id: 1 };
  if (value === 'price-desc') return { price: -1, _id: -1 };
  if (value === 'newest') return { createdAt: -1, _id: -1 };
  return { isFeatured: -1, createdAt: -1, _id: -1 };
}

router.get('/', async (req, res) => {
  const cacheKey = req.originalUrl;
  const cached = await productListCache.get(cacheKey);
  if (cached) return res.json(cached);

  const { q, tag, category, brand, gender, featured, newArrival, sort } = req.query;
  const includeFacets = queryFlag(req.query.includeFacets);
  const includeTotal = queryFlag(req.query.includeTotal);
  const rawLimit = Number(req.query.limit);
  const rawSkip = Number(req.query.skip);
  const requestedLimit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 48;
  const requestedSkip = Number.isFinite(rawSkip) ? Math.floor(rawSkip) : 0;
  const limit = Math.min(Math.max(requestedLimit, 1), 96);
  const skip = Math.max(requestedSkip, 0);
  const botAmazonRecord = { badge: 'Amazon', $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }] };
  const filter = { isActive: true, $nor: [botAmazonRecord] };

  if (q) filter.$text = { $search: q };
  if (tag) filter.tags = exactTextRegex(tag);
  if (category) filter.category = exactTextRegex(category);
  if (brand) filter.brand = exactTextRegex(brand);
  if (gender) filter.gender = exactTextRegex(gender);
  if (featured === 'true') filter.isFeatured = true;
  if (newArrival === 'true') filter.isNewArrival = true;

  const projection = Object.fromEntries(productListProjectionFields.map((field) => [field, 1]));
  if (q) projection.score = { $meta: 'textScore' };
  const query = Product.find(filter, projection).skip(skip).limit(limit).lean();
  if (q && !sort) query.sort({ score: { $meta: 'textScore' }, createdAt: -1, _id: -1 });
  else query.sort(sortFor(sort));

  const [products, exactTotal, facetData] = await Promise.all([
    query,
    includeTotal ? Product.countDocuments(filter) : Promise.resolve(null),
    includeFacets
      ? Promise.all([
          Product.distinct('brand', { isActive: true, $nor: [botAmazonRecord] }),
          Product.distinct('category', { isActive: true, $nor: [botAmazonRecord] }),
          Product.aggregate([
            { $match: filter },
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } }
          ])
        ])
      : Promise.resolve([[], [], []])
  ]);
  const [brands, categories, categoryCounts] = facetData;

  const payload = {
    products: products.map(productToClient),
    total: includeTotal ? exactTotal : skip + products.length,
    facets: {
      brands: brands.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      categoryCounts: categoryCounts.map((item) => ({ category: item._id || 'uncategorized', count: item.count }))
    }
  };
  await productListCache.set(cacheKey, payload);
  res.json(payload);
});

export async function searchAmazonProductsForQuery({ query: rawQuery, limit: rawLimit = 2, user, genderPreference: rawGenderPreference, fast = false, timeoutMs: rawTimeoutMs } = {}) {
  const query = String(rawQuery || '').trim();
  const limit = Math.min(Math.max(Number(rawLimit) || 2, 1), 12);
  const fastMode = Boolean(fast);
  const timeoutMs = Math.max(1000, Number(rawTimeoutMs) || Number(process.env.AMAZON_SEARCH_TIMEOUT_MS) || 15000);
  const genderPreference = genderPreferenceForQuery(query, rawGenderPreference || user?.genderPreference);
  if (!query) throw new Error('Tell AI Studio what you want first');
  const baseUrl = amazonSearchBaseUrl();
  const cacheKey = JSON.stringify({ baseUrl, query: query.toLowerCase(), genderPreference, limit, fastMode });
  const cached = await amazonSearchCache.get(cacheKey);
  if (cached) return cached;

  const queryCompatibility = wearableCompatibility({ name: query }, { query });
  if (!queryCompatibility.compatible) throw new Error(queryCompatibility.reason);

  const searchQuery = genderedSearchQuery(query, genderPreference);
  const searchUrl = `${baseUrl}/s?k=${encodeURIComponent(searchQuery)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(searchUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Amazon search timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error('Amazon search did not respond');

  const html = await response.text();
  const pageProblem = amazonSearchPageProblem(html);
  if (pageProblem) throw new Error(pageProblem);
  const exposesProductMarkup = /\bdata-asin=["'][A-Z0-9]{10}["']|\/(?:dp|gp\/product)\/[A-Z0-9]{10}|class=["'][^"']*s-image/i.test(html);
  if (!exposesProductMarkup) throw new Error('Amazon did not expose product result HTML for this search');

  const searchResults = extractAmazonSearchResults(html, response.url || searchUrl).slice(0, fastMode ? Math.max(limit * 2, 6) : Math.max(limit * 3, 8));
  if (searchResults.length === 0) throw new Error('No usable Amazon product cards were found for that search');

  const settled = await Promise.allSettled(searchResults.map(async (searchResult) => {
    if (fastMode) return draftToExternalProduct(draftFromAmazonSearchResult(searchResult, query), query);
    try {
      const draft = await buildProductDraft(withAmazonAssociateTag(searchResult.link));
      return draftToExternalProduct({
        ...draft,
        price: draft.price ?? searchResult.price,
        currency: draft.currency || searchResult.currency,
        remoteImageUrl: draft.remoteImageUrl || searchResult.remoteImageUrl
      }, query);
    } catch {
      return draftToExternalProduct(draftFromAmazonSearchResult(searchResult, query), query);
    }
  }));
  const products = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    if (products.some((product) => product.sourceUrl === result.value.sourceUrl)) continue;
    if (!hasUsableProductTitle(result.value, query)) continue;
    if (!queryIntentCompatibility(result.value, query)) continue;
    if (!wearableCompatibility(result.value, { query }).compatible) continue;
    if (!genderCompatibility(result.value, genderPreference).compatible) continue;
    products.push(result.value);
    if (products.length >= limit) break;
  }
  if (products.length === 0) throw new Error('Amazon results were found, but none could be used for AI try-on. Try a clearer clothing product search.');

  await amazonSearchCache.set(cacheKey, products);
  return products;
}

function friendlyAmazonSearchError(error) {
  const detail = readableError(error, 'Could not search Amazon right now');
  if (/blocked|captcha|automated access|unusual traffic|robot/i.test(detail)) {
    return 'Live Amazon search is being rate-limited right now. Try again in a moment with a simpler product phrase.';
  }
  if (/did not expose|no usable|no results|did not find/i.test(detail)) {
    return 'No usable Amazon product cards were found for that search. Try another colour, category, budget, or shorter phrase.';
  }
  if (/none were compatible|none could be used|compatible with AI try-on|clothing item/i.test(detail)) {
    return 'Amazon results were found, but none could be used for AI try-on. Try a clearer clothing product search.';
  }
  if (/network|fetch|respond|timed out/i.test(detail)) {
    return 'Live Amazon search is taking longer than usual. Try again in a moment.';
  }
  return detail;
}

async function amazonSearchProductsService({ userId, body = {} }) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 401;
    throw error;
  }
  const products = await searchAmazonProductsForQuery({
    query: body?.query,
    limit: body?.limit,
    user,
    genderPreference: body?.genderPreference
  });
  return { products };
}

router.post('/amazon-search', requireUser, async (req, res) => {
  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'amazon-product-search',
      key: `${req.user._id}:${String(req.body?.query || '').trim().toLowerCase()}:${req.body?.limit || ''}:${req.body?.genderPreference || ''}`,
      payload: {
        body: {
          query: req.body?.query,
          limit: req.body?.limit,
          genderPreference: req.body?.genderPreference
        }
      },
      maxAttempts: 1,
      runInline: async () => ({
        statusCode: 200,
        body: await amazonSearchProductsService({ userId: req.user._id, body: req.body })
      })
    });
  } catch (error) {
    console.warn('[products:amazon-search] failed', readableError(error, 'Could not search Amazon right now'));
    res.status(error.statusCode || 400).json({ message: friendlyAmazonSearchError(error) });
  }
});

function registerProductJobHandlers() {
  registerJobHandler('amazon-product-search', async ({ payload, job }) => (
    amazonSearchProductsService({ userId: job.user, body: payload.body })
  ));
}

router.post('/recategorize', requireAdmin, async (_req, res) => {
  const botAmazonRecord = { badge: 'Amazon', $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }] };
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
  res.json({ updated, checked: products.length, changes });
});

router.get('/:id', async (req, res) => {
  try {
    const cached = await productDetailCache.get(req.params.id);
    if (cached) return res.json(cached);
    const product = await Product.findOne({ _id: req.params.id, isActive: true }).lean();
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const payload = { product: productToClient(product) };
    await productDetailCache.set(req.params.id, payload);
    res.json(payload);
  } catch {
    res.status(404).json({ message: 'Product not found' });
  }
});

router.post('/preview-link', requireAdmin, async (req, res) => {
  try {
    const draft = await buildProductDraft(req.body.affiliateLink);
    res.json({ draft });
  } catch (error) {
    res.status(400).json({ message: readableError(error, 'Could not preview affiliate link') });
  }
});

router.post('/', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    const { name, brand, category, gender, price } = req.body;
    if (!name || !brand || !category || !price) {
      return res.status(400).json({ message: 'Name, brand, category, and price are required' });
    }

    let image;
    if (req.file) {
      const filename = `product-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensionFor(req.file.mimetype)}`;
      image = await saveStoredFile({
        buffer: req.file.buffer,
        filename,
        mimetype: req.file.mimetype,
        folder: 'products',
        prefix: 'product'
      });
    } else if (req.body.remoteImageUrl) {
      image = { remoteUrl: cleanUrl(req.body.remoteImageUrl) };
    }

    if (!image) return res.status(400).json({ message: 'Product image or fetched image URL is required' });

    const product = await Product.create({
      name,
      brand,
      category,
      gender: gender || 'unisex',
      price: Number(price),
      compareAtPrice: req.body.compareAtPrice ? Number(req.body.compareAtPrice) : undefined,
      currency: String(req.body.currency || 'INR').trim().toUpperCase(),
      rating: req.body.rating ? Number(req.body.rating) : 4.5,
      ratingCount: req.body.ratingCount ? Number(req.body.ratingCount) : 0,
      badge: req.body.badge,
      affiliateLink: cleanUrl(req.body.affiliateLink),
      sourceUrl: cleanUrl(req.body.sourceUrl),
      description: req.body.description,
      tags: splitList(req.body.tags),
      colors: splitList(req.body.colors),
      tryOnModel: normalizeTryOnModel(req.body.tryOnModel),
      isFeatured: toBoolean(req.body.isFeatured),
      isNewArrival: toBoolean(req.body.isNewArrival),
      image
    });

    await clearReadCachesAfterProductWrite();
    res.status(201).json({ product: product.toClient() });
  } catch (error) {
    const message = readableError(error, 'Could not save product');
    res.status(isStorageConfigurationError(error) ? error.statusCode || 503 : 400).json({ message });
  }
});

router.patch('/:id/tryon-model', requireAdmin, async (req, res) => {
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { tryOnModel: normalizeTryOnModel(req.body.tryOnModel) },
    { new: true }
  );
  if (!product) return res.status(404).json({ message: 'Product not found' });
  await clearReadCachesAfterProductWrite();
  res.json({ product: product.toClient() });
});

router.delete('/', requireAdmin, async (_req, res) => {
  const result = await Product.updateMany({ isActive: true }, { isActive: false });
  await clearReadCachesAfterProductWrite();
  res.json({ removed: result.modifiedCount || 0 });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  await clearReadCachesAfterProductWrite();
  res.json({ product: product.toClient() });
});

export default router;
export { buildProductDraft, registerProductJobHandlers };
