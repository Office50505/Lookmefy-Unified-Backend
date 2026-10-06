import express from 'express';
import mongoose from 'mongoose';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Product, { productToClient } from '../models/Product.js';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import { requireUser } from './auth.js';
import { requireAdmin } from '../utils/adminAuth.js';
import { createHybridCache } from '../utils/cache.js';
import { inlineOrQueue, registerJobHandler } from '../utils/jobs.js';
import { productGenderForPreference } from '../utils/genderPreference.js';
import { wearableCompatibility } from '../utils/wearable.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const aiStudioKnowledgeDir = path.resolve(__dirname, '..', 'knowledge', 'ai-studio');
const recommendationCacheTtlMs = Number(process.env.RECOMMENDATION_READ_CACHE_TTL_MS || 30 * 1000);
const productPoolCache = createHybridCache('recommendations:product-pool', { ttlMs: recommendationCacheTtlMs, maxItems: 20 });
const similarProductsCache = createHybridCache('recommendations:similar', { ttlMs: recommendationCacheTtlMs, maxItems: 300 });
const aiStudioFashionResultCache = createHybridCache('recommendations:ai-studio-fashion-results', {
  ttlMs: Number(process.env.AI_STUDIO_SEARCH_CACHE_TTL_MS || 10 * 60 * 1000),
  maxItems: 120
});

async function clearRecommendationCaches() {
  await Promise.all([
    productPoolCache.clear(),
    similarProductsCache.clear()
  ]);
}

const EVENT_WEIGHTS = {
  search: 1,
  filter: 1,
  product_view: 2,
  product_click: 2,
  style_bot_query: 2,
  custom_tryon: 2,
  try_on: 5,
  shop_click: 8
};

function catalogFilter(extra = {}) {
  const botAmazonRecord = { badge: 'Amazon', $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }] };
  return { isActive: true, $nor: [botAmazonRecord], ...extra };
}

function normalizeKey(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function queryTerms(value = '') {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
}

function allQueryTerms(value = '') {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
}

function alphaTokens(value = '') {
  return String(value || '').toLowerCase().match(/[a-z]{3,}/g) || [];
}

function alphaCompact(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z]+/g, '');
}

function editDistanceAtMost(source = '', target = '', maxDistance = 2) {
  const left = String(source || '');
  const right = String(target || '');
  if (!left || !right || Math.abs(left.length - right.length) > maxDistance) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMin = current[0];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
      current[column] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return false;
    previous = current;
  }
  return previous[right.length] <= maxDistance;
}

function compactHasApproxTerm(compact = '', target = '', maxDistance = 2) {
  const minLength = Math.max(1, target.length - maxDistance);
  const maxLength = target.length + maxDistance;
  for (let start = 0; start < compact.length; start += 1) {
    for (let length = minLength; length <= maxLength; length += 1) {
      const piece = compact.slice(start, start + length);
      if (piece.length < minLength) continue;
      if (editDistanceAtMost(piece, target, maxDistance)) return true;
    }
  }
  return false;
}

function mentionsLookmefy(message = '') {
  const lower = String(message || '').toLowerCase();
  const compact = alphaCompact(message);
  if (/\blook\s*mefy\b|\blookmefy\b/.test(lower) || compact.includes('lookmefy')) return true;
  if (compactHasApproxTerm(compact, 'lookmefy', 2)) return true;
  return alphaTokens(message).some((token) => token.length >= 6 && editDistanceAtMost(token, 'lookmefy', 2));
}

function readableError(value, fallback = 'Request failed') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message || fallback;
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

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeChat(value = '') {
  return String(value || '').toLowerCase();
}

function textHasFashionTerm(text = '', term = '') {
  const cleaned = normalizeChat(term).trim();
  if (!cleaned) return false;
  const escaped = escapeRegExp(cleaned).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`).test(normalizeChat(text));
}

function canonicalGreetingToken(token = '') {
  return normalizeChat(token).replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
}

function isGreetingOnly(message = '') {
  const raw = String(message || '').trim();
  if (!raw) return false;
  const lower = normalizeChat(raw).replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (/^h+i+$/.test(compact) || /^h+e+(?:y+)?$/.test(compact) || /^h+e+l+o+$/.test(compact)) return true;
  if (/^go+d+(morning|afternoon|evening)$/.test(compact)) return true;
  const tokens = lower.match(/[a-z0-9]+/g) || [];
  if (!tokens.length || tokens.length > 4) return false;
  const canonical = tokens.map(canonicalGreetingToken);
  const greetingWords = new Set(['hi', 'hey', 'he', 'helo', 'hello', 'hlo', 'hlw', 'hay', 'hai', 'hola', 'yo', 'sup', 'gm', 'morning', 'afternoon', 'evening', 'namaste', 'namaskar', 'salam']);
  const fillerWords = new Set(['bro', 'brother', 'bruh', 'yaar', 'sir', 'dude', 'there', 'dear', 'buddy', 'ji', 'lookmefy', 'lm', 'ai']);
  if (canonical.join('') === 'goodmorning' || canonical.join('') === 'goodafternoon' || canonical.join('') === 'goodevening') return true;
  return canonical.some((token) => greetingWords.has(token))
    && canonical.every((token) => greetingWords.has(token) || fillerWords.has(token));
}

function isCasualGreetingPrefix(message = '') {
  const lower = normalizeChat(message).replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = lower.match(/[a-z0-9]+/g) || [];
  if (tokens.length < 2 || tokens.length > 5) return false;
  const first = canonicalGreetingToken(tokens[0]);
  const greetings = new Set(['hi', 'hey', 'he', 'helo', 'hello', 'hlo', 'hlw', 'hay', 'hai', 'hola', 'yo', 'sup', 'gm', 'namaste', 'namaskar', 'salam']);
  if (!greetings.has(first) && !/^h+i+$/.test(tokens[0]) && !/^h+e+(?:y+)?$/.test(tokens[0])) return false;
  const rest = tokens.slice(1).map(canonicalGreetingToken);
  const fillerWords = new Set(['bro', 'brother', 'bruh', 'yaar', 'sir', 'dude', 'there', 'dear', 'buddy', 'ji', 'lookmefy', 'lm', 'ai']);
  return rest.every((token) => fillerWords.has(token));
}

function titleCaseWords(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function detectCelebrityStyleRequest(message = '') {
  const text = String(message || '')
    .trim()
    .replace(/^(?:search|find|shop|buy)\s+(?:(?:online|amazon|products?)\s+)?(?:for\s+)?/i, '');
  const patterns = [
    /\b(?:dress|dressing|look|style|outfit|wear)\s+(?:like|as|inspired\s+by)\s+([a-z][a-z .'-]{2,60})/i,
    /\b([a-z][a-z .'-]{2,60})\s+(?:style|inspired\s+look|inspired\s+outfit)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]
      ?.replace(/\b(?:for|under|below|with|in|from|on|outfit|look|style|dress|clothes?)\b.*$/i, '')
      .trim();
    if (name && !mentionsLookmefy(name) && name.split(/\s+/).length <= 5) return { name: titleCaseWords(name) };
  }
  return null;
}

function visibleSourceQuestion(message = '') {
  const lower = normalizeChat(message);
  const hasReference = /\b(these|this|those|them|they|products?|items?|options?|cards?|results?)\b/.test(lower);
  const asksSource = /\b(from|of|in|belong|source|amazon|online|wardrobe|closet|mine|owned|lookmefy|catalog|website|site)\b/.test(lower);
  return hasReference && asksSource && (
    /\b(are|is|were|was|do|does|did)\b/.test(lower)
    || /\bproducts?\s+(?:of|from|in)\s+my\s+(?:wardrobe|closet)\b/.test(lower)
    || /\b(?:wardrobe|closet|mine|owned|amazon|online|catalog|lookmefy)\b/.test(lower)
  );
}

function productSourceType(product = {}, fallback = '') {
  const sourceText = normalizeChat([
    product.source,
    product.searchSource,
    product.sourceLabel,
    product.badge,
    product.sourceUrl,
    product.affiliateLink,
    fallback
  ].filter(Boolean).join(' '));
  if (/wardrobe|closet/.test(sourceText)) return 'wardrobe';
  if (/amazon|amzn\.in/.test(sourceText)) return 'amazon';
  if (/catalog|lookmefy|fitlook/.test(sourceText)) return 'lookmefy_catalog';
  if (/external/.test(sourceText)) return 'external';
  return fallback || '';
}

function sourceLabel(sourceOrProduct = '') {
  const source = typeof sourceOrProduct === 'string'
    ? productSourceType({ source: sourceOrProduct }, sourceOrProduct)
    : productSourceType(sourceOrProduct);
  if (source === 'wardrobe') return 'Wardrobe item';
  if (source === 'amazon') return 'Amazon result';
  if (source === 'lookmefy_catalog') return 'Lookmefy catalog';
  if (source === 'external') return 'External product';
  return '';
}

function withSourceMetadata(product = {}, source = '') {
  const type = productSourceType(product, source);
  return {
    ...product,
    source: type || product.source || source || '',
    sourceLabel: product.sourceLabel || sourceLabel(type),
    searchSource: product.searchSource || source || product.searchSource || ''
  };
}

function action(type, label, payload = {}, extra = {}) {
  return { type, label, payload, ...extra };
}

function userCanTryOn(user = {}) {
  const status = user?.bodyPhotoStatus || user?.bodyPhoto?.status || 'uploaded';
  const hasPhoto = Boolean(user?.bodyPhotoUrl || user?.bodyPhoto?.path || user?.bodyPhoto?.url);
  const tokens = Number(user?.tokens || 0);
  if (!hasPhoto) return { ok: false, reason: 'Upload a try-on profile photo first.' };
  if (status === 'generating') return { ok: false, reason: 'Your try-on profile is still preparing.' };
  if (status === 'failed') return { ok: false, reason: 'Upload a clearer try-on profile photo first.' };
  if (tokens < 1 && !user?.devMode) return { ok: false, reason: 'Not enough tokens for AI try-on.' };
  return { ok: true, reason: '' };
}

function productActionPayload(product = {}, user = {}) {
  const source = productSourceType(product);
  const productId = String(product.id || product._id || '');
  const tryOnReady = userCanTryOn(user);
  const openUrl = product.affiliateLink || product.sourceUrl || '';
  const actions = [];
  if (openUrl) actions.push(action('open_product', 'Open product', { url: openUrl, productId, source }));
  if (source === 'amazon' || source === 'external') {
    actions.push(action('try_on_external_product', 'Try on', {
      endpoint: '/api/tryons/external',
      method: 'POST',
      body: {
        product: {
          name: product.name,
          brand: product.brand || '',
          category: product.category || '',
          price: product.price,
          currency: product.currency || 'INR',
          imageUrl: product.imageUrl || '',
          sourceUrl: product.sourceUrl || product.affiliateLink || '',
          affiliateLink: product.affiliateLink || product.sourceUrl || ''
        }
      },
      requiresTokens: true
    }, { enabled: tryOnReady.ok, disabledReason: tryOnReady.reason }));
  } else if (productId) {
    actions.push(action('try_on_product', 'Try on', {
      endpoint: `/api/tryons/${encodeURIComponent(productId)}`,
      method: 'POST',
      productId,
      requiresTokens: true
    }, { enabled: tryOnReady.ok, disabledReason: tryOnReady.reason }));
  }
  actions.push(action('wishlist_product', 'Save', { productId, source, product }, {
    clientAction: 'toggleWishlist',
    enabled: Boolean(productId || openUrl)
  }));
  return actions;
}

function decorateProducts(products = [], source = '', user = {}) {
  return products.map((product) => {
    const decorated = withSourceMetadata(product, source);
    return { ...decorated, actions: productActionPayload(decorated, user) };
  });
}

function outfitActionPayload(outfit = {}, user = {}, message = '') {
  const itemIds = (outfit.items || []).map((item) => item.id || item._id).filter(Boolean);
  const actions = [
    action('open_wardrobe', 'Open wardrobe', {
      endpoint: '/api/closet',
      method: 'GET'
    })
  ];
  if (itemIds.length) {
    const tryOnReady = userCanTryOn(user);
    actions.unshift(action('generate_wardrobe_tryon', 'Generate try-on', {
      endpoint: '/api/closet/outfits/generate',
      method: 'POST',
      body: {
        itemIds,
        occasion: String(message || outfit.occasion || '').slice(0, 120),
        title: outfit.title || 'AI Studio wardrobe look'
      },
      requiresTokens: true
    }, { enabled: tryOnReady.ok, disabledReason: tryOnReady.reason }));
  }
  if (outfit.missing?.length) {
    actions.push(action('search_missing_piece', 'Search missing piece', {
      endpoint: '/api/recommendations/studio-chat',
      method: 'POST',
      message: `Search online for ${outfit.missing[0]} to complete ${message || outfit.title || 'this wardrobe look'}`
    }));
  }
  return actions;
}

function primaryActions({ mode = '', message = '', products = [], outfits = [], user = {}, suggestions = [] } = {}) {
  const actions = [];
  const firstProduct = products[0];
  const firstOutfit = outfits[0];
  if (firstProduct?.actions?.length) actions.push(...firstProduct.actions.slice(0, 2));
  if (firstOutfit?.actions?.length) actions.push(...firstOutfit.actions.slice(0, 2));
  if (!actions.some((item) => item.type === 'check_wardrobe')) {
    actions.push(action('check_wardrobe', 'Check wardrobe', {
      endpoint: '/api/recommendations/studio-chat',
      method: 'POST',
      message: `Check wardrobe for ${message || suggestions[0] || 'an outfit'}`
    }));
  }
  if (!actions.some((item) => item.type === 'search_products')) {
    actions.push(action('search_products', mode === 'product_search' ? 'Search again' : 'Search products', {
      endpoint: '/api/recommendations/studio-chat',
      method: 'POST',
      message: `Search online for ${message || suggestions[0] || 'fashion products'}`
    }));
  }
  return actions.slice(0, 5);
}

function visibleSourceReply(message = '', history = [], body = {}) {
  if (!visibleSourceQuestion(message)) return null;
  const bodyVisible = body.lastVisible || {};
  const bodyProducts = Array.isArray(bodyVisible.products) ? bodyVisible.products : Array.isArray(body.visibleProducts) ? body.visibleProducts : Array.isArray(body.products) ? body.products : [];
  const bodyOutfits = Array.isArray(bodyVisible.outfits) ? bodyVisible.outfits : Array.isArray(body.visibleOutfits) ? body.visibleOutfits : Array.isArray(body.outfits) ? body.outfits : [];
  const bodyWardrobeItems = Array.isArray(bodyVisible.wardrobeItems) ? bodyVisible.wardrobeItems : Array.isArray(body.visibleWardrobeItems) ? body.visibleWardrobeItems : [];
  const recent = [...(Array.isArray(history) ? history : [])].reverse();
  const visibleEntry = bodyProducts.length || bodyOutfits.length || bodyWardrobeItems.length ? { products: bodyProducts, outfits: bodyOutfits, wardrobeItems: bodyWardrobeItems } : recent.find((entry) => {
    const products = Array.isArray(entry?.products) ? entry.products : [];
    const outfits = Array.isArray(entry?.outfits) ? entry.outfits : [];
    const wardrobeItems = Array.isArray(entry?.wardrobeItems) ? entry.wardrobeItems : [];
    return products.length || outfits.length || wardrobeItems.length;
  });
  const products = visibleEntry?.products || [];
  const outfits = visibleEntry?.outfits || [];
  const wardrobeItems = visibleEntry?.wardrobeItems || [];
  const productSources = [...new Set(products.map((product) => productSourceType(product)).filter(Boolean))];
  const hasWardrobe = outfits.some((outfit) => productSourceType(outfit, outfit.source || 'wardrobe') === 'wardrobe')
    || products.some((product) => productSourceType(product) === 'wardrobe')
    || wardrobeItems.length > 0;
  const asksWardrobe = /\b(wardrobe|closet|mine|owned|already\s+have|have\s+these|have\s+this)\b/.test(normalizeChat(message));
  const asksAmazon = /\b(amazon|online|shopping|shop)\b/.test(normalizeChat(message));
  if (!visibleEntry) return 'I do not have visible product or wardrobe cards in this chat yet. Ask me to search products or check your wardrobe first.';
  if (asksWardrobe && products.some((product) => productSourceType(product) !== 'wardrobe')) {
    const sourceNames = productSources.map(sourceLabel).filter(Boolean).join(', ') || 'shopping results';
    return `No. Those visible product cards are ${sourceNames}, not items from your wardrobe. I can check your wardrobe separately for a similar look.`;
  }
  if (asksWardrobe && hasWardrobe) return 'Yes. The visible wardrobe or outfit cards are built from your wardrobe items.';
  if (asksAmazon) {
    return productSources.includes('amazon')
      ? 'Yes, those visible product cards are Amazon shopping results. They are not wardrobe items unless you save or upload them.'
      : 'No, those visible cards are not Amazon results.';
  }
  const sourceNames = [...new Set(productSources.map(sourceLabel).filter(Boolean))].join(', ') || (hasWardrobe ? 'Wardrobe item' : 'visible results');
  return `The visible cards are ${sourceNames}. Wardrobe items and shopping results are separate.`;
}

function preferenceValue(map, key) {
  if (!map || !key) return 0;
  return map.get?.(key) || map[key] || 0;
}

function eventWeight(type) {
  return EVENT_WEIGHTS[type] || 1;
}

function productPreferenceIncrements(product, weight) {
  const increments = {};
  const add = (bucket, value, scale = 1) => {
    const key = normalizeKey(value);
    if (!key) return;
    increments[`${bucket}.${key}`] = (increments[`${bucket}.${key}`] || 0) + weight * scale;
  };

  add('categories', product?.category, 1);
  add('brands', product?.brand, 0.75);
  add('genders', product?.gender, 0.8);
  (product?.tags || []).slice(0, 10).forEach((tag) => add('tags', tag, 0.7));
  if (Number.isFinite(Number(product?.price))) {
    increments.priceTotal = Number(product.price) * weight;
    increments.priceCount = weight;
  }
  return increments;
}

function queryPreferenceIncrements(query, weight) {
  const increments = {};
  queryTerms(query).forEach((term) => {
    const key = normalizeKey(term);
    if (key) increments[`tags.${key}`] = (increments[`tags.${key}`] || 0) + weight;
  });
  return increments;
}

async function updatePreference({ userId, type, product, query, metadata }) {
  const weight = eventWeight(type);
  const preferenceSource = product || metadata?.product || metadata;
  const increments = {
    ...queryPreferenceIncrements(query, weight),
    ...productPreferenceIncrements(preferenceSource, weight)
  };
  if (Object.keys(increments).length === 0) return null;

  return UserPreference.findOneAndUpdate(
    { user: userId },
    { $inc: increments, $setOnInsert: { user: userId } },
    { upsert: true, new: true }
  );
}

function scoreProduct(product, preference) {
  if (!preference) return 0;
  const categoryScore = preferenceValue(preference.categories, normalizeKey(product.category)) * 4;
  const brandScore = preferenceValue(preference.brands, normalizeKey(product.brand)) * 2;
  const genderScore = preferenceValue(preference.genders, normalizeKey(product.gender)) * 3;
  const tagScore = (product.tags || []).slice(0, 12).reduce((sum, tag) => sum + preferenceValue(preference.tags, normalizeKey(tag)), 0) * 2.5;
  const averagePrice = preference.priceCount ? preference.priceTotal / preference.priceCount : 0;
  const price = Number(product.price);
  const priceFit = averagePrice && Number.isFinite(price) ? Math.max(0, 2 - Math.abs(price - averagePrice) / Math.max(averagePrice, 1)) : 0;
  const recencyBoost = product.isNewArrival ? 0.8 : 0;
  const featuredBoost = product.isFeatured ? 0.8 : 0;
  const ratingBoost = Number(product.rating || 0) / 5;
  return categoryScore + brandScore + genderScore + tagScore + priceFit + recencyBoost + featuredBoost + ratingBoost;
}

function similarScore(base, product) {
  const baseTags = new Set((base.tags || []).map(normalizeKey).filter(Boolean));
  const productTags = (product.tags || []).map(normalizeKey).filter(Boolean);
  const sharedTags = productTags.filter((tag) => baseTags.has(tag)).length;
  const basePrice = Number(base.price);
  const price = Number(product.price);
  const priceFit = Number.isFinite(basePrice) && Number.isFinite(price) ? Math.max(0, 2 - Math.abs(price - basePrice) / Math.max(basePrice, 1)) : 0;
  return (
    (normalizeKey(base.category) === normalizeKey(product.category) ? 6 : 0) +
    (normalizeKey(base.gender) === normalizeKey(product.gender) ? 3 : 0) +
    (normalizeKey(base.brand) === normalizeKey(product.brand) ? 2 : 0) +
    sharedTags * 2 +
    priceFit +
    (product.isNewArrival ? 0.5 : 0) +
    Number(product.rating || 0) / 5
  );
}

router.post('/events', requireUser, async (req, res) => {
  const type = String(req.body?.type || '').trim();
  if (!EVENT_WEIGHTS[type]) return res.status(400).json({ message: 'Unknown recommendation event type' });

  const productId = String(req.body?.productId || '').trim();
  const query = String(req.body?.query || '').trim();
  const product = mongoose.Types.ObjectId.isValid(productId)
    ? await Product.findOne({ _id: productId, isActive: true }).lean()
    : null;

  await UserEvent.create({
    user: req.user._id,
    type,
    product: product?._id,
    query,
    weight: eventWeight(type),
    metadata: req.body?.metadata || {}
  });
  await updatePreference({ userId: req.user._id, type, product, query, metadata: req.body?.metadata || {} });
  res.status(201).json({ ok: true });
});

router.get('/recent-searches', requireUser, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 12);
  const events = await UserEvent.find({
    user: req.user._id,
    type: 'search',
    query: { $exists: true, $ne: '' }
  })
    .sort({ createdAt: -1 })
    .limit(limit * 8)
    .lean();

  const seen = new Set();
  const searches = [];
  for (const event of events) {
    const query = String(event.query || '').trim();
    const key = query.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    searches.push({ query, createdAt: event.createdAt });
    if (searches.length >= limit) break;
  }

  res.json({ searches });
});

const wearableProductPattern = /\b(dresses?|gowns?|frocks?|bodycon|maxi|midi|mini\s*dress|a-line\s*dress|wrap\s*dress|party\s*dress|cocktail\s*dress|slip\s*dress|shirt\s*dress|skater\s*dress|sarees?|saris?|lehengas?|dupattas?|kurtas?|kurtis?|salwars?|churidars?|anarkali|palazzos?|shararas?|ethnic\s*wear|shirts?|t\s*-?\s*shirts?|tshirts?|tees?|tops?|blouses?|tunics?|pants?|trousers?|trackpants?|joggers?|leggings?|jeans?|denims?|bottomwear|shorts?|skirts?|jackets?|coats?|blazers?|hoodies?|sweatshirts?|sweaters?|suits?|waistcoats?|vests?|shoes?|sneakers?|heels?|sandals?|boots?|slippers?|footwear|loafers?|pumps?|flats?|watches?|smart\s*watches?|bags?|handbags?|wallets?|purses?|belts?|caps?|hats?|scarves?|sunglasses?|eyewear|glasses|jewellery|jewelry|earrings?|necklaces?|bracelets?|accessories|loungewear|sleepwear|nightwear|pajamas?|pyjamas?|swimwear|bikinis?|cover\s*ups?|beachwear)\b/i;
const nonWearableSearchPattern = /\b(beauty|makeup|cosmetics?|perfume|fragrance|skincare|serum|lipsticks?|cookware|kitchen|home\s*decor|furniture|appliances?|toys?|books?|electronics?|phones?|laptops?|groceries|food|medicine|kids?\s*toys?)\b/i;
const fashionSignalPattern = /\b(black|white|red|pink|blue|green|yellow|beige|brown|maroon|purple|lavender|grey|gray|cream|linen|cotton|denim|silk|wool|leather|formal|casual|classy|streetwear|old\s*money|minimal|oversized|slim|regular|under|below|upto|up\s*to|budget|rs\.?|inr|₹|men|women|male|female|unisex)\b/i;
const occasionOnlyPattern = /\b(beach|pool|vacation|holiday|resort|travel|airport|wedding|engagement|reception|sangeet|haldi|diwali|festival|festive|eid|christmas|halloween|party|club|concert|brunch|date|dinner|office|work|interview|college|campus|gym|workout|summer|winter|rainy|monsoon)\b/i;
const sourceChoicePattern = /^(?:check\s+(?:my\s+)?wardrobe|wardrobe|closet|my\s+closet|search\s+online|search\s+amazon|shop\s+online|online|amazon|show\s+products?)$/i;

function fashionSearchBlock(message = '') {
  const lower = String(message || '').toLowerCase();
  if (!nonWearableSearchPattern.test(lower)) return '';
  return 'AI Studio can search wearable fashion here. Try shirts, dresses, pants, shoes, jackets, ethnic wear, watches, bags, or accessories by colour, budget, occasion, fabric, or vibe.';
}

function aiStudioChoiceAction(message = '') {
  const normalized = String(message || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(?:check\s+(?:my\s+)?wardrobe|wardrobe|closet|my closet)$/.test(normalized)) return 'wardrobe';
  if (/^(?:search\s+online|search\s+amazon|shop\s+online|online|amazon|show products?)$/.test(normalized)) return 'online';
  return '';
}

function latestUserContext(history = [], fallback = '') {
  const currentAction = aiStudioChoiceAction(fallback);
  const entries = Array.isArray(history) ? history : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== 'user') continue;
    const text = String(entry.text || '').trim();
    if (!text || aiStudioChoiceAction(text)) continue;
    return text.slice(0, 600);
  }
  return currentAction ? '' : String(fallback || '').trim().slice(0, 600);
}

function isLookmefyHelpQuestion(message = '') {
  const lower = String(message || '').toLowerCase();
  return mentionsLookmefy(message)
    || /\b(token|tokens|credit|credits|balance|refund|otp|login|account|privacy|delete account|support|profile photo|body photo|try\s*on|generation|generated|video try|wishlist|history)\b/.test(lower);
}

function lookmefyHelpReply(message = '', userContext = {}) {
  const lower = String(message || '').toLowerCase();
  if (!isLookmefyHelpQuestion(message)) return null;
  const profile = userContext.profile || {};
  const tokenText = Number.isFinite(Number(profile.tokens)) ? ` You currently have ${Number(profile.tokens)} token${Number(profile.tokens) === 1 ? '' : 's'}.` : '';
  const photoStatus = profile.bodyPhotoStatus ? ` Your try-on profile status is ${profile.bodyPhotoStatus}.` : '';
  if (/\b(token|tokens|credit|credits|balance|refund)\b/.test(lower)) {
    return {
      reply: `Tokens are Lookmefy credits for generation actions like AI try-on images, video try-ons, custom try-ons, and closet look generation. Browsing, asking AI Studio, wardrobe checks, and opening product links do not spend tokens.${tokenText}`,
      products: [],
      suggestions: ['Try on a product', 'Check wardrobe', 'Search products'],
      intent: 'lookmefy_help',
      mode: 'rag_help'
    };
  }
  if (/\b(try\s*on|generation|generated|video try|profile photo|body photo)\b/.test(lower)) {
    return {
      reply: `AI try-on needs a ready profile/body photo and enough tokens before generation can start.${photoStatus} AI previews are estimates, so fit, color, material, and proportions can differ from real life.`,
      products: [],
      suggestions: ['Search products', 'Check wardrobe', 'Upload profile photo'],
      intent: 'lookmefy_help',
      mode: 'rag_help'
    };
  }
  if (/\b(wardrobe|closet)\b/.test(lower)) {
    return {
      reply: `Your wardrobe is where uploaded clothes become styling inputs. I can build looks from saved wardrobe items first, then search products only when a piece is missing or you ask to shop.`,
      products: [],
      suggestions: ['Check wardrobe', 'Search missing piece'],
      intent: 'lookmefy_help',
      mode: 'rag_help'
    };
  }
  const wantsFeatures = /\b(feature|features|explain|how|work|works)\b/.test(lower);
  return {
    reply: wantsFeatures
      ? 'Lookmefy helps you discover fashion products, manage a digital wardrobe, create AI try-on images and videos, and track credits from your profile. In AI Studio, ask for an item, occasion, budget, colour, fabric, or vibe and I can search products or help style from your wardrobe.'
      : 'Lookmefy is an AI fashion app for shopping, wardrobe planning, and virtual try-ons. You can find products, save wardrobe pieces, preview looks on your profile, and manage credits in one place.',
    products: [],
    suggestions: ['Beach outfit', 'Kurta for wedding', 'Black shirt under INR 1000'],
    intent: 'lookmefy_help',
    mode: 'rag_help'
  };
}

function naturalAiStudioReply(message = '') {
  const lower = String(message || '').toLowerCase().trim();
  if (isGreetingOnly(message) || isCasualGreetingPrefix(message)) {
    return {
      reply: 'Hey. What are we styling today? Tell me an occasion, item, budget, colour, or vibe.',
      products: [],
      suggestions: ['Beach outfit', 'Kurta for wedding', 'Black shirt under ₹1000'],
      intent: 'greeting',
      mode: 'chat_control'
    };
  }
  if (/^(thanks|thank you|thx|cool|nice|great|perfect|okay|ok|k|love it|looks good|sounds good)[!.\s]*$/i.test(lower)) {
    return {
      reply: 'Anytime. Want wardrobe help, online products, or a try-on plan?',
      products: [],
      suggestions: ['Check wardrobe', 'Search online', 'Try on'],
      intent: 'small_talk',
      mode: 'chat_control'
    };
  }
  if (/\b(how are you|what'?s up)\b/i.test(lower)) {
    return {
      reply: 'I’m good and ready to style. Give me an occasion, product, budget, colour, fabric, or vibe.',
      products: [],
      suggestions: ['Office outfit', 'Casual sneakers', 'Linen shirts'],
      intent: 'small_talk',
      mode: 'chat_control'
    };
  }
  if (/\b(who are you|what can you do)\b/i.test(lower)) {
    return {
      reply: 'I can help with outfit ideas, wardrobe checks, shopping searches, try-on planning, and Lookmefy questions.',
      products: [],
      suggestions: ['Beach outfit', 'Search online', 'What is Lookmefy?'],
      intent: 'lookmefy_help',
      mode: 'rag_help'
    };
  }
  return null;
}

function hasFashionSignal(message = '') {
  const value = String(message || '');
  return (
    wearableProductPattern.test(value) ||
    occasionOnlyPattern.test(value) ||
    fashionSignalPattern.test(value) ||
    budgetCeiling(value)
  );
}

function unclearFashionReply(message = '') {
  const compact = String(message || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const words = String(message || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (sourceChoicePattern.test(String(message || '').trim())) return '';
  if (hasFashionSignal(message)) return '';
  if (!compact) return '';
  if (words.length <= 2 && compact.length >= 8) {
    return 'I could not understand that as a fashion request. Try something specific like "beach outfit", "kurta for wedding", "black shirt under ₹1000", or "office shoes".';
  }
  return 'Give me one fashion detail and I will make it useful: an item, occasion, place, budget, colour, fabric, or vibe. For example: "beach outfit", "kurta for wedding", or "white sneakers under ₹1500".';
}

function outOfScopeReply() {
  return 'I can only help with Lookmefy, fashion, wardrobe, shopping, products, tokens, profile, and AI try-on. Try “beach outfit”, “kurta for wedding”, “black shirt under INR 1000”, or “how do Lookmefy tokens work?”';
}

function shouldBlockOutOfScopeQuestion(message = '') {
  const lower = normalizeChat(message);
  if (!lower || isGreetingOnly(message) || isCasualGreetingPrefix(message) || isLookmefyHelpQuestion(message) || hasFashionSignal(message)) return false;
  return /\b(who|what|where|when|why|how|tell me|explain|write|code|solve|calculate|capital|president|prime minister|pm|minister|weather|news|stock|crypto|recipe|movie|song)\b/.test(lower)
    || lower.endsWith('?');
}

function shouldAskSourceChoice(message = '') {
  const value = String(message || '').trim();
  if (!value || sourceChoicePattern.test(value)) return false;
  if (wearableProductPattern.test(value)) return false;
  if (budgetCeiling(value)) return false;
  return occasionOnlyPattern.test(value) || /\b(outfit|look|wear|style|dress me|what should i wear)\b/i.test(value);
}

function sourceChoiceReply(message = '') {
  const context = String(message || 'this').replace(/\s+/g, ' ').trim();
  return {
    reply: `For ${context}, do you want me to build from your wardrobe first or search online for product options?`,
    products: [],
    suggestions: ['Check wardrobe', 'Search online']
  };
}

function onlineSearchPromptForContext(message = '', user = {}) {
  const prompt = String(message || '').trim();
  if (!prompt) return '';
  if (wearableProductPattern.test(prompt)) return prompt;
  const genderWord = user?.genderPreference === 'male' ? 'men' : user?.genderPreference === 'female' ? 'women' : '';
  const lower = prompt.toLowerCase();
  if (/\bbeach|pool|resort\b/.test(lower)) return `${genderWord} beach outfit beachwear swimwear sandals`.trim();
  if (/\bdiwali|festival|festive|eid\b/.test(lower)) return `${genderWord} festive ethnic outfit kurta saree lehenga`.trim();
  if (/\bwedding|engagement|reception|sangeet|haldi\b/.test(lower)) return `${genderWord} wedding guest outfit ethnic wear`.trim();
  if (/\bhalloween\b/.test(lower)) return `${genderWord} halloween costume outfit`.trim();
  if (/\bchristmas\b/.test(lower)) return `${genderWord} christmas party outfit`.trim();
  if (/\boffice|work|interview\b/.test(lower)) return `${genderWord} office outfit formal wear`.trim();
  if (/\bgym|workout\b/.test(lower)) return `${genderWord} gym activewear outfit`.trim();
  if (/\btravel|airport|vacation|holiday\b/.test(lower)) return `${genderWord} travel outfit vacation wear`.trim();
  return `${prompt} ${genderWord} outfit`.replace(/\s+/g, ' ').trim();
}

function closetText(item = {}) {
  return [
    item.name,
    item.category,
    item.color,
    item.fabric,
    item.pattern,
    item.season,
    item.formality,
    ...(item.occasions || []),
    ...(item.tags || [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function extractFashionFilters(message = '', user = {}) {
  const lower = normalizeChat(message);
  const budget = budgetCeiling(message);
  const categoryMap = [
    ['dresses', /\b(dress(?:es)?|gowns?|frocks?|bodycon|maxi|midi|mini)\b/],
    ['ethnic', /\b(kurtas?|kurtis?|sarees?|saris?|lehengas?|salwars?|anarkali|ethnic|festive)\b/],
    ['tops', /\b(shirts?|t-?shirts?|tshirts?|tees?|tops?|blouses?|tunics?|hoodies?)\b/],
    ['bottoms', /\b(pants?|trousers?|jeans?|denims?|joggers?|leggings?|shorts?|skirts?)\b/],
    ['shoes', /\b(shoes?|sneakers?|heels?|sandals?|boots?|loafers?|pumps?|flats?|footwear)\b/],
    ['outerwear', /\b(jackets?|coats?|blazers?|sweaters?|sweatshirts?)\b/],
    ['accessories', /\b(watches?|bags?|handbags?|belts?|scarves?|sunglasses?|jewellery|jewelry|earrings?|necklaces?|bracelets?|accessories)\b/],
    ['activewear', /\b(gym|workout|activewear|trackpants?|sports?\s*bra)\b/]
  ];
  const category = categoryMap.find(([, pattern]) => pattern.test(lower))?.[0] || '';
  return {
    category,
    gender: productGenderForPreference(user?.genderPreference) || '',
    color: lower.match(/\b(black|white|red|pink|blue|green|yellow|beige|brown|maroon|purple|lavender|grey|gray|cream|gold|silver|navy)\b/)?.[1] || '',
    material: lower.match(/\b(cotton|linen|denim|silk|leather|wool|georgette|chiffon|satin)\b/)?.[1] || '',
    occasion: lower.match(/\b(beach|pool|vacation|holiday|resort|travel|airport|wedding|engagement|reception|sangeet|haldi|diwali|festival|festive|eid|christmas|halloween|party|club|concert|brunch|date|dinner|office|work|interview|college|campus|gym|workout|summer|winter|rainy|monsoon)\b/)?.[1] || '',
    style: detectCelebrityStyleRequest(message) ? 'celebrity-inspired' : (lower.match(/\b(classy|casual|formal|minimal|streetwear|old\s*money|glam|party|oversized|slim|regular)\b/)?.[1] || ''),
    budget
  };
}

function desiredOutfitGroups(filters = {}) {
  if (filters.category === 'dresses') return [['dresses'], ['shoes']];
  if (filters.category === 'ethnic') return [['ethnic', 'dresses', 'suits'], ['shoes']];
  if (filters.category === 'shoes') return [['shoes']];
  if (filters.category === 'accessories') return [['accessories']];
  if (filters.category === 'outerwear') return [['outerwear'], ['tops'], ['bottoms']];
  if (filters.occasion && /\b(wedding|engagement|reception|sangeet|haldi|diwali|festival|festive|eid)\b/.test(filters.occasion)) return [['ethnic', 'dresses', 'suits'], ['shoes'], ['accessories']];
  if (filters.occasion && /\b(gym|workout)\b/.test(filters.occasion)) return [['activewear', 'tops'], ['bottoms', 'activewear'], ['shoes']];
  return [['dresses', 'ethnic', 'suits'], ['tops'], ['bottoms'], ['shoes']];
}

function itemMatchesGroup(item = {}, group = []) {
  return group.includes(item.category);
}

function scoreClosetItemForFilters(item = {}, filters = {}, preference = null) {
  const text = closetText(item);
  let score = item.favorite ? 8 : 0;
  if (filters.category && item.category === filters.category) score += 22;
  if (filters.color && normalizeKey(item.color) === normalizeKey(filters.color)) score += 16;
  if (filters.material && text.includes(filters.material)) score += 10;
  if (filters.occasion && text.includes(filters.occasion)) score += 14;
  if (filters.style && text.includes(filters.style.replace(/\s+/g, ' '))) score += 8;
  if (item.formality && filters.occasion && /\b(office|work|interview)\b/.test(filters.occasion) && ['formal', 'smart-casual'].includes(item.formality)) score += 10;
  if (item.formality && filters.occasion && /\b(party|club|concert|date|dinner)\b/.test(filters.occasion) && ['party', 'smart-casual', 'formal'].includes(item.formality)) score += 8;
  if (item.lastWornAt) score -= 1;
  score += Math.min(Number(item.wearCount || 0), 10) / 4;
  score += (preferenceValue(preference?.categories, normalizeKey(item.category)) || 0) * 2;
  score += (item.tags || []).slice(0, 8).reduce((sum, tag) => sum + preferenceValue(preference?.tags, normalizeKey(tag)), 0);
  return score;
}

function bestClosetItemForGroup(items = [], group = [], filters = {}, usedIds = new Set(), preference = null) {
  return items
    .filter((item) => itemMatchesGroup(item, group) && !usedIds.has(String(item.id || item._id)))
    .map((item) => ({ item, score: scoreClosetItemForFilters(item, filters, preference) }))
    .sort((a, b) => b.score - a.score || Number(b.item.favorite) - Number(a.item.favorite) || new Date(b.item.updatedAt || 0) - new Date(a.item.updatedAt || 0))[0] || null;
}

function buildWardrobeOutfitOptions(items = [], message = '', userContext = {}) {
  const filters = extractFashionFilters(message, userContext.profile);
  const groups = desiredOutfitGroups(filters);
  const used = new Set();
  const selected = [];
  const missing = [];

  for (const group of groups) {
    if (selected.some((item) => ['dresses', 'ethnic', 'suits'].includes(item.category)) && (group.includes('tops') || group.includes('bottoms'))) continue;
    const best = bestClosetItemForGroup(items, group, filters, used, userContext.preference);
    if (best?.item && best.score > 0) {
      selected.push(best.item);
      used.add(String(best.item.id || best.item._id));
    } else if (!group.some((category) => ['outerwear', 'accessories'].includes(category))) {
      missing.push(group[0]);
    }
  }

  const accessory = bestClosetItemForGroup(items, ['outerwear', 'accessories'], filters, used, userContext.preference);
  if (accessory?.item && selected.length >= 2 && accessory.score >= 4) selected.push(accessory.item);

  const score = selected.reduce((sum, item) => sum + scoreClosetItemForFilters(item, filters, userContext.preference), 0) - missing.length * 15;
  const wardrobeFit = missing.length ? (selected.length >= 2 ? 'partial' : 'weak') : selected.length >= 2 || ['shoes', 'accessories'].includes(filters.category) ? 'strong' : 'partial';
  if (!selected.length) return [];
  return [{
    id: `wardrobe-${selected.map((item) => item.id || item._id).join('-')}`,
    title: filters.occasion ? `${titleCaseWords(filters.occasion)} wardrobe look` : `${selected[0].name || 'Wardrobe'} look`,
    source: 'wardrobe',
    sourceLabel: 'Wardrobe item',
    items: selected.map(closetItemToClient),
    missing,
    score: Math.round(score),
    wardrobeFit,
    reason: missing.length
      ? `Your wardrobe has ${selected.map((item) => item.name).join(', ')}, but it still needs ${missing.map((item) => item.replace(/s$/, '')).join(', ')}.`
      : `This uses ${selected.map((item) => item.name).join(', ')} from your wardrobe.`
  }];
}

function scoreClosetItemForContext(item = {}, message = '') {
  const context = String(message || '').toLowerCase();
  const text = closetText(item);
  let score = item.favorite ? 4 : 0;
  for (const term of queryTerms(context)) {
    if (text.includes(term)) score += 4;
  }
  if (/\bbeach|pool|resort|vacation|summer\b/.test(context) && ['tops', 'dresses', 'shoes', 'accessories'].includes(item.category)) score += 4;
  if (/\bwedding|diwali|festival|festive|eid\b/.test(context) && ['ethnic', 'dresses', 'suits', 'shoes', 'accessories'].includes(item.category)) score += 5;
  if (/\boffice|work|interview|formal\b/.test(context) && ['tops', 'bottoms', 'suits', 'shoes', 'outerwear'].includes(item.category)) score += 4;
  if (/\bgym|workout\b/.test(context) && ['activewear', 'shoes', 'tops', 'bottoms'].includes(item.category)) score += 4;
  if (!item.lastWornAt) score += 1;
  return score;
}

async function wardrobeReplyForContext(userOrContext, message = '') {
  const isLoadedContext = Array.isArray(userOrContext?.wardrobe);
  const userContext = isLoadedContext ? userOrContext : null;
  const user = userContext?.user || userOrContext;
  const items = userContext?.wardrobe || (await ClosetItem.find({ user: user._id }).sort({ favorite: -1, updatedAt: -1 }).limit(80).lean()).map(closetItemToClient);
  if (!items.length) {
    return {
      reply: 'Your wardrobe is empty right now. Upload a few clothes first, or I can search online for product options instead.',
      products: [],
      outfits: [],
      suggestions: ['Search online'],
      intent: 'wardrobe_outfit_check',
      mode: 'wardrobe_check'
    };
  }
  const outfitOptions = buildWardrobeOutfitOptions(items, message, userContext || { profile: userPublicContext(user), preference: null });
  const ranked = outfitOptions[0]?.items?.length
    ? outfitOptions[0].items
    : items
        .map((item) => ({ item, score: scoreClosetItemForContext(item, message) }))
        .sort((a, b) => b.score - a.score || new Date(b.item.updatedAt || 0) - new Date(a.item.updatedAt || 0))
        .slice(0, 4)
        .map(({ item }) => item);
  if (!ranked.length && !outfitOptions.length) {
    return {
      reply: 'I could not find a strong wardrobe match for that. Add a few more tagged items, or search online for product options.',
      products: [],
      outfits: [],
      suggestions: ['Search online'],
      intent: 'wardrobe_outfit_check',
      mode: 'wardrobe_check'
    };
  }
  const names = ranked.map((item) => item.name).filter(Boolean);
  const missing = outfitOptions[0]?.missing || [];
  return {
    reply: missing.length
      ? `From your wardrobe, start with ${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names[3]}` : ''}. It is a partial match, so I would search for ${missing.map((item) => item.replace(/s$/, '')).join(', ')} to complete it.`
      : `From your wardrobe, start with ${names.slice(0, 3).join(', ')}${names.length > 3 ? `, and ${names[3]}` : ''}. These are the closest complete matches I found for ${String(message || 'your plan').trim()}.`,
    products: [],
    outfits: outfitOptions,
    suggestions: missing.length ? ['Search missing piece', 'Search online'] : ['Search online', 'Try on this look'],
    intent: 'wardrobe_outfit_check',
    mode: outfitOptions[0]?.wardrobeFit === 'strong' ? 'wardrobe_first' : 'hybrid_wardrobe_shopping'
  };
}

function productLooksWearable(product = {}, query = '') {
  return wearableCompatibility(product, { query }).compatible;
}

function productSearchText(product = {}) {
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    product.gender,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.colors) ? product.colors : [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function productMatchesRequestedCategory(product = {}, filters = {}) {
  if (!filters.category) return true;
  const text = productSearchText(product);
  const category = normalizeKey(product.category);
  if (category === normalizeKey(filters.category)) return true;
  if (filters.category === 'dresses') return /\b(dress|gown|frock|maxi|midi|bodycon|a-line)\b/.test(text);
  if (filters.category === 'ethnic') return /\b(kurta|kurti|saree|sari|lehenga|salwar|anarkali|ethnic)\b/.test(text);
  if (filters.category === 'tops') return /\b(shirt|tshirt|t-shirt|tee|top|blouse|tunic|hoodie)\b/.test(text);
  if (filters.category === 'bottoms') return /\b(pant|trouser|jean|denim|jogger|legging|short|skirt)\b/.test(text);
  if (filters.category === 'shoes') return /\b(shoe|sneaker|heel|sandal|boot|loafer|pump|flat|footwear)\b/.test(text);
  if (filters.category === 'outerwear') return /\b(jacket|coat|blazer|sweater|sweatshirt)\b/.test(text);
  if (filters.category === 'accessories') return /\b(watch|bag|belt|scarf|sunglass|jewel|earring|necklace|bracelet|accessor)\b/.test(text);
  return text.includes(filters.category);
}

function readFashionPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === '') return null;
  const numeric = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0];
  return numeric ? Number(numeric) : null;
}

function productPriceMatchesBudget(product = {}, filters = {}) {
  if (!filters.budget) return true;
  const price = readFashionPrice(product.price);
  return price !== null && price <= filters.budget;
}

function productMatchesRequiredFashionFilters(product = {}, filters = {}) {
  const text = productSearchText(product);
  if (filters.category && !productMatchesRequestedCategory(product, filters)) return false;
  if (filters.color && !textHasFashionTerm(text, filters.color)) return false;
  if (filters.material && !textHasFashionTerm(text, filters.material)) return false;
  if (!productPriceMatchesBudget(product, filters)) return false;
  return true;
}

function scoreFashionProductCandidate(product = {}, message = '', user = {}, source = '') {
  const text = productSearchText(product);
  const filters = extractFashionFilters(message, user);
  const preferredGender = productGenderForPreference(user?.genderPreference);
  const price = Number(product.price);
  let score = 0;
  if (!productMatchesRequiredFashionFilters(product, filters)) return -1000;
  if (productLooksWearable(product, message)) score += 25;
  if (filters.category) score += productMatchesRequestedCategory(product, filters) ? 24 : -18;
  if (preferredGender && String(product.gender || '').toLowerCase() === preferredGender) score += 12;
  if (preferredGender && String(product.gender || '').toLowerCase() === 'unisex') score += 5;
  if (filters.budget && Number.isFinite(price)) {
    score += price <= filters.budget ? 16 : -Math.min(18, Math.ceil((price - filters.budget) / Math.max(filters.budget, 1) * 20));
  }
  if (filters.color && text.includes(filters.color)) score += 10;
  if (filters.material && text.includes(filters.material)) score += 8;
  if (filters.occasion && text.includes(filters.occasion)) score += 7;
  if (filters.style && filters.style !== 'celebrity-inspired' && text.includes(filters.style)) score += 6;
  for (const term of fashionCatalogTerms(message)) {
    if (text.includes(term)) score += 4;
  }
  if (product.imageUrl || product.thumbnail || product.image?.remoteUrl || product.image?.url) score += 8;
  if (product.sourceUrl || product.affiliateLink) score += 4;
  if (source === 'amazon') score += 3;
  if (source === 'catalog-fallback') score += 1;
  score += Math.min(Number(product.rating || 0), 5);
  return score;
}

function amazonFashionQuery(message = '', user = {}) {
  const prompt = String(message || '').trim();
  const celebrityStyle = detectCelebrityStyleRequest(prompt);
  if (celebrityStyle && !wearableProductPattern.test(prompt)) {
    const genderWord = user?.genderPreference === 'male' ? 'men' : user?.genderPreference === 'female' ? 'women' : '';
    const vibe = normalizeChat(prompt).match(/\b(airport|casual|party|glam|ethnic|festive|red\s*carpet|formal|classy)\b/g)?.join(' ') || 'fashion';
    return `${genderWord} ${vibe} outfit dress top trousers shoes`.replace(/\s+/g, ' ').trim();
  }
  if (wearableProductPattern.test(prompt)) return prompt;
  const genderWord = user?.genderPreference === 'male' ? 'men' : user?.genderPreference === 'female' ? 'women' : '';
  return `${prompt} ${genderWord} fashion`.replace(/\s+/g, ' ').trim();
}

function budgetCeiling(message = '') {
  const match = String(message || '').match(/(?:under|below|upto|up to|less than)\s*(?:rs\.?|₹|inr)?\s*(\d{2,6})/i);
  const value = Number(match?.[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function fashionCatalogTerms(message = '') {
  return queryTerms(message)
    .filter((term) => !['fashion', 'wear', 'under', 'below', 'upto', 'than', 'women', 'woman', 'female', 'mens', 'male'].includes(term))
    .slice(0, 8);
}

function scoreCatalogFashion(product = {}, message = '', user = {}) {
  const text = [
    product.name,
    product.brand,
    product.category,
    product.description,
    ...(Array.isArray(product.tags) ? product.tags : []),
    ...(Array.isArray(product.colors) ? product.colors : [])
  ].filter(Boolean).join(' ').toLowerCase();
  const terms = fashionCatalogTerms(message);
  const budget = budgetCeiling(message);
  const preferredGender = productGenderForPreference(user?.genderPreference);
  const price = Number(product.price);
  const filters = extractFashionFilters(message, user);

  let score = scoreFashionProductCandidate(product, message, user, 'catalog-fallback');
  if (productLooksWearable(product, message)) score += 18;
  if (filters.category) score += productMatchesRequestedCategory(product, filters) ? 12 : -20;
  if (preferredGender && String(product.gender || '').toLowerCase() === preferredGender) score += 10;
  if (preferredGender && String(product.gender || '').toLowerCase() === 'unisex') score += 4;
  if (budget && Number.isFinite(price) && price <= budget) score += 12;
  if (budget && Number.isFinite(price) && price > budget) score -= Math.min(10, Math.ceil((price - budget) / Math.max(budget, 1) * 10));
  for (const term of terms) {
    if (text.includes(term)) score += 5;
  }
  if (product.isFeatured) score += 2;
  if (product.isNewArrival) score += 1.5;
  score += Math.min(Number(product.rating || 0), 5) / 2;
  return score;
}

async function catalogFashionFallback(message = '', user = {}) {
  const preferredGender = productGenderForPreference(user?.genderPreference);
  const filters = extractFashionFilters(message, user);
  const genderFilter = preferredGender ? { $or: [{ gender: preferredGender }, { gender: 'unisex' }, { gender: { $exists: false } }] } : {};
  const query = catalogFilter(genderFilter);
  let products = await Product.find(query).sort({ isFeatured: -1, isNewArrival: -1, rating: -1, createdAt: -1 }).limit(80).lean();

  if (products.length < 4) {
    products = await Product.find(catalogFilter()).sort({ isFeatured: -1, isNewArrival: -1, rating: -1, createdAt: -1 }).limit(180).lean();
  }

  return products
    .filter((product) => productLooksWearable(product, message))
    .filter((product) => productMatchesRequiredFashionFilters(product, filters))
    .map((product) => ({
      product,
      score: scoreCatalogFashion(product, message, user)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ product }) => withSourceMetadata({ ...productToClient(product), searchSource: 'catalog-fallback' }, 'catalog-fallback'));
}

function uniqueStrings(values = []) {
  const seen = new Set();
  return values
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function aiStudioSearchVariants(message = '', user = {}) {
  const prompt = String(message || '').trim();
  const base = amazonFashionQuery(prompt, user);
  const genderWord = user?.genderPreference === 'male' ? 'men' : 'women';
  const budget = prompt.match(/(?:under|below|upto|up to|less than)\s*(?:rs\.?|₹|inr)?\s*(\d{2,6})/i)?.[1];
  const colour = prompt.match(/\b(black|white|red|pink|blue|green|yellow|beige|brown|maroon|purple|lavender|grey|gray|cream)\b/i)?.[1] || '';
  const occasion = prompt.match(/\b(party|wedding|brunch|office|date|dinner|summer|vacation|casual|formal|cocktail|gym|travel|workout)\b/i)?.[1] || '';

  return uniqueStrings([
    base,
    `${base} ${genderWord}`,
    `${genderWord} ${base}`,
    colour ? `${colour} ${genderWord} fashion` : '',
    occasion ? `${occasion} ${genderWord} outfit` : '',
    budget ? `${genderWord} fashion under ${budget}` : '',
    `${prompt} clothing`,
    `${prompt} accessories`
  ]).slice(0, 5);
}

function aiStudioSearchFailureReply(detail = '') {
  const text = String(detail || '');
  if (/blocked|captcha|automated access|unusual traffic|robot/i.test(text)) {
    return 'Amazon is blocking live fashion search right now. Try a simpler request in a moment, like “black shirt under 1500”.';
  }
  if (/did not expose|no usable|no results|did not find|none were compatible|none could be used|compatible with AI try-on/i.test(text)) {
    return 'I could not find usable Amazon fashion cards for that request. Try another item type, colour, budget, or occasion and I will search again.';
  }
  if (/timed out|network|fetch|respond/i.test(text)) {
    return 'Live fashion search is taking longer than usual. Try again in a moment with a shorter query.';
  }
  return 'I could not complete live fashion search right now. Try another item type, colour, budget, or occasion.';
}

let aiStudioKnowledgeCache = null;

async function loadAiStudioKnowledge() {
  if (aiStudioKnowledgeCache) return aiStudioKnowledgeCache;
  try {
    const files = (await readdir(aiStudioKnowledgeDir)).filter((file) => file.endsWith('.md')).sort();
    const docs = await Promise.all(files.map(async (file) => {
      const content = await readFile(path.join(aiStudioKnowledgeDir, file), 'utf8');
      const title = content.match(/^#\s+(.+)$/m)?.[1] || file.replace(/\.md$/, '').replace(/-/g, ' ');
      return { id: file, file, title, content: content.replace(/^#\s+.+$/m, '').trim() };
    }));
    aiStudioKnowledgeCache = docs;
    return docs;
  } catch (error) {
    console.warn('[ai-studio] knowledge load failed', readableError(error));
    aiStudioKnowledgeCache = [];
    return aiStudioKnowledgeCache;
  }
}

function scoreKnowledgeDoc(doc = {}, message = '') {
  const text = `${doc.title || ''} ${doc.content || ''}`.toLowerCase();
  const terms = allQueryTerms(message).filter((term) => term.length >= 3);
  const matchedTerms = terms.filter((term) => text.includes(term));
  let score = matchedTerms.length * 4;
  if (/\btoken|credit|balance|refund\b/i.test(message) && /token|credit|refund/i.test(text)) score += 20;
  if (/\btry\s*on|generate|generation|video|profile photo|body photo\b/i.test(message) && /try-on|generation|profile|body photo/i.test(text)) score += 20;
  if (/\bwardrobe|closet|owned|mine\b/i.test(message) && /wardrobe|closet/i.test(text)) score += 20;
  if (/\bshop|search|buy|amazon|product|price|under|below\b/i.test(message) && /product search|amazon|catalog|budget/i.test(text)) score += 20;
  if (mentionsLookmefy(message) && /lookmefy|ai studio/i.test(text)) score += 12;
  return { ...doc, matchedTerms, score };
}

async function retrieveAiStudioKnowledge(message = '', limit = 5) {
  const docs = await loadAiStudioKnowledge();
  return docs
    .map((doc) => scoreKnowledgeDoc(doc, message))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function falAiStudioEndpoint() {
  return String(process.env.FAL_AI_STUDIO_ENDPOINT || process.env.FAL_CLOSET_VISION_ENDPOINT || 'openrouter/router/vision').replace(/^\/+|\/+$/g, '');
}

function falAiStudioModel() {
  return process.env.FAL_AI_STUDIO_MODEL || process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash-lite';
}

function falHeaders() {
  if (!process.env.FAL_KEY) throw Object.assign(new Error('FAL_KEY is missing on the server'), { statusCode: 503 });
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

async function findFashionProducts(message, user) {
  const { searchAmazonProductsForQuery } = await import('./products.js');
  const variants = aiStudioSearchVariants(message, user);
  const filters = extractFashionFilters(message, user);
  const cacheKey = JSON.stringify({
    variants: variants.map((item) => item.toLowerCase()),
    genderPreference: user?.genderPreference || '',
    requiredFilters: filters
  });
  const cached = await aiStudioFashionResultCache.get(cacheKey);
  if (cached) return Array.isArray(cached) ? { products: cached, source: 'amazon' } : cached;

  const failures = [];
  const products = [];
  const seen = new Set();
  for (const query of variants) {
    try {
      const batch = await searchAmazonProductsForQuery({
        query,
        limit: 6,
        user
      });
      for (const product of batch.filter((entry) => productLooksWearable(entry, message) && productMatchesRequiredFashionFilters(entry, filters))) {
        const key = product.sourceUrl || product.affiliateLink || product.id || product.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        products.push(withSourceMetadata(product, 'amazon'));
        if (products.length >= 18) break;
      }
      if (products.length >= 18) break;
    } catch (error) {
      failures.push(readableError(error));
    }
  }

  if (products.length) {
    const ranked = products
      .map((product) => ({ product, score: scoreFashionProductCandidate(product, message, user, 'amazon') }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ product }) => product)
      .slice(0, 6);
    const payload = { products: ranked.length ? ranked : products.slice(0, 6), source: 'amazon' };
    await aiStudioFashionResultCache.set(cacheKey, payload);
    return payload;
  }

  const fallbackProducts = await catalogFashionFallback(message, user);
  if (fallbackProducts.length) {
    const payload = {
      products: fallbackProducts,
      source: 'catalog-fallback',
      diagnostics: failures.slice(0, 5)
    };
    await aiStudioFashionResultCache.set(cacheKey, payload);
    return payload;
  }

  const error = new Error(aiStudioSearchFailureReply(failures.join(' | ')));
  error.statusCode = 200;
  error.publicMessage = error.message;
  error.diagnostics = failures.slice(0, 5);
  throw error;
}

function fashionFollowUps(message) {
  const lower = String(message || '').toLowerCase();
  if (/shoe|sneaker|heel|sandal|boot/.test(lower)) return ['White sneakers', 'Black formal shoes', 'Sandals under ₹999'];
  if (/shirt|tee|top|blouse/.test(lower)) return ['Black shirts under ₹999', 'Linen shirts', 'Oversized t-shirts'];
  if (/pant|trouser|jean|jogger|short/.test(lower)) return ['Office trousers', 'Relaxed jeans', 'Track pants under ₹999'];
  if (/watch|bag|belt|jewellery|jewelry|sunglass|accessor/.test(lower)) return ['Minimal watches', 'Crossbody bags', 'Sunglasses under ₹999'];
  if (/wedding|party|dinner|date|office|interview/.test(lower)) return ['Black party outfit', 'Office shirts', 'Wedding guest dress'];
  return ['Casual sneakers', 'Black shirts under ₹999', 'Office trousers'];
}

function aiStudioPrompt({ message, history, products, source = 'amazon', knowledge = [], context = {}, mode = 'product_search' }) {
  const sourceLabel = source === 'catalog-fallback' ? 'Lookmefy catalog' : 'Amazon';
  return [
    'You are Lookmefy AI Studio, the in-app assistant for fashion, wardrobe, shopping, AI try-on, tokens, profile, and Lookmefy help.',
    'Stay inside Lookmefy scope. Do not answer unrelated politics, news, general knowledge, coding, medical, legal, finance, or homework questions.',
    `Current mode: ${mode}. Recommend wearable clothing, footwear, ethnic wear, watches, bags, or accessories from the ${sourceLabel} result cards when product cards are supplied.`,
    'Do not recommend beauty, home, electronics, toys, groceries, or non-fashion products.',
    'Use user context only for personalization. Do not invent token balance, wardrobe items, saved outfits, product prices, or actions.',
    'If no result card fits, say that no matching fashion items are available and ask for another item type, colour, budget, or occasion.',
    source === 'catalog-fallback' ? 'Be transparent that live Amazon results were unavailable and these are catalog fallback picks.' : '',
    'If a user asks about a celebrity look, treat it as celebrity-inspired styling, not exact celebrity wardrobe knowledge.',
    'Reply conversationally in 2-4 short sentences. Do not claim a try-on image was generated.',
    '',
    `Latest user request: ${message}`,
    '',
    `User context summary: ${JSON.stringify({
      genderPreference: context.profile?.genderPreference,
      tokens: context.profile?.tokens,
      bodyPhotoStatus: context.profile?.bodyPhotoStatus,
      wardrobeCount: context.wardrobe?.length || 0,
      savedOutfitCount: context.savedOutfits?.length || 0,
      recentActivity: (context.recentActivity || []).slice(0, 6)
    })}`,
    '',
    `Lookmefy knowledge snippets: ${JSON.stringify((knowledge || []).slice(0, 5).map(({ title, content, matchedTerms }) => ({
      title,
      content: String(content || '').slice(0, 500),
      matchedTerms
    })))}`,
    '',
    `Recent conversation: ${JSON.stringify((Array.isArray(history) ? history : [])
      .slice(-8)
      .map((entry) => ({ role: entry.role === 'user' ? 'user' : 'assistant', text: String(entry.text || '').slice(0, 400) })))}`,
    '',
    `${sourceLabel} result cards: ${JSON.stringify(products.slice(0, 6).map(({ name, brand, category, gender, price, currency, colors, tags }) => ({
      name,
      brand,
      category,
      gender,
      price,
      currency,
      colors,
      tags
    })))}`
  ].join('\n');
}

function localFashionReply(message, products, source = 'amazon') {
  if (!products.length) {
    return 'I could not find matching fashion results. Try an item type, colour, occasion, budget, or fit and I will search again.';
  }
  const top = products.slice(0, 3).map((product) => product.name).filter(Boolean);
  if (source === 'catalog-fallback') {
    return `Live Amazon did not expose usable product cards, so I pulled matching fashion picks from the Lookmefy catalog for now. Start with ${top[0]}, then compare ${top.slice(1).join(' or ') || 'the remaining picks'} by price, colour, and occasion fit.`;
  }
  if (/black/i.test(message)) {
    return `I found black fashion options from Amazon. Start with ${top[0]}, and compare it with ${top.slice(1).join(' or ') || 'the other picks'} based on fit, material, and price.`;
  }
  return `I found a few Amazon fashion picks that match your brief. Start with ${top[0]}, then compare ${top.slice(1).join(' or ') || 'the remaining picks'} for colour, fabric, and occasion fit.`;
}

async function falAiStudioReply({ message, history, products, source, knowledge, context, mode }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.FAL_AI_STUDIO_TIMEOUT_MS || 20_000));
  try {
    const response = await fetch(`https://fal.run/${falAiStudioEndpoint()}`, {
      method: 'POST',
      headers: falHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model: falAiStudioModel(),
        prompt: aiStudioPrompt({ message, history, products, source, knowledge, context, mode }),
        max_tokens: 420,
        temperature: 0.35
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(readableError(data.error || data.detail || data.message || data, 'AI Studio request failed')), { statusCode: response.status || 503 });
    const text = flattenText(data).trim();
    if (!text) throw Object.assign(new Error('AI Studio did not return a response'), { statusCode: 503 });
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function closetItemToClient(item = {}) {
  return {
    id: String(item._id || item.id || ''),
    name: item.name || '',
    category: item.category || 'other',
    color: item.color || '',
    fabric: item.fabric || '',
    pattern: item.pattern || '',
    season: item.season || 'all-season',
    formality: item.formality || 'any',
    occasions: item.occasions || [],
    tags: item.tags || [],
    favorite: Boolean(item.favorite),
    wearCount: Number(item.wearCount || 0),
    lastWornAt: item.lastWornAt || null,
    imageUrl: item.image?.url || item.imageUrl || null,
    source: 'wardrobe',
    sourceLabel: 'Wardrobe item',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function userPublicContext(user) {
  const client = typeof user?.toClient === 'function'
    ? user.toClient()
    : {
        id: String(user?._id || ''),
        name: user?.name || '',
        genderPreference: user?.genderPreference || 'other',
        tokens: Number(user?.tokens || 0),
        subscription: user?.subscription || {},
        devMode: Boolean(user?.devMode),
        bodyPhotoStatus: user?.bodyPhoto?.status || 'uploaded',
        bodyPhotoUrl: user?.bodyPhoto?.url || '',
        avatarPhotoUrl: user?.avatarPhoto?.url || '',
        joinedAt: user?.createdAt || null
      };
  return {
    id: client.id,
    name: client.name,
    genderPreference: client.genderPreference || 'other',
    tokens: Number(client.tokens || 0),
    subscription: client.subscription || {},
    devMode: Boolean(client.devMode),
    bodyPhotoStatus: client.bodyPhotoStatus || user?.bodyPhoto?.status || 'uploaded',
    bodyPhotoUrl: client.bodyPhotoUrl || '',
    avatarPhotoUrl: client.avatarPhotoUrl || '',
    joinedAt: client.joinedAt || null
  };
}

function compactEvent(event = {}) {
  return {
    type: event.type || '',
    query: event.query || '',
    product: event.product ? {
      id: String(event.product._id || event.product.id || ''),
      name: event.product.name || '',
      brand: event.product.brand || '',
      category: event.product.category || ''
    } : null,
    metadata: event.metadata || {},
    createdAt: event.createdAt
  };
}

function savedOutfitToClient(outfit = {}, itemsById = new Map()) {
  const itemIds = (outfit.itemIds || []).map((id) => String(id));
  return {
    id: String(outfit._id || outfit.id || ''),
    title: outfit.title || 'Saved outfit',
    occasion: outfit.occasion || '',
    mood: outfit.mood || '',
    notes: outfit.notes || '',
    favorite: Boolean(outfit.favorite),
    plannedFor: outfit.plannedFor || null,
    itemIds,
    items: itemIds.map((id) => itemsById.get(id)).filter(Boolean),
    source: 'wardrobe',
    sourceLabel: 'Wardrobe item',
    createdAt: outfit.createdAt
  };
}

async function loadAiStudioUserContext(userId) {
  const [user, wardrobeItems, savedOutfits, recentActivity, preference] = await Promise.all([
    User.findById(userId),
    ClosetItem.find({ user: userId }).sort({ favorite: -1, updatedAt: -1 }).limit(100).lean(),
    ClosetOutfit.find({ user: userId }).sort({ favorite: -1, createdAt: -1 }).limit(20).lean(),
    UserEvent.find({ user: userId }).sort({ createdAt: -1 }).limit(24).populate('product', 'name brand category price gender tags').lean(),
    UserPreference.findOne({ user: userId }).lean()
  ]);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 401;
    throw error;
  }
  const wardrobe = wardrobeItems.map(closetItemToClient);
  const itemsById = new Map(wardrobe.map((item) => [String(item.id), item]));
  return {
    user,
    profile: userPublicContext(user),
    wardrobe,
    savedOutfits: savedOutfits.map((outfit) => savedOutfitToClient(outfit, itemsById)),
    recentActivity: recentActivity.map(compactEvent),
    preference,
    stats: {
      wardrobeCount: wardrobe.length,
      savedOutfitCount: savedOutfits.length,
      favoriteWardrobeCount: wardrobe.filter((item) => item.favorite).length,
      recentActivityCount: recentActivity.length
    }
  };
}

function decorateAiStudioResponse(response = {}, { intent = '', mode = '', message = '', userContext = {}, knowledge = [] } = {}) {
  const user = userContext.profile || {};
  const products = decorateProducts(response.products || [], response.source || response.productSource || '', user);
  const outfits = (response.outfits || []).map((outfit) => ({
    ...outfit,
    source: outfit.source || 'wardrobe',
    sourceLabel: outfit.sourceLabel || 'Wardrobe item',
    items: (outfit.items || []).map((item) => ({ ...item, source: 'wardrobe', sourceLabel: 'Wardrobe item' }))
  })).map((outfit) => ({
    ...outfit,
    actions: outfit.actions?.length ? outfit.actions : outfitActionPayload(outfit, user, message)
  }));
  const suggestions = response.suggestions || fashionFollowUps(message);
  const resolvedIntent = response.intent || intent || (products.length ? 'product_search_confirmed' : outfits.length ? 'wardrobe_outfit_check' : 'style_advice');
  const resolvedMode = response.mode || mode || (products.length ? 'product_search' : outfits.length ? 'wardrobe_first' : 'chat_control');
  const actions = response.actions?.length
    ? response.actions
    : primaryActions({ mode: resolvedMode, message, products, outfits, user, suggestions });
  return {
    brain: 'master_ai',
    intent: resolvedIntent,
    mode: resolvedMode,
    reply: response.reply || '',
    products,
    outfits,
    suggestions,
    actions,
    rag: knowledge.map(({ id, title, matchedTerms, score }) => ({ id, title, matchedTerms, score })),
    context: {
      profile: {
        name: user.name || '',
        genderPreference: user.genderPreference || 'other',
        tokens: Number(user.tokens || 0),
        bodyPhotoStatus: user.bodyPhotoStatus || 'uploaded',
        hasBodyPhoto: Boolean(user.bodyPhotoUrl || userContext.user?.bodyPhoto?.path || userContext.user?.bodyPhoto?.url)
      },
      wardrobeCount: userContext.stats?.wardrobeCount || 0,
      savedOutfitCount: userContext.stats?.savedOutfitCount || 0,
      recentActivityCount: userContext.stats?.recentActivityCount || 0
    },
    debug: process.env.AI_STUDIO_DEBUG === '1' ? {
      knowledge: knowledge.map(({ file, title, matchedTerms, score }) => ({ file, title, matchedTerms, score })),
      productSource: response.source || response.productSource || '',
      stats: userContext.stats || {}
    } : undefined
  };
}

function compactAiStudioBody(body = {}, message = '', history = []) {
  const copyArray = (value, limit) => (Array.isArray(value) ? value.slice(0, limit) : undefined);
  const lastVisible = body?.lastVisible && typeof body.lastVisible === 'object'
    ? {
        products: copyArray(body.lastVisible.products, 12) || [],
        outfits: copyArray(body.lastVisible.outfits, 6) || [],
        wardrobeItems: copyArray(body.lastVisible.wardrobeItems, 12) || []
      }
    : undefined;
  return {
    message,
    history,
    ...(lastVisible ? { lastVisible } : {}),
    ...(copyArray(body?.visibleProducts, 12) ? { visibleProducts: copyArray(body.visibleProducts, 12) } : {}),
    ...(copyArray(body?.visibleOutfits, 6) ? { visibleOutfits: copyArray(body.visibleOutfits, 6) } : {}),
    ...(copyArray(body?.visibleWardrobeItems, 12) ? { visibleWardrobeItems: copyArray(body.visibleWardrobeItems, 12) } : {}),
    ...(copyArray(body?.products, 12) ? { products: copyArray(body.products, 12) } : {}),
    ...(copyArray(body?.outfits, 6) ? { outfits: copyArray(body.outfits, 6) } : {})
  };
}

async function aiStudioChatService({ userId, body = {} }) {
  const userContext = await loadAiStudioUserContext(userId);
  const user = userContext.user;
  const message = String(body?.message || '').trim().slice(0, 600);
  if (!message) {
    const error = new Error('Message AI Studio first');
    error.statusCode = 400;
    throw error;
  }
  const history = Array.isArray(body?.history) ? body.history.slice(-10) : [];
  const knowledge = await retrieveAiStudioKnowledge(message);
  const finish = (response = {}, meta = {}) => decorateAiStudioResponse(response, {
    intent: meta.intent,
    mode: meta.mode,
    message: meta.message || message,
    userContext,
    knowledge: meta.knowledge || knowledge
  });

  await UserEvent.create({
    user: user._id,
    type: 'style_bot_query',
    query: message,
    weight: eventWeight('style_bot_query'),
    metadata: { source: 'ai_studio_master_ai' }
  });
  await updatePreference({ userId: user._id, type: 'style_bot_query', query: message, metadata: { source: 'ai_studio_master_ai' } });

  const sourceMemoryReply = visibleSourceReply(message, history, body);
  if (sourceMemoryReply) {
    return finish({
      reply: sourceMemoryReply,
      products: [],
      outfits: [],
      suggestions: ['Check wardrobe', 'Search products'],
      actions: [
        action('check_wardrobe', 'Check wardrobe', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: 'Check wardrobe for a similar look'
        }),
        action('search_products', 'Search products', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: 'Search online for similar products'
        })
      ],
      intent: 'visible_source_question',
      mode: 'context_answer'
    });
  }

  const natural = naturalAiStudioReply(message);
  if (natural) return finish(natural);

  const help = lookmefyHelpReply(message, userContext);
  if (help) return finish(help);

  if (shouldBlockOutOfScopeQuestion(message)) {
    return finish({
      reply: outOfScopeReply(),
      products: [],
      outfits: [],
      suggestions: ['Beach outfit', 'Kurta for wedding', 'Black shirt under INR 1000'],
      intent: 'out_of_scope',
      mode: 'chat_control',
      actions: []
    });
  }

  const celebrityStyle = detectCelebrityStyleRequest(message);
  const explicitShopping = /\b(search|find|shop|buy|amazon|online|price|under|below)\b/i.test(message) || budgetCeiling(message);
  if (celebrityStyle && !explicitShopping) {
    return finish({
      reply: `I can build a ${celebrityStyle.name}-inspired look, but I will keep it as a general style direction instead of pretending I know the exact outfit. Pick a vibe and I will make it specific.`,
      products: [],
      outfits: [],
      suggestions: ['Airport casual', 'Party glam', 'Ethnic festive', 'Shop similar'],
      actions: [
        action('style_option', 'Airport casual', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: `${celebrityStyle.name} inspired airport casual outfit`
        }),
        action('style_option', 'Party glam', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: `${celebrityStyle.name} inspired party glam outfit`
        }),
        action('style_option', 'Ethnic festive', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: `${celebrityStyle.name} inspired ethnic festive outfit`
        }),
        action('search_products', 'Shop similar', {
          endpoint: '/api/recommendations/studio-chat',
          method: 'POST',
          message: `Search online for ${celebrityStyle.name} inspired outfit`
        })
      ],
      intent: 'outfit_source_choice',
      mode: 'source_choice'
    });
  }

  const choiceAction = aiStudioChoiceAction(message);
  if (choiceAction) {
    const context = latestUserContext(history, message);
    if (!context) {
      return finish({
        reply: choiceAction === 'wardrobe'
          ? 'What occasion, place, or vibe should I check your wardrobe for?'
          : 'What should I search online for? Tell me the item, occasion, budget, colour, or vibe.',
        products: [],
        outfits: [],
        suggestions: ['Beach outfit', 'Kurta for wedding', 'Black shirt under INR 1000'],
        intent: choiceAction === 'wardrobe' ? 'wardrobe_outfit_check' : 'product_search',
        mode: choiceAction === 'wardrobe' ? 'wardrobe_check' : 'product_choice'
      });
    }
    if (choiceAction === 'wardrobe') {
      return finish(await wardrobeReplyForContext(userContext, context), { message: context });
    }
    const searchMessage = onlineSearchPromptForContext(context, user);
    try {
      const result = await findFashionProducts(searchMessage, user);
      const products = result.products || [];
      let reply = '';
      try {
        reply = await falAiStudioReply({ message: context, history, products, source: result.source, knowledge, context: userContext, mode: 'product_search' });
      } catch (error) {
        console.warn('[ai-studio] FAL request failed', readableError(error));
        reply = localFashionReply(context, products, result.source);
      }
      return finish({
        reply,
        products: products.slice(0, 6),
        source: result.source,
        suggestions: fashionFollowUps(searchMessage),
        intent: 'product_search_confirmed',
        mode: 'product_search'
      }, { message: searchMessage });
    } catch (error) {
      const detail = readableError(error, 'Could not search Amazon for fashion right now. Try another item type, colour, budget, or occasion.');
      const reply = error.publicMessage || aiStudioSearchFailureReply(detail);
      console.warn('[ai-studio] Amazon fashion search failed', detail);
      return finish({
        reply,
        products: [],
        outfits: [],
        suggestions: fashionFollowUps(searchMessage),
        intent: 'product_search_confirmed',
        mode: 'product_search'
      }, { message: searchMessage });
    }
  }

  const blocked = fashionSearchBlock(message);
  if (blocked) {
    return finish({
      reply: blocked,
      products: [],
      outfits: [],
      suggestions: fashionFollowUps(''),
      intent: 'out_of_scope',
      mode: 'chat_control'
    });
  }

  const unclear = unclearFashionReply(message);
  if (unclear) {
    return finish({
      reply: unclear,
      products: [],
      outfits: [],
      suggestions: ['Beach outfit', 'Kurta for wedding', 'Black shirt under INR 1000'],
      intent: 'style_advice',
      mode: 'chat_control'
    });
  }

  if (shouldAskSourceChoice(message)) {
    return finish(sourceChoiceReply(message), { intent: 'outfit_source_choice', mode: 'source_choice' });
  }

  try {
    const result = await findFashionProducts(message, user);
    const products = result.products || [];
    let reply = '';
    try {
      reply = await falAiStudioReply({ message, history, products, source: result.source, knowledge, context: userContext, mode: 'product_search' });
    } catch (error) {
      console.warn('[ai-studio] FAL request failed', readableError(error));
      reply = localFashionReply(message, products, result.source);
    }
    return finish({
      reply,
      products: products.slice(0, 6),
      source: result.source,
      suggestions: fashionFollowUps(message),
      intent: 'product_search_confirmed',
      mode: 'product_search'
    });
  } catch (error) {
    const detail = readableError(error, 'Could not search Amazon for fashion right now. Try another item type, colour, budget, or occasion.');
    const reply = error.publicMessage || aiStudioSearchFailureReply(detail);
    console.warn('[ai-studio] Amazon fashion search failed', detail);
    return finish({
      reply,
      products: [],
      outfits: [],
      suggestions: fashionFollowUps(message),
      intent: 'product_search_confirmed',
      mode: 'product_search'
    });
  }
}

async function aiStudioChat(req, res) {
  const message = String(req.body?.message || '').trim().slice(0, 600);
  if (!message) return res.status(400).json({ message: 'Message AI Studio first' });
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  const queuedBody = compactAiStudioBody(req.body, message, history);
  const visibleSourceKey = visibleSourceQuestion(message)
    ? JSON.stringify({
        lastVisibleProducts: queuedBody.lastVisible?.products?.map((product) => product.id || product._id || product.sourceUrl || product.name).slice(0, 8) || [],
        lastVisibleOutfits: queuedBody.lastVisible?.outfits?.map((outfit) => outfit.id || outfit.title).slice(0, 4) || [],
        lastVisibleWardrobeItems: queuedBody.lastVisible?.wardrobeItems?.map((item) => item.id || item._id || item.name).slice(0, 8) || [],
        visibleProducts: queuedBody.visibleProducts?.map((product) => product.id || product._id || product.sourceUrl || product.name).slice(0, 8) || [],
        visibleOutfits: queuedBody.visibleOutfits?.map((outfit) => outfit.id || outfit.title).slice(0, 4) || [],
        visibleWardrobeItems: queuedBody.visibleWardrobeItems?.map((item) => item.id || item._id || item.name).slice(0, 8) || []
      })
    : '';
  const historyKey = aiStudioChoiceAction(message)
    ? history
        .map((entry) => `${entry?.role || ''}:${String(entry?.text || '').slice(0, 120)}`)
        .join('|')
        .toLowerCase()
    : '';

  try {
    return await inlineOrQueue({
      req,
      res,
      type: 'ai-studio-search',
      key: `${req.user._id}:fashion:${message.toLowerCase()}:${historyKey}:${visibleSourceKey}`,
      payload: {
        body: queuedBody
      },
      maxAttempts: 1,
      runInline: async () => ({
        statusCode: 200,
        body: await aiStudioChatService({ userId: req.user._id, body: queuedBody })
      })
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: readableError(error, 'AI Studio request failed') });
  }
}

function registerRecommendationJobHandlers() {
  registerJobHandler('ai-studio-search', async ({ payload, job }) => (
    aiStudioChatService({ userId: job.user, body: payload.body })
  ));
}

router.post('/studio-chat', requireUser, aiStudioChat);
router.post('/stylist-chat', requireUser, aiStudioChat);

router.get('/admin/stats', requireAdmin, async (_req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [totalEvents, activeUsers, eventCounts, topProducts, preferences, recentEvents] = await Promise.all([
    UserEvent.countDocuments(),
    UserEvent.distinct('user', { createdAt: { $gte: since } }),
    UserEvent.aggregate([
      { $group: { _id: '$type', count: { $sum: 1 }, weight: { $sum: '$weight' } } },
      { $sort: { count: -1 } }
    ]),
    UserEvent.aggregate([
      { $match: { product: { $exists: true, $ne: null } } },
      { $group: { _id: '$product', count: { $sum: 1 }, weight: { $sum: '$weight' } } },
      { $sort: { weight: -1, count: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $project: { count: 1, weight: 1, name: '$product.name', brand: '$product.brand', category: '$product.category' } }
    ]),
    UserPreference.find({}).limit(500).lean(),
    UserEvent.find({}).sort({ createdAt: -1 }).limit(12).populate('product', 'name brand category').lean()
  ]);

  const rollup = (bucket) => {
    const totals = new Map();
    preferences.forEach((preference) => {
      const entries = preference[bucket] instanceof Map ? preference[bucket].entries() : Object.entries(preference[bucket] || {});
      for (const [key, value] of entries) totals.set(key, (totals.get(key) || 0) + Number(value || 0));
    });
    return [...totals.entries()]
      .map(([key, weight]) => ({ key, label: key.replace(/_/g, ' '), weight: Math.round(weight * 10) / 10 }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);
  };

  const priceTotal = preferences.reduce((sum, preference) => sum + Number(preference.priceTotal || 0), 0);
  const priceCount = preferences.reduce((sum, preference) => sum + Number(preference.priceCount || 0), 0);

  res.json({
    totals: {
      events: totalEvents,
      activeUsers30d: activeUsers.length,
      preferenceProfiles: preferences.length,
      averagePreferredPrice: priceCount ? Math.round(priceTotal / priceCount) : 0
    },
    eventCounts: eventCounts.map((item) => ({ type: item._id, count: item.count, weight: Math.round(item.weight * 10) / 10 })),
    topProducts: topProducts.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      brand: item.brand,
      category: item.category,
      count: item.count,
      weight: Math.round(item.weight * 10) / 10
    })),
    topCategories: rollup('categories'),
    topBrands: rollup('brands'),
    topTags: rollup('tags'),
    topGenders: rollup('genders'),
    recentEvents: recentEvents.map((event) => ({
      id: event._id.toString(),
      type: event.type,
      query: event.query,
      weight: event.weight,
      product: event.product ? {
        name: event.product.name,
        brand: event.product.brand,
        category: event.product.category
      } : null,
      createdAt: event.createdAt
    }))
  });
});

router.get('/for-you', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 8, 24);
  const preference = await UserPreference.findOne({ user: req.user._id }).lean();
  const products = await productPoolCache.remember(
    'for-you-catalog',
    () => Product.find(catalogFilter()).sort({ isFeatured: -1, createdAt: -1 }).limit(180).lean()
  );
  const ranked = products
    .map((product) => ({ product, score: scoreProduct(product, preference) }))
    .sort((a, b) => b.score - a.score || Number(b.product.rating || 0) - Number(a.product.rating || 0))
    .slice(0, limit)
    .map(({ product, score }) => ({ ...productToClient(product), recommendationScore: Math.round(score * 100) / 100 }));

  res.json({ products: ranked, personalized: Boolean(preference) });
});

router.get('/similar/:productId', async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.productId)) return res.status(404).json({ message: 'Product not found' });
  const limit = Math.min(Number(req.query.limit) || 4, 12);
  const cacheKey = `${req.params.productId}:${limit}`;
  const cached = await similarProductsCache.get(cacheKey);
  if (cached) return res.json(cached);

  const base = await Product.findOne({ _id: req.params.productId, isActive: true }).lean();
  if (!base) return res.status(404).json({ message: 'Product not found' });
  const products = await Product.find(catalogFilter({ _id: { $ne: base._id } })).limit(160).lean();
  const ranked = products
    .map((product) => ({ product, score: similarScore(base, product) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ product, score }) => ({ ...productToClient(product), recommendationScore: Math.round(score * 100) / 100 }));
  const payload = { products: ranked };
  await similarProductsCache.set(cacheKey, payload);
  res.json(payload);
});

export default router;
export { clearRecommendationCaches };
export { registerRecommendationJobHandlers };
