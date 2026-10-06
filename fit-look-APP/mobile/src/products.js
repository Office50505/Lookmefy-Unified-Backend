import { API_ORIGIN, imageUrl } from './api';

const MEASUREMENT_LABEL_PATTERN = /\b(?:chest|waist|shoulder|length|bust|hip|inseam|sleeve|heel|toe|cuff|hem|thigh|circumference|size)\s*\(?(?:in|cm)?\)?\b/i;
const MINOR_UNIT_THRESHOLD = 100000;
const NEW_ARRIVAL_DAYS = 30;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function titleCaseWord(value) {
  return cleanText(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function isMeasurementLabel(value) {
  const text = cleanText(value);
  if (!text) return false;
  return MEASUREMENT_LABEL_PATTERN.test(text) && text.length > 14;
}

function firstString(...values) {
  for (const value of values.flat()) {
    if (typeof value === 'string' && cleanText(value)) return cleanText(value);
  }
  return '';
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePrice(value, currency) {
  const amount = asNumber(value);
  if (amount === null) return null;
  const normalizedCurrency = cleanText(currency).toUpperCase();
  if (amount >= MINOR_UNIT_THRESHOLD && ['INR', 'USD', 'EUR', 'GBP'].includes(normalizedCurrency)) {
    return amount / 100;
  }
  return amount;
}

function currencyFromUrl(value) {
  const url = cleanText(value);
  if (!url) return '';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'amzn.in' || host.endsWith('.amazon.in')) return 'INR';
    if (host.endsWith('.amazon.co.uk')) return 'GBP';
    if (host.endsWith('.amazon.ca')) return 'CAD';
    if (host.endsWith('.amazon.com.au')) return 'AUD';
    if (host.endsWith('.amazon.co.jp')) return 'JPY';
  } catch {
    // Keep source currency detection best-effort.
  }
  return '';
}

function normalizeCurrency(product = {}) {
  const declared = cleanText(product.currency || product.priceCurrency || product.currencyCode).toUpperCase();
  const inferred = [product.sourceUrl, product.affiliateLink, product.url, product.productUrl]
    .map(currencyFromUrl)
    .find(Boolean);
  if (inferred && (!declared || declared === 'USD')) return inferred;
  return declared || inferred || 'INR';
}

function resolveCandidateImage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return firstString(value.url, value.uri, value.imageUrl, value.remoteUrl, value.src, value.path);
  }
  return '';
}

export function resolveImageUrl(value) {
  const candidate = resolveCandidateImage(value);
  if (!candidate) return '';
  if (/^(?:https?:|data:image)/i.test(candidate)) return candidate;
  if (candidate.startsWith('/')) return imageUrl(candidate);
  if (/^(?:uploads|assets)\//i.test(candidate)) return `${API_ORIGIN}/${candidate}`;
  return imageUrl(candidate);
}

function normalizeImages(product = {}) {
  const images = [
    product.imageUrl,
    product.thumbnail,
    product.image,
    product.remoteImageUrl,
    product.imageUrls,
    product.images,
    product.media
  ].flatMap(toArray);
  return [...new Set(images.map(resolveImageUrl).filter(Boolean))];
}

function normalizeColors(product = {}) {
  const candidates = [
    product.colors,
    product.colours,
    product.color,
    product.primaryColor,
    toArray(product.variants).flatMap((variant) => [variant?.color, variant?.colour, variant?.name])
  ].flatMap(toArray);

  return [...new Set(candidates.map((color) => cleanText(color)).filter(Boolean))]
    .filter((color) => !isMeasurementLabel(color))
    .slice(0, 12)
    .map((color) => ({ name: color, value: color }));
}

function normalizeSizes(product = {}) {
  const candidates = [
    product.sizes,
    product.size,
    toArray(product.variants).flatMap((variant) => [variant?.size, variant?.label])
  ].flatMap(toArray);
  return [...new Set(candidates.map((size) => cleanText(size)).filter(Boolean))]
    .filter((size) => !isMeasurementLabel(size))
    .slice(0, 12);
}

export function getProductDisplayLabel(product = {}) {
  const brand = cleanText(product.brand);
  if (brand && !isMeasurementLabel(brand)) return brand;
  const badge = cleanText(product.badge);
  if (badge && !isMeasurementLabel(badge)) return badge;
  const category = cleanText(product.category);
  if (category) return titleCaseWord(category);
  const gender = cleanText(product.gender);
  if (gender) return titleCaseWord(gender);
  return '';
}

export function normalizeProduct(apiProduct = {}) {
  const raw = apiProduct || {};
  const id = firstString(raw.id, raw._id, raw.productId, raw.asin, raw.sourceUrl, raw.affiliateLink);
  const title = firstString(raw.name, raw.title, raw.productName, raw.label, raw.description) || 'Untitled product';
  const imageUrls = normalizeImages(raw);
  const sourceCurrency = normalizeCurrency(raw);
  const price = normalizePrice(raw.salePrice ?? raw.price ?? raw.currentPrice, sourceCurrency);
  const compareAtPrice = normalizePrice(raw.compareAtPrice ?? raw.listPrice ?? raw.originalPrice, sourceCurrency);
  const createdAt = raw.createdAt || raw.updatedAt || null;
  const createdAtTime = createdAt ? new Date(createdAt).getTime() : NaN;
  const calculatedNew = Number.isFinite(createdAtTime)
    ? Date.now() - createdAtTime <= NEW_ARRIVAL_DAYS * 24 * 60 * 60 * 1000
    : false;

  return {
    ...raw,
    id,
    title,
    name: title,
    brand: cleanText(raw.brand),
    displayLabel: getProductDisplayLabel(raw),
    category: cleanText(raw.category),
    imageUrl: imageUrls[0] || null,
    imageUrls,
    price,
    compareAtPrice,
    currency: sourceCurrency,
    colors: normalizeColors(raw),
    sizes: normalizeSizes(raw),
    isNew: Boolean(raw.isNew || raw.isNewArrival || calculatedNew),
    isAvailable: raw.isAvailable !== false && raw.inventory !== 0 && raw.isActive !== false,
    raw
  };
}

export function normalizeProducts(products = []) {
  return toArray(products).map(normalizeProduct).filter((product) => product.id);
}

export function calculateCreditPercentage(remaining, total) {
  const current = Math.max(0, Number(remaining) || 0);
  const max = Number(total);
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, (current / max) * 100));
}
