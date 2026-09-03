import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OptimizedImage from './components/common/OptimizedImage.jsx';
import ShaderBackground from './components/common/ShaderBackground.jsx';
import { cartItemCount, cartSubtotal, readCartItems, removeCartItem, saveCartItems, updateCartQuantity } from './utils/cart.js';
import { trackClientEvent } from './utils/analytics.js';
import { DEFAULT_MODEL_PLACEMENT, calculateModelPlacement, normalizedPlacement } from './utils/modelPlacement.js';
import { updateProductSeo, updateRouteSeo } from './utils/seo.js';
import {
  SUBSCRIPTION_PLAN,
  TOP_UP_PLANS,
  creditRateLabel,
  firstRecurringPaymentDate,
  formatMinorAmount
} from '../shared/pricing.js';

const asset = (name) => `/assets/${name}`;
const MAX_BODY_PHOTO_BYTES = 8 * 1024 * 1024;
const TARGET_BODY_PHOTO_BYTES = 6.5 * 1024 * 1024;
const BODY_PHOTO_ACCEPT = 'image/*,.avif,.heic,.heif,image/avif,image/heic,image/heif';
const API_TIMEOUT_MS = 25000;
const AI_IMAGE_TIMEOUT_MS = 180000;
const AI_VIDEO_TIMEOUT_MS = 300000;
const PRODUCT_CACHE_TTL_MS = 30_000;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const AUTH_TOKEN_KEY = 'fitlook_token';
const MEDIA_TOKEN_KEY = 'fitlook_media_token';
const ENABLE_TEST_OTP_HELPER = import.meta.env.DEV && import.meta.env.VITE_ENABLE_TEST_OTP_HELPER !== 'false';
const APP_STORE_URL = safeExternalStoreUrl(import.meta.env.VITE_APP_STORE_URL);
const PLAY_STORE_URL = safeExternalStoreUrl(import.meta.env.VITE_PLAY_STORE_URL);
const productListCache = new Map();
const productDetailLocalCache = new Map();
const EMPTY_PRODUCT_FACETS = { brands: [], categories: [], categoryCounts: [] };
const INDIA_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal'
];

function safeExternalStoreUrl(value = '') {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function emptyProductListState(error = '') {
  return { products: [], total: 0, facets: EMPTY_PRODUCT_FACETS, loading: false, error };
}

function normalizeProductListResponse(data) {
  if (!data || typeof data !== 'object') return emptyProductListState('Product catalog response was empty. Please try again.');
  const products = Array.isArray(data.products) ? data.products : [];
  const facets = data.facets && typeof data.facets === 'object'
    ? {
        brands: Array.isArray(data.facets.brands) ? data.facets.brands : [],
        categories: Array.isArray(data.facets.categories) ? data.facets.categories : [],
        categoryCounts: Array.isArray(data.facets.categoryCounts) ? data.facets.categoryCounts : []
      }
    : EMPTY_PRODUCT_FACETS;
  const total = Number.isFinite(Number(data.total)) ? Number(data.total) : products.length;
  return { products, total, facets, loading: false, error: '' };
}

function formatFileSize(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function isHeicFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' || name.endsWith('.heic') || name.endsWith('.heif');
}

function isAvifFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return type === 'image/avif' || type === 'image/x-avif' || name.endsWith('.avif');
}

function imageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Please upload a JPG, PNG, WebP, AVIF, HEIC, or HEIF profile photo.'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not prepare the profile photo. Try a different image.'));
    }, 'image/jpeg', quality);
  });
}

async function prepareBodyPhoto(file) {
  if (!file) return file;
  if (isHeicFile(file) || isAvifFile(file)) {
    if (file.size > MAX_BODY_PHOTO_BYTES) throw new Error(`AVIF/HEIC/HEIF profile photo is ${formatFileSize(file.size)}. Please choose one under 8 MB.`);
    return file;
  }

  const image = await imageFromFile(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  for (const quality of [0.86, 0.76, 0.66, 0.56]) {
    const blob = await canvasToBlob(canvas, quality);
    if (blob.size <= TARGET_BODY_PHOTO_BYTES || quality === 0.56) {
      if (blob.size > MAX_BODY_PHOTO_BYTES) throw new Error(`Profile photo is still ${formatFileSize(blob.size)} after optimization. Please upload a smaller image.`);
      const name = `${file.name.replace(/\.[^.]+$/, '') || 'profile-photo'}.jpg`;
      return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
    }
  }

  return file;
}

async function prepareClosetItemPhoto(file) {
  if (!file) return file;
  try {
    const image = await imageFromFile(file);
    const maxSide = 1800;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, 0.88);
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'closet-item'}.jpg`;
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (error) {
    if (isHeicFile(file) || isAvifFile(file)) {
      return file;
    }
    throw error;
  }
}

function formatMoney(value, currency = 'INR') {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Price unavailable';
  const requestedCurrency = String(currency || 'INR').toUpperCase();
  const normalizedCurrency = requestedCurrency === 'USD' ? 'INR' : requestedCurrency;
  const locale = normalizedCurrency === 'INR' ? 'en-IN' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: normalizedCurrency }).format(amount);
  } catch {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);
  }
}

function formatDate(value) {
  if (!value) return 'Recently';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return new Intl.DateTimeFormat('en-IN', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function dateInputValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function nextPlannerDays(count = 7) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);
    date.setHours(0, 0, 0, 0);
    return {
      value: dateInputValue(date),
      label: index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : new Intl.DateTimeFormat('en-IN', { weekday: 'short', month: 'short', day: 'numeric' }).format(date)
    };
  });
}

const AI_PREVIEW_DISCLAIMER = 'AI previews can make mistakes. Check fit, colour, and product details before buying.';
const DEFAULT_WARDROBE_MODEL_SRC = '/assets/wardrobe-default-model.png';

function AiPreviewDisclaimer({ className = '' }) {
  return <p className={`ai-preview-disclaimer ${className}`.trim()}>{AI_PREVIEW_DISCLAIMER}</p>;
}

function ZoomableImage({ src, alt, className = '', imageClassName = '', zoom = 1.65, disableZoom = false, onError, onOpen }) {
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const frameRef = useRef(null);
  const touchZoomRef = useRef(null);
  const wheelZoomTimeoutRef = useRef(null);
  const canOpen = typeof onOpen === 'function';

  const moveOrigin = (event) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    setOrigin({ x, y });
  };

  const stopZoom = (event) => {
    if (disableZoom || zoom <= 1) return;
    setZooming(false);
    if (event.pointerType !== 'mouse') {
      touchZoomRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const handlePointerDown = (event) => {
    if (disableZoom || zoom <= 1 || event.pointerType === 'mouse') return;
    touchZoomRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (event) => {
    if (disableZoom || zoom <= 1) return;
    if (event.pointerType === 'mouse') {
      if (zooming) moveOrigin(event);
      return;
    }
    const touchZoom = touchZoomRef.current;
    if (!touchZoom || touchZoom.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - touchZoom.x, event.clientY - touchZoom.y);
    if (!touchZoom.active && distance > 8) {
      touchZoom.active = true;
      setZooming(true);
    }
    if (touchZoom.active) moveOrigin(event);
  };

  const handleWheel = (event) => {
    if (disableZoom || zoom <= 1 || Math.abs(event.deltaY) < 2) return;
    event.preventDefault();
    moveOrigin(event);
    setZooming(true);
    window.clearTimeout(wheelZoomTimeoutRef.current);
    wheelZoomTimeoutRef.current = window.setTimeout(() => setZooming(false), 900);
  };

  useEffect(() => () => window.clearTimeout(wheelZoomTimeoutRef.current), []);

  const openImage = () => {
    if (canOpen) onOpen();
  };

  const handleKeyDown = (event) => {
    if (!canOpen || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <div
      ref={frameRef}
      className={`zoomable-image ${zooming ? 'is-zoomed' : ''} ${disableZoom || zoom <= 1 ? 'no-zoom' : ''} ${canOpen ? 'generated-image-open' : ''} ${className}`.trim()}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      aria-label={canOpen ? `Open ${alt || 'generated image'} full screen` : undefined}
      style={{
        '--zoom-origin-x': `${origin.x}%`,
        '--zoom-origin-y': `${origin.y}%`,
        '--zoom-scale': zoom
      }}
      onClick={canOpen ? openImage : undefined}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopZoom}
      onPointerCancel={stopZoom}
      onPointerLeave={stopZoom}
    >
      <OptimizedImage className={imageClassName} src={src} alt={alt} draggable="false" onError={onError} />
    </div>
  );
}

/**
 * @typedef {{
 *   prefix: string;
 *   image: string;
 *   kicker: string;
 *   title: import('react').ReactNode;
 *   lead: string;
 *   aside?: import('react').ReactNode;
 *   ariaLabel?: string;
 * }} BackdropHeroProps
 */

/**
 * @param {BackdropHeroProps} props
 */
function BackdropHero({ prefix, image, kicker, title, lead, aside, ariaLabel }) {
  return (
    <section className={prefix} aria-label={ariaLabel}>
      <OptimizedImage className={`${prefix}-bg`} src={asset(image)} alt="" eager />
      <div className={`${prefix}-scrim`} aria-hidden="true" />
      <div className={`wrap ${prefix}-inner`}>
        <div>
          <p className="kicker">{kicker}</p>
          <h1>{title}</h1>
          <p className="lead">{lead}</p>
        </div>
        {aside}
      </div>
    </section>
  );
}

const styleBotWearablePatterns = [
  /\b(cloth(?:e|es|ing)?|apparel|garments?|outfits?|fashion|wearable|style|look)\b/i,
  /\b(sarees?|saris?|lehenga(?:s)?|dupatta(?:s)?|kurta(?:s)?|kurtis?|salwar(?:s)?|churidar(?:s)?|anarkali|palazzo(?:s)?|sharara(?:s)?)\b/i,
  /\b(sun\s*glasses|sunglasses|eye\s*glasses|eyeglasses|spectacles?|optical\s*frames?|goggles?|aviator|wayfarer)\b/i,
  /\b(underwear|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear|bikinis?|swimsuits?|swimwear|monokinis?)\b/i,
  /\b(night(?:y|ie|wear|gown|suit|dress)|sleepwear|pajamas?|pyjamas?|loungewear|robe)\b/i,
  /\b(dress(?:es)?|gowns?|suits?|skirts?|skorts?|jeans?|pants?|trousers?|joggers?|leggings?|chinos?|shorts?|bermudas?)\b/i,
  /\b(hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?|jackets?|overshirts?|blazers?|coats?|windcheaters?|parkas?|shrugs?)\b/i,
  /\b(t\s*-?\s*shirts?|tshirts?|tees?|polo\s*(?:shirts?)?|shirts?|button\s*(?:down|up)|tops?|blouses?|tunics?|crop\s*tops?|tank\s*tops?)\b/i,
  /\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?)\b/i,
  /\b(watch(?:es)?|smart\s*watch(?:es)?|smartwatch(?:es)?|chronograph)\b/i,
  /\b(wallets?|purses?|backpacks?|handbags?|totes?|sling\s*bags?|crossbody|duffels?|clutches?)\b/i,
  /\b(belts?|baseball\s*caps?|hats?|scarves?|ties?|jewellery|jewelry|necklaces?|bracelets?|earrings?|accessor(?:y|ies))\b/i
];

const styleBotBlockedPatterns = [
  ['an oral care product', /\b(tooth\s*paste|toothpaste|toote\s*paste|tooth\s*brush|toothbrush|mouth\s*wash|mouthwash|dental|oral\s+care|colgate|sensodyne|pepsodent)\b/i],
  ['a beauty or hygiene product', /\b(shampoo|conditioner|soap|body\s*wash|face\s*wash|cleanser|lotion|cream|moisturi[sz]er|deodorant|perfume|makeup|cosmetics?|serum|sunscreen)\b/i],
  ['a food or grocery product', /\b(food|grocery|snacks?|chocolate|candy|tea|coffee|rice|flour|oil|spices?|sauce|drink|beverage|juice|protein\s*powder)\b/i],
  ['an electronics product', /\b(phone|mobile|laptop|tablet|camera|charger|cable|adapter|headphones?|earbuds?|speaker|keyboard|mouse|monitor|television|tv)\b/i],
  ['a home product', /\b(furniture|chair|table|mattress|bedsheet|curtain|lamp|bottle|mug|plate|cookware|utensils?|detergent|cleaner|toilet|kitchen|bathroom)\b/i],
  ['a book or stationery product', /\b(books?|notebooks?|pens?|pencils?|markers?|stationery|diary|paper)\b/i],
  ['medicine or a supplement', /\b(medicine|tablet|capsules?|syrup|vitamins?|supplements?|pain\s*relief|antiseptic)\b/i]
];

function styleBotCompatibility(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const blocked = styleBotBlockedPatterns.find(([, pattern]) => pattern.test(text));
  if (blocked) {
    return {
      compatible: false,
      reason: `This is not a compatible product type for AI try-on. Style Bot only supports wearable fashion items, and this looks like ${blocked[0]}.`
    };
  }
  if (styleBotWearablePatterns.some((pattern) => pattern.test(text))) return { compatible: true };
  return {
    compatible: false,
    reason: 'This is not a compatible product type for AI try-on. Try clothes, shoes, watches, bags, eyewear, or accessories.'
  };
}

function styleBotProductCompatibility(product = {}, query = '') {
  const productText = [
    product.name,
    product.brand,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ');
  const braIntent = /\b(bras?|bralettes?|sports?\s+bras?)\b/i.test(query);
  const swimIntent = /\b(bikinis?|swimsuits?|swimwear|monokinis?|one\s*piece\s+swimsuits?)\b/i.test(query);

  if (braIntent && !/\b(bras?|bralettes?|sports?\s+bras?|lingerie)\b/i.test(productText)) return { compatible: false };
  if (swimIntent && !/\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|one\s*piece)\b/i.test(productText)) return { compatible: false };
  return styleBotCompatibility([query, productText].filter(Boolean).join(' '));
}

function productGenderForPreference(value = '') {
  if (value === 'male') return 'men';
  if (value === 'female') return 'women';
  return '';
}

function genderPreferenceForStyleQuery(query = '', preference = '') {
  if (/\b(bras?|bralettes?|sports?\s+bras?|lingerie|pant(?:y|ies)|bikinis?|swimsuits?|swimwear|one\s*piece\s+swimsuits?|monokinis?)\b/i.test(query)) return 'female';
  return preference;
}

function genderedStyleBotQuery(query = '', preference = '') {
  const target = productGenderForPreference(genderPreferenceForStyleQuery(query, preference));
  if (!target) return query;
  const withoutGender = String(query || '')
    .replace(/\b(male|female|men'?s?|women'?s?|mans?|womans?|boys?|girls?|ladies|gentlemen)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${target} ${withoutGender}`.trim();
}

function genderPreferenceLabel(value = '') {
  if (value === 'male') return 'Male';
  if (value === 'female') return 'Female';
  return 'Other';
}

function styleBotGenderCompatibility(product = {}, preference = '') {
  const target = productGenderForPreference(preference);
  if (!target) return { compatible: true };
  const text = [
    product.name,
    product.brand,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ');
  const productGender = String(product.gender || '').toLowerCase();
  const isMens = /\b(men'?s?|male|boys?|gentlemen)\b/i.test(text);
  const isWomens = /\b(women'?s?|female|girls?|ladies)\b/i.test(text);

  if (target === 'women' && (productGender === 'men' || isMens)) return { compatible: false };
  if (target === 'men' && (productGender === 'women' || isWomens)) return { compatible: false };
  return { compatible: true };
}

const categories = [
  ['Shirts', 'category-1.jpg', 'shirts'],
  ['T-Shirts', 'category-2.jpg', 't-shirts'],
  ['Dresses', 'arrival-4.jpg', 'dresses'],
  ['Pants', 'category-3.jpg', 'pants'],
  ['Jeans', 'category-4.jpg', 'jeans'],
  ['Jackets', 'category-5.jpg', 'jackets'],
  ['Shoes', 'category-6.jpg', 'shoes'],
  ['Watches', 'category-7.jpg', 'watches'],
  ['Accessories', 'category-8.jpg', 'accessories'],
  ['Ethnic Wear', 'arrival-4.jpg', 'ethnic wear'],
  ['Eyewear', 'search-shirt-4.jpg', 'eyewear'],
  ['Innerwear', 'arrival-6.jpg', 'innerwear'],
  ['Sleepwear', 'arrival-5.jpg', 'sleepwear']
];
const featuredSearchCategories = categories.slice(0, 8);
const popularSearchTerms = ['shirts', 'jeans', 'innerwear', 'ethnic wear', 'shoes', 'sleepwear'];
const suggestedSearchTerms = ['shirts', 't-shirts', 'dresses', 'jeans', 'shoes', 'accessories'];

function categorySlug(value) {
  return String(value || 'uncategorized').trim().toLowerCase();
}

function categoryVisualKey(value) {
  const key = categorySlug(value)
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (/\b(inner ?wear|underwear|briefs?|boxers?|trunks?|vests?|lingerie|bras?|bralettes?|pant(?:y|ies)|camisoles?|shapewear|swimwear|swimsuits?|bikinis?|monokinis?|tankinis?)\b/.test(key)) return 'innerwear';
  if (/\b(night ?wear|nighty|nightie|nightgown|sleep ?wear|pajamas?|pyjamas?|lounge ?wear|robes?)\b/.test(key)) return 'sleepwear';
  if (/\b(sun ?glasses|eye ?glasses|eyewear|spectacles?|optical frames?|goggles?|aviator|wayfarer)\b/.test(key)) return 'eyewear';
  if (/\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?)\b/.test(key)) return 'shoes';
  if (/\b(wallets?|purses?|backpacks?|handbags?|totes?|sling bags?|crossbody|duffels?|clutches?|bags?)\b/.test(key)) return 'bags';
  if (/\b(watches?|smart ?watches?|smartwatch(?:es)?|chronograph)\b/.test(key)) return 'watches';
  if (/\b(belts?|caps?|hats?|scarves?|ties?|jewellery|jewelry|necklaces?|bracelets?|earrings?|accessor(?:y|ies))\b/.test(key)) return 'accessories';
  if (/\b(sarees?|saris?|lehengas?|dupattas?|kurtas?|kurtis?|salwars?|churidars?|anarkali|palazzos?|ethnic|traditional|shararas?)\b/.test(key)) return 'ethnic wear';
  if (/\b(skirts?|skorts?)\b/.test(key)) return 'skirts';
  if (/\b(dresses?|gowns?|bodycon|maxi|midi|mini dress|a line dress|wrap dress|party dress)\b/.test(key)) return 'dresses';
  if (/\b(jeans?|denim)\b/.test(key)) return 'jeans';
  if (/\b(shorts?|bermudas?)\b/.test(key)) return 'shorts';
  if (/\b(pants?|trousers?|joggers?|leggings?|chinos?|cargo pants?|track pants?|bottom ?wear)\b/.test(key)) return 'pants';
  if (/\b(hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?)\b/.test(key)) return 'sweatshirts';
  if (/\b(jackets?|overshirts?|blazers?|coats?|windcheaters?|parkas?|shrugs?|outer ?wear)\b/.test(key)) return 'jackets';
  if (/\b(t ?shirts?|tshirts?|tees?|polo shirts?)\b/.test(key)) return 't-shirts';
  if (/\b(shirts?|button down|button up|formal shirt|casual shirt)\b/.test(key)) return 'shirts';
  if (/\b(tops?|blouses?|tunics?|crop tops?|tank tops?|camis?)\b/.test(key)) return 'tops';
  if (/\b(women|woman|female|ladies)\b/.test(key)) return 'women';
  if (/\b(men|man|male|gentlemen)\b/.test(key)) return 'men';
  if (/\b(unisex)\b/.test(key)) return 'unisex';

  return key.replace(/\s+/g, '-');
}

const categoryCollectionVisualPools = {
  all: [
    { image: 'category-reference-bottoms.png', position: 'center' },
    { image: 'category-reference-footwear.png', position: 'center' },
    { image: 'category-reference-accessories.png', position: 'center' },
    { image: 'wardrobe-room.jpg', position: '82% center' },
    { image: 'atelier-tailoring-reference.png', position: '58% center' },
    { image: 'opening-editorial-hero.png', position: '57% center' },
    { image: 'home-hero-editorial.png', position: '58% center' },
    { image: 'category-unisex-hero.png', position: '75% center' }
  ],
  women: [
    { image: 'category-women-hero.png', position: '73% center' },
    { image: 'hero1.png', position: '83% center' },
    { image: 'category-women-hero.png', position: '81% center' },
    { image: 'opening-editorial-hero.png', position: '42% center' },
    { image: 'home-hero-editorial.png', position: '42% center' },
    { image: 'atelier-tailoring-reference.png', position: '38% center' }
  ],
  men: [
    { image: 'arrival-1.jpg', position: 'center' },
    { image: 'arrival-2.jpg', position: 'center' },
    { image: 'arrival-3.jpg', position: 'center' },
    { image: 'arrival-5.jpg', position: 'center' },
    { image: 'arrival-6.jpg', position: 'center' },
    { image: 'trending-1.jpg', position: 'center' },
    { image: 'trending-2.jpg', position: 'center' },
    { image: 'trending-3.jpg', position: 'center' },
    { image: 'trending-4.jpg', position: 'center' },
    { image: 'trending-5.jpg', position: 'center' },
    { image: 'trending-6.jpg', position: 'center' },
    { image: 'search-shirt-1.jpg', position: 'center' }
  ],
  unisex: [
    { image: 'category-unisex-hero.png', position: '73% center' },
    { image: 'opening-editorial-hero.png', position: '57% center' },
    { image: 'home-hero-editorial.png', position: '58% center' },
    { image: 'atelier-tailoring-reference.png', position: '58% center' },
    { image: 'category-women-hero.png', position: '74% center' },
    { image: 'category-men-hero.png', position: '74% center' }
  ]
};

const categoryIconVisuals = {
  innerwear: { image: 'category-heroes/innerwear-hero.png', position: 'center' },
  lingerie: { image: 'category-heroes/innerwear-hero.png', position: 'center' },
  underwear: { image: 'category-heroes/innerwear-hero.png', position: 'center' },
  shorts: { image: 'category-heroes/bottomwear-hero.png', position: 'center' },
  jeans: { image: 'category-generated/jeans.png', position: 'center' },
  denim: { image: 'category-generated/jeans.png', position: 'center' },
  pants: { image: 'category-generated/pants.png', position: 'center' },
  trousers: { image: 'category-generated/pants.png', position: 'center' },
  bottoms: { image: 'category-generated/pants.png', position: 'center' },
  shoes: { image: 'category-heroes/shoes-hero.png', position: 'center' },
  footwear: { image: 'category-heroes/shoes-hero.png', position: 'center' },
  dresses: { image: 'category-heroes/dresses-hero.png', position: 'center' },
  dress: { image: 'category-heroes/dresses-hero.png', position: 'center' },
  skirts: { image: 'category-generated/skirts.png', position: 'center' },
  tops: { image: 'category-heroes/tops-hero.png', position: 'center' },
  shirts: { image: 'category-generated/shirts.png', position: 'center' },
  shirt: { image: 'category-generated/shirts.png', position: 'center' },
  't-shirts': { image: 'category-generated/t-shirts.png', position: 'center' },
  tshirts: { image: 'category-generated/t-shirts.png', position: 'center' },
  tees: { image: 'category-generated/t-shirts.png', position: 'center' },
  eyewear: { image: 'category-generated/eyewear.png', position: 'center' },
  sunglasses: { image: 'category-generated/eyewear.png', position: 'center' },
  glasses: { image: 'category-generated/eyewear.png', position: 'center' },
  jackets: { image: 'category-generated/jackets.png', position: 'center' },
  jacket: { image: 'category-heroes/outerwear-hero.png', position: 'center' },
  outerwear: { image: 'category-heroes/outerwear-hero.png', position: 'center' },
  sweatshirts: { image: 'category-generated/sweatshirts.png', position: 'center' },
  hoodies: { image: 'category-generated/sweatshirts.png', position: 'center' },
  sleepwear: { image: 'category-generated/sleepwear.png', position: 'center' },
  nightwear: { image: 'category-heroes/sleepwear-hero.png', position: 'center' },
  loungewear: { image: 'category-heroes/sleepwear-hero.png', position: 'center' },
  bags: { image: 'category-generated/bags.png', position: 'center' },
  accessories: { image: 'category-heroes/accessories-hero.png', position: 'center' },
  watches: { image: 'category-generated/watches.png', position: 'center' },
  watch: { image: 'category-generated/watches.png', position: 'center' },
  'ethnic wear': { image: 'category-generated/ethnic-wear.png', position: 'center' },
  ethnic: { image: 'category-generated/ethnic-wear.png', position: 'center' },
  women: { image: 'category-women-hero.png', position: '64% 18%' },
  men: { image: 'category-men-hero.png', position: '65% 18%' },
  unisex: { image: 'category-unisex-hero.png', position: 'center' }
};

function collectionVisualForCategory(category, audience = 'all') {
  const directMatch = categoryIconVisuals[categoryVisualKey(category)];
  if (directMatch) return directMatch;
  const pool = categoryCollectionVisualPools[audience] || categoryCollectionVisualPools.all;
  const key = categoryVisualKey(category);
  const index = [...key].reduce((total, character) => total + character.charCodeAt(0), 0) % pool.length;
  return pool[index];
}

function fallbackCategoryMeta(slug) {
  const match = categories.find(([, , itemSlug]) => itemSlug === slug);
  if (match) return { label: match[0], image: match[1] };
  return {
    label: slug.split(/[\s-]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ') || 'Uncategorized',
    image: 'hero2.png'
  };
}

const pageMeta = {
  '/women': ['For Women', 'Try new silhouettes with less guessing.', 'A dedicated shopping entry point for shirts, denim, jackets, accessories, and AI-powered outfit previews.', 'arrival-4.jpg'],
  '/new-arrivals': ['New Arrivals', 'Fresh pieces, first impressions.', 'New products are updated here so you can preview the latest fits before they disappear.', 'arrival-5.jpg'],
  '/sale': ['Sale', 'Better deals, fewer fit doubts.', 'Browse discounted products and use try-on previews before finalizing your picks.', 'search-shirt-2.jpg'],
  '/gift-cards': ['Gift Cards', 'Style confidence makes a good gift.', 'Gift cards can be used toward shopping and try-on tokens when the product is connected.', 'hero2.png'],
  '/about': ['About', 'Shopping online should feel more certain.', 'Lookmefy combines product discovery with AI try-on previews so shoppers can compare styles with more confidence.', 'hero2.png'],
  '/support': ['Help', 'Support for shopping and try-on.', 'Find answers about shipping, returns, profile photos, tokens, and account access.', 'search-shirt-4.jpg'],
  '/contact': ['Contact', 'Tell us what you need.', 'For order, token, account, and AI try-on questions, reach the Lookmefy support team.', 'hero2.png'],
  '/cart': ['Cart', 'Review your selected products.', 'Cart is prepared for product checkout, with backend order APIs still required before payment can be enabled.', 'hero2.png'],
  '/faq': ['FAQ', 'Common Lookmefy questions.', 'Answers for AI try-on, credits, shopping, privacy, and account support.', 'hero2.png'],
  '/shipping': ['Shipping Policy', 'Delivery information.', 'Shipping terms depend on connected brand and order support.', 'hero2.png'],
  '/returns': ['Return and Refund Policy', 'Return and refund guidance.', 'Return eligibility depends on brand policies and final order support.', 'hero2.png'],
  '/cancellation': ['Cancellation Policy', 'Cancellation guidance.', 'Cancellation support will follow the checkout and order backend contract.', 'hero2.png'],
  '/data-deletion': ['Data Deletion', 'Request deletion of Lookmefy data.', 'Learn how uploaded photos, generated looks, and account data can be removed.', 'hero2.png'],
  '/ai-disclaimer': ['AI Try-On Disclaimer', 'AI previews are visual guides.', 'AI-generated previews help visualize outfits; actual fit, colour, and fabric appearance may vary.', 'hero2.png'],
  '/careers': ['Careers', 'Build the future of fitting rooms.', 'Future roles across product, design, engineering, fashion operations, and partnerships would be listed here.', 'hero2.png'],
  '/blog': ['Blog', 'Fit notes, styling ideas, and AI try-on updates.', 'Editorial content, product guides, and try-on tips would live here.', 'arrival-4.jpg'],
  '/press': ['Press', 'Lookmefy press and media.', 'Company information, product screenshots, and media contact details would be available here.', 'hero2.png'],
  '/terms': ['Terms', 'Terms and conditions.', 'This page outlines where account, token, shopping, and AI try-on usage rules live.', 'hero2.png'],
  '/privacy': ['Privacy', 'Your try-on profile is personal.', 'This page describes how account details, full-body photos, token usage, and shopping activity are handled.', 'hero2.png'],
  '/copyright': ['Copyright Policy', 'Ownership and permitted use.', 'Copyright ownership, platform content rules, user content licence, and takedown support for Lookmefy.', 'hero2.png'],
  '/accessibility': ['Accessibility', 'Accessibility matters at every step.', 'Accessibility goals cover navigation, forms, image alt text, contrast, and keyboard-friendly flows.', 'hero2.png']
};

const legalDetails = {
  brand: 'Lookmefy',
  legalEntity: 'Lookmefy',
  copyrightOwner: 'Sharafat Hussain Khan',
  registeredAddress: '324 Kohinoor colony, Indore',
  supportEmail: 'support@lookmefy.com',
  jurisdiction: 'Indore, Madhya Pradesh, India',
  refundTimeline: '5-7 business days',
  lastUpdated: '17 August 2026'
};

const policyPages = {
  '/terms': {
    badge: 'Required',
    title: 'Terms and Conditions',
    intro: `These Terms govern your access to ${legalDetails.brand}, including account features, AI try-on previews, wardrobe tools, token purchases, and shopping links.`,
    sections: [
      ['Who operates Lookmefy', [`${legalDetails.brand} is operated by ${legalDetails.legalEntity}. Registered address: ${legalDetails.registeredAddress}.`, 'By using Lookmefy, you agree to these Terms and any policy pages linked from them.']],
      ['Accounts and eligibility', ['You are responsible for the information you provide during signup, including your name, phone number, email address, username, password, and try-on profile photo.', 'Do not create an account for someone else, upload photos you do not have rights to use, or use Lookmefy for unlawful, abusive, deceptive, or harmful purposes.']],
      ['AI try-on and wardrobe features', ['AI try-on images, videos, body-photo processing, style suggestions, and wardrobe outputs are visual previews only. They may differ from actual product fit, colour, fabric, size, texture, lighting, and availability.', 'You must not upload intimate, illegal, exploitative, or non-consensual images. We may block, remove, or refuse generation requests that appear unsafe or violate these Terms.']],
      ['Tokens, payments, and generation costs', ['Tokens are used for AI generation features. The token cost is shown in the app and may vary by feature, model, promotion, or plan.', 'If a generation fails and tokens were deducted without a usable output, Lookmefy may restore the applicable tokens after review. Tokens used for completed AI outputs are generally not refundable unless required by law.']],
      ['Monthly membership', ['Lookmefy offers a monthly membership/token plan. Membership billing, renewal, mandate setup, and token crediting are shown in the payment flow before confirmation.', 'Cancelling a monthly membership stops future renewals according to the payment flow, but does not automatically refund tokens already credited, consumed, or used for completed generations.']],
      ['Catalog and Amazon shopping links', ['Lookmefy redirects users to Amazon or other connected third-party stores for product checkout. Lookmefy is not the seller of those products and does not directly handle product fulfilment.', 'Amazon or the relevant seller controls the final price, stock, delivery, cancellation, return, refund, warranty, seller claims, and checkout terms. Always confirm final details on Amazon before purchase.']],
      ['User content and licence', ['You retain ownership of photos and content you upload. You give Lookmefy a limited licence to process, store, display, transform, and use that content only to provide the app features, improve reliability and safety, comply with law, and support your account requests.', 'You confirm that you have all rights and permissions needed for uploaded photos, garments, names, product links, and other submitted materials.']],
      ['Suspension and termination', ['We may limit, suspend, or terminate access if we reasonably believe an account violates these Terms, creates security risk, abuses tokens/promotions, attempts fraud, or harms other users or systems.', 'You may stop using the service at any time and request deletion of account data using the Data Deletion page.']],
      ['Liability and governing law', [`To the maximum extent permitted by law, ${legalDetails.brand} is provided on an “as is” and “as available” basis. We do not guarantee uninterrupted access, perfect AI results, product availability, or Amazon/seller fulfilment.`, `These Terms are governed by the laws of India, and courts at Indore, Madhya Pradesh will have jurisdiction, subject to applicable law.`]]
    ]
  },
  '/privacy': {
    badge: 'Required',
    title: 'Privacy Policy',
    intro: `This Privacy Policy explains how ${legalDetails.brand} handles account data, uploaded photos, generated try-ons, wardrobe data, payment events, and usage activity.`,
    sections: [
      ['Data we collect', ['Account information such as name, username, email address, phone number, OTP verification status, password hash, gender/style preference, and account settings.', 'Photos and media you upload, including profile/body photos, garment uploads, wardrobe images, generated try-on images/videos, background-removed images, and related metadata.', 'Usage and device information such as product views, wishlist actions, search/filter events, token usage, generation history, approximate logs, IP-derived security information, and browser/session data.']],
      ['How we use data', ['To create and secure your account, verify login, provide AI try-on/profile generation, store wardrobe items, personalize recommendations, operate credits/tokens, process payments, prevent abuse, debug failures, and provide support.', 'To improve reliability, safety, product ranking, model prompts, and app performance, using appropriate access controls and minimization where practical.']],
      ['AI, payment, storage, and infrastructure providers', ['We may share necessary data with service providers that help run Lookmefy, including AI generation providers, image/video processing providers, hosting infrastructure, storage/CDN providers, analytics/observability tools, payment processors, SMS/OTP providers, and support tools.', 'Payment card/UPI/banking details are handled by the payment provider. Lookmefy stores payment status, order identifiers, token credit records, and limited transaction metadata needed for reconciliation and support.']],
      ['Photos and generated media', ['Uploaded body photos and generated previews are sensitive to you. They are used to provide try-on, profile, wardrobe, and style features. Avoid uploading photos of other people without consent.', 'Generated previews may be stored so you can view history, compare looks, create videos, or restore prior outputs. You can request deletion using the Data Deletion page.']],
      ['Retention and deletion', ['We keep account data while your account is active or as needed for service, security, legal, tax, fraud prevention, dispute resolution, and backup purposes.', 'When deletion is requested, we will delete or de-identify eligible account data and media, subject to legal, security, transaction, and backup-retention requirements. Some third-party providers may retain logs under their own policies.']],
      ['Your choices and rights', ['You can update account details in profile settings, delete wishlist/wardrobe items where available, log out, and request account/media deletion.', 'You may contact us to access, correct, withdraw consent where applicable, or raise a privacy grievance. We will verify requests before acting on account or photo data.']],
      ['Security', ['We use technical and organizational measures such as authentication, access controls, upload validation, storage controls, rate limiting, and monitoring. No online service can guarantee absolute security.', 'Keep your password and device secure. Tell us promptly if you suspect unauthorized account access.']],
      ['Contact and support', [`Support and privacy requests can be sent to ${legalDetails.supportEmail}. Use your registered email/phone and include enough detail for us to verify and review the request.`]]
    ]
  },
  '/copyright': {
    badge: 'Required',
    title: 'Copyright Policy',
    intro: `Copyright in ${legalDetails.brand}'s platform content is owned by ${legalDetails.copyrightOwner}. This policy explains ownership, permitted use, user uploads, third-party product content, and copyright support.`,
    sections: [
      ['Copyright owner and business details', [`Copyright (c) 2026 ${legalDetails.copyrightOwner}. All rights reserved for original ${legalDetails.brand} website, app, design, text, layouts, policy content, brand presentation, AI try-on experience, wardrobe flows, token/credit screens, and related platform material.`, `${legalDetails.brand} is operated by ${legalDetails.legalEntity}. Registered address: ${legalDetails.registeredAddress}. Support and copyright requests can be sent to ${legalDetails.supportEmail}.`]],
      ['Protected Lookmefy content', [`Protected content includes ${legalDetails.brand} pages, UI screens, visual design, product discovery flows, profile and wardrobe interfaces, AI try-on prompts and outputs generated through the platform where rights belong to ${legalDetails.brand}, written policies, logos, icons, text, code, databases, compilations, and service documentation.`, `You may use ${legalDetails.brand} only for personal fashion discovery, wardrobe management, AI try-on previews, token purchases, and shopping-link navigation as allowed by our Terms and policies.`]],
      ['Permitted use', [`You may view, access, and use ${legalDetails.brand} content for normal personal use inside the website or app. You may share standard page links to public pages, product links, support pages, and policy pages.`, 'Any copying, scraping, republication, resale, reverse engineering, automated extraction, brand impersonation, removal of notices, or commercial reuse of Lookmefy content requires prior written permission.']],
      ['User uploaded content', ['You retain ownership of photos, garment images, wardrobe items, names, product references, and other content you upload, subject to the licence granted in the Terms and Privacy Policy.', `By uploading content, you confirm that you have the rights and permissions needed to upload and process it through ${legalDetails.brand}. Do not upload photos, media, product images, or personal content that infringes another person's rights.`]],
      ['AI try-on and generated media', ['AI try-on images, videos, wardrobe outputs, and stylist suggestions are visual previews only. Rights and permitted use may depend on your uploaded content, third-party product images, provider terms, and applicable law.', `Generated media may be stored and displayed in your ${legalDetails.brand} account for history, comparison, wardrobe, styling, video creation, support, security, and service operation as described in our Privacy Policy.`]],
      ['Third-party catalog and marketplace content', [`${legalDetails.brand} may display or link to product images, names, prices, descriptions, brands, Amazon links, seller information, and other third-party catalog data for discovery and shopping convenience.`, 'Third-party product content remains owned by the relevant brand, seller, marketplace, manufacturer, or rights holder. Amazon or the relevant seller controls final product listing content, checkout, shipping, returns, refunds, and warranties.']],
      ['Payment, token, and policy content', ['Copyright and policy pages support payment-gateway compliance by explaining platform ownership, permitted use, support routes, payment-related content, token usage, and user responsibilities.', 'Token purchases, memberships, refunds, cancellation, privacy, shipping, and data deletion are governed by their respective Lookmefy policy pages and the final payment flow shown before confirmation.']],
      ['Copyright complaints and takedown requests', [`If you believe content on ${legalDetails.brand} infringes your copyright, email ${legalDetails.supportEmail} with the subject "Copyright complaint". Include your name, contact details, copyrighted work, the exact Lookmefy URL or content location, proof of ownership or authorization, and a statement explaining the alleged infringement.`, 'We may remove, restrict, or investigate reported content after review. We may also ask for additional verification before acting on a request. False or misleading complaints may be rejected and may lead to account action.']],
      ['Repeat infringement and account action', [`${legalDetails.brand} may suspend or terminate accounts that repeatedly upload infringing, unauthorized, deceptive, unsafe, or abusive content. We may also block content that creates legal, security, privacy, or platform-risk concerns.`]],
      ['Governing law and contact', [`This policy is governed by the laws of India, and courts at ${legalDetails.jurisdiction} will have jurisdiction, subject to applicable law.`, `For copyright, support, payment-policy, privacy, or grievance questions, contact ${legalDetails.supportEmail}.`]]
    ]
  },
  '/shipping': {
    badge: 'Required',
    title: 'Shipping Policy',
    intro: `${legalDetails.brand} helps you discover products and preview outfits. Product checkout and shipping are handled by Amazon or the seller where you complete checkout.`,
    sections: [
      ['Who ships the product', ['If you click through to Amazon, Amazon or the listed seller is responsible for shipping, delivery timelines, tracking, delivery charges, failed delivery, and logistics support.', 'Lookmefy may display catalog and price information for convenience, but the Amazon checkout page controls the final order terms.']],
      ['Delivery timelines and charges', ['Estimated delivery dates, serviceable pincodes, shipping fees, cash-on-delivery availability, and express-delivery options may vary by Amazon, seller, warehouse, product, and address.', 'Always review the final Amazon checkout page before paying.']],
      ['Tracking and delivery issues', ['Use the Amazon order/tracking page for live shipment updates. If you need help finding order support, contact Lookmefy support with the product link, order date, seller name, and any order reference available.', 'Delays caused by weather, address errors, courier disruption, seller stock issues, customs, strikes, or force majeure are outside Lookmefy control.']],
      ['Digital products and tokens', ['Tokens, AI generations, account features, and other digital services are delivered inside the Lookmefy account and do not require physical shipping.']]
    ]
  },
  '/returns': {
    badge: 'Required',
    title: 'Return and Refund Policy',
    intro: 'This policy separates Amazon product returns from Lookmefy token, AI generation, membership, and digital-service refunds.',
    sections: [
      ['Product returns', ['For products bought on Amazon, Amazon’s and the listed seller’s return, exchange, replacement, and refund policy applies. Check size, hygiene exclusions, return window, tags, packaging, pickup availability, and refund method before purchase.', 'Lookmefy redirects users to Amazon and can help locate the product/order support path, but final approval is controlled by Amazon or the seller.']],
      ['Token and AI generation refunds', ['Tokens used for completed AI outputs are generally non-refundable because the generation cost is incurred when the request is processed.', 'If tokens are deducted and generation fails without a usable output, Lookmefy may restore the deducted tokens after review. The primary remedy for failed generation is token restoration, not cash refund.']],
      ['Monthly membership refunds', ['Monthly membership payments are charged through the payment flow shown in the app. Used tokens, credited tokens, and completed AI generations are generally not refundable.', 'If a duplicate charge, payment mismatch, or technical billing error is confirmed, an approved refund will be processed within 5-7 business days, subject to payment provider and bank timelines.']],
      ['Payment refunds', ['Accepted refunds will normally be returned to the original payment method or credited as account tokens, depending on the case, payment processor rules, and applicable law.', `Approved Lookmefy refunds are initiated within ${legalDetails.refundTimeline}. Actual bank, card, UPI, or payment-app posting time may vary.`]],
      ['Non-returnable cases', ['AI previews are not guarantees of exact fit, product quality, or Amazon/seller fulfilment. A difference between AI preview and real-world product appearance does not by itself make an Amazon product return eligible unless Amazon or the seller policy allows it.', 'Items marked final sale, hygiene-sensitive, customized, damaged after delivery, missing tags/packaging, or outside the return window may be refused by Amazon or sellers.']]
    ]
  },
  '/cancellation': {
    badge: 'Required',
    title: 'Cancellation Policy',
    intro: 'This policy explains cancellation for AI generation requests, token purchases, and third-party product orders.',
    sections: [
      ['AI generation cancellation', ['Image/video generation starts quickly after you submit a request. Once submitted to the AI provider, a generation request may not be cancellable because provider cost may already be incurred.', 'If the request fails and no usable output is delivered, token restoration may apply under the Return and Refund Policy.']],
      ['Token purchase cancellation', ['Token top-ups and digital credits may be cancelled only before successful payment confirmation. After tokens are credited, cancellation/refund is handled under the Return and Refund Policy.', 'If a payment succeeds but tokens do not appear, contact support with the transaction reference so we can verify and credit or reverse as applicable.']],
      ['Monthly membership cancellation', ['Monthly membership is available now. You can cancel future renewal/mandate billing through the payment or account flow when available, or by contacting support from your registered account email.', 'Cancelling future billing does not automatically refund already-used tokens, credited tokens, or completed AI generations. Confirmed duplicate or technical billing errors may be refunded under the Return and Refund Policy.']],
      ['Amazon order cancellation', ['For products ordered on Amazon, cancellation is governed by Amazon’s and the seller’s policy and order status. Any cancellation charges or restrictions should be reviewed on Amazon before checkout.']]
    ]
  },
  '/data-deletion': {
    badge: 'Required',
    title: 'Data Deletion Policy',
    intro: `You can request deletion of eligible ${legalDetails.brand} account data, uploaded photos, generated try-ons, wardrobe media, and related profile information.`,
    sections: [
      ['How to request deletion', [`Email ${legalDetails.supportEmail} from your registered email address with the subject “Data deletion request”, or use the in-app support flow when available. Include your username, phone/email used for signup, and what you want deleted: account, body photo, generated media, wardrobe items, or specific records.`, 'We may ask for verification before deleting account-linked data or photos.']],
      ['What we delete', ['Eligible account profile data, uploaded body/profile photos, generated try-on images/videos, wardrobe uploads, wishlist data, saved preferences, and non-essential usage history associated with your account.', 'We may also delete derived thumbnails, cached images, background-removed versions, and private stored media where technically feasible.']],
      ['What may be retained', ['We may retain records required for legal, fraud prevention, payment reconciliation, tax/accounting, dispute resolution, security logs, backup integrity, or compliance obligations.', 'Backups and provider logs may take additional time to expire under normal retention cycles.']],
      ['Timeline', ['We aim to acknowledge deletion requests within a reasonable period and complete eligible deletion after verification, subject to legal, security, payment, fraud-prevention, and backup-retention requirements.', 'If deletion is complex or legally restricted, we will explain the status or limitation where appropriate.']],
      ['Effect of deletion', ['Deleting account or body-photo data may disable try-on history, profile previews, wardrobe features, recommendations, token history display, and support visibility for prior generations.']]
    ]
  },
  '/ai-disclaimer': {
    badge: 'Recommended',
    title: 'AI Try-On Disclaimer',
    intro: 'AI previews help you visualize styling, but they are not measurements, guarantees, medical/body advice, or seller promises.',
    sections: [
      ['Preview accuracy', ['Generated images and videos may differ from real product fit, size, drape, colour, fabric texture, transparency, lighting, logos, sleeves, collars, footwear, body proportions, and background.', 'Use previews as visual guidance only. Confirm size charts, seller photos, material details, reviews, and return rules before buying.']],
      ['Body photos and identity', ['AI systems may alter pose, face, body shape, skin tone, hairstyle, clothing edges, shadows, or proportions. Use clear, consented photos and avoid uploading images of other people without permission.', 'Do not use AI try-on outputs for identity verification, health/body assessment, biometric decisions, or any high-stakes decision.']],
      ['Product and brand information', ['Lookmefy may process third-party catalog images and Amazon links. AI outputs do not mean a brand, Amazon, or seller endorses the preview or guarantees availability.', 'Final purchase decisions remain between you and Amazon or the seller.']],
      ['Safety limits', ['Some images or requests may be blocked or fail because of provider safety filters, image quality, product category, or technical limitations.']]
    ]
  },
  '/accessibility': {
    badge: 'Recommended',
    title: 'Accessibility Statement',
    intro: `${legalDetails.brand} aims to make product discovery, account flows, and AI try-on tools usable across devices, input methods, and assistive technologies.`,
    sections: [
      ['Our current approach', ['We aim for readable contrast, keyboard-reachable navigation, labelled controls, responsive layouts, alt text for meaningful images, form labels, focus states, and reduced-motion support where practical.', 'AI-generated and catalog images may still have limitations, especially when source metadata is incomplete.']],
      ['Known areas to improve', ['Complex experiences such as image zoom, generated media previews, wardrobe editing, onboarding spotlight overlays, and Amazon/product embeds may need further testing with screen readers and keyboard-only flows.', 'Some third-party checkout, payment, seller, or provider pages are outside our direct control.']],
      ['Feedback', [`If you face an accessibility issue, contact ${legalDetails.supportEmail} with the page URL, device/browser, assistive technology if any, and a description of the issue.`]],
      ['Ongoing work', ['We will continue improving mobile spacing, text scaling, focus order, error messages, and media alternatives as the product evolves.']]
    ]
  },
  '/contact': {
    badge: 'Required',
    title: 'Contact and Grievance Support',
    intro: 'Use this page for account, payment, data, product-link, AI generation, and policy questions.',
    sections: [
      ['Customer support', [`Email: ${legalDetails.supportEmail}. Include your registered email/phone, username, product link or transaction ID if relevant, screenshots if helpful, and a short description of the issue.`]],
      ['Support and policy contact', [`For support, privacy, grievance, and policy requests, email ${legalDetails.supportEmail}. Include enough detail for us to verify the account or request where needed.`]],
      ['Typical request categories', ['Account access, OTP/login issues, token payment verification, failed generation, data deletion, privacy requests, seller/order guidance, safety reports, and accessibility feedback.']],
      ['Response process', ['We will review requests, verify account ownership where needed, and route Amazon or seller order issues to the appropriate external support flow when Lookmefy is not the merchant of record.']]
    ]
  },
  '/support': {
    badge: 'Required',
    title: 'Support Center',
    intro: 'Find help for account access, AI try-on, tokens, product links, shipping, returns, and privacy requests.',
    sections: [
      ['Fastest way to get help', [`Email ${legalDetails.supportEmail} with your registered account details and issue type. For payments, include transaction/order reference. For Amazon products, include the product URL and seller name.`]],
      ['AI generation help', ['If image or video generation fails, try a clear full-body profile photo, a wearable product image, and a stable connection. If tokens were deducted for a failed generation, contact support for review.']],
      ['Shopping help', ['Lookmefy redirects shopping to Amazon. For delivery, cancellation, return, exchange, warranty, and final refund approval, follow Amazon’s and the seller’s policy.']],
      ['Privacy and deletion', ['For privacy, correction, consent withdrawal, or deletion requests, use the Data Deletion Policy or email support with the subject line that matches your request.']]
    ]
  }
};

const demoPolicyPages = {
  '/terms': {
    title: 'Terms and Conditions',
    intro: `These Terms govern ${legalDetails.brand} ecommerce checkout, account features, AI try-on previews, token purchases, and product orders placed directly on Lookmefy.`,
    sections: [
      ['Who operates Lookmefy', [`${legalDetails.brand} is operated by ${legalDetails.legalEntity}. Registered address: ${legalDetails.registeredAddress}.`, 'Lookmefy can collect product order details and confirm supported India deliveries through the checkout flow.']],
      ['Product orders', ['Product prices, availability, images, descriptions, and eligible variants are shown in the catalog and rechecked before order creation.', 'An order is confirmed only after payment status is successfully verified. We may cancel or refund orders affected by pricing errors, stock issues, serviceability limits, fraud checks, or technical failure.']],
      ['Payments', ['The Pay now action confirms the order in Lookmefy for this checkout mode.', 'Lookmefy stores order identifiers, payment status, contact details, delivery address, and support records needed for fulfilment workflows.']],
      ['Delivery, cancellation, returns, and refunds', ['Delivery is currently available within India for serviceable pincodes. Delivery timelines, support handling, cancellation eligibility, return eligibility, and refund timelines are described in the linked policy pages.', `Approved refunds are initiated within ${legalDetails.refundTimeline}, subject to payment provider and bank timelines.`]],
      ['AI try-on and tokens', ['AI try-on previews remain visual guides only. They do not guarantee exact fit, size, colour, fabric, or final product appearance.', 'Token purchases, memberships, and AI generation requests continue to follow the token and AI policy sections shown in the app.']],
      ['Liability and governing law', [`To the maximum extent permitted by law, ${legalDetails.brand} is provided on an as-is and as-available basis.`, `These Terms are governed by the laws of India, and courts at ${legalDetails.jurisdiction} will have jurisdiction, subject to applicable law.`]]
    ]
  },
  '/privacy': {
    title: 'Privacy Policy',
    intro: `This Privacy Policy explains how ${legalDetails.brand} handles account data, checkout contact details, delivery addresses, payment events, uploaded photos, generated try-ons, and usage activity.`,
    sections: [
      ['Data we collect', ['For ecommerce checkout, we collect full name, mobile number, delivery address, pincode, cart items, product snapshots, order totals, and payment status metadata.', 'For AI and account features, we collect the profile, media, generation, wishlist, wardrobe, token, and usage data described in the standard Privacy Policy.']],
      ['How we use data', ['We use checkout data to create orders, validate serviceable pincodes, confirm payment status, provide delivery updates, prevent abuse, and support customer requests.', 'We may use limited operational data to improve reliability, security, catalog quality, and fulfilment workflows.']],
      ['Payment providers and service providers', ['Lookmefy stores order references and transaction state needed to operate the checkout and support customer requests.', 'We may share necessary checkout and support data with hosting, storage, analytics, logistics, notification, and support providers.']],
      ['Retention and deletion', ['Order and payment records may be retained for legal, tax, accounting, fraud prevention, dispute resolution, security, and support requirements.', 'You can request access, correction, consent withdrawal where applicable, or deletion of eligible account and media data by contacting support.']],
      ['Contact and grievance support', [`Support and privacy requests can be sent to ${legalDetails.supportEmail}. Include the order ID, checkout mobile number, registered account detail if any, and enough detail for us to verify the request.`]]
    ]
  },
  '/shipping': {
    title: 'Shipping Policy',
    intro: `${legalDetails.brand} currently delivers product orders within India to serviceable pincodes.`,
    sections: [
      ['Delivery area', ['Checkout accepts India delivery addresses only. Pincode lookup may auto-fill city/state details when available and will block unsupported pincodes.', 'Some pincodes may be unsupported because of courier coverage, inventory location, operational limits, or temporary service restrictions.']],
      ['Shipping charges and timelines', ['Checkout currently shows free shipping unless a future shipping rule is added. Estimated timelines will be shared through order support or delivery updates.', 'Delivery may be delayed by address errors, customer unavailability, courier constraints, weather, public holidays, strikes, or other events outside direct control.']],
      ['Delivery updates', ['Order and delivery updates use the full name and mobile number entered at checkout.', 'If your address or contact information is wrong, contact support quickly with the order ID. Changes may not be possible after packing or dispatch.']]
    ]
  },
  '/returns': {
    title: 'Return and Refund Policy',
    intro: 'This policy covers product orders placed directly through Lookmefy checkout, plus token and AI-generation refunds.',
    sections: [
      ['Product returns', ['Return eligibility depends on product category, condition, tags, packaging, hygiene restrictions, damage checks, pickup feasibility, and the return window shown or communicated for the order.', 'Items used, washed, altered, missing original tags/packaging, damaged after delivery, hygiene-sensitive, personalized, or marked final sale may be refused.']],
      ['Refunds', [`Approved product refunds are initiated within ${legalDetails.refundTimeline} after return approval or successful cancellation, subject to payment network and bank timelines.`, 'Refunds normally return to the original payment method unless another legally valid remedy is agreed.']],
      ['Damaged, wrong, or missing items', ['Contact support with order ID, photos, packaging images, and an unboxing/delivery issue description as soon as possible.', 'We may request additional verification before approving replacement, return, or refund.']],
      ['Token and AI generation refunds', ['Tokens used for completed AI outputs are generally non-refundable. If tokens are deducted for a failed generation with no usable output, token restoration may apply after review.']]
    ]
  },
  '/cancellation': {
    title: 'Cancellation Policy',
    intro: 'This policy explains cancellation for Lookmefy product orders, token purchases, membership billing, and AI generation requests.',
    sections: [
      ['Product order cancellation', ['A product order can be cancelled before it is packed or dispatched, subject to payment verification, inventory status, fraud checks, and fulfilment stage.', 'After dispatch, cancellation may not be available and the return process may apply instead.']],
      ['Failed or pending payments', ['Checkout should confirm inside Lookmefy. If an order remains pending because of a technical issue, you can retry checkout from the order status or product page.', 'For token purchases, contact support with the transaction reference if payment succeeds but account crediting is delayed.']],
      ['AI generation and token cancellation', ['AI generation requests start quickly and may not be cancellable once submitted. Token purchase and membership cancellation continue to follow the token policy terms.']]
    ]
  },
  '/contact': {
    title: 'Contact and Grievance Support',
    intro: 'Use this page for product orders, delivery updates, payment issues, account support, AI generation, and privacy requests.',
    sections: [
      ['Customer support', [`Email: ${legalDetails.supportEmail}. Include your full name, checkout mobile number, order ID or transaction reference, screenshots if helpful, and a short issue description.`]],
      ['Order support', ['For delivery, cancellation, return, refund, wrong item, damaged item, or payment confirmation issues, include the Lookmefy order ID and checkout contact details used on the order.']],
      ['Privacy and grievance requests', [`For privacy, data deletion, policy, or grievance questions, contact ${legalDetails.supportEmail}. We may verify your identity before acting on account, media, payment, or order data.`]]
    ]
  },
  '/support': {
    title: 'Support Center',
    intro: 'Find help for product orders, payments, delivery, returns, account access, AI try-on, tokens, and privacy requests.',
    sections: [
      ['Fastest way to get help', [`Email ${legalDetails.supportEmail} with your order ID, registered contact details, transaction reference if relevant, screenshots, and the issue type.`]],
      ['Checkout and payment help', ['Product checkout confirms inside Lookmefy. If the success popup does not appear, retry from checkout or the order status page.', 'For token payments, support can verify transaction metadata when needed.']],
      ['Delivery, cancellation, and returns', ['Delivery is currently within India for supported pincodes. Cancellation and return support depends on the order status and product condition.']],
      ['AI and token help', ['For failed generations or token issues, include the generation type, product link if any, and account email or mobile number.']]
    ]
  }
};

function policyForPath(path, demoEcommerceMode = false) {
  return demoEcommerceMode ? (demoPolicyPages[path] || policyPages[path]) : policyPages[path];
}

function normalizePath() {
  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
  return path || '/';
}

function authReturnPath() {
  const value = new URLSearchParams(window.location.search).get('return') || '';
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/home';
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return '/home';
    return `${url.pathname}${url.search}${url.hash}` || '/home';
  } catch {
    return '/home';
  }
}

function loginHrefForIdentifier(identifier = '') {
  const params = new URLSearchParams();
  const cleanIdentifier = String(identifier || '').trim();
  const destination = authReturnPath();
  if (cleanIdentifier) params.set('identifier', cleanIdentifier);
  if (destination && destination !== '/home') params.set('return', destination);
  const query = params.toString();
  return `/login${query ? `?${query}` : ''}`;
}

function isExistingAccountError(error) {
  return error?.code === 'ACCOUNT_EXISTS' || (error?.status === 409 && /account already exists/i.test(error?.message || ''));
}

function isLikelyEmail(value = '') {
  return /^\S+@\S+\.\S+$/.test(String(value || '').trim());
}

function requiresAuthentication(path = normalizePath()) {
  return path === '/profile'
    || path === '/generation-history'
    || path === '/style-bot'
    || path === '/custom-try-on'
    || path === '/try-on'
    || path === '/closet'
    || path.startsWith('/closet/');
}

function readAuthToken() {
  const persistent = localStorage.getItem(AUTH_TOKEN_KEY);
  if (persistent) return persistent;
  const legacy = sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (legacy) {
    localStorage.setItem(AUTH_TOKEN_KEY, legacy);
    sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }
  return legacy || '';
}

function writeAuthToken(token) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
}

function readMediaToken() {
  return sessionStorage.getItem(MEDIA_TOKEN_KEY) || '';
}

function writeMediaToken(token) {
  if (token) sessionStorage.setItem(MEDIA_TOKEN_KEY, token);
  else sessionStorage.removeItem(MEDIA_TOKEN_KEY);
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(AUTH_TOKEN_KEY);
  sessionStorage.removeItem(MEDIA_TOKEN_KEY);
}

function currentSearchValue() {
  return normalizeSearchQuery(new URLSearchParams(window.location.search).get('q') || '');
}

function normalizeSearchQuery(value = '') {
  let query = String(value || '').trim().replace(/\s+/g, ' ');
  query = query.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim().replace(/\s+/g, ' ');
  return query;
}

function isWardrobeRoomPreview(value = '') {
  return /(?:wardrobe-room|wardrobe-stage-room|warm-modern-wardrobe|closet-room|room-preview)/i.test(String(value || ''));
}

function safeWardrobeImageUrl(value = '') {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || isWardrobeRoomPreview(url)) return '';
  return protectedMediaUrl(url);
}

function protectedMediaUrl(value = '') {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || /^(?:data:|blob:)/i.test(url)) return url;
  if (!url.startsWith('/uploads/')) return url;
  const token = readMediaToken();
  if (!token || /(?:[?&])mediaToken=/.test(url)) return API_BASE_URL ? `${API_BASE_URL}${url}` : url;
  const separator = url.includes('?') ? '&' : '?';
  const withToken = `${url}${separator}mediaToken=${encodeURIComponent(token)}`;
  return API_BASE_URL ? `${API_BASE_URL}${withToken}` : withToken;
}

function readRecentSearches() {
  try {
    const stored = JSON.parse(localStorage.getItem('fitlook_recent_searches') || '[]');
    return Array.isArray(stored) ? stored.map(normalizeSearchQuery).filter(Boolean).slice(0, 6) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(search) {
  const value = normalizeSearchQuery(search);
  if (!value) return readRecentSearches();
  const next = [value, ...readRecentSearches().filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(0, 6);
  try {
    localStorage.setItem('fitlook_recent_searches', JSON.stringify(next));
  } catch {
    // Search still works when private storage is unavailable.
  }
  return next;
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

function cleanDisplayText(value, fallback = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (/\b(?:bust|waist|hip|sleeve|shoulder|inseam|cuff|length|heel to toe|thigh circumference)\s*\(in\)/i.test(text)) return fallback;
  if (text.length > 58) return fallback;
  return text;
}

function displayBrand(product) {
  const brand = cleanDisplayText(product?.brand, '');
  if (!brand) return 'Marketplace brand';
  if (brand.toLowerCase() === 'amazon') return 'Amazon';
  return brand;
}

function displayCategory(product) {
  return cleanDisplayText(product?.category, 'Products');
}

function displayProductBadge(product) {
  const badge = cleanDisplayText(product?.badge, '');
  return badge.toLowerCase() === 'affiliate' ? '' : badge;
}

function usableBrands(brands = []) {
  return brands.map((brand) => cleanDisplayText(brand, '')).filter(Boolean);
}

function rateLimitMessage(data, fallback) {
  const base = readableError(data, fallback);
  const seconds = Number(data?.retryAfterSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return base;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${base} Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

function compactCount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '0';
  if (number >= 1000) return `${Math.floor(number / 1000)}K+`;
  return String(number);
}

async function api(path, options = {}) {
  const {
    timeout = API_TIMEOUT_MS,
    retry,
    signal: externalSignal,
    headers: optionHeaders,
    ...requestOptions
  } = options;
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const retryCount = retry === undefined ? (method === 'GET' ? 1 : 0) : Math.max(0, Number(retry) || 0);
  const token = readAuthToken();
  const headers = requestOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestPath = String(path || '').startsWith('/') ? String(path || '') : `/${path || ''}`;
  const requestUrl = `${API_BASE_URL}/api${requestPath}`;

  let lastError;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);

    try {
      const res = await fetch(requestUrl, {
        ...requestOptions,
        signal: controller.signal,
        headers: { ...headers, ...optionHeaders }
      });
      const contentType = res.headers.get('content-type') || '';
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = new Error(res.status === 429 ? rateLimitMessage(data, `Request failed (${res.status})`) : readableError(data, `Request failed (${res.status})`));
        error.status = res.status;
        if (data && typeof data === 'object') {
          error.data = data;
          error.code = data.code;
          error.identifier = data.identifier;
        }
        throw error;
      }
      if (data === null && !contentType.includes('application/json')) {
        const error = new Error('The API is not returning JSON. Check the production /api routing.');
        error.status = res.status;
        throw error;
      }
      if (data?.mediaToken) writeMediaToken(data.mediaToken);
      return data;
    } catch (error) {
      if (externalSignal?.aborted) throw error;
      if (timedOut) {
        const isLongRunningAi = timeout >= AI_IMAGE_TIMEOUT_MS || /\/tryons\/|\/closet\/outfits\/generate/.test(path);
        throw new Error(isLongRunningAi
          ? 'AI rendering is taking longer than expected. Please try again in a moment.'
          : 'The request took too long. Check your connection and try again.');
      }
      lastError = error instanceof Error ? error : new Error('Unable to reach Lookmefy right now.');
      const canRetry = attempt < retryCount && (!lastError.status || lastError.status >= 500);
      if (!canRetry) {
        if (!lastError.status && typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('You appear to be offline. Reconnect and try again.');
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
  throw lastError || new Error('Unable to reach Lookmefy right now.');
}

async function resolveQueuedJobResponse(data, { timeout = AI_IMAGE_TIMEOUT_MS, intervalMs = 1800 } = {}) {
  if (!data?.queued || !data.jobId) return data;
  const statusPath = data.statusPath || String(data.statusUrl || '').replace(/^\/api/, '');
  if (!statusPath) throw new Error('Try-on job was queued, but no status endpoint was returned.');

  const started = Date.now();
  while (Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const status = await api(statusPath, { timeout: API_TIMEOUT_MS, retry: 0 });
    const job = status.job || {};
    if (job.state === 'completed') {
      const result = job.result || {};
      if (result.status && result.status >= 400) throw new Error(readableError(result.body, 'Could not generate AI try-on'));
      return result.body || result;
    }
    if (job.state === 'failed') {
      throw new Error(job.failedReason || 'Could not generate AI try-on');
    }
  }
  throw new Error('AI rendering is still running. Check this item again in a moment.');
}

async function generateQueuedTryOn(path, options = {}) {
  const data = await api(path, options);
  return resolveQueuedJobResponse(data, { timeout: options.timeout || AI_IMAGE_TIMEOUT_MS });
}

let razorpayCheckoutLoader = null;

function loadRazorpayCheckout() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Razorpay checkout is only available in the browser.'));
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (razorpayCheckoutLoader) return razorpayCheckoutLoader;
  razorpayCheckoutLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay checkout could not be loaded.'));
    };
    script.onerror = () => reject(new Error('Razorpay checkout could not be loaded. Check your connection and try again.'));
    document.head.appendChild(script);
  }).catch((error) => {
    razorpayCheckoutLoader = null;
    throw error;
  });
  return razorpayCheckoutLoader;
}

function razorpayFailureMessage(response) {
  return response?.error?.description || response?.error?.reason || 'Payment was not completed. You can try again when ready.';
}

function recordEvent(type, payload = {}) {
  trackClientEvent(type, payload);
  if (!readAuthToken()) return;
  api('/recommendations/events', {
    method: 'POST',
    body: JSON.stringify({ type, ...payload })
  }).catch(() => {});
}

function tryOnProfileBlockMessage(user) {
  const status = user?.bodyPhotoStatus || 'uploaded';
  if (!user?.bodyPhotoUrl && !user?.bodyPhotoOriginalUrl) return 'Upload a profile photo before starting an AI try-on.';
  if (status === 'generating') return 'Your full-body try-on profile is still preparing. Try again in a minute.';
  if (status === 'failed') return 'Could not prepare your full-body try-on profile. Upload a clearer photo from your profile page.';
  return '';
}

function announce(message, tone = 'success') {
  if (typeof window === 'undefined' || !message) return;
  window.dispatchEvent(new CustomEvent('fitlook:toast', { detail: { message, tone } }));
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && Boolean(window.matchMedia?.(query)?.matches)
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}

function useStorefrontConfig() {
  const [state, setState] = useState({ demoEcommerceMode: false, loading: true, error: '' });

  useEffect(() => {
    let alive = true;
    api('/storefront/config', { retry: 1 })
      .then((data) => {
        if (alive) setState({ demoEcommerceMode: Boolean(data?.demoEcommerceMode), loading: false, error: '' });
      })
      .catch((error) => {
        if (alive) setState({ demoEcommerceMode: false, loading: false, error: error.message || 'Storefront settings unavailable' });
      });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

function useProducts(params) {
  const paramKey = JSON.stringify(params || {});
  const query = useMemo(() => {
    const search = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    });
    return search.toString();
  }, [paramKey]);
  const [state, setState] = useState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: true, error: '' });
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const cached = requestVersion === 0 ? productListCache.get(query) : null;
    if (cached && Date.now() - cached.createdAt < PRODUCT_CACHE_TTL_MS) {
      setState(cached.state);
      return () => {
        alive = false;
      };
    }
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/products${query ? `?${query}` : ''}`, { signal: controller.signal })
      .then((data) => {
        if (!alive) return;
        const nextState = normalizeProductListResponse(data);
        if (!nextState.error) productListCache.set(query, { createdAt: Date.now(), state: nextState });
        setState(nextState);
      })
      .catch((err) => {
        if (alive && err.name !== 'AbortError') setState(emptyProductListState(err.message));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [query, requestVersion]);

  return { ...state, retry: () => setRequestVersion((current) => current + 1) };
}

function useRecommendedProducts(user, limit = 6) {
  const [state, setState] = useState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: Boolean(user), error: '' });

  useEffect(() => {
    if (!user) {
      setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: '' });
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/recommendations/for-you?limit=${limit}`, { signal: controller.signal })
      .then((data) => {
        if (alive) setState({ ...normalizeProductListResponse(data), facets: EMPTY_PRODUCT_FACETS });
      })
      .catch((err) => {
        if (alive && err.name !== 'AbortError') setState(emptyProductListState(err.message));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [user, limit]);

  return state;
}

function useSimilarProducts(id, limit = 4) {
  const [state, setState] = useState({ products: [], loading: true, error: '' });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const controller = new AbortController();
    setState({ products: [], loading: true, error: '' });
    api(`/recommendations/similar/${encodeURIComponent(id)}?limit=${limit}`, { signal: controller.signal })
      .then((data) => {
        if (alive) setState({ products: Array.isArray(data?.products) ? data.products : [], loading: false, error: '' });
      })
      .catch((err) => {
        if (alive && err.name !== 'AbortError') setState({ products: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id, limit]);

  return state;
}

function useProduct(id) {
  const [state, setState] = useState({ product: null, loading: true, error: '' });

  useEffect(() => {
    if (!id) {
      setState({ product: null, loading: false, error: '' });
      return undefined;
    }
    let alive = true;
    const controller = new AbortController();
    setState({ product: null, loading: true, error: '' });
    api(`/products/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((data) => {
        if (alive) setState({ product: data.product || null, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive && err.name !== 'AbortError') setState({ product: null, loading: false, error: err.message });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);

  return state;
}

function useWishlistProducts(ids = [], accountId = '') {
  const idKey = useMemo(() => [...new Set((ids || []).map(String).filter(Boolean))].join(','), [ids]);
  const [state, setState] = useState({ products: [], loading: Boolean(idKey), error: '' });
  const [requestVersion, setRequestVersion] = useState(0);
  const syncedAccountRef = useRef('');

  useEffect(() => {
    if (!accountId) syncedAccountRef.current = '';
    const wishlistIds = idKey ? idKey.split(',').filter(Boolean) : [];
    const shouldSyncAccount = Boolean(accountId) && syncedAccountRef.current !== accountId;
    if (wishlistIds.length === 0 && !shouldSyncAccount) {
      setState({ products: [], loading: false, error: '' });
      return undefined;
    }

    let alive = true;
    const controller = new AbortController();
    const savedSnapshots = readWishlistProductSnapshots();
    const cachedProducts = wishlistIds.map((id) => productDetailLocalCache.get(id) || savedSnapshots[id]).filter(Boolean);
    if (!shouldSyncAccount && cachedProducts.length === wishlistIds.length && requestVersion === 0) {
      setState({ products: cachedProducts, loading: false, error: '' });
      return () => {
        alive = false;
      };
    }

    setState((current) => ({ ...current, loading: true, error: '' }));
    const loadLocalProducts = async () => {
      const results = await Promise.allSettled(wishlistIds.map(async (id) => {
        if (requestVersion === 0 && productDetailLocalCache.has(id)) return productDetailLocalCache.get(id);
        const data = await api(`/products/${encodeURIComponent(id)}`, { signal: controller.signal });
        const product = data.product || null;
        if (product) productDetailLocalCache.set(id, product);
        return product;
      }));
      const productsById = new Map();
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) productsById.set(wishlistProductId(result.value), result.value);
      });
      return {
        products: wishlistIds.map((id) => productsById.get(id) || savedSnapshots[id]).filter(Boolean),
        failed: results.filter((result) => result.status === 'rejected').length
      };
    };

    const request = shouldSyncAccount
      ? api('/auth/wishlist/sync', {
        method: 'POST',
        body: JSON.stringify({ productIds: wishlistIds }),
        signal: controller.signal
      }).then((data) => {
        const accountIds = (data.productIds || []).map(String).filter(Boolean);
        const products = data.products || [];
        products.forEach((product) => {
          const productId = wishlistProductId(product);
          if (!productId) return;
          productDetailLocalCache.set(productId, product);
          writeWishlistProductSnapshot(product);
        });
        writeWishlistProductIds(accountIds);
        window.dispatchEvent(new CustomEvent('fitlook:wishlist-change', { detail: { ids: accountIds } }));
        syncedAccountRef.current = accountId;
        return { products, failed: 0, accountSynced: true };
      }).catch(async (accountError) => {
        if (accountError.name === 'AbortError') throw accountError;
        const localResult = await loadLocalProducts();
        return { ...localResult, accountError };
      })
      : loadLocalProducts();

    request
      .then((result) => {
        if (!alive) return;
        const products = result.products || [];
        setState({
          products,
          loading: false,
          error: products.length === 0 && (result.failed || result.accountError)
            ? 'Saved products could not be loaded. Please try again.'
            : ''
        });
      })
      .catch((error) => {
        if (alive && error.name !== 'AbortError') setState({ products: [], loading: false, error: error.message });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [accountId, idKey, requestVersion]);

  return { ...state, retry: () => setRequestVersion((current) => current + 1) };
}

function useTryOnCache(user, products) {
  const [tryOns, setTryOns] = useState({});
  const productIds = useMemo(
    () => [...new Set((products || []).map((product) => product?.id).filter(Boolean))].slice(0, 96).join(','),
    [products]
  );

  useEffect(() => {
    if (!user || !productIds) {
      setTryOns({});
      return;
    }
    let alive = true;
    const controller = new AbortController();
    api(`/tryons?productIds=${encodeURIComponent(productIds)}`, { signal: controller.signal })
      .then((data) => {
        if (!alive) return;
        const saved = Object.fromEntries((data.tryOns || []).map((tryOn) => [tryOn.productId, tryOn]));
        setTryOns((current) => ({ ...current, ...saved }));
      })
      .catch(() => {});
    return () => {
      alive = false;
      controller.abort();
    };
  }, [user, productIds]);

  return [tryOns, setTryOns];
}

function useGenerationHistory(user) {
  const [state, setState] = useState({ items: [], loading: Boolean(user), error: '' });
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    if (!user) {
      setState({ items: [], loading: false, error: '' });
      return undefined;
    }

    let alive = true;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: '' }));

    api('/tryons', { signal: controller.signal })
      .then(async (data) => {
        const tryOns = Array.isArray(data.tryOns) ? data.tryOns : [];
        const productIds = [...new Set(tryOns.map((item) => item.productId).filter(Boolean))].slice(0, 48);
        const productPairs = await Promise.all(productIds.map(async (productId) => {
          try {
            const result = await api(`/products/${encodeURIComponent(productId)}`, { signal: controller.signal });
            return [productId, result.product || null];
          } catch {
            return [productId, null];
          }
        }));
        if (!alive) return;
        const productsById = Object.fromEntries(productPairs);
        const items = tryOns
          .filter((item) => item?.imageUrl)
          .map((item) => ({ ...item, product: productsById[item.productId] || null }));
        setState({ items, loading: false, error: '' });
      })
      .catch((error) => {
        if (alive && error.name !== 'AbortError') setState({ items: [], loading: false, error: 'We couldn’t load your generation history.' });
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [user?.id, requestVersion]);

  return { ...state, retry: () => setRequestVersion((current) => current + 1) };
}

function MobileBottomNav({ user }) {
  const currentPath = normalizePath();
  const ProfileNavIcon = () => <NavProfileAvatar user={user} />;
  const mobileNavLinks = [
    { label: 'Home', href: '/home', Icon: HomeIcon },
    { label: 'Explore', href: '/categories', Icon: GridIcon },
    { label: 'Try-On', href: '/custom-try-on', Icon: TryOnIcon },
    { label: 'AI Stylist', href: user ? '/style-bot' : '/signup', Icon: SparkleLineIcon },
    { label: 'Wardrobe', href: '/closet', Icon: ClosetIcon },
    { label: 'Profile', href: user ? '/profile' : '/signup', Icon: ProfileNavIcon }
  ];
  const isActiveLink = (href, index) => {
    const hrefPath = href.split('?')[0] || '/';
    return currentPath === hrefPath || (currentPath === '/' && index === 0);
  };

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
      {mobileNavLinks.map(({ label, href, Icon }, index) => {
        const active = isActiveLink(href, index);
        return <a className={active ? 'active' : ''} href={href} aria-current={active ? 'page' : undefined} key={label}><Icon /><span>{label}</span></a>;
      })}
    </nav>
  );
}

function NavProfileAvatar({ user }) {
  const imageUrl = protectedMediaUrl(user?.bodyPhotoUrl || user?.bodyPhotoOriginalUrl || '');
  return (
    <span className={`nav-profile-avatar ${imageUrl ? 'has-image' : ''}`}>
      {imageUrl ? <img src={imageUrl} alt="" /> : <UserIcon />}
    </span>
  );
}

function Header({ user, setUser, authChecked = true }) {
  const tokenLabel = user ? `${user.tokens} Tokens` : 'Tokens';
  const [menuOpen, setMenuOpen] = useState(false);
  const [wishlistCount, setWishlistCount] = useState(() => user?.wishlistCount || readWishlistProductIds().length);
  const [desktopSearch, setDesktopSearch] = useState(currentSearchValue);
  const headerRef = useRef(null);
  const desktopSearchRef = useRef(null);
  const [recentSearches, setRecentSearches] = useState(readRecentSearches);
  const currentPath = normalizePath();
  const currentParams = new URLSearchParams(window.location.search);
  const searchValueFromUrl = currentSearchValue();
  const logout = () => {
    clearAuthToken();
    setUser(null);
    setMenuOpen(false);
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const navLinks = [
    ['Home', '/home'],
    ['Explore', '/categories'],
    ['Wardrobe', '/closet'],
    ['Custom Try On', '/custom-try-on'],
    ['AI Stylist', user ? '/style-bot' : '/signup'],
    ['Download', '/download'],
    ['About', '/about']
  ];
  const exactQueryActiveHref = navLinks.find(([, href]) => {
    if (!href.includes('?')) return false;
    const [hrefPath, hrefQuery] = href.split('?');
    if (currentPath !== hrefPath) return false;
    const hrefParams = new URLSearchParams(hrefQuery);
    return [...hrefParams.entries()].every(([key, value]) => currentParams.get(key) === value);
  })?.[1];
  const isActiveLink = (href, index) => {
    if (exactQueryActiveHref) return href === exactQueryActiveHref;
    const hrefPath = href.split('?')[0] || '/';
    return currentPath === hrefPath || (currentPath === '/' && index === 0);
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousOverscroll = document.documentElement.style.overscrollBehavior;
    const previouslyFocused = document.activeElement;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'contain';
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const closeOnOutsidePress = (event) => {
      if (!headerRef.current?.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousOverscroll;
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      // Return focus to whatever opened the drawer, so keyboard users are not
      // dropped back at the top of the document.
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [menuOpen]);

  useEffect(() => {
    setDesktopSearch(searchValueFromUrl);
  }, [currentPath, searchValueFromUrl]);

  useEffect(() => {
    setWishlistCount(user?.wishlistCount || readWishlistProductIds().length);
  }, [user?.wishlistCount]);

  useEffect(() => {
    const syncWishlist = (event) => {
      const ids = event.detail?.ids;
      setWishlistCount(Array.isArray(ids) ? ids.length : readWishlistProductIds().length);
    };
    window.addEventListener('fitlook:wishlist-change', syncWishlist);
    return () => {
      window.removeEventListener('fitlook:wishlist-change', syncWishlist);
    };
  }, []);

  useEffect(() => {
    const focusSearch = () => {
      desktopSearchRef.current?.focus();
    };
    const onKeyDown = (event) => {
      const element = event.target;
      const typing = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusSearch();
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        focusSearch();
      }
      if (event.key === 'Escape' && element === desktopSearchRef.current) {
        if (desktopSearch) setDesktopSearch('');
        else element.blur();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [desktopSearch]);

  const rememberSearch = (event) => {
    const query = normalizeSearchQuery(new FormData(event.currentTarget).get('q'));
    const field = event.currentTarget.elements.q;
    if (field) field.value = query;
    if (!query) {
      event.preventDefault();
      setDesktopSearch('');
      desktopSearchRef.current?.focus();
      return;
    }
    setRecentSearches(saveRecentSearch(query));
    setMenuOpen(false);
  };
  const clearSearch = () => {
    setDesktopSearch('');
    desktopSearchRef.current?.focus();
  };

  return (
    <>
      {currentPath !== '/wishlist' && currentPath !== '/tokens' && currentPath !== '/tokens/top-up' && currentPath !== '/profile' && currentPath !== '/generation-history' && <div className="announcement">
        <span>✨</span>
        <span>{user ? <>You have {user.tokens} tokens ready for AI try-on</> : <>Get free tokens on sign up to try AI try-on</>}</span>
        <span>✨</span>
      </div>}
      <header className="site-header" ref={headerRef}>
        <div className="wrap header-inner">
          <div className="header-left">
            <a className="brand" href="/home" aria-label="Lookmefy home"><BrandLogo /></a>
            <nav className="nav" aria-label="Primary navigation">
              {navLinks.map(([label, href], index) => {
                const active = isActiveLink(href, index);
                return <a className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} href={href} key={label}>{label}</a>;
              })}
            </nav>
          </div>
          <div className="header-search" role="search">
            <form className="search-form" action="/categories" onSubmit={rememberSearch}>
              <button className="search-submit" type="submit" aria-label="Search"><SearchIcon /></button>
              <input ref={desktopSearchRef} name="q" type="search" list="fitlook-recent-searches" placeholder="Search curated collections..." value={desktopSearch} onChange={(event) => setDesktopSearch(event.currentTarget.value)} aria-label="Search products" aria-keyshortcuts="Control+K Meta+K" title="Search (Ctrl+K)" />
              {desktopSearch && <button className="search-clear" type="button" aria-label="Clear search" onClick={clearSearch}><CloseIcon /></button>}
            </form>
          </div>
          <div className="header-actions">
            <a className="icon-button mobile-search-trigger" href="/search" aria-label="Open search"><SearchIcon /></a>
            <a className={`header-credit-button ${!authChecked ? 'auth-pending' : ''}`} href="/tokens" aria-label={user ? `Buy credits. ${tokenLabel} available` : 'Buy credits'}><SparkleLineIcon /><span>Credits</span>{user && <strong>{user.tokens}</strong>}{!authChecked && <strong className="header-auth-skeleton" aria-hidden="true" />}</a>
            <a className="icon-button header-count-button" href="/wishlist" aria-label={`${wishlistCount} wishlist items`}><HeartIcon />{wishlistCount > 0 && <strong>{wishlistCount}</strong>}</a>
            {!authChecked ? <span className="icon-button header-auth-loading" role="status" aria-label="Checking account"><UserIcon /></span> : user ? <a className="icon-button" href="/profile" aria-label="Profile"><NavProfileAvatar user={user} /></a> : <a className="icon-button" href="/signup" aria-label="Account"><UserIcon /></a>}
            {user && <button className="text-button" onClick={logout}>Log out</button>}
            <button className="icon-button menu-toggle" type="button" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-controls="mobile-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>
        <button className={`mobile-menu-overlay ${menuOpen ? 'open' : ''}`} type="button" aria-hidden="true" tabIndex="-1" onClick={() => setMenuOpen(false)} />
        {/* The closed drawer is not display:none — a later rule slides it off-canvas
            with translateX while leaving it visible, so its 10 controls stayed in
            the tab order and were announced by screen readers. `inert` removes it
            from both while preserving the slide animation. */}
        <div className={`mobile-menu ${menuOpen ? 'open' : ''}`} id="mobile-navigation" role="dialog" aria-modal={menuOpen ? 'true' : undefined} aria-label="Mobile navigation" inert={!menuOpen}>
          <div className="wrap mobile-menu-inner">
            {navLinks.map(([label, href], index) => {
              const active = isActiveLink(href, index);
              return <a className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} href={href} key={label} onClick={() => setMenuOpen(false)}>{label}</a>;
            })}
            <a href="/tokens" onClick={() => setMenuOpen(false)}>Credits{user ? ` (${user.tokens})` : ''}</a>
            {!authChecked ? <span className="mobile-menu-auth-loading" role="status">Checking account...</span> : <a href={user ? '/profile' : '/signup'} onClick={() => setMenuOpen(false)}>{user ? 'Profile' : 'Account'}</a>}
            {user && <button type="button" onClick={logout}>Log out</button>}
          </div>
        </div>
      </header>
      <datalist id="fitlook-recent-searches">
        {recentSearches.map((search) => <option value={search} key={search} />)}
      </datalist>
    </>
  );
}

function SearchLandingPage() {
  const searchInputRef = useRef(null);
  const [query, setQuery] = useState(currentSearchValue);
  const [recentSearches, setRecentSearches] = useState(readRecentSearches);
  const quickSearches = popularSearchTerms;
  const featuredCategories = featuredSearchCategories;

  useEffect(() => {
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const rememberSearch = (event) => {
    const nextQuery = normalizeSearchQuery(new FormData(event.currentTarget).get('q'));
    const field = event.currentTarget.elements.q;
    if (field) field.value = nextQuery;
    if (!nextQuery) {
      event.preventDefault();
      setQuery('');
      searchInputRef.current?.focus();
      return;
    }
    setRecentSearches(saveRecentSearch(nextQuery));
  };

  return (
    <main className="mobile-search-page">
      <section className="mobile-search-panel" aria-labelledby="mobile-search-title">
        <p className="mobile-search-kicker">Find your edit</p>
        <h1 id="mobile-search-title">Search Lookmefy</h1>
        <form className="mobile-search-page-form" action="/categories" role="search" onSubmit={rememberSearch}>
          <SearchIcon />
          <input ref={searchInputRef} name="q" type="search" list="fitlook-recent-searches" placeholder="Search products..." value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }} aria-label="Search products" />
          {query && <button className="mobile-search-clear" type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}><CloseIcon /></button>}
          <button type="submit">Search</button>
        </form>
        {recentSearches.length > 0 && (
          <div className="mobile-search-block">
            <div className="mobile-search-block-head">
              <h2>Recent searches</h2>
              <button type="button" onClick={() => { localStorage.removeItem('fitlook_recent_searches'); setRecentSearches([]); }}>Clear</button>
            </div>
            <div className="mobile-search-chip-row">
              {recentSearches.map((search) => <a href={`/categories?q=${encodeURIComponent(search)}`} key={search}>{search}</a>)}
            </div>
          </div>
        )}
        <div className="mobile-search-block">
          <h2>Popular now</h2>
          <div className="mobile-search-chip-row">
            {quickSearches.map((search) => <a href={`/categories?q=${encodeURIComponent(search)}`} key={search}>{search}</a>)}
          </div>
        </div>
        <div className="mobile-search-block">
          <h2>Browse categories</h2>
          <div className="mobile-search-category-grid">
            {featuredCategories.map(([label, image, value]) => (
              <a href={`/categories/${encodeURIComponent(categorySlug(value))}`} key={value}>
                <OptimizedImage src={asset(categoryIconVisuals[categoryVisualKey(value)]?.image || image)} alt="" />
                <span>{label}</span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function storeLinkItems(context = 'page') {
  return [
    {
      key: 'app_store',
      label: 'Download on the App Store',
      helper: 'Download on the',
      title: 'App Store',
      href: APP_STORE_URL,
      icon: 'apple',
      platform: 'apple',
      context
    },
    {
      key: 'google_play',
      label: 'Get it on Google Play',
      helper: 'Get it on',
      title: 'Google Play',
      href: PLAY_STORE_URL,
      icon: 'play',
      platform: 'google_play',
      context
    }
  ];
}

function StoreAction({ item, className = 'download-store-action' }) {
  const analyticsEvent = item.platform === 'apple' ? 'app_store_click' : 'google_play_click';
  const content = (
    <>
      <StoreLogo name={item.icon} />
      <span>
        <small>{item.helper}</small>
        <strong>{item.title}</strong>
      </span>
    </>
  );
  if (!item.href) {
    return (
      <button className={`${className} is-disabled`} type="button" disabled aria-label={`${item.label} unavailable until the store URL is configured`}>
        {content}
      </button>
    );
  }
  return (
    <a
      className={className}
      href={item.href}
      target="_blank"
      rel="noreferrer"
      aria-label={item.label}
      onClick={() => trackClientEvent(analyticsEvent, { platform: item.platform, context: item.context })}
    >
      {content}
    </a>
  );
}

function StoreActions({ context, className = 'download-store-actions', itemClassName = 'download-store-action' }) {
  return (
    <div className={className}>
      {storeLinkItems(context).map((item) => <StoreAction item={item} className={itemClassName} key={item.key} />)}
    </div>
  );
}

function Footer() {
  const socialLinks = [
    { label: 'Instagram', href: 'https://instagram.com/', icon: 'instagram' },
    { label: 'X', href: 'https://x.com/', icon: 'x' }
  ];

  return (
    <footer className="wishlist-compact-footer">
      <div className="wrap wishlist-compact-footer-inner">
        <div className="wishlist-compact-footer-grid">
          <div className="wishlist-compact-brand"><a href="/" aria-label="Lookmefy home"><BrandLogo /></a><p>Discover personal style through curated fashion and AI-powered try-on.</p><div className="wishlist-compact-social" aria-label="Social links">{socialLinks.map((item) => <a href={item.href} target="_blank" rel="noreferrer" aria-label={item.label} title={item.label} key={item.label}><SocialLogo name={item.icon} /></a>)}</div></div>
          <div><h2>Shop</h2><a href="/categories">New in</a><a href="/categories?gender=women">Women</a><a href="/categories?gender=men">Men</a><a href="/categories?discounted=true">Sale</a></div>
          <div><h2>Help</h2><a href="/support">Support</a><a href="/returns">Returns</a><a href="/contact">Contact us</a><a href="/shipping">Shipping</a></div>
          <div><h2><a className="footer-heading-link" href="/download">Download our App</a></h2><p>Get the Lookmefy app for your daily fashion edit.</p><StoreActions context="footer" className="wishlist-app-links" itemClassName="wishlist-app-link" /></div>
        </div>
        <div className="wishlist-compact-footer-bottom"><span>© 2026 Lookmefy. Curated by intelligence.</span><div><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/copyright">Copyright</a></div></div>
      </div>
    </footer>
  );
}

function BrandLogo() {
  return (
    <span className="brand-logo-lockup" aria-hidden="true">
      <svg className="brand-logo-mark-art" viewBox="440 186 359 322" preserveAspectRatio="xMidYMid meet" focusable="false">
        <g transform="translate(0,970) scale(0.1,-0.1)" fill="currentColor" stroke="none">
          <path d="M6445 7823 c-95 -34 -161 -103 -190 -198 -17 -58 -13 -81 17 -91 25
-8 58 25 58 58 0 35 40 98 80 127 83 60 181 62 271 5 45 -28 71 -66 89 -129
28 -99 -46 -219 -158 -259 -77 -27 -86 -45 -92 -195 l-5 -126 -53 -7 c-66 -10
-176 -60 -273 -125 -227 -152 -615 -384 -797 -478 -162 -82 -272 -190 -272
-266 0 -18 13 -9 74 49 180 171 377 201 463 70 l28 -42 3 -615 c1 -338 0 -621
-2 -628 -4 -8 -35 2 -108 36 -202 95 -380 140 -598 150 l-135 6 0 1100 0 1100
22 47 c22 49 63 82 115 93 16 4 26 11 22 16 -6 10 -577 13 -587 2 -4 -3 16
-16 45 -27 61 -25 91 -63 107 -137 15 -70 15 -1998 0 -2085 -13 -77 -60 -137
-120 -155 -67 -21 -46 -32 44 -23 141 15 383 10 470 -9 133 -29 283 -93 516
-220 383 -208 478 -240 711 -241 144 -1 172 3 265 42 94 38 113 72 23 41 -110
-38 -277 -17 -432 54 -94 44 -279 147 -288 161 -12 17 -10 1136 2 1136 10 0
105 -141 353 -525 60 -93 153 -236 206 -317 53 -81 117 -181 144 -223 26 -41
54 -75 61 -75 7 0 79 109 159 243 137 229 354 588 482 797 32 52 64 102 71
110 12 12 14 -91 14 -655 0 -755 3 -721 -75 -760 l-40 -20 112 -3 c62 -1 164
-1 225 0 l113 3 -40 20 c-79 39 -75 -4 -75 831 0 408 3 756 6 773 4 17 23 50
44 74 36 40 40 42 96 42 45 0 73 -7 118 -30 72 -36 158 -119 191 -185 18 -35
31 -50 45 -50 48 0 4 120 -72 199 -51 52 -104 87 -253 166 -161 85 -383 212
-609 348 -229 137 -281 163 -368 181 l-63 13 0 118 c0 95 3 119 15 125 8 5 34
16 58 26 59 24 119 85 149 151 22 48 25 65 21 133 -7 115 -55 187 -162 242
-57 30 -174 35 -241 11z m240 -909 c28 -10 142 -72 255 -139 113 -66 296 -172
408 -234 111 -62 202 -116 202 -120 0 -4 -27 -15 -60 -25 -33 -10 -88 -35
-121 -55 -61 -37 -64 -40 -189 -252 -131 -222 -513 -853 -544 -901 -10 -16
-21 -28 -25 -28 -3 0 -55 77 -116 170 -60 94 -144 223 -186 288 -42 64 -158
245 -259 401 -207 320 -187 300 -359 343 -47 12 -92 23 -100 25 -20 5 -9 13
104 78 117 67 433 264 557 347 111 75 172 106 228 118 58 12 142 5 205 -16z" />
        </g>
      </svg>
      <span className="brand-logo-divider" aria-hidden="true" />
      <svg className="brand-logo-wordmark-art" viewBox="257 526 676 138" preserveAspectRatio="xMidYMid meet" focusable="false">
        <g transform="translate(0,970) scale(0.1,-0.1)" fill="currentColor" stroke="none">
          <path d="M5360 4413 c-35 -13 -66 -26 -68 -28 -2 -2 6 -13 17 -24 21 -21 21
-28 21 -476 0 -443 -4 -505 -32 -505 -4 0 -8 -4 -8 -10 0 -6 40 -10 100 -10
55 0 100 2 100 5 0 3 -9 14 -20 25 -18 18 -20 33 -20 145 l0 125 32 30 c17 17
36 29 42 27 5 -2 69 -79 142 -171 72 -93 138 -173 147 -178 9 -5 52 -8 94 -6
l78 3 -37 22 c-20 12 -80 76 -134 145 -54 67 -122 153 -152 190 -30 37 -52 72
-50 76 5 14 177 159 227 193 25 16 51 29 58 29 8 0 12 4 8 9 -7 12 -152 13
-160 1 -3 -5 -1 -11 5 -15 5 -3 10 -17 10 -30 0 -18 -33 -52 -139 -145 -77
-66 -143 -125 -146 -130 -21 -34 -25 20 -27 357 -2 234 -7 367 -13 368 -5 2
-39 -8 -75 -22z" />
          <path d="M8545 4421 c-78 -20 -141 -78 -176 -159 -11 -26 -22 -81 -26 -133
l-6 -89 -33 0 c-46 0 -52 -18 -7 -22 l38 -3 0 -302 0 -301 -24 -26 -24 -26
108 0 108 0 -24 26 -24 26 0 301 0 302 73 3 c93 4 85 22 -10 22 l-71 0 5 128
c4 105 9 134 26 169 49 96 158 97 210 4 13 -23 27 -41 31 -41 13 0 51 46 51
62 0 9 -16 26 -36 38 -39 24 -136 35 -189 21z" />
          <path d="M2638 4402 l-66 -3 24 -24 24 -24 0 -466 0 -466 -25 -25 c-14 -14
-25 -27 -25 -29 0 -3 155 -5 345 -5 l344 0 26 85 c15 47 25 90 23 96 -2 6 -18
-10 -35 -35 -67 -95 -144 -119 -368 -114 l-150 3 0 477 0 476 24 26 c14 14 23
26 20 27 -18 3 -106 3 -161 1z" />
          <path d="M3730 4041 c-104 -21 -210 -104 -257 -200 -24 -49 -28 -68 -28 -146
0 -83 3 -95 35 -153 39 -73 92 -124 170 -161 50 -23 66 -26 170 -26 109 0 118
2 175 32 72 37 137 105 171 176 34 74 34 200 0 273 -73 157 -253 242 -436 205z
m186 -34 c114 -59 182 -225 156 -380 -24 -141 -86 -223 -191 -254 -45 -13 -64
-14 -105 -4 -137 32 -216 157 -216 342 0 202 108 327 271 315 31 -2 69 -11 85
-19z" />
          <path d="M4649 4041 c-105 -22 -206 -103 -259 -207 -21 -41 -25 -63 -25 -134
0 -76 4 -93 33 -152 37 -76 88 -124 172 -166 50 -25 65 -27 170 -27 110 0 118
1 175 32 113 59 187 164 201 285 5 43 2 72 -16 129 -19 63 -30 81 -83 134 -45
45 -78 68 -122 85 -64 24 -183 35 -246 21z m199 -40 c22 -11 57 -41 76 -67 53
-70 71 -132 70 -249 0 -88 -3 -108 -28 -163 -36 -77 -87 -125 -160 -148 -49
-16 -63 -16 -109 -5 -145 36 -225 171 -215 366 8 155 69 247 188 286 40 13
133 3 178 -20z" />
          <path d="M6427 4033 c-27 -9 -70 -36 -97 -60 -26 -24 -51 -43 -54 -43 -3 0 -6
25 -6 55 0 30 -3 55 -8 55 -4 0 -38 -11 -76 -25 -38 -14 -71 -25 -74 -25 -3 0
5 -12 19 -26 l24 -26 0 -263 0 -263 -24 -26 -24 -26 108 0 108 0 -24 26 c-24
25 -24 28 -27 246 -2 155 0 230 9 250 17 41 95 106 142 119 89 24 171 -14 208
-96 16 -35 19 -68 19 -266 0 -212 -1 -227 -20 -247 -11 -12 -20 -24 -20 -27 0
-3 45 -5 100 -5 l101 0 -22 29 c-19 26 -21 44 -26 240 -5 202 -4 213 17 256
61 126 228 163 317 69 46 -49 55 -107 51 -342 -3 -174 -5 -202 -20 -219 -10
-11 -18 -23 -18 -26 0 -4 46 -7 102 -7 l101 0 -24 26 c-24 25 -24 28 -29 267
l-5 242 -28 47 c-18 31 -44 57 -75 75 -41 25 -57 28 -132 28 -76 0 -91 -3
-139 -30 -29 -16 -69 -48 -88 -70 -33 -37 -36 -39 -47 -21 -67 111 -189 152
-319 109z" />
          <path d="M7734 4041 c-92 -24 -187 -101 -236 -192 -20 -38 -23 -58 -23 -149 0
-87 4 -113 22 -152 30 -66 96 -133 162 -165 50 -25 67 -28 161 -28 94 0 110 3
155 27 49 25 152 124 142 135 -3 3 -22 -12 -43 -32 -53 -54 -115 -78 -199 -79
-96 -1 -153 22 -210 86 -50 55 -89 159 -83 220 l3 33 265 5 265 5 -1 50 c-3
132 -122 235 -279 241 -38 2 -84 0 -101 -5z m138 -21 c73 -21 133 -118 126
-205 l-3 -40 -195 -2 c-107 -2 -201 1 -208 5 -10 7 -8 23 8 76 42 134 149 200
272 166z" />
          <path d="M8688 4034 c-3 -3 5 -16 18 -29 22 -23 54 -84 108 -212 13 -32 42
-96 64 -143 21 -47 60 -133 86 -191 l47 -106 -35 -76 c-42 -89 -85 -143 -123
-150 -29 -5 -71 11 -92 37 -20 24 -36 19 -56 -18 -18 -34 -18 -36 -1 -55 28
-30 87 -36 138 -13 76 34 108 83 198 297 23 55 48 114 56 130 7 17 54 129 104
250 50 121 100 232 110 247 11 15 20 30 20 33 0 3 -22 5 -49 5 -50 0 -74 -13
-46 -24 26 -10 17 -76 -24 -176 -22 -52 -62 -149 -89 -215 -28 -66 -54 -119
-58 -118 -13 2 -204 446 -204 473 0 10 7 23 15 30 8 7 12 16 9 21 -6 10 -187
13 -196 3z" />
        </g>
      </svg>
    </span>
  );
}

function SocialLogo({ name }) {
  if (name === 'instagram') {
    return (
      <svg className="brand-logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="5" />
        <circle cx="12" cy="12" r="3.7" />
        <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (name === 'tiktok') {
    return (
      <svg className="brand-logo-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M14.8 3.5c.3 2.3 1.6 3.8 3.9 4.2v3.2a7.1 7.1 0 0 1-3.8-1.2v5.8c0 3.1-2 5.1-5 5.1-2.9 0-5-1.9-5-4.6 0-2.9 2.3-4.8 5.6-4.5v3.2c-1.4-.3-2.3.3-2.3 1.3 0 .9.7 1.5 1.7 1.5 1.1 0 1.8-.7 1.8-2.1V3.5h3.1Z" />
      </svg>
    );
  }
  return (
    <svg className="brand-logo-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15.1 10.6 21.2 3.5h-2.9l-4.5 5.2-3.6-5.2H3.1l6.4 9.1-6.7 7.9h2.9l5.1-5.9 4.1 5.9h7.1l-6.9-9.9Zm-2.1 2.5-1.3-1.8L7.8 5.7h1.4l3.2 4.6 1.3 1.8 4.2 6.1h-1.4L13 13.1Z" />
    </svg>
  );
}

function StoreLogo({ name }) {
  if (name === 'apple') {
    return (
      <svg className="store-logo-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.4 12.7c0-1.9 1.5-2.9 1.6-3-1-1.4-2.4-1.6-2.9-1.6-1.2-.1-2.4.7-3 .7s-1.6-.7-2.7-.7c-1.4 0-2.8.8-3.5 2.1-1.5 2.5-.4 6.3 1.1 8.3.7 1 1.5 2.1 2.6 2.1 1 0 1.5-.7 2.7-.7 1.3 0 1.6.7 2.8.7 1.1 0 1.9-1 2.6-2 .8-1.1 1.1-2.3 1.1-2.3-.1 0-2.4-.9-2.4-3.6Z" />
        <path d="M15.3 6.8c.6-.7 1-1.6.9-2.5-.8 0-1.8.5-2.4 1.2-.5.6-1 1.5-.9 2.4.9.1 1.8-.4 2.4-1.1Z" />
      </svg>
    );
  }
  return (
    <svg className="store-logo-icon play-logo-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#34a853" d="M4.5 3.6c-.3.3-.5.8-.5 1.4v14c0 .6.2 1.1.5 1.4l8.1-8.4-8.1-8.4Z" />
      <path fill="#fbbc04" d="m15.3 9.2-2.7 2.8 2.7 2.8 3.4-1.9c1.1-.6 1.1-1.9 0-2.5l-3.4-1.2Z" />
      <path fill="#4285f4" d="m4.5 3.6 8.1 8.4 2.7-2.8L6.7 4.3c-.8-.5-1.6-.7-2.2-.7Z" />
      <path fill="#ea4335" d="m4.5 20.4c.6.1 1.4-.2 2.2-.7l8.6-4.9-2.7-2.8-8.1 8.4Z" />
    </svg>
  );
}

function Hero({ compact = false }) {
  const slide = {
    kicker: 'New Collection',
    title: <>Summer<br /><em>Essentials</em></>,
    copy: 'Drop now live',
    cta: 'Shop Now',
    href: '/categories',
    image: compact ? 'hero2.png' : 'hero1.png'
  };

  return (
    <section className="hero">
      <div className="wrap">
        <div className={compact ? 'hero-panel compact' : 'hero-panel'}>
          <OptimizedImage className="hero-bg" src={asset(slide.image)} alt="" eager />
          <div className="hero-card">
            <span className="hero-kicker">{slide.kicker}</span>
            <h1 className="hero-title">{slide.title}</h1>
            <p className="hero-copy">{slide.copy}</p>
            <a className="hero-cta" href={slide.href}>{slide.cta} <span>→</span></a>
          </div>
          {!compact && (
            <div className="hero-offer-badge" aria-label="Up to 50% off">
              <span>Up to</span>
              <strong>50%</strong>
              <small>Off</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AtelierIcon({ name }) {
  const paths = {
    clock: <><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></>,
    sparkle: <><path d="M12 3l2.286 6.857L21 12l-6.714 2.143L12 21l-2.286-6.857L3 12l6.714-2.143L12 3Z" /><path d="M5 3v4M3 5h4" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2 2.4 3 5.4 3 9s-1 6.6-3 9c-2-2.4-3-5.4-3-9s1-6.6 3-9Z" /></>,
    arrowLeft: <path d="m15 19-7-7 7-7" />,
    arrowRight: <path d="m9 5 7 7-7 7" />,
    twitter: <path d="M4 5.5c3 2 5.2 3.2 7.1 3.7C11 6.5 12.1 5 13.8 5c1.2 0 2.1.5 2.7 1.4.8-.2 1.5-.5 2.2-.9-.3.9-.9 1.6-1.7 2 .8-.1 1.5-.3 2.2-.6-.5.8-1.1 1.5-1.8 2.1.1 4.8-3.3 10.2-9.7 10.2-1.9 0-3.7-.6-5.2-1.5 1.8.2 3.5-.3 4.8-1.3-1.5 0-2.7-1-3.1-2.4.5.1 1 .1 1.5-.1-1.6-.3-2.7-1.7-2.7-3.3.4.2.9.4 1.4.4C2.9 8.9 2.6 7 3.5 5.5Z" />,
    instagram: <><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.3" cy="6.7" r=".7" fill="currentColor" stroke="none" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="1" /><path d="m3 7 9 6 9-6" /></>,
    shield: <path d="M12 3 4.5 6v5.5c0 4.7 3 8.2 7.5 9.5 4.5-1.3 7.5-4.8 7.5-9.5V6L12 3Z" />,
    support: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>
  };
  return <svg className="atelier-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const atelierHeroSlides = [
  {
    id: 'ai-try-on',
    image: 'home-hero-editorial.png',
    position: '57% 18%',
    kicker: 'AI Fashion Try-On',
    title: <>See Yourself<br />In Every Look</>,
    copy: 'Experience the future of fashion with AI-powered virtual try-on. Upload, try, and find your perfect style.',
    primaryLabel: 'Start AI Try-On',
    primaryHref: '/custom-try-on',
    secondaryLabel: 'Explore Collections',
    secondaryHref: '/categories'
  },
  {
    id: 'women-edit',
    image: 'category-women-hero.png',
    position: '64% 18%',
    kicker: 'Women’s Edit',
    title: <>Light Layers<br />Sharp Intent</>,
    copy: 'Discover clean tailoring, elevated essentials, and pieces selected for everyday confidence.',
    primaryLabel: 'Shop Women',
    primaryHref: '/categories?gender=women',
    secondaryLabel: 'Try A Look',
    secondaryHref: '/custom-try-on'
  },
  {
    id: 'men-edit',
    image: 'category-men-hero.png',
    position: '65% 18%',
    kicker: 'Men’s Edit',
    title: <>Modern Ease<br />Daily Style</>,
    copy: 'Build refined outfits from shirts, shoes, sunglasses, caps, and essentials already in the live catalog.',
    primaryLabel: 'Shop Men',
    primaryHref: '/categories?gender=men',
    secondaryLabel: 'Open Wardrobe',
    secondaryHref: '/closet'
  }
];

function AtelierProductRailCard({ product, demoEcommerceMode = false }) {
  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100) : 0;
  const rating = Number(product.rating || 0);
  const ratingCount = Number(product.ratingCount || product.reviewsCount || product.reviewCount || 0);
  const badge = displayProductBadge(product);

  return (
    <article className="atelier-product">
      <a className="atelier-product-link" href={`/product/${encodeURIComponent(product.id)}`} aria-label={`Open ${product.name}`}>
        <span className="atelier-product-image">
          {(badge || discount > 0) && <span className="atelier-best-seller">{badge || `${discount}% off`}</span>}
          <OptimizedImage src={product.imageUrl} alt={product.name} highResolution={false} />
        </span>
        <span className="atelier-product-category">{displayCategory(product)}</span>
        <h3>{product.name}</h3>
        <span className="atelier-price">
          <strong>{formatMoney(product.price || 0, product.currency)}</strong>
          {hasDiscount && <del>{formatMoney(product.compareAtPrice, product.currency)}</del>}
        </span>
        {(!demoEcommerceMode && rating > 0 || product.tryOnAvailable || product.aiTryOnAvailable) && (
          <span className="atelier-product-meta">
            {!demoEcommerceMode && rating > 0 && <span>★ {rating.toFixed(1)}{ratingCount > 0 ? ` (${ratingCount})` : ''}</span>}
            {(product.tryOnAvailable || product.aiTryOnAvailable) && <span>AI Try-On</span>}
          </span>
        )}
      </a>
      <WishlistHeartButton product={product} className="card-wishlist-heart" />
    </article>
  );
}

function AtelierCategoryProductCard({ product }) {
  return (
    <article className="atelier-category-product">
      <a href={`/product/${encodeURIComponent(product.id)}`}>
        <div className="atelier-category-product-image">
          <OptimizedImage src={product.imageUrl} alt={product.name} highResolution={false} />
        </div>
        <span className="atelier-category-product-brand">{displayBrand(product)}</span>
        <h3>{product.name}</h3>
        <strong>{formatMoney(product.price || 0, product.currency)}</strong>
      </a>
      <WishlistHeartButton product={product} className="card-wishlist-heart" />
    </article>
  );
}

function AtelierProductStrip({ title, railId, label, products, viewHref = '/categories', viewLabel = 'View more', railRef, onScroll, onKeyDown, demoEcommerceMode = false }) {
  if (!products.length) return null;
  return (
    <section className="atelier-arrivals atelier-product-strip">
      <div className="atelier-wide">
        <div className="atelier-section-heading">
          <h2>{title}</h2>
          <div className="atelier-product-arrows">
            <button type="button" aria-label={`Previous ${label}`} aria-controls={railId} onClick={() => onScroll(railRef, -1)}><AtelierIcon name="arrowLeft" /></button>
            <button type="button" aria-label={`Next ${label}`} aria-controls={railId} onClick={() => onScroll(railRef, 1)}><AtelierIcon name="arrowRight" /></button>
          </div>
        </div>
        <div className="atelier-product-grid atelier-arrivals-rail" id={railId} ref={railRef} tabIndex="0" aria-label={label} onKeyDown={(event) => onKeyDown(railRef, event)}>
          {products.map((product) => <AtelierProductRailCard product={product} demoEcommerceMode={demoEcommerceMode} key={product.id} />)}
          <a className="atelier-arrivals-more" href={viewHref}><span>{label}</span><strong>{viewLabel}</strong><small>Explore the full edit <b>→</b></small></a>
        </div>
      </div>
    </section>
  );
}

function productDiscountPercent(product) {
  const price = Number(product?.price || 0);
  const compareAtPrice = Number(product?.compareAtPrice || 0);
  if (!price || !compareAtPrice || compareAtPrice <= price) return 0;
  return Math.round(((compareAtPrice - price) / compareAtPrice) * 100);
}

function productMetric(product, keys = []) {
  return keys.reduce((best, key) => Math.max(best, Number(product?.[key] || 0)), 0);
}

function uniqueProducts(products = []) {
  const seen = new Set();
  return products.filter((product) => {
    if (!product?.id || !product?.imageUrl || seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function productImageKey(productOrImage) {
  const image = typeof productOrImage === 'string' ? productOrImage : productOrImage?.imageUrl;
  return String(image || '').trim().split('?')[0].toLowerCase();
}

function pickCardProduct(productPools = [], usedImageKeys = new Set(), matcher = () => true) {
  const pools = Array.isArray(productPools[0]) ? productPools : [productPools];
  const candidates = uniqueProducts(pools.flat().filter(Boolean));
  const product = candidates.find((candidate) => {
    const key = productImageKey(candidate);
    return key && !usedImageKeys.has(key) && matcher(candidate);
  });
  if (product) usedImageKeys.add(productImageKey(product));
  return product || null;
}

function productMatchesAnyCategory(product, words = []) {
  const text = [product?.category, product?.name, product?.tags?.join?.(' ') || product?.tags]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.some((word) => text.includes(word));
}

function stableExploreProducts(products = []) {
  return [...products]
    .sort((a, b) => String(a.id || a.name || '').localeCompare(String(b.id || b.name || '')))
    .sort((a, b) => ((String(a.id || '').charCodeAt(0) || 0) % 7) - ((String(b.id || '').charCodeAt(0) || 0) % 7));
}

function fillProductRailProducts(products = [], fallbackProducts = [], minimum = 8) {
  const primary = uniqueProducts(products);
  if (primary.length >= minimum) return primary;
  const seen = new Set(primary.map((product) => product.id));
  const fillers = stableExploreProducts(fallbackProducts).filter((product) => product?.id && product?.imageUrl && !seen.has(product.id));
  return uniqueProducts([...primary, ...fillers]).slice(0, minimum);
}

function AtelierCommerceStrip({ id, title, subtitle, products, viewHref = '/categories', demoEcommerceMode = false }) {
  const railRef = useRef(null);
  const isMobileRail = useMediaQuery('(max-width: 760px)');
  const visibleProducts = uniqueProducts(products).slice(0, isMobileRail ? 8 : 18);
  if (!visibleProducts.length) return null;

  const scrollRail = (direction) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(rail.clientWidth * .86, 320), behavior: 'smooth' });
  };

  const handleKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    scrollRail(event.key === 'ArrowRight' ? 1 : -1);
  };

  return (
    <section className="atelier-arrivals atelier-product-strip atelier-commerce-strip">
      <div className="atelier-wide">
        <div className="atelier-section-heading atelier-commerce-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="atelier-product-arrows">
            <a className="atelier-text-link" href={viewHref}>View All <span>→</span></a>
            <button type="button" aria-label={`Previous ${title}`} aria-controls={id} onClick={() => scrollRail(-1)}><AtelierIcon name="arrowLeft" /></button>
            <button type="button" aria-label={`Next ${title}`} aria-controls={id} onClick={() => scrollRail(1)}><AtelierIcon name="arrowRight" /></button>
          </div>
        </div>
        <div className="atelier-product-grid atelier-arrivals-rail" id={id} ref={railRef} tabIndex="0" aria-label={title} onKeyDown={handleKeyDown}>
          {visibleProducts.map((product) => <AtelierProductRailCard product={product} demoEcommerceMode={demoEcommerceMode} key={`${id}-${product.id}`} />)}
        </div>
      </div>
    </section>
  );
}

function buildOfferCards({ catalogProducts = [], arrivalProducts = [], tryOnPickProducts = [], feedGender = '' }) {
  const pricedProducts = catalogProducts.filter((product) => Number(product.price || 0) > 0);
  const catalogProductsWithImages = uniqueProducts(catalogProducts).filter((product) => product?.imageUrl);
  const discountedProducts = uniqueProducts(catalogProducts)
    .filter((product) => productDiscountPercent(product) > 0)
    .sort((a, b) => productDiscountPercent(b) - productDiscountPercent(a));
  const under499Products = pricedProducts.filter((product) => Number(product.price || 0) < 499);
  const under999Products = pricedProducts.filter((product) => Number(product.price || 0) < 999);
  const genderProducts = feedGender
    ? catalogProducts.filter((product) => String(product.gender || '').toLowerCase() === feedGender)
    : [];
  const usedImageKeys = new Set();
  const cards = [];
  const contextText = (product) => `${product?.category || ''} ${product?.name || ''} ${Array.isArray(product?.tags) ? product.tags.join(' ') : product?.tags || ''}`;
  const discountedProduct = pickCardProduct(discountedProducts, usedImageKeys);
  const under499Product = pickCardProduct(under499Products, usedImageKeys);
  const under999Product = pickCardProduct(under999Products, usedImageKeys);
  const arrivalProduct = pickCardProduct(arrivalProducts, usedImageKeys);
  const tryOnProduct = pickCardProduct(tryOnPickProducts, usedImageKeys);
  const genderProduct = pickCardProduct(genderProducts, usedImageKeys);
  const occasionProduct = pickCardProduct(
    [arrivalProducts, catalogProductsWithImages],
    usedImageKeys,
    (product) => /dress|saree|gown|jumpsuit|co-ord|set|blazer|jacket|occasion|party|date|work/i.test(contextText(product))
  ) || pickCardProduct([arrivalProducts, catalogProductsWithImages], usedImageKeys);
  const menProduct = pickCardProduct(
    catalogProductsWithImages,
    usedImageKeys,
    (product) => String(product.gender || '').toLowerCase() === 'men'
  ) || pickCardProduct(
    catalogProductsWithImages,
    usedImageKeys,
    (product) => /shirt|t-shirt|jacket|pants|trouser|men/i.test(contextText(product))
  );
  const categoryFinderProduct = pickCardProduct(
    catalogProductsWithImages,
    usedImageKeys,
    (product) => /bag|accessor|shoe|watch|eyewear|jewel/i.test(contextText(product))
  ) || pickCardProduct(catalogProductsWithImages, usedImageKeys);
  const cozyStaplesProduct = pickCardProduct(
    catalogProductsWithImages,
    usedImageKeys,
    (product) => /sweatshirt|hoodie|jacket|layer|knit|sweater/i.test(contextText(product))
  ) || pickCardProduct(catalogProductsWithImages, usedImageKeys);

  if (discountedProduct) cards.push({
      id: 'deal-drop',
      kicker: 'Top Deals',
      title: `Up to ${productDiscountPercent(discountedProduct)}% off`,
      copy: `${discountedProducts.length} live markdowns`,
      cta: 'Shop now',
      href: '/categories?discounted=true',
      image: discountedProduct.imageUrl
    });
  if (under499Product) cards.push({
      id: 'under-499-offer',
      kicker: 'Budget Edit',
      title: 'Under ₹499',
      copy: `${under499Products.length} catalog picks`,
      cta: 'Explore',
      href: '/categories?maxPrice=499',
      image: under499Product.imageUrl
    });
  if (under999Product) cards.push({
      id: 'under-999-offer',
      kicker: 'Easy Prices',
      title: 'Under ₹999',
      copy: `${under999Products.length} styles available`,
      cta: 'View picks',
      href: '/categories?maxPrice=999',
      image: under999Product.imageUrl
    });
  if (arrivalProduct) cards.push({
      id: 'new-arrivals-offer',
      kicker: 'Fresh Drop',
      title: 'New arrivals',
      copy: `${arrivalProducts.length} recent styles`,
      cta: 'Shop new',
      href: '/categories',
      image: arrivalProduct.imageUrl
    });
  if (tryOnProduct) cards.push({
      id: 'ai-tryon-offer',
      kicker: 'AI Try-On',
      title: 'See it on you',
      copy: `${tryOnPickProducts.length} preview-ready picks`,
      cta: 'Try now',
      href: '/custom-try-on',
      image: tryOnProduct.imageUrl
    });
  if (genderProduct) cards.push({
      id: 'gender-feed-offer',
      kicker: feedGender === 'women' ? "Women's edit" : "Men's edit",
      title: feedGender === 'women' ? 'Curated for women' : 'Curated for men',
      copy: `${genderProducts.length} matching styles`,
      cta: 'Open edit',
      href: `/categories?gender=${feedGender}`,
      image: genderProduct.imageUrl
    });
  if (occasionProduct) cards.push({
      id: 'occasion-edit-offer',
      kicker: 'Occasion edit',
      title: 'Plan every look',
      copy: 'Work, dates, weekends',
      cta: 'Get ideas',
      href: '/style-bot',
      image: occasionProduct.imageUrl
    });
  if (menProduct) cards.push({
      id: 'men-curated-offer',
      kicker: "Men's edit",
      title: 'Curated for men',
      copy: 'Clean layers and daily staples',
      cta: 'Open edit',
      href: '/categories?gender=men',
      image: menProduct.imageUrl
    });
  if (categoryFinderProduct) cards.push({
      id: 'category-finder-offer',
      kicker: 'Explore',
      title: 'Find your edit',
      copy: 'Shop every department fast',
      cta: 'Browse',
      href: '/categories',
      image: categoryFinderProduct.imageUrl
    });
  if (cozyStaplesProduct) cards.push({
      id: 'cozy-staples-offer',
      kicker: 'Staples',
      title: 'Cozy layers',
      copy: 'Sweatshirts and soft essentials',
      cta: 'View picks',
      href: '/categories/sweatshirts',
      image: cozyStaplesProduct.imageUrl
    });
  return cards.slice(0, 8);
}

function AtelierOfferCards({ offers = [] }) {
  if (!offers.length) return null;
  const offerCardStyle = {
    height: 'clamp(142px, 10.8vw, 178px)',
    minHeight: 0,
    maxHeight: '178px',
    overflow: 'hidden',
    gridTemplateColumns: 'minmax(0, .58fr) minmax(104px, .42fr)'
  };
  const offerMediaStyle = {
    display: 'block',
    height: '100%',
    minHeight: 0,
    overflow: 'hidden'
  };
  const offerImageStyle = {
    width: '100%',
    height: '100%',
    minHeight: 0,
    objectFit: 'cover',
    objectPosition: 'center top'
  };

  return (
    <section className="atelier-offer-card-section atelier-wide" aria-label="Lookmefy offers">
      <div className="atelier-offer-card-grid">
        {offers.map((offer) => (
          <a className="atelier-offer-card" href={offer.href} key={offer.id} style={offerCardStyle} data-layout="fixed-landscape">
            <span className="atelier-offer-card-copy">
              <small>{offer.kicker}</small>
              <strong>{offer.title}</strong>
              <em>{offer.copy}</em>
              <b>{offer.cta}</b>
            </span>
            <span className="atelier-offer-card-media" aria-hidden="true" style={offerMediaStyle}>
              <OptimizedImage src={offer.image} alt="" style={offerImageStyle} />
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

function buildCampaignCards() {
  return [
    {
      id: 'campaign-ai-tryon',
      tone: 'violet',
      title: 'AI Try-On',
      copy: 'See it on yourself',
      cta: 'Try now',
      href: '/custom-try-on',
      image: asset('about/about-tryon.png')
    },
    {
      id: 'campaign-smart-wardrobe',
      tone: 'wardrobe',
      title: 'Smart Wardrobe',
      copy: 'Save pieces and build AI looks',
      cta: 'Open wardrobe',
      href: '/closet',
      image: asset('wardrobe-stage-room.png')
    },
    {
      id: 'campaign-ai-stylist',
      tone: 'stylist',
      title: 'AI Stylist',
      copy: 'Ask for looks and outfit ideas',
      cta: 'Ask looks',
      href: '/style-bot',
      image: asset('ai-stylist-campaign.png')
    }
  ].filter(Boolean);
}

function AtelierCampaignCards({ cards = [] }) {
  if (!cards.length) return null;
  return (
    <section className="atelier-campaign-section atelier-wide" aria-label="Featured Lookmefy campaigns">
      <div className="atelier-campaign-grid">
        {cards.map((card) => (
          <a className={`atelier-campaign-card ${card.tone ? `tone-${card.tone}` : ''}`} href={card.href} key={card.id}>
            <span className="atelier-campaign-copy">
              <strong>{card.title}</strong>
              <em>{card.copy}</em>
              <b>{card.cta}</b>
            </span>
            <OptimizedImage src={card.image} alt="" />
          </a>
        ))}
      </div>
    </section>
  );
}

function AtelierBestCategories({ categories = [] }) {
  const visibleCategories = categories.slice(0, 8);
  if (!visibleCategories.length) return null;
  return (
    <section className="atelier-best-category-section atelier-wide">
      <div className="atelier-dense-heading">
        <h2>Best of Categories</h2>
        <a href="/categories">View All <span>›</span></a>
      </div>
      <div className="atelier-best-category-grid">
        {visibleCategories.map(({ category, count, slug, collectionVisual }) => (
          <a className="atelier-best-category-card" href={categoryPageHref(category)} key={`best-${slug}`}>
            <OptimizedImage src={asset(collectionVisual.image)} alt="" style={{ objectPosition: collectionVisual.position }} />
            <strong>{displayCategory({ category })}</strong>
            <small>{compactCount(count)} styles</small>
          </a>
        ))}
      </div>
    </section>
  );
}

function AtelierHome({ user, demoEcommerceMode = false }) {
  const state = useProducts({ limit: 96, sort: 'newest' });
  const recommendedState = useRecommendedProducts(user, 16);
  const arrivalsRailRef = useRef(null);
  const tryOnRailRef = useRef(null);
  const essentialsRailRef = useRef(null);
  const categoryRailRef = useRef(null);
  const [heroSlideIndex, setHeroSlideIndex] = useState(0);
  const isMobileHome = useMediaQuery('(max-width: 760px)');
  const primaryRailLimit = isMobileHome ? 8 : 12;
  const mixedFeedLimit = isMobileHome ? 18 : 48;
  const catalogProducts = useMemo(
    () => (state.products || []).filter((product) => product?.id && product?.imageUrl),
    [state.products]
  );
  const newArrivalProducts = catalogProducts.filter((product) => product.isNewArrival);
  const arrivalProducts = [...newArrivalProducts, ...catalogProducts.filter((product) => !product.isNewArrival)].slice(0, primaryRailLimit);
  const productsAfterArrivals = catalogProducts.filter((product) => !arrivalProducts.some((arrival) => arrival.id === product.id));
  const tryOnPickProducts = (productsAfterArrivals.length ? productsAfterArrivals : catalogProducts).slice(0, primaryRailLimit);
  const productsAfterTryOnPicks = catalogProducts.filter((product) => (
    !arrivalProducts.some((arrival) => arrival.id === product.id)
    && !tryOnPickProducts.some((item) => item.id === product.id)
  ));
  const dailyEssentialProducts = (productsAfterTryOnPicks.length ? productsAfterTryOnPicks : [...catalogProducts].reverse()).slice(0, primaryRailLimit);
  const recommendedProducts = uniqueProducts(recommendedState.products || []);
  const feedGender = productGenderForPreference(user?.genderPreference || '');
  const genderedFeedPool = useMemo(() => {
    if (!feedGender) return catalogProducts;
    const exactGenderProducts = catalogProducts.filter((product) => String(product.gender || '').toLowerCase() === feedGender);
    if (exactGenderProducts.length) return exactGenderProducts;
    return catalogProducts.filter((product) => {
      const productGender = String(product.gender || '').toLowerCase();
      return productGender === feedGender || productGender === 'unisex';
    });
  }, [catalogProducts, feedGender]);
  const mixedFeedProducts = useMemo(() => {
    return stableExploreProducts(genderedFeedPool).slice(0, mixedFeedLimit);
  }, [genderedFeedPool, mixedFeedLimit]);
  const mixedFeedLabel = feedGender ? `${feedGender === 'women' ? "Women's" : "Men's"} picks from every department` : 'Mixed picks from every department';
  const promoProducts = catalogProducts.slice(4, 6);
  const offerCards = useMemo(() => buildOfferCards({ catalogProducts, arrivalProducts, tryOnPickProducts, feedGender }), [arrivalProducts, catalogProducts, feedGender, tryOnPickProducts]);
  const campaignCards = useMemo(() => buildCampaignCards({ catalogProducts, tryOnPickProducts, reservedImages: offerCards.map((card) => card.image) }), [catalogProducts, offerCards, tryOnPickProducts]);
  const commerceSections = useMemo(() => {
    const pricedProducts = catalogProducts.filter((product) => Number(product.price || 0) > 0);
    const byRating = uniqueProducts(catalogProducts)
      .filter((product) => Number(product.rating || 0) > 0)
      .sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    const byDiscount = uniqueProducts(catalogProducts)
      .filter((product) => productDiscountPercent(product) > 0)
      .sort((a, b) => productDiscountPercent(b) - productDiscountPercent(a));
    const bestSellers = uniqueProducts(catalogProducts)
      .filter((product) => productMetric(product, ['soldCount', 'salesCount', 'orderCount', 'orders']) > 0)
      .sort((a, b) => productMetric(b, ['soldCount', 'salesCount', 'orderCount', 'orders']) - productMetric(a, ['soldCount', 'salesCount', 'orderCount', 'orders']));
    const mostViewed = uniqueProducts(catalogProducts)
      .filter((product) => productMetric(product, ['viewCount', 'views', 'impressions']) > 0)
      .sort((a, b) => productMetric(b, ['viewCount', 'views', 'impressions']) - productMetric(a, ['viewCount', 'views', 'impressions']));
    const mostWishlisted = uniqueProducts(catalogProducts)
      .filter((product) => productMetric(product, ['wishlistCount', 'wishlistedCount', 'saves']) > 0)
      .sort((a, b) => productMetric(b, ['wishlistCount', 'wishlistedCount', 'saves']) - productMetric(a, ['wishlistCount', 'wishlistedCount', 'saves']));
    const sections = [
      { id: 'recommended-for-you', title: 'Recommended for You', subtitle: 'Built from your Lookmefy profile', products: fillProductRailProducts(recommendedProducts, catalogProducts), viewHref: '/categories' },
      { id: 'top-deals', title: 'Top Deals', subtitle: 'Live markdowns from the catalog', products: fillProductRailProducts(byDiscount, catalogProducts), viewHref: '/categories?discounted=true' },
      { id: 'under-499', title: 'Under ₹499', subtitle: 'Budget-friendly finds', products: fillProductRailProducts(pricedProducts.filter((product) => Number(product.price || 0) < 499), catalogProducts), viewHref: '/categories?maxPrice=499' },
      { id: 'under-999', title: 'Under ₹999', subtitle: 'More styles at easy prices', products: fillProductRailProducts(pricedProducts.filter((product) => Number(product.price || 0) < 999), catalogProducts), viewHref: '/categories?maxPrice=999' },
      { id: 'women-fashion', title: "Women's Fashion", subtitle: 'Fresh pieces for women', products: fillProductRailProducts(catalogProducts.filter((product) => String(product.gender || '').toLowerCase() === 'women'), catalogProducts), viewHref: '/categories?gender=women' },
      { id: 'men-fashion', title: "Men's Fashion", subtitle: 'Everyday men’s edits', products: fillProductRailProducts(catalogProducts.filter((product) => String(product.gender || '').toLowerCase() === 'men'), catalogProducts), viewHref: '/categories?gender=men' },
      { id: 'footwear', title: 'Footwear', subtitle: 'Shoes and easy pairings', products: fillProductRailProducts(catalogProducts.filter((product) => productMatchesAnyCategory(product, ['shoe', 'footwear', 'sneaker', 'sandal', 'slipper', 'heel'])), catalogProducts), viewHref: '/categories/footwear' },
      { id: 'accessories', title: 'Accessories', subtitle: 'Finishing pieces from the catalog', products: fillProductRailProducts(catalogProducts.filter((product) => productMatchesAnyCategory(product, ['accessor', 'bag', 'watch', 'cap', 'sunglass', 'wallet', 'belt'])), catalogProducts), viewHref: '/categories/accessories' },
      { id: 'best-sellers', title: 'Best Sellers', subtitle: 'Ranked from available sales data', products: fillProductRailProducts(bestSellers, catalogProducts), viewHref: '/categories' },
      { id: 'most-viewed', title: 'Most Viewed', subtitle: 'Products shoppers are opening', products: fillProductRailProducts(mostViewed, catalogProducts), viewHref: '/categories' },
      { id: 'most-wishlisted', title: 'Most Wishlisted', subtitle: 'Saved most often', products: mostWishlisted, viewHref: '/wishlist' },
      !demoEcommerceMode && { id: 'top-rated', title: 'Top Rated', subtitle: 'Highest rated catalog products', products: fillProductRailProducts(byRating, catalogProducts), viewHref: '/categories' }
    ].filter(Boolean);
    return sections.filter((section) => uniqueProducts(section.products).length >= 4);
  }, [catalogProducts, demoEcommerceMode, recommendedProducts]);
  const categoryCards = useMemo(() => {
    const counts = state.facets?.categoryCounts || [];
    return counts
      .map(({ category, count }) => {
        const slug = categorySlug(category);
        const product = catalogProducts.find((item) => categorySlug(item.category) === slug);
        return product ? { category, count, product, slug, collectionVisual: collectionVisualForCategory(category) } : null;
      })
      .filter(Boolean)
      .slice(0, 16);
  }, [catalogProducts, state.facets]);
  const heroSlide = atelierHeroSlides[heroSlideIndex] || atelierHeroSlides[0];
  const firstCommerceSections = commerceSections.slice(0, isMobileHome ? 2 : 4);
  const secondCommerceSections = commerceSections.slice(isMobileHome ? 2 : 4, isMobileHome ? 4 : 8);
  const finalCommerceSections = isMobileHome ? [] : commerceSections.slice(8);

  useEffect(() => {
    if (atelierHeroSlides.length < 2) return undefined;
    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (prefersReducedMotion) return undefined;
    const timer = window.setInterval(() => {
      setHeroSlideIndex((current) => (current + 1) % atelierHeroSlides.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, []);

  const scrollProductRail = (railRef, direction) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(rail.clientWidth * .82, 300), behavior: 'smooth' });
  };

  const handleProductRailKeyDown = (railRef, event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    scrollProductRail(railRef, event.key === 'ArrowRight' ? 1 : -1);
  };

  return (
    <div className="atelier-home">
      <main>
        <section className="atelier-hero atelier-hero-editorial" aria-label="Lookmefy AI fashion try-on">
          <div className="atelier-hero-editorial-slides" aria-hidden="true">
            {atelierHeroSlides.map((slide, index) => (
              <OptimizedImage
                className={`atelier-hero-editorial-image ${index === heroSlideIndex ? 'active' : ''}`}
                src={asset(slide.image)}
                alt=""
                eager={index === 0}
                key={slide.id}
                style={{ objectPosition: slide.position }}
              />
            ))}
          </div>
          <div className="atelier-hero-editorial-scrim" aria-hidden="true" />
          <div className="atelier-hero-editorial-content">
            <div className="atelier-hero-editorial-copy" key={heroSlide.id}>
              <span>{heroSlide.kicker}</span>
              <h1>{heroSlide.title}</h1>
              <p>{heroSlide.copy}</p>
              <div>
                <a className="atelier-hero-editorial-primary" href={heroSlide.primaryHref}><SparkleLineIcon /> {heroSlide.primaryLabel}</a>
                <a className="atelier-hero-editorial-secondary" href={heroSlide.secondaryHref}>{heroSlide.secondaryLabel}</a>
              </div>
            </div>
          </div>
          <div className="atelier-hero-editorial-dots" aria-label="Hero slides">
            {atelierHeroSlides.map((slide, index) => (
              <button
                className={index === heroSlideIndex ? 'active' : ''}
                type="button"
                aria-label={`Show ${slide.kicker} slide`}
                aria-pressed={index === heroSlideIndex}
                key={slide.id}
                onClick={() => setHeroSlideIndex(index)}
              />
            ))}
          </div>
        </section>

        <section className="atelier-category-section">
          <div className="atelier-wide">
            <div className="atelier-section-heading"><h2>Shop by Category</h2><a className="atelier-text-link" href="/categories">View All Departments <span>→</span></a></div>
            <div className="atelier-category-rail-wrap">
              <button className="atelier-category-scroll-button prev" type="button" aria-label="Previous categories" onClick={() => scrollProductRail(categoryRailRef, -1)}><AtelierIcon name="arrowLeft" /></button>
              <div className="atelier-category-grid" ref={categoryRailRef} tabIndex="0" aria-label="Shop by category" onKeyDown={(event) => handleProductRailKeyDown(categoryRailRef, event)}>
                {categoryCards.map(({ category, count, slug, collectionVisual }) => <a className={`atelier-category category-icon-${slug}`} href={categoryPageHref(category)} key={slug}><div className="atelier-category-image"><OptimizedImage src={asset(collectionVisual.image)} alt={`${displayCategory({ category })} category`} style={{ objectPosition: collectionVisual.position }} /></div><span>{displayCategory({ category })} <small>{count}</small></span></a>)}
              </div>
              <button className="atelier-category-scroll-button next" type="button" aria-label="Next categories" onClick={() => scrollProductRail(categoryRailRef, 1)}><AtelierIcon name="arrowRight" /></button>
            </div>
          </div>
        </section>

        {promoProducts.length > 0 && <section className="atelier-promos atelier-wide" aria-label="Featured products">
          {promoProducts.map((product) => <article className="atelier-promo atelier-promo-sale" key={product.id}><a className="atelier-promo-link" href={`/product/${encodeURIComponent(product.id)}`}><div><span className="atelier-eyebrow">{displayCategory(product)}</span><h3>{product.name}</h3><p>{displayBrand(product)} · {formatMoney(product.price || 0, product.currency)}</p><span className="atelier-text-link">View Product →</span></div><OptimizedImage src={product.imageUrl} alt={product.name} highResolution={false} /></a><WishlistHeartButton product={product} className="card-wishlist-heart" /></article>)}
        </section>}

        <AtelierProductStrip title="Curated New Arrivals" railId="new-arrivals-rail" label="Curated new arrivals" products={arrivalProducts} railRef={arrivalsRailRef} onScroll={scrollProductRail} onKeyDown={handleProductRailKeyDown} demoEcommerceMode={demoEcommerceMode} />
        <AtelierOfferCards offers={offerCards.slice(0, 4)} />
        {firstCommerceSections.map((section) => <AtelierCommerceStrip {...section} demoEcommerceMode={demoEcommerceMode} key={section.id} />)}
        <AtelierProductStrip title="AI Try-On Picks" railId="ai-tryon-picks-rail" label="AI try-on picks" products={tryOnPickProducts} viewHref="/categories" railRef={tryOnRailRef} onScroll={scrollProductRail} onKeyDown={handleProductRailKeyDown} demoEcommerceMode={demoEcommerceMode} />
        {!isMobileHome && <AtelierOfferCards offers={offerCards.slice(4)} />}
        {!isMobileHome && <AtelierCampaignCards cards={campaignCards} />}
        <AtelierBestCategories categories={categoryCards} />
        {secondCommerceSections.map((section) => <AtelierCommerceStrip {...section} demoEcommerceMode={demoEcommerceMode} key={section.id} />)}
        <AtelierProductStrip title="Daily Essentials" railId="daily-essentials-rail" label="Daily essentials" products={dailyEssentialProducts} viewHref="/categories" railRef={essentialsRailRef} onScroll={scrollProductRail} onKeyDown={handleProductRailKeyDown} demoEcommerceMode={demoEcommerceMode} />
        {finalCommerceSections.map((section) => <AtelierCommerceStrip {...section} demoEcommerceMode={demoEcommerceMode} key={section.id} />)}
        {mixedFeedProducts.length > 0 && (
          <section className="atelier-mixed-feed">
            <div className="atelier-wide">
              <div className="atelier-section-heading atelier-mixed-feed-heading">
                <h2>More to explore</h2>
                <p>{mixedFeedLabel}</p>
              </div>
              <div className="atelier-mixed-grid" aria-label="Mixed product recommendations">
                {mixedFeedProducts.map((product) => <AtelierProductRailCard product={product} demoEcommerceMode={demoEcommerceMode} key={`mixed-${product.id}`} />)}
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Home() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.history.pushState({}, '', authReturnPath());
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="opening-page" aria-labelledby="opening-title">
      <OptimizedImage className="opening-page-image" src={asset('opening-editorial-hero.png')} alt="A woman and man in tailored outerwear" eager />
      <div className="opening-page-overlay" aria-hidden="true" />
      <section className="opening-page-content">
        <a className="opening-page-brand" href="/" id="opening-title" aria-label="Lookmefy home"><BrandLogo /></a>
        <p>Personal style, considered.</p>
        <nav className="opening-page-actions" aria-label="Start exploring Lookmefy">
          <a href="/categories?gender=women">Women's edit</a>
          <a className="opening-page-shop" href="/categories">Shop Lookmefy</a>
          <a href="/categories?gender=men">Men's edit</a>
        </nav>
        <a className="opening-page-enter" href="/custom-try-on">AI Try-On</a>
      </section>
    </main>
  );
}

function ProductSection({ title, href, state, user, eyebrow = '', copy = '', limit = 6, className = '' }) {
  const { products, loading, error, retry } = state;
  const displayProducts = products.slice(0, limit);
  const [tryOns] = useTryOnCache(user, displayProducts);
  return (
    <section className={`section product-section ${className}`.trim()}>
      <div className="wrap">
        <div className="section-head"><div>{eyebrow && <p className="kicker">{eyebrow}</p>}<h2>{title}</h2>{copy && <p className="section-copy">{copy}</p>}</div><a className="view-all" href={href}>View all ›</a></div>
        {loading && <ProductGridSkeleton count={limit} />}
        {error && <StatusPanel text={error} onRetry={retry} />}
        {!loading && !error && products.length === 0 && <EmptyProducts />}
        {!loading && !error && products.length > 0 && <div className="product-grid">{displayProducts.map((product) => <ProductCard key={product.id} product={product} user={user} tryOn={tryOns[product.id]} />)}</div>}
      </div>
    </section>
  );
}

function HomePromoBand() {
  return (
    <section className="home-promo-band" aria-label="Lookmefy offers">
      <div className="wrap home-promo-grid">
        <a className="home-promo-card dark" href="/categories?discounted=true">
          <span className="home-promo-icon" aria-hidden="true"><TagIcon /></span>
          <span>
            <small>Limited Time Offer</small>
            <strong>Up To 50% Off</strong>
          </span>
        </a>
        <a className="home-promo-card light" href="/support">
          <span className="home-promo-icon" aria-hidden="true"><GlobeIcon /></span>
          <span>
            <strong>Free Shipping</strong>
            <small>On eligible brand orders</small>
          </span>
        </a>
      </div>
    </section>
  );
}

const categoryHeroSlides = [
  {
    kicker: 'Summer Collection',
    title: 'The Art Of Summer',
    copy: 'Lightweight layers, refined textures, and warm-weather staples from the live catalog.',
    image: 'hero2.png',
    href: '/categories',
    cta: 'Shop Now'
  },
  {
    kicker: 'Wardrobe Refresh',
    title: 'Modern Essentials',
    copy: 'Build polished everyday looks from categories already connected to your store.',
    image: 'hero1.png',
    href: '/categories?featured=true',
    cta: 'Explore Edit'
  },
  {
    kicker: 'Evening Edit',
    title: 'Curated Occasionwear',
    copy: 'Discover sharper silhouettes, premium separates, and AI-ready outfit ideas.',
    image: 'arrival-4.jpg',
    href: '/categories/dresses',
    cta: 'View Styles'
  },
  {
    kicker: 'Street Style',
    title: 'Layered Looks',
    copy: 'Casual staples and new arrivals arranged for quick category discovery.',
    image: 'trending-3.jpg',
    href: '/categories',
    cta: 'Browse Now'
  }
];

function CategoryHeroSlider({ products = [] }) {
  const [activeSlide, setActiveSlide] = useState(0);
  const slide = categoryHeroSlides[activeSlide];
  const heroProduct = products.filter((product) => product?.imageUrl)[activeSlide % Math.max(products.filter((product) => product?.imageUrl).length, 1)];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveSlide((current) => (current + 1) % categoryHeroSlides.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, []);

  const goToSlide = (index) => setActiveSlide((index + categoryHeroSlides.length) % categoryHeroSlides.length);

  return (
    <section className="category-hero" aria-label="Featured category collections">
      {categoryHeroSlides.map((item, index) => (
        <div className={`category-hero-slide ${index === activeSlide ? 'active' : ''}`} key={item.title} aria-hidden={index !== activeSlide}>
          <OptimizedImage className="category-hero-bg" src={asset(item.image)} alt="" eager={index === 0} />
        </div>
      ))}
      <div className="category-hero-scrim" aria-hidden="true" />
      <div className="wrap category-page-head">
        <div className="category-hero-copy">
          <p className="category-kicker">{slide.kicker}</p>
          <h1>{slide.title}</h1>
          <p className="lead">{slide.copy}</p>
          <a className="category-hero-cta" href={slide.href}>{slide.cta} <span>→</span></a>
        </div>
        <div className="category-hero-card" aria-label="Featured product preview">
          {heroProduct ? (
            <a href={`/product/${encodeURIComponent(heroProduct.id)}`}>
              <OptimizedImage src={heroProduct.imageUrl} alt={heroProduct.name} />
              <span>
                <small>{displayCategory(heroProduct)}</small>
                <strong>{heroProduct.name}</strong>
                <em>{formatMoney(heroProduct.price || 0, heroProduct.currency)}</em>
              </span>
            </a>
          ) : (
            <a href={slide.href}>
              <span>
                <small>Featured Edit</small>
                <strong>{slide.title}</strong>
                <em>Explore now</em>
              </span>
            </a>
          )}
        </div>
      </div>
      <div className="category-hero-controls" aria-label="Category banner controls">
        <button type="button" onClick={() => goToSlide(activeSlide - 1)} aria-label="Previous banner">‹</button>
        <div className="category-hero-dots" aria-label="Select banner">
          {categoryHeroSlides.map((item, index) => (
            <button className={index === activeSlide ? 'active' : ''} type="button" onClick={() => goToSlide(index)} aria-label={`Show ${item.title}`} key={item.title} />
          ))}
        </div>
        <button type="button" onClick={() => goToSlide(activeSlide + 1)} aria-label="Next banner">›</button>
      </div>
    </section>
  );
}

function CategoryPromoTiles() {
  return (
    <section className="category-promo-section" aria-label="Category offers">
      <div className="wrap category-promo-grid">
        <a className="category-promo-card sale" href="/categories?discounted=true">
          <OptimizedImage src={asset('category-6.jpg')} alt="" />
          <span>
            <small>Big Summer</small>
            <strong>Big Sale</strong>
            <em>Up to 70% off selected drops</em>
          </span>
        </a>
        <a className="category-promo-card shipping" href="/support">
          <span className="category-promo-icon" aria-hidden="true"><GlobeIcon /></span>
          <span>
            <strong>Free Shipping</strong>
            <small>On eligible brand orders</small>
            <em>Shop Now →</em>
          </span>
        </a>
      </div>
    </section>
  );
}

function CategoryCollections({ categories: categoryGroups = [], user }) {
  const collections = categoryGroups.filter((category) => category.products.length > 0);
  if (!collections.length) return null;

  return (
    <section className="category-collections-section" aria-labelledby="category-collections-title">
      <div className="wrap">
        <div className="category-reference-head">
          <div>
            <p className="category-kicker dark">All Collections</p>
            <h2 id="category-collections-title">Shop category wise</h2>
          </div>
          <a className="category-view-all" href="/categories">View full catalog →</a>
        </div>

        <div className="category-collection-list">
          {collections.map((category) => {
            const categoryImage = category.products.find((product) => product.imageUrl)?.imageUrl || asset(category.fallbackImage);
            return (
              <article className="category-collection-panel" key={category.slug}>
                <div className="category-collection-head">
                  <div className="category-collection-title">
                    <OptimizedImage src={categoryImage} alt="" />
                    <div>
                      <p>{category.products.length} pieces</p>
                      <h3>{category.label}</h3>
                    </div>
                  </div>
                  <a href={`/categories/${encodeURIComponent(category.slug)}`}>View Collection →</a>
                </div>
                <div className="category-collection-row" aria-label={`${category.label} products`}>
                  {category.products.map((product) => (
                    <ProductCard key={`${category.slug}-${product.id}`} product={product} user={user} />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const categoryAudienceOptions = [
  { label: 'Women', value: 'women', aliases: ['women', 'woman', 'female', 'ladies'], image: 'category-icons/women-section.png' },
  { label: 'Men', value: 'men', aliases: ['men', 'man', 'male', 'gentlemen'], image: 'category-icons/men-section.png' },
  { label: 'Girls', value: 'girls', aliases: ['girls', 'girl'] },
  { label: 'Boys', value: 'boys', aliases: ['boys', 'boy'] },
  { label: 'Teens', value: 'teens', aliases: ['teens', 'teen'] },
  { label: 'Kids', value: 'kids', aliases: ['kids', 'kid', 'children', 'child'] },
  { label: 'Unisex', value: 'unisex', aliases: ['unisex'], image: 'category-icons/unisex-section.png' }
];

function categoryAudienceForProduct(product) {
  const gender = categorySlug(product?.gender);
  return categoryAudienceOptions.find((audience) => audience.aliases.includes(gender)) || null;
}

function isFashionCatalogProduct(product) {
  const catalogText = [
    product?.name,
    product?.brand,
    product?.category,
    product?.description,
    Array.isArray(product?.tags) ? product.tags.join(' ') : product?.tags
  ].filter(Boolean).join(' ');

  return styleBotCompatibility(catalogText).compatible || /\b(ethnic|apparel|fashion|clothing)\b/i.test(catalogText);
}

function categoryLabel(value) {
  return String(value || 'Uncategorized')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Uncategorized';
}

function categoryPageHref(category, gender = '') {
  const query = new URLSearchParams();
  if (gender) query.set('gender', gender);
  const suffix = query.toString() ? `?${query}` : '';
  return `/categories/${encodeURIComponent(categorySlug(category))}${suffix}`;
}

function AtelierCategoriesPage() {
  const routeSearch = window.location.search;
  const initialParams = useMemo(() => new URLSearchParams(routeSearch), [routeSearch]);
  const initialGender = productGenderForPreference(initialParams.get('gender') || '');
  const initialCategoryFilter = initialParams.get('category') ? categorySlug(initialParams.get('category')) : 'all';
  const initialBrandFilter = initialParams.get('brand') || 'all';
  const queryFilters = useMemo(() => ({
    q: initialParams.get('q') || '',
    tag: initialParams.get('tag') || '',
    category: initialParams.get('category') || '',
    brand: initialParams.get('brand') || '',
    gender: initialParams.get('gender') || '',
    featured: initialParams.get('featured') || '',
    newArrival: initialParams.get('newArrival') || '',
    minPrice: initialParams.get('minPrice') || '',
    maxPrice: initialParams.get('maxPrice') || '',
    discounted: initialParams.get('discounted') || initialParams.get('sale') || ''
  }), [initialParams]);
  const [activeAudience, setActiveAudience] = useState(initialGender || 'all');
  const [categoryFilter, setCategoryFilter] = useState(initialCategoryFilter);
  const [brandFilter, setBrandFilter] = useState(initialBrandFilter);
  const [sortFilter, setSortFilter] = useState('newest');
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const quickCategoryRailRef = useRef(null);
  const audienceRailRef = useRef(null);
  const audienceInitialized = useRef(false);
  const state = useProducts({
    ...queryFilters,
    limit: 96,
    sort: sortFilter === 'price-low' ? 'price-asc' : sortFilter === 'price-high' ? 'price-desc' : 'newest'
  });

  const catalog = useMemo(() => {
    const fashionProducts = (state.products || []).filter((product) => (
      product?.id && product?.imageUrl && isFashionCatalogProduct(product)
    ));
    const audienceCards = categoryAudienceOptions.map((audience) => {
      const products = fashionProducts.filter((product) => categoryAudienceForProduct(product)?.value === audience.value);
      if (!products.length) return null;
      return {
        ...audience,
        count: products.length,
        product: products[0],
        genderFilter: categorySlug(products[0].gender)
      };
    }).filter(Boolean);
    const selectedProducts = activeAudience === 'all'
      ? fashionProducts
      : fashionProducts.filter((product) => categoryAudienceForProduct(product)?.value === activeAudience);
    const filterCategories = [...selectedProducts.reduce((map, product) => {
      const category = String(product.category || '').trim();
      if (!category) return map;
      const key = categorySlug(category);
      const existing = map.get(key) || { value: key, label: categoryLabel(category), count: 0 };
      existing.count += 1;
      map.set(key, existing);
      return map;
    }, new Map()).values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const filterBrands = usableBrands([...selectedProducts.reduce((map, product) => {
      const brand = displayBrand(product);
      if (!brand || brand === 'Marketplace brand') return map;
      const key = brand.toLowerCase();
      const existing = map.get(key) || { value: brand, label: brand, count: 0 };
      existing.count += 1;
      map.set(key, existing);
      return map;
    }, new Map()).values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map((brand) => brand.label))
      .map((brand) => {
        const match = selectedProducts.filter((product) => displayBrand(product) === brand).length;
        return { value: brand, label: brand, count: match };
      });
    const filteredProducts = selectedProducts
      .filter((product) => categoryFilter === 'all' || categorySlug(product.category) === categoryFilter)
      .filter((product) => brandFilter === 'all' || displayBrand(product) === brandFilter)
      .sort((a, b) => {
        if (sortFilter === 'price-low') return Number(a.price || 0) - Number(b.price || 0);
        if (sortFilter === 'price-high') return Number(b.price || 0) - Number(a.price || 0);
        if (sortFilter === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
        return new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0);
      });
    const makeCategorySections = (products) => {
      const groups = products.reduce((categoryGroups, product) => {
        const category = String(product.category || '').trim();
        if (!category) return categoryGroups;
        const key = categorySlug(category);
        if (!categoryGroups.has(key)) categoryGroups.set(key, { category, products: [] });
        categoryGroups.get(key).products.push(product);
        return categoryGroups;
      }, new Map());

      return [...groups.values()]
        .map(({ category, products: categoryProducts }) => ({
          category,
          label: categoryLabel(category),
          count: categoryProducts.length,
          representative: categoryProducts[0],
          collectionVisual: collectionVisualForCategory(category, activeAudience),
          products: categoryProducts.slice(0, 6)
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    };
    const categorySections = makeCategorySections(filteredProducts);

    return {
      audienceCards,
      fashionProductCount: fashionProducts.length,
      featuredProduct: selectedProducts[0] || null,
      quickCategories: makeCategorySections(selectedProducts).slice(0, 20),
      filterCategories,
      filterBrands,
      filteredProductCount: filteredProducts.length,
      categorySections,
      selectedAudience: audienceCards.find((audience) => audience.value === activeAudience) || null
    };
  }, [activeAudience, brandFilter, categoryFilter, sortFilter, state.products]);

  useEffect(() => {
    if (!audienceInitialized.current) {
      audienceInitialized.current = true;
      return;
    }
    setCategoryFilter('all');
    setBrandFilter('all');
    setSortFilter('newest');
    setFilterPanelOpen(false);
  }, [activeAudience]);

  useEffect(() => {
    setActiveAudience(initialGender || 'all');
  }, [initialGender]);

  const resetCategoryFilters = () => {
    setCategoryFilter('all');
    setBrandFilter('all');
    setSortFilter('newest');
  };
  const urlFilterCount = Object.values(queryFilters).filter(Boolean).length;
  const filtersActive = categoryFilter !== 'all' || brandFilter !== 'all' || sortFilter !== 'newest' || urlFilterCount > 0;
  const selectedCategoryLabel = catalog.filterCategories.find((category) => category.value === categoryFilter)?.label || 'All categories';
  const selectedBrandLabel = catalog.filterBrands.find((brand) => brand.value === brandFilter)?.label || 'All brands';
  const sortOptions = [
    ['newest', 'Newest'],
    ['price-low', 'Price: Low to High'],
    ['price-high', 'Price: High to Low'],
    ['name', 'Name A-Z']
  ];
  const activeFilterChips = [
    categoryFilter !== 'all' && ['Category', selectedCategoryLabel, () => setCategoryFilter('all')],
    brandFilter !== 'all' && ['Brand', selectedBrandLabel, () => setBrandFilter('all')],
    sortFilter !== 'newest' && ['Sort', sortOptions.find(([value]) => value === sortFilter)?.[1] || 'Newest', () => setSortFilter('newest')]
  ].filter(Boolean);
  const activeFilterCount = activeFilterChips.length;

  const categoryHref = (category) => {
    return categoryPageHref(category, catalog.selectedAudience?.genderFilter || '');
  };
  const scrollQuickCategoryRail = (direction) => {
    const rail = quickCategoryRailRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(rail.clientWidth * .76, 260), behavior: 'smooth' });
  };
  const scrollAudienceRail = (direction) => {
    const rail = audienceRailRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(rail.clientWidth * .72, 220), behavior: 'smooth' });
  };
  const handleQuickCategoryKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    scrollQuickCategoryRail(event.key === 'ArrowRight' ? 1 : -1);
  };
  const categoryHero = activeAudience === 'all'
    ? {
      imageUrl: asset('category-all-hero.png'),
      alt: 'A woman and a man in modern everyday looks',
      href: '/categories',
      category: 'All fashion',
      title: 'Style for Every Day',
      cta: 'Explore All Fashion',
      campaign: 'all'
    }
    : activeAudience === 'women'
      ? {
      imageUrl: asset('category-women-hero.png'),
      alt: 'Two women in tailored neutral looks',
      href: '/categories?gender=women',
      category: "Women's edit",
      title: 'Tailored for Every Day',
      cta: "Shop Women's Fashion",
      campaign: 'women'
    }
    : activeAudience === 'men'
      ? {
        imageUrl: asset('category-men-hero.png'),
        alt: 'Two men in modern tailored looks',
        href: '/categories?gender=men',
        category: "Men's edit",
        title: 'Modern Essentials',
        cta: "Shop Men's Fashion",
        campaign: 'men'
      }
      : activeAudience === 'unisex'
        ? {
          imageUrl: asset('category-unisex-hero.png'),
          alt: 'A woman and a man in coordinated modern looks',
          href: '/categories?gender=unisex',
          category: 'Unisex edit',
          title: 'Style Without Limits',
          cta: 'Shop Unisex Fashion',
          campaign: 'unisex'
        }
        : catalog.featuredProduct && {
          imageUrl: catalog.featuredProduct.imageUrl,
          alt: catalog.featuredProduct.name,
          href: `/product/${encodeURIComponent(catalog.featuredProduct.id)}`,
          category: displayCategory(catalog.featuredProduct),
          title: catalog.featuredProduct.name,
          cta: `View Product · ${formatMoney(catalog.featuredProduct.price || 0, catalog.featuredProduct.currency)}`,
          campaign: ''
        };

  return (
    <div className="atelier-category-page">
      <main className="atelier-category-main">
        {categoryHero && <section className="atelier-category-wide atelier-category-hero-section">
          <a className={`atelier-category-hero${categoryHero.campaign ? ` atelier-category-hero-${categoryHero.campaign}` : ''}`} href={categoryHero.href}>
            <OptimizedImage src={categoryHero.imageUrl} alt={categoryHero.alt} eager />
            <span className="atelier-category-hero-scrim" aria-hidden="true" />
            <span className="atelier-category-hero-copy"><small>{categoryHero.category}</small><strong>{categoryHero.title}</strong><span className="atelier-category-hero-support">Curated essentials, trending pieces and everyday styles.</span><em>{categoryHero.cta} <span aria-hidden="true">→</span></em></span>
          </a>
        </section>}

        {catalog.quickCategories.length > 0 && <section className="atelier-category-wide atelier-category-quick-section" aria-labelledby="category-quick-title">
          <div className="atelier-category-quick-heading"><p>SHOP BY CATEGORY</p><h2 id="category-quick-title">Find your style</h2></div>
          <div className="atelier-category-rail-wrap">
            <button className="atelier-category-scroll-button prev" type="button" aria-label="Previous fashion categories" onClick={() => scrollQuickCategoryRail(-1)}><AtelierIcon name="arrowLeft" /></button>
            <nav className="atelier-category-quick-rail" aria-label="Fashion categories" ref={quickCategoryRailRef} tabIndex="0" onKeyDown={handleQuickCategoryKeyDown}>
              {catalog.quickCategories.map((category) => <a className={`category-icon-${categorySlug(category.category)}`} href={categoryHref(category.category)} key={category.category}>
                <span className="atelier-category-quick-image"><OptimizedImage src={asset(category.collectionVisual.image)} alt="" style={{ objectPosition: category.collectionVisual.position }} /></span><strong>{category.label}</strong><small>{category.count} items</small>
              </a>)}
            </nav>
            <button className="atelier-category-scroll-button next" type="button" aria-label="Next fashion categories" onClick={() => scrollQuickCategoryRail(1)}><AtelierIcon name="arrowRight" /></button>
          </div>
        </section>}

        {catalog.audienceCards.length > 0 && <section className="atelier-category-wide atelier-category-audience-section" aria-labelledby="category-audience-title">
          <div className="atelier-category-audience-heading">
            <p id="category-audience-title">Shop by audience</p>
            <span>Fashion from the live catalog</span>
          </div>
          <div className="atelier-category-audience-rail-wrap">
            <button className="atelier-category-scroll-button prev" type="button" aria-label="Previous audience" onClick={() => scrollAudienceRail(-1)}><AtelierIcon name="arrowLeft" /></button>
            <div className="atelier-category-audience-rail" role="tablist" aria-label="Shop fashion by audience" ref={audienceRailRef}>
              <button className={activeAudience === 'all' ? 'active' : ''} type="button" role="tab" aria-selected={activeAudience === 'all'} onClick={() => setActiveAudience('all')}>
                <span className="atelier-category-audience-all" aria-hidden="true">All</span><strong>All fashion</strong><small>{catalog.fashionProductCount} items</small>
              </button>
              {catalog.audienceCards.map((audience) => (
                <button className={activeAudience === audience.value ? 'active' : ''} type="button" role="tab" aria-selected={activeAudience === audience.value} key={audience.value} onClick={() => setActiveAudience(audience.value)}>
                  <span className="atelier-category-audience-image"><OptimizedImage src={audience.image ? asset(audience.image) : audience.product.imageUrl} alt="" /></span><strong>{audience.label}</strong><small>{audience.count} items</small>
                </button>
              ))}
            </div>
            <button className="atelier-category-scroll-button next" type="button" aria-label="Next audience" onClick={() => scrollAudienceRail(1)}><AtelierIcon name="arrowRight" /></button>
          </div>
        </section>}

        <section className="atelier-category-wide atelier-category-filter-section" aria-label="Catalog filters">
          <div className="atelier-category-filter-head">
            <div><p>{catalog.filteredProductCount} styles</p><span>{activeAudience === 'all' ? 'All fashion' : catalog.selectedAudience?.label || 'Fashion'} catalog</span></div>
            <div className="atelier-category-filter-actions">
              <button className="atelier-category-filter-toggle" type="button" aria-expanded={filterPanelOpen} aria-controls="category-filter-panel" onClick={() => setFilterPanelOpen((open) => !open)}>Filter{activeFilterCount > 0 && <strong>{activeFilterCount}</strong>}</button>
              {filtersActive && <button className="atelier-category-filter-clear" type="button" onClick={resetCategoryFilters}>Clear all</button>}
            </div>
          </div>
          {filterPanelOpen && <div className="atelier-category-filter-controls" id="category-filter-panel">
            <label className="atelier-category-filter-select">
              <span>Category</span>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} aria-label="Filter by category">
                <option value="all">All categories</option>
                {catalog.filterCategories.map((category) => <option value={category.value} key={category.value}>{category.label} ({category.count})</option>)}
              </select>
            </label>
            <label className="atelier-category-filter-select">
              <span>Brand</span>
              <select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)} aria-label="Filter by brand">
                <option value="all">All brands</option>
                {catalog.filterBrands.map((brand) => <option value={brand.value} key={brand.value}>{brand.label} ({brand.count})</option>)}
              </select>
            </label>
            <label className="atelier-category-filter-sort">
              <span>Sort by</span>
              <select value={sortFilter} onChange={(event) => setSortFilter(event.target.value)} aria-label="Sort catalog">
                {sortOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </label>
          </div>}
          {filtersActive && <div className="atelier-category-filter-chips" aria-label="Active filters">
            {activeFilterChips.map(([type, label, clear]) => <button type="button" onClick={clear} key={`${type}-${label}`}>{type}: {label} <b aria-hidden="true">x</b></button>)}
          </div>}
        </section>

        {state.error && <div className="atelier-category-wide"><StatusPanel text={state.error} onRetry={state.retry} /></div>}
        {!state.loading && !state.error && catalog.categorySections.length === 0 && <div className="atelier-category-wide atelier-category-empty"><h2>No fashion products available</h2><p>{filtersActive ? 'No products match the selected filters. Reset filters to view the full edit.' : 'There are no wearable fashion products in this audience yet.'}</p></div>}

        {catalog.categorySections.map((category) => (
          <section className="atelier-category-wide atelier-category-products-section" aria-labelledby={`category-section-${categorySlug(category.category)}`} key={`section-${category.category}`}>
            <div className="atelier-category-products-head">
              <div><p>{category.count} Products</p><h2 id={`category-section-${categorySlug(category.category)}`}>{category.label}</h2></div>
              <a href={categoryHref(category.category)}>View All</a>
            </div>
            <div className="atelier-category-product-grid">
              {category.products.map((product) => <AtelierCategoryProductCard product={product} key={product.id} />)}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

function CategoriesPage() {
  return <AtelierCategoriesPage />;
}

function departmentTitle(category) {
  return categorySlug(category) === 'eyewear' ? 'Sunglasses & Eyewear' : categoryLabel(category);
}

function departmentHeroVisual(category, audience = 'all') {
  const curated = collectionVisualForCategory(category, audience);
  if (!curated?.image) return null;
  return {
    imageUrl: asset(curated.image),
    position: curated.position || 'center',
    alt: `${departmentTitle(category)} department`,
    href: categoryPageHref(category, audience === 'all' ? '' : audience),
    curated: true
  };
}

const departmentPriceFilters = [
  { value: 'all', label: 'All prices', test: () => true },
  { value: 'under-500', label: 'Under 500', test: (price) => price > 0 && price < 500 },
  { value: '500-1000', label: '500 to 1,000', test: (price) => price >= 500 && price < 1000 },
  { value: '1000-2500', label: '1,000 to 2,500', test: (price) => price >= 1000 && price < 2500 },
  { value: '2500-plus', label: '2,500+', test: (price) => price >= 2500 }
];

function CategoryDepartmentPage({ category, user, demoEcommerceMode = false }) {
  const initialGender = new URLSearchParams(window.location.search).get('gender') || '';
  const [gender, setGender] = useState(initialGender);
  const [brandFilter, setBrandFilter] = useState('all');
  const [priceFilter, setPriceFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const state = useProducts({ category, gender, sort, limit: 96 });
  const title = departmentTitle(category);
  const categoryPath = categoryPageHref(category, gender);
  const departmentProducts = state.products || [];
  const heroVisual = departmentHeroVisual(category, gender || 'all');
  const departmentBrands = useMemo(() => {
    const brandCounts = departmentProducts.reduce((map, product) => {
      const brand = displayBrand(product);
      if (!brand || brand === 'Marketplace brand') return map;
      const key = brand.toLowerCase();
      const existing = map.get(key) || { value: brand, label: brand, count: 0 };
      existing.count += 1;
      map.set(key, existing);
      return map;
    }, new Map());

    return [...brandCounts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [departmentProducts]);
  const departmentPriceOptions = useMemo(() => departmentPriceFilters.map((option) => ({
    ...option,
    count: option.value === 'all'
      ? departmentProducts.length
      : departmentProducts.filter((product) => option.test(Number(product.price || 0))).length
  })), [departmentProducts]);
  const departmentSortOptions = [
    ['newest', 'Newest'],
    ['price_asc', 'Price: Low to High'],
    ['price_desc', 'Price: High to Low'],
    !demoEcommerceMode && ['rating', 'Top Rated']
  ].filter(Boolean);
  const visibleProducts = useMemo(() => {
    const priceOption = departmentPriceFilters.find((option) => option.value === priceFilter) || departmentPriceFilters[0];
    return departmentProducts
      .filter((product) => brandFilter === 'all' || displayBrand(product) === brandFilter)
      .filter((product) => priceOption.test(Number(product.price || 0)));
  }, [brandFilter, departmentProducts, priceFilter]);
  const filtersActive = Boolean(gender) || brandFilter !== 'all' || priceFilter !== 'all' || sort !== 'newest';

  useEffect(() => {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath !== categoryPath) window.history.replaceState({}, '', categoryPath);
  }, [categoryPath]);

  useEffect(() => {
    setBrandFilter('all');
    setPriceFilter('all');
  }, [category, gender]);

  useEffect(() => {
    if (brandFilter !== 'all' && !departmentBrands.some((brand) => brand.value === brandFilter)) setBrandFilter('all');
  }, [brandFilter, departmentBrands]);

  useEffect(() => {
    if (demoEcommerceMode && sort === 'rating') setSort('newest');
  }, [demoEcommerceMode, sort]);

  const resetDepartmentFilters = () => {
    setGender('');
    setBrandFilter('all');
    setPriceFilter('all');
    setSort('newest');
    window.history.replaceState({}, '', categoryPageHref(category));
  };

  return (
    <main className="department-page">
      <section className={`department-hero${heroVisual ? ' has-image' : ''}`}>
        {heroVisual && (
          <div className={`department-hero-image${heroVisual.curated ? ' curated' : ''}`} aria-hidden="true">
            <OptimizedImage src={heroVisual.imageUrl} alt="" eager style={{ objectPosition: heroVisual.position }} />
          </div>
        )}
        <div className="wrap department-hero-inner">
          <div className="department-hero-copy">
            <a className="department-back-link" href="/categories">All Departments</a>
            <p>Lookmefy Category</p>
            <h1>{title}</h1>
            <span>{state.loading ? 'Loading products' : `${state.total} products selected for this department`}</span>
          </div>
        </div>
      </section>

      <section className="department-catalog wrap" aria-label={`${title} catalog`}>
        <div className="department-controls">
          <div className="department-gender-filter" role="tablist" aria-label="Filter by gender">
            {[['All', ''], ['Women', 'women'], ['Men', 'men'], ['Unisex', 'unisex']].map(([label, value]) => <button className={gender === value ? 'active' : ''} type="button" role="tab" aria-selected={gender === value} onClick={() => setGender(value)} key={label}>{label}</button>)}
          </div>
          <div className="department-filter-selects">
            <label className="department-sort"><span>Brand</span><select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)} aria-label="Filter products by brand" disabled={!departmentBrands.length}><option value="all">All brands</option>{departmentBrands.map((brand) => <option value={brand.value} key={brand.value}>{brand.label} ({brand.count})</option>)}</select></label>
            <label className="department-sort"><span>Price</span><select value={priceFilter} onChange={(event) => setPriceFilter(event.target.value)} aria-label="Filter products by price">{departmentPriceOptions.map((option) => <option value={option.value} key={option.value}>{option.label}{option.value !== 'all' ? ` (${option.count})` : ''}</option>)}</select></label>
            <label className="department-sort"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort products">{departmentSortOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          </div>
        </div>

        <div className="department-results-head"><div><p>{state.loading ? 'Loading' : `${visibleProducts.length} Products`}</p><h2>{title}</h2></div><button className="department-reset-link" type="button" disabled={!filtersActive} onClick={resetDepartmentFilters}>Reset department</button></div>
        {state.loading && <ProductGridSkeleton count={8} />}
        {state.error && <StatusPanel text={state.error} onRetry={state.retry} />}
        {!state.loading && !state.error && visibleProducts.length === 0 && <EmptyProducts search={title} />}
        {!state.loading && !state.error && visibleProducts.length > 0 && <div className="product-grid department-product-grid">{visibleProducts.map((product) => <ProductCard key={product.id} product={product} user={user} demoEcommerceMode={demoEcommerceMode} />)}</div>}
      </section>
    </main>
  );
}

function ProductCard({ product, user, locked = false, tryOn, canTryOn = false, demoEcommerceMode = false, tryOnLoading = false, tryOnVideoLoading = false, tryOnError = '', tryOnVideoError = '', onTryOn, onTryOnVideo }) {
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(() => readWishlistProductIds().includes(String(product.id)));
  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? `${Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)}% OFF` : '';
  const badge = displayProductBadge(product);
  const productImage = product.imageUrl || asset('hero2.png');
  const tryOnImageUrl = protectedMediaUrl(tryOn?.imageUrl || '');
  const tryOnVideoUrl = protectedMediaUrl(tryOn?.videoUrl || '');
  const hasUsableTryOn = Boolean(tryOnImageUrl) && !tryOnImageFailed;
  const hasTryOnVideo = Boolean(tryOnVideoUrl) && hasUsableTryOn;
  const image = hasUsableTryOn ? tryOnImageUrl : productImage;
  const detailHref = `/product/${encodeURIComponent(product.id)}`;
  const buyHref = `/checkout?productId=${encodeURIComponent(product.id)}`;
  const authBuyHref = `/signup?return=${encodeURIComponent(buyHref)}`;
  const brand = displayBrand(product);

  useEffect(() => {
    setTryOnImageFailed(false);
  }, [tryOn?.imageUrl]);

  useEffect(() => {
    const productId = String(product.id);
    const sync = (event) => {
      const ids = event.detail?.ids;
      if (Array.isArray(ids)) setIsWishlisted(ids.map(String).includes(productId));
      else if (String(event.detail?.id || '') === productId) setIsWishlisted(Boolean(event.detail?.saved));
    };
    const syncFromStorage = () => setIsWishlisted(readWishlistProductIds().includes(productId));
    syncFromStorage();
    window.addEventListener('fitlook:wishlist-change', sync);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener('fitlook:wishlist-change', sync);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, [product.id]);

  const toggleWishlist = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const saved = toggleWishlistProductId(product);
    setIsWishlisted(saved);
    announce(saved ? `${product.name} saved to your wishlist.` : `${product.name} removed from your wishlist.`);
  };

  const content = (
    <>
      <div className="product-media">
        {hasTryOnVideo ? (
          <video src={tryOnVideoUrl} poster={tryOnImageUrl} autoPlay muted loop playsInline />
        ) : (
          <OptimizedImage
            src={image}
            alt={product.name}
            highResolution={false}
            onError={(event) => {
              if (hasUsableTryOn) setTryOnImageFailed(true);
              else if (event.currentTarget.src !== window.location.origin + asset('hero2.png')) event.currentTarget.src = asset('hero2.png');
            }}
          />
        )}
        {badge && <span className="badge">{badge}</span>}
        {hasUsableTryOn && <span className="badge tryon-badge">{hasTryOnVideo ? 'Video Try-On' : 'AI Try-On'}</span>}
        <TryOnGenerating active={tryOnLoading || tryOnVideoLoading} text={tryOnVideoLoading ? 'Generating video' : 'Generating try-on'} />
      </div>
      <div className="product-info">
        <h3 className="product-title">{product.name}</h3>
        <p className="product-brand">{brand}</p>
        <p className="product-category-chip">{displayCategory(product)}</p>
        {!demoEcommerceMode && <p className="rating"><span>★</span> {Number(product.rating || 0).toFixed(1)} {product.ratingCount ? `(${product.ratingCount})` : ''}</p>}
        <div className="price-row">
          <span className="price">{formatMoney(product.price || 0, product.currency)}</span>
          {hasDiscount && <span className="was">{formatMoney(product.compareAtPrice, product.currency)}</span>}
          {discount && <span className="off">{discount}</span>}
        </div>
      </div>
    </>
  );

  return (
    <article className={`product-card ${locked ? 'locked-product' : ''}`}>
      {locked ? <div>{content}</div> : <><a className="product-card-link" href={detailHref} onClick={() => recordEvent('product_click', { productId: product.id })}>{content}</a><button className={`heart ${isWishlisted ? 'saved' : ''}`} type="button" aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`} aria-pressed={isWishlisted} title={isWishlisted ? 'Remove from wishlist' : 'Save to wishlist'} onClick={toggleWishlist}><HeartIcon /></button></>}
      {!locked && (
        <div className="product-card-actions">
          {canTryOn && onTryOn ? (
            <button type="button" onClick={() => onTryOn(product, { force: Boolean(tryOn?.imageUrl) })} disabled={tryOnLoading}>
              {tryOnLoading ? 'Generating...' : hasUsableTryOn ? 'Generate Again' : tryOnImageFailed ? 'Try Again' : 'Try On'}
            </button>
          ) : (
            <a href={user ? detailHref : '/signup'}>{hasUsableTryOn ? 'Generate Again' : 'Try On'}</a>
          )}
          {hasUsableTryOn && onTryOnVideo && (
            <button className="video-action" type="button" onClick={() => onTryOnVideo(product, { force: Boolean(tryOn?.videoUrl) })} disabled={tryOnVideoLoading}>
              {tryOnVideoLoading ? 'Video...' : tryOn?.videoUrl ? 'New Video' : 'Video Try-On'}
            </button>
          )}
          {demoEcommerceMode ? (
            <a className="shop-action" href={user ? buyHref : authBuyHref} onClick={() => recordEvent(user ? 'buy_now_click' : 'buy_auth_prompt', { productId: product.id })}>{user ? 'Buy' : 'Sign up to buy'}</a>
          ) : (
            product.affiliateLink && <a className="shop-action" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={() => recordEvent('shop_click', { productId: product.id })}>Shop</a>
          )}
          {tryOnError && <p>{tryOnError}</p>}
          {tryOnVideoError && <p>{tryOnVideoError}</p>}
        </div>
      )}
    </article>
  );
}

const closetCategories = [
  ['All', 'all'],
  ['Tops', 'tops'],
  ['Bottoms', 'bottoms'],
  ['Dresses', 'dresses'],
  ['Suits', 'suits'],
  ['Outerwear', 'outerwear'],
  ['Shoes', 'shoes'],
  ['Accessories', 'accessories'],
  ['Activewear', 'activewear'],
  ['Ethnic', 'ethnic'],
  ['Other', 'other']
];

const closetOccasions = ['today casual', 'office meeting', 'date night', 'party', 'wedding function', 'college day', 'travel', 'rainy weather'];
const closetComboSlots = [
  { key: 'topwear', label: 'Topwear', helper: 'Choose shirt/top', categories: ['tops', 'ethnic'] },
  { key: 'bottomwear', label: 'Bottomwear', helper: 'Choose pant/bottom', categories: ['bottoms'] },
  { key: 'outerwear', label: 'Layer', helper: 'Jacket or suit', categories: ['outerwear', 'suits'] },
  { key: 'footwear', label: 'Footwear', helper: 'Choose shoes', categories: ['shoes'] },
  { key: 'accessory', label: 'Accessory', helper: 'Cap, goggles, watch', categories: ['accessories'] }
];

function closetText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function closetList(value) {
  if (Array.isArray(value)) return value.map((item) => closetText(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeClosetItem(item = {}, index = 0) {
  const source = item && typeof item === 'object' ? item : {};
  const id = closetText(source.id || source._id || source.productId, `closet-item-${index}`);
  return {
    ...source,
    id,
    name: closetText(source.name || source.title, 'Wardrobe item'),
    category: closetText(source.category, 'other').toLowerCase() || 'other',
    imageUrl: closetText(source.imageUrl || source.image || source.thumbnailUrl),
    color: closetText(source.color),
    fabric: closetText(source.fabric),
    pattern: closetText(source.pattern),
    formality: closetText(source.formality),
    favorite: Boolean(source.favorite),
    tags: closetList(source.tags),
    occasions: closetList(source.occasions),
    createdAt: closetText(source.createdAt),
    updatedAt: closetText(source.updatedAt || source.createdAt)
  };
}

function normalizeClosetOutfit(outfit = {}, index = 0) {
  const source = outfit && typeof outfit === 'object' ? outfit : {};
  return {
    ...source,
    id: closetText(source.id || source._id, `closet-outfit-${index}`),
    title: closetText(source.title || source.name, 'Generated wardrobe look'),
    imageUrl: closetText(source.imageUrl || source.image),
    transparentImageUrl: closetText(source.transparentImageUrl),
    plannedFor: source.plannedFor || null,
    imageProcessing: source.imageProcessing && typeof source.imageProcessing === 'object' ? source.imageProcessing : null,
    items: Array.isArray(source.items) ? source.items.map(normalizeClosetItem).filter((entry) => entry.id) : []
  };
}

function normalizeClosetSuggestion(suggestion = {}, index = 0) {
  const source = suggestion && typeof suggestion === 'object' ? suggestion : {};
  const items = Array.isArray(source.items) ? source.items.map(normalizeClosetItem).filter((entry) => entry.id) : [];
  return {
    ...source,
    key: closetText(source.key || source.id, `closet-suggestion-${index}`),
    title: closetText(source.title || source.name, 'Recommended look'),
    reason: closetText(source.reason, 'AI-picked from your closet'),
    itemIds: Array.isArray(source.itemIds) ? source.itemIds.map((id) => closetText(id)).filter(Boolean) : items.map((item) => item.id),
    items
  };
}

function normalizeClosetData(data = {}) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    items: Array.isArray(source.items) ? source.items.map(normalizeClosetItem).filter((item) => item.id) : [],
    outfits: Array.isArray(source.outfits) ? source.outfits.map(normalizeClosetOutfit).filter((outfit) => outfit.id) : [],
    suggestions: Array.isArray(source.suggestions) ? source.suggestions.map(normalizeClosetSuggestion).filter((suggestion) => suggestion.key) : [],
    stats: source.stats && typeof source.stats === 'object' && !Array.isArray(source.stats) ? source.stats : {}
  };
}

function uniqueClosetItems(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function placementStorageKey(modelSrc = '') {
  return `fitlook:model-placement:${String(modelSrc || '').slice(0, 180)}`;
}

function readSavedPlacement(modelSrc) {
  if (typeof window === 'undefined' || !modelSrc) return DEFAULT_MODEL_PLACEMENT;
  try {
    return normalizedPlacement(JSON.parse(localStorage.getItem(placementStorageKey(modelSrc)) || 'null') || DEFAULT_MODEL_PLACEMENT);
  } catch {
    return DEFAULT_MODEL_PLACEMENT;
  }
}

function savePlacement(modelSrc, placement) {
  if (typeof window === 'undefined' || !modelSrc) return;
  localStorage.setItem(placementStorageKey(modelSrc), JSON.stringify(normalizedPlacement(placement)));
}

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let frame = 0;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        return current.width === width && current.height === height ? current : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    });
    observer.observe(element);
    window.addEventListener('orientationchange', update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('orientationchange', update);
    };
  }, [ref]);

  return size;
}

function useImageNaturalSize(src) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!src) {
      setSize({ width: 0, height: 0 });
      return undefined;
    }
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (active) setSize({ width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 });
    };
    image.onerror = () => {
      if (active) setSize({ width: 0, height: 0 });
    };
    image.src = src;
    return () => {
      active = false;
    };
  }, [src]);

  return size;
}

function inspectPreviewImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('Transparent image URL is missing'));
      return;
    }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      if (!width || !height) {
        reject(new Error('Transparent image loaded without dimensions'));
        return;
      }
      let alphaDetected = null;
      try {
        const canvas = document.createElement('canvas');
        const sampleWidth = Math.min(220, width);
        const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
        const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
        alphaDetected = false;
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] < 255) {
            alphaDetected = true;
            break;
          }
        }
      } catch {
        alphaDetected = null;
      }
      resolve({ width, height, alphaDetected });
    };
    image.onerror = () => reject(new Error('Transparent image could not be loaded by the browser'));
    image.src = src;
  });
}

function useSubjectIsolation(modelSource, user) {
  const sourceUrl = modelSource?.imageUrl || '';
  const providedTransparent = modelSource?.transparentImageUrl || '';
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState({
    status: providedTransparent ? 'completed' : sourceUrl ? 'idle' : 'idle',
    transparentUrl: providedTransparent,
    error: '',
    errorCode: '',
    processing: modelSource?.imageProcessing || null,
    outputLoaded: false,
    alphaDetected: null,
    cacheHit: Boolean(modelSource?.imageProcessing?.cached)
  });

  useEffect(() => {
    if (!sourceUrl) {
      setState({ status: 'idle', transparentUrl: '', error: '', errorCode: '', processing: null, outputLoaded: false, alphaDetected: null, cacheHit: false });
      return undefined;
    }
    let active = true;
    const completeWithPreview = async (transparentUrl, processing = null) => {
      try {
        const loaded = await inspectPreviewImage(transparentUrl);
        if (!active) return;
        setState({
          status: loaded.alphaDetected === false ? 'failed' : 'completed',
          transparentUrl: loaded.alphaDetected === false ? '' : transparentUrl,
          error: loaded.alphaDetected === false ? 'Transparent image loaded, but no alpha pixels were detected.' : '',
          errorCode: loaded.alphaDetected === false ? 'NO_ALPHA_DETECTED' : '',
          processing,
          outputLoaded: true,
          alphaDetected: loaded.alphaDetected,
          cacheHit: Boolean(processing?.cached)
        });
      } catch (error) {
        if (!active) return;
        setState({
          status: 'failed',
          transparentUrl: '',
          error: error.message,
          errorCode: 'TRANSPARENT_IMAGE_LOAD_FAILED',
          processing,
          outputLoaded: false,
          alphaDetected: false,
          cacheHit: Boolean(processing?.cached)
        });
      }
    };

    if (providedTransparent) {
      setState((current) => ({ ...current, status: 'requesting', transparentUrl: '', error: '', errorCode: '', processing: modelSource?.imageProcessing || null }));
      completeWithPreview(providedTransparent, modelSource?.imageProcessing || null);
      return () => {
        active = false;
      };
    }
    if (!user || !sourceUrl.startsWith('/uploads/')) {
      setState({ status: 'failed', transparentUrl: '', error: 'No saved source image is available for cutout processing.', errorCode: 'SOURCE_UNAVAILABLE', processing: modelSource?.imageProcessing || null, outputLoaded: false, alphaDetected: null, cacheHit: false });
      return () => {
        active = false;
      };
    }

    const controller = new AbortController();
    setState((current) => ({ ...current, status: 'requesting', transparentUrl: current.transparentUrl || '', error: '', errorCode: '' }));
    api('/images/subject-isolation', {
      method: 'POST',
      body: JSON.stringify({ imageUrl: sourceUrl }),
      timeout: 120000,
      signal: controller.signal
    })
      .then((data) => {
        if (!active) return;
        const status = data.status || data.processing?.processingStatus || 'failed';
        const transparentUrl = data.transparentImageUrl || data.processing?.transparentImageUrl || '';
        if (status === 'completed' && transparentUrl) {
          completeWithPreview(transparentUrl, data.processing || null);
          return;
        }
        setState({
          status: status === 'processing' || status === 'queued' ? 'processing' : 'failed',
          transparentUrl: '',
          error: data.message || data.processing?.processingError || 'Could not prepare transparent preview.',
          errorCode: data.errorCode || 'BACKGROUND_REMOVAL_FAILED',
          processing: data.processing || null,
          outputLoaded: false,
          alphaDetected: null,
          cacheHit: Boolean(data.processing?.cached)
        });
      })
      .catch((error) => {
        if (active && error.name !== 'AbortError') {
          setState({ status: 'failed', transparentUrl: '', error: error.message, errorCode: 'BACKGROUND_REMOVAL_REQUEST_FAILED', processing: null, outputLoaded: false, alphaDetected: null, cacheHit: false });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [sourceUrl, providedTransparent, user?.id, retryKey]);

  return { ...state, retry: () => setRetryKey((current) => current + 1), sourceUrl };
}

function FloorContactShadow({ placement }) {
  if (!placement.modelWidth || !placement.modelHeight) return null;
  return (
    <span
      className="floor-contact-shadow"
      aria-hidden="true"
      style={{
        left: `${placement.leftPercent}%`,
        bottom: `${placement.bottom}px`,
        width: `${placement.shadowWidth}px`,
        height: `${placement.shadowHeight}px`
      }}
    />
  );
}

function ModelAdjustmentControls({ placement, onChange, onReset, onSave }) {
  const current = normalizedPlacement(placement);
  const setScale = (event) => onChange({ ...current, scale: Number(event.target.value) });
  const move = (dx, dy) => onChange({ ...current, x: current.x + dx, floorY: current.floorY + dy });
  return (
    <div className="model-adjustment-controls" role="group" aria-label="Adjust model placement">
      <div className="model-adjustment-nudge" aria-label="Move model">
        <button type="button" onClick={() => move(0, -0.012)} aria-label="Move model up">↑</button>
        <button type="button" onClick={() => move(-0.012, 0)} aria-label="Move model left">←</button>
        <button type="button" onClick={() => move(0.012, 0)} aria-label="Move model right">→</button>
        <button type="button" onClick={() => move(0, 0.012)} aria-label="Move model down">↓</button>
      </div>
      <label>
        <span>Scale</span>
        <input type="range" min="0.72" max="1.25" step="0.01" value={current.scale} onChange={setScale} aria-label="Model scale" />
      </label>
      <button type="button" onClick={onReset}>Reset</button>
      <button type="button" onClick={onSave}>Save</button>
    </div>
  );
}

function TransparentModel({ src, fallback, alt, placement, adjusting, onOpen, onPlacementChange }) {
  const dragRef = useRef(null);
  const activeSrc = src || fallback;
  const isFallback = !src && Boolean(fallback);
  if (!activeSrc) return null;

  const pointerDown = (event) => {
    if (!adjusting) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      placement
    };
  };
  const pointerMove = (event) => {
    const drag = dragRef.current;
    if (!adjusting || !drag || drag.id !== event.pointerId) return;
    const stage = event.currentTarget.closest('.wardrobe-model-frame');
    const rect = stage?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return;
    onPlacementChange({
      ...drag.placement,
      x: drag.placement.x + (event.clientX - drag.startX) / rect.width,
      floorY: drag.placement.floorY + (event.clientY - drag.startY) / rect.height
    });
  };
  const pointerUp = (event) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  return (
    <button
      className={`transparent-model ${isFallback ? 'fallback-model' : ''} ${adjusting ? 'is-adjusting' : ''}`}
      type="button"
      onClick={adjusting ? undefined : onOpen}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      aria-label={adjusting ? 'Drag model to adjust placement' : 'Open model preview full screen'}
      style={{
        left: `${placement.leftPercent}%`,
        bottom: `${placement.bottom}px`,
        height: `${placement.modelHeight}px`
      }}
    >
      <OptimizedImage src={activeSrc} alt={alt} />
    </button>
  );
}

function CutoutFallbackNotice({ isolation, originalSrc, onRetry }) {
  return (
    <div className="cutout-fallback-notice" role="status" aria-live="polite">
      <div>
        <strong>Room cutout needs retry</strong>
        <span>{isolation.error || 'The transparent model preview could not be prepared.'}</span>
      </div>
      {originalSrc && <img src={originalSrc} alt="" />}
      <button type="button" onClick={onRetry}>Retry cutout</button>
    </div>
  );
}

function RoomScene({ modelSource, alt, generating, onOpen, onEmpty }) {
  const visibleSrc = safeWardrobeImageUrl(modelSource?.imageUrl);
  const imageAlt = alt || 'Wardrobe preview';

  return (
    <div className={`room-scene wardrobe-flat-scene ${generating ? 'is-generating' : ''}`}>
      {visibleSrc ? (
        <button className="wardrobe-flat-model" type="button" onClick={onOpen} aria-label="Open wardrobe preview full screen">
          <OptimizedImage
            className="wardrobe-flat-image"
            src={visibleSrc}
            alt={imageAlt}
            eager
            fallbackSrc={asset('wardrobe-default-model.png')}
            style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', objectPosition: 'center center' }}
          />
        </button>
      ) : (
        <button className="wardrobe-model-empty" type="button" onClick={onEmpty}>
          <UserIcon />
          <strong>Upload model photo</strong>
          <span>Use your profile image for wardrobe try-ons.</span>
        </button>
      )}
    </div>
  );
}

function ClosetPage({ user, setUser }) {
  const [state, setState] = useState({ items: [], outfits: [], stats: {}, suggestions: [], loading: true, error: '' });
  const [selectedIds, setSelectedIds] = useState([]);
  const [comboSlots, setComboSlots] = useState({});
  const [activeWardrobeKey, setActiveWardrobeKey] = useState('topwear');
  const [filter, setFilter] = useState('all');
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [occasion, setOccasion] = useState('today casual');
  const [weather, setWeather] = useState('');
  const [mood, setMood] = useState('');
  const [plannedFor, setPlannedFor] = useState(dateInputValue());
  const [pose, setPose] = useState('front facing');
  const [lighting, setLighting] = useState('natural light');
  const [autoApply, setAutoApply] = useState(true);
  const [stagePreviewMode, setStagePreviewMode] = useState(() => (
    new URLSearchParams(window.location.search).get('preview') === 'latest' ? 'outfit' : 'model'
  ));
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chat, setChat] = useState([
    { role: 'assistant', text: 'Ask what to wear today, for an occasion, or which pants fit a shirt from your closet.' }
  ]);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [mobileWardrobePicker, setMobileWardrobePicker] = useState(null);
  const generateInFlightRef = useRef(false);
  const latestOutfitPreviewOpenedRef = useRef(false);

  const loadCloset = () => {
    if (!user) return;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api('/closet')
      .then((data) => {
        const nextState = normalizeClosetData(data);
        setState({ ...nextState, loading: false, error: '' });
        if (!latestOutfitPreviewOpenedRef.current && nextState.outfits[0]?.imageUrl) {
          latestOutfitPreviewOpenedRef.current = true;
          setStagePreviewMode('outfit');
        }
      })
      .catch((err) => setState({ items: [], outfits: [], stats: {}, suggestions: [], loading: false, error: err.message }));
  };

  const processedBodyPhotoUrl = safeWardrobeImageUrl(user?.bodyPhotoUrl);
  const uploadedBodyPhotoUrl = safeWardrobeImageUrl(user?.bodyPhotoOriginalUrl);
  const userBodyPhotoUrl = processedBodyPhotoUrl || uploadedBodyPhotoUrl;

  useEffect(() => {
    loadCloset();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    const refreshProfile = () => {
      api('/auth/me')
        .then((data) => {
          if (active && data.user) setUser(data.user);
        })
        .catch(() => {});
    };
    refreshProfile();
    if (user.bodyPhotoStatus !== 'generating') return () => {
      active = false;
    };
    const timer = window.setInterval(refreshProfile, 4500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user?.id, user?.bodyPhotoStatus, setUser]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const closetItems = Array.isArray(state.items) ? state.items.filter((item) => item && typeof item === 'object') : [];
  const closetOutfits = Array.isArray(state.outfits) ? state.outfits.filter((outfit) => outfit && typeof outfit === 'object') : [];
  const closetSuggestions = Array.isArray(state.suggestions) ? state.suggestions.filter((suggestion) => suggestion && typeof suggestion === 'object') : [];
  const closetStats = state.stats && typeof state.stats === 'object' && !Array.isArray(state.stats) ? state.stats : {};
  const selectedItems = selectedIds.map((id) => closetItems.find((item) => item.id === id)).filter(Boolean);
  const filteredItems = closetItems.filter((item) => filter === 'all' || item.category === filter);
  const plannerDays = nextPlannerDays(7);
  const plannedByDay = new Map(closetOutfits.filter((outfit) => outfit.plannedFor).map((outfit) => [dateInputValue(outfit.plannedFor), outfit]));
  const latestOutfit = closetOutfits[0] || null;
  const mainPreview = latestOutfit?.imageUrl || userBodyPhotoUrl || asset('hero2.png');
  const wardrobeSlots = [
    { key: 'topwear', label: 'Topwear', helper: 'Shirts, tops, kurtas', short: 'To', categories: ['tops', 'outerwear', 'ethnic'] },
    { key: 'bottomwear', label: 'Bottomwear', helper: 'Pants, denim, skirts', short: 'Bo', categories: ['bottoms'] },
    { key: 'goggles', label: 'Goggles', helper: 'Glasses and shades', short: 'Go', categories: ['accessories'], keywords: ['goggle', 'goggles', 'glass', 'glasses', 'sunglass', 'eyewear'] },
    { key: 'cap', label: 'Cap', helper: 'Caps and hats', short: 'Ca', categories: ['accessories'], keywords: ['cap', 'hat'] },
    { key: 'footwear', label: 'Footwear', helper: 'Shoes, boots, sandals', short: 'Fo', categories: ['shoes'] }
  ];
  const wardrobeSlotMatches = (slot, item, strict = false) => {
    if (!item?.category) return false;
    if (!slot.categories.includes(item.category)) return false;
    if (!slot.keywords?.length) return true;
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const occasions = Array.isArray(item.occasions) ? item.occasions : [];
    const text = [item.name, item.category, item.color, item.formality, ...tags, ...occasions].filter(Boolean).join(' ').toLowerCase();
    const keywordMatch = slot.keywords.some((keyword) => text.includes(keyword));
    return strict ? keywordMatch : keywordMatch || slot.categories.includes(item.category);
  };
  const wardrobeOptionsForSlot = (slot) => {
    const exactOptions = closetItems.filter((item) => wardrobeSlotMatches(slot, item, true));
    return exactOptions.length ? exactOptions : closetItems.filter((item) => wardrobeSlotMatches(slot, item));
  };
  const wardrobeRail = wardrobeSlots.map((slot) => {
    const options = wardrobeOptionsForSlot(slot);
    const selected = closetItems.find((item) => item.id === comboSlots[slot.key]) || null;
    return {
      ...slot,
      item: selected || options[0] || null,
      selected,
      options
    };
  });
  const activeWardrobeSlot = wardrobeRail.find((slot) => slot.key === activeWardrobeKey) || wardrobeRail[0];
  const lookbookCards = closetOutfits.length
    ? closetOutfits.slice(0, 5).map((outfit) => ({ id: outfit.id, title: outfit.title, imageUrl: outfit.imageUrl, items: Array.isArray(outfit.items) ? outfit.items : [] }))
    : closetSuggestions.slice(0, 5).map((suggestion, index) => ({ id: suggestion.key || `${suggestion.title}-${index}`, title: suggestion.title, items: Array.isArray(suggestion.items) ? suggestion.items : [] }));
  const comboOptions = closetSuggestions.slice(0, 6);
  const selectedKey = selectedIds.slice().sort().join(':');
  const comboPreviewItems = (selectedItems.length ? selectedItems : closetItems.filter((item) => ['tops', 'bottoms', 'suits', 'outerwear', 'shoes'].includes(item.category))).slice(0, 4);
  const wardrobeSections = [
    { label: 'Tops', icon: <TryOnIcon />, categories: ['tops', 'ethnic', 'activewear'] },
    { label: 'Bottoms', icon: <ClosetIcon />, categories: ['bottoms'] },
    { label: 'Outerwear', icon: <BagIcon />, categories: ['outerwear', 'suits'] },
    { label: 'Shoes', icon: <TagIcon />, categories: ['shoes'] }
  ].map((section) => ({
    ...section,
    items: closetItems.filter((item) => section.categories.includes(item.category))
  }));
  const closetSelectionCards = [
    {
      href: '/closet/add',
      step: '01',
      title: 'Add Clothes',
      copy: 'Upload wardrobe photos and save category, color, fabric, season and occasion tags.',
      meta: `${closetStats.total || closetItems.length} saved`,
      action: 'Open Add Page',
      tone: 'add',
      items: closetItems.slice(0, 3)
    },
    {
      href: '/closet/combo',
      step: '02',
      title: 'Build Combo',
      copy: 'Select which pant fits which shirt, add shoes or accessories, then generate it on you.',
      meta: selectedItems.length ? `${selectedItems.length} selected` : 'Shirt + pant picker',
      action: 'Choose Items',
      tone: 'combo',
      items: comboPreviewItems
    },
    {
      href: '/closet/items',
      step: '03',
      title: 'Your Closet',
      copy: 'Browse all saved clothes with category filters and send selected pieces to the combo page.',
      meta: `${closetCategories.length - 1} filters`,
      action: 'View Wardrobe',
      tone: 'items',
      items: closetItems.slice(0, 4)
    }
  ];

  const slotItems = closetComboSlots.map((slot) => ({
    ...slot,
    selected: closetItems.find((item) => item.id === comboSlots[slot.key]) || null,
    options: closetItems.filter((item) => slot.categories.includes(item.category))
  }));

  const selectedIdsFromSlots = (slots) => [...new Set(Object.values(slots).filter(Boolean))];

  const slotsFromItems = (items = []) => {
    const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const next = {};
    closetComboSlots.forEach((slot) => {
      const item = safeItems.find((entry) => slot.categories.includes(entry.category));
      if (item) next[slot.key] = item.id;
    });
    return next;
  };

  const updateItem = async (item, updates) => {
    const data = await api(`/closet/items/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
    setState((current) => ({ ...current, items: (Array.isArray(current.items) ? current.items : []).map((entry) => (entry.id === item.id ? data.item : entry)) }));
  };

  const deleteItem = async (item) => {
    await api(`/closet/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    setSelectedIds((current) => current.filter((id) => id !== item.id));
    setState((current) => ({ ...current, items: (Array.isArray(current.items) ? current.items : []).filter((entry) => entry.id !== item.id) }));
  };

  const toggleSelected = (item) => {
    if (!item?.id) return;
    setSelectedIds((current) => {
      if (current.includes(item.id)) return current.filter((id) => id !== item.id);
      return [...current, item.id].slice(-5);
    });
  };

  const chooseSlotItem = (slotKey, item) => {
    setComboSlots((current) => {
      const next = { ...current };
      if (!item) delete next[slotKey];
      else next[slotKey] = item.id;
      setSelectedIds(selectedIdsFromSlots(next));
      return next;
    });
  };

  const applyComboItems = (items = []) => {
    const safeItems = Array.isArray(items) ? items.filter((item) => item?.id) : [];
    const nextSlots = slotsFromItems(safeItems);
    setComboSlots(nextSlots);
    setSelectedIds(safeItems.map((item) => item.id).filter(Boolean));
  };

  const swapSelected = (item) => {
    if (!item?.id) return;
    const replacement = closetItems
      .filter((candidate) => candidate.id !== item.id && candidate.category === item.category && !selectedIds.includes(candidate.id))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    if (!replacement) {
      setMessage(`No other ${item.category} item is available to swap.`);
      return;
    }
    setSelectedIds((current) => current.map((id) => (id === item.id ? replacement.id : id)));
    setComboSlots((current) => {
      const matchedSlot = closetComboSlots.find((slot) => slot.categories.includes(item.category));
      if (!matchedSlot || current[matchedSlot.key] !== item.id) return current;
      return { ...current, [matchedSlot.key]: replacement.id };
    });
    setMessage(`Swapped ${item.name} with ${replacement.name}.`);
  };

  const scheduleOutfit = async (outfit, date) => {
    try {
      const data = await api(`/closet/outfits/${encodeURIComponent(outfit.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ plannedFor: date })
      });
      setState((current) => ({ ...current, outfits: (Array.isArray(current.outfits) ? current.outfits : []).map((entry) => (entry.id === outfit.id ? data.outfit : entry)) }));
      setMessage(`Planned ${outfit.title} for ${formatDate(date)}.`);
    } catch (err) {
      setMessage(err.message);
    }
  };

  const askForSuggestions = async (nextOccasion = occasion) => {
    setOccasion(nextOccasion);
    setMessage('Finding the best combos from your closet...');
    try {
      const data = await api('/closet/suggest', {
        method: 'POST',
        body: JSON.stringify({ occasion: nextOccasion, weather, mood })
      });
      setState((current) => ({ ...current, suggestions: Array.isArray(data.suggestions) ? data.suggestions : [] }));
      setMessage('Suggestions ready.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const generateOutfit = async (ids = selectedIds, details = {}) => {
    if (generateInFlightRef.current) return;
    if (!ids.length) {
      setMessage('Select closet items or choose a suggested combo first.');
      return;
    }
    generateInFlightRef.current = true;
    setGenerating(true);
    setMessage('');
    try {
      const data = await api('/closet/outfits/generate', {
        method: 'POST',
        timeout: AI_IMAGE_TIMEOUT_MS,
        body: JSON.stringify({
          itemIds: ids,
          occasion: details.occasion || occasion,
          weather,
          mood,
          plannedFor,
          backdrop: 'neutral grey studio',
          pose,
          lighting,
          notes: ['Use a seamless neutral grey studio background. No room, furniture, windows, plants, closet interior, or lifestyle scene.', pose, lighting].filter(Boolean).join(' · '),
          title: details.title || `Closet look for ${details.occasion || occasion || 'today'}`
        })
      });
      setState((current) => ({ ...current, outfits: data.outfit ? [data.outfit, ...(Array.isArray(current.outfits) ? current.outfits : [])] : (Array.isArray(current.outfits) ? current.outfits : []) }));
      setSelectedIds(ids);
      if (data.user) setUser(data.user);
      setStagePreviewMode('outfit');
      setMessage('Closet look is ready.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      generateInFlightRef.current = false;
      setGenerating(false);
    }
  };

  const submitChat = async (event) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    setChatInput('');
    setChat((current) => [...current, { role: 'user', text }]);
    setChatBusy(true);
    try {
      const data = await api('/closet/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
      setChat((current) => [...current, { role: 'assistant', text: data.reply || 'I found a few closet options for you.' }]);
      if (data.suggestions) setState((current) => ({ ...current, suggestions: Array.isArray(data.suggestions) ? data.suggestions : [] }));
    } catch (err) {
      setChat((current) => [...current, { role: 'assistant', text: err.message }]);
    } finally {
      setChatBusy(false);
    }
  };

  const openRoute = (href) => {
    window.history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const matchedComboSlot = (item) => item?.category ? closetComboSlots.find((slot) => slot.categories.includes(item.category)) : null;

  const handleWardrobeItemClick = (item) => {
    if (!item?.id) return;
    const matchedSlot = matchedComboSlot(item);
    if (!matchedSlot) {
      toggleSelected(item);
      return;
    }
    const shouldClear = comboSlots[matchedSlot.key] === item.id;
    chooseSlotItem(matchedSlot.key, shouldClear ? null : item);
    if (autoApply) setMessage(shouldClear ? `Removed ${item.name} from the look.` : `${item.name} added to the look.`);
  };

  const applyAccessorySlot = (slotKey, label) => {
    const slot = wardrobeRail.find((entry) => entry.key === slotKey);
    setActiveWardrobeKey(slotKey);
    if (!slot?.item) {
      setFilter('accessories');
      setMessage(`Add a ${label.toLowerCase()} to use it in your look.`);
      return;
    }
    chooseSlotItem(slotKey, slot.item);
    setMessage(`${slot.item.name} added to the look.`);
  };

  const clearWardrobeSelection = () => {
    setComboSlots({});
    setSelectedIds([]);
    setMessage('Selection cleared.');
  };

  const undoWardrobeSelection = () => {
    const latestItems = Array.isArray(latestOutfit?.items) ? latestOutfit.items : [];
    if (latestItems.length) {
      applyComboItems(latestItems);
      setMessage('Restored the last generated look.');
      return;
    }
    clearWardrobeSelection();
  };

  const sortedClosetItems = [...closetItems]
    .filter((item) => item?.id && item?.imageUrl)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  const closetItemsForCategories = (categories, offset = 0) => {
    const options = sortedClosetItems.filter((item) => categories.includes(item.category));
    return options.length ? options[offset % options.length] : null;
  };
  const dressItems = sortedClosetItems.filter((item) => ['dresses', 'ethnic', 'suits'].includes(item.category));
  const generatedWardrobeCombos = [
    ...dressItems.slice(0, 6).map((dress, index) => ({
      id: `dress-look-${dress.id}-${index}`,
      title: `${occasion || 'Today'} dress pairing`,
      reason: `Picked for ${occasion || 'today'} from your wardrobe.`,
      items: uniqueClosetItems([
        dress,
        closetItemsForCategories(['shoes'], index),
        closetItemsForCategories(['outerwear', 'suits'], index),
        closetItemsForCategories(['accessories'], index)
      ])
    })),
    ...Array.from({ length: 6 }).map((_, index) => ({
      id: `wardrobe-look-${index}`,
      title: `${closetOccasions[index] || occasion || 'Today'} outfit pair`,
      reason: `Recommended for ${closetOccasions[index] || occasion || 'today'}.`,
      items: uniqueClosetItems([
        closetItemsForCategories(['tops', 'ethnic'], index),
        closetItemsForCategories(['bottoms'], index),
        closetItemsForCategories(['outerwear', 'suits'], index),
        closetItemsForCategories(['shoes'], index),
        closetItemsForCategories(['accessories'], index)
      ])
    }))
  ].filter((card) => card.items.length > 0);
  const recommendationCombos = closetSuggestions.length
    ? closetSuggestions
      .slice(0, 6)
      .map((suggestion, index) => ({
        id: suggestion.key || suggestion.title || `suggestion-${index}`,
        title: suggestion.title || closetOccasions[index] || 'Recommended look',
        reason: suggestion.reason || `Recommended for ${occasion || 'today'}.`,
        items: (Array.isArray(suggestion.items) ? suggestion.items : []).filter((item) => item?.imageUrl)
      }))
      .filter((card) => card.items.length > 0)
    : generatedWardrobeCombos;
  const wardrobeRecommendationCards = recommendationCombos.slice(0, 10);

  const tryRecommendedLook = (card) => {
    const cardItems = Array.isArray(card?.items) ? card.items.filter((item) => item?.id) : [];
    if (!cardItems.length) {
      askForSuggestions();
      return;
    }
    applyComboItems(cardItems);
    generateOutfit(cardItems.map((item) => item.id).filter(Boolean), { title: card.title, occasion });
  };

  const latestOutfitImage = safeWardrobeImageUrl(latestOutfit?.imageUrl);
  const bodyPhotoPreview = userBodyPhotoUrl;
  const showingGeneratedOutfit = stagePreviewMode === 'outfit' && Boolean(latestOutfitImage);
  const modelPreview = showingGeneratedOutfit ? latestOutfitImage : bodyPhotoPreview;
  const previewTitle = showingGeneratedOutfit ? latestOutfit?.title || 'Generated wardrobe look' : 'Model';
  const previewAlt = showingGeneratedOutfit ? latestOutfit?.title || 'Generated wardrobe look' : 'Current wardrobe model';
  const visibleWardrobeStageMessage = message;
  const wardrobeStageMessageIsError = /error|missing|not enough|failed|could not|cannot|unable|timed out|timeout|select|upload|try again|no other/i.test(message);
  const mobileWardrobeSections = wardrobeSections.filter((section) => ['Tops', 'Bottoms'].includes(section.label));
  const activeMobileWardrobeSection = mobileWardrobeSections.find((section) => section.label === mobileWardrobePicker) || null;
  const wardrobeFallbackForSection = (section) => (
    section.label === 'Bottoms' ? asset('category-icons/jeans.png') : asset('category-icons/tops.png')
  );
  const pickMobileWardrobeSection = (section) => {
    setFilter(section.categories[0]);
    setMobileWardrobePicker(section.label);
  };
  const chooseMobileWardrobeItem = (item) => {
    handleWardrobeItemClick(item);
    setMobileWardrobePicker(null);
  };
  const modelSource = {
    imageUrl: modelPreview,
    transparentImageUrl: showingGeneratedOutfit ? latestOutfit?.transparentImageUrl || '' : '',
    imageProcessing: showingGeneratedOutfit ? latestOutfit?.imageProcessing || null : null
  };
  return (
    <main className="closet-page wardrobe-studio-page">
      <div className="wardrobe-studio-shell">
        <aside className="wardrobe-sidebar" aria-label="My wardrobe">
          <div className="wardrobe-sidebar-head">
            <h1>My Wardrobe</h1>
            <button type="button" aria-label="Search wardrobe" onClick={() => openRoute('/closet/items')}><SearchIcon /></button>
          </div>

          <div className="wardrobe-category-stack">
            {wardrobeSections.map((section) => (
              <section className="wardrobe-category-panel" key={section.label}>
                <button className="wardrobe-category-toggle" type="button" onClick={() => setFilter(section.categories[0])} aria-label={`Filter ${section.label}`}>
                  <span>{section.icon}</span>
                  <strong>{section.label}</strong>
                  <small>⌄</small>
                </button>
                <div className="wardrobe-thumb-grid">
                  {section.items.length ? section.items.slice(0, 3).map((item) => (
                    <button className={selectedIds.includes(item.id) ? 'active' : ''} type="button" key={item.id} onClick={() => handleWardrobeItemClick(item)} title={item.name}>
                      <img src={item.imageUrl} alt={item.name} />
                    </button>
                  )) : (
                    <a className="wardrobe-empty-thumb" href="/closet/add">Add</a>
                  )}
                </div>
              </section>
            ))}
          </div>

          <a className="wardrobe-add-button" href="/closet/add">+ Add New Item</a>
        </aside>

        <section className="wardrobe-model-stage" aria-label="Wardrobe model preview" style={{ background: '#d7d7d5', backgroundImage: 'none' }}>
          <div className="wardrobe-mobile-category-rail" aria-label="Wardrobe quick controls">
            <button type="button" onClick={() => setStagePreviewMode('model')}>
              <span>{bodyPhotoPreview ? <OptimizedImage src={bodyPhotoPreview} fallbackSrc={asset('wardrobe-default-model.png')} alt="" /> : <UserIcon />}</span>
              <small>Model</small>
            </button>
            {mobileWardrobeSections.map((section) => {
              const selectedItem = section.items.find((item) => selectedIds.includes(item.id));
              const previewItem = selectedItem || section.items[0];
              return (
                <button className={selectedItem ? 'active' : ''} type="button" key={section.label} onClick={() => pickMobileWardrobeSection(section)}>
                  <span>{previewItem ? <OptimizedImage src={previewItem.imageUrl} fallbackSrc={wardrobeFallbackForSection(section)} alt="" /> : section.icon}</span>
                  <small>{section.label}</small>
                </button>
              );
            })}
            <button type="button" onClick={() => applyAccessorySlot('cap', 'Cap')}>
              <span><BagIcon /></span>
              <small>Cap</small>
            </button>
            <button type="button" onClick={() => applyAccessorySlot('goggles', 'Sunglasses')}>
              <span><EyeIcon /></span>
              <small>Glasses</small>
            </button>
          </div>
          <a className="wardrobe-mobile-add-item" href="/closet/add">+ Add Item</a>
          {!state.loading && closetItems.length === 0 && (
            <section className="wardrobe-empty-state" aria-labelledby="wardrobe-empty-title">
              <h2 id="wardrobe-empty-title">Your wardrobe is empty</h2>
              <p>Add a garment to start creating AI looks.</p>
              <a className="button" href="/closet/add">Add First Item</a>
              <span>Use garment-only photos with the full item visible on a plain, well-lit background.</span>
            </section>
          )}
          {activeMobileWardrobeSection && (
            <div className="wardrobe-mobile-picker-backdrop" role="presentation" onClick={() => setMobileWardrobePicker(null)}>
              <section className="wardrobe-mobile-picker" aria-label={`Choose ${activeMobileWardrobeSection.label}`} onClick={(event) => event.stopPropagation()}>
                <header>
                  <div>
                    <small>Choose item</small>
                    <strong>{activeMobileWardrobeSection.label}</strong>
                  </div>
                  <a href="/closet/add">+ Add</a>
                  <button type="button" aria-label="Close picker" onClick={() => setMobileWardrobePicker(null)}>×</button>
                </header>
                {activeMobileWardrobeSection.items.length ? (
                  <div className="wardrobe-mobile-picker-list">
                    {activeMobileWardrobeSection.items.map((item) => {
                      const isSelected = selectedIds.includes(item.id);
                      return (
                        <button className={isSelected ? 'active' : ''} type="button" key={item.id} onClick={() => chooseMobileWardrobeItem(item)}>
                          <span><OptimizedImage src={item.imageUrl} fallbackSrc={wardrobeFallbackForSection(activeMobileWardrobeSection)} alt="" /></span>
                          <div>
                            <strong>{item.name || activeMobileWardrobeSection.label}</strong>
                            <small>{[item.color, item.formality, item.season].filter(Boolean).join(' · ') || item.category}</small>
                          </div>
                          <em>{isSelected ? 'Selected' : 'Pick'}</em>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="wardrobe-mobile-picker-empty">
                    <strong>No {activeMobileWardrobeSection.label.toLowerCase()} added yet</strong>
                    <p>Add one item first, then come back to build your look.</p>
                    <a href="/closet/add">Add {activeMobileWardrobeSection.label}</a>
                  </div>
                )}
              </section>
            </div>
          )}

          <div className="wardrobe-model-tools left">
            <button type="button" onClick={() => setStagePreviewMode('model')}>
              <span>{bodyPhotoPreview ? <OptimizedImage src={bodyPhotoPreview} fallbackSrc={asset('wardrobe-default-model.png')} alt="" /> : <UserIcon />}</span>
              <small>Model</small>
            </button>
            <button type="button" onClick={() => applyAccessorySlot('cap', 'Cap')}>
              <span><BagIcon /></span>
              <small>Cap</small>
            </button>
            <button type="button" onClick={() => applyAccessorySlot('goggles', 'Sunglasses')}>
              <span><EyeIcon /></span>
              <small>Sunglasses</small>
            </button>
          </div>

          <div className="wardrobe-model-tools right">
            <button type="button" onClick={undoWardrobeSelection} aria-label="Undo selection"><span>↶</span><small>Undo</small></button>
            <button type="button" onClick={clearWardrobeSelection} aria-label="Clear selection"><span>⌫</span><small>Clear</small></button>
          </div>

          <div className="wardrobe-model-frame">
            <RoomScene
              key={`${stagePreviewMode}:${modelPreview}`}
              modelSource={modelSource}
              alt={previewAlt}
              generating={generating}
              user={user}
              onOpen={() => modelPreview ? setFullscreenImage({ src: modelPreview, alt: previewAlt, title: previewTitle }) : openRoute('/profile')}
              onEmpty={() => openRoute('/profile')}
            />
          </div>

          {showingGeneratedOutfit && !generating && <AiPreviewDisclaimer className="wardrobe-ai-disclaimer" />}
          {!generating && visibleWardrobeStageMessage && (
            <p className={`wardrobe-stage-message ${wardrobeStageMessageIsError ? 'error-message' : ''}`} role="status">
              {visibleWardrobeStageMessage}
            </p>
          )}

          <div className="wardrobe-stage-actions">
            <button className="wardrobe-generate-button" type="button" onClick={() => generateOutfit(selectedIds, { title: 'My wardrobe look' })} disabled={generating || selectedIds.length === 0}>
              <SparkleLineIcon />
              <span>{generating ? 'Generating...' : 'Generate Look'}</span>
            </button>
            <button className="wardrobe-heart-button" type="button" onClick={() => latestOutfitImage ? setFullscreenImage({ src: latestOutfitImage, alt: latestOutfit.title, title: latestOutfit.title }) : setMessage('Generate a look first to preview it.') } aria-label="Open latest look"><HeartIcon /></button>
          </div>
        </section>

        <aside className="wardrobe-recommendations" aria-label="AI recommendations">
          <div className="wardrobe-recommendations-head">
            <h2><SparkleLineIcon /> Recommendations</h2>
            <button className="wardrobe-refresh-button" type="button" onClick={() => askForSuggestions('today casual')}>Refresh</button>
          </div>
          <div className="wardrobe-recommendation-tabs">
            {closetOccasions.slice(0, 4).map((idea, index) => (
              <button className={occasion === idea ? 'active' : ''} type="button" key={idea} onClick={() => askForSuggestions(idea)}>{idea}</button>
            ))}
          </div>

          <div className="wardrobe-recommendation-list">
            {wardrobeRecommendationCards.length ? wardrobeRecommendationCards.map((card) => (
              <article className="wardrobe-recommendation-card combo" key={card.id}>
                <button className="wardrobe-recommendation-combo" type="button" onClick={() => tryRecommendedLook(card)}>
                  <span className="wardrobe-combo-hero"><img src={card.items[0].imageUrl} alt={card.items[0].name} /></span>
                  {card.items.length > 1 && <span className="wardrobe-combo-strip">
                    {card.items.slice(1, 4).map((item) => <img key={`${card.id}-${item.id}`} src={item.imageUrl} alt={item.name} />)}
                  </span>}
                  <small>{card.items.length} wardrobe {card.items.length === 1 ? 'piece' : 'pieces'} · {occasion}</small>
                  <strong>{card.title}</strong>
                  {card.reason && <span className="wardrobe-recommendation-reason">{card.reason}</span>}
                  <em>Try this look</em>
                </button>
              </article>
            )) : (
              <article className="wardrobe-recommendation-card empty">
                <p>Add a few wardrobe items to unlock outfit recommendations.</p>
                <a href="/closet/add">Add New Item</a>
              </article>
            )}
          </div>
        </aside>
      </div>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </main>
  );
}

function ClosetComboPage({ user, setUser }) {
  const [state, setState] = useState({ items: [], suggestions: [], loading: true, error: '' });
  const [selectedIds, setSelectedIds] = useState([]);
  const [comboSlots, setComboSlots] = useState({});
  const [occasion, setOccasion] = useState('today casual');
  const [weather, setWeather] = useState('');
  const [mood, setMood] = useState('');
  const [plannedFor, setPlannedFor] = useState(dateInputValue());
  const [pose, setPose] = useState('front facing');
  const [lighting, setLighting] = useState('natural light');
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api('/closet')
      .then((data) => {
        if (!alive) return;
        const closetData = normalizeClosetData(data);
        const items = closetData.items;
        setState({ items, suggestions: closetData.suggestions, loading: false, error: '' });
        let storedSeed = [];
        try {
          const parsedSeed = JSON.parse(localStorage.getItem('fitlook_combo_seed') || '[]');
          storedSeed = Array.isArray(parsedSeed) ? parsedSeed : [];
        } catch {
          localStorage.removeItem('fitlook_combo_seed');
        }
        const seededIds = storedSeed.filter((id) => items.some((item) => item.id === id));
        if (seededIds.length) {
          const seededItems = seededIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
          setSelectedIds(seededIds);
          setComboSlots(slotsFromItems(seededItems));
          localStorage.removeItem('fitlook_combo_seed');
        }
      })
      .catch((err) => {
        if (alive) setState({ items: [], suggestions: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [user?.id]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const closetItems = Array.isArray(state.items) ? state.items.filter((item) => item && typeof item === 'object') : [];
  const closetSuggestions = Array.isArray(state.suggestions) ? state.suggestions.filter((suggestion) => suggestion && typeof suggestion === 'object') : [];
  const selectedItems = selectedIds.map((id) => closetItems.find((item) => item.id === id)).filter(Boolean);
  const selectedKey = selectedIds.slice().sort().join(':');
  const comboOptions = closetSuggestions.slice(0, 6);
  const slotItems = closetComboSlots.map((slot) => ({
    ...slot,
    selected: closetItems.find((item) => item.id === comboSlots[slot.key]) || null,
    options: closetItems.filter((item) => slot.categories.includes(item.category))
  }));

  const selectedIdsFromSlots = (slots) => [...new Set(Object.values(slots).filter(Boolean))];
  const slotsFromItems = (items = []) => {
    const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const next = {};
    closetComboSlots.forEach((slot) => {
      const item = safeItems.find((entry) => slot.categories.includes(entry.category));
      if (item) next[slot.key] = item.id;
    });
    return next;
  };

  const chooseSlotItem = (slotKey, item) => {
    setComboSlots((current) => {
      const next = { ...current };
      if (!item) delete next[slotKey];
      else next[slotKey] = item.id;
      setSelectedIds(selectedIdsFromSlots(next));
      return next;
    });
  };

  const applyComboItems = (items = []) => {
    const safeItems = Array.isArray(items) ? items.filter((item) => item?.id) : [];
    setComboSlots(slotsFromItems(safeItems));
    setSelectedIds(safeItems.map((item) => item.id).filter(Boolean));
  };

  const toggleSelected = (item) => {
    if (!item?.id) return;
    setSelectedIds((current) => current.filter((id) => id !== item.id));
    setComboSlots((current) => {
      const next = { ...current };
      Object.entries(next).forEach(([key, id]) => {
        if (id === item.id) delete next[key];
      });
      return next;
    });
  };

  const swapSelected = (item) => {
    if (!item?.id) return;
    const replacement = closetItems
      .filter((candidate) => candidate.id !== item.id && candidate.category === item.category && !selectedIds.includes(candidate.id))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    if (!replacement) {
      setMessage(`No other ${item.category} item is available to swap.`);
      return;
    }
    setSelectedIds((current) => current.map((id) => (id === item.id ? replacement.id : id)));
    setComboSlots((current) => {
      const matchedSlot = closetComboSlots.find((slot) => slot.categories.includes(item.category));
      if (!matchedSlot || current[matchedSlot.key] !== item.id) return current;
      return { ...current, [matchedSlot.key]: replacement.id };
    });
    setMessage(`Swapped ${item.name} with ${replacement.name}.`);
  };

  const askForSuggestions = async (nextOccasion = occasion) => {
    setOccasion(nextOccasion);
    setMessage('Finding combo ideas...');
    try {
      const data = await api('/closet/suggest', {
        method: 'POST',
        body: JSON.stringify({ occasion: nextOccasion, weather, mood })
      });
      setState((current) => ({ ...current, suggestions: Array.isArray(data.suggestions) ? data.suggestions : [] }));
      setMessage('Combo ideas ready.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const generateOutfit = async (ids = selectedIds, details = {}) => {
    if (!ids.length) {
      setMessage('Choose at least one shirt, pant, shoe, or accessory.');
      return;
    }
    setGenerating(true);
    setMessage('Generating your selected combo with FitRoom...');
    try {
      const data = await api('/closet/outfits/generate', {
        method: 'POST',
        timeout: AI_IMAGE_TIMEOUT_MS,
        body: JSON.stringify({
          itemIds: ids,
          occasion: details.occasion || occasion,
          weather,
          mood,
          plannedFor,
          backdrop: 'neutral grey studio',
          pose,
          lighting,
          notes: ['Use a seamless neutral grey studio background. No room, furniture, windows, plants, closet interior, or lifestyle scene.', pose, lighting].filter(Boolean).join(' · '),
          title: details.title || `Closet combo for ${details.occasion || occasion || 'today'}`
        })
      });
      if (data.user) setUser(data.user);
      setMessage('Combo preview is ready in wardrobe.');
      window.history.pushState({}, '', '/closet?preview=latest');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      setMessage(err.message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <main className="closet-combo-page">
      <section className="wrap closet-add-hero">
        <div>
          <p className="kicker">Outfit Builder</p>
          <h1>Build a combo.</h1>
          <p className="lead">Choose which shirt goes with which pant, then add shoes or accessories and generate the outfit on you.</p>
        </div>
        <a className="secondary-button" href="/closet">Back To Closet</a>
      </section>

      <section className="wrap closet-combo-layout">
        <div className="closet-builder">
          <div className="closet-builder-controls">
            <input value={occasion} onChange={(event) => setOccasion(event.target.value)} placeholder="Occasion" />
            <input value={weather} onChange={(event) => setWeather(event.target.value)} placeholder="Weather" />
            <input value={mood} onChange={(event) => setMood(event.target.value)} placeholder="Mood" />
            <button type="button" onClick={() => askForSuggestions()} disabled={closetItems.length === 0}>Suggest</button>
          </div>
          <div className="closet-scene-controls">
            <label><span>Plan date</span><input type="date" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)} /></label>
            <label><span>Pose</span><select value={pose} onChange={(event) => setPose(event.target.value)}><option>front facing</option><option>relaxed standing</option><option>walking pose</option><option>three-quarter angle</option></select></label>
            <label><span>Lighting</span><select value={lighting} onChange={(event) => setLighting(event.target.value)}><option>natural light</option><option>studio softbox</option><option>evening warm</option><option>bright daylight</option></select></label>
          </div>
          <div className="selected-strip">
            {selectedItems.length ? selectedItems.map((item) => (
              <div className="selected-chip" key={item.id}>
                <img src={item.imageUrl} alt="" />
                <span>{item.name}</span>
                <button type="button" onClick={() => swapSelected(item)}>Swap</button>
                <button type="button" onClick={() => toggleSelected(item)}>Remove</button>
              </div>
            )) : <span>Select a shirt and pant below, or use an AI suggestion.</span>}
          </div>
          <button className="submit" type="button" disabled={generating || selectedIds.length === 0} onClick={() => generateOutfit()}>{generating ? 'Generating...' : 'Generate Combo On Me'}</button>
          {message && <p className={`form-message ${/error|missing|not enough|failed|could not/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
          {state.loading && <StatusPanel text="Loading closet items..." />}
          {state.error && <StatusPanel text={state.error} />}
        </div>

        <section className="combo-selection-panel closet-combo-selection-page" aria-label="Combo selection">
          <div className="combo-selection-head">
            <strong>Combo Selection</strong>
            <span>{selectedItems.length ? `${selectedItems.length} pieces selected` : 'Choose shirt, pant and more'}</span>
          </div>
          <div className="slot-combo-builder" aria-label="Build a custom clothing combo">
            {slotItems.map((slot) => (
              <article className="slot-picker" key={slot.key}>
                <div className="slot-picker-head">
                  <div><strong>{slot.label}</strong><span>{slot.helper}</span></div>
                  {slot.selected && <button type="button" onClick={() => chooseSlotItem(slot.key, null)}>Clear</button>}
                </div>
                <div className="slot-selected-preview">
                  {slot.selected ? <><img src={slot.selected.imageUrl} alt="" /><span>{slot.selected.name}</span></> : <span>No {slot.label.toLowerCase()} selected</span>}
                </div>
                <div className="slot-options">
                  {slot.options.length ? slot.options.slice(0, 10).map((item) => (
                    <button className={slot.selected?.id === item.id ? 'active' : ''} type="button" key={item.id} onClick={() => chooseSlotItem(slot.key, item)} title={item.name}>
                      <img src={item.imageUrl} alt="" />
                    </button>
                  )) : <small>Add {slot.label.toLowerCase()} items to your closet.</small>}
                </div>
              </article>
            ))}
          </div>
          <div className="combo-options">
            {comboOptions.length ? comboOptions.map((combo, index) => {
              const comboIds = Array.isArray(combo.itemIds) ? combo.itemIds : [];
              const comboKey = comboIds.slice().sort().join(':');
              const active = comboKey && comboKey === selectedKey;
              const comboItems = Array.isArray(combo.items) ? combo.items.filter((item) => item?.id) : [];
              return (
                <button className={active ? 'active' : ''} type="button" key={combo.key || combo.title || index} onClick={() => applyComboItems(comboItems)}>
                  <span className="combo-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="combo-thumbs">{comboItems.slice(0, 4).map((item) => <img src={item.imageUrl} alt="" key={item.id} />)}</span>
                  <span className="combo-copy"><strong>{combo.title || `Combo ${index + 1}`}</strong><small>{combo.reason || 'AI-picked from your closet'}</small></span>
                </button>
              );
            }) : (
              <button className="empty-combo-option" type="button" onClick={() => askForSuggestions()}>
                <span className="combo-number">AI</span>
                <span className="combo-copy"><strong>Create combos</strong><small>Get recommendations from your uploaded closet.</small></span>
              </button>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function ClosetItemsPage({ user, setUser }) {
  const [state, setState] = useState({ items: [], loading: true, error: '' });
  const [filter, setFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api('/closet')
      .then((data) => {
        if (alive) setState({ items: normalizeClosetData(data).items, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ items: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [user?.id]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const closetItems = Array.isArray(state.items) ? state.items.filter((item) => item && typeof item === 'object') : [];
  const filteredItems = closetItems.filter((item) => filter === 'all' || item.category === filter);

  const updateItem = async (item, updates) => {
    try {
      const data = await api(`/closet/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      setState((current) => ({ ...current, items: (Array.isArray(current.items) ? current.items : []).map((entry) => (entry.id === item.id ? data.item : entry)) }));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const deleteItem = async (item) => {
    try {
      await api(`/closet/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setSelectedIds((current) => current.filter((id) => id !== item.id));
      setState((current) => ({ ...current, items: (Array.isArray(current.items) ? current.items : []).filter((entry) => entry.id !== item.id) }));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const toggleSelected = (item) => {
    setSelectedIds((current) => (current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id].slice(-5)));
  };

  const openComboBuilder = () => {
    localStorage.setItem('fitlook_combo_seed', JSON.stringify(selectedIds));
    window.location.href = '/closet/combo';
  };

  return (
    <main className="closet-items-page">
      <section className="wrap closet-items-hero">
        <div>
          <p className="kicker">Wardrobe</p>
          <h1>Your closet</h1>
          <p className="lead">Browse clothes by type, save favorites, remove old items, or send selected pieces to the combo builder.</p>
        </div>
        <div className="closet-items-actions">
          <a className="secondary-button" href="/closet">Back To Closet</a>
          <a className="button" href="/closet/add">Add Clothes</a>
        </div>
      </section>

      <section className="wrap closet-items-section standalone">
        <div className="section-head">
          <h2>Your closet</h2>
          <div className="closet-tabs">{closetCategories.map(([label, value]) => <button className={filter === value ? 'active' : ''} type="button" key={value} onClick={() => setFilter(value)}>{label}</button>)}</div>
        </div>
        {message && <p className={`form-message ${/error|missing|failed|could not|cannot|upload/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
        {selectedIds.length > 0 && (
          <div className="closet-selection-bar">
            <span>{selectedIds.length} selected for combo</span>
            <button type="button" onClick={openComboBuilder}>Build Combo</button>
          </div>
        )}
        {state.loading && <StatusPanel text="Loading closet items..." />}
        {state.error && <StatusPanel text={state.error} />}
        {!state.loading && !state.error && filteredItems.length === 0 && <EmptyProducts search={filter === 'all' ? '' : filter} />}
        <div className="closet-grid">
          {filteredItems.map((item) => (
            <article className={`closet-item-card ${selectedIds.includes(item.id) ? 'selected' : ''}`} key={item.id}>
              <button className="closet-item-media" type="button" onClick={() => toggleSelected(item)}>
                <img src={item.imageUrl} alt={item.name} />
                <span>{selectedIds.includes(item.id) ? 'Selected' : 'Add to combo'}</span>
              </button>
              <div className="closet-item-info">
                <h3>{item.name}</h3>
                <p>{[item.color, item.fabric, item.category, item.formality].filter(Boolean).join(' · ')}</p>
                <div>
                  <button type="button" onClick={() => updateItem(item, { favorite: !item.favorite })}>{item.favorite ? 'Saved' : 'Save'}</button>
                  <button type="button" onClick={() => deleteItem(item)}>Remove</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function ClosetAddPage({ user, setUser }) {
  const formRef = useRef(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const analysisRunRef = useRef(0);
  const [uploadPreview, setUploadPreview] = useState('');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [detectedProfile, setDetectedProfile] = useState(null);
  const [savedItems, setSavedItems] = useState([]);
  const [season, setSeason] = useState('summer');
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  }, [uploadPreview]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const validateClosetUpload = (file) => {
    if (!file) return 'Upload a garment image before continuing.';
    const name = String(file.name || '');
    const type = String(file.type || '').toLowerCase();
    const supported = type.startsWith('image/') || /\.(?:avif|heic|heif|jpe?g|png|webp)$/i.test(name);
    if (!supported || type === 'image/svg+xml' || /\.svg$/i.test(name)) return 'Upload a JPG, PNG, WebP, AVIF, HEIC, or HEIF garment photo.';
    if (file.size > MAX_BODY_PHOTO_BYTES) return 'This garment photo is too large. Choose an image under 8 MB.';
    if (file.size === 0) return 'This garment photo appears corrupted. Choose a different image.';
    return '';
  };

  const applyDetectedDetails = (details = {}) => {
    const form = formRef.current;
    if (!form) return;
    const setField = (name, value, defaults = ['', 'any', 'all-season']) => {
      const field = form.elements[name];
      const next = Array.isArray(value) ? value.join(', ') : String(value || '');
      if (!field || !next) return;
      if (!field.value || defaults.includes(field.value)) field.value = next;
    };
    setField('name', details.name);
    setField('category', details.category);
    setField('color', details.color);
    setField('fabric', details.fabric);
    setField('pattern', details.pattern);
    setField('formality', details.formality);
    setField('occasions', details.occasions);
    const detectedSeason = Array.isArray(details.season) ? details.season[0] : details.season;
    if (['summer', 'winter', 'monsoon', 'spring', 'autumn', 'all-season'].includes(String(detectedSeason || '').toLowerCase())) setSeason(String(detectedSeason).toLowerCase());
    const detectedTags = Array.isArray(details.tags) ? details.tags : String(details.tags || '').split(',');
    if (detectedTags.filter(Boolean).length) setTags([...new Set(detectedTags.map((tag) => String(tag).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 12));
  };

  const analyzeUpload = async (file, runId) => {
    setAnalyzing(true);
    setDetectedProfile(null);
    setMessage('Analyzing clothing photo...');
    try {
      const prepared = await prepareClosetItemPhoto(file);
      const form = new FormData();
      form.set('item', prepared);
      const data = await api('/closet/items/analyze', { method: 'POST', body: form });
      if (analysisRunRef.current !== runId) return;
      setDetectedProfile(data.visualProfile || null);
      applyDetectedDetails(data.details || {});
      setMessage('AI details detected. Review and save the item.');
    } catch (err) {
      if (analysisRunRef.current !== runId) return;
      setMessage(`Could not auto-detect details. ${err.message}`);
    } finally {
      if (analysisRunRef.current === runId) setAnalyzing(false);
    }
  };

  const selectUpload = (event) => {
    const file = event.currentTarget.files?.[0];
    const validationError = validateClosetUpload(file);
    if (file && validationError) {
      setUploadPreview('');
      setDetectedProfile(null);
      setAnalyzing(false);
      setMessage(validationError);
      event.currentTarget.value = '';
      return;
    }
    setUploadPreview(file ? URL.createObjectURL(file) : '');
    setDetectedProfile(null);
    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;
    if (file) analyzeUpload(file, runId);
    else {
      setAnalyzing(false);
      setMessage('');
    }
  };

  const submitUpload = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const chosenFile = form.get('item');
    const file = chosenFile?.name ? chosenFile : cameraRef.current?.files?.[0] || fileRef.current?.files?.[0];
    const validationError = validateClosetUpload(file?.name ? file : null);
    if (validationError) {
      setMessage(validationError);
      return;
    }
    if (!form.get('name')) form.set('name', file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
    if (detectedProfile) form.set('visualProfile', JSON.stringify(detectedProfile));
    setUploading(true);
    setMessage('Analyzing clothing photo and saving closet item...');
    try {
      form.set('item', await prepareClosetItemPhoto(file));
      const data = await api('/closet/items', { method: 'POST', body: form });
      setSavedItems((current) => [data.item, ...current].slice(0, 6));
      formRef.current?.reset();
      if (cameraRef.current) cameraRef.current.value = '';
      if (fileRef.current) fileRef.current.value = '';
      setUploadPreview('');
      setDetectedProfile(null);
      setSeason('summer');
      setTags([]);
      setTagInput('');
      setMessage('Item added to wardrobe.');
      window.setTimeout(() => {
        window.history.pushState({}, '', '/closet');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, 700);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setUploading(false);
    }
  };

  const discardDraft = () => {
    analysisRunRef.current += 1;
    formRef.current?.reset();
    if (fileRef.current) fileRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
    setUploadPreview('');
    setDetectedProfile(null);
    setAnalyzing(false);
    setMessage('');
    setSeason('summer');
    setTags([]);
    setTagInput('');
  };

  const addTag = () => {
    const nextTags = tagInput.split(',').map((tag) => tag.replace(/^#/, '').trim()).filter(Boolean);
    if (!nextTags.length) return;
    setTags((current) => [...new Set([...current, ...nextTags])].slice(0, 12));
    setTagInput('');
  };

  return (
    <main className="closet-add-page atelier-closet-add-page">
      <section className="wrap closet-add-hero atelier-closet-add-hero">
        <div>
          <h1>Curate Your Studio</h1>
          <p className="lead">Add a new piece to your digital archive. High-quality imagery ensures the most accurate AI-generated outfit recommendations and virtual try-ons.</p>
        </div>
      </section>

      <section className="wrap closet-add-layout atelier-closet-add-layout">
        <form ref={formRef} className="atelier-closet-add-form" onSubmit={submitUpload}>
          <div className="atelier-closet-upload-column">
            <label className={`atelier-closet-upload-zone ${uploadPreview ? 'has-preview' : ''}`}>
              <input ref={fileRef} name="item" type="file" accept="image/*" onChange={selectUpload} />
              {uploadPreview ? <img src={uploadPreview} alt="Closet item preview" /> : <span className="atelier-closet-upload-copy"><span className="atelier-closet-upload-icon"><SparkleLineIcon /></span><strong>Upload a garment photo</strong><small>Garment only, entire item visible, plain background</small><em>Avoid people wearing it, folded or cropped items, blur, and multiple garments</em></span>}
            </label>
            <div className="garment-upload-guidance closet-guidance" aria-label="Wardrobe garment photo guidance">
              <div><strong>Good photo</strong><span>Garment only</span><span>Entire garment visible</span><span>Plain background</span><span>Good lighting</span></div>
              <div><strong>Avoid</strong><span>Person wearing garment</span><span>Folded item</span><span>Cropped item</span><span>Blurry photo</span></div>
            </div>
            <input ref={cameraRef} className="camera-input" type="file" accept="image/*" capture="environment" onChange={selectUpload} />
            {savedItems.length > 0 && <div className="atelier-closet-recent"><span>Recently added</span>{savedItems.slice(0, 3).map((item) => <a href="/closet/items" key={item.id}><img src={item.imageUrl} alt={item.name} /></a>)}</div>}
          </div>

          <section className="atelier-closet-specifications">
            <header><span>Archive Entry: {categoryLabel(detectedProfile?.category || 'New Item')}</span><h2>Item Specifications</h2></header>
            <div className="atelier-closet-form-grid">
              <label><span>Dress Name</span><input name="name" placeholder="e.g. Moonlight Silk Slip" /></label>
              <label><span>Type</span><select name="category" defaultValue=""><option value="">Select type</option>{closetCategories.slice(1).map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="atelier-closet-color-field"><span>Color</span><div><i aria-hidden="true" /><input name="color" placeholder="Stone / Ivory" /></div></label>
              <label><span>Fabric</span><input name="fabric" placeholder="Silk, linen, cotton" /></label>
              <label><span>Pattern</span><input name="pattern" placeholder="Solid / Floral" /></label>
              <div className="atelier-closet-season"><span>Season</span><input name="season" type="hidden" value={season} readOnly /><div><button className={season === 'summer' || season === 'spring' ? 'active' : ''} type="button" onClick={() => setSeason('summer')}>Spring/Summer</button><button className={season === 'winter' || season === 'autumn' ? 'active' : ''} type="button" onClick={() => setSeason('winter')}>Autumn/Winter</button></div></div>
              <label><span>Vibe</span><select name="formality" defaultValue="any"><option value="any">Select vibe</option><option value="casual">Casual</option><option value="smart-casual">Smart Casual</option><option value="formal">Elegant</option><option value="party">Party</option><option value="active">Active</option></select></label>
              <label><span>Occasion</span><input name="occasions" placeholder="Evening, Work, Wedding" /></label>
            </div>
            <div className="atelier-closet-tags"><span>Metadata Tags</span><div className="atelier-closet-tag-list">{tags.map((tag) => <button type="button" key={tag} onClick={() => setTags((current) => current.filter((item) => item !== tag))}>#{tag} <b aria-hidden="true">x</b></button>)}</div><input type="hidden" name="tags" value={tags.join(', ')} readOnly /><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } }} placeholder="Press Enter to add tags..." /></div>
            <footer><button className="atelier-closet-discard" type="button" onClick={discardDraft}>Discard Draft</button><button className="atelier-closet-save" type="submit" disabled={uploading || analyzing}>{uploading ? 'Saving...' : analyzing ? 'Detecting Details...' : 'Save Clothing Item'}</button></footer>
            {message && <p className={`form-message ${/error|missing|failed|could not|cannot|upload/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
          </section>
        </form>
      </section>
    </main>
  );
}

function TryOnGenerating({ text = 'Try-on is being generated', active = true }) {
  const [visible, setVisible] = useState(active);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setComplete(false);
      return undefined;
    }

    if (!visible) return undefined;
    setComplete(true);
    const timer = window.setTimeout(() => setVisible(false), 2200);
    return () => window.clearTimeout(timer);
  }, [active, visible]);

  if (!visible) return null;

  return (
    <div className="tryon-generating" role="status" aria-live="polite" aria-label={text}>
      <ShaderBackground className="tryon-shader-background" complete={complete} />
    </div>
  );
}

function ProductGridSkeleton({ count = 8 }) {
  return (
    <div className="product-grid skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <article className="product-card product-skeleton" key={index}>
          <div className="skeleton-media" />
          <div className="product-info">
            <span className="skeleton-line wide" />
            <span className="skeleton-line medium" />
            <span className="skeleton-line short" />
          </div>
        </article>
      ))}
    </div>
  );
}

function ProductDetailSkeleton() {
  return (
    <main className="product-page" aria-busy="true">
      <p className="sr-only" role="status">Loading product...</p>
      <section className="wrap product-detail">
        <div className="product-detail-grid product-detail-skeleton" aria-hidden="true">
          <div className="skeleton-detail-media" />
          <div className="product-summary">
            <span className="skeleton-line short" />
            <span className="skeleton-line title" />
            <span className="skeleton-line wide" />
            <span className="skeleton-line medium" />
            <div className="product-detail-facts">
              {Array.from({ length: 4 }).map((_, index) => <span className="skeleton-box" key={index} />)}
            </div>
            <span className="skeleton-line wide" />
            <span className="skeleton-line medium" />
          </div>
        </div>
      </section>
    </main>
  );
}

function SearchPage({ user, setUser, tryOnMode = false, demoEcommerceMode = false }) {
  const params = new URLSearchParams(window.location.search);
  const q = normalizeSearchQuery(params.get('q') || '');
  const tag = params.get('tag') || '';
  const category = params.get('category') || '';
  const brand = params.get('brand') || '';
  const gender = params.get('gender') || '';
  const sort = params.get('sort') || '';
  const newArrival = params.get('newArrival') || '';
  const state = useProducts({ q, tag, category, brand, gender, sort, newArrival, limit: 60 });
  const [tryOns, setTryOns] = useTryOnCache(user, state.products);
  const [tryOnLoading, setTryOnLoading] = useState({});
  const [tryOnVideoLoading, setTryOnVideoLoading] = useState({});
  const [tryOnErrors, setTryOnErrors] = useState({});
  const [tryOnVideoErrors, setTryOnVideoErrors] = useState({});
  const [continueWithoutTryOn, setContinueWithoutTryOn] = useState(false);
  const autoTryOnStarted = useRef('');
  const searchEventStarted = useRef('');
  const hasSearchIntent = Boolean(q);
  const allowTryOnTrial = Boolean(user) && !continueWithoutTryOn && (tryOnMode || hasSearchIntent);
  const shouldAutoGenerate = Boolean(user) && !continueWithoutTryOn && hasSearchIntent && !tryOnMode;
  const trialProducts = state.products.slice(0, 4);
  const visibleProducts = allowTryOnTrial ? trialProducts : state.products;
  const lockedProducts = allowTryOnTrial ? state.products.slice(4, 12) : [];
  const title = tryOnMode ? 'AI Try-On' : q || tag || category || brand || gender || (newArrival ? 'New Arrivals' : 'All Products');
  const filterValues = { q, tag, category, brand, gender, sort, newArrival };
  const shownCount = visibleProducts.length + lockedProducts.length;
  const resultsLabel = state.loading ? 'Searching...' : `${state.total} Products`;
  const listingMode = tryOnMode ? 'AI Try-On Studio' : hasSearchIntent ? 'Search Results' : category ? 'Category View' : 'Product Listing';

  const generateTryOn = async (product, options = {}) => {
    const profileBlockMessage = tryOnProfileBlockMessage(user);
    if (profileBlockMessage) {
      setTryOnErrors((current) => ({ ...current, [product.id]: profileBlockMessage }));
      return;
    }
    setTryOnLoading((current) => ({ ...current, [product.id]: true }));
    setTryOnErrors((current) => ({ ...current, [product.id]: '' }));
    try {
      const data = await generateQueuedTryOn(`/tryons/${product.id}`, {
        method: 'POST',
        timeout: AI_IMAGE_TIMEOUT_MS,
        body: options.force ? JSON.stringify({ force: true }) : undefined
      });
      setTryOns((current) => ({ ...current, [product.id]: data.tryOn }));
      recordEvent('try_on', { productId: product.id, metadata: { regenerated: Boolean(options.force) } });
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
    } catch (err) {
      setTryOnErrors((current) => ({ ...current, [product.id]: err.message }));
    } finally {
      setTryOnLoading((current) => ({ ...current, [product.id]: false }));
    }
  };

  const generateTryOnVideo = async (product, options = {}) => {
    setTryOnVideoLoading((current) => ({ ...current, [product.id]: true }));
    setTryOnVideoErrors((current) => ({ ...current, [product.id]: '' }));
    try {
      const data = await api(`/tryons/${product.id}/video`, {
        method: 'POST',
        timeout: AI_VIDEO_TIMEOUT_MS,
        body: options.force ? JSON.stringify({ force: true }) : undefined
      });
      setTryOns((current) => ({ ...current, [product.id]: data.tryOn }));
      recordEvent('try_on', { productId: product.id, metadata: { video: true, regenerated: Boolean(options.force) } });
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
    } catch (err) {
      setTryOnVideoErrors((current) => ({ ...current, [product.id]: err.message }));
    } finally {
      setTryOnVideoLoading((current) => ({ ...current, [product.id]: false }));
    }
  };

  useEffect(() => {
    if (!user) return;
    const key = JSON.stringify({ q, tag, category, brand, gender, sort, newArrival });
    if (searchEventStarted.current === key) return;
    searchEventStarted.current = key;
    if (q) recordEvent('search', { query: q, metadata: { tag, category, brand, gender, sort, newArrival } });
    else if (tag || category || brand || gender || newArrival) recordEvent('filter', { metadata: { tag, category, brand, gender, sort, newArrival } });
  }, [user, q, tag, category, brand, gender, sort, newArrival]);

  useEffect(() => {
    if (!shouldAutoGenerate || trialProducts.length === 0) return;
    const runKey = trialProducts.map((product) => product.id).join(',');
    if (autoTryOnStarted.current === runKey) return;
    autoTryOnStarted.current = runKey;

    const missingProducts = trialProducts.filter((product) => !tryOns[product.id]);
    Promise.allSettled(missingProducts.map((product) => generateTryOn(product)));
  }, [shouldAutoGenerate, trialProducts.map((product) => product.id).join(','), Object.keys(tryOns).join(',')]);

  return (
    <main className="product-listing-page">
      <section className="listing-hero">
        <OptimizedImage className="listing-hero-bg" src={asset('hero2.png')} alt="" eager />
        <div className="listing-hero-scrim" aria-hidden="true" />
        <div className="wrap listing-hero-inner">
          <div>
            <p className="listing-kicker">{listingMode}</p>
            <h1>{title}</h1>
            <p className="listing-copy">Discover live catalog pieces, tune filters, and open any product for AI try-on previews.</p>
          </div>
          <div className="listing-hero-panel" aria-label="Product listing summary">
            <span>{resultsLabel}</span>
            <span>{state.loading ? 'Preparing grid' : `Showing ${shownCount || 0}`}</span>
          </div>
        </div>
      </section>

      <section className="wrap listing-toolbar" aria-label="Product listing tools">
        <ListingCategoryChips facets={state.facets} values={filterValues} />
        <form className="listing-sort-form" action="/categories">
          {q && <input type="hidden" name="q" value={q} />}
          {tag && <input type="hidden" name="tag" value={tag} />}
          {category && <input type="hidden" name="category" value={category} />}
          {brand && <input type="hidden" name="brand" value={brand} />}
          {gender && <input type="hidden" name="gender" value={gender} />}
          {newArrival && <input type="hidden" name="newArrival" value={newArrival} />}
          <label><span>Sort</span><select name="sort" defaultValue={sort} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
              <option value="">Most relevant</option>
              <option value="newest">Newest</option>
              <option value="price-asc">Price low to high</option>
              <option value="price-desc">Price high to low</option>
            </select></label>
        </form>
      </section>

      <section className="wrap results-shell">
        <div className="results-main">
          <div className="results-head">
            <div><h2>{title}</h2><p className="count" aria-live="polite">{resultsLabel}</p></div>
          </div>
          <ActiveFilterChips values={filterValues} />
          <FilterPanel className="mobile-filters" facets={state.facets} values={filterValues} />
          {state.loading && <ProductGridSkeleton count={8} />}
          {state.error && <StatusPanel text={state.error} onRetry={state.retry} />}
          {!state.loading && !state.error && state.products.length === 0 && <EmptyProducts search={title} />}
          {!state.loading && !state.error && state.products.length > 0 && (
            <div className="product-grid">
              {visibleProducts.map((product, index) => <ProductCard key={product.id} product={product} user={user} tryOn={tryOns[product.id]} canTryOn={allowTryOnTrial && index < 4} demoEcommerceMode={demoEcommerceMode} tryOnLoading={Boolean(tryOnLoading[product.id])} tryOnVideoLoading={Boolean(tryOnVideoLoading[product.id])} tryOnError={tryOnErrors[product.id]} tryOnVideoError={tryOnVideoErrors[product.id]} onTryOn={generateTryOn} onTryOnVideo={generateTryOnVideo} />)}
              {lockedProducts.length > 0 && (
                <div className="locked-row">
                  {lockedProducts.map((product) => <ProductCard key={`locked-${product.id}`} product={product} locked />)}
                  {user ? (
                    <div className="locked-content"><div><div className="lock-icon">▢</div><p className="locked-title">More AI try-ons are token gated</p><p className="locked-copy">Use the first row for trial previews, buy more tokens, or continue browsing regular product photos.</p><div className="locked-actions"><a className="buy" href="/tokens">Buy More Tokens</a><button className="browse" type="button" onClick={() => setContinueWithoutTryOn(true)}>Continue Without Try-On</button></div></div></div>
                  ) : (
                    <div className="locked-content"><div><div className="lock-icon">▢</div><p className="locked-title">AI try-on previews are locked</p><p className="locked-copy">Create a profile to see more products and generate try-on previews.</p><div className="locked-actions"><a className="buy" href="/signup">Create Profile</a><a className="browse" href="/categories">Browse Without Try-On</a></div></div></div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <FilterPanel className="desktop-filters" facets={state.facets} values={filterValues} />
      </section>
    </main>
  );
}

function readWishlistProductIds() {
  const keys = ['fitlook_wishlist', 'fitlook_wishlist_ids', 'fitlook:wishlist', 'wishlist'];
  const ids = [];

  keys.forEach((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (typeof entry === 'string' || typeof entry === 'number') ids.push(String(entry));
          else if (entry?.productId || entry?.id || entry?._id) ids.push(String(entry.productId || entry.id || entry._id));
        });
      } else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([id, saved]) => {
          if (saved) ids.push(String(id));
        });
      }
    } catch {
      raw.split(',').map((id) => id.trim()).filter(Boolean).forEach((id) => ids.push(id));
    }
  });

  try {
    const snapshots = JSON.parse(localStorage.getItem('fitlook_wishlist_products') || '{}');
    if (snapshots && typeof snapshots === 'object' && !Array.isArray(snapshots)) {
      Object.keys(snapshots).filter(Boolean).forEach((id) => ids.push(String(id)));
    }
  } catch {}

  return [...new Set(ids)];
}

function writeWishlistProductIds(ids) {
  const normalizedIds = [...new Set((ids || []).map(String).filter(Boolean))];
  ['fitlook_wishlist', 'fitlook_wishlist_ids', 'fitlook:wishlist', 'wishlist'].forEach((key) => {
    localStorage.setItem(key, JSON.stringify(normalizedIds));
  });
}

function readWishlistProductSnapshots() {
  const snapshots = {};
  try {
    const stored = JSON.parse(localStorage.getItem('fitlook_wishlist_products') || '{}');
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) Object.assign(snapshots, stored);
  } catch {}

  for (const key of ['fitlook_wishlist', 'fitlook_wishlist_ids', 'fitlook:wishlist', 'wishlist']) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (!Array.isArray(value)) continue;
      value.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const product = entry.product && typeof entry.product === 'object' ? entry.product : entry;
        const id = wishlistProductId(product) || String(entry.productId || '');
        if (id) snapshots[id] = { ...product, id };
      });
    } catch {}
  }

  return snapshots;
}

function writeWishlistProductSnapshot(product) {
  const id = wishlistProductId(product);
  if (!id || !product) return;
  const snapshots = readWishlistProductSnapshots();
  snapshots[id] = {
    id,
    _id: product._id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    imageUrl: product.imageUrl,
    price: product.price,
    currency: product.currency,
    compareAtPrice: product.compareAtPrice,
    affiliateLink: product.affiliateLink,
    rating: product.rating,
    ratingCount: product.ratingCount,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  };
  localStorage.setItem('fitlook_wishlist_products', JSON.stringify(snapshots));
}

function removeWishlistProductSnapshot(id) {
  const snapshots = readWishlistProductSnapshots();
  delete snapshots[String(id || '')];
  localStorage.setItem('fitlook_wishlist_products', JSON.stringify(snapshots));
}

function toggleWishlistProductId(productOrId) {
  const product = productOrId && typeof productOrId === 'object' ? productOrId : null;
  const id = product ? wishlistProductId(product) : String(productOrId || '');
  if (!id) return false;
  const current = readWishlistProductIds();
  const isSaved = current.includes(id);
  const saved = !isSaved;
  writeWishlistProductIds(saved ? [...current, id] : current.filter((item) => item !== id));
  if (saved && product) writeWishlistProductSnapshot(product);
  if (!saved) removeWishlistProductSnapshot(id);
  window.dispatchEvent(new CustomEvent('fitlook:wishlist-change', { detail: { id, saved } }));
  if (readAuthToken()) {
    api(`/auth/wishlist/${encodeURIComponent(id)}`, { method: saved ? 'PUT' : 'DELETE' })
      .catch(() => announce('Wishlist saved on this device. Account sync will retry when the connection is available.', 'error'));
  }
  return saved;
}

function wishlistProductId(product) {
  return String(product?.id || product?._id || '');
}

function WishlistHeartButton({ product, className = '' }) {
  const id = wishlistProductId(product);
  const [isSaved, setIsSaved] = useState(() => (id ? readWishlistProductIds().includes(id) : false));

  useEffect(() => {
    if (!id) return undefined;
    const sync = (event) => {
      const ids = event.detail?.ids;
      if (Array.isArray(ids)) setIsSaved(ids.map(String).includes(id));
      else if (String(event.detail?.id || '') === id) setIsSaved(Boolean(event.detail?.saved));
    };
    const syncFromStorage = () => setIsSaved(readWishlistProductIds().includes(id));
    setIsSaved(readWishlistProductIds().includes(id));
    window.addEventListener('fitlook:wishlist-change', sync);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener('fitlook:wishlist-change', sync);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, [id]);

  if (!id) return null;

  const toggle = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const saved = toggleWishlistProductId(product);
    setIsSaved(saved);
    announce(saved ? `${product.name} saved to your wishlist.` : `${product.name} removed from your wishlist.`);
  };

  return (
    <button
      className={`${className} ${isSaved ? 'saved' : ''}`.trim()}
      type="button"
      aria-label={isSaved ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}
      aria-pressed={isSaved}
      title={isSaved ? 'Remove from wishlist' : 'Save to wishlist'}
      onClick={toggle}
    >
      <HeartIcon />
    </button>
  );
}

function readWishlistCollections() {
  try {
    const collections = JSON.parse(localStorage.getItem('fitlook_wishlist_collections') || '[]');
    if (!Array.isArray(collections)) return [];
    return collections
      .map((collection) => ({
        id: String(collection?.id || ''),
        label: cleanDisplayText(collection?.label, ''),
        productIds: [...new Set((collection?.productIds || []).map(String).filter(Boolean))]
      }))
      .filter((collection) => collection.id && collection.label);
  } catch {
    return [];
  }
}

function WishlistPage({ user, demoEcommerceMode = false }) {
  const [wishlistIds, setWishlistIds] = useState(() => readWishlistProductIds());
  const [savedCollections, setSavedCollections] = useState(() => readWishlistCollections());
  const [activeCollection, setActiveCollection] = useState('all');
  const [sort, setSort] = useState('recent');
  const [view, setView] = useState('grid');
  const [shareStatus, setShareStatus] = useState('');
  const [undoRemoval, setUndoRemoval] = useState(null);
  const wishlistState = useWishlistProducts(wishlistIds, user?.id || '');
  const wishlistProducts = wishlistState.products || [];
  const showWishlistTools = wishlistIds.length > 0 || wishlistProducts.length > 0;
  const isLoadingWishlist = wishlistState.loading && Boolean(user || wishlistIds.length > 0);
  const collections = useMemo(() => {
    const byCategory = new Map();
    wishlistProducts.forEach((product) => {
      const category = displayCategory(product);
      const key = `category-${categorySlug(category)}`;
      const existing = byCategory.get(key) || { id: key, label: category, kind: 'category', category, productIds: [] };
      existing.productIds.push(wishlistProductId(product));
      byCategory.set(key, existing);
    });
    return [
      { id: 'all', label: 'All items', kind: 'all', productIds: wishlistProducts.map(wishlistProductId) },
      ...[...byCategory.values()].sort((a, b) => a.label.localeCompare(b.label)),
      ...savedCollections.map((collection) => ({ ...collection, kind: 'saved' }))
    ];
  }, [savedCollections, wishlistProducts]);
  const activeCollectionData = collections.find((collection) => collection.id === activeCollection) || collections[0];
  const visibleWishlistProducts = useMemo(() => {
    const collectionIds = new Set(activeCollectionData?.productIds || []);
    const visible = activeCollectionData?.kind === 'all'
      ? [...wishlistProducts]
      : wishlistProducts.filter((product) => collectionIds.has(wishlistProductId(product)));
    return visible.sort((a, b) => {
      if (sort === 'price-low') return Number(a.price || 0) - Number(b.price || 0);
      if (sort === 'price-high') return Number(b.price || 0) - Number(a.price || 0);
      if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
      return new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0);
    });
  }, [activeCollectionData, sort, wishlistProducts]);

  useEffect(() => {
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  }, []);

  useEffect(() => {
    if (activeCollection !== 'all' && !collections.some((collection) => collection.id === activeCollection)) setActiveCollection('all');
  }, [activeCollection, collections]);

  useEffect(() => {
    if (!undoRemoval) return undefined;
    const timer = window.setTimeout(() => setUndoRemoval(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undoRemoval]);

  useEffect(() => {
    const syncWishlist = () => setWishlistIds(readWishlistProductIds());
    window.addEventListener('fitlook:wishlist-change', syncWishlist);
    window.addEventListener('storage', syncWishlist);
    return () => {
      window.removeEventListener('fitlook:wishlist-change', syncWishlist);
      window.removeEventListener('storage', syncWishlist);
    };
  }, []);

  const removeFromWishlist = (product) => {
    const id = wishlistProductId(product);
    const previousIds = [...wishlistIds];
    const stillSaved = toggleWishlistProductId(product);
    if (stillSaved) return;
    setWishlistIds(previousIds.filter((wishlistId) => wishlistId !== id));
    announce(`${product.name} removed from your wishlist.`);
    setUndoRemoval({ id, name: product.name, product, previousIds });
  };
  const restoreRemoval = () => {
    if (!undoRemoval) return;
    const saved = toggleWishlistProductId(undoRemoval.product);
    if (!saved) return;
    setWishlistIds(undoRemoval.previousIds);
    announce(`${undoRemoval.name} restored to your wishlist.`);
    setUndoRemoval(null);
  };
  const createCollection = () => {
    const label = cleanDisplayText(window.prompt('Name this collection') || '', '');
    if (!label) return;
    const collection = {
      id: `collection-${Date.now()}`,
      label,
      productIds: [...wishlistIds]
    };
    const nextCollections = [...savedCollections, collection];
    localStorage.setItem('fitlook_wishlist_collections', JSON.stringify(nextCollections));
    setSavedCollections(nextCollections);
    setActiveCollection(collection.id);
  };
  const shareWishlist = async () => {
    const shareData = { title: 'My Lookmefy Wishlist', text: 'See my saved Lookmefy edit.', url: window.location.href };
    try {
      if (navigator.share) await navigator.share(shareData);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(shareData.url);
      setShareStatus(navigator.share ? 'Wishlist shared.' : 'Wishlist link copied.');
    } catch (error) {
      if (error?.name !== 'AbortError') setShareStatus('Could not share this wishlist.');
    }
  };

  return (
    <main className="wishlist-page wishlist-reference-page">
      <section className="wrap wishlist-reference-shell" aria-label="Wishlist">
        {!showWishlistTools && <h1 className="sr-only">My Wishlist</h1>}
        {showWishlistTools && (
          <header className="wishlist-reference-head">
            <div>
              <h1>My Wishlist <span>({wishlistProducts.length || wishlistIds.length})</span></h1>
              <p>Your saved edit.</p>
            </div>
            <div className="wishlist-reference-head-actions">
              <button className="wishlist-outline-action" type="button" onClick={createCollection}>+ Create Collection</button>
              <button className="wishlist-outline-action" type="button" onClick={shareWishlist}>↗ Share Wishlist</button>
            </div>
          </header>
        )}
        {shareStatus && <p className="wishlist-share-status" role="status">{shareStatus}</p>}
        {undoRemoval && <div className="wishlist-undo-toast" role="status" aria-live="polite"><span>Removed {undoRemoval.name}.</span><button type="button" onClick={restoreRemoval}>Undo</button></div>}

        {showWishlistTools && (
          <div className="wishlist-reference-toolbar">
            <div className="wishlist-collection-tabs" role="tablist" aria-label="Wishlist collections">
              {collections.map((collection) => (
                <button
                  className={activeCollection === collection.id ? 'active' : ''}
                  type="button"
                  role="tab"
                  aria-selected={activeCollection === collection.id}
                  onClick={() => setActiveCollection(collection.id)}
                  key={collection.id}
                >
                  {collection.label}<span>{collection.productIds.length}</span>
                </button>
              ))}
            </div>
            <div className="wishlist-reference-controls">
              <label className="wishlist-sort-control"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">Recently added</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="name">Name</option></select></label>
              <div className="wishlist-view-toggle" role="group" aria-label="Wishlist view">
                <button type="button" className={view === 'grid' ? 'active' : ''} aria-label="Grid view" title="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><GridIcon /></button>
                <button type="button" className={view === 'list' ? 'active' : ''} aria-label="List view" title="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><ListIcon /></button>
              </div>
            </div>
          </div>
        )}

        <section className="wishlist-reference-products" aria-label="Saved products">
          {isLoadingWishlist && <ProductGridSkeleton count={8} />}
          {wishlistState.error && wishlistIds.length > 0 && <StatusPanel text={wishlistState.error} onRetry={wishlistState.retry} />}
          {!isLoadingWishlist && !wishlistState.error && visibleWishlistProducts.length > 0 && (
            <div className={`wishlist-reference-grid ${view === 'list' ? 'is-list' : ''}`}>
              {visibleWishlistProducts.map((product) => <WishlistProductCard key={wishlistProductId(product)} product={product} user={user} demoEcommerceMode={demoEcommerceMode} onRemove={() => removeFromWishlist(product)} />)}
            </div>
          )}
          {!isLoadingWishlist && !wishlistState.error && wishlistIds.length === 0 && (
            <section className="wishlist-reference-empty" aria-label="Empty wishlist">
              <div><h2>Your wishlist is waiting.</h2><p>Save pieces from the catalog and they will appear here.</p></div>
              <a href="/categories">Explore products</a>
            </section>
          )}
          {!isLoadingWishlist && !wishlistState.error && wishlistIds.length > 0 && wishlistProducts.length === 0 && (
            <section className="wishlist-reference-empty" aria-label="Saved products unavailable">
              <div><h2>Saved items are syncing.</h2><p>We found saved products in your wishlist, but the live catalog did not return them yet.</p></div>
              <button type="button" onClick={wishlistState.retry}>Retry wishlist</button>
            </section>
          )}
          {!isLoadingWishlist && !wishlistState.error && wishlistProducts.length > 0 && visibleWishlistProducts.length === 0 && (
            <section className="wishlist-reference-empty" aria-label="Empty collection">
              <div><h2>This collection is empty.</h2><p>Choose another collection to see your saved products.</p></div>
              <button type="button" onClick={() => setActiveCollection('all')}>Show all items</button>
            </section>
          )}
        </section>

        <section className="wishlist-reference-upgrade" aria-label="AI try-on tokens">
          <span className="wishlist-upgrade-icon"><SparkleLineIcon /></span>
          <div><h2>Try on more looks</h2><p>{user ? `${user.tokens} tokens are ready for your next preview.` : 'Create a profile to unlock personalized AI try-on previews.'}</p></div>
          <a href={user ? '/tokens' : '/signup'}>{user ? 'Explore Tokens' : 'Create Profile'}</a>
        </section>
      </section>
    </main>
  );
}

function WishlistProductCard({ product, user, demoEcommerceMode = false, onRemove }) {
  const id = wishlistProductId(product);
  const detailHref = `/product/${encodeURIComponent(id)}`;
  const checkoutHref = `/checkout?productId=${encodeURIComponent(id)}`;
  const authBuyHref = `/signup?return=${encodeURIComponent(checkoutHref)}`;
  const shopHref = demoEcommerceMode ? (user ? checkoutHref : authBuyHref) : (product.affiliateLink || detailHref);
  const isExternalShop = Boolean(!demoEcommerceMode && product.affiliateLink);
  const actionLabel = demoEcommerceMode ? (user ? 'Buy now' : 'Sign up to buy') : isExternalShop ? 'Move to Bag' : 'View Product';
  const actionEvent = demoEcommerceMode ? (user ? 'buy_now_click' : 'buy_auth_prompt') : (isExternalShop ? 'shop_click' : 'product_click');
  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;

  return (
    <article className="wishlist-reference-card">
      <div className="wishlist-reference-card-media">
        <a href={detailHref} onClick={() => recordEvent('product_click', { productId: id })}><OptimizedImage src={product.imageUrl || asset('hero2.png')} alt={product.name} onError={(event) => { event.currentTarget.src = asset('hero2.png'); }} /></a>
        <button className="card-wishlist-heart saved wishlist-remove-heart" type="button" aria-label={`Remove ${product.name} from wishlist`} aria-pressed={true} title="Remove from wishlist" onClick={onRemove}><HeartIcon /></button>
      </div>
      <div className="wishlist-reference-card-copy">
        <p>{displayBrand(product)}</p>
        <a href={detailHref} onClick={() => recordEvent('product_click', { productId: id })}><h3>{product.name}</h3></a>
        <div><strong>{formatMoney(product.price || 0, product.currency)}</strong>{hasDiscount && <s>{formatMoney(product.compareAtPrice, product.currency)}</s>}</div>
      </div>
      <a className="wishlist-reference-card-action" href={shopHref} target={isExternalShop ? '_blank' : undefined} rel={isExternalShop ? 'noreferrer' : undefined} onClick={() => recordEvent(actionEvent, { productId: id })}>{actionLabel} <span>→</span></a>
    </article>
  );
}

function CustomTryOnPage({ user, setUser }) {
  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  return (
    <main className="custom-tryon-page">
      <section className="wrap custom-tryon-hero">
        <h1>Custom Try-On</h1>
        <p className="lead">Transform your digital wardrobe. Upload a flat garment photo and our AI will render it onto your saved model contextually.</p>
      </section>
      <CustomClothingTryOn user={user} setUser={setUser} />
      <CustomTryOnConfidence user={user} />
    </main>
  );
}

function CustomClothingTryOn({ user, setUser }) {
  const fileRef = useRef(null);
  const generationControllerRef = useRef(null);
  const generationInFlightRef = useRef(false);
  const generationRunRef = useRef(0);
  const [garmentFile, setGarmentFile] = useState(null);
  const [garmentPreview, setGarmentPreview] = useState('');
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [previewMode, setPreviewMode] = useState('garment');

  useEffect(() => () => {
    generationControllerRef.current?.abort();
  }, []);

  useEffect(() => () => {
    if (garmentPreview.startsWith('blob:')) URL.revokeObjectURL(garmentPreview);
  }, [garmentPreview]);

  const validateGarmentFile = (file) => {
    if (!file) return 'Upload a garment image before continuing.';
    const name = String(file.name || '');
    const type = String(file.type || '').toLowerCase();
    const supported = type.startsWith('image/') || /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i.test(name);
    if (!supported || type === 'image/svg+xml' || /\.svg$/i.test(name)) return 'Upload a JPG, PNG, WebP, AVIF, HEIC, or HEIF garment photo.';
    if (file.size > MAX_BODY_PHOTO_BYTES) return 'This garment photo is too large. Choose an image under 8 MB.';
    if (file.size === 0) return 'This garment photo appears corrupted. Choose a different image.';
    return '';
  };

  const isValidImageFile = (file) => !validateGarmentFile(file);

  const clearFileInput = () => {
    if (fileRef.current) fileRef.current.value = '';
  };

  const abortActiveGeneration = () => {
    generationControllerRef.current?.abort();
    generationControllerRef.current = null;
    generationInFlightRef.current = false;
    setLoading(false);
  };

  const clearGarment = () => {
    generationRunRef.current += 1;
    abortActiveGeneration();
    setResult(null);
    setMessage('');
    setPreviewMode('garment');
    setGarmentFile(null);
    setGarmentPreview('');
    clearFileInput();
  };

  const setGarmentFromFile = (file) => {
    generationRunRef.current += 1;
    abortActiveGeneration();
    setResult(null);
    setMessage('');
    setPreviewMode('garment');
    if (!file) {
      setGarmentFile(null);
      setGarmentPreview('');
      clearFileInput();
      return;
    }
    const validationError = validateGarmentFile(file);
    if (validationError) {
      setGarmentFile(null);
      setGarmentPreview('');
      setMessage(validationError);
      clearFileInput();
      return;
    }
    setGarmentFile(file);
    setGarmentPreview(URL.createObjectURL(file));
  };

  const chooseGarment = (event) => {
    setGarmentFromFile(event.currentTarget.files?.[0]);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    setDragActive(true);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    setGarmentFromFile(event.dataTransfer.files?.[0]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (generationInFlightRef.current) return;
    const file = garmentFile || fileRef.current?.files?.[0];
    if (!file) {
      setMessage('Upload a garment image before continuing.');
      return;
    }
    const validationError = validateGarmentFile(file);
    if (validationError) {
      setMessage(validationError);
      clearFileInput();
      return;
    }
    generationInFlightRef.current = true;
    const generationRun = generationRunRef.current + 1;
    generationRunRef.current = generationRun;
    setLoading(true);
    setMessage('Preparing your try-on...');
    setResult(null);
    setPreviewMode('garment');
    const controller = new AbortController();
    generationControllerRef.current = controller;
    try {
      const form = new FormData();
      form.append('garment', file);
      const data = await api('/tryons/custom', { method: 'POST', body: form, timeout: AI_IMAGE_TIMEOUT_MS, signal: controller.signal });
      if (generationRunRef.current !== generationRun) return;
      setResult(data.tryOn);
      setPreviewMode('result');
      recordEvent('custom_tryon');
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
      setMessage(`Custom try-on ready. ${Number(data.user?.tokens ?? user?.tokens ?? 0)} credits remaining.`);
    } catch (err) {
      if (generationRunRef.current !== generationRun) return;
      if (err.name === 'AbortError') setMessage('Generation canceled. Your garment photo is ready to try again.');
      else setMessage('We couldn\'t create this try-on. Try a clearer garment-only photo.');
    } finally {
      if (generationControllerRef.current === controller) {
        generationControllerRef.current = null;
        generationInFlightRef.current = false;
        setLoading(false);
      }
    }
  };

  const cancelGeneration = () => generationControllerRef.current?.abort();
  const resultImageUrl = protectedMediaUrl(result?.imageUrl || '');
  const showingGeneratedPreview = previewMode === 'result' && Boolean(resultImageUrl);
  const selectedPreviewSrc = showingGeneratedPreview ? resultImageUrl : garmentPreview;
  const selectedPreviewTitle = showingGeneratedPreview ? 'Generated Try-On' : 'Garment Preview';
  const selectedPreviewTone = showingGeneratedPreview ? 'AI Powered' : 'Original Upload';
  const mobilePreviewTone = showingGeneratedPreview ? 'AI generated result' : 'Original upload';
  const selectedPreviewAlt = showingGeneratedPreview ? 'Generated custom try-on' : 'Uploaded garment preview';

  return (
    <>
      <section className="wrap custom-tryon">
        <form className="custom-tryon-panel" onSubmit={submit}>
          <label
            className={`upload-box custom-upload ${dragActive ? 'drag-active' : ''}`}
            onDragEnter={handleDragOver}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            <input ref={fileRef} name="garment" type="file" accept="image/*" onChange={chooseGarment} />
            <span className="custom-upload-content">
              <span className="upload-icon"><UploadCloudIcon /></span>
              <span className="upload-title">Upload a garment photo</span>
              <span className="upload-help">Garment only, entire item visible, plain background, good lighting and sharp image</span>
              <span className="upload-action">Browse files</span>
            </span>
          </label>
          <div className="garment-upload-guidance" aria-label="Garment photo guidance">
            <div><strong>Good photo</strong><span>Garment only</span><span>Entire garment visible</span><span>Plain background</span><span>Good lighting</span><span>Sharp image</span></div>
            <div><strong>Avoid</strong><span>Person wearing garment</span><span>Folded item</span><span>Cropped item</span><span>Blurry photo</span><span>Multiple garments</span></div>
          </div>
          {garmentPreview && <button className="custom-upload-remove" type="button" onClick={clearGarment} disabled={loading}>Remove upload</button>}
          <div className="custom-tryon-mobile-action">
            <button className="submit" type="submit" disabled={loading}>{loading ? 'Generating...' : 'Generate Custom Try-On'}</button>
            <span>{user?.tokens ?? 0} Credits Left</span>
          </div>
          <div className="custom-preview-grid custom-preview-grid-desktop" aria-label="Custom try-on preview comparison">
            <article className="custom-preview-card">
              <header className="custom-preview-label">
                <strong>Garment Preview</strong>
                <span>Original Upload</span>
              </header>
              <div className={`custom-preview garment ${garmentPreview ? 'has-image' : ''}`}>
                {garmentPreview ? <ZoomableImage src={garmentPreview} alt="Uploaded garment preview" /> : <span>Preview</span>}
              </div>
            </article>

            <div className="custom-preview-bridge" aria-hidden="true"><SparkleLineIcon /></div>

            <article className="custom-preview-card">
              <header className="custom-preview-label">
                <strong>Generated Try-On</strong>
                <span>AI Powered</span>
              </header>
              <div className={`custom-preview result ${resultImageUrl ? 'has-image' : ''}`}>
                <TryOnGenerating active={loading} text="Rendering try-on" />
                {resultImageUrl ? (
                  <>
                    <ZoomableImage
                      src={resultImageUrl}
                      alt="Generated custom try-on"
                      onOpen={() => setFullscreenImage({ src: resultImageUrl, alt: 'Generated custom try-on', title: 'Custom Try-On' })}
                    />
                    <button className="fullscreen-button" type="button" aria-label="Open generated image full screen" title="Open full screen" onClick={() => setFullscreenImage({ src: resultImageUrl, alt: 'Generated custom try-on', title: 'Custom Try-On' })}><FullscreenIcon /></button>
                  </>
                ) : <span>Preview</span>}
                <span className="custom-result-status">{loading ? 'Rendering preview' : resultImageUrl ? 'Custom try-on ready' : 'Ready for rendering'}</span>
              </div>
              {resultImageUrl && <AiPreviewDisclaimer className="custom-ai-disclaimer" />}
            </article>
          </div>

          <div className="custom-preview-grid custom-preview-grid-review custom-preview-grid-mobile" aria-label="Custom try-on preview review">
            <article className="custom-preview-card custom-preview-review-card">
              <header className="custom-preview-label">
                <strong><span className="desktop-preview-label">{selectedPreviewTitle}</span><span className="mobile-preview-label">Preview</span></strong>
                <span><span className="desktop-preview-label">{selectedPreviewTone}</span><span className="mobile-preview-label">{mobilePreviewTone}</span></span>
              </header>
              <div className={`custom-preview custom-review-preview ${showingGeneratedPreview ? 'result' : 'garment'} ${selectedPreviewSrc ? 'has-image' : ''}`}>
                <TryOnGenerating active={loading && !resultImageUrl} text="Rendering try-on" />
                {selectedPreviewSrc ? (
                  <>
                    <ZoomableImage
                      src={selectedPreviewSrc}
                      alt={selectedPreviewAlt}
                      onOpen={() => setFullscreenImage({ src: selectedPreviewSrc, alt: selectedPreviewAlt, title: selectedPreviewTitle })}
                    />
                    <button className="fullscreen-button" type="button" aria-label="Open preview image full screen" title="Open full screen" onClick={() => setFullscreenImage({ src: selectedPreviewSrc, alt: selectedPreviewAlt, title: selectedPreviewTitle })}><FullscreenIcon /></button>
                  </>
                ) : (
                  <span className="custom-review-empty">
                    <span className="custom-review-empty-icon"><UploadCloudIcon /></span>
                    <strong>Preview</strong>
                    <small>Upload or generate to compare your result</small>
                  </span>
                )}
                {(loading || resultImageUrl) && <span className="custom-result-status">{loading ? 'Rendering preview' : showingGeneratedPreview ? 'Custom try-on ready' : 'Original upload'}</span>}
              </div>
              <div className="custom-preview-chooser" aria-label="Choose preview image">
                <button className={previewMode === 'garment' ? 'active' : ''} type="button" disabled={!garmentPreview} onClick={() => setPreviewMode('garment')}>
                  <span>{garmentPreview ? <img src={garmentPreview} alt="" /> : <UploadCloudIcon />}</span>
                  <strong>Upload</strong>
                  <small>Original</small>
                </button>
                <button className={previewMode === 'result' ? 'active' : ''} type="button" disabled={!result?.imageUrl} onClick={() => setPreviewMode('result')}>
                  <span>{resultImageUrl ? <img src={resultImageUrl} alt="" /> : <SparkleLineIcon />}</span>
                  <strong>Final</strong>
                  <small>{loading ? 'Rendering' : 'AI result'}</small>
                </button>
              </div>
              {result?.imageUrl && <AiPreviewDisclaimer className="custom-ai-disclaimer" />}
            </article>
          </div>

          <div className="custom-tryon-action-block">
            <p>Our AI considers lighting, fabric physics, and body contouring for a realistic preview.</p>
            <button className="submit" type="submit" disabled={loading}>{loading ? 'Generating...' : 'Generate Custom Try-On'}</button>
            {loading && <button className="custom-tryon-cancel" type="button" onClick={cancelGeneration}>Cancel generation</button>}
            <div className="custom-tryon-credit-row"><span>{user?.tokens ?? 0} Credits Left</span><i aria-hidden="true" /><a href="/tokens">Upgrade to Pro</a></div>
          </div>
          {message && <p className={`form-message ${result?.imageUrl ? '' : 'error-message'}`}>{message}</p>}
        </form>
      </section>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </>
  );
}

function CustomTryOnConfidence({ user }) {
  const recommendations = useRecommendedProducts(user, 5);
  const fallback = useProducts({ limit: 5, sort: 'newest' });
  const products = (recommendations.products.length ? recommendations.products : fallback.products).slice(0, 5);
  const loading = recommendations.loading || (!products.length && fallback.loading);

  return (
    <section className="wrap custom-confidence-section" aria-label="Style with confidence">
      <h2>Style with Confidence</h2>
      <div className="custom-confidence-grid">
        {loading && !products.length ? Array.from({ length: 3 }).map((_, index) => (
          <article className="custom-confidence-card custom-confidence-card-loading" key={`confidence-loading-${index}`}>
            <span aria-hidden="true" />
            <strong>Curating</strong>
          </article>
        )) : products.map((product) => (
          <article className="custom-confidence-card" key={wishlistProductId(product)}>
            <a className="custom-confidence-link" href={`/product/${encodeURIComponent(wishlistProductId(product))}`} onClick={() => recordEvent('product_click', { productId: wishlistProductId(product), source: 'custom_confidence' })}>
              <span className="custom-confidence-image"><OptimizedImage src={product.imageUrl || asset('hero2.png')} alt={product.name} onError={(event) => { event.currentTarget.src = asset('hero2.png'); }} /></span>
              <span className="custom-confidence-copy">
                <small>{displayBrand(product)}</small>
                <strong>{product.name}</strong>
                <b>{formatMoney(product.price || 0, product.currency)}</b>
              </span>
            </a>
            <WishlistHeartButton product={product} className="card-wishlist-heart" />
          </article>
        ))}
      </div>
    </section>
  );
}

function StyleBotPage({ user, setUser }) {
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const conciergeScrollRef = useRef(null);
  const conciergeEndRef = useRef(null);
  const promptIdeas = ['linen shirts under 1500', 'black party dress', 'gold sunglasses', 'oversized denim jacket'];
  const creditCount = Number(user?.tokens || 0);

  useEffect(() => {
    if (!user || runs.length === 0) return undefined;
    let frameId = 0;
    const timeouts = [];
    const scrollToLatest = (behavior = 'smooth') => {
      frameId = window.requestAnimationFrame(() => {
        const scrollNode = conciergeScrollRef.current;
        conciergeEndRef.current?.scrollIntoView({ block: 'end', behavior });
        if (scrollNode) {
          scrollNode.scrollTo({ top: scrollNode.scrollHeight, behavior });
        }
      });
    };
    scrollToLatest();
    timeouts.push(window.setTimeout(() => scrollToLatest(), 180));
    timeouts.push(window.setTimeout(() => scrollToLatest(), 520));
    return () => {
      window.cancelAnimationFrame(frameId);
      timeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [user, runs, busy]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const sessionHistory = runs.slice().reverse();

  const updateRun = (id, updater) => {
    setRuns((current) => current.map((run) => (run.id === id ? { ...run, ...updater(run) } : run)));
  };

  const submit = async (event) => {
    event.preventDefault();
    const prompt = query.trim();
    if (!prompt || busy) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const promptCompatibility = styleBotCompatibility(prompt);
    const genderPreference = genderPreferenceForStyleQuery(prompt, user.genderPreference || 'other');
    const searchPrompt = genderedStyleBotQuery(prompt, genderPreference);
    setQuery('');
    setBusy(true);
    recordEvent('style_bot_query', { query: prompt });
    setRuns((current) => [
      ...current,
      { id, query: prompt, products: [], tryOns: {}, loading: promptCompatibility.compatible, generating: {}, errors: {}, searchError: promptCompatibility.compatible ? '' : promptCompatibility.reason }
    ]);
    if (!promptCompatibility.compatible) {
      setBusy(false);
      return;
    }

    try {
      const data = await api('/products/amazon-search', {
        method: 'POST',
        body: JSON.stringify({ query: searchPrompt, limit: 2, genderPreference })
      });
      const products = (data.products || []).filter((product) => (
        styleBotProductCompatibility(product, prompt).compatible &&
        styleBotGenderCompatibility(product, genderPreference).compatible
      ));
      if (products.length === 0) {
        throw new Error('Amazon results were found, but none matched your try-on gender preference. Try a more specific clothing search.');
      }
      updateRun(id, () => ({
        products,
        loading: false,
        generating: {}
      }));
    } catch (err) {
      updateRun(id, () => ({ loading: false, searchError: err.message }));
    } finally {
      setBusy(false);
    }
  };

  const startNewSession = () => {
    setRuns([]);
    setQuery('');
  };

  return (
    <main className="style-bot-page concierge-page">
      <aside className="concierge-session-rail" aria-label="Stylist sessions">
        <a className="concierge-brand" href="/" aria-label="Lookmefy home"><BrandLogo /></a>
        <p>Stylist sessions</p>
        <div className="concierge-session-list">
          {sessionHistory.length ? sessionHistory.map((run, index) => (
            <button type="button" key={run.id} onClick={() => setQuery(run.query)}>
              <span>{String(sessionHistory.length - index).padStart(2, '0')}</span><strong>{run.query}</strong><small>{run.loading ? 'Curating' : run.searchError ? 'Needs retry' : `${run.products.length} suggestions`}</small>
            </button>
          )) : <div className="concierge-empty-session"><strong>New style session</strong><span>Your personal edit begins here.</span></div>}
        </div>
        <button className="concierge-new-session" type="button" onClick={startNewSession}>+ New Session</button>
      </aside>

      <section className="concierge-workspace" aria-label="Lookmefy Concierge">
        <div className="concierge-chat-head"><span className="concierge-status-dot" aria-hidden="true" /><strong>Lookmefy Concierge</strong><small>{creditCount} credits</small></div>
        <div className="concierge-scroll" ref={conciergeScrollRef}>
          <div className="concierge-message assistant">
            <p className="concierge-message-label">Lookmefy Concierge</p>
            <div className="concierge-bubble">Welcome. Share the item, occasion, color, or budget you have in mind and I’ll curate a considered edit for your wardrobe.</div>
          </div>
          {runs.map((run) => (
            <div className="concierge-run" key={run.id}>
              <div className="concierge-message user"><p className="concierge-message-label">You</p><div className="concierge-bubble">{run.query}</div></div>
              <div className="concierge-message assistant">
                <p className="concierge-message-label">Lookmefy Concierge</p>
                <div className="concierge-bubble concierge-response">
                  {run.loading && <span className="concierge-loading">Curating your edit...</span>}
                  {run.searchError && <p className="form-message error-message">{run.searchError}</p>}
                  {!run.loading && !run.searchError && <div className="concierge-result-summary"><p className="concierge-result-copy">I found {run.products.length} matching piece{run.products.length === 1 ? '' : 's'} for this edit.</p><a href={`/categories?q=${encodeURIComponent(run.query)}`}>View matching products</a></div>}
                </div>
              </div>
            </div>
          ))}
          <div className="concierge-scroll-anchor" ref={conciergeEndRef} aria-hidden="true" />
        </div>
        <form className="concierge-composer" onSubmit={submit}>
          <div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask your stylist anything..." aria-label="Ask Lookmefy Concierge" /><button type="submit" disabled={busy || !query.trim()} aria-label={busy ? 'Curating suggestions' : 'Send message'} title={busy ? 'Curating suggestions' : 'Send message'}>{busy ? '...' : '→'}</button></div>
          <section aria-label="Prompt ideas">{promptIdeas.slice(0, 3).map((idea) => <button type="button" key={idea} onClick={() => setQuery(idea)}>{idea}</button>)}</section>
        </form>
      </section>
    </main>
  );
}

function StyleBotProduct({ product, tryOn, loading, error, onFullscreen }) {
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const productImage = product.imageUrl || asset('hero2.png');
  const hasUsableTryOn = Boolean(tryOn?.imageUrl) && !tryOnImageFailed;
  const detailHref = `/product/${encodeURIComponent(product.id)}`;

  useEffect(() => {
    setTryOnImageFailed(false);
  }, [tryOn?.imageUrl]);

  return (
    <article className="concierge-product-card">
      <a className="concierge-product-image" href={detailHref} onClick={() => recordEvent('product_click', { productId: product.id })}><OptimizedImage src={productImage} alt={product.name} /></a>
      <WishlistHeartButton product={product} className="card-wishlist-heart" />
      <p>{displayBrand(product)}</p>
      <h2>{product.name}</h2>
      <strong>{formatMoney(product.price, product.currency)}</strong>
      {loading && <span className="concierge-product-state">Preparing preview</span>}
      {hasUsableTryOn && <button className="concierge-preview-action" type="button" onClick={() => onFullscreen({ src: tryOn.imageUrl, alt: `AI try-on for ${product.name}`, title: product.name })}>View preview</button>}
      {tryOn?.imageUrl && !hasUsableTryOn && <span className="concierge-product-state">Preview unavailable</span>}
      {error && <span className="concierge-product-error">{error}</span>}
      <a className="concierge-shop-action" href={product.affiliateLink || detailHref} target={product.affiliateLink ? '_blank' : undefined} rel={product.affiliateLink ? 'noreferrer' : undefined} onClick={() => recordEvent(product.affiliateLink ? 'shop_click' : 'product_click', { productId: product.id })}>Shop the suggestion</a>
    </article>
  );
}

function ImageLightbox({ image, onClose }) {
  const closeButtonRef = useRef(null);
  const isVideo = image?.type === 'video';

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'contain';
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
    };
  }, []);

  const lightbox = (
    <div className={`image-lightbox ${isVideo ? 'video-lightbox' : ''}`} role="dialog" aria-modal="true" aria-label={isVideo ? 'Full screen video preview' : 'Full screen image preview'} onClick={onClose}>
      <button className="lightbox-close" ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close full screen preview">×</button>
      <figure onClick={(event) => event.stopPropagation()}>
        {isVideo ? (
          <video className="lightbox-video" src={image.src} poster={image.poster} autoPlay muted loop playsInline controls />
        ) : (
          <ZoomableImage className="lightbox-zoom-frame" src={image.src} alt={image.alt} zoom={2.45} />
        )}
        <figcaption>{image.title}</figcaption>
      </figure>
    </div>
  );

  return createPortal(lightbox, document.body);
}

function TokenPage({ user, setUser, mode = 'overview' }) {
  const isTopUpPage = mode === 'topup';
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [selectedPackId, setSelectedPackId] = useState(isTopUpPage ? 'topup_50_tokens' : 'monthly_150_tokens');
  const [message, setMessage] = useState('');
  const [creditedOrder, setCreditedOrder] = useState(null);
  const verifiedOrderRef = useRef('');
  const checkoutIdempotencyRef = useRef(new Map());
  const params = new URLSearchParams(window.location.search);
  const returnedOrderId = params.get('merchantOrderId') || params.get('orderId') || '';
  const subscription = user?.subscription;
  const isActive = subscription?.status === 'active' && (!subscription.currentPeriodEnd || new Date(subscription.currentPeriodEnd) > new Date());

  useEffect(() => {
    if (!user || !returnedOrderId || verifiedOrderRef.current === returnedOrderId) return;
    verifiedOrderRef.current = returnedOrderId;
    let alive = true;
    setMessage('Verifying payment with Razorpay...');
    api(`/payments/orders/${encodeURIComponent(returnedOrderId)}/status`)
      .then((data) => {
        if (!alive) return;
        if (data.user) setUser(data.user);
        const state = data.order?.status;
        if (state === 'completed') {
          const addedTokens = Number(data.order?.tokens || 0);
          setMessage(`Payment confirmed. ${addedTokens || 'Your'} tokens have been added to your account.`);
        }
        else if (state === 'failed') setMessage('Payment was not completed. You can try again when ready.');
        else setMessage('Payment is still pending. Refresh this page in a moment to check again.');
      })
      .catch((err) => {
        if (alive) setMessage(err.message);
      });
    return () => {
      alive = false;
    };
  }, [user, returnedOrderId, setUser]);

  const startCheckout = async (pack) => {
    if (!user) {
      window.location.href = '/signup';
      return;
    }
    setCheckoutLoading(true);
    setMessage('Opening secure Razorpay checkout...');
    try {
      const idempotencyKey = checkoutIdempotencyRef.current.get(pack.id)
        || (window.crypto?.randomUUID?.() || `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      checkoutIdempotencyRef.current.set(pack.id, idempotencyKey);
      const data = await api('/payments/checkout', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ planId: pack.planId || pack.id })
      });
      if (data.razorpay) {
        const Razorpay = await loadRazorpayCheckout();
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return false;
            settled = true;
            return true;
          };
          const checkout = new Razorpay({
            key: data.razorpay.key,
            amount: data.razorpay.amount,
            currency: data.razorpay.currency || 'INR',
            name: data.razorpay.name || 'Lookmefy',
            description: data.razorpay.description || pack.label,
            order_id: data.razorpay.orderId,
            prefill: data.razorpay.prefill || {},
            notes: data.razorpay.notes || {},
            theme: { color: '#1f1b19' },
            handler: async (response) => {
              try {
                setCheckoutLoading(true);
                setMessage('Verifying payment with Razorpay...');
                const verified = await api(data.razorpay.verifyPath || '/payments/razorpay/verify', {
                  method: 'POST',
                  body: JSON.stringify({
                    merchantOrderId: data.order?.merchantOrderId,
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature
                  })
                });
                if (verified.user) setUser(verified.user);
                setCreditedOrder({ order: verified.order, user: verified.user || user });
                checkoutIdempotencyRef.current.delete(pack.id);
                setMessage('');
                announce(`${Number(verified.order?.tokens || 0)} credits credited.`);
                if (finish()) resolve();
              } catch (error) {
                if (finish()) reject(error);
              } finally {
                setCheckoutLoading(false);
              }
            },
            modal: {
              ondismiss: () => {
                if (!finish()) return;
                setMessage('Checkout closed before payment was completed.');
                setCheckoutLoading(false);
                resolve();
              }
            }
          });
          checkout.on('payment.failed', (response) => {
            if (!finish()) return;
            setMessage(razorpayFailureMessage(response));
            setCheckoutLoading(false);
            resolve();
          });
          checkout.open();
          setCheckoutLoading(false);
        });
        return;
      }
      if (!data.redirectUrl) throw new Error('Checkout did not return a payment link.');
      window.location.assign(data.redirectUrl);
    } catch (err) {
      checkoutIdempotencyRef.current.delete(pack.id);
      setMessage(err.message);
      setCheckoutLoading(false);
    }
  };

  const recurringAmount = formatMinorAmount(SUBSCRIPTION_PLAN.mandate.recurringAmount, SUBSCRIPTION_PLAN.currency);
  const dueTodayAmount = formatMinorAmount(SUBSCRIPTION_PLAN.dueTodayAmount, SUBSCRIPTION_PLAN.currency);
  const firstRecurringDate = formatDate(firstRecurringPaymentDate(SUBSCRIPTION_PLAN));
  const subscriptionPack = {
    id: SUBSCRIPTION_PLAN.id,
    planId: SUBSCRIPTION_PLAN.id,
    plan: SUBSCRIPTION_PLAN,
    label: SUBSCRIPTION_PLAN.name,
    headline: `${SUBSCRIPTION_PLAN.tokens} credits every month`,
    price: dueTodayAmount,
    tokensLabel: `${SUBSCRIPTION_PLAN.tokens} credits every month`,
    rateLabel: `${creditRateLabel(SUBSCRIPTION_PLAN)} monthly`,
    billing: `${recurringAmount} on ${firstRecurringDate}, then monthly`,
    copy: SUBSCRIPTION_PLAN.cancellation,
    cta: user ? `Set up ${recurringAmount}/month mandate` : 'Create profile',
    featured: true,
    payable: true
  };
  const bestTopUpValue = Math.min(...TOP_UP_PLANS.map((plan) => Number(plan.dueTodayAmount || plan.amount || 0) / Math.max(Number(plan.tokens || 1), 1)));
  const topUpPacks = TOP_UP_PLANS.map((plan) => {
    const value = Number(plan.dueTodayAmount || plan.amount || 0) / Math.max(Number(plan.tokens || 1), 1);
    return {
    id: plan.id,
    planId: plan.id,
    plan,
    label: 'Top-up',
    headline: formatMinorAmount(plan.dueTodayAmount, plan.currency),
    tokensLabel: `${plan.tokens} credits`,
    rateLabel: creditRateLabel(plan),
    price: formatMinorAmount(plan.dueTodayAmount, plan.currency),
    billing: plan.billing,
    copy: plan.tokens >= 400
      ? 'Best value for bulk catalog work and repeated video trials.'
      : plan.tokens >= 100
        ? 'Better value for product batches and style exploration.'
        : 'Extra credits for image try-ons and videos.',
    cta: user ? 'Buy top-up' : 'Create profile',
    badge: value === bestTopUpValue ? 'Best Value' : '',
    payable: true
  };
  });
  const overviewPacks = [
    subscriptionPack,
    {
      id: 'topup_banner',
      label: 'Top-up',
      headline: 'Add more',
      price: 'From Rs 199',
      tokensLabel: 'One-time packs',
      billing: 'No subscription change',
      copy: 'Open the top-up page to choose 50, 75, 110, 135, or 400 extra tokens.',
      cta: 'View top-ups',
      href: '/tokens/top-up',
      featured: false
    }
  ];
  const creditPacks = isTopUpPage ? topUpPacks : overviewPacks;
  const selectedPack = creditPacks.find((pack) => pack.id === selectedPackId) || creditPacks[1];
  const isPaidPack = Boolean(selectedPack.payable);
  const selectedPlan = selectedPack.plan || null;
  const isSubscriptionPack = selectedPlan?.orderType === 'subscription';
  const completeSelection = () => {
    if (!user) {
      window.location.assign('/signup');
      return;
    }
    if (isPaidPack) {
      startCheckout(selectedPack);
      return;
    }
    window.location.assign(selectedPack.href);
  };

  return (
    <main className="credit-purchase-page">
      <section className="wrap credit-purchase-shell">
        {isTopUpPage && <a className="credit-back-link" href="/tokens" aria-label="Back to credits" title="Back to credits"><ArrowLeftIcon /></a>}
        <header className="credit-purchase-head">
          <h1>{isTopUpPage ? 'Top-ups' : 'Credits'}</h1>
          <span>{isTopUpPage ? 'Choose a one-time token pack when you want extra image try-ons or videos on top of the monthly membership.' : 'Pick the monthly mandate setup or open one-time top-ups. Starter accounts include 8 tokens, images use 1 token, and videos use 3 tokens.'}</span>
        </header>

        {message && <p className={`credit-purchase-message ${/failed|not completed|missing|Could not|error/i.test(message) ? 'error-message' : ''}`} role="status">{message}</p>}

        <div className="credit-purchase-layout">
          <div className="credit-purchase-main">
            <section className={`credit-pack-grid ${isTopUpPage ? 'topup-grid' : 'overview-grid'}`} aria-label="Credit packs">
              {creditPacks.map((pack) => {
                const className = `credit-pack-option ${selectedPack.id === pack.id ? 'selected' : ''} ${pack.featured ? 'featured' : ''}`;
                const content = (
                  <>
                    {pack.badge && <span className="credit-pack-badge">{pack.badge}</span>}
                    <small>{pack.label}</small>
                    <strong>{pack.headline}</strong>
                    <b>{pack.tokensLabel}</b>
                    {pack.rateLabel && <em className="credit-pack-rate">{pack.rateLabel}</em>}
                    <span>{pack.billing}</span>
                    <i>{pack.copy}</i>
                  </>
                );
                if (pack.href) {
                  return <a className={className} key={pack.id} href={pack.href}>{content}</a>;
                }
                return (
                  <button className={className} type="button" key={pack.id} onClick={() => setSelectedPackId(pack.id)} aria-pressed={selectedPack.id === pack.id}>
                    {content}
                  </button>
                );
              })}
            </section>

            <section className="credit-payment-section" aria-label="Payment method">
              <div className="credit-section-heading"><h2>Payment Method</h2><span>Secure checkout</span></div>
              <button className="credit-payment-choice active" type="button" aria-pressed="true">
                <span className="credit-phonepe-mark">R</span><strong>Razorpay</strong><small>UPI, cards, and net banking</small><b>Selected</b>
              </button>
            </section>
          </div>

          <aside className="credit-order-summary" aria-label="Order summary">
            <div className="credit-summary-heading"><h2>Order Summary</h2><span>{isActive ? 'Active plan' : 'Selected pack'}</span></div>
            <div className="credit-summary-row"><span>Credit Package</span><strong>{selectedPack.label}</strong></div>
            <div className="credit-summary-row"><span>Tokens</span><strong>{selectedPack.tokensLabel}</strong></div>
            {selectedPack.rateLabel && <div className="credit-summary-row"><span>Rate</span><strong>{selectedPack.rateLabel}</strong></div>}
            {isSubscriptionPack ? (
              <>
                <div className="credit-summary-row"><span>First recurring payment</span><strong>{recurringAmount} on {firstRecurringDate}</strong></div>
                <div className="credit-summary-row"><span>Then</span><strong>{recurringAmount}/month</strong></div>
                <div className="credit-summary-row"><span>Billing frequency</span><strong>{selectedPlan.mandate.frequency}</strong></div>
                <div className="credit-summary-row"><span>Cancellation</span><strong>{selectedPlan.cancellation}</strong></div>
              </>
            ) : (
              <div className="credit-summary-row"><span>Billing</span><strong>{selectedPack.billing}</strong></div>
            )}
            <div className="credit-summary-row"><span>Processing Fee</span><strong>Free</strong></div>
            <div className="credit-summary-total"><span>Due today</span><strong>{selectedPack.price}</strong></div>
            <button type="button" onClick={completeSelection} disabled={checkoutLoading}>{checkoutLoading ? 'Opening checkout...' : selectedPack.cta}</button>
            <small>{isPaidPack ? (isActive && subscription.currentPeriodEnd && selectedPack.id === 'monthly_150_tokens' ? `Current plan ends ${formatDate(subscription.currentPeriodEnd)}. Credits are added after secure payment verification.` : 'Secured by Razorpay. Credits are added only after payment verification.') : selectedPack.copy}</small>
          </aside>
        </div>
      </section>
      {creditedOrder && <CreditSuccessModal order={creditedOrder.order} user={creditedOrder.user} onClose={() => setCreditedOrder(null)} />}
    </main>
  );
}

function CreditSuccessModal({ order, user, onClose }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="checkout-success-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="checkout-success-modal credit-success-modal" role="dialog" aria-modal="true" aria-labelledby="credit-success-title">
        <button ref={closeButtonRef} className="checkout-success-close" type="button" onClick={onClose} aria-label="Close credit success"><CloseIcon /></button>
        <div className="checkout-success-mark" aria-hidden="true">✓</div>
        <p className="kicker">Credits credited</p>
        <h2 id="credit-success-title">Credits added</h2>
        <p>Your credit pack has been added to your Lookmefy account.</p>
        <div className="checkout-success-details">
          <div><span>Pack</span><strong>{order?.planName || 'Credits'}</strong></div>
          <div><span>Credits</span><strong>{Number(order?.tokens || 0)}</strong></div>
          <div><span>Amount</span><strong>{formatMoney(Number(order?.dueTodayAmount || order?.amount || 0) / 100, order?.currency || 'INR')}</strong></div>
          <div><span>New balance</span><strong>{Number(user?.tokens || 0)}</strong></div>
        </div>
        <div className="checkout-success-actions">
          <a className="button" href="/custom-try-on">Use credits</a>
          <a className="button secondary" href="/tokens">Back to credits</a>
        </div>
      </section>
    </div>
  );
}

function ProfilePage({ user, setUser }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const deleteTriggerRef = useRef(null);
  const [preview, setPreview] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [profilePhotoMode, setProfilePhotoMode] = useState('ai-full-body');
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [creditHistory, setCreditHistory] = useState({
    loading: false,
    error: '',
    items: [],
    totalPurchased: 0,
    totalUsed: 0
  });
  const generationHistory = useGenerationHistory(user);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  useEffect(() => {
    if (!user) return undefined;
    let alive = true;
    setCreditHistory((current) => ({ ...current, loading: true, error: '' }));
    api('/payments/credits/history')
      .then((data) => {
        if (!alive) return;
        setCreditHistory({
          loading: false,
          error: '',
          items: Array.isArray(data.items) ? data.items : [],
          totalPurchased: Number(data.totalPurchased || 0),
          totalUsed: Number(data.totalUsed || 0)
        });
      })
      .catch((err) => {
        if (!alive) return;
        setCreditHistory((current) => ({
          ...current,
          loading: false,
          error: err.message || 'Credit history unavailable'
        }));
      });
    return () => {
      alive = false;
    };
  }, [user?.id, user?.tokens]);

  useEffect(() => {
    if (user?.bodyPhotoStatus !== 'generating') return;
    let alive = true;
    const interval = setInterval(() => {
      api('/auth/me')
        .then((data) => {
          if (!alive) return;
          setUser(data.user);
          if (data.user?.bodyPhotoStatus === 'ready') setMessage('Full-body try-on profile is ready.');
          if (data.user?.bodyPhotoStatus === 'failed') setMessage('Full-body profile generation failed. Upload a clearer selfie or body photo.');
        })
        .catch(() => {});
    }, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [user?.bodyPhotoStatus, setUser]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const hasUploadedPhoto = Boolean(user.bodyPhotoOriginalUrl || user.bodyPhotoUrl);
  const hasAiProfile = user.bodyPhotoSource === 'fal-full-body' && Boolean(user.bodyPhotoUrl);
  const generatedProfilePhotoUrl = hasAiProfile ? user.bodyPhotoUrl : '';
  const uploadedProfilePhotoUrl = user.bodyPhotoOriginalUrl || user.bodyPhotoUrl;
  const photoSrc = preview || protectedMediaUrl(generatedProfilePhotoUrl || uploadedProfilePhotoUrl);
  const photoFrameClass = hasAiProfile && !preview ? 'ai-full-body-ready' : '';
  const showGeneratingPhotoStatus = user.bodyPhotoStatus === 'generating';
  const selectPhoto = (event) => {
    const file = event.currentTarget.files?.[0];
    setPhotoFile(file || null);
    setPreview(file ? URL.createObjectURL(file) : '');
    setMessage('');
  };

  const submitPhoto = async (event) => {
    event.preventDefault();
    const file = photoFile || fileRef.current?.files?.[0] || cameraRef.current?.files?.[0];
    if (!file) {
      setMessage('Choose a new profile photo first.');
      return;
    }
    setSaving(true);
    setMessage('Uploading profile photo...');
    try {
      const form = new FormData();
      form.append('bodyPhoto', await prepareBodyPhoto(file));
      form.append('profilePhotoMode', profilePhotoMode);
      const data = await api('/auth/body-photo', { method: 'POST', body: form });
      setUser(data.user);
      if (fileRef.current) fileRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
      setPhotoFile(null);
      setPreview('');
      setMessage(data.user?.bodyPhotoStatus === 'generating' ? 'Photo saved. Full-body try-on profile is preparing in the background.' : 'Profile photo updated.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const createAiBodyProfile = async () => {
    if (user.bodyPhotoStatus === 'generating') return;
    setSaving(true);
    setMessage('Preparing your AI full-body profile...');
    try {
      const data = await api('/auth/body-photo/generate-full-body', { method: 'POST' });
      setUser(data.user);
      setMessage('AI full-body profile is preparing in the background.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const initials = (user.name || user.username || 'FL').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const creditProgress = Math.min(100, Math.max(0, ((user.tokens || 0) / 2000) * 100));
  const logout = () => {
    clearAuthToken();
    setUser(null);
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const finishAccountDeletion = () => {
    clearAuthToken();
    ['fitlook_wishlist', 'fitlook_wishlist_ids', 'fitlook:wishlist', 'wishlist', 'fitlook_wishlist_products', 'fitlook_wishlist_collections'].forEach((key) => localStorage.removeItem(key));
    window.dispatchEvent(new CustomEvent('fitlook:wishlist-change', { detail: { ids: [] } }));
    setUser(null);
    announce('Your account has been deleted.');
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <main className="profile-page profile-reference-page">
      <section className="wrap profile-reference-shell">
        <header className="profile-reference-head"><h1>My Profile</h1><p>Manage your account preferences</p></header>

        <section className="profile-reference-panel profile-reference-account" aria-label="Account overview">
          <div className={`profile-reference-avatar ${photoFrameClass}`.trim()}>{photoSrc ? <img src={photoSrc} alt="" /> : <span>{initials}</span>}</div>
          <div className="profile-reference-account-copy"><div><h2>{user.name}</h2><span>@{user.username}</span></div><p>{user.email}</p><small>{genderPreferenceLabel(user.genderPreference)} preference · Member since {formatDate(user.joinedAt)}</small></div>
          <a href="#tryon-photo">Update photo</a>
        </section>

        <section className="profile-reference-panel profile-reference-credits" aria-label="Credit balance">
          <div className="profile-reference-section-head"><div><h2>Credit Balance</h2><p>Credits available for virtual try-ons</p></div><span className="profile-credit-mark"><SparkleLineIcon /></span></div>
          <div className="profile-reference-credit-number"><strong>{user.tokens}</strong><span>credits</span></div>
          <div className="profile-reference-progress"><i style={{ width: `${creditProgress}%` }} /></div>
          <div className="profile-credit-summary" aria-label="Credit summary">
            <div><span>Purchased</span><strong>+{creditHistory.totalPurchased}</strong></div>
            <div><span>Used</span><strong>-{creditHistory.totalUsed}</strong></div>
          </div>
          <div className="profile-credit-history" aria-label="Credit history">
            <div className="profile-credit-history-head"><strong>Credit History</strong><span>Recent activity</span></div>
            {creditHistory.loading && <p className="profile-credit-history-empty">Loading credit history...</p>}
            {!creditHistory.loading && creditHistory.error && <p className="profile-credit-history-empty">{creditHistory.error}</p>}
            {!creditHistory.loading && !creditHistory.error && creditHistory.items.length === 0 && <p className="profile-credit-history-empty">No credit purchases or usage yet.</p>}
            {!creditHistory.loading && !creditHistory.error && creditHistory.items.slice(0, 6).map((item) => (
              <div className={`profile-credit-history-row ${item.type === 'purchase' ? 'purchase' : 'usage'}`} key={item.id}>
                <div><strong>{item.title}</strong><span>{item.detail}</span></div>
                <div><b>{Number(item.credits || 0) > 0 ? '+' : ''}{item.credits}</b><time dateTime={item.date}>{formatDate(item.date)}</time></div>
              </div>
            ))}
          </div>
          <div className="profile-reference-credit-foot"><p>Each new AI try-on uses 1 credit.</p><a href="/tokens">Buy more credits</a></div>
        </section>

        <section className="profile-reference-panel profile-generation-card" aria-label="Generation history">
          <div className="profile-reference-section-head">
            <div><h2>Generation History</h2><p>View all AI Try-On images you’ve created.</p></div>
            <span className="profile-credit-mark"><SparkleLineIcon /></span>
          </div>
          {generationHistory.items.length > 0 && (
            <div className="profile-generation-preview" aria-label="Recent generation previews">
              {generationHistory.items.slice(0, 3).map((item) => {
                const title = item.product?.name || 'AI Try-On';
                return <img src={protectedMediaUrl(item.imageUrl)} alt={title} key={item.id} />;
              })}
            </div>
          )}
          <div className="profile-generation-foot">
            <p>{generationHistory.loading ? 'Loading recent generations...' : generationHistory.items.length ? `${generationHistory.items.length} saved ${generationHistory.items.length === 1 ? 'creation' : 'creations'}` : 'Your saved try-ons will appear here.'}</p>
            <a href="/generation-history">View History <span>→</span></a>
          </div>
        </section>

        <section className="profile-reference-panel profile-reference-photo" id="tryon-photo" aria-label="Try-on photo">
          <div className="profile-reference-section-head"><div><h2>Try-On Portrait</h2><p>Manage the photo used for your virtual try-on previews.</p></div></div>
          <div className="profile-reference-photo-layout">
            <div className="profile-reference-photo-preview-stack">
              <div className={`profile-reference-photo-preview ${photoFrameClass}`.trim()}>
                {photoSrc ? <img src={photoSrc} alt="Current model profile" /> : <span>{initials}</span>}
                {photoSrc && <button className="fullscreen-button" type="button" aria-label="Open try-on photo full screen" title="Open full screen" onClick={() => setFullscreenImage({ src: photoSrc, alt: 'Current try-on profile', title: 'Try-on Photo' })}><FullscreenIcon /></button>}
              </div>
              {(message || showGeneratingPhotoStatus) && (
                <div className="profile-reference-photo-status">
                  {message && <p className={`profile-reference-message ${/failed|error|clearer/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
                  {showGeneratingPhotoStatus && <p className="profile-reference-message">Full-body profile is preparing in the background.</p>}
                </div>
              )}
            </div>
            <form className="profile-reference-photo-form" onSubmit={submitPhoto}>
              <label className="profile-reference-upload-zone">
                <input ref={fileRef} name="bodyPhoto" type="file" accept={BODY_PHOTO_ACCEPT} onChange={selectPhoto} />
                <UploadCloudIcon />
                <strong>Upload New Photo</strong>
                <span>Drag and drop or choose a clear photo here</span>
                <b>Browse files</b>
              </label>
              <input ref={cameraRef} className="camera-input" type="file" accept={BODY_PHOTO_ACCEPT} capture="user" onChange={selectPhoto} />
              <div className="profile-reference-photo-tools"><button type="button" onClick={() => cameraRef.current?.click()}>Take photo</button><div role="radiogroup" aria-label="Profile photo mode"><label><input type="radio" name="profilePhotoMode" value="ai-full-body" checked={profilePhotoMode === 'ai-full-body'} onChange={(event) => setProfilePhotoMode(event.target.value)} /> AI full-body profile</label><label><input type="radio" name="profilePhotoMode" value="exact" checked={profilePhotoMode === 'exact'} onChange={(event) => setProfilePhotoMode(event.target.value)} /> Exact photo</label></div></div>
              {preview && <button className="profile-reference-save-photo" type="submit" disabled={saving}>{saving ? 'Saving photo...' : 'Save new photo'}</button>}
              {hasUploadedPhoto && !hasAiProfile && user.bodyPhotoStatus !== 'generating' && <button className="profile-reference-save-photo secondary" type="button" disabled={saving} onClick={createAiBodyProfile}>{saving ? 'Starting AI profile...' : 'Create AI full-body profile'}</button>}
            </form>
          </div>
        </section>

        <section className="profile-reference-panel profile-reference-payment" aria-label="Payment methods">
          <div className="profile-reference-section-head"><div><h2>Payment Methods</h2><p>Payments are securely verified before credits are added.</p></div><a href="/tokens">Add credits</a></div>
          <div className="profile-reference-payment-row"><span>Razorpay</span><strong>UPI, cards, and net banking</strong><small>Secure checkout</small><a href="/tokens" aria-label="Open credit checkout">›</a></div>
        </section>

        <section className="profile-reference-panel profile-reference-settings" aria-label="Account settings">
          <div className="profile-reference-section-head"><div><h2>Account Settings</h2><p>Control how your profile is used across Lookmefy.</p></div></div>
          <div className="profile-reference-setting-list">
            <div><span>Username</span><strong>@{user.username}</strong></div>
            <div><span>Email address</span><strong>{user.email}</strong></div>
            <div className="profile-reference-mode"><span>Try-on photo mode</span><div role="radiogroup" aria-label="Try-on photo mode"><label><input type="radio" name="profilePhotoModeSettings" value="ai-full-body" checked={profilePhotoMode === 'ai-full-body'} onChange={(event) => setProfilePhotoMode(event.target.value)} /> AI full-body</label><label><input type="radio" name="profilePhotoModeSettings" value="exact" checked={profilePhotoMode === 'exact'} onChange={(event) => setProfilePhotoMode(event.target.value)} /> Exact photo</label></div></div>
            <button className="profile-reference-neutral-action" type="button" onClick={() => window.dispatchEvent(new CustomEvent('fitlook:replay-onboarding'))}><span>Replay platform tour</span><b>›</b></button>
            <a href="/terms"><span>Terms and conditions</span><b>›</b></a>
            <a href="/privacy"><span>Privacy policy</span><b>›</b></a>
            <a href="/copyright"><span>Copyright policy</span><b>›</b></a>
            <a href="/data-deletion"><span>Data deletion</span><b>›</b></a>
            <button type="button" onClick={logout}><span>Log out</span><b>›</b></button>
          </div>
        </section>

        <section className="profile-reference-panel profile-danger-zone" aria-label="Danger zone">
          <div className="profile-reference-section-head">
            <div><h2>Danger Zone</h2><p>Permanent account actions</p></div>
          </div>
          <div className="profile-danger-action">
            <div>
              <strong>Delete account permanently</strong>
              <p>Permanently delete your Lookmefy account and associated data. This action cannot be undone.</p>
            </div>
            <button ref={deleteTriggerRef} type="button" onClick={() => setDeleteModalOpen(true)}>Delete Account</button>
          </div>
        </section>
      </section>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
      {deleteModalOpen && (
        <DeleteAccountDialog
          returnFocusRef={deleteTriggerRef}
          onCancel={() => setDeleteModalOpen(false)}
          onDeleted={finishAccountDeletion}
        />
      )}
    </main>
  );
}

function DeleteAccountDialog({ onCancel, onDeleted, returnFocusRef }) {
  const cancelButtonRef = useRef(null);
  const confirmInputRef = useRef(null);
  const deletingRef = useRef(false);
  const [step, setStep] = useState('review');
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const canDelete = confirmation === 'DELETE' && !deleting;

  useEffect(() => {
    deletingRef.current = deleting;
  }, [deleting]);

  useEffect(() => {
    cancelButtonRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape' && !deletingRef.current) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnFocusRef?.current?.focus();
    };
  }, [onCancel, returnFocusRef]);

  useEffect(() => {
    if (step === 'confirm') confirmInputRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const continueToConfirm = () => {
    setError('');
    setStep('confirm');
  };

  const deleteAccount = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setError('');
    try {
      const data = await api('/auth/me', {
        method: 'DELETE',
        retry: 0,
        body: JSON.stringify({ confirmation: 'DELETE' })
      });
      if (!data?.deleted) throw new Error('Delete failed');
      onDeleted();
    } catch {
      setDeleting(false);
      setError('We couldn’t delete your account. Please try again.');
    }
  };

  return (
    <div className="delete-account-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onCancel(); }}>
      <section className="delete-account-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title" aria-describedby="delete-account-description">
        <header>
          <div>
            <p>Danger Zone</p>
            <h2 id="delete-account-title">Delete your account?</h2>
          </div>
          <button ref={cancelButtonRef} type="button" aria-label="Cancel account deletion" disabled={deleting} onClick={onCancel}>×</button>
        </header>

        <p id="delete-account-description">This will permanently delete your Lookmefy account and associated account data. This action cannot be undone.</p>
        <ul>
          <li>Profile information</li>
          <li>Wardrobe items</li>
          <li>Wishlist</li>
          <li>AI Try-On generation history</li>
          <li>Saved portrait</li>
          <li>Remaining credits</li>
          <li>Account preferences</li>
        </ul>
        <p className="delete-account-credit-warning">Any remaining credits will be permanently lost.</p>

        {step === 'confirm' && (
          <label className="delete-account-confirm">
            <span>Type DELETE to confirm</span>
            <input ref={confirmInputRef} value={confirmation} disabled={deleting} autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        )}
        {error && <p className="delete-account-error" role="alert">{error}</p>}

        <div className="delete-account-actions">
          <button type="button" disabled={deleting} onClick={onCancel}>Cancel</button>
          {step === 'review' ? (
            <button type="button" className="delete-account-continue" onClick={continueToConfirm}>Continue</button>
          ) : (
            <button type="button" className="delete-account-final" disabled={!canDelete} onClick={deleteAccount}>{deleting ? 'Deleting your account…' : 'Permanently Delete Account'}</button>
          )}
        </div>
      </section>
    </div>
  );
}

function GenerationHistoryPage({ user }) {
  const history = useGenerationHistory(user);
  const [fullscreenImage, setFullscreenImage] = useState(null);

  if (!user) return null;

  return (
    <main className="profile-page profile-reference-page generation-history-page">
      <section className="wrap profile-reference-shell generation-history-shell" aria-labelledby="generation-history-title">
        <header className="profile-reference-head generation-history-head">
          <div>
            <h1 id="generation-history-title">Generation History</h1>
            <p>Your AI Try-On creations, all in one place.</p>
          </div>
          <a className="generation-history-back" href="/profile">Back to Profile</a>
        </header>

        <section className="generation-history-content" aria-label="AI Try-On generation history">
          {history.loading && <ProductGridSkeleton count={8} />}
          {!history.loading && history.error && <StatusPanel text={history.error} onRetry={history.retry} />}
          {!history.loading && !history.error && history.items.length > 0 && (
            <div className="generation-history-grid">
              {history.items.map((item) => {
                const product = item.product;
                const title = product?.name || 'AI Try-On';
                const imageUrl = protectedMediaUrl(item.imageUrl);
                return (
                  <article className="generation-history-card" key={item.id}>
                    <button
                      className="generation-history-media"
                      type="button"
                      aria-label={`Open ${title} generation`}
                      onClick={() => setFullscreenImage({ src: imageUrl, alt: `AI Try-On creation${product?.name ? ` for ${product.name}` : ''}`, title })}
                    >
                      <OptimizedImage src={imageUrl} fallbackSrc={asset('hero2.png')} alt={`AI Try-On creation${product?.name ? ` for ${product.name}` : ''}`} />
                    </button>
                    <div className="generation-history-copy">
                      <p>AI Try-On</p>
                      {product ? <a href={`/product/${encodeURIComponent(product.id)}`}><h2>{product.name}</h2></a> : <h2>AI Try-On</h2>}
                      {item.createdAt && <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {!history.loading && !history.error && history.items.length === 0 && (
            <section className="wishlist-reference-empty generation-history-empty" aria-label="No generation history">
              <div><h2>No generations yet</h2><p>Your AI Try-On creations will appear here.</p></div>
              <a href="/categories">Explore Styles</a>
            </section>
          )}
        </section>
      </section>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </main>
  );
}

function ActiveFilterChips({ values }) {
  const active = [
    ['q', values.q, `Search: ${values.q}`],
    ['tag', values.tag, `Tag: ${values.tag}`],
    ['category', values.category, displayCategory({ category: values.category })],
    ['brand', values.brand, displayBrand({ brand: values.brand })],
    ['gender', values.gender, values.gender],
    ['newArrival', values.newArrival, 'New arrivals'],
    ['sort', values.sort, values.sort === 'price-asc' ? 'Price low to high' : values.sort === 'price-desc' ? 'Price high to low' : values.sort === 'newest' ? 'Newest' : '']
  ].filter(([, value, label]) => value && label);

  if (active.length === 0) return null;

  return (
    <div className="active-filters" aria-label="Active filters">
      {active.map(([key, , label]) => <a href={searchHref(values, { [key]: '' })} key={key}>{label}<span>×</span></a>)}
      <a className="clear" href="/categories">Clear all</a>
    </div>
  );
}

function searchHref(values, overrides = {}) {
  const params = new URLSearchParams();
  Object.entries({ ...values, ...overrides }).forEach(([name, value]) => {
    const normalized = name === 'q' ? normalizeSearchQuery(value) : String(value || '').trim();
    if (normalized) params.set(name, normalized);
  });
  return `/categories${params.toString() ? `?${params}` : ''}`;
}

function ListingCategoryChips({ facets, values }) {
  const source = facets.categoryCounts?.length
    ? facets.categoryCounts
    : facets.categories.map((category) => ({ category, count: null }));
  const items = source.slice(0, 10);
  if (items.length === 0) return null;

  return (
    <nav className="listing-category-chips" aria-label="Product categories">
      <a className={!values.category ? 'active' : ''} href={searchHref(values, { category: '' })}>All</a>
      {items.map(({ category, count }) => {
        const active = categorySlug(category) === categorySlug(values.category);
        return (
          <a className={active ? 'active' : ''} href={searchHref(values, { category })} key={category}>
            <span>{displayCategory({ category })}</span>
            {count !== null && <small>{count}</small>}
          </a>
        );
      })}
    </nav>
  );
}

function FilterPanel({ facets, values, className = '' }) {
  const resetHref = '/search';
  const brands = usableBrands(facets.brands);

  return (
    <aside className={`filters ${className}`}>
      <div className="filter-head"><div><h2>Filters</h2><p>Refine the live catalog</p></div><a href={resetHref}>Reset</a></div>
      <form className="filter-form" action="/categories">
        <label><span>Search</span><input name="q" defaultValue={values.q} placeholder="Search keyword" /></label>
        <label><span>Category</span><select name="category" defaultValue={values.category}>
            <option value="">All categories</option>
            {facets.categories.map((item) => <option key={item} value={item}>{item}</option>)}
          </select></label>
        <label><span>Brand</span><select name="brand" defaultValue={values.brand}>
            <option value="">All brands</option>
            {brands.map((item) => <option key={item} value={item}>{item}</option>)}
          </select></label>
        <label><span>Gender</span><select name="gender" defaultValue={values.gender}>
            <option value="">All genders</option>
            <option value="men">Men</option>
            <option value="women">Women</option>
            <option value="unisex">Unisex</option>
          </select></label>
        <label><span>Sort</span><select name="sort" defaultValue={values.sort}>
            <option value="">Most relevant</option>
            <option value="newest">Newest</option>
            <option value="price-asc">Price: Low to High</option>
            <option value="price-desc">Price: High to Low</option>
          </select></label>
        {values.newArrival && <input type="hidden" name="newArrival" value={values.newArrival} />}
        {values.tag && <input type="hidden" name="tag" value={values.tag} />}
        <button className="apply">Apply Filters</button>
      </form>
    </aside>
  );
}

function CartPage({ user, demoEcommerceMode = false }) {
  const [items, setItems] = useState(() => readCartItems());
  const subtotal = cartSubtotal(items);

  useEffect(() => {
    const sync = (event) => setItems(event.detail?.items || readCartItems());
    window.addEventListener('fitlook:cart-change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('fitlook:cart-change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setQuantity = (item, quantity) => {
    setItems(updateCartQuantity(item.productId, quantity, item.variant));
  };

  const removeItem = (item) => {
    setItems(removeCartItem(item.productId, item.variant));
    announce(`${item.name} removed from cart.`);
  };

  const moveToWishlist = (item) => {
    toggleWishlistProductId({
      id: item.productId,
      name: item.name,
      brand: item.brand,
      imageUrl: item.imageUrl,
      price: item.price,
      compareAtPrice: item.compareAtPrice,
      currency: item.currency
    });
    removeItem(item);
    announce(`${item.name} moved to wishlist.`);
  };

  if (items.length === 0) {
    return (
      <main className="cart-page">
        <section className="wrap cart-empty-state">
          <p className="kicker">Your cart</p>
          <h1>Your cart is empty.</h1>
          <p>Explore products and save the pieces you want to compare before checkout.</p>
          <a className="button" href="/categories">Explore fashion</a>
        </section>
      </main>
    );
  }

  return (
    <main className="cart-page">
      <section className="wrap cart-shell" aria-labelledby="cart-title">
        <header className="cart-head">
          <div>
            <p className="kicker">Your cart</p>
            <h1 id="cart-title">Review selected products</h1>
            <p>{cartItemCount(items)} item{cartItemCount(items) === 1 ? '' : 's'} ready for checkout setup.</p>
          </div>
          <a href="/categories">Continue shopping</a>
        </header>

        <div className="cart-layout">
          <div className="cart-items" aria-label="Cart items">
            {items.map((item) => (
              <article className="cart-item" key={`${item.productId}-${item.variant}`}>
                <a className="cart-item-media" href={`/product/${encodeURIComponent(item.productId)}`}>
                  <OptimizedImage src={item.imageUrl || asset('hero2.png')} alt={item.name} />
                </a>
                <div className="cart-item-copy">
                  <p>{item.brand}</p>
                  <h2><a href={`/product/${encodeURIComponent(item.productId)}`}>{item.name}</a></h2>
                  <span>{item.variant}</span>
                  <strong>{formatMoney(item.price, item.currency)}</strong>
                  {item.compareAtPrice > item.price && <del>{formatMoney(item.compareAtPrice, item.currency)}</del>}
                  <div className="cart-item-actions">
                    <label>
                      <span>Qty</span>
                      <select value={item.quantity} onChange={(event) => setQuantity(item, event.target.value)} aria-label={`Quantity for ${item.name}`}>
                        {Array.from({ length: 10 }, (_, index) => index + 1).map((quantity) => <option value={quantity} key={quantity}>{quantity}</option>)}
                      </select>
                    </label>
                    <button type="button" onClick={() => moveToWishlist(item)}>Move to wishlist</button>
                    <button type="button" onClick={() => removeItem(item)}>Remove</button>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <aside className="cart-summary" aria-label="Cart summary">
            <h2>Order summary</h2>
            <div><span>Subtotal</span><strong>{formatMoney(subtotal, items[0]?.currency || 'INR')}</strong></div>
            <div><span>Delivery</span><strong>{demoEcommerceMode ? 'Free' : 'Calculated at checkout'}</strong></div>
            <p>{demoEcommerceMode ? 'Checkout confirms orders inside Lookmefy. Delivery is currently available within India.' : 'Product checkout needs backend order, address, inventory, and payment confirmation APIs before it can accept payment safely.'}</p>
            {demoEcommerceMode ? <a className="cart-checkout-action" href={user ? '/checkout' : `/signup?return=${encodeURIComponent('/checkout')}`}>{user ? 'Checkout' : 'Sign up to checkout'}</a> : <button type="button" disabled aria-disabled="true">Checkout coming soon</button>}
            <a href="/support">Contact support</a>
          </aside>
        </div>
      </section>
    </main>
  );
}

function checkoutContactFromUser(user) {
  return {
    fullName: user?.name || '',
    mobile: user?.phone || user?.mobile || ''
  };
}

function checkoutItemFromProduct(product) {
  if (!product?.id) return null;
  return {
    productId: product.id,
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    currency: product.currency || 'INR',
    variant: 'Standard',
    quantity: 1
  };
}

function CheckoutPage({ user, demoEcommerceMode = false, demoModeLoading = false }) {
  const params = new URLSearchParams(window.location.search);
  const directProductId = params.get('productId') || '';
  const { product, loading: productLoading, error: productError } = useProduct(directProductId);
  const [cartItems, setCartItems] = useState(() => readCartItems());
  const [form, setForm] = useState(() => ({
    ...checkoutContactFromUser(user),
    houseStreet: '',
    area: '',
    landmark: '',
    city: '',
    state: '',
    pincode: ''
  }));
  const [pincodeStatus, setPincodeStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [createdOrder, setCreatedOrder] = useState(null);
  const [successOrder, setSuccessOrder] = useState(null);
  const directItem = checkoutItemFromProduct(product);
  const items = directItem ? [directItem] : cartItems;
  const subtotal = cartSubtotal(items);
  const total = subtotal;
  const currency = items[0]?.currency || 'INR';

  useEffect(() => {
    const sync = (event) => setCartItems(event.detail?.items || readCartItems());
    window.addEventListener('fitlook:cart-change', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('fitlook:cart-change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    const contact = checkoutContactFromUser(user);
    setForm((current) => ({
      ...current,
      fullName: current.fullName || contact.fullName,
      mobile: current.mobile || contact.mobile
    }));
  }, [user?.id]);

  useEffect(() => {
    const pincode = form.pincode.replace(/\D/g, '').slice(0, 6);
    if (pincode !== form.pincode) {
      setForm((current) => ({ ...current, pincode }));
      return undefined;
    }
    if (pincode.length !== 6) {
      setPincodeStatus('');
      return undefined;
    }
    let alive = true;
    setPincodeStatus('Checking pincode...');
    api(`/orders/pincode/${pincode}`, { retry: 0 })
      .then((data) => {
        if (!alive) return;
        if (!data?.serviceable) {
          setPincodeStatus('This pincode is not serviceable yet.');
          return;
        }
        setForm((current) => ({
          ...current,
          city: data.city || current.city,
          state: data.state || current.state
        }));
        setPincodeStatus(data.city ? `Delivering to ${data.city}, ${data.state}.` : `Delivering in ${data.state}. Add your city to continue.`);
      })
      .catch((err) => {
        if (alive) setPincodeStatus(err.message || 'Could not check this pincode.');
      });
    return () => {
      alive = false;
    };
  }, [form.pincode]);

  const updateField = (field) => (event) => {
    const value = field === 'pincode' ? event.target.value.replace(/\D/g, '').slice(0, 6) : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const startPayment = async (event) => {
    event.preventDefault();
    if (submitting || !items.length) return;
    setSubmitting(true);
    setError('');
    try {
      const idempotencyKey = `product-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const orderResponse = await api('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          items: items.map((item) => ({ productId: item.productId || item.id, quantity: item.quantity, variant: item.variant || 'Standard' })),
          contact: {
            fullName: form.fullName,
            mobile: form.mobile
          },
          address: {
            houseStreet: form.houseStreet,
            area: form.area,
            landmark: form.landmark,
            city: form.city,
            state: form.state,
            pincode: form.pincode
          }
        })
      });
      const order = orderResponse.order;
      setCreatedOrder(order);
      const demoPayment = await api(`/orders/${encodeURIComponent(order.id)}/demo-success`, { method: 'POST' });
      const completedOrder = demoPayment.order || order;
      setCreatedOrder(completedOrder);
      if (!directItem) saveCartItems([]);
      recordEvent('product_checkout_completed', { metadata: { orderId: completedOrder.id, itemCount: items.length, mode: 'demo' } });
      setSuccessOrder(completedOrder);
      announce('Checkout successful.');
    } catch (err) {
      setError(err.message || 'Could not complete checkout.');
    } finally {
      setSubmitting(false);
    }
  };

  if (demoModeLoading) {
    return (
      <main className="checkout-page">
        <section className="wrap checkout-empty-state">
          <p className="kicker">Checkout</p>
          <h1>Checking checkout mode...</h1>
          <p>Preparing the storefront settings for this session.</p>
        </section>
      </main>
    );
  }

  if (!demoEcommerceMode) {
    return (
      <main className="checkout-page">
        <section className="wrap checkout-empty-state">
          <p className="kicker">Checkout</p>
          <h1>Product checkout is not enabled.</h1>
          <p>Shop links currently open the linked seller. Demo ecommerce mode can be enabled from admin settings.</p>
          <a className="button" href="/categories">Back to catalog</a>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="checkout-page">
        <section className="wrap checkout-empty-state">
          <p className="kicker">Checkout</p>
          <h1>Sign up to buy.</h1>
          <p>Create a Lookmefy account before placing a demo product order.</p>
          <a className="button" href={`/signup?return=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Create profile</a>
        </section>
      </main>
    );
  }

  if (directProductId && productLoading) {
    return <ProductDetailSkeleton />;
  }

  if (directProductId && (productError || !product)) {
    return (
      <main className="checkout-page">
        <section className="wrap checkout-empty-state">
          <p className="kicker">Checkout</p>
          <h1>This product could not be loaded.</h1>
          <p>{productError || 'Open the catalog and choose another item.'}</p>
          <a className="button" href="/categories">Back to catalog</a>
        </section>
      </main>
    );
  }

  if (!items.length) {
    return (
      <main className="checkout-page">
        <section className="wrap checkout-empty-state">
          <p className="kicker">Checkout</p>
          <h1>Your bag is empty.</h1>
          <p>Add a product before starting prepaid checkout.</p>
          <a className="button" href="/categories">Explore fashion</a>
        </section>
      </main>
    );
  }

  return (
    <main className="checkout-page">
      <section className="wrap checkout-shell" aria-labelledby="checkout-title">
        <form className="checkout-form" onSubmit={startPayment}>
          <div className="checkout-section-head">
            <p className="kicker">Secure checkout</p>
            <h1 id="checkout-title">Checkout</h1>
            <p>For payment and delivery updates</p>
          </div>
          <div className="checkout-field-grid">
            <label><span>Full name</span><input value={form.fullName} onChange={updateField('fullName')} autoComplete="name" required /></label>
            <label><span>Mobile number</span><input value={form.mobile} onChange={updateField('mobile')} inputMode="tel" autoComplete="tel" required /></label>
          </div>

          <div className="checkout-section-head compact">
            <h2>Delivery address</h2>
            <p>Currently delivering within India</p>
          </div>
          <div className="checkout-field-grid">
            <label className="wide"><span>House / flat and street</span><input value={form.houseStreet} onChange={updateField('houseStreet')} autoComplete="address-line1" required /></label>
            <label><span>Area / locality (optional)</span><input value={form.area} onChange={updateField('area')} autoComplete="address-line2" /></label>
            <label><span>Landmark (optional)</span><input value={form.landmark} onChange={updateField('landmark')} /></label>
            <label><span>City</span><input value={form.city} onChange={updateField('city')} autoComplete="address-level2" required /></label>
            <label><span>State</span><select value={form.state} onChange={updateField('state')} autoComplete="address-level1" required><option value="">Choose state</option>{INDIA_STATES.map((state) => <option value={state} key={state}>{state}</option>)}</select></label>
            <label><span>Pincode</span><input value={form.pincode} onChange={updateField('pincode')} inputMode="numeric" pattern="[0-9]{6}" maxLength="6" autoComplete="postal-code" placeholder="Enter a 6-digit pincode" required /></label>
          </div>
          {pincodeStatus && <p className={`checkout-pincode-status ${/not|could/i.test(pincodeStatus) ? 'error-message' : ''}`.trim()}>{pincodeStatus}</p>}

          <div className="checkout-section-head compact">
            <h2>Payment</h2>
            <p>Prepaid and secure</p>
          </div>
          <label className="checkout-payment-option">
            <input type="radio" checked readOnly />
            <span><strong>Prepaid online checkout</strong><small>Pay now confirms the order securely inside Lookmefy.</small></span>
          </label>

          {error && <p className="form-message error-message" role="alert">{error}</p>}
          {createdOrder && !successOrder && <p className="form-message">Order created. Confirming checkout...</p>}
          <button className="checkout-pay-button" type="submit" disabled={submitting}>{submitting ? 'Confirming order...' : 'Pay now'}</button>
        </form>

        <aside className="checkout-summary" aria-label="Order summary">
          <h2>Order summary</h2>
          <div className="checkout-summary-items">
            {items.map((item) => (
              <article className="checkout-summary-item" key={`${item.productId || item.id}-${item.variant}`}>
                <img src={item.imageUrl || asset('hero2.png')} alt="" />
                <div><strong>{item.name}</strong><span>{item.brand || 'Lookmefy'} · Qty {item.quantity}</span></div>
                <b>{formatMoney((Number(item.price) || 0) * (Number(item.quantity) || 1), item.currency)}</b>
              </article>
            ))}
          </div>
          <div className="checkout-total-row"><span>Subtotal</span><strong>{formatMoney(subtotal, currency)}</strong></div>
          <div className="checkout-total-row"><span>Shipping</span><strong>Free</strong></div>
          <div className="checkout-total-row total"><span>Total</span><strong>{formatMoney(total, currency)}</strong></div>
        </aside>
      </section>
      {successOrder && <CheckoutSuccessModal order={successOrder} onClose={() => setSuccessOrder(null)} />}
    </main>
  );
}

function CheckoutSuccessModal({ order, onClose }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="checkout-success-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="checkout-success-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-success-title">
        <button ref={closeButtonRef} className="checkout-success-close" type="button" onClick={onClose} aria-label="Close checkout success"><CloseIcon /></button>
        <div className="checkout-success-mark" aria-hidden="true">✓</div>
        <p className="kicker">Order placed</p>
        <h2 id="checkout-success-title">Checkout successful</h2>
        <p>Your order has been confirmed inside Lookmefy.</p>
        <div className="checkout-success-details">
          <div><span>Order ID</span><strong>{order.merchantOrderId || order.id}</strong></div>
          <div><span>Total</span><strong>{formatMoney(order.total, order.currency)}</strong></div>
          <div><span>Mobile</span><strong>{order.contact?.mobile || 'Not provided'}</strong></div>
          <div><span>Status</span><strong>{order.paymentStatus}</strong></div>
        </div>
        <div className="checkout-success-actions">
          <a className="button" href={`/order/${encodeURIComponent(order.id)}/status`}>View order</a>
          <a className="button secondary" href="/categories">Continue shopping</a>
        </div>
      </section>
    </div>
  );
}

function OrderStatusPage({ id, user }) {
  const [state, setState] = useState({ order: null, loading: true, error: '' });

  useEffect(() => {
    if (!id || !user) return undefined;
    let alive = true;
    let timer = null;
    const load = () => {
      api(`/orders/${encodeURIComponent(id)}/payment-status`, { retry: 0 })
        .then((data) => {
          if (!alive) return;
          const order = data.order || null;
          setState({ order, loading: false, error: '' });
          if (order?.paymentStatus === 'pending') timer = window.setTimeout(load, 5000);
        })
        .catch((err) => {
          if (alive) setState({ order: null, loading: false, error: err.message || 'Could not load order status.' });
        });
    };
    load();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [id, user]);

  const order = state.order;
  const paid = order?.paymentStatus === 'paid';
  const failed = ['failed', 'cancelled'].includes(order?.paymentStatus);

  if (!user) {
    return (
      <main className="checkout-page order-status-page">
        <section className="wrap checkout-empty-state order-status-shell">
          <p className="kicker">Order status</p>
          <h1>Sign in to view this order.</h1>
          <p>Order details are linked to the account that placed the checkout.</p>
          <a className="button" href={`/login?return=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</a>
        </section>
      </main>
    );
  }

  return (
    <main className="checkout-page order-status-page">
      <section className="wrap checkout-empty-state order-status-shell">
        <p className="kicker">Order status</p>
        {state.loading && <h1>Checking payment...</h1>}
        {state.error && <><h1>We could not load this order.</h1><p>{state.error}</p></>}
        {order && (
          <>
            <h1>{paid ? 'Payment received.' : failed ? 'Payment was not completed.' : 'Payment is pending.'}</h1>
            <p>{paid ? 'Your order is confirmed and delivery updates will be sent to your contact details.' : failed ? 'You can return to checkout and try payment again.' : 'Payment is still processing. This page will refresh automatically.'}</p>
            <div className="order-status-details">
              <div><span>Order</span><strong>{order.merchantOrderId || order.id}</strong></div>
              <div><span>Payment</span><strong>{order.paymentStatus}</strong></div>
              <div><span>Fulfillment</span><strong>{order.fulfillmentStatus}</strong></div>
              <div><span>Total</span><strong>{formatMoney(order.total, order.currency)}</strong></div>
            </div>
            <div className="empty-products-actions">
              {failed && <a className="button" href={`/checkout${order.items?.[0]?.productId ? `?productId=${encodeURIComponent(order.items[0].productId)}` : ''}`}>Try again</a>}
              <a className="button secondary" href="/categories">Continue shopping</a>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function AutoPlayingTryOnVideo({ src, poster }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    video.muted = true;
    video.playsInline = true;
    video.currentTime = 0;
    const playPromise = video.play();
    if (playPromise?.catch) playPromise.catch(() => {});
  }, [src]);

  return (
    <video
      ref={videoRef}
      className="tryon-video-player"
      src={src}
      poster={poster}
      autoPlay
      muted
      loop
      playsInline
    />
  );
}

function ProductPage({ id, user, setUser, demoEcommerceMode = false }) {
  const { product, loading, error } = useProduct(id);
  const related = useSimilarProducts(id, 4);
  const [tryOn, setTryOn] = useState(null);
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const [tryOnLoading, setTryOnLoading] = useState(false);
  const [tryOnVideoLoading, setTryOnVideoLoading] = useState(false);
  const [tryOnSlow, setTryOnSlow] = useState(false);
  const [tryOnError, setTryOnError] = useState('');
  const [tryOnVideoError, setTryOnVideoError] = useState('');
  const [tryOnCreditNotice, setTryOnCreditNotice] = useState('');
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [detailImageView, setDetailImageView] = useState('tryon');
  const [sizeRequestOpen, setSizeRequestOpen] = useState(false);
  const productViewStarted = useRef('');
  const relatedProducts = related.products.filter((item) => item.id !== id).slice(0, 4);

  useEffect(() => {
    if (!user || !id) {
      setTryOn(null);
      return;
    }
    let alive = true;
    api(`/tryons?productIds=${encodeURIComponent(id)}`)
      .then((data) => {
        if (!alive) return;
        setTryOn(data.tryOns?.[0] || null);
      })
      .catch(() => {
        if (alive) setTryOn(null);
      });
    return () => {
      alive = false;
    };
  }, [id, user]);

  useEffect(() => {
    setTryOnImageFailed(false);
    setDetailImageView(tryOn?.imageUrl ? 'tryon' : 'product');
  }, [tryOn?.imageUrl]);

  useEffect(() => {
    if (!user || !product?.id || productViewStarted.current === product.id) return;
    productViewStarted.current = product.id;
    recordEvent('product_view', { productId: product.id });
  }, [user, product?.id]);

  useEffect(() => {
    if (product) updateProductSeo(product);
  }, [product]);

  useEffect(() => {
    if (!tryOnLoading && !tryOnVideoLoading) {
      setTryOnSlow(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setTryOnSlow(true), 12000);
    return () => window.clearTimeout(timer);
  }, [tryOnLoading, tryOnVideoLoading]);

  if (loading) {
    return <ProductDetailSkeleton />;
  }

  if (error || !product) {
    return (
      <main className="wrap product-page">
        <div className="empty-products">
          <h3>We couldn't load this product.</h3>
          <p>This item may have moved, or the catalog request may need another try.</p>
          <div className="empty-products-actions">
            <button className="button" type="button" onClick={() => window.location.reload()}>Retry</button>
            <a className="button secondary" href="/categories">Back to Explore</a>
          </div>
        </div>
      </main>
    );
  }

  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? `${Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)}% off` : '';
  const productImage = product.imageUrl || asset('hero2.png');
  const tryOnImageUrl = protectedMediaUrl(tryOn?.imageUrl || '');
  const tryOnVideoUrl = protectedMediaUrl(tryOn?.videoUrl || '');
  const badge = displayProductBadge(product);
  const hasUsableTryOn = Boolean(tryOnImageUrl) && !tryOnImageFailed;
  const hasTryOnVideo = Boolean(tryOnVideoUrl) && hasUsableTryOn;
  const showingTryOnVideo = hasTryOnVideo && detailImageView === 'video';
  const showingTryOn = hasUsableTryOn && (detailImageView === 'tryon' || showingTryOnVideo);
  const showingTryOnImage = hasUsableTryOn && detailImageView === 'tryon';
  const profilePreviewUrl = protectedMediaUrl(user?.bodyPhotoUrl || user?.bodyPhotoOriginalUrl || '');
  const tryOnCost = 1;
  const creditBalance = Number(user?.tokens || 0);
  const image = showingTryOn ? tryOnImageUrl : productImage;
  const swapPreview = hasUsableTryOn && product.imageUrl
    ? {
        label: detailImageView === 'product' ? 'AI Try-On' : 'Product photo',
        src: detailImageView === 'product' ? tryOnImageUrl : product.imageUrl,
        alt: detailImageView === 'product' ? `AI try-on for ${product.name}` : `${product.name} product photo`,
        nextView: detailImageView === 'product' ? 'tryon' : 'product'
      }
    : null;
  const brand = displayBrand(product);
  const category = displayCategory(product);
  const detailFacts = [
    ['Brand', brand],
    ['Category', category],
    ['Fit area', product.garmentPlacement === 'bottom' ? 'Bottomwear' : 'Topwear'],
    ['For', product.gender],
    !demoEcommerceMode && ['Rating', `${Number(product.rating || 0).toFixed(1)}${product.ratingCount ? ` from ${product.ratingCount} reviews` : ''}`],
    ['Price', formatMoney(product.price, product.currency)]
  ].filter(Boolean).filter(([, value]) => value);
  const productTags = (product.tags || []).filter(Boolean).slice(0, 10);
  const editorialImage = relatedProducts.find((item) => item.imageUrl)?.imageUrl || productImage;
  const buyHref = `/checkout?productId=${encodeURIComponent(product.id)}`;
  const authBuyHref = `/signup?return=${encodeURIComponent(buyHref)}`;
  const galleryItems = [
    {
      key: 'product',
      label: 'Product',
      src: productImage,
      active: !showingTryOn,
      onSelect: () => setDetailImageView('product')
    },
    hasUsableTryOn && {
      key: 'tryon',
      label: 'AI Try-On',
      src: tryOnImageUrl,
      active: showingTryOnImage,
      onSelect: () => setDetailImageView('tryon')
    },
    hasTryOnVideo && {
      key: 'video',
      label: 'AI Video',
      src: tryOnImageUrl,
      videoUrl: tryOnVideoUrl,
      active: showingTryOnVideo,
      onSelect: () => setDetailImageView('video')
    }
  ].filter(Boolean);

  const generateProductTryOn = async () => {
    if (!product || tryOnLoading) return;
    const profileBlockMessage = tryOnProfileBlockMessage(user);
    if (profileBlockMessage) {
      setTryOnError(profileBlockMessage);
      return;
    }
    const regenerate = Boolean(tryOn?.imageUrl);
    setTryOnLoading(true);
    setTryOnError('');
    setTryOnCreditNotice('');
    try {
      const data = await generateQueuedTryOn(`/tryons/${product.id}`, {
        method: 'POST',
        timeout: AI_IMAGE_TIMEOUT_MS,
        body: regenerate ? JSON.stringify({ force: true }) : undefined
      });
      setTryOn(data.tryOn);
      setDetailImageView('tryon');
      setTryOnImageFailed(false);
      recordEvent('try_on', { productId: product.id, metadata: { tryOnModel: product.tryOnModel || 'default', regenerated: regenerate } });
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
        setTryOnCreditNotice(`${tryOnCost} credit used. ${Number(data.user.tokens || 0)} credits remaining.`);
      }
    } catch (err) {
      setTryOnError('We couldn\'t create this try-on.');
    } finally {
      setTryOnLoading(false);
    }
  };

  const generateProductTryOnVideo = async () => {
    if (!product || tryOnVideoLoading || tryOnLoading) return;
    const needsImageTryOn = !tryOn?.imageUrl || tryOnImageFailed;
    setTryOnVideoLoading(true);
    setTryOnVideoError('');
    setTryOnCreditNotice('');
    if (needsImageTryOn) {
      setTryOnLoading(true);
      setTryOnError('');
    }
    try {
      let activeTryOn = tryOn;

      if (needsImageTryOn) {
        const preview = await generateQueuedTryOn(`/tryons/${product.id}`, {
          method: 'POST',
          timeout: AI_IMAGE_TIMEOUT_MS,
          body: tryOn?.imageUrl ? JSON.stringify({ force: true }) : undefined
        });
        activeTryOn = preview.tryOn;
        setTryOn(activeTryOn);
        setDetailImageView('tryon');
        setTryOnImageFailed(false);
        recordEvent('try_on', { productId: product.id, metadata: { tryOnModel: product.tryOnModel || 'default', generatedForVideo: true } });
        if (preview.user) {
          setUser((current) => {
            if (!current) return preview.user;
            return { ...preview.user, tokens: Math.min(current.tokens, preview.user.tokens) };
          });
        }
      }

      const regenerate = Boolean(activeTryOn?.videoUrl);
      const data = await api(`/tryons/${product.id}/video`, {
        method: 'POST',
        timeout: AI_VIDEO_TIMEOUT_MS,
        body: regenerate ? JSON.stringify({ force: true }) : undefined
      });
      setTryOn(data.tryOn);
      setDetailImageView('video');
      recordEvent('try_on', { productId: product.id, metadata: { video: true, regenerated: regenerate } });
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
    } catch (err) {
      setTryOnVideoError('We couldn\'t create this try-on.');
    } finally {
      if (needsImageTryOn) setTryOnLoading(false);
      setTryOnVideoLoading(false);
    }
  };

  return (
    <main className="product-page product-editorial-page">
      <section className="wrap product-editorial-detail">
        <div className="product-editorial-breadcrumb"><a href="/categories">New arrivals</a><span>/</span><a href={`/categories/${encodeURIComponent(categorySlug(product.category || ''))}`}>{category}</a></div>
        <div className="product-editorial-grid">
          <div className="product-editorial-gallery">
            <div className={`product-detail-media product-editorial-media ${showingTryOn ? 'showing-tryon' : 'showing-product'}`}>
              {showingTryOnVideo ? (
                <button
                  className="tryon-video-preview-button"
                  type="button"
                  aria-label={`Open video try-on for ${product.name} full screen`}
                  onClick={() => setFullscreenImage({ type: 'video', src: tryOnVideoUrl, poster: tryOnImageUrl, alt: `Video try-on for ${product.name}`, title: product.name })}
                >
                  <AutoPlayingTryOnVideo src={tryOnVideoUrl} poster={tryOnImageUrl} />
                  <span>Tap to preview</span>
                </button>
              ) : (
                <ZoomableImage
                  src={image}
                  alt={product.name}
                  zoom={showingTryOn ? 1 : 1.75}
                  disableZoom={showingTryOn}
                  onOpen={() => setFullscreenImage({
                    src: image,
                    alt: showingTryOn ? `AI try-on for ${product.name}` : `${product.name} product photo`,
                    title: showingTryOn ? product.name : `${product.name} product photo`
                  })}
                  onError={(event) => {
                    if (hasUsableTryOn) setTryOnImageFailed(true);
                    else if (event.currentTarget.src !== window.location.origin + asset('hero2.png')) event.currentTarget.src = asset('hero2.png');
                  }}
                />
              )}
              {badge && <span className="badge">{badge}</span>}
              {showingTryOn && <span className="badge tryon-badge">{showingTryOnVideo ? 'Video Try-On' : 'AI Try-On'}</span>}
              {hasUsableTryOn && !showingTryOnVideo && (
                <button
                  className="fullscreen-button"
                  type="button"
                  aria-label="Open current product image full screen"
                  title="Open full screen"
                  onClick={() => setFullscreenImage({
                    src: image,
                    alt: showingTryOn ? `AI try-on for ${product.name}` : `${product.name} product photo`,
                    title: showingTryOn ? product.name : `${product.name} product photo`
                  })}
                >
                  <FullscreenIcon />
                </button>
              )}
              <TryOnGenerating active={tryOnLoading || tryOnVideoLoading} text={tryOnVideoLoading ? 'Creating your look...' : 'Creating your look...'} />
              {swapPreview && (
                <button
                  className="original-product-preview"
                  type="button"
                  onClick={() => setDetailImageView(swapPreview.nextView)}
                  aria-label={`Show ${swapPreview.label}`}
                  title={`Show ${swapPreview.label}`}
                >
                  <span>{swapPreview.label}</span>
                  <img src={swapPreview.src} alt={swapPreview.alt} />
                </button>
              )}
            </div>
            {showingTryOn && <AiPreviewDisclaimer className="product-ai-disclaimer product-gallery-disclaimer" />}
            <div className="product-editorial-thumbnails" aria-label="Product image gallery">
              {galleryItems.map((item) => (
                <button className={`${item.active ? 'active' : ''} ${item.videoUrl ? 'video-thumb' : ''}`.trim()} type="button" key={item.key} onClick={item.onSelect} aria-label={`Show ${item.label}`} title={item.label}>
                  {item.videoUrl ? <video src={item.videoUrl} poster={item.src} muted playsInline preload="metadata" /> : <img src={item.src} alt="" />}
                  {item.videoUrl && <span aria-hidden="true">▶</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="product-editorial-summary">
            <div className="product-editorial-summary-head">
              <p className="product-editorial-kicker">{brand}</p>
              <h1>{product.name}</h1>
              <div className="product-editorial-price-row">
                <strong>{formatMoney(product.price || 0, product.currency)}</strong>
                {hasDiscount && <del>{formatMoney(product.compareAtPrice, product.currency)}</del>}
                {discount && <span>{discount}</span>}
              </div>
              {!demoEcommerceMode && <p className="product-editorial-rating"><span>Rating</span> {Number(product.rating || 0).toFixed(1)} {product.ratingCount ? `(${product.ratingCount} reviews)` : ''}</p>}
            </div>

            <div className="product-editorial-actions">
              <div className="product-tryon-credit-panel" aria-live="polite">
                <strong>AI Try-On</strong>
                <span>Selected product: {product.name}</span>
                <span>Selected portrait: {profilePreviewUrl ? 'Ready' : 'Add one in Profile'}</span>
                <span>Cost: {tryOnCost} credit</span>
                <span>Balance: {creditBalance} credits</span>
              </div>
              {user ? (
                <button className="product-editorial-tryon" type="button" onClick={generateProductTryOn} disabled={tryOnLoading}>
                  {tryOnLoading ? 'Creating your look...' : hasUsableTryOn ? 'Refresh try-on' : tryOnImageFailed ? 'Try Again' : 'Generate Try-On'}
                </button>
              ) : <a className="product-editorial-tryon" href="/signup">AI try-on</a>}
              {user ? (
                <button className="product-editorial-video" type="button" onClick={generateProductTryOnVideo} disabled={tryOnVideoLoading} title="Generate an AI try-on video">
                  {tryOnVideoLoading ? 'Making video...' : hasTryOnVideo ? 'Refresh video' : 'Generate video'}
                </button>
              ) : <a className="product-editorial-video" href="/signup">Generate video</a>}
              {demoEcommerceMode ? (
                <a className="product-editorial-shop" href={user ? buyHref : authBuyHref} onClick={() => recordEvent(user ? 'buy_now_click' : 'buy_auth_prompt', { productId: product.id })}>{user ? 'Buy now' : 'Sign up to buy'}</a>
              ) : (
                product.affiliateLink && <a className="product-editorial-shop" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={() => recordEvent('shop_click', { productId: product.id })}>Shop now</a>
              )}
            </div>
            {(tryOnLoading || tryOnVideoLoading) && <p className="form-message" role="status">{tryOnSlow ? 'This is taking a little longer than usual.' : 'Preparing your try-on...'}</p>}
            {tryOnCreditNotice && <p className="form-message">{tryOnCreditNotice}</p>}
            <div className="product-editorial-ship"><span>Shipping</span><strong>Live catalog item</strong></div>
            <div className="product-editorial-benefits">
              <div><strong>AI fit preview</strong><span>Built from your Lookmefy profile</span></div>
              <div><strong>Verified catalog</strong><span>Brand and price details</span></div>
            </div>
            {tryOnError && <p className="form-message error-message">{tryOnError}</p>}
            {tryOnVideoError && <p className="form-message error-message">{tryOnVideoError}</p>}

            <div className="product-editorial-accordions">
              <details open>
                <summary>Product details</summary>
                <p>{product.description || 'This product is available through the live Lookmefy catalog.'}</p>
                <dl>{detailFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
              </details>
              <details>
                <summary>Fit and style</summary>
                <p>{product.garmentPlacement === 'bottom' ? 'Designed for bottomwear styling.' : 'Designed to pair seamlessly with your wardrobe.'}{product.gender ? ` Suitable for ${product.gender}.` : ''}</p>
                <div className="product-size-assist">
                  <strong>Can’t find your size?</strong>
                  <button type="button" onClick={() => setSizeRequestOpen(true)}>Ask the Seller</button>
                </div>
                {productTags.length > 0 && <p className="product-editorial-tags">{productTags.map((tag) => <a href={`/categories?tag=${encodeURIComponent(tag)}`} key={tag}>{tag}</a>)}</p>}
              </details>
              <details>
                <summary>Delivery and returns</summary>
                <p>{demoEcommerceMode ? 'Checkout confirms your order inside Lookmefy. Delivery is currently available within India, and order updates are sent to your contact details.' : 'Checkout, delivery, and return terms are managed by Amazon or the linked seller.'}</p>
              </details>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap product-editorial-story">
        <div>
          <p className="product-editorial-story-kicker">Considered by design</p>
          <h2>The details of<br /><em>modernity.</em></h2>
          <p>{product.description || `${brand} brings a considered point of view to ${category.toLowerCase()}. Explore the product, preview it with your personal fit profile, and follow through to Amazon when it feels right.`}</p>
        </div>
        <img src={editorialImage} alt={`${brand} ${category}`} />
      </section>

      {relatedProducts.length > 0 && (
        <section className="wrap product-editorial-related">
          <div className="product-editorial-related-head"><div><p>Curated for you</p><h2>Complete the look</h2></div><a href={`/categories/${encodeURIComponent(categorySlug(product.category || ''))}`}>View all in {category}</a></div>
          <div className="product-editorial-related-grid">{relatedProducts.map((item) => <EditorialRelatedProduct key={item.id} product={item} />)}</div>
        </section>
      )}
      {sizeRequestOpen && <SizeRequestPanel product={product} onClose={() => setSizeRequestOpen(false)} />}
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </main>
  );
}

function SizeRequestPanel({ product, onClose }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="size-request-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="size-request-panel" role="dialog" aria-modal="true" aria-labelledby="size-request-title">
        <header>
          <div>
            <p className="kicker">Seller request</p>
            <h2 id="size-request-title">Can’t find your size?</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close seller size request"><CloseIcon /></button>
        </header>
        <p>Size requests for {product.name} aren’t open yet. Our team can check availability with the brand, or you can explore pieces we have in stock now.</p>
        <div className="size-request-form">
          <a className="primary" href="/support">Contact support</a>
          <a href={`/categories/${encodeURIComponent(categorySlug(product.category || ''))}`}>Browse similar pieces</a>
        </div>
      </section>
    </div>
  );
}

function EditorialRelatedProduct({ product }) {
  const category = displayCategory(product);
  const brand = displayBrand(product);
  return (
    <article className="product-editorial-related-card">
      <a href={`/product/${encodeURIComponent(product.id)}`}>
        <img src={product.imageUrl || asset('hero2.png')} alt={product.name} />
        <p>{brand}</p>
        <h3>{product.name}</h3>
        <strong>{formatMoney(product.price || 0, product.currency)}</strong>
        <span>{category}</span>
      </a>
      <WishlistHeartButton product={product} className="card-wishlist-heart" />
    </article>
  );
}

function StatusPanel({ text, onRetry }) {
  return <div className="status-panel" role="status" aria-live="polite"><p>{text}</p>{onRetry && <button type="button" onClick={onRetry}>Try again</button>}</div>;
}

function Toast({ toast, onDismiss }) {
  const isError = toast.tone === 'error';
  return (
    <div className={`app-toast ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'}>
      <span>{toast.message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification" title="Dismiss notification"><CloseIcon /></button>
    </div>
  );
}

function EmptyProducts({ search }) {
  const query = normalizeSearchQuery(search);
  return (
    <div className="empty-products">
      <h3>{query ? `No exact matches for "${query}"` : 'No styles available yet.'}</h3>
      <p>{query ? 'Try a related style, browse popular categories, or return to Explore.' : 'Products will appear here as soon as the catalog is available.'}</p>
      {query && (
        <div className="empty-products-suggestions" aria-label="Suggested searches">
          <span>Suggested searches</span>
          {suggestedSearchTerms.map((term) => <a href={`/categories?q=${encodeURIComponent(term)}`} key={term}>{term}</a>)}
        </div>
      )}
      <div className="empty-products-actions">
        {featuredSearchCategories.slice(0, 4).map(([label, , value]) => <a href={`/categories/${encodeURIComponent(categorySlug(value))}`} key={value}>{label}</a>)}
        <a className="button" href="/categories">Back to Explore</a>
      </div>
    </div>
  );
}

function ProtectedRouteGate({ path, authChecked }) {
  const details = path.startsWith('/closet')
    ? {
      title: 'Sign in to access your wardrobe',
      copy: 'Save garments, create looks and use AI styling.',
      image: 'wardrobe-stage-room.png'
    }
    : path === '/generation-history'
      ? {
        title: 'Sign in to view your generation history',
        copy: 'See the AI Try-On images you have created.',
        image: 'hero2.png'
      }
    : path === '/profile'
      ? {
        title: 'Sign in to view your profile',
        copy: 'Manage your try-on photo, credits and account details.',
        image: 'hero2.png'
      }
      : {
        title: 'Sign in to continue',
        copy: 'Create a profile to use AI try-on tools and saved account features.',
        image: 'hero2.png'
      };
  const returnPath = `${path || '/'}${window.location.search || ''}`;
  const authHref = `/signup?return=${encodeURIComponent(returnPath)}`;

  return (
    <main className="auth-gate-page">
      <section className="wrap auth-gate-panel" aria-labelledby="auth-gate-title" aria-busy={!authChecked}>
        <div className="auth-gate-copy">
          <p>{authChecked ? 'Account required' : 'Checking account'}</p>
          <h1 id="auth-gate-title">{authChecked ? details.title : 'Checking your account...'}</h1>
          <span>{authChecked ? details.copy : 'We are confirming whether you are already signed in.'}</span>
          {authChecked ? (
            <div className="auth-gate-actions">
              <a className="button" href={authHref}>Continue with Phone</a>
              <a className="button secondary" href="/categories">Back to Explore</a>
            </div>
          ) : (
            <div className="auth-gate-loading" role="status" aria-live="polite">
              <i aria-hidden="true" />
              <span>Loading account state...</span>
            </div>
          )}
        </div>
        <div className="auth-gate-visual" aria-hidden="true">
          <OptimizedImage src={asset(details.image)} alt="" />
        </div>
      </section>
    </main>
  );
}

function NotFoundPage() {
  return (
    <main className="not-found-page">
      <section className="wrap not-found-panel" aria-labelledby="not-found-title">
        <div>
          <p>404</p>
          <h1 id="not-found-title">We couldn't find that page.</h1>
          <span>The page may have moved or no longer exists.</span>
          <div className="not-found-actions">
            <a className="button" href="/categories">Explore Styles</a>
            <a className="button secondary" href="/home">Back Home</a>
          </div>
        </div>
        <nav className="not-found-categories" aria-label="Popular categories">
          {featuredSearchCategories.slice(0, 6).map(([label, , value]) => <a href={`/categories/${encodeURIComponent(categorySlug(value))}`} key={value}>{label}</a>)}
        </nav>
      </section>
    </main>
  );
}

function HowItWorks({ user }) {
  const steps = [
    {
      title: 'Set your fit profile',
      copy: user ? 'Your profile photo is ready, so product try-ons can use the same body reference across the site.' : 'Create an account once with a clear full-body photo so future try-ons have a consistent reference.',
      meta: user ? 'Profile ready' : 'One-time setup'
    },
    {
      title: 'Find a product',
      copy: 'Browse the catalog, search directly, or ask Style Bot for a specific look, budget, occasion, or category.',
      meta: 'Search or Style Bot'
    },
    {
      title: 'Generate the preview',
      copy: 'Use one token to create a try-on image. If that same product was already generated for you, Lookmefy reuses the saved result.',
      meta: '1 token when new'
    },
    {
      title: 'Compare and shop',
      copy: 'Open the generated image full screen, compare it with the product photo, then continue to Amazon when ready.',
      meta: 'Review, then buy'
    }
  ];
  const signals = [
    ['Product pages', 'See product info, saved try-ons, and similar recommendations in one place.'],
    ['Custom try-on', 'Upload your own clothing reference and choose the right generation mode.'],
    ['Recommendations', 'Searches, clicks, try-ons, and shop clicks quietly tune your product suggestions.']
  ];

  return (
    <main className="how-page">
      <section className="wrap how-hero">
        <div>
          <p className="kicker">How Lookmefy Works</p>
          <h1>Four simple steps.</h1>
          <p className="lead">From profile photo to product preview, the whole flow is built around making online shopping feel less like guessing.</p>
          <a className="button" href={user ? '/search' : '/signup'}>{user ? 'Start Shopping' : 'Create Profile'}</a>
        </div>
        <div className="how-hero-visual" aria-hidden="true">
          <img src={asset('search-locked-preview.jpg')} alt="" />
          <div>
            <strong>{user ? 'Ready to try on' : 'Profile starts here'}</strong>
            <span>{user ? 'Browse, generate, compare.' : 'Upload once, preview often.'}</span>
          </div>
        </div>
      </section>

      <section className="wrap how-steps" aria-label="Lookmefy steps">
        {steps.map((step, index) => (
          <article className="how-step" key={step.title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <small>{step.meta}</small>
            <h2>{step.title}</h2>
            <p>{step.copy}</p>
          </article>
        ))}
      </section>

      <section className="wrap how-support">
        {signals.map(([title, copy]) => (
          <article key={title}>
            <h3>{title}</h3>
            <p>{copy}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function AboutPage({ user }) {
  const processSteps = [
    ['01', 'Discover', 'Explore fashion across categories, collections and personalised recommendations.'],
    ['02', 'Try', 'Use AI Try-On to visualise selected clothing on your saved model.'],
    ['03', 'Save', 'Keep products you want in your Wishlist and pieces you own in your Wardrobe.'],
    ['04', 'Style', 'Use your wardrobe and AI Stylist to explore outfit ideas for different occasions.']
  ];
  const flowSteps = ['Explore', 'Wishlist', 'Try On', 'Wardrobe', 'Build a Look', 'AI Stylist'];

  return (
    <main className="about-page">
      <section className="about-hero about-section" aria-labelledby="about-title">
        <div className="wrap about-hero-grid">
          <div className="about-hero-copy">
            <p className="about-kicker">About Lookmefy</p>
            <h1 id="about-title">Fashion, made personal.</h1>
            <p className="about-lead">Lookmefy brings fashion discovery, virtual try-on, your digital wardrobe and AI-powered styling together in one experience.</p>
            <p className="about-sublead">Discover what you like. See how it looks on you. Build outfits around your style.</p>
            <div className="about-actions">
              <a className="about-button about-button-primary" href="/home">Explore Lookmefy</a>
              <a className="about-button about-button-secondary" href="/custom-try-on">Try It On</a>
            </div>
          </div>
          <div className="about-hero-media">
            <OptimizedImage src={asset('about/about-hero.png')} alt="Editorial fashion scene representing Lookmefy style discovery" />
          </div>
        </div>
      </section>

      <section className="about-section about-intro" aria-labelledby="about-intro-title">
        <div className="wrap about-narrow">
          <p className="about-kicker">About Lookmefy</p>
          <h2 id="about-intro-title">A smarter way to discover your style.</h2>
          <div className="about-body">
            <p>Shopping for fashion online often means jumping between products, imagining how something might look, saving screenshots and trying to remember what already works with your wardrobe.</p>
            <p>Lookmefy is designed to bring those moments together.</p>
            <p>Discover fashion from across the platform, virtually try selected pieces, save products you love, organise what you own in your digital wardrobe and use AI-powered styling tools to help put looks together.</p>
          </div>
        </div>
      </section>

      <section className="about-section about-process" aria-labelledby="about-process-title">
        <div className="wrap">
          <div className="about-section-heading">
            <p className="about-kicker">How it works</p>
            <h2 id="about-process-title">From discovery to outfit.</h2>
          </div>
          <div className="about-step-grid">
            {processSteps.map(([number, title, copy]) => (
              <article className="about-step" key={title}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="about-section about-feature" aria-labelledby="about-tryon-title">
        <div className="wrap about-feature-grid">
          <div className="about-feature-media">
            <OptimizedImage src={asset('about/about-tryon.png')} alt="Fashion model preview for AI try-on" />
          </div>
          <div className="about-feature-copy">
            <p className="about-kicker">AI Try-On</p>
            <h2 id="about-tryon-title">See the look before making it yours.</h2>
            <p>Lookmefy's virtual try-on experience lets you use your saved model and compatible clothing images to create an AI-generated visual preview.</p>
            <p>It is designed to help you explore styles and combinations before deciding what you want to save, wear or shop.</p>
            <p className="about-note">AI-generated previews are visual representations and may not exactly reproduce real-world fit, sizing, fabric behaviour or appearance.</p>
            <a className="about-text-link" href="/custom-try-on">Try It On</a>
          </div>
        </div>
      </section>

      <section className="about-section about-feature about-feature-reverse" aria-labelledby="about-wardrobe-title">
        <div className="wrap about-feature-grid">
          <div className="about-feature-copy">
            <p className="about-kicker">Your Wardrobe</p>
            <h2 id="about-wardrobe-title">Your clothes, organised around you.</h2>
            <p>Save the pieces you own and build a digital wardrobe that stays connected to your Lookmefy experience.</p>
            <p>Combine tops, bottoms, outerwear, shoes and accessories, experiment with different looks and keep the pieces you reach for close at hand.</p>
            <a className="about-text-link" href="/closet">Open Wardrobe</a>
          </div>
          <div className="about-feature-media">
            <OptimizedImage src={asset('about/about-wardrobe.png')} alt="Minimal wardrobe room for organizing saved fashion pieces" />
          </div>
        </div>
      </section>

      <section className="about-section about-feature" aria-labelledby="about-stylist-title">
        <div className="wrap about-feature-grid">
          <div className="about-feature-media">
            <OptimizedImage src={asset('about/about-stylist.png')} alt="Styled outfit scene for AI stylist ideas" />
          </div>
          <div className="about-feature-copy">
            <p className="about-kicker">AI Stylist</p>
            <h2 id="about-stylist-title">Ask what to wear.</h2>
            <p>Need an everyday outfit, something for work, a date, a trip or a special occasion?</p>
            <p>Lookmefy's AI Stylist is designed to help you explore outfit ideas using your preferences, saved fashion and wardrobe context where available.</p>
            <a className="about-text-link" href="/style-bot">Ask AI Stylist</a>
          </div>
        </div>
      </section>

      <section className="about-section about-discovery" aria-labelledby="about-discovery-title">
        <div className="wrap about-discovery-grid">
          <div>
            <p className="about-kicker">Discover</p>
            <h2 id="about-discovery-title">Fashion beyond a single store.</h2>
            <p>Lookmefy helps users discover fashion through categories, collections and product recommendations while bringing those discoveries into the same experience as Wishlist, Try-On and Wardrobe.</p>
            <a className="about-text-link" href="/categories">Explore Fashion</a>
          </div>
          <div className="about-discovery-panel">
            <OptimizedImage src={asset('about/about-discovery.png')} alt="Editorial fashion category discovery preview" />
          </div>
        </div>
      </section>

      <section className="about-section about-connected" aria-labelledby="about-connected-title">
        <div className="wrap about-connected-inner">
          <h2 id="about-connected-title">Everything works better together.</h2>
          <p>Lookmefy is designed so fashion discovery does not end when you find a product. Save it, visualise it, connect it to your wardrobe and use it as part of your personal style journey.</p>
          <ol className="about-flow" aria-label="Lookmefy connected flow">
            {flowSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      </section>

      <section className="about-section about-vision" aria-labelledby="about-vision-title">
        <div className="wrap about-narrow">
          <p className="about-kicker">Our Vision</p>
          <h2 id="about-vision-title">Make online fashion feel more personal.</h2>
          <div className="about-body">
            <p>We believe discovering fashion online should be more than scrolling through endless products.</p>
            <p>Our goal with Lookmefy is to create a more connected experience where technology helps people explore what they like, understand how pieces might work together and make more confident style decisions.</p>
            <p>We are continuing to improve Lookmefy as our AI experiences, catalogue and personalisation systems evolve.</p>
          </div>
        </div>
      </section>

      <section className="about-section about-responsible" aria-labelledby="about-responsible-title">
        <div className="wrap about-responsible-grid">
          <div>
            <p className="about-kicker">Responsible AI</p>
            <h2 id="about-responsible-title">Designed with your experience in mind.</h2>
          </div>
          <div className="about-body">
            <p>Some Lookmefy features use AI to create visual previews and styling suggestions. AI-generated results can vary and should be treated as visual guidance rather than an exact representation of real-world sizing or fit.</p>
            <p>Where users provide photos or other personal content, those experiences should follow the application's existing Privacy Policy, consent flows and data-handling implementation.</p>
            <div className="about-actions about-actions-compact">
              <a className="about-button about-button-secondary" href="/privacy">Privacy Policy</a>
              <a className="about-button about-button-secondary" href="/terms">Terms</a>
            </div>
          </div>
        </div>
      </section>

      <section className="about-section about-final" aria-labelledby="about-final-title">
        <div className="wrap about-final-inner">
          <p className="about-kicker">Start with your style</p>
          <h2 id="about-final-title">Find it. Try it. Style it.</h2>
          <p>Explore fashion in a way that feels more like you.</p>
          <div className="about-actions">
            <a className="about-button about-button-primary" href="/categories">Explore Fashion</a>
            <a className="about-button about-button-secondary" href="/custom-try-on">Try It On</a>
          </div>
        </div>
      </section>
    </main>
  );
}

function DownloadDeviceMockup({ label, variant = 'explore' }) {
  return (
    <div className={`download-device-mockup ${variant}`} aria-label={`${label} app screen placeholder`}>
      <div className="download-device-shell">
        <div className="download-device-notch" aria-hidden="true" />
        <div className="download-device-status"><span>9:41</span><span>Lookmefy</span></div>
        <div className="download-device-content">
          <div className="download-device-hero-card">
            <span>{label}</span>
            <strong>{variant === 'tryon' ? 'Try it on' : variant === 'stylist' ? 'Your style edit' : 'Mockup ready'}</strong>
          </div>
          <div className="download-device-grid" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="download-device-tabs" aria-hidden="true"><span /><span /><span /><span /><span /></div>
      </div>
    </div>
  );
}

function DownloadPhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="2.8" width="10" height="18.4" rx="2" />
      <path d="M10 5h4M11 18.5h2" />
    </svg>
  );
}

function DownloadHeroMockup() {
  const [imageUnavailable, setImageUnavailable] = useState(false);

  if (!imageUnavailable) {
    return (
      <div className="download-hero-phone-stage">
        <OptimizedImage
          className="download-hero-mockup-image"
          src={asset('download-hero-mobile-screen.png')}
          fallbackSrc=""
          alt="Lookmefy mobile app home screen showing categories and new arrivals"
          eager
          highResolution={false}
          onError={() => setImageUnavailable(true)}
        />
      </div>
    );
  }

  return (
    <div className="download-hero-devices">
      <DownloadDeviceMockup label="AI Try-On" variant="tryon" />
      <DownloadDeviceMockup label="My Wardrobe" variant="wardrobe" />
    </div>
  );
}

function DownloadExploreMockup() {
  const sideItems = [
    { label: 'Popular', icon: 'star' },
    { label: 'Kurti, Saree & Lehenga', image: 'category-generated/ethnic-wear.png' },
    { label: 'Women Western', image: 'category-icons/tops-section.png' },
    { label: 'Lingerie', image: 'category-icons/innerwear-section.png' },
    { label: 'Men', image: 'category-generated/shirts.png', active: true },
    { label: 'Beauty', image: 'category-generated/bags.png' },
    { label: 'Footwear', image: 'category-icons/shoes-section.png' }
  ];
  const featuredItems = [
    { label: 'Shirts', image: 'category-generated/shirts.png' },
    { label: 'T-Shirts', image: 'category-generated/t-shirts.png' },
    { label: 'Shoes', image: 'category-icons/shoes-section.png' }
  ];
  const fashionItems = [
    { label: 'Shirts', image: 'category-generated/shirts.png' },
    { label: 'Pants', image: 'category-generated/pants.png' },
    { label: 'Jeans', image: 'category-generated/jeans.png' },
    { label: 'Jackets', image: 'category-generated/jackets.png' },
    { label: 'Watches', image: 'category-generated/watches.png' },
    { label: 'Eyewear', image: 'category-generated/eyewear.png' }
  ];
  const bottomTabs = [
    ['Home', <HomeIcon />],
    ['Categories', <GridIcon />, true],
    ['Wardrobe', <ClosetIcon />],
    ['AI Studio', <SparkleLineIcon />],
    ['Profile', <UserIcon />]
  ];

  return (
    <div className="download-explore-mockup" aria-label="Lookmefy Categories mobile app mockup">
      <span className="download-explore-hardware download-explore-hardware-left-one" aria-hidden="true" />
      <span className="download-explore-hardware download-explore-hardware-left-two" aria-hidden="true" />
      <span className="download-explore-hardware download-explore-hardware-right" aria-hidden="true" />
      <div className="download-explore-camera" aria-hidden="true" />
      <div className="download-explore-status" aria-hidden="true">
        <span>2:27</span>
        <span className="download-explore-status-icons"><i /><i /><i /></span>
        <span className="download-explore-signal"><i /><i /><i /></span>
      </div>
      <div className="download-explore-header">
        <div className="download-explore-brand">
          <span className="download-explore-logo-mark">LM</span>
          <span />
          <strong>Lookmefy</strong>
        </div>
        <div className="download-explore-actions" aria-hidden="true">
          <SearchIcon />
          <HeartIcon />
          <svg viewBox="0 0 24 24"><path d="M7 4h10v16H7z" /><path d="M10 8h4M10 12h4M10 16h2" /><path d="M5 7h2M5 11h2M5 15h2" /></svg>
        </div>
      </div>
      <div className="download-explore-body">
        <aside className="download-explore-sidebar" aria-hidden="true">
          {sideItems.map((item) => (
            <div className={`download-explore-side-item${item.active ? ' is-active' : ''}`} key={item.label}>
              {item.icon === 'star' ? <span className="download-explore-star">★</span> : <OptimizedImage src={asset(item.image)} fallbackSrc="" alt="" highResolution={false} />}
              <span>{item.label}</span>
            </div>
          ))}
        </aside>
        <div className="download-explore-content">
          <p>MEN</p>
          <h3>Featured For Men</h3>
          <div className="download-explore-featured-grid">
            {featuredItems.map((item) => (
              <div className="download-explore-category" key={item.label}>
                <span><OptimizedImage src={asset(item.image)} fallbackSrc="" alt="" highResolution={false} /></span>
                <strong>{item.label}</strong>
              </div>
            ))}
          </div>
          <hr />
          <h3>All Men Fashion</h3>
          <div className="download-explore-fashion-grid">
            {fashionItems.map((item) => (
              <div className="download-explore-category" key={item.label}>
                <span><OptimizedImage src={asset(item.image)} fallbackSrc="" alt="" highResolution={false} /></span>
                <strong>{item.label}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
      <nav className="download-explore-bottom-tabs" aria-hidden="true">
        {bottomTabs.map(([label, icon, active]) => (
          <span className={active ? 'is-active' : ''} key={label}>
            {icon}
            <small>{label}</small>
          </span>
        ))}
      </nav>
    </div>
  );
}

function DownloadScreenVisual({ screen }) {
  if (screen.deviceImage) {
    return (
      <OptimizedImage
        className={`download-screen-device-image ${screen.variant || ''}`.trim()}
        src={asset(screen.deviceImage)}
        fallbackSrc=""
        alt={screen.alt}
        highResolution={false}
      />
    );
  }

  if (screen.image) {
    return (
      <span className={`download-screen-image-frame ${screen.variant || ''}`.trim()}>
        <OptimizedImage
          className="download-screen-image"
          src={asset(screen.image)}
          fallbackSrc=""
          alt={screen.alt}
          highResolution={false}
        />
      </span>
    );
  }

  return <DownloadDeviceMockup label={screen.label} variant={screen.variant} />;
}

function DownloadAppPage() {
  const featureItems = [
    ['AI Try-On', 'Try on outfits with AI and see your perfect look instantly.', <SparkleLineIcon />],
    ['Personal Wardrobe', 'Organize your clothes and create your own digital wardrobe.', <ClosetIcon />],
    ['Saved Looks', 'Save your favorite styles and shop them whenever you like.', <HeartIcon />],
    ['Generation History', 'View and manage all your AI try-on creations in one place.', <AtelierIcon name="clock" />],
    ['AI Stylist', 'Get personalized style recommendations just for you.', <UserIcon />]
  ];
  const appScreens = [
    {
      label: 'Explore',
      variant: 'explore',
      deviceImage: 'download-screen-explore-device.png',
      alt: 'Lookmefy mobile Categories screen showing Featured For Men and All Men Fashion'
    },
    {
      label: 'AI Try-On',
      variant: 'tryon',
      deviceImage: 'download-screen-tryon-device.png',
      alt: 'Lookmefy mobile AI Try-On screen showing a generated outfit preview and product details'
    },
    {
      label: 'Wardrobe',
      variant: 'wardrobe',
      deviceImage: 'download-screen-wardrobe-device.png',
      alt: 'Lookmefy mobile wardrobe screen with Try This outfit action'
    },
    {
      label: 'AI Stylist',
      variant: 'stylist',
      deviceImage: 'download-screen-stylist-device.png',
      alt: 'Lookmefy mobile AI Studio screen showing AI stylist recommendations and product cards'
    },
    {
      label: 'Profile',
      variant: 'profile',
      deviceImage: 'download-screen-profile-device.png',
      alt: 'Lookmefy mobile profile screen showing credits and generation history'
    }
  ];

  return (
    <main className="download-page">
      <section className="download-hero download-section" aria-labelledby="download-title">
        <div className="wrap download-hero-grid">
          <div className="download-hero-copy">
            <p className="download-kicker">LOOKMEFY APP</p>
            <h1 id="download-title">Your personal AI stylist, now in your pocket.</h1>
            <p className="download-lead">Discover styles, try on looks with AI, manage your wardrobe and keep your fashion experience with you wherever you go.</p>
            <StoreActions context="download_hero" />
          </div>
          <div className="download-hero-visual" aria-label="Lookmefy app mockup placement">
            <div className="download-hero-visual-bg" aria-hidden="true" />
            <DownloadHeroMockup />
          </div>
        </div>
      </section>

      <section className="download-section download-features" aria-labelledby="download-features-title">
        <div className="wrap">
          <div className="download-section-heading">
            <p className="download-kicker">Everything Lookmefy, wherever you go</p>
            <h2 id="download-features-title">Powerful features, made for you.</h2>
          </div>
          <div className="download-feature-grid">
            {featureItems.map(([title, copy, icon]) => (
              <article className="download-feature-item" key={title}>
                <span className="download-feature-icon" aria-hidden="true">{icon}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="download-section download-screens" aria-labelledby="download-screens-title">
        <div className="wrap">
          <div className="download-section-heading">
            <p className="download-kicker">Designed for your everyday style</p>
            <h2 id="download-screens-title">Experience Lookmefy</h2>
          </div>
          <div className="download-screen-rail">
            {appScreens.map((screen) => (
              <figure className="download-screen-card" key={screen.label}>
                <DownloadScreenVisual screen={screen} />
                <figcaption>{screen.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      <section className="download-section download-final-cta" aria-labelledby="download-final-title">
        <div className="wrap download-final-inner">
          <span className="download-final-icon"><DownloadPhoneIcon /></span>
          <div>
            <h2 id="download-final-title">Take Lookmefy with you</h2>
            <p>Download the app and keep your style, wardrobe and AI Try-On experience in one place.</p>
          </div>
          <StoreActions context="download_bottom" />
        </div>
      </section>
    </main>
  );
}

function InfoPage({ meta, children, user, ctaLabel, ctaHref, demoEcommerceMode = false }) {
  const policy = policyForPath(normalizePath(), demoEcommerceMode);
  if (policy && !children) return <PolicyContent policy={policy} />;

  const [kicker, title, lead, image] = meta;
  const actionLabel = ctaLabel || (user ? 'Browse Products' : 'Create Profile');
  const actionHref = ctaHref || (user ? '/search' : '/signup');

  return (
    <main className="info-page-main">
      <section className="page-hero"><div className="wrap hero-grid"><div className="page-copy"><p className="kicker">{kicker}</p><h1>{title}</h1><p className="lead">{lead}</p><a className="button" href={actionHref}>{actionLabel}</a></div><div className="page-image"><OptimizedImage src={asset(image)} alt="" /></div></div></section>
      {children || <section className="section"><div className="wrap info-grid"><article className="info-card"><h3>AI try-on ready</h3><p>Preview selected products on your profile.</p></article><article className="info-card"><h3>Catalog shopping</h3><p>Explore styles, categories, and new arrivals.</p></article><article className="info-card"><h3>Token powered</h3><p>Use tokens only when generating previews.</p></article><article className="info-card"><h3>Privacy aware</h3><p>Your full-body photo is part of your personal profile.</p></article></div></section>}
    </main>
  );
}

function PolicyContent({ policy }) {
  return (
    <main className="section policy-page" aria-label={policy.title}>
      <div className="wrap policy-shell">
        <header className="policy-summary">
          <h1>{policy.title}</h1>
          <p>{policy.intro}</p>
          <small>Last updated: {legalDetails.lastUpdated}</small>
        </header>
        <div className="policy-sections">
          {policy.sections.map(([heading, paragraphs]) => (
            <article className="policy-section" key={heading}>
              <h3>{heading}</h3>
              {paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}

function AuthInputField({ label, className = '', icon = null, type = 'text', ...inputProps }) {
  const inputId = inputProps.id || `auth-${inputProps.name}`;
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === 'password';

  return (
    <div className={`auth-input-field ${className}`.trim()}>
      <label htmlFor={inputId}>{label}</label>
      <div className="auth-input-shell">
        {icon && <span className="auth-input-icon" aria-hidden="true">{icon}</span>}
        <input id={inputId} type={isPassword && showPassword ? 'text' : type} {...inputProps} />
        {isPassword && (
          <button
            className="auth-password-toggle"
            type="button"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            <EyeIcon crossed={showPassword} />
          </button>
        )}
      </div>
    </div>
  );
}

function AuthSubmitButton({ children, loading = false }) {
  return (
    <button className="auth-submit-button" type="submit" disabled={loading} aria-busy={loading}>
      <span>{children}</span>
      <span aria-hidden="true">&rarr;</span>
    </button>
  );
}

function OnboardingOverview({ user, onComplete, onClose, persist = true }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [spotlight, setSpotlight] = useState({ x: 0, y: 0, radius: 86 });
  const [isMobileTour, setIsMobileTour] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
  ));
  const dialogRef = useRef(null);
  const nextButtonRef = useRef(null);

  const steps = useMemo(() => [
    {
      eyebrow: 'Welcome',
      title: 'Let’s take a quick tour',
      body: 'A few seconds to understand Lookmefy: browse products, try them on, save pieces, and build outfits.',
      gain: 'You can skip this anytime.',
      icon: <SparkleLineIcon />,
      visual: 'Profile - Browse - Try on',
      target: 'Lookmefy',
      position: 'center',
      selectors: ['.brand', '.site-logo', '.app-logo'],
      mobileSelectors: ['.site-header .brand', '.brand', '.site-logo', '.app-logo'],
      fallback: { x: 50, y: 36, radius: 96 },
      mobileFallback: { x: 42, y: 9, radius: 54 }
    },
    {
      eyebrow: 'Explore',
      title: 'Shop the catalog',
      body: 'Use search, categories, offers, and new arrivals to find relevant pieces quickly.',
      gain: 'Less scrolling, better product discovery.',
      icon: <SearchIcon />,
      visual: 'Search + filters',
      target: 'Search and explore',
      position: 'top',
      selectors: ['.desktop-search', '.search-shell', '.mobile-search-trigger', 'a[href="/categories"]', 'a[href="/search"]'],
      mobileSelectors: ['.mobile-search-trigger', '.mobile-bottom-nav a[href="/categories"]', 'a[href="/search"]', 'a[href="/categories"]'],
      fallback: { x: 50, y: 14, radius: 88 },
      mobileFallback: { x: 62, y: 8, radius: 50 }
    },
    {
      eyebrow: 'Preview',
      title: 'AI Try-On',
      body: 'Open any product and generate an AI preview using your saved Lookmefy profile.',
      gain: 'Check the look before buying.',
      icon: <TryOnIcon />,
      visual: 'Product - AI preview',
      target: 'AI try-on button',
      position: 'right',
      selectors: ['a[href="/custom-try-on"]', 'a[href="/try-on"]', '.mobile-bottom-nav a[href="/custom-try-on"]', '.mobile-bottom-nav a[href="/try-on"]', '.product-ai-tryon-button', '.ai-tryon-button'],
      mobileSelectors: ['.mobile-bottom-nav a[href="/custom-try-on"]', '.mobile-bottom-nav a[href="/try-on"]', 'a[href="/custom-try-on"]', 'a[href="/try-on"]', '.product-ai-tryon-button', '.ai-tryon-button'],
      fallback: { x: 58, y: 84, radius: 74 },
      mobileFallback: { x: 50, y: 92, radius: 54 }
    },
    {
      eyebrow: 'Wardrobe',
      title: 'Build your Smart Closet',
      body: 'Upload your own clothes, choose saved tops and bottoms, and generate outfit ideas.',
      gain: 'Turn browsing into outfit planning instead of one-item decisions.',
      icon: <ClosetIcon />,
      visual: 'Upload - Combine - Save',
      target: 'Wardrobe',
      position: 'left',
      selectors: ['a[href="/closet"]', '.mobile-bottom-nav a[href="/closet"]', '.closet-link', '.wardrobe-link'],
      mobileSelectors: ['.mobile-bottom-nav a[href="/closet"]', 'a[href="/closet"]', '.closet-link', '.wardrobe-link'],
      fallback: { x: 72, y: 86, radius: 76 },
      mobileFallback: { x: 72, y: 92, radius: 54 }
    },
    {
      eyebrow: 'AI Stylist',
      title: 'Ask AI Stylist for outfit help',
      body: 'Get outfit ideas from AI Stylist, then use Wishlist and credits to save favorites and keep try-ons moving.',
      gain: 'Keep outfit help and saved decisions in one place.',
      mobileEyebrow: 'AI Stylist',
      mobileTitle: 'Ask AI Stylist',
      mobileBody: 'Get outfit ideas, then use Wishlist and credits to save favorites and keep try-ons moving.',
      mobileGain: 'Keep outfit help one tap away on mobile.',
      mobileTarget: 'AI Stylist',
      icon: <SparkleLineIcon />,
      visual: 'Ask - Save - Credits',
      target: 'AI Stylist',
      position: 'bottom-right',
      selectors: ['.site-header .nav a[href="/style-bot"]', '.site-header .nav a[href="/signup"]', '.credits-pill', '.credit-button', 'a[href="/wishlist"]', '.mobile-bottom-nav a[href="/style-bot"]'],
      mobileSelectors: ['.mobile-bottom-nav a[href="/style-bot"]', '.site-header .nav a[href="/style-bot"]', '.site-header .nav a[href="/signup"]', '.mobile-bottom-nav a[href="/profile"]', '.header-credit-button', '.credits-pill', '.credit-button', 'a[href="/wishlist"]'],
      fallback: { x: 82, y: 18, radius: 80 },
      mobileFallback: { x: 80, y: 8, radius: 52 }
    },
    {
      eyebrow: 'Ready',
      title: 'You are all set',
      body: 'Start exploring. You can replay this tour anytime from your profile.',
      gain: 'Let us get your first look moving.',
      icon: <GlobeIcon />,
      visual: 'Enter Lookmefy',
      target: 'Start shopping',
      position: 'center',
      selectors: [],
      fallback: { x: 50, y: 42, radius: 92 },
      mobileFallback: { x: 50, y: 50, radius: 70 }
    }
  ], [user?.name]);

  const step = steps[stepIndex];
  const hasSpotlightTarget = stepIndex !== 0 && stepIndex !== steps.length - 1;
  const displayStep = isMobileTour ? {
    ...step,
    eyebrow: step.mobileEyebrow || step.eyebrow,
    title: step.mobileTitle || step.title,
    body: step.mobileBody || step.body,
    gain: step.mobileGain || step.gain,
    target: step.mobileTarget || step.target
  } : step;
  const isLastStep = stepIndex === steps.length - 1;
  const spotlightStyle = {
    '--tour-x': `${Math.round(spotlight.x)}px`,
    '--tour-y': `${Math.round(spotlight.y)}px`,
    '--tour-radius': `${Math.round(spotlight.radius)}px`
  };

  const markComplete = async (reason) => {
    if (saving) return;
    setError('');
    if (!persist) {
      onClose?.();
      return;
    }

    setSaving(true);
    try {
      const data = await api('/auth/onboarding', {
        method: 'PATCH',
        body: JSON.stringify({ reason })
      });
      if (data.user) onComplete?.(data.user);
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not save onboarding status. Try again.');
      setSaving(false);
    }
  };

  const focusableElements = () => Array.from(dialogRef.current?.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ) || []).filter((element) => element.offsetParent !== null || element === document.activeElement);

  const onDialogKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      markComplete('escape');
      return;
    }
    if (event.key !== 'Tab') return;

    const items = focusableElements();
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const updateMobileTourState = () => {
      setIsMobileTour(window.matchMedia('(max-width: 760px)').matches);
    };

    updateMobileTourState();
    window.addEventListener('resize', updateMobileTourState);
    window.addEventListener('orientationchange', updateMobileTourState);
    window.visualViewport?.addEventListener('resize', updateMobileTourState);

    return () => {
      window.removeEventListener('resize', updateMobileTourState);
      window.removeEventListener('orientationchange', updateMobileTourState);
      window.visualViewport?.removeEventListener('resize', updateMobileTourState);
    };
  }, []);

  useEffect(() => {
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlHeight = document.documentElement.style.height;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyLeft = document.body.style.left;
    const previousBodyRight = document.body.style.right;
    const previousBodyWidth = document.body.style.width;
    const previousBodyHeight = document.body.style.height;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousBodyTouchAction = document.body.style.touchAction;
    const preventTourScroll = (event) => {
      event.preventDefault();
    };
    const holdTourScroll = () => {
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
        window.scrollTo(scrollX, scrollY);
      }
    };

    document.documentElement.classList.add('onboarding-scroll-locked');
    document.body.classList.add('onboarding-scroll-locked');
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.height = '100%';
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = `-${scrollX}px`;
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.height = '100dvh';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.touchAction = 'none';
    document.addEventListener('wheel', preventTourScroll, { passive: false, capture: true });
    document.addEventListener('touchmove', preventTourScroll, { passive: false, capture: true });
    window.addEventListener('scroll', holdTourScroll, { passive: true });
    window.requestAnimationFrame(() => nextButtonRef.current?.focus());
    return () => {
      document.removeEventListener('wheel', preventTourScroll, true);
      document.removeEventListener('touchmove', preventTourScroll, true);
      window.removeEventListener('scroll', holdTourScroll);
      document.documentElement.classList.remove('onboarding-scroll-locked');
      document.body.classList.remove('onboarding-scroll-locked');
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.height = previousHtmlHeight;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.left = previousBodyLeft;
      document.body.style.right = previousBodyRight;
      document.body.style.width = previousBodyWidth;
      document.body.style.height = previousBodyHeight;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.body.style.touchAction = previousBodyTouchAction;
      window.scrollTo(scrollX, scrollY);
    };
  }, []);

  useEffect(() => {
    nextButtonRef.current?.focus();
  }, [stepIndex]);

  useLayoutEffect(() => {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
    const clampCenter = (value, size, radius, padding) => {
      const min = padding + radius;
      const max = size - padding - radius;
      return min > max ? size / 2 : clamp(value, min, max);
    };
    const getViewport = () => ({
      width: window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0
    });

    const findVisibleTarget = (selectors = []) => {
      const viewport = getViewport();
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        const target = elements.find((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 4
            && rect.height > 4
            && rect.bottom > 0
            && rect.right > 0
            && rect.top < viewport.height
            && rect.left < viewport.width
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0;
        });
        if (target) return target;
      }
      return null;
    };

    let frameId = 0;
    let observedTarget = null;
    let resizeObserver = null;
    let mutationObserver = null;

    const setMeasuredSpotlight = (nextSpotlight) => {
      setSpotlight((current) => {
        const isSame = Math.abs(current.x - nextSpotlight.x) < 0.5
          && Math.abs(current.y - nextSpotlight.y) < 0.5
          && Math.abs(current.radius - nextSpotlight.radius) < 0.5;
        return isSame ? current : nextSpotlight;
      });
    };

    const scheduleSpotlightUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateSpotlight();
      });
    };

    const observeTarget = (target) => {
      if (observedTarget === target) return;
      resizeObserver?.disconnect();
      resizeObserver = null;
      observedTarget = target;
      if (!target || typeof ResizeObserver === 'undefined') return;

      resizeObserver = new ResizeObserver(scheduleSpotlightUpdate);
      resizeObserver.observe(target);
      const layoutParent = target.closest?.('.mobile-bottom-nav, .site-header, .desktop-search, .header-actions, .mobile-header-actions, header');
      if (layoutParent && layoutParent !== target) resizeObserver.observe(layoutParent);
    };

    const updateSpotlight = () => {
      const viewport = getViewport();
      const isMobile = viewport.width <= 760;
      const viewportMin = Math.min(viewport.width, viewport.height);
      const minRadius = isMobile ? 16 : 46;
      const maxRadius = Math.max(minRadius, Math.min(isMobile ? 42 : 108, viewportMin * (isMobile ? 0.1 : 0.16)));
      const edgePadding = isMobile ? 12 : 28;
      const mobileFallback = isMobile ? step.mobileFallback : null;
      const targetSelectors = isMobile ? (step.mobileSelectors || step.selectors) : step.selectors;
      const target = findVisibleTarget(targetSelectors);
      if (target) {
        const rect = target.getBoundingClientRect();
        const focusSize = rect.width > rect.height * 2.4
          ? rect.height
          : Math.max(rect.width, rect.height);
        const isBottomNavTarget = isMobile && target.closest?.('.mobile-bottom-nav');
        const radius = clamp((focusSize / 2) + (isBottomNavTarget ? 2 : isMobile ? 4 : 16), minRadius, isBottomNavTarget ? 28 : maxRadius);
        observeTarget(target);
        setMeasuredSpotlight({
          x: clamp(rect.left + rect.width / 2, edgePadding, viewport.width - edgePadding),
          y: clamp(rect.top + rect.height / 2, edgePadding, viewport.height - edgePadding),
          radius
        });
        return;
      }

      observeTarget(null);
      const fallback = mobileFallback || step.fallback || { x: 50, y: 50, radius: 92 };
      const fallbackRadius = clamp(isMobile ? fallback.radius * 0.82 : fallback.radius, minRadius, maxRadius);
      setMeasuredSpotlight({
        x: clampCenter(viewport.width * (fallback.x / 100), viewport.width, fallbackRadius, edgePadding),
        y: clampCenter(viewport.height * (fallback.y / 100), viewport.height, fallbackRadius, edgePadding),
        radius: fallbackRadius
      });
    };

    updateSpotlight();
    const timer = window.setTimeout(scheduleSpotlightUpdate, 220);
    const secondTimer = window.setTimeout(scheduleSpotlightUpdate, 520);
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(scheduleSpotlightUpdate);
      mutationObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        childList: true,
        subtree: true
      });
    }
    window.addEventListener('resize', scheduleSpotlightUpdate);
    window.addEventListener('orientationchange', scheduleSpotlightUpdate);
    window.visualViewport?.addEventListener('resize', scheduleSpotlightUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleSpotlightUpdate);
    window.addEventListener('scroll', scheduleSpotlightUpdate, true);

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.clearTimeout(timer);
      window.clearTimeout(secondTimer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', scheduleSpotlightUpdate);
      window.removeEventListener('orientationchange', scheduleSpotlightUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleSpotlightUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleSpotlightUpdate);
      window.removeEventListener('scroll', scheduleSpotlightUpdate, true);
    };
  }, [step]);

  return (
    <div
      className={`onboarding-overview onboarding-cinematic onboarding-tour-step-${stepIndex} onboarding-tour-${step.position} ${hasSpotlightTarget ? 'has-spotlight-target' : 'no-spotlight-target'}`}
      role="presentation"
      style={spotlightStyle}
    >
      {hasSpotlightTarget && <div className="onboarding-tour-spotlight" aria-hidden="true">
        <span>{step.icon}</span>
      </div>}
      <section
        ref={dialogRef}
        className={`onboarding-dialog onboarding-cinematic-caption ${stepIndex === 0 || isLastStep ? 'intro' : 'tooltip'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-copy"
        onKeyDown={onDialogKeyDown}
      >
        <header className="onboarding-topbar">
          <div>
            <p>{displayStep.eyebrow}</p>
            <span>{stepIndex + 1} / {steps.length}</span>
          </div>
          <button type="button" onClick={() => markComplete('skip')} disabled={saving}>
            {saving ? 'Saving...' : 'Skip'}
          </button>
        </header>

        <div className="onboarding-content">
          <div className="onboarding-copy">
            <small>{displayStep.target}</small>
            <h2 id="onboarding-title">{displayStep.title}</h2>
            <p id="onboarding-copy">{displayStep.body}</p>
            <b>{displayStep.gain}</b>
          </div>
        </div>

        {error && <p className="onboarding-error" role="alert">{error}</p>}

        <footer className="onboarding-actions">
          <button type="button" onClick={() => setStepIndex((current) => Math.max(0, current - 1))} disabled={stepIndex === 0 || saving}>
            Back
          </button>
          <div className="onboarding-progress" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
            {steps.map((item, index) => (
              <span className={index === stepIndex ? 'active' : ''} key={item.title} />
            ))}
          </div>
          <button
            ref={nextButtonRef}
            type="button"
            onClick={() => isLastStep ? markComplete('finish') : setStepIndex((current) => Math.min(steps.length - 1, current + 1))}
            disabled={saving}
          >
            {saving ? 'Saving...' : isLastStep ? 'Done' : stepIndex === 0 ? 'Take a tour' : 'Next'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function isLikelyIndianMobile(phone = '') {
  const raw = String(phone || '').trim();
  if (!raw || /[a-z]/i.test(raw)) return false;
  const digits = raw.replace(/\D/g, '');
  const local = digits.length === 10
    ? digits
    : digits.length === 11 && digits.startsWith('0')
      ? digits.slice(1)
      : digits.length === 12 && digits.startsWith('91')
        ? digits.slice(2)
        : '';
  return /^[6-9]\d{9}$/.test(local);
}

function normalizePhoneEntry(phone = '') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) return digits.slice(2, 12);
  if (digits.length > 10 && digits.startsWith('0')) return digits.slice(1, 11);
  return digits.slice(0, 10);
}

function OtpCodeFields({ idPrefix, value, onChange, disabled }) {
  const otp = String(value || '').replace(/\D/g, '').slice(0, 6);
  const setOtp = (nextValue) => {
    const next = String(nextValue || '').replace(/\D/g, '').slice(0, 6);
    onChange(next);
  };

  return (
    <fieldset className="otp-code-fields" aria-label="Enter verification code">
      <legend>OTP</legend>
      <div className="otp-code-grid">
        <input
          id={`${idPrefix}-code`}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          aria-label="6-digit OTP"
          placeholder="6-digit OTP"
          maxLength="6"
          value={otp}
          disabled={disabled}
          onChange={(event) => setOtp(event.target.value)}
          onPaste={(event) => {
            event.preventDefault();
            setOtp(event.clipboardData.getData('text'));
          }}
        />
      </div>
    </fieldset>
  );
}

function AuthEditorialStory() {
  return (
    <section className="auth-login-story auth-login-reference-story" aria-label="Lookmefy fashion experience">
      <OptimizedImage className="auth-login-background" src={asset('login-editorial-couple.png')} alt="" eager />
      <div className="auth-login-scrim" aria-hidden="true" />
      <a className="auth-login-logo" href="/" aria-label="Lookmefy home"><BrandLogo /></a>
      <div className="auth-login-story-copy">
        <h2>AI Fashion Try-On Experience</h2>
        <p>See it on you before you buy it. Experience a more personal way to shop.</p>
        <ul className="auth-login-benefits" aria-label="Lookmefy benefits">
          {[
            ['AI Try-On', 'See selected styles on your profile.'],
            ['Smart Closet', 'Keep your wardrobe in one place.'],
            ['AI Stylist', 'Find looks that fit your point of view.']
          ].map(([title, copy]) => (
            <li key={title}>
              <strong>{title}</strong>
              <small>{copy}</small>
            </li>
          ))}
        </ul>
      </div>
      <p className="auth-login-copyright">Lookmefy, curated with intelligence.</p>
    </section>
  );
}

function ForgotPasswordPage() {
  const [step, setStep] = useState('phone');
  const [phoneValue, setPhoneValue] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [otpSession, setOtpSession] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState('');
  const [loading, setLoading] = useState(false);
  const [localOtpLoading, setLocalOtpLoading] = useState(false);
  const [localTestOtp, setLocalTestOtp] = useState('');
  const [localOtpIssue, setLocalOtpIssue] = useState('');
  const shouldAutoFocusAuthField = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    && window.innerWidth > 700;

  const cancelReset = async (session = otpSession, phone = phoneValue) => {
    if (!session || !phone) return;
    try {
      await api('/auth/password-reset/cancel-otp', {
        method: 'POST',
        body: JSON.stringify({ phone, otpSession: session }),
        retry: 0
      });
    } catch {
      // Reset completion remains server-authoritative.
    }
  };

  const fetchLocalTestOtp = async (session, phone, { fill = false } = {}) => {
    if (!ENABLE_TEST_OTP_HELPER || !session || !phone || localOtpLoading) return '';
    setLocalOtpLoading(true);
    setLocalOtpIssue('');
    try {
      const params = new URLSearchParams({ purpose: 'password-reset', phone, otpSession: session });
      const data = await api(`/auth/test-otp?${params.toString()}`, { retry: 0 });
      const otp = String(data.otp || '').replace(/\D/g, '').slice(0, 6);
      setLocalTestOtp(otp);
      if (fill) setOtpValue(otp);
      if (!otp) setLocalOtpIssue('No local test OTP was returned for this request.');
      return otp;
    } catch (error) {
      setLocalTestOtp('');
      const detail = error?.message && !/not found/i.test(error.message)
        ? ` ${error.message}`
        : ' Enable mock OTP delivery and ENABLE_TEST_OTP_HELPER on the server.';
      setLocalOtpIssue(`Local test OTP is unavailable.${detail}`);
      return '';
    } finally {
      setLocalOtpLoading(false);
    }
  };

  const requestOtp = async (event) => {
    event?.preventDefault();
    if (loading) return;
    if (!isLikelyIndianMobile(phoneValue)) {
      setMessage('Enter a valid mobile number.');
      setMessageTone('error');
      return;
    }
    setLoading(true);
    setMessage('');
    setMessageTone('');
    try {
      const data = await api('/auth/password-reset/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue })
      });
      const nextSession = data.otpSession || '';
      const nextPhone = data.phone || phoneValue;
      setOtpSession(nextSession);
      setPhoneValue(nextPhone);
      setOtpValue('');
      setLocalTestOtp('');
      setLocalOtpIssue('');
      setStep('otp');
      const testOtp = await fetchLocalTestOtp(nextSession, nextPhone);
      setMessage(testOtp ? `OTP sent. Test code: ${testOtp}` : data.message || 'OTP sent.');
      setMessageTone('success');
    } catch (error) {
      setMessage(error.message);
      setMessageTone('error');
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async (event) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setMessage('');
    setMessageTone('');
    try {
      const data = await api('/auth/password-reset/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otp: otpValue, otpSession })
      });
      setOtpSession(data.otpSession || otpSession);
      setPhoneValue(data.phone || phoneValue);
      setStep('password');
      setMessage('');
      setMessageTone('');
    } catch (error) {
      setMessage(error.message);
      setMessageTone('error');
    } finally {
      setLoading(false);
    }
  };

  const resetPassword = async (event) => {
    event.preventDefault();
    if (loading) return;
    if (newPassword.length < 12) {
      setMessage('Password must be at least 12 characters.');
      setMessageTone('error');
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage('Passwords do not match.');
      setMessageTone('error');
      return;
    }
    setLoading(true);
    setMessage('Resetting password...');
    setMessageTone('');
    try {
      await api('/auth/password-reset', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otpSession, password: newPassword })
      });
      window.history.pushState({}, '', '/login?passwordReset=success');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (error) {
      setMessage(error.message);
      setMessageTone('error');
    } finally {
      setLoading(false);
    }
  };

  const changeNumber = () => {
    const session = otpSession;
    const phone = phoneValue;
    setStep('phone');
    setOtpSession('');
    setOtpValue('');
    setLocalTestOtp('');
    setLocalOtpIssue('');
    setMessage('');
    setMessageTone('');
    if (session) void cancelReset(session, phone);
  };

  const title = step === 'phone' ? 'Forgot Password?' : step === 'otp' ? 'Enter Your OTP' : 'Create New Password';
  const copy = step === 'phone'
    ? 'Enter the mobile number linked to your Lookmefy account.'
    : step === 'otp'
      ? `Enter the 6-digit code sent to ${phoneValue}.`
      : 'Choose a new password for your account.';

  return (
    <main className="auth-login-page auth-login-reference-page auth-reset-page" aria-labelledby="forgot-password-title">
      <AuthEditorialStory />
      <section className="auth-login-panel auth-login-reference-panel">
        <div className="auth-login-card">
          <a className="auth-login-mobile-logo" href="/" aria-label="Lookmefy home"><BrandLogo /></a>
          <p className="auth-reset-eyebrow">Account recovery</p>
          <h1 id="forgot-password-title">{title}</h1>
          <p className="auth-login-copy">{copy}</p>

          {step === 'phone' && (
            <form className="auth-login-form auth-reset-form" onSubmit={requestOtp} aria-busy={loading}>
              <AuthInputField label="Mobile number" name="resetPhone" type="tel" inputMode="numeric" pattern="[0-9]*" required autoFocus={shouldAutoFocusAuthField} autoComplete="tel-national" placeholder="Mobile number" value={phoneValue} onChange={(event) => setPhoneValue(normalizePhoneEntry(event.target.value))} />
              <button className="signup-submit-button signup-otp-button" type="submit" disabled={loading || !phoneValue.trim()}>{loading ? 'Sending OTP...' : 'Send OTP'}</button>
            </form>
          )}

          {step === 'otp' && (
            <form className="auth-login-form auth-reset-form" onSubmit={verifyOtp} aria-busy={loading}>
              <OtpCodeFields idPrefix="password-reset-otp" value={otpValue} onChange={setOtpValue} disabled={loading} />
              {ENABLE_TEST_OTP_HELPER && (
                <div className="signup-test-otp-panel" role="status" aria-live="polite">
                  <p className={`signup-test-otp ${localOtpIssue && !localTestOtp ? 'signup-test-otp-error' : ''}`}>
                    {localTestOtp ? <>Test OTP: <strong>{localTestOtp}</strong></> : localOtpLoading ? 'Getting test OTP...' : localOtpIssue || 'Test OTP appears here when local mock delivery is enabled.'}
                  </p>
                  <button className="signup-test-otp-action" type="button" disabled={localOtpLoading || !otpSession} onClick={() => fetchLocalTestOtp(otpSession, phoneValue, { fill: true })}>
                    {localTestOtp ? 'Fill OTP' : localOtpLoading ? 'Checking...' : 'Show test OTP'}
                  </button>
                </div>
              )}
              <button className="signup-submit-button signup-otp-button" type="submit" disabled={loading || otpValue.length < 6}>{loading ? 'Verifying...' : 'Verify OTP'}</button>
              <div className="auth-reset-actions">
                <button type="button" onClick={requestOtp} disabled={loading}>Resend OTP</button>
                <button type="button" onClick={changeNumber} disabled={loading}>Change number</button>
              </div>
            </form>
          )}

          {step === 'password' && (
            <form className="auth-login-form auth-reset-form" onSubmit={resetPassword} aria-busy={loading}>
              <AuthInputField label="New password" name="newPassword" type="password" required minLength="12" maxLength="72" autoComplete="new-password" placeholder="At least 12 characters" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              <AuthInputField label="Confirm password" name="confirmPassword" type="password" required minLength="12" maxLength="72" autoComplete="new-password" placeholder="Repeat your password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              <button className="signup-submit-button signup-otp-button" type="submit" disabled={loading || !newPassword || !confirmPassword}>{loading ? 'Resetting...' : 'Reset Password'}</button>
            </form>
          )}

          {message && <p className={`auth-login-message form-message ${messageTone === 'error' ? 'error-message' : ''}`} role="status" aria-live="polite">{message}</p>}
          <p className="auth-login-switch-inline"><a href="/login" onClick={() => void cancelReset()}>Back to login</a></p>
        </div>
      </section>
    </main>
  );
}

function AuthPage({ mode, setUser }) {
  const bodyPhotoCameraRef = useRef(null);
  const [message, setMessage] = useState('');
  const [nameValue, setNameValue] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirmPassword, setSignupConfirmPassword] = useState('');
  const [signupStep, setSignupStep] = useState('phone');
  const [phoneValue, setPhoneValue] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [otpSession, setOtpSession] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [localOtpLoading, setLocalOtpLoading] = useState(false);
  const [localTestOtp, setLocalTestOtp] = useState('');
  const [localOtpIssue, setLocalOtpIssue] = useState('');
  const [bodyPhotoFile, setBodyPhotoFile] = useState(null);
  const [bodyPhotoPreview, setBodyPhotoPreview] = useState('');
  const [profilePhotoMode, setProfilePhotoMode] = useState('ai-full-body');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const isSignup = mode === 'signup';
  const shouldAutoFocusAuthField = typeof window !== 'undefined'
    && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
    && window.innerWidth > 700;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resetSucceeded = mode === 'login' && params.get('passwordReset') === 'success';
    const loginIdentifier = mode === 'login' ? (params.get('identifier') || params.get('email') || params.get('phone') || '') : '';
    setMessage(resetSucceeded ? 'Password reset successfully. Sign in with your new password.' : '');
    setCapsLock(false);
    setIsSubmitting(false);
    setOtpLoading(false);
    setLocalOtpLoading(false);
    setPhoneValue(loginIdentifier);
    setOtpValue('');
    setOtpSession('');
    setLocalTestOtp('');
    setLocalOtpIssue('');
    setSignupPassword('');
    setSignupConfirmPassword('');
    if (mode === 'signup') {
      setSignupStep('phone');
    }
  }, [mode, window.location.search]);

  useEffect(() => () => {
    if (bodyPhotoPreview) URL.revokeObjectURL(bodyPhotoPreview);
  }, [bodyPhotoPreview]);

  const previewBodyPhoto = (event) => {
    const file = event.currentTarget.files?.[0];
    setBodyPhotoFile(file || null);
    setMessage(file && file.size > MAX_BODY_PHOTO_BYTES ? ((isHeicFile(file) || isAvifFile(file)) ? 'Large AVIF/HEIC/HEIF photo selected. Please choose one under 8 MB.' : 'Large profile photo selected. It will be optimized before upload.') : '');
    setBodyPhotoPreview(file ? URL.createObjectURL(file) : '');
  };

  const cancelOtpSession = async (purpose, session = otpSession, phone = phoneValue) => {
    if (!session || !phone) return;
    try {
      await api(`/auth/${purpose}/cancel-otp`, {
        method: 'POST',
        body: JSON.stringify({ phone, otpSession: session }),
        retry: 0
      });
    } catch {
      // The next verification/account step is still server-authoritative.
    }
  };

  const clearOtpEntry = (purpose) => {
    const session = otpSession;
    const phone = phoneValue;
    setOtpSession('');
    setOtpValue('');
    setLocalTestOtp('');
    setLocalOtpIssue('');
    setMessage('');
    if (session) void cancelOtpSession(purpose, session, phone);
  };

  const updatePhoneEntry = (purpose, nextPhone) => {
    const session = otpSession;
    const phone = phoneValue;
    setPhoneValue(normalizePhoneEntry(nextPhone));
    setOtpSession('');
    setOtpValue('');
    setLocalTestOtp('');
    setLocalOtpIssue('');
    if (session) void cancelOtpSession(purpose, session, phone);
  };

  const redirectExistingAccountToLogin = (error, fallbackIdentifier = phoneValue) => {
    const identifier = error?.identifier || error?.data?.identifier || fallbackIdentifier;
    window.history.pushState({}, '', loginHrefForIdentifier(identifier));
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const fetchLocalTestOtp = async (purpose, session = otpSession, phone = phoneValue, { fill = false } = {}) => {
    if (!ENABLE_TEST_OTP_HELPER || !session || !phone || localOtpLoading) return '';
    setLocalOtpLoading(true);
    setLocalOtpIssue('');
    try {
      const params = new URLSearchParams({ purpose, phone, otpSession: session });
      const data = await api(`/auth/test-otp?${params.toString()}`, { retry: 0 });
      const otp = String(data.otp || '').replace(/\D/g, '').slice(0, 6);
      setLocalTestOtp(otp);
      if (fill) setOtpValue(otp);
      if (!otp) setLocalOtpIssue('No local test OTP was returned for this request.');
      return otp;
    } catch (err) {
      setLocalTestOtp('');
      const detail = err?.message && !/not found/i.test(err.message)
        ? ` ${err.message}`
        : ' Enable mock OTP delivery and ENABLE_TEST_OTP_HELPER on the server.';
      setLocalOtpIssue(`Local test OTP is unavailable.${detail}`);
      return '';
    } finally {
      setLocalOtpLoading(false);
    }
  };

  const renderLocalTestOtpHelper = (purpose) => {
    if (!ENABLE_TEST_OTP_HELPER) return null;
    const helperText = localTestOtp
      ? <>Test OTP: <strong>{localTestOtp}</strong></>
      : localOtpLoading
        ? 'Getting test OTP...'
        : localOtpIssue || 'Test OTP appears here when local mock delivery is enabled.';
    return (
      <div className="signup-test-otp-panel" role="status" aria-live="polite">
        <p className={`signup-test-otp ${localOtpIssue && !localTestOtp ? 'signup-test-otp-error' : ''}`}>{helperText}</p>
        <button
          className="signup-test-otp-action"
          type="button"
          disabled={localOtpLoading || !otpSession}
          onClick={() => fetchLocalTestOtp(purpose, otpSession, phoneValue, { fill: true })}
        >
          {localTestOtp ? 'Fill OTP' : localOtpLoading ? 'Checking...' : 'Show test OTP'}
        </button>
      </div>
    );
  };

  const requestSignupOtp = async () => {
    if (otpLoading) return;
    if (!isLikelyIndianMobile(phoneValue)) {
      setMessage('Enter a valid mobile number.');
      return;
    }
    setOtpLoading(true);
    setMessage('');
    try {
      const data = await api('/auth/signup/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue })
      });
      const nextSession = data.otpSession || '';
      const nextPhone = data.phone || phoneValue;
      setOtpSession(nextSession);
      setPhoneValue(nextPhone);
      setOtpValue('');
      setLocalTestOtp('');
      setLocalOtpIssue('');
      const testOtp = await fetchLocalTestOtp('signup', nextSession, nextPhone);
      setMessage(testOtp ? `OTP sent. Test code: ${testOtp}` : 'OTP sent.');
    } catch (err) {
      if (isExistingAccountError(err)) {
        redirectExistingAccountToLogin(err, phoneValue);
        return;
      }
      setMessage(err.message);
    } finally {
      setOtpLoading(false);
    }
  };

  const verifySignupOtp = async () => {
    if (otpLoading) return;
    setOtpLoading(true);
    setMessage('');
    try {
      const data = await api('/auth/signup/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otp: otpValue, otpSession })
      });
      setOtpSession(data.otpSession || otpSession);
      setPhoneValue(data.phone || phoneValue);
      setSignupStep('details');
      setMessage('');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setOtpLoading(false);
    }
  };

  const requestLoginOtp = async () => {
    if (otpLoading) return;
    if (!isLikelyIndianMobile(phoneValue)) {
      setMessage('Enter a valid mobile number.');
      return;
    }
    setOtpLoading(true);
    setMessage('');
    try {
      const data = await api('/auth/login/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue })
      });
      const nextSession = data.otpSession || '';
      const nextPhone = data.phone || phoneValue;
      setOtpSession(nextSession);
      setPhoneValue(nextPhone);
      setOtpValue('');
      setLocalTestOtp('');
      setLocalOtpIssue('');
      const testOtp = await fetchLocalTestOtp('login', nextSession, nextPhone);
      setMessage(testOtp ? `OTP sent. Test code: ${testOtp}` : 'OTP sent.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setOtpLoading(false);
    }
  };

  const verifyLoginOtp = async () => {
    if (otpLoading) return;
    setOtpLoading(true);
    setMessage('');
    try {
      const data = await api('/auth/login/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ phone: phoneValue, otp: otpValue, otpSession })
      });
      const destination = authReturnPath();
      writeAuthToken(data.token);
      setUser(data.user);
      window.history.pushState({}, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      setMessage(err.message);
    } finally {
      setOtpLoading(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (isSignup && signupStep !== 'details') return;
    setIsSubmitting(true);
    setMessage(isSignup ? 'Creating account...' : 'Logging in...');
    try {
      const form = event.currentTarget;
      const loginIdentifier = String(phoneValue || '').trim();
      if (!isSignup && !loginIdentifier) throw new Error('Enter your mobile number or email.');
      if (!isSignup && !isLikelyEmail(loginIdentifier) && !isLikelyIndianMobile(loginIdentifier)) throw new Error('Enter a valid mobile number or email.');
      const body = isSignup
        ? new FormData(form)
        : JSON.stringify({
          [isLikelyEmail(loginIdentifier) ? 'email' : 'phone']: loginIdentifier,
          password: String(new FormData(form).get('password') || '')
        });
      if (isSignup) {
        const cleanName = String(body.get('name') || '').trim();
        const password = String(body.get('password') || '');
        const confirmPassword = String(body.get('confirmPassword') || '');
        if (password.length < 12) throw new Error('Password must be at least 12 characters.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        const random = Math.random().toString(36).slice(2, 8);
        const suffix = `${Date.now().toString(36)}${random}`;
        const baseUsername = cleanName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 24) || 'fitlook_user';
        const bodyPhoto = bodyPhotoFile || form.elements.bodyPhoto?.files?.[0] || bodyPhotoCameraRef.current?.files?.[0];
        if (!bodyPhoto) throw new Error('Choose or take a profile photo first.');
        body.set('username', `${baseUsername}_${suffix}`.slice(0, 48));
        body.set('email', `profile_${suffix}@fitlook.local`);
        body.set('password', password);
        body.set('phone', phoneValue);
        body.set('otpSession', otpSession);
        body.set('bodyPhoto', await prepareBodyPhoto(bodyPhoto));
      }
      const data = await api(isSignup ? '/auth/signup' : '/auth/login', { method: 'POST', body });
      const destination = authReturnPath();
      writeAuthToken(data.token);
      setUser(data.user);
      window.history.pushState({}, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      if (isSignup && isExistingAccountError(err)) {
        redirectExistingAccountToLogin(err, phoneValue);
        return;
      }
      setMessage(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isSignup) {
    return (
      <main className="auth-login-page auth-login-reference-page" aria-labelledby="login-title">
        <AuthEditorialStory />

        <section className="auth-login-panel auth-login-reference-panel">
          <div className="auth-login-card">
            <a className="auth-login-mobile-logo" href="/" aria-label="Lookmefy home"><BrandLogo /></a>
            <h1 id="login-title">Welcome Back</h1>
            <p className="auth-login-copy">Login with your mobile number or email and password.</p>
            <div className="auth-login-tabs" aria-hidden="true"><span>Password Login</span></div>
            <form className="auth-login-form" onSubmit={submit} aria-busy={isSubmitting}>
              <AuthInputField label="Mobile number or email" name="loginIdentifier" type="text" required autoFocus={shouldAutoFocusAuthField} autoComplete="username" placeholder="Mobile number or email" value={phoneValue} onChange={(event) => setPhoneValue(event.target.value)} />
              <AuthInputField label="Password" name="password" type="password" required autoComplete="current-password" placeholder="Enter your password" />
              <p className="auth-login-switch-inline auth-forgot-password-link"><a href="/forgot-password">Forgot password?</a></p>
              <button className="signup-submit-button signup-otp-button" type="submit" disabled={isSubmitting || !phoneValue.trim()}>{isSubmitting ? 'Logging in...' : 'Login'}</button>
              <p className="auth-login-switch-inline">New to Lookmefy? <a href="/signup">Sign up</a></p>
              <p className="auth-login-switch-inline"><a href="/categories">Explore without login</a></p>
            </form>
            {message && <p className={`auth-login-message form-message ${/Logging in|Working|Password reset successfully/.test(message) ? '' : 'error-message'}`}>{message}</p>}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-signup-page auth-signup-reference-page" aria-labelledby="signup-title">
      <section className="auth-signup-reference-shell">
        <form className={`auth-signup-form auth-signup-reference-form signup-step-${signupStep}`} onSubmit={submit} aria-busy={isSubmitting}>
          <a className="auth-signup-reference-logo" href="/" aria-label="Lookmefy home"><BrandLogo /></a>
          <header className="auth-signup-reference-head">
            <h1 id="signup-title">{signupStep === 'phone' ? <>Verify Your<br />Number</> : <>Create Your<br />Account</>}</h1>
            <p>{signupStep === 'phone' ? 'Start with your mobile number and OTP verification.' : 'Set your password and add the style details for your AI try-on profile.'}</p>
          </header>

          {signupStep === 'phone' ? (
            <div className="signup-phone-step">
              <div className="auth-signup-reference-fields">
                <label className="signup-field">
                  <span>Mobile number</span>
                  <input name="phoneDisplay" type="tel" inputMode="numeric" pattern="[0-9]*" required autoFocus={shouldAutoFocusAuthField} autoComplete="tel-national" placeholder="Mobile number" value={phoneValue} onChange={(event) => updatePhoneEntry('signup', event.target.value)} />
                </label>
              </div>
              <button className="signup-submit-button signup-otp-button" type="button" disabled={otpLoading || !phoneValue.trim()} onClick={requestSignupOtp}>{otpLoading ? 'Sending OTP...' : otpSession ? 'Resend OTP' : 'Send OTP'}</button>
              {otpSession && (
                <div className="auth-signup-reference-fields">
                  <OtpCodeFields idPrefix="signup-otp" value={otpValue} onChange={setOtpValue} disabled={otpLoading} />
                  {renderLocalTestOtpHelper('signup')}
                  <button className="signup-submit-button signup-otp-button" type="button" disabled={otpLoading || otpValue.length < 6} onClick={verifySignupOtp}>{otpLoading ? 'Verifying...' : 'Verify & continue'}</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <button className="signup-back-step" type="button" onClick={() => { setSignupStep('phone'); clearOtpEntry('signup'); }}>Change number</button>
              <div className="auth-signup-reference-fields">
                <label className="signup-field">
                  <span>Full name</span>
                  <input name="name" required autoFocus={shouldAutoFocusAuthField} value={nameValue} autoComplete="name" placeholder="Enter your name" onChange={(event) => setNameValue(event.target.value)} />
                </label>
                <AuthInputField className="signup-field" label="Create password" name="password" type="password" required minLength="12" maxLength="72" value={signupPassword} autoComplete="new-password" placeholder="At least 12 characters" onChange={(event) => setSignupPassword(event.target.value)} />
                <AuthInputField className="signup-field" label="Confirm password" name="confirmPassword" type="password" required minLength="12" maxLength="72" value={signupConfirmPassword} autoComplete="new-password" placeholder="Repeat your password" onChange={(event) => setSignupConfirmPassword(event.target.value)} />
              </div>

              <fieldset className="signup-gender-group">
                <legend>Style preference</legend>
                {[
                  ['female', 'Women'],
                  ['male', 'Men'],
                  ['other', 'All styles']
                ].map(([value, label], index) => (
                  <label key={value}>
                    <input type="radio" name="genderPreference" value={value} required={index === 0} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>

              <div className="signup-reference-photo-row">
                <label className={`signup-reference-photo-choice signup-upload-box ${bodyPhotoPreview ? 'has-preview' : ''}`}>
                  <input name="bodyPhoto" type="file" accept={BODY_PHOTO_ACCEPT} onChange={previewBodyPhoto} />
                  {bodyPhotoPreview ? <img className="upload-preview" src={bodyPhotoPreview} alt="Uploaded model profile preview" /> : <><strong>Upload a photo</strong><small>Clear selfie or full-body image</small></>}
                </label>
                <button className="signup-reference-photo-choice signup-camera-button" type="button" onClick={() => bodyPhotoCameraRef.current?.click()}><strong>Take a photo</strong><small>Use your camera</small></button>
                <input ref={bodyPhotoCameraRef} className="camera-input" type="file" accept={BODY_PHOTO_ACCEPT} capture="user" onChange={previewBodyPhoto} />
                <input type="hidden" name="profilePhotoMode" value={profilePhotoMode} />
              </div>

              {bodyPhotoPreview && (
                <div className="signup-reference-profile-mode" role="radiogroup" aria-label="Choose how to use your uploaded photo">
                  <button type="button" className={profilePhotoMode === 'exact' ? 'active' : ''} onClick={() => setProfilePhotoMode('exact')} aria-pressed={profilePhotoMode === 'exact'}>Use this exact photo</button>
                  <button type="button" className={profilePhotoMode === 'ai-full-body' ? 'active' : ''} onClick={() => setProfilePhotoMode('ai-full-body')} aria-pressed={profilePhotoMode === 'ai-full-body'}>AI full body profile</button>
                </div>
              )}

              <label className="signup-terms">
                <input name="terms" type="checkbox" required />
                <span>I agree to Lookmefy creating an AI try-on profile from my uploaded photo and accept the <a href="/terms">Terms</a>, <a href="/privacy">Privacy Policy</a>, and <a href="/ai-disclaimer">AI Disclaimer</a>.</span>
              </label>
              <button className="signup-submit-button" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? 'Creating account...' : 'Sign up'}</button>
            </>
          )}

          {message && <p className={`signup-message form-message ${/OTP sent|Local code filled|Creating account/.test(message) ? '' : 'error-message'}`}>{message}</p>}
          <p className="signup-switch">Already have an account? <a href="/login">Log in</a></p>
          <p className="signup-switch"><a href="/categories">Explore without login</a></p>
        </form>

        <aside className="auth-signup-reference-scene" aria-label="Lookmefy wardrobe preview">
          <img src={asset('wardrobe-room.jpg')} alt="Warm modern wardrobe interior" />
          <a href="/categories" className="auth-signup-reference-explore">Explore</a>
          <div className="auth-signup-scene-notes" aria-hidden="true">
            <div><img src={asset('arrival-3.jpg')} alt="" /><span><strong>Personalized for you</strong><small>Curated pieces for your style</small></span></div>
            <div><img src={asset('arrival-5.jpg')} alt="" /><span><strong>AI style edit</strong><small>Looks built around you</small></span></div>
            <div><span><strong>Your profile, your closet</strong><small>Try on more before you buy</small></span></div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function FeatureBand() {
  const items = [
    ['Trending Now', 'Hot right now', <SparkleLineIcon />],
    ['Best Sellers', 'Top picks', <HeartIcon />],
    ['New Arrivals', 'New styles added', <BagIcon />],
    ['Fast Delivery', 'Across the world', <GlobeIcon />]
  ];

  return (
    <section className="feature-band">
      <div className="wrap features">
        {items.map(([title, copy, icon]) => (
          <div className="feature" key={title}>
            <div className="feature-icon" aria-hidden="true">{icon}</div>
            <div><p className="feature-title">{title}</p><p className="feature-copy">{copy}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [path, setPath] = useState(normalizePath());
  const [routeKey, setRouteKey] = useState(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(() => !readAuthToken());
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [toast, setToast] = useState(null);
  const [replayTourOpen, setReplayTourOpen] = useState(false);
  const storefrontConfig = useStorefrontConfig();
  const demoEcommerceMode = Boolean(storefrontConfig.demoEcommerceMode);
  const scrollPositions = useRef(new Map());
  const toastTimer = useRef(null);

  const syncRoute = () => {
    setPath(normalizePath());
    setRouteKey(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  };

  const navigateTo = (next) => {
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next === current) return;
    const currentPath = normalizePath();
    const nextPath = new URL(next, window.location.href).pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
    if ((['/login', '/signup', '/forgot-password'].includes(currentPath) || ['/login', '/signup', '/forgot-password'].includes(nextPath)) && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    scrollPositions.current.set(current, window.scrollY);
    window.history.pushState({}, '', next);
    syncRoute();
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  };

  useEffect(() => {
    const onPop = () => {
      syncRoute();
      const key = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.requestAnimationFrame(() => window.scrollTo({ top: scrollPositions.current.get(key) || 0, left: 0, behavior: 'auto' }));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const updateNetworkState = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateNetworkState);
    window.addEventListener('offline', updateNetworkState);
    return () => {
      window.removeEventListener('online', updateNetworkState);
      window.removeEventListener('offline', updateNetworkState);
    };
  }, []);

  useEffect(() => {
    const showToast = (event) => {
      const detail = event.detail || {};
      const message = String(detail.message || '').trim();
      if (!message) return;
      window.clearTimeout(toastTimer.current);
      setToast({ id: Date.now(), message, tone: detail.tone === 'error' ? 'error' : 'success' });
      toastTimer.current = window.setTimeout(() => setToast(null), 4000);
    };
    window.addEventListener('fitlook:toast', showToast);
    return () => {
      window.removeEventListener('fitlook:toast', showToast);
      window.clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    const replayOnboarding = () => {
      if (user) setReplayTourOpen(true);
    };
    window.addEventListener('fitlook:replay-onboarding', replayOnboarding);
    return () => window.removeEventListener('fitlook:replay-onboarding', replayOnboarding);
  }, [user]);

  const dismissToast = () => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  };

  useEffect(() => {
    const navigateInternally = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      const next = `${target.pathname}${target.search}${target.hash}`;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (next === current) return;
      if (target.pathname === window.location.pathname && target.search === window.location.search && target.hash) return;
      event.preventDefault();
      navigateTo(next);
    };
    document.addEventListener('click', navigateInternally);
    return () => document.removeEventListener('click', navigateInternally);
  }, []);

  useEffect(() => {
    const submitInternally = (event) => {
      if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      if (String(form.method || 'get').toLowerCase() !== 'get' || form.querySelector('input[type="file"]')) return;
      const target = new URL(form.action || window.location.href, window.location.href);
      if (target.origin !== window.location.origin) return;

      const search = new URLSearchParams(target.search);
      new FormData(form).forEach((value, key) => {
        if (typeof value !== 'string') return;
        const normalized = key === 'q' ? normalizeSearchQuery(value) : value.trim();
        if (normalized) search.set(key, normalized);
        else search.delete(key);
      });
      target.search = search.toString();
      const next = `${target.pathname}${target.search}${target.hash}`;
      event.preventDefault();
      navigateTo(next);
    };
    document.addEventListener('submit', submitInternally);
    return () => document.removeEventListener('submit', submitInternally);
  }, []);

  useEffect(() => {
    if (!readAuthToken()) {
      setAuthChecked(true);
      return;
    }
    api('/auth/me')
      .then((data) => setUser(data.user))
      .catch(() => clearAuthToken())
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!user?.id) return undefined;
    let active = true;
    const refreshMediaToken = () => {
      api('/auth/media-token', { retry: 0 })
        .then(() => {
          if (active) setUser((current) => current ? { ...current } : current);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(refreshMediaToken, 10 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [user?.id]);

  useEffect(() => {
    const syncAuthAcrossTabs = (event) => {
      if (event.key !== AUTH_TOKEN_KEY) return;
      if (!event.newValue) {
        setUser(null);
        setAuthChecked(true);
        return;
      }
      api('/auth/me')
        .then((data) => setUser(data.user))
        .catch(() => clearAuthToken())
        .finally(() => setAuthChecked(true));
    };
    window.addEventListener('storage', syncAuthAcrossTabs);
    return () => window.removeEventListener('storage', syncAuthAcrossTabs);
  }, []);

  useEffect(() => {
    updateRouteSeo(path, window.location.search);
    recordEvent('page_view', { path, search: window.location.search });
  }, [path, routeKey]);

  useEffect(() => {
    if (!user || !['/signup', '/login', '/forgot-password'].includes(path)) return;
    const destination = authReturnPath();
    window.history.replaceState({}, '', destination);
    setPath(normalizePath());
  }, [path, routeKey, user]);

  useEffect(() => {
    if (!['/signup', '/login', '/forgot-password'].includes(path)) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  }, [path, routeKey]);

  useEffect(() => {
    const isAuthRoute = ['/signup', '/login', '/forgot-password'].includes(path);
    if (!isAuthRoute) {
      document.documentElement.style.removeProperty('--fitlook-auth-height');
      document.documentElement.style.removeProperty('--fitlook-auth-width');
      return undefined;
    }

    const lockAuthViewport = () => {
      const currentWidth = window.innerWidth;
      const lockedWidth = Number.parseFloat(document.documentElement.style.getPropertyValue('--fitlook-auth-width')) || 0;
      if (document.documentElement.style.getPropertyValue('--fitlook-auth-height') && Math.abs(currentWidth - lockedWidth) < 8) return;
      document.documentElement.style.setProperty('--fitlook-auth-height', `${window.innerHeight}px`);
      document.documentElement.style.setProperty('--fitlook-auth-width', `${currentWidth}px`);
    };

    lockAuthViewport();
    window.addEventListener('orientationchange', lockAuthViewport);
    return () => window.removeEventListener('orientationchange', lockAuthViewport);
  }, [path]);

  const page = useMemo(() => {
    const productMatch = path.match(/^\/product\/([^/]+)$/);
    const orderStatusMatch = path.match(/^\/order\/([^/]+)\/status$/);
    const categoryMatch = path.match(/^\/categories\/([^/]+)$/);
    if (requiresAuthentication(path) && !user) return <ProtectedRouteGate path={path} authChecked={authChecked} />;
    if (path === '/') return <Home user={user} />;
    if (path === '/home') return <AtelierHome user={user} demoEcommerceMode={demoEcommerceMode} />;
    if (path === '/categories' || path === '/explore') return <CategoriesPage key={routeKey} user={user} demoEcommerceMode={demoEcommerceMode} />;
    if (categoryMatch) return <CategoryDepartmentPage category={decodeURIComponent(categoryMatch[1])} user={user} demoEcommerceMode={demoEcommerceMode} />;
    if (path === '/search') return <SearchLandingPage key={routeKey} />;
    if (path === '/try-on') return <CustomTryOnPage user={user} setUser={setUser} />;
    if (path === '/closet') return <ClosetPage user={user} setUser={setUser} />;
    if (path === '/closet/add') return <ClosetAddPage user={user} setUser={setUser} />;
    if (path === '/closet/combo') return <ClosetComboPage user={user} setUser={setUser} />;
    if (path === '/closet/items') return <ClosetItemsPage user={user} setUser={setUser} />;
    if (path === '/wishlist') return <WishlistPage user={user} demoEcommerceMode={demoEcommerceMode} />;
    if (path === '/cart') return <CartPage user={user} demoEcommerceMode={demoEcommerceMode} />;
    if (path === '/checkout') return <CheckoutPage user={user} demoEcommerceMode={demoEcommerceMode} demoModeLoading={storefrontConfig.loading} />;
    if (path === '/custom-try-on') return <CustomTryOnPage user={user} setUser={setUser} />;
    if (path === '/style-bot') return <StyleBotPage user={user} setUser={setUser} />;
    if (path === '/tokens') return <TokenPage user={user} setUser={setUser} mode="overview" />;
    if (path === '/tokens/top-up') return <TokenPage key={routeKey} user={user} setUser={setUser} mode="topup" />;
    if (path === '/profile') return <ProfilePage user={user} setUser={setUser} />;
    if (path === '/generation-history') return <GenerationHistoryPage user={user} />;
    if (productMatch) return <ProductPage id={decodeURIComponent(productMatch[1])} user={user} setUser={setUser} demoEcommerceMode={demoEcommerceMode} />;
    if (orderStatusMatch) return <OrderStatusPage id={decodeURIComponent(orderStatusMatch[1])} user={user} />;
    if (['/signup', '/login', '/forgot-password'].includes(path) && user) return <SearchPage user={user} setUser={setUser} demoEcommerceMode={demoEcommerceMode} />;
    if (path === '/signup') return <AuthPage mode="signup" setUser={setUser} />;
    if (path === '/login') return <AuthPage mode="login" setUser={setUser} />;
    if (path === '/forgot-password') return <ForgotPasswordPage />;
    if (path === '/how-it-works') return <HowItWorks user={user} />;
    if (path === '/about') return <AboutPage user={user} />;
    if (path === '/download') return <DownloadAppPage />;
    if (pageMeta[path]) return <InfoPage meta={pageMeta[path]} user={user} demoEcommerceMode={demoEcommerceMode} />;
    return <NotFoundPage />;
  }, [authChecked, demoEcommerceMode, path, routeKey, storefrontConfig.loading, user]);

  useEffect(() => {
    const revealSelectors = [
      '.atelier-category-section',
      '.atelier-promos',
      '.atelier-arrivals',
      '.atelier-lookbook',
      '.atelier-newsletter',
      '.atelier-mixed-feed',
      '.atelier-category-hero-section',
      '.atelier-category-quick-section',
      '.atelier-category-audience-section',
      '.atelier-category-filter-section',
      '.atelier-category-products-section',
      '.department-catalog',
      '.results-shell',
      '.product-editorial-detail',
      '.product-editorial-story',
      '.product-editorial-related',
      '.custom-tryon-page .custom-tryon-hero',
      '.custom-tryon-page .custom-tryon-panel',
      '.atelier-closet-add-hero',
      '.atelier-closet-add-form',
      '.wishlist-reference-empty',
      '.wishlist-reference-section',
      '.profile-reference-panel',
      '.credit-purchase-layout',
      '.feature-band',
      '.about-section',
      '.about-feature',
      '.about-step',
      '.download-section',
      '.download-feature-item'
    ].join(',');
    const sections = Array.from(document.querySelectorAll(revealSelectors));
    if (!sections.length) return undefined;

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    sections.forEach((section, index) => {
      section.classList.add('fitlook-motion-section');
      section.style.setProperty('--motion-delay', `${Math.min((index % 4) * 45, 135)}ms`);
      if (prefersReducedMotion) section.classList.add('is-visible');
    });
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      sections.forEach((section) => section.classList.add('is-visible'));
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [routeKey]);

  const authFallbackRoutes = ['/try-on', '/custom-try-on', '/closet', '/closet/add', '/closet/combo', '/closet/items', '/style-bot', '/tokens', '/profile', '/generation-history'];
  const isStandaloneAuth = ['/login', '/signup', '/forgot-password'].includes(path) && !user;
  const isConciergePage = path === '/style-bot' && Boolean(user);
  const isProductPage = /^\/product\/[^/]+$/.test(path);
  const isOpeningPage = path === '/';
  const shouldHideMobileBottomNav = isOpeningPage || isStandaloneAuth || (!user && authFallbackRoutes.includes(path));
  const isWardrobeWorkspace = path === '/closet' || path === '/closet/add';
  const shouldShowOnboarding = Boolean(user && !user.hasCompletedOnboarding && !isStandaloneAuth);

  useEffect(() => {
    document.body.classList.toggle('fitlook-auth-without-mobile-nav', shouldHideMobileBottomNav);
    return () => document.body.classList.remove('fitlook-auth-without-mobile-nav');
  }, [shouldHideMobileBottomNav]);

  return (
    <>
      {!isStandaloneAuth && !isOpeningPage && <a className="skip-link" href="#main-content">Skip to main content</a>}
      {!isStandaloneAuth && !isOpeningPage && <Header user={user} setUser={setUser} authChecked={authChecked} />}
      <div id="main-content" className="app-page-transition" tabIndex="-1" key={routeKey}>{page}</div>
      {!isOnline && <div className="network-status" role="status" aria-live="polite">You are offline. Changes will resume when you reconnect.</div>}
      {toast && <Toast toast={toast} onDismiss={dismissToast} />}
      {!shouldHideMobileBottomNav && <MobileBottomNav user={user} />}
      {!isStandaloneAuth && !isOpeningPage && !isConciergePage && <Footer />}
      {shouldShowOnboarding && <OnboardingOverview user={user} onComplete={setUser} />}
      {replayTourOpen && user && <OnboardingOverview user={user} persist={false} onClose={() => setReplayTourOpen(false)} />}
    </>
  );
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

function MailIcon() {
  return <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><path d="M12 15v2" /></svg>;
}

function EyeIcon({ crossed = false }) {
  return <svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" /><circle cx="12" cy="12" r="3" />{crossed && <path d="m4 4 16 16" />}</svg>;
}

function TryOnIcon() {
  return <svg viewBox="0 0 24 24"><path d="M12 4 5 8v8l7 4 7-4V8l-7-4Z" /><path d="M9 13a3 3 0 0 0 6 0" /><path d="M9 9h.01" /><path d="M15 9h.01" /></svg>;
}

function ClosetIcon() {
  return <svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="16" rx="1.5" /><path d="M12 4v16" /><path d="M9 12h.01" /><path d="M15 12h.01" /></svg>;
}

function SparkleLineIcon() {
  return <svg viewBox="0 0 24 24"><path d="m12 3 1.4 4.1L18 8.5l-4.6 1.4L12 14l-1.4-4.1L6 8.5l4.6-1.4L12 3Z" /><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" /><path d="m5 15 .6 1.6L7 17l-1.4.4L5 19l-.6-1.6L3 17l1.4-.4L5 15Z" /></svg>;
}

function UploadCloudIcon() {
  return <svg viewBox="0 0 24 24"><path d="M16 16l-4-4-4 4" /><path d="M12 12v9" /><path d="M20.4 18.1A5 5 0 0 0 18 8.7h-1.3A7 7 0 1 0 5 15.1" /><path d="M5 15.1A4 4 0 0 0 6.5 23H18" /></svg>;
}

function CameraIcon() {
  return <svg viewBox="0 0 24 24"><path d="M4 7h4l1.5-2h5L16 7h4v12H4V7Z" /><circle cx="12" cy="13" r="3.5" /></svg>;
}

function UserIcon() {
  return <svg viewBox="0 0 24 24"><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>;
}

function HeartIcon() {
  return <svg viewBox="0 0 24 24"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" /></svg>;
}

function HomeIcon() {
  return <svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8" /><path d="M5 10v10h5v-6h4v6h5V10" /></svg>;
}

function GridIcon() {
  return <svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx=".5" /><rect x="14" y="4" width="6" height="6" rx=".5" /><rect x="4" y="14" width="6" height="6" rx=".5" /><rect x="14" y="14" width="6" height="6" rx=".5" /></svg>;
}

function ListIcon() {
  return <svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>;
}

function BagIcon() {
  return <svg viewBox="0 0 24 24"><path d="M6 7h12l1 14H5L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></svg>;
}

function TagIcon() {
  return <svg viewBox="0 0 24 24"><path d="M20 13 13 20a2 2 0 0 1-2.8 0L4 13.8V4h9.8L20 10.2a2 2 0 0 1 0 2.8Z" /><path d="M8 8h.01" /></svg>;
}

function GlobeIcon() {
  return <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></svg>;
}

function FullscreenIcon() {
  return <svg viewBox="0 0 24 24"><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M21 16v5h-5" /><path d="M8 21H3v-5" /></svg>;
}

function MenuIcon() {
  return <svg viewBox="0 0 24 24"><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>;
}

function ArrowLeftIcon() {
  return <svg viewBox="0 0 24 24"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
}

export default App;
