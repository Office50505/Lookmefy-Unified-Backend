import { useEffect, useMemo, useRef, useState } from 'react';

const asset = (name) => `/assets/${name}`;
const MAX_BODY_PHOTO_BYTES = 8 * 1024 * 1024;
const TARGET_BODY_PHOTO_BYTES = 6.5 * 1024 * 1024;
const BODY_PHOTO_ACCEPT = 'image/*,.avif,.heic,.heif,image/avif,image/heic,image/heif';
const JOB_TIMEOUT_MS = 180000;
const JOB_POLL_INTERVAL_MS = 1400;

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
  const formatOptions = {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
  };
  try {
    return new Intl.NumberFormat('en-IN', formatOptions).format(amount);
  } catch {
    return `${formatOptions.currency} ${amount.toLocaleString('en-IN', { maximumFractionDigits: formatOptions.maximumFractionDigits })}`;
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

function ZoomableImage({ src, alt, className = '', imageClassName = '', zoom = 1.65, disableZoom = false, onError }) {
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const frameRef = useRef(null);

  const moveOrigin = (event) => {
    const frame = frameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    setOrigin({ x, y });
  };

  const startZoom = (event) => {
    if (disableZoom || zoom <= 1) return;
    moveOrigin(event);
    setZooming(true);
    if (event.pointerType !== 'mouse') event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const stopZoom = (event) => {
    if (disableZoom || zoom <= 1) return;
    setZooming(false);
    if (event.pointerType !== 'mouse') event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      ref={frameRef}
      className={`zoomable-image ${zooming ? 'is-zoomed' : ''} ${disableZoom || zoom <= 1 ? 'no-zoom' : ''} ${className}`.trim()}
      style={{
        '--zoom-origin-x': `${origin.x}%`,
        '--zoom-origin-y': `${origin.y}%`,
        '--zoom-scale': zoom
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') startZoom(event);
      }}
      onPointerDown={startZoom}
      onPointerMove={(event) => {
        if (zooming || event.pointerType === 'mouse') moveOrigin(event);
      }}
      onPointerUp={stopZoom}
      onPointerCancel={stopZoom}
      onPointerLeave={stopZoom}
    >
      <img className={imageClassName} src={src} alt={alt} draggable="false" onError={onError} />
    </div>
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
  ['Tops', 'category-tops-updated.jpg', 'tops'],
  ['Bottoms', 'category-bottoms-updated.jpg', 'bottoms'],
  ['Shirts', 'category-1.jpg', 'shirts'],
  ['T-Shirts', 'category-tshirts-updated.jpg', 't-shirts'],
  ['Pants', 'category-3.jpg', 'pants'],
  ['Jeans', 'category-4.jpg', 'jeans'],
  ['Jackets', 'category-5.jpg', 'jackets'],
  ['Shoes', 'category-shoes-updated.jpg', 'shoes'],
  ['Watches', 'category-7.jpg', 'watches'],
  ['Accessories', 'category-8.jpg', 'accessories'],
  ['Ethnic Wear', 'arrival-4.jpg', 'ethnic wear'],
  ['Eyewear', 'category-eyewear-updated.jpg', 'eyewear'],
  ['Innerwear', 'arrival-6.jpg', 'innerwear'],
  ['Sleepwear', 'arrival-5.jpg', 'sleepwear']
];

const pageMeta = {
  '/women': ['For Women', 'Try new silhouettes with less guessing.', 'A dedicated shopping entry point for shirts, denim, jackets, accessories, and AI-powered outfit previews.', 'arrival-4.jpg'],
  '/new-arrivals': ['New Arrivals', 'Fresh pieces, first impressions.', 'New products are updated here so you can preview the latest fits before they disappear.', 'arrival-5.jpg'],
  '/sale': ['Sale', 'Better deals, fewer fit doubts.', 'Browse discounted products and use try-on previews before finalizing your picks.', 'search-shirt-2.jpg'],
  '/gift-cards': ['Gift Cards', 'Style confidence makes a good gift.', 'Gift cards can be used toward shopping and try-on tokens when the product is connected.', 'hero2.png'],
  '/about': ['About', 'Shopping online should feel more certain.', 'FitLook combines product discovery with AI try-on previews so shoppers can compare styles with more confidence.', 'hero2.png'],
  '/support': ['Help', 'Support for shopping and try-on.', 'Find answers about shipping, returns, profile photos, tokens, and account access.', 'search-shirt-4.jpg'],
  '/contact': ['Contact', 'Tell us what you need.', 'For order, token, account, and AI try-on questions, reach the FitLook support team.', 'hero2.png'],
  '/careers': ['Careers', 'Build the future of fitting rooms.', 'Future roles across product, design, engineering, fashion operations, and partnerships would be listed here.', 'hero2.png'],
  '/blog': ['Blog', 'Fit notes, styling ideas, and AI try-on updates.', 'Editorial content, product guides, and try-on tips would live here.', 'arrival-4.jpg'],
  '/press': ['Press', 'FitLook press and media.', 'Company information, product screenshots, and media contact details would be available here.', 'hero2.png'],
  '/terms': ['Terms', 'Terms and conditions.', 'This page outlines where account, token, shopping, and AI try-on usage rules live.', 'hero2.png'],
  '/privacy': ['Privacy', 'Your try-on profile is personal.', 'This page describes how account details, full-body photos, token usage, and shopping activity are handled.', 'hero2.png'],
  '/accessibility': ['Accessibility', 'Accessibility matters at every step.', 'Accessibility goals cover navigation, forms, image alt text, contrast, and keyboard-friendly flows.', 'hero2.png']
};

const supportEmail = 'support@lookmefy.com';
const policyPages = {
  '/privacy': {
    emailSubject: 'Lookmefy privacy request',
    sections: [
      ['Information we collect', [
        'Lookmefy collects account details such as name, mobile number, email or generated account email, username, gender preference, profile photo, and full-body try-on photo.',
        'We also process wardrobe uploads, product images or links you submit, generated try-on images or videos, wishlists, credits, token activity, payment/order references, support messages, and app usage events such as searches, product views, and try-on requests.'
      ]],
      ['How we use information', [
        'We use this information to provide login, profile, AI try-on, wardrobe, wishlist, support, credits, checkout, safety, abuse prevention, troubleshooting, analytics, and service improvement.',
        'Profile photos, garment images, and generation prompts may be sent to AI, storage, payment, hosting, messaging, analytics, or infrastructure providers only as needed to operate Lookmefy.'
      ]],
      ['Third-party shopping and payments', [
        'Lookmefy may redirect product shopping to Amazon or other third-party stores. Those stores control checkout, delivery, returns, refunds, and their separate privacy practices.',
        'Payment details are handled by the payment provider shown in the app. Lookmefy stores order references, payment status, credit balance changes, and support information needed to operate the credits service.'
      ]],
      ['Retention and choices', [
        'We keep account and generated content while your account is active or as needed for support, fraud prevention, billing, security, legal, tax, dispute, or compliance reasons.',
        `You can update profile details in the app, contact ${supportEmail} for privacy requests, and use Profile > Delete Account in the app to request deletion of your account and associated app data.`
      ]]
    ]
  },
  '/terms': {
    emailSubject: 'Lookmefy terms question',
    sections: [
      ['Using Lookmefy', [
        'Use Lookmefy only for lawful personal styling, shopping, wardrobe, and try-on purposes. You are responsible for the information, photos, links, and images you submit.',
        "Do not upload content that is illegal, abusive, infringing, sexually explicit, deceptive, harmful, or violates another person's privacy, publicity, intellectual property, or platform rights."
      ]],
      ['AI try-on limitations', [
        'AI previews are generated estimates and may differ from real-world fit, colour, material, sizing, lighting, body shape, product quality, or seller fulfilment.',
        'Always check the product listing, seller terms, size chart, return window, and real product details before buying.'
      ]],
      ['Credits, memberships, and refunds', [
        'Credits or tokens are used for AI generation features. Completed generations generally consume credits because provider costs are incurred when processing starts.',
        'Credits, token purchases, membership billing, cancellations, failed generations, and refunds are handled under the cancellation and refund policies shown in the app.'
      ]],
      ['Third-party services', [
        'Products may be listed from or redirected to Amazon or other third-party services. Lookmefy does not control third-party prices, availability, seller claims, delivery, returns, warranties, refunds, or checkout decisions.'
      ]]
    ]
  },
  '/delete-account': {
    emailSubject: 'Lookmefy account deletion request',
    meta: ['Privacy', 'Account & Data Deletion', 'Signed-in users can delete their Lookmefy account and associated app data from Profile in the app.', 'hero2.png'],
    sections: [
      ['How to delete your account', [
        'In the app, go to Profile, scroll to the bottom, and tap Delete Account. Confirming the prompt submits the deletion request from your signed-in account.',
        `If you cannot access the app, email ${supportEmail} from your registered contact details with the subject "Account deletion request". We may ask for information to verify account ownership.`
      ]],
      ['What is deleted', [
        'Account deletion removes your Lookmefy account access, profile details, uploaded profile and try-on photos, generated try-on history, wardrobe items, wardrobe outfits, app preferences, credit events, token order records held in the app database, queued jobs, and app activity tied to your account from active systems.'
      ]],
      ['What may be retained', [
        'Some records may be retained if required for law, tax, accounting, fraud prevention, security, payment disputes, abuse prevention, or enforcing our terms. Retained records are limited to the purpose that requires retention.'
      ]]
    ]
  }
};

function normalizePath() {
  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
  return path || '/';
}

function currentSearchValue() {
  return new URLSearchParams(window.location.search).get('q') || '';
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollQueuedJob(jobId, headers, timeoutMs = JOB_TIMEOUT_MS) {
  const startedAt = Date.now();
  const limitMs = Math.max(JOB_TIMEOUT_MS, Number(timeoutMs) || 0);

  while (Date.now() - startedAt < limitMs) {
    await sleep(JOB_POLL_INTERVAL_MS);
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      headers,
      cache: 'no-store'
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(readableError(data, `Job status failed (${res.status})`));
    const status = data?.job?.status;
    if (status === 'succeeded') return data.result;
    if (status === 'failed') throw new Error(data?.job?.error || 'Background task failed');
  }

  throw new Error('Still processing. Please try again in a moment.');
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

function usableBrands(brands = []) {
  return brands.map((brand) => cleanDisplayText(brand, '')).filter(Boolean);
}

async function api(path, options = {}) {
  const { pollJob = true, jobTimeoutMs, ...fetchOptions } = options;
  const token = localStorage.getItem('fitlook_token');
  const headers = fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const requestHeaders = { ...headers, ...fetchOptions.headers };
  const res = await fetch(`/api${path}`, { ...fetchOptions, headers: requestHeaders });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(readableError(data, `Request failed (${res.status})`));
  if (res.status === 202 && data?.jobId && pollJob) {
    return pollQueuedJob(data.jobId, requestHeaders, jobTimeoutMs);
  }
  return data;
}

function recordEvent(type, payload = {}) {
  if (!localStorage.getItem('fitlook_token')) return;
  api('/recommendations/events', {
    method: 'POST',
    body: JSON.stringify({ type, ...payload })
  }).catch(() => {});
}

function useProducts(params) {
  const query = useMemo(() => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') search.set(key, value);
    });
    return search.toString();
  }, [params]);
  const [state, setState] = useState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: true, error: '' });

  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/products${query ? `?${query}` : ''}`)
      .then((data) => {
        if (alive) setState({ products: data.products || [], total: data.total || 0, facets: data.facets || { brands: [], categories: [], categoryCounts: [] }, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [query]);

  return state;
}

function useRecommendedProducts(user, limit = 6) {
  const [state, setState] = useState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: Boolean(user), error: '' });

  useEffect(() => {
    if (!user) {
      setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: '' });
      return;
    }
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api(`/recommendations/for-you?limit=${limit}`)
      .then((data) => {
        if (alive) setState({ products: data.products || [], total: data.products?.length || 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ products: [], total: 0, facets: { brands: [], categories: [], categoryCounts: [] }, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [user, limit]);

  return state;
}

function useSimilarProducts(id, limit = 4) {
  const [state, setState] = useState({ products: [], loading: true, error: '' });

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ products: [], loading: true, error: '' });
    api(`/recommendations/similar/${encodeURIComponent(id)}?limit=${limit}`)
      .then((data) => {
        if (alive) setState({ products: data.products || [], loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ products: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [id, limit]);

  return state;
}

function useProduct(id) {
  const [state, setState] = useState({ product: null, loading: true, error: '' });

  useEffect(() => {
    let alive = true;
    setState({ product: null, loading: true, error: '' });
    api(`/products/${encodeURIComponent(id)}`)
      .then((data) => {
        if (alive) setState({ product: data.product || null, loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ product: null, loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return state;
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
    api(`/tryons?productIds=${encodeURIComponent(productIds)}`)
      .then((data) => {
        if (!alive) return;
        const saved = Object.fromEntries((data.tryOns || []).map((tryOn) => [tryOn.productId, tryOn]));
        setTryOns((current) => ({ ...current, ...saved }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, productIds]);

  return [tryOns, setTryOns];
}

function Header({ user, setUser }) {
  const tokenLabel = user ? `${user.tokens} Tokens` : 'Tokens';
  const [menuOpen, setMenuOpen] = useState(false);
  const logout = () => {
    localStorage.removeItem('fitlook_token');
    setUser(null);
    setMenuOpen(false);
    window.history.pushState({}, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  const navLinks = [
    ['Shop', '/search'],
    ['Closet', '/closet'],
    ['For Men', '/search?gender=men'],
    ['For Women', '/search?gender=women'],
    ['Categories', '/categories'],
    ['How it Works', '/how-it-works']
  ];

  return (
    <>
      <div className="announcement">
        <span>✨</span>
        <span>{user ? <>You have {user.tokens} tokens ready for AI try-on</> : <>Get free tokens on sign up to try AI try-on</>}</span>
        <span>✨</span>
      </div>
      <header className="site-header">
        <div className="wrap header-inner">
          <div className="header-left">
            <a className="brand" href="/">FitLook</a>
            <nav className="nav">
              {navLinks.map(([label, href]) => <a href={href} key={label}>{label}</a>)}
            </nav>
          </div>
          <div className="header-search" role="search">
            <form className="search-form" action="/search">
              <input name="q" type="search" placeholder="Search products, brands, categories" defaultValue={currentSearchValue()} aria-label="Search products" />
              <button className="search-submit" type="submit" aria-label="Search"><SearchIcon /></button>
            </form>
          </div>
          <div className="header-actions">
            <a className="token-pill" href="/tokens"><span>✨</span>{tokenLabel}</a>
            {user ? <a className="icon-button" href="/profile" aria-label="Profile"><UserIcon /></a> : <a className="icon-button" href="/login" aria-label="Account"><UserIcon /></a>}
            {user && <button className="text-button" onClick={logout}>Log out</button>}
            <button className="icon-button" aria-label="Wishlist"><HeartIcon /></button>
            <button className="icon-button menu-toggle" type="button" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              {menuOpen ? <CloseIcon /> : <MenuIcon />}
            </button>
          </div>
        </div>
        <div className={`mobile-menu ${menuOpen ? 'open' : ''}`}>
          <div className="wrap mobile-menu-inner">
            {navLinks.map(([label, href]) => <a href={href} key={label} onClick={() => setMenuOpen(false)}>{label}</a>)}
            <a href="/tokens" onClick={() => setMenuOpen(false)}>{tokenLabel}</a>
            <a href={user ? '/profile' : '/login'} onClick={() => setMenuOpen(false)}>{user ? 'Profile' : 'Account'}</a>
            {user && <button type="button" onClick={logout}>Log out</button>}
          </div>
        </div>
      </header>
    </>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-grid">
          <div>
            <a className="footer-logo" href="/">FitLook</a>
            <p className="footer-about">Your AI fitting room.<br />See it on you, before you buy.</p>
          </div>
          <FooterCol title="Shop" links={[['All Products', '/search'], ['Men', '/search?gender=men'], ['Women', '/search?gender=women'], ['New Arrivals', '/search?newArrival=true'], ['Sale', '/sale'], ['Gift Cards', '/gift-cards']]} />
          <FooterCol title="Company" links={[['About Us', '/about'], ['How it Works', '/how-it-works'], ['Careers', '/careers'], ['Blog', '/blog'], ['Press', '/press']]} />
          <FooterCol title="Help" links={[['FAQ', '/support'], ['Shipping', '/support'], ['Returns & Exchanges', '/support'], ['Track Order', '/support'], ['Contact Us', '/contact']]} />
          <div className="newsletter"><h3>Join Our Community</h3><p>Explore new arrivals and token offers when they go live.</p><a className="footer-newsletter-link" href="/search?newArrival=true">See New Arrivals</a></div>
        </div>
        <div className="footer-bottom"><div>© 2024 FitLook. All rights reserved.</div><div className="legal"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/delete-account">Delete Account</a><a href="/accessibility">Accessibility</a></div></div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`footer-col ${open ? 'open' : ''}`}>
      <button className="footer-col-toggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <h3>{title}</h3>
        <span aria-hidden="true">+</span>
      </button>
      <ul>{links.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul>
    </div>
  );
}

function Hero({ compact = false }) {
  const slide = {
    kicker: 'AI Try-On',
    title: <>See it on you,<br />before <em>you</em> buy.</>,
    copy: 'Upload once. Try thousands of outfits using AI and shop from top brands.',
    cta: 'Start Trying',
    href: '/tokens',
    image: compact ? 'hero2.png' : 'hero1.png'
  };

  return (
    <section className="hero">
      <div className="wrap">
        <div className={compact ? 'hero-panel compact' : 'hero-panel'}>
          <img className="hero-bg" src={asset(slide.image)} alt="" />
          <div className="hero-card">
            <span className="hero-kicker">{slide.kicker}</span>
            <h1 className="hero-title">{slide.title}</h1>
            <p className="hero-copy">{slide.copy}</p>
            <a className="hero-cta" href={slide.href}>{slide.cta} <span>→</span></a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Home({ user }) {
  const recommended = useRecommendedProducts(user, 6);
  const arrivals = useProducts({ newArrival: 'true', sort: 'newest', limit: 6 });

  return (
    <>
      <Hero />
      {user && (recommended.loading || recommended.products.length > 0) && <ProductSection title="Recommended For You" href="/search" state={recommended} user={user} />}
      <ProductSection title="New Arrivals" href="/search?newArrival=true" state={arrivals} user={user} />
      <section className="categories"><div className="wrap"><div className="section-head"><h2>Shop by Category</h2><a className="view-all" href="/categories">View all ›</a></div><div className="category-grid">{categories.slice(0, 8).map(([label, image, q]) => <a className="category" href={`/search?category=${encodeURIComponent(q)}`} key={label}><img src={asset(image)} alt={label} /><span>{label}</span></a>)}</div></div></section>
      <FeatureBand />
    </>
  );
}

function ProductSection({ title, href, state, user }) {
  const { products, loading, error } = state;
  const displayProducts = products.slice(0, 6);
  const [tryOns] = useTryOnCache(user, displayProducts);
  return (
    <section className="section">
      <div className="wrap">
        <div className="section-head"><h2>{title}</h2><a className="view-all" href={href}>View all ›</a></div>
        {loading && <ProductGridSkeleton count={6} />}
        {error && <StatusPanel text={error} />}
        {!loading && !error && products.length === 0 && <EmptyProducts />}
        {!loading && !error && products.length > 0 && <div className="product-grid">{displayProducts.map((product) => <ProductCard key={product.id} product={product} user={user} tryOn={tryOns[product.id]} />)}</div>}
      </div>
    </section>
  );
}

function CategoriesPage() {
  const state = useProducts({ limit: 96, sort: 'newest' });
  const fallbackBySlug = Object.fromEntries(categories.map(([label, image, slug]) => [slug, { label, image }]));
  const categoryCards = useMemo(() => {
    const groups = new Map();
    (state.products || []).forEach((product) => {
      const slug = String(product.category || 'uncategorized').toLowerCase();
      const current = groups.get(slug) || {
        slug,
        label: fallbackBySlug[slug]?.label || product.category || 'Uncategorized',
        fallbackImage: fallbackBySlug[slug]?.image || 'hero2.png',
        products: []
      };
      current.products.push(product);
      groups.set(slug, current);
    });

    const liveCategories = [...groups.values()].filter((category) => category.products.length > 0);
    if (liveCategories.length) {
      return liveCategories.sort((a, b) => b.products.length - a.products.length || a.label.localeCompare(b.label));
    }

    return categories.map(([label, image, slug]) => ({ slug, label, fallbackImage: image, products: [] }));
  }, [state.products]);

  return (
    <main className="category-page">
      <section className="wrap category-page-head">
        <p className="kicker">Categories</p>
        <h1>Shop by category.</h1>
        <p className="lead">Browse product groups with a quick visual preview from the live catalog.</p>
      </section>

      <section className="wrap category-showcase-grid">
        {state.loading && <StatusPanel text="Loading categories..." />}
        {state.error && <StatusPanel text={state.error} />}
        {!state.loading && !state.error && categoryCards.map((category) => {
          const previewImages = category.products.slice(0, 4).map((product) => product.imageUrl).filter(Boolean);
          const images = previewImages.length ? previewImages : [asset(category.fallbackImage)];
          return (
            <article className="category-showcase-card" key={category.slug}>
              <a className="category-showcase-media" href={`/search?category=${encodeURIComponent(category.slug)}`}>
                {Array.from({ length: 4 }).map((_, index) => (
                  <img src={images[index % images.length]} alt="" key={`${category.slug}-${index}`} />
                ))}
              </a>
              <div className="category-showcase-info">
                <div className="category-showcase-title">
                  <img src={asset(category.fallbackImage)} alt="" />
                  <div>
                    <h2>{category.label}</h2>
                    <p>{category.products.length ? `${category.products.length} products` : 'Waiting for products'}</p>
                  </div>
                </div>
                <a href={`/search?category=${encodeURIComponent(category.slug)}`}>View more ›</a>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}

function ProductCard({ product, user, locked = false, tryOn, canTryOn = false, tryOnLoading = false, tryOnVideoLoading = false, tryOnError = '', tryOnVideoError = '', onTryOn, onTryOnVideo }) {
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? `${Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)}% OFF` : '';
  const productImage = product.imageUrl || asset('hero2.png');
  const hasUsableTryOn = Boolean(tryOn?.imageUrl) && !tryOnImageFailed;
  const hasTryOnVideo = Boolean(tryOn?.videoUrl) && hasUsableTryOn;
  const image = hasUsableTryOn ? tryOn.imageUrl : productImage;
  const detailHref = `/product/${encodeURIComponent(product.id)}`;
  const brand = displayBrand(product);

  useEffect(() => {
    setTryOnImageFailed(false);
  }, [tryOn?.imageUrl]);

  const content = (
    <>
      <div className="product-media">
        {hasTryOnVideo ? (
          <video src={tryOn.videoUrl} poster={tryOn.imageUrl} autoPlay muted loop playsInline />
        ) : (
          <img
            src={image}
            alt={product.name}
            onError={(event) => {
              if (hasUsableTryOn) setTryOnImageFailed(true);
              else if (event.currentTarget.src !== window.location.origin + asset('hero2.png')) event.currentTarget.src = asset('hero2.png');
            }}
          />
        )}
        {product.badge && <span className="badge">{product.badge}</span>}
        {hasUsableTryOn && <span className="badge tryon-badge">{hasTryOnVideo ? 'Video Try-On' : 'AI Try-On'}</span>}
        {(tryOnLoading || tryOnVideoLoading) && <TryOnGenerating text={tryOnVideoLoading ? 'Generating video' : 'Generating try-on'} />}
        {!locked && <span className="heart"><HeartIcon /></span>}
      </div>
      <div className="product-info">
        <h3 className="product-title">{product.name}</h3>
        <p className="product-brand">{brand}</p>
        <p className="rating"><span>★</span> {Number(product.rating || 0).toFixed(1)} {product.ratingCount ? `(${product.ratingCount})` : ''}</p>
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
      {locked ? <div>{content}</div> : <a className="product-card-link" href={detailHref} onClick={() => recordEvent('product_click', { productId: product.id })}>{content}</a>}
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
            <button className="video-action" type="button" onClick={() => onTryOnVideo(product, { force: Boolean(tryOn?.videoUrl) })} disabled={tryOnVideoLoading || tryOnLoading}>
              {tryOnVideoLoading ? 'Video...' : tryOn?.videoUrl ? 'New Video' : 'Video Try-On'}
            </button>
          )}
          {product.affiliateLink && <a className="shop-action" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={() => recordEvent('shop_click', { productId: product.id })}>Shop</a>}
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
  const [backdrop, setBackdrop] = useState('neutral studio');
  const [pose, setPose] = useState('front facing');
  const [lighting, setLighting] = useState('natural light');
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chat, setChat] = useState([
    { role: 'assistant', text: 'Ask what to wear today, for an occasion, or which pants fit a shirt from your closet.' }
  ]);
  const [fullscreenImage, setFullscreenImage] = useState(null);

  const loadCloset = () => {
    if (!user) return;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api('/closet')
      .then((data) => {
        setState({ items: data.items || [], outfits: data.outfits || [], stats: data.stats || {}, suggestions: data.suggestions || [], loading: false, error: '' });
      })
      .catch((err) => setState({ items: [], outfits: [], stats: {}, suggestions: [], loading: false, error: err.message }));
  };

  useEffect(() => {
    loadCloset();
  }, [user?.id]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const selectedItems = selectedIds.map((id) => state.items.find((item) => item.id === id)).filter(Boolean);
  const filteredItems = state.items.filter((item) => filter === 'all' || item.category === filter);
  const plannerDays = nextPlannerDays(7);
  const plannedByDay = new Map((state.outfits || []).filter((outfit) => outfit.plannedFor).map((outfit) => [dateInputValue(outfit.plannedFor), outfit]));
  const latestOutfit = state.outfits?.[0] || null;
  const mainPreview = latestOutfit?.imageUrl || user.bodyPhotoUrl || asset('hero2.png');
  const wardrobeSlots = [
    { key: 'topwear', label: 'Topwear', helper: 'Shirts, tops, kurtas', short: 'To', categories: ['tops', 'outerwear', 'ethnic'] },
    { key: 'bottomwear', label: 'Bottomwear', helper: 'Pants, denim, skirts', short: 'Bo', categories: ['bottoms'] },
    { key: 'goggles', label: 'Goggles', helper: 'Glasses and shades', short: 'Go', categories: ['accessories'], keywords: ['goggle', 'goggles', 'glass', 'glasses', 'sunglass', 'eyewear'] },
    { key: 'cap', label: 'Cap', helper: 'Caps and hats', short: 'Ca', categories: ['accessories'], keywords: ['cap', 'hat'] },
    { key: 'footwear', label: 'Footwear', helper: 'Shoes, boots, sandals', short: 'Fo', categories: ['shoes'] }
  ];
  const wardrobeSlotMatches = (slot, item, strict = false) => {
    if (!slot.categories.includes(item.category)) return false;
    if (!slot.keywords?.length) return true;
    const text = [item.name, item.category, item.color, item.formality, ...(item.tags || []), ...(item.occasions || [])].filter(Boolean).join(' ').toLowerCase();
    const keywordMatch = slot.keywords.some((keyword) => text.includes(keyword));
    return strict ? keywordMatch : keywordMatch || slot.categories.includes(item.category);
  };
  const wardrobeOptionsForSlot = (slot) => {
    const exactOptions = state.items.filter((item) => wardrobeSlotMatches(slot, item, true));
    return exactOptions.length ? exactOptions : state.items.filter((item) => wardrobeSlotMatches(slot, item));
  };
  const wardrobeRail = wardrobeSlots.map((slot) => {
    const options = wardrobeOptionsForSlot(slot);
    const selected = state.items.find((item) => item.id === comboSlots[slot.key]) || null;
    return {
      ...slot,
      item: selected || options[0] || null,
      selected,
      options
    };
  });
  const activeWardrobeSlot = wardrobeRail.find((slot) => slot.key === activeWardrobeKey) || wardrobeRail[0];
  const lookbookCards = state.outfits.length
    ? state.outfits.slice(0, 5).map((outfit) => ({ id: outfit.id, title: outfit.title, imageUrl: outfit.imageUrl, items: outfit.items || [] }))
    : state.suggestions.slice(0, 5).map((suggestion, index) => ({ id: suggestion.key || `${suggestion.title}-${index}`, title: suggestion.title, items: suggestion.items || [] }));
  const comboOptions = state.suggestions.slice(0, 6);
  const selectedKey = selectedIds.slice().sort().join(':');
  const comboPreviewItems = (selectedItems.length ? selectedItems : state.items.filter((item) => ['tops', 'bottoms', 'suits', 'outerwear', 'shoes'].includes(item.category))).slice(0, 4);
  const closetSelectionCards = [
    {
      href: '/closet/add',
      step: '01',
      title: 'Add Clothes',
      copy: 'Upload wardrobe photos and save category, color, fabric, season and occasion tags.',
      meta: `${state.stats.total || state.items.length} saved`,
      action: 'Open Add Page',
      tone: 'add',
      items: state.items.slice(0, 3)
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
      items: state.items.slice(0, 4)
    }
  ];

  const slotItems = closetComboSlots.map((slot) => ({
    ...slot,
    selected: state.items.find((item) => item.id === comboSlots[slot.key]) || null,
    options: state.items.filter((item) => slot.categories.includes(item.category))
  }));

  const selectedIdsFromSlots = (slots) => [...new Set(Object.values(slots).filter(Boolean))];

  const slotsFromItems = (items) => {
    const next = {};
    closetComboSlots.forEach((slot) => {
      const item = items.find((entry) => slot.categories.includes(entry.category));
      if (item) next[slot.key] = item.id;
    });
    return next;
  };

  const updateItem = async (item, updates) => {
    const data = await api(`/closet/items/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
    setState((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? data.item : entry)) }));
  };

  const deleteItem = async (item) => {
    await api(`/closet/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    setSelectedIds((current) => current.filter((id) => id !== item.id));
    setState((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }));
  };

  const toggleSelected = (item) => {
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
    const nextSlots = slotsFromItems(items);
    setComboSlots(nextSlots);
    setSelectedIds(items.map((item) => item.id).filter(Boolean));
  };

  const swapSelected = (item) => {
    const replacement = state.items
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
      setState((current) => ({ ...current, outfits: current.outfits.map((entry) => (entry.id === outfit.id ? data.outfit : entry)) }));
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
      setState((current) => ({ ...current, suggestions: data.suggestions || [] }));
      setMessage('Suggestions ready.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  const generateOutfit = async (ids = selectedIds, details = {}) => {
    if (!ids.length) {
      setMessage('Select closet items or choose a suggested combo first.');
      return;
    }
    setGenerating(true);
    setMessage('Generating your closet look with FitRoom...');
    try {
      const data = await api('/closet/outfits/generate', {
        method: 'POST',
        body: JSON.stringify({
          itemIds: ids,
          occasion: details.occasion || occasion,
          weather,
          mood,
          plannedFor,
          backdrop,
          pose,
          lighting,
          notes: [backdrop, pose, lighting].filter(Boolean).join(' · '),
          title: details.title || `Closet look for ${details.occasion || occasion || 'today'}`
        })
      });
      setState((current) => ({ ...current, outfits: [data.outfit, ...current.outfits] }));
      setSelectedIds(ids);
      if (data.user) setUser(data.user);
      setMessage('Closet look is ready.');
      if (data.outfit?.imageUrl) setFullscreenImage({ src: data.outfit.imageUrl, alt: data.outfit.title, title: data.outfit.title });
    } catch (err) {
      setMessage(err.message);
    } finally {
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
      if (data.suggestions) setState((current) => ({ ...current, suggestions: data.suggestions }));
    } catch (err) {
      setChat((current) => [...current, { role: 'assistant', text: err.message }]);
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <main className="closet-page">
      <section className="wrap stylist-console" aria-label="AI stylist wardrobe preview">
        <div className="stylist-topbar">
          <strong>BeSpoke AI Stylist</strong>
          <button type="button" onClick={() => askForSuggestions('today')}>Get Daily Recommendations</button>
        </div>
        <div className="stylist-board-head">
          <h1>Daily Recommendations</h1>
          <h2>Lookbook & OOTD</h2>
        </div>
        <div className="stylist-board">
          <aside className="wardrobe-rail" aria-label="Wardrobe categories">
            {wardrobeRail.map((entry) => (
              <button type="button" key={entry.key} onClick={() => setActiveWardrobeKey(entry.key)} className={`${activeWardrobeKey === entry.key ? 'active' : ''} ${entry.selected ? 'selected' : ''}`}>
                <span className="rail-thumb">
                  {entry.item?.imageUrl ? <img src={entry.item.imageUrl} alt="" /> : <small>{entry.short}</small>}
                </span>
                <span>{entry.label}</span>
                <small>{entry.selected ? entry.selected.name : `${entry.options.length} options`}</small>
              </button>
            ))}
          </aside>

          <section className="stylist-preview-card">
            <div className="stylist-preview-frame">
              <ZoomableImage src={mainPreview} alt={latestOutfit?.title || 'FitLook body profile'} />
              {generating && <TryOnGenerating text="Generating outfit" />}
            </div>
            <div className="stylist-preview-strip">
              <span />
              <i />
              <span />
            </div>
            <div className="stylist-selected-row">
              {(selectedItems.length ? selectedItems : state.items.slice(0, 4)).slice(0, 4).map((item) => <img src={item.imageUrl} alt="" key={item.id} />)}
            </div>
          </section>

          <aside className="lookbook-rail" aria-label="Lookbook outfits">
            {lookbookCards.length ? lookbookCards.map((card) => (
              <button type="button" key={card.id} onClick={() => card.imageUrl ? setFullscreenImage({ src: card.imageUrl, alt: card.title, title: card.title }) : applyComboItems(card.items || [])}>
                {card.imageUrl ? <img className="lookbook-main-thumb" src={card.imageUrl} alt="" /> : null}
                <span>
                  {(card.items || []).slice(0, 4).map((item) => <img src={item.imageUrl} alt="" key={item.id} />)}
                </span>
              </button>
            )) : Array.from({ length: 4 }).map((_, index) => (
              <button type="button" key={`empty-look-${index}`} onClick={() => askForSuggestions()}>
                <span><small>OOTD</small></span>
              </button>
            ))}
          </aside>
        </div>
        <div className="stylist-slot-panel">
          <div className="stylist-slot-head">
            <div>
              <p className="kicker">Choose {activeWardrobeSlot.label}</p>
              <h3>{activeWardrobeSlot.selected ? activeWardrobeSlot.selected.name : `Select ${activeWardrobeSlot.label}`}</h3>
              <span>{activeWardrobeSlot.helper}</span>
            </div>
            {activeWardrobeSlot.selected && (
              <button type="button" onClick={() => chooseSlotItem(activeWardrobeSlot.key, null)}>Clear</button>
            )}
          </div>
          <div className="stylist-slot-options">
            {activeWardrobeSlot.options.length ? activeWardrobeSlot.options.map((item) => (
              <button type="button" key={item.id} onClick={() => chooseSlotItem(activeWardrobeSlot.key, item)} className={comboSlots[activeWardrobeSlot.key] === item.id ? 'active' : ''}>
                <img src={item.imageUrl} alt="" />
                <span>{item.name}</span>
              </button>
            )) : (
              <a className="stylist-slot-empty" href="/closet/add">Add {activeWardrobeSlot.label}</a>
            )}
          </div>
        </div>
        <div className="stylist-console-actions">
          <div>
            <strong>{state.stats.total || state.items.length}</strong>
            <span>items in your wardrobe</span>
          </div>
          <div>
            <strong>{user.tokens}</strong>
            <span>try-on tokens</span>
          </div>
          <button type="button" onClick={() => generateOutfit(selectedIds, { title: 'My closet combo' })} disabled={generating || selectedIds.length === 0}>{generating ? 'Generating...' : `Generate ${selectedIds.length ? `(${selectedIds.length})` : ''}`}</button>
        </div>
      </section>

      <section className="wrap closet-selection-hub" aria-label="Closet selection">
        <div className="closet-selection-head">
          <div>
            <p className="kicker">Selection</p>
            <h2>Choose your closet action.</h2>
          </div>
          <span>{user.tokens} try-on tokens</span>
        </div>
        <div className="closet-selection-grid">
          {closetSelectionCards.map((card) => (
            <a className={`closet-selection-card ${card.tone}`} href={card.href} key={card.href}>
              <div className="closet-selection-card-top">
                <span>{card.step}</span>
                <small>{card.meta}</small>
              </div>
              <div className={`closet-selection-preview ${card.items.length ? '' : 'empty'}`}>
                {card.items.length ? card.items.map((item) => <img src={item.imageUrl} alt="" key={item.id} />) : <strong>{card.title.slice(0, 2)}</strong>}
              </div>
              <div className="closet-selection-copy">
                <h3>{card.title}</h3>
                <p>{card.copy}</p>
              </div>
              <span className="closet-selection-action">{card.action}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="wrap closet-quick-actions closet-console-chips">
        {closetOccasions.map((idea) => <button type="button" key={idea} onClick={() => askForSuggestions(idea)}>{idea}</button>)}
      </section>

      <section className="wrap closet-shell">
        <aside className="closet-sidebar">
          <section className="closet-assistant">
            <div className="chat-panel-head"><div><strong>Closet Stylist</strong><span>Your clothes only</span></div><small>{user.tokens} tokens</small></div>
            <div className="closet-chat-scroll">
              {chat.map((entry, index) => <div className={`chat-row ${entry.role}`} key={`${entry.role}-${index}`}><div className="chat-bubble">{entry.text}</div></div>)}
            </div>
            <form className="chat-composer" onSubmit={submitChat}>
              <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="What should I wear today?" />
              <button type="submit" disabled={chatBusy || !chatInput.trim()}>{chatBusy ? '...' : 'Ask'}</button>
            </form>
          </section>
        </aside>

        <div className="closet-main">
          {message && <p className={`form-message closet-message ${/error|missing|not enough|failed|could not/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
          {state.loading && <StatusPanel text="Loading your closet..." />}
          {state.error && <StatusPanel text={state.error} />}

          {state.outfits.length > 0 && (
            <section className="closet-looks-section">
              <div className="section-head"><h2>Generated looks</h2><span className="count">{state.outfits.length} saved</span></div>
              <div className="closet-look-grid">
                {state.outfits.map((outfit) => (
                  <article className="closet-look-card" key={outfit.id}>
                    <div className="closet-look-media">
                      <ZoomableImage src={outfit.imageUrl} alt={outfit.title} />
                      <button className="fullscreen-button" type="button" aria-label="Open outfit full screen" title="Open full screen" onClick={() => setFullscreenImage({ src: outfit.imageUrl, alt: outfit.title, title: outfit.title })}><FullscreenIcon /></button>
                    </div>
                    <div className="closet-look-info">
                      <h3>{outfit.title}</h3>
                      <p>{[outfit.occasion, outfit.weather, outfit.mood, outfit.plannedFor ? `planned ${formatDate(outfit.plannedFor)}` : ''].filter(Boolean).join(' · ') || 'Generated closet outfit'}</p>
                      <div>{(outfit.items || []).slice(0, 4).map((item) => <span key={item.id}>{item.name}</span>)}</div>
                      <button className="secondary-button" type="button" onClick={() => scheduleOutfit(outfit, plannedFor)}>Plan For Selected Date</button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>
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
  const [backdrop, setBackdrop] = useState('neutral studio');
  const [pose, setPose] = useState('front facing');
  const [lighting, setLighting] = useState('natural light');
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');
  const [fullscreenImage, setFullscreenImage] = useState(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    api('/closet')
      .then((data) => {
        if (!alive) return;
        const items = data.items || [];
        setState({ items, suggestions: data.suggestions || [], loading: false, error: '' });
        const seededIds = JSON.parse(localStorage.getItem('fitlook_combo_seed') || '[]').filter((id) => items.some((item) => item.id === id));
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

  const selectedItems = selectedIds.map((id) => state.items.find((item) => item.id === id)).filter(Boolean);
  const selectedKey = selectedIds.slice().sort().join(':');
  const comboOptions = state.suggestions.slice(0, 6);
  const slotItems = closetComboSlots.map((slot) => ({
    ...slot,
    selected: state.items.find((item) => item.id === comboSlots[slot.key]) || null,
    options: state.items.filter((item) => slot.categories.includes(item.category))
  }));

  const selectedIdsFromSlots = (slots) => [...new Set(Object.values(slots).filter(Boolean))];
  const slotsFromItems = (items) => {
    const next = {};
    closetComboSlots.forEach((slot) => {
      const item = items.find((entry) => slot.categories.includes(entry.category));
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
    setComboSlots(slotsFromItems(items));
    setSelectedIds(items.map((item) => item.id).filter(Boolean));
  };

  const toggleSelected = (item) => {
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
    const replacement = state.items
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
      setState((current) => ({ ...current, suggestions: data.suggestions || [] }));
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
        body: JSON.stringify({
          itemIds: ids,
          occasion: details.occasion || occasion,
          weather,
          mood,
          plannedFor,
          backdrop,
          pose,
          lighting,
          notes: [backdrop, pose, lighting].filter(Boolean).join(' · '),
          title: details.title || `Closet combo for ${details.occasion || occasion || 'today'}`
        })
      });
      if (data.user) setUser(data.user);
      setMessage('Combo preview is ready.');
      if (data.outfit?.imageUrl) setFullscreenImage({ src: data.outfit.imageUrl, alt: data.outfit.title, title: data.outfit.title });
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
            <button type="button" onClick={() => askForSuggestions()} disabled={state.items.length === 0}>Suggest</button>
          </div>
          <div className="closet-scene-controls">
            <label><span>Plan date</span><input type="date" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)} /></label>
            <label><span>Backdrop</span><select value={backdrop} onChange={(event) => setBackdrop(event.target.value)}><option>neutral studio</option><option>office lobby</option><option>cafe</option><option>outdoor street</option><option>wedding venue</option></select></label>
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
              const comboIds = combo.itemIds || [];
              const comboKey = comboIds.slice().sort().join(':');
              const active = comboKey && comboKey === selectedKey;
              return (
                <button className={active ? 'active' : ''} type="button" key={combo.key || combo.title || index} onClick={() => applyComboItems(combo.items || [])}>
                  <span className="combo-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="combo-thumbs">{(combo.items || []).slice(0, 4).map((item) => <img src={item.imageUrl} alt="" key={item.id} />)}</span>
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
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
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
        if (alive) setState({ items: data.items || [], loading: false, error: '' });
      })
      .catch((err) => {
        if (alive) setState({ items: [], loading: false, error: err.message });
      });
    return () => {
      alive = false;
    };
  }, [user?.id]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const filteredItems = state.items.filter((item) => filter === 'all' || item.category === filter);

  const updateItem = async (item, updates) => {
    try {
      const data = await api(`/closet/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      setState((current) => ({ ...current, items: current.items.map((entry) => (entry.id === item.id ? data.item : entry)) }));
    } catch (err) {
      setMessage(err.message);
    }
  };

  const deleteItem = async (item) => {
    try {
      await api(`/closet/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setSelectedIds((current) => current.filter((id) => id !== item.id));
      setState((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }));
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
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [uploadPreview, setUploadPreview] = useState('');
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [savedItems, setSavedItems] = useState([]);

  useEffect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  }, [uploadPreview]);

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  const selectUpload = (event) => {
    const file = event.currentTarget.files?.[0];
    setUploadPreview(file ? URL.createObjectURL(file) : '');
    setMessage('');
  };

  const submitUpload = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const chosenFile = form.get('item');
    const file = chosenFile?.name ? chosenFile : cameraRef.current?.files?.[0] || fileRef.current?.files?.[0];
    if (!file || !file.name) {
      setMessage('Upload a clothing photo first.');
      return;
    }
    if (!form.get('name')) form.set('name', file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
    setUploading(true);
    setMessage('Saving closet item...');
    try {
      form.set('item', await prepareClosetItemPhoto(file));
      const data = await api('/closet/items', { method: 'POST', body: form });
      setSavedItems((current) => [data.item, ...current].slice(0, 6));
      event.currentTarget.reset();
      if (cameraRef.current) cameraRef.current.value = '';
      setUploadPreview('');
      setMessage('Added to your closet.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <main className="closet-add-page">
      <section className="wrap closet-add-hero">
        <div>
          <p className="kicker">Add Clothes</p>
          <h1>Build your digital wardrobe.</h1>
          <p className="lead">Add each shirt, pant, dress, suit, shoe, cap or accessory here. Then return to AI Closet to mix shirt and pant combinations.</p>
        </div>
        <a className="secondary-button" href="/closet">Back To Closet</a>
      </section>

      <section className="wrap closet-add-layout">
        <form className="closet-upload-card closet-add-form" onSubmit={submitUpload}>
          <label className={`upload-box closet-add-upload ${uploadPreview ? 'has-preview' : ''}`}>
            <input ref={fileRef} name="item" type="file" accept="image/*" onChange={selectUpload} />
            {uploadPreview ? <img className="upload-preview" src={uploadPreview} alt="Closet item preview" /> : <span><span className="upload-icon">↑</span><span className="upload-title">Upload clothing photo</span><span className="upload-help">Use one clear item per photo for best combo selection.</span></span>}
          </label>
          <input ref={cameraRef} className="camera-input" type="file" accept="image/*" capture="environment" onChange={selectUpload} />
          <button className="secondary-button camera-button" type="button" onClick={() => cameraRef.current?.click()}>Take Photo</button>
          <label className="field"><span>Name</span><input name="name" placeholder="Black formal shirt" /></label>
          <div className="two-col">
            <label className="field"><span>Type</span><select name="category" defaultValue=""><option value="">Auto</option>{closetCategories.slice(1).map(([label, value]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Color</span><input name="color" placeholder="black" /></label>
          </div>
          <div className="two-col">
            <label className="field"><span>Fabric</span><input name="fabric" placeholder="denim, cotton, silk" /></label>
            <label className="field"><span>Pattern</span><input name="pattern" placeholder="solid, striped" /></label>
          </div>
          <div className="two-col">
            <label className="field"><span>Season</span><select name="season" defaultValue="all-season"><option>all-season</option><option>summer</option><option>winter</option><option>rainy</option></select></label>
            <label className="field"><span>Vibe</span><select name="formality" defaultValue="any"><option>any</option><option>casual</option><option>smart-casual</option><option>formal</option><option>party</option><option>active</option></select></label>
          </div>
          <label className="field"><span>Occasions</span><input name="occasions" placeholder="office, date, wedding" /></label>
          <label className="field"><span>Tags</span><input name="tags" placeholder="linen, oversized, modest" /></label>
          <button className="submit" type="submit" disabled={uploading}>{uploading ? 'Saving...' : 'Save Clothing Item'}</button>
          {message && <p className={`form-message ${/error|missing|failed|could not|cannot|upload/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
        </form>

        <aside className="closet-add-guide">
          <h2>Best photos</h2>
          <div className="photo-rules">
            <strong>For better shirt and pant matching</strong>
            <ul>
              <li>Upload one item per photo.</li>
              <li>Use a plain background if possible.</li>
              <li>Choose the correct type for shirts, pants and shoes.</li>
              <li>Add color and fabric so AI can suggest better combos.</li>
            </ul>
          </div>
          {savedItems.length > 0 && (
            <div className="closet-added-list">
              <h3>Recently added</h3>
              {savedItems.map((item) => (
                <article key={item.id}>
                  <img src={item.imageUrl} alt="" />
                  <div><strong>{item.name}</strong><span>{[item.color, item.category].filter(Boolean).join(' · ')}</span></div>
                </article>
              ))}
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}

function TryOnGenerating({ text = 'Try-on is being generated' }) {
  const [progress, setProgress] = useState(7);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 94) return current;
        const step = current < 45 ? 7 : current < 76 ? 4 : 2;
        return Math.min(94, current + step);
      });
    }, 850);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="tryon-generating">
      <div className="tryon-progress-copy">
        <strong>{text}</strong>
        <span>{progress}%</span>
      </div>
      <div className="tryon-progress-track" aria-label={`${progress}% generated`}>
        <span style={{ width: `${progress}%` }} />
      </div>
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
    <main className="product-page">
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
          </div>
        </div>
      </section>
    </main>
  );
}

function SearchPage({ user, setUser, tryOnMode = false }) {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q') || '';
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

  const generateTryOn = async (product, options = {}) => {
    setTryOnLoading((current) => ({ ...current, [product.id]: true }));
    setTryOnErrors((current) => ({ ...current, [product.id]: '' }));
    try {
      const data = await api(`/tryons/${product.id}`, {
        method: 'POST',
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
    <>
      <Hero compact />
      <section className="wrap results-shell">
        <div className="results-main">
          <div className="results-head">
            <div><h1>{title}</h1><p className="count">{state.loading ? 'Searching...' : `${state.total} Products`}</p></div>
          </div>
          <ActiveFilterChips values={filterValues} />
          <FilterPanel className="mobile-filters" facets={state.facets} values={filterValues} />
          {state.loading && <ProductGridSkeleton count={8} />}
          {state.error && <StatusPanel text={state.error} />}
          {!state.loading && !state.error && state.products.length === 0 && <EmptyProducts search={title} />}
          {!state.loading && !state.error && state.products.length > 0 && (
            <div className="product-grid">
              {visibleProducts.map((product, index) => <ProductCard key={product.id} product={product} user={user} tryOn={tryOns[product.id]} canTryOn={allowTryOnTrial && index < 4} tryOnLoading={Boolean(tryOnLoading[product.id])} tryOnVideoLoading={Boolean(tryOnVideoLoading[product.id])} tryOnError={tryOnErrors[product.id]} tryOnVideoError={tryOnVideoErrors[product.id]} onTryOn={generateTryOn} onTryOnVideo={generateTryOnVideo} />)}
              {lockedProducts.length > 0 && (
                <div className="locked-row">
                  {lockedProducts.map((product) => <ProductCard key={`locked-${product.id}`} product={product} locked />)}
                  {user ? (
                    <div className="locked-content"><div><div className="lock-icon">▢</div><p className="locked-title">More AI try-ons are token gated</p><p className="locked-copy">Use the first row for trial previews, buy more tokens, or continue browsing regular product photos.</p><div className="locked-actions"><a className="buy" href="/tokens">Buy More Tokens</a><button className="browse" type="button" onClick={() => setContinueWithoutTryOn(true)}>Continue Without Try-On</button></div></div></div>
                  ) : (
                    <div className="locked-content"><div><div className="lock-icon">▢</div><p className="locked-title">AI try-on previews are locked</p><p className="locked-copy">Create a profile to see more products and generate try-on previews.</p><div className="locked-actions"><a className="buy" href="/signup">Create Profile</a><a className="browse" href="/search">Browse Without Try-On</a></div></div></div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <FilterPanel className="desktop-filters" facets={state.facets} values={filterValues} />
      </section>
    </>
  );
}

function CustomTryOnPage({ user, setUser }) {
  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

  return (
    <main className="custom-tryon-page">
      <section className="wrap custom-tryon-hero">
        <p className="kicker">Custom Try-On</p>
        <h1>Try on any clothing photo.</h1>
        <p className="lead">Upload a garment image and FitLook will generate it on your saved profile photo. Each generated image costs 1 token.</p>
      </section>
      <CustomClothingTryOn setUser={setUser} />
    </main>
  );
}

function CustomClothingTryOn({ setUser }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [garmentFile, setGarmentFile] = useState(null);
  const [garmentPreview, setGarmentPreview] = useState('');
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState(null);

  const chooseGarment = (event) => {
    const file = event.currentTarget.files?.[0];
    setResult(null);
    setMessage('');
    if (!file) {
      setGarmentFile(null);
      setGarmentPreview('');
      return;
    }
    setGarmentFile(file);
    setGarmentPreview(URL.createObjectURL(file));
  };

  const submit = async (event) => {
    event.preventDefault();
    const file = garmentFile || fileRef.current?.files?.[0] || cameraRef.current?.files?.[0];
    if (!file) {
      setMessage('Upload a clothing photo first.');
      return;
    }
    setLoading(true);
    setMessage('Generating custom try-on...');
    try {
      const form = new FormData();
      form.append('garment', file);
      const data = await api('/tryons/custom', { method: 'POST', body: form });
      setResult(data.tryOn);
      recordEvent('custom_tryon');
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
      setMessage('Custom try-on ready.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <section className="wrap custom-tryon">
        <div className="custom-tryon-copy">
          <p className="kicker">Custom Clothing</p>
          <h2>Upload the garment.</h2>
          <p>Use a clear front-facing photo where the clothing item is easy to see.</p>
        </div>
        <form className="custom-tryon-panel" onSubmit={submit}>
          <label className="upload-box custom-upload">
            <input ref={fileRef} name="garment" type="file" accept="image/*" onChange={chooseGarment} />
            <span>
              <span className="upload-icon">↑</span>
              <span className="upload-title">Upload clothing photo</span>
              <span className="upload-help">Use a front-facing product photo with the garment clearly visible.</span>
            </span>
          </label>
          <input ref={cameraRef} className="camera-input" type="file" accept="image/*" capture="environment" onChange={chooseGarment} />
          <button className="secondary-button camera-button" type="button" onClick={() => cameraRef.current?.click()}>Take Photo</button>
          <div className="custom-preview-grid">
            <div className="custom-preview">
              {garmentPreview ? <ZoomableImage src={garmentPreview} alt="Uploaded clothing preview" /> : <span>Garment preview</span>}
            </div>
            <div className="custom-preview result">
              {loading && <TryOnGenerating />}
              {result?.imageUrl ? (
                <>
                  <ZoomableImage src={result.imageUrl} alt="Generated custom try-on" />
                  <button className="fullscreen-button" type="button" aria-label="Open generated image full screen" title="Open full screen" onClick={() => setFullscreenImage({ src: result.imageUrl, alt: 'Generated custom try-on', title: 'Custom Try-On' })}><FullscreenIcon /></button>
                </>
              ) : <span>Generated try-on</span>}
            </div>
          </div>
          <button className="submit" type="submit" disabled={loading}>{loading ? 'Generating...' : 'Generate Custom Try-On'}</button>
          {message && <p className={`form-message ${result?.imageUrl ? '' : 'error-message'}`}>{message}</p>}
        </form>
      </section>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </>
  );
}

function StyleBotPage({ user, setUser }) {
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const promptIdeas = ['linen shirts under 1500', 'black party dress', 'gold sunglasses', 'oversized denim jacket'];

  if (!user) return <AuthPage mode="signup" setUser={setUser} />;

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
        generating: Object.fromEntries(products.map((product) => [product.id, true]))
      }));

      await Promise.allSettled(products.map(async (product) => {
        try {
          const generated = await api('/tryons/external', {
            method: 'POST',
            body: JSON.stringify({ product })
          });
          recordEvent('try_on', { query: product.name, metadata: { product } });
          updateRun(id, (run) => ({
            tryOns: { ...run.tryOns, [product.id]: generated.tryOn },
            errors: { ...run.errors, [product.id]: '' }
          }));
          if (generated.user) {
            setUser((current) => {
              if (!current) return generated.user;
              return { ...generated.user, tokens: Math.min(current.tokens, generated.user.tokens) };
            });
          }
        } catch (err) {
          updateRun(id, (run) => ({ errors: { ...run.errors, [product.id]: err.message } }));
        } finally {
          updateRun(id, (run) => ({ generating: { ...run.generating, [product.id]: false } }));
        }
      }));
    } catch (err) {
      updateRun(id, () => ({ loading: false, searchError: err.message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="style-bot-page">
      <section className="wrap style-bot-shell">
        <div className="style-bot-head">
          <p className="kicker">Style Bot</p>
          <h1>Tell FitLook what to find.</h1>
          <p className="lead">The bot searches public Amazon pages, pulls the top two product details into the chat, and auto-generates try-ons for those results. Each new try-on costs 1 token.</p>
          <div className="style-prompt-chips" aria-label="Style bot prompt ideas">
            {promptIdeas.map((idea) => <button type="button" key={idea} onClick={() => setQuery(idea)}>{idea}</button>)}
          </div>
        </div>

        <section className="chat-panel" aria-label="Style bot chat">
          <div className="chat-panel-head">
            <div><strong>FitLook Assistant</strong><span>Amazon trial search · 2 products max</span></div>
            <small>{`${user?.tokens ?? 0} tokens`}</small>
          </div>
          <div className="chat-scroll">
            <div className="chat-row assistant">
              <div className="chat-bubble">Tell me the item, vibe, color, budget, or occasion. I’ll find two options and generate the try-on right here.</div>
            </div>
            {runs.map((run) => (
              <div className="chat-run" key={run.id}>
                <div className="chat-row user"><div className="chat-bubble">{run.query}</div></div>
                <div className="chat-row assistant">
                  <div className="chat-bubble wide">
                    {run.loading && <StatusPanel text="Searching Amazon public pages..." />}
                    {run.searchError && <p className="form-message error-message">{run.searchError}</p>}
                    {!run.loading && !run.searchError && (
                      <>
                        <p className="chat-note">Found {run.products.length} products · try-ons generate automatically</p>
                        <div className="style-results">
                          {run.products.map((product) => (
                            <StyleBotProduct
                              key={product.id}
                              product={product}
                              tryOn={run.tryOns[product.id]}
                              loading={Boolean(run.generating[product.id])}
                              error={run.errors[product.id]}
                              onFullscreen={setFullscreenImage}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <form className="chat-composer" onSubmit={submit}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Describe the dress, outfit, or accessory" />
            <button type="submit" disabled={busy || !query.trim()}>{busy ? 'Working...' : 'Send'}</button>
          </form>
        </section>
      </section>
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </main>
  );
}

function StyleBotProduct({ product, tryOn, loading, error, onFullscreen }) {
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const tags = (product.tags || []).filter(Boolean).slice(0, 4);
  const productImage = product.imageUrl || asset('hero2.png');
  const hasUsableTryOn = Boolean(tryOn?.imageUrl) && !tryOnImageFailed;
  const brand = displayBrand(product);
  const category = displayCategory(product);

  useEffect(() => {
    setTryOnImageFailed(false);
  }, [tryOn?.imageUrl]);

  return (
    <article className="style-result-card">
      <div className="style-result-media">
        <div>
          <span className="style-media-label">Product</span>
          <ZoomableImage src={productImage} alt={product.name} />
        </div>
        <div className="style-generated">
          <span className="style-media-label">On You</span>
          {loading && <TryOnGenerating />}
          {hasUsableTryOn ? (
            <>
              <ZoomableImage src={tryOn.imageUrl} alt={`AI try-on for ${product.name}`} onError={() => setTryOnImageFailed(true)} />
              <button className="fullscreen-button" type="button" aria-label="Open generated image full screen" title="Open full screen" onClick={() => onFullscreen({ src: tryOn.imageUrl, alt: `AI try-on for ${product.name}`, title: product.name })}><FullscreenIcon /></button>
            </>
          ) : tryOn?.imageUrl ? (
            <ZoomableImage src={productImage} alt={product.name} />
          ) : <div className="style-placeholder">Waiting for try-on</div>}
        </div>
      </div>
      <div className="style-result-info">
        <h2>{product.name}</h2>
        <p>{brand} · {category}</p>
        <p className="rating"><span>★</span> {Number(product.rating || 0).toFixed(1)} {product.ratingCount ? `(${product.ratingCount})` : ''}</p>
        <div className="price-row"><span className="price">{formatMoney(product.price, product.currency)}</span></div>
        {product.description && <p className="style-result-description">{product.description}</p>}
        {tags.length > 0 && <div className="style-result-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
        {error && <p className="form-message error-message">{error}</p>}
        <div className="style-result-actions">
          {product.affiliateLink && <a className="button" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={() => recordEvent('shop_click', { query: product.name, metadata: { product } })}>Shop ↗</a>}
        </div>
      </div>
    </article>
  );
}

function ImageLightbox({ image, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Generated try-on preview" onClick={onClose}>
      <button className="lightbox-close" type="button" onClick={onClose} aria-label="Close full screen preview">×</button>
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={image.src} alt={image.alt} />
        <figcaption>{image.title}</figcaption>
      </figure>
    </div>
  );
}

function TokenPage({ user, setUser }) {
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [plans, setPlans] = useState([]);
  const verifiedOrderRef = useRef('');
  const params = new URLSearchParams(window.location.search);
  const returnedOrderId = params.get('merchantOrderId') || params.get('orderId') || '';
  const subscription = user?.subscription;
  const isActive = subscription?.status === 'active' && (!subscription.currentPeriodEnd || new Date(subscription.currentPeriodEnd) > new Date());
  const fallbackPlan = { id: 'monthly_100_tokens', name: 'Lookmefy 100 Token Pack', amount: 100000, currency: 'INR', tokens: 100 };
  const plan = plans[0] || fallbackPlan;
  const planPrice = Number(plan.amount) / 100;
  const planTokens = Number(plan.tokens) || 0;

  useEffect(() => {
    let alive = true;
    api('/payments/plans')
      .then((data) => {
        if (alive) setPlans(Array.isArray(data?.plans) ? data.plans : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!user || !returnedOrderId || verifiedOrderRef.current === returnedOrderId) return;
    verifiedOrderRef.current = returnedOrderId;
    let alive = true;
    setMessage('Verifying payment with PhonePe...');
    api(`/payments/orders/${encodeURIComponent(returnedOrderId)}/status`)
      .then((data) => {
        if (!alive) return;
        if (data.user) setUser(data.user);
        const state = data.order?.status;
        if (state === 'completed') setMessage(`Payment confirmed. ${Number(data.order?.tokens) || planTokens} tokens have been added to your account.`);
        else if (state === 'failed') setMessage('Payment was not completed. You can try again when ready.');
        else setMessage('Payment is still pending. Refresh this page in a moment to check again.');
      })
      .catch((err) => {
        if (alive) setMessage(err.message);
      });
    return () => {
      alive = false;
    };
  }, [user, returnedOrderId, setUser, planTokens]);

  const startCheckout = async () => {
    if (!user) {
      window.location.href = '/signup';
      return;
    }
    setCheckoutLoading(true);
    setMessage('Opening PhonePe checkout...');
    try {
      const data = await api('/payments/phonepe/subscription', {
        method: 'POST',
        body: JSON.stringify({ planId: plan.id })
      });
      window.location.assign(data.redirectUrl);
    } catch (err) {
      setMessage(err.message);
      setCheckoutLoading(false);
    }
  };

  // Dev mode removed in frontend — token mode only

  return (
    <main className="token-page">
      <section className="wrap token-hero">
        <p className="kicker">FitLook Tokens</p>
        <h1>One token, one AI try-on.</h1>
        <p className="lead">Get 20 free tokens on signup. {plan.name} adds {planTokens} try-on tokens for {formatMoney(planPrice)}.</p>
        <div className="token-balance">{user ? <><span>{user.tokens}</span><strong>tokens available</strong></> : <><span>20</span><strong>free tokens on signup</strong></>}</div>
        {message && <p className={`token-message ${/failed|not completed|missing|Could not|error/i.test(message) ? 'error-message' : ''}`}>{message}</p>}
      </section>

      <section className="wrap token-grid subscription-grid">
        <article className="token-pack featured-token-pack">
          <div className="plan-status-row">
            <h2>{plan.name}</h2>
            {isActive && <span>Active</span>}
          </div>
          <p className="token-amount">{planTokens} tokens</p>
          <p className="token-price">{formatMoney(planPrice)}</p>
          <p>PhonePe checkout opens securely when you buy credits. Tokens are added only after payment is confirmed.</p>
          <button type="button" onClick={startCheckout} disabled={checkoutLoading}>
            {checkoutLoading ? 'Opening PhonePe...' : user ? 'Buy with PhonePe' : 'Create Account First'}
          </button>
          {isActive && subscription.currentPeriodEnd && <small>Plan window ends {formatDate(subscription.currentPeriodEnd)}</small>}
        </article>
      </section>

      <section className="wrap token-rules">
        <article><h3>What costs tokens?</h3><p>Generating a product try-on or custom clothing try-on costs 1 token.</p></article>
        <article><h3>What is free?</h3><p>New accounts start with 20 free tokens. Browsing, search, product pages, and viewing saved try-ons are free.</p></article>
        <article><h3>How payment works</h3><p>FitLook verifies the PhonePe order status before adding paid tokens, so a return or callback cannot double-credit your account.</p></article>
      </section>
    </main>
  );
}

function ProfilePage({ user, setUser }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [preview, setPreview] = useState('');
  const [photoFile, setPhotoFile] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [profilePhotoMode, setProfilePhotoMode] = useState('ai-full-body');

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

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

  const photoSrc = preview || user.bodyPhotoUrl;
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

  return (
    <main className="profile-page">
      <section className="wrap profile-hero">
        <div>
          <p className="kicker">Profile</p>
          <h1>Your fitting room profile.</h1>
          <p className="lead">Manage the account details and body photo FitLook uses for AI try-on previews.</p>
        </div>
        <div className="profile-credit-card">
          <span>{user.tokens}</span>
          <strong>credits available</strong>
          <a href="/tokens">View token plans</a>
        </div>
      </section>

      <section className="wrap profile-grid">
        <article className="profile-card">
          <h2>Basic details</h2>
          <dl className="profile-details">
            <div><dt>Name</dt><dd>{user.name}</dd></div>
            <div><dt>Username</dt><dd>@{user.username}</dd></div>
            <div><dt>Email</dt><dd>{user.email}</dd></div>
            <div><dt>Preference</dt><dd>{genderPreferenceLabel(user.genderPreference)}</dd></div>
            <div><dt>Joined</dt><dd>{formatDate(user.joinedAt)}</dd></div>
          </dl>
        </article>

        <article className="profile-card">
          <h2>Credits</h2>
          <div className="profile-token-meter">
            <span>{user.tokens}</span>
            <div>
              <strong>{`${user.tokens} try-on credits`}</strong>
              <p>Each new AI-generated try-on costs 1 token. Cached try-ons are free to view again.</p>
            </div>
          </div>
        </article>

        <article className="profile-card profile-photo-card">
          <div>
            <h2>Try-on photo</h2>
            <p>Upload a selfie or body photo. FitLook creates the full-body reference used for product and custom try-ons.</p>
            {user.bodyPhotoStatus === 'generating' && <p className="form-message">Full-body try-on profile is preparing in the background.</p>}
            {user.bodyPhotoStatus === 'failed' && <p className="form-message error-message">Full-body profile generation failed. Upload a clearer selfie or body photo.</p>}
          </div>
          <form className="profile-photo-form" onSubmit={submitPhoto}>
            <label className={`upload-box profile-photo-upload ${photoSrc ? 'has-preview' : ''}`}>
              <input ref={fileRef} name="bodyPhoto" type="file" accept={BODY_PHOTO_ACCEPT} onChange={selectPhoto} />
              {photoSrc ? (
                <>
                  <img className="upload-preview" src={photoSrc} alt="Current try-on profile" />
                  <span className="upload-overlay"><span className="upload-title">Change try-on photo</span><span className="upload-help">Use a clear selfie or front-facing photo.</span></span>
                </>
              ) : (
                <span><span className="upload-icon">↑</span><span className="upload-title">Upload selfie or photo</span><span className="upload-help">FitLook will create a full-body try-on profile.</span></span>
              )}
            </label>
            <input ref={cameraRef} className="camera-input" type="file" accept={BODY_PHOTO_ACCEPT} capture="user" onChange={selectPhoto} />
            <button className="secondary-button camera-button" type="button" onClick={() => cameraRef.current?.click()}>Take Photo</button>
            <div className="tryon-model-select" role="radiogroup" aria-label="Profile photo mode">
              <label className={profilePhotoMode === 'ai-full-body' ? 'active' : ''}>
                <input type="radio" name="profilePhotoMode" value="ai-full-body" checked={profilePhotoMode === 'ai-full-body'} onChange={(event) => setProfilePhotoMode(event.target.value)} />
                <span>Create full-body AI profile</span>
              </label>
              <label className={profilePhotoMode === 'exact' ? 'active' : ''}>
                <input type="radio" name="profilePhotoMode" value="exact" checked={profilePhotoMode === 'exact'} onChange={(event) => setProfilePhotoMode(event.target.value)} />
                <span>Use this exact photo</span>
              </label>
            </div>
            <button className="submit" type="submit" disabled={saving || !preview}>{saving ? 'Saving...' : 'Save New Photo'}</button>
            {message && <p className="form-message">{message}</p>}
          </form>
        </article>
      </section>
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

  const hrefWithout = (key) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([name, value]) => {
      if (name !== key && value) params.set(name, value);
    });
    return `/search${params.toString() ? `?${params}` : ''}`;
  };

  return (
    <div className="active-filters" aria-label="Active filters">
      {active.map(([key, , label]) => <a href={hrefWithout(key)} key={key}>{label}<span>×</span></a>)}
      <a className="clear" href="/search">Clear all</a>
    </div>
  );
}

function FilterPanel({ facets, values, className = '' }) {
  const resetHref = '/search';
  const brands = usableBrands(facets.brands);

  return (
    <aside className={`filters ${className}`}>
      <div className="filter-head"><h2>Filters</h2><a href={resetHref}>Reset</a></div>
      <form className="filter-form" action="/search">
        <input name="q" defaultValue={values.q} placeholder="Search keyword" />
        <select name="category" defaultValue={values.category}>
          <option value="">All categories</option>
          {facets.categories.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select name="brand" defaultValue={values.brand}>
          <option value="">All brands</option>
          {brands.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select name="gender" defaultValue={values.gender}>
          <option value="">All genders</option>
          <option value="men">Men</option>
          <option value="women">Women</option>
          <option value="unisex">Unisex</option>
        </select>
        <select name="sort" defaultValue={values.sort}>
          <option value="">Most relevant</option>
          <option value="newest">Newest</option>
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
        </select>
        {values.newArrival && <input type="hidden" name="newArrival" value={values.newArrival} />}
        {values.tag && <input type="hidden" name="tag" value={values.tag} />}
        <button className="apply">Apply Filters</button>
      </form>
    </aside>
  );
}

function ProductPage({ id, user, setUser }) {
  const { product, loading, error } = useProduct(id);
  const related = useSimilarProducts(id, 4);
  const [tryOn, setTryOn] = useState(null);
  const [tryOnImageFailed, setTryOnImageFailed] = useState(false);
  const [tryOnLoading, setTryOnLoading] = useState(false);
  const [tryOnVideoLoading, setTryOnVideoLoading] = useState(false);
  const [tryOnError, setTryOnError] = useState('');
  const [tryOnVideoError, setTryOnVideoError] = useState('');
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [detailImageView, setDetailImageView] = useState('tryon');
  const productViewStarted = useRef('');
  const relatedProducts = related.products.filter((item) => item.id !== id).slice(0, 4);
  const [relatedTryOns] = useTryOnCache(user, relatedProducts);

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

  if (loading) {
    return <ProductDetailSkeleton />;
  }

  if (error || !product) {
    return (
      <main className="wrap product-page">
        <div className="empty-products">
          <h3>Product not found.</h3>
          <p>This item may have been removed from the catalog.</p>
          <a className="button" href="/search">Back to Shop</a>
        </div>
      </main>
    );
  }

  const hasDiscount = product.compareAtPrice && product.compareAtPrice > product.price;
  const discount = hasDiscount ? `${Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)}% off` : '';
  const productImage = product.imageUrl || asset('hero2.png');
  const hasUsableTryOn = Boolean(tryOn?.imageUrl) && !tryOnImageFailed;
  const hasTryOnVideo = Boolean(tryOn?.videoUrl) && hasUsableTryOn;
  const showingTryOn = hasUsableTryOn && detailImageView !== 'product';
  const showingTryOnVideo = showingTryOn && hasTryOnVideo;
  const image = showingTryOn ? tryOn.imageUrl : productImage;
  const swapPreview = hasUsableTryOn && product.imageUrl
    ? {
        label: showingTryOn ? 'Product photo' : 'AI Try-On',
        src: showingTryOn ? product.imageUrl : tryOn.imageUrl,
        alt: showingTryOn ? `${product.name} product photo` : `AI try-on for ${product.name}`,
        nextView: showingTryOn ? 'product' : 'tryon'
      }
    : null;
  const brand = displayBrand(product);
  const category = displayCategory(product);
  const detailFacts = [
    ['Brand', brand],
    ['Category', category],
    ['For', product.gender],
    ['Rating', `${Number(product.rating || 0).toFixed(1)}${product.ratingCount ? ` from ${product.ratingCount} reviews` : ''}`],
    ['Price', formatMoney(product.price, product.currency)]
  ].filter(([, value]) => value);
  const productTags = (product.tags || []).filter(Boolean).slice(0, 10);

  const generateProductTryOn = async () => {
    if (!product || tryOnLoading) return;
    const regenerate = Boolean(tryOn?.imageUrl);
    setTryOnLoading(true);
    setTryOnError('');
    try {
      const data = await api(`/tryons/${product.id}`, {
        method: 'POST',
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
      }
    } catch (err) {
      setTryOnError(err.message);
    } finally {
      setTryOnLoading(false);
    }
  };

  const generateProductTryOnVideo = async () => {
    if (!product || tryOnVideoLoading || !hasUsableTryOn) return;
    const regenerate = Boolean(tryOn?.videoUrl);
    setTryOnVideoLoading(true);
    setTryOnVideoError('');
    try {
      const data = await api(`/tryons/${product.id}/video`, {
        method: 'POST',
        body: regenerate ? JSON.stringify({ force: true }) : undefined
      });
      setTryOn(data.tryOn);
      setDetailImageView('tryon');
      recordEvent('try_on', { productId: product.id, metadata: { video: true, regenerated: regenerate } });
      if (data.user) {
        setUser((current) => {
          if (!current) return data.user;
          return { ...data.user, tokens: Math.min(current.tokens, data.user.tokens) };
        });
      }
    } catch (err) {
      setTryOnVideoError(err.message);
    } finally {
      setTryOnVideoLoading(false);
    }
  };

  return (
    <main className="product-page">
      <section className="wrap product-detail">
        <div className="breadcrumb"><a href="/search">Shop</a><span>/</span><a href={`/search?category=${encodeURIComponent(product.category || '')}`}>{category}</a></div>
        <div className="product-detail-grid">
          <div className={`product-detail-media ${showingTryOn ? 'showing-tryon' : 'showing-product'}`}>
            {showingTryOnVideo ? (
              <video className="tryon-video-player" src={tryOn.videoUrl} poster={tryOn.imageUrl} autoPlay muted loop playsInline controls />
            ) : (
              <ZoomableImage
                src={image}
                alt={product.name}
                zoom={showingTryOn ? 1 : 1.75}
                disableZoom={showingTryOn}
                onError={(event) => {
                  if (hasUsableTryOn) setTryOnImageFailed(true);
                  else if (event.currentTarget.src !== window.location.origin + asset('hero2.png')) event.currentTarget.src = asset('hero2.png');
                }}
              />
            )}
            {product.badge && <span className="badge">{product.badge}</span>}
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
            {(tryOnLoading || tryOnVideoLoading) && <TryOnGenerating text={tryOnVideoLoading ? 'Generating video' : 'Generating try-on'} />}
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
          <div className="product-summary">
            <p className="kicker">{brand}</p>
            <h1>{product.name}</h1>
            <p className="rating detail-rating"><span>★</span> {Number(product.rating || 0).toFixed(1)} {product.ratingCount ? `(${product.ratingCount} reviews)` : ''}</p>
            <div className="price-row detail-price">
              <span className="price">{formatMoney(product.price || 0, product.currency)}</span>
              {hasDiscount && <span className="was">{formatMoney(product.compareAtPrice, product.currency)}</span>}
              {discount && <span className="off">{discount}</span>}
            </div>
            <p className="product-description">{product.description || 'No product description has been added yet.'}</p>
            <div className="product-meta">
              {product.category && <a href={`/search?category=${encodeURIComponent(product.category)}`}>{category}</a>}
              {product.gender && <a href={`/search?gender=${encodeURIComponent(product.gender)}`}>{product.gender}</a>}
              {product.isNewArrival && <span>New arrival</span>}
            </div>
            <div className="product-detail-facts" aria-label="Product details">
              {detailFacts.map(([label, value]) => (
                <div key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
            {productTags.length > 0 && (
              <div className="product-tags" aria-label="Product tags">
                {productTags.map((tag) => <a href={`/search?tag=${encodeURIComponent(tag)}`} key={tag}>{tag}</a>)}
              </div>
            )}
            <div className="product-actions">
              {product.affiliateLink && <a className="button" href={product.affiliateLink} target="_blank" rel="noreferrer" onClick={() => recordEvent('shop_click', { productId: product.id })}>Shop Brand ↗</a>}
              {user ? (
                <button className="secondary-button" type="button" onClick={generateProductTryOn} disabled={tryOnLoading}>
                  {tryOnLoading ? 'Generating Try-On...' : hasUsableTryOn ? 'Generate Try-On Again' : tryOnImageFailed ? 'Try Again' : 'Generate AI Try-On'}
                </button>
              ) : <a className="secondary-button" href="/signup">Create Profile for Try-On</a>}
              {user && hasUsableTryOn && (
                <button className="secondary-button video-tryon-button" type="button" onClick={generateProductTryOnVideo} disabled={tryOnLoading || tryOnVideoLoading}>
                  {tryOnVideoLoading ? 'Generating Video...' : hasTryOnVideo ? 'Generate Video Again' : 'Generate Video Try-On'}
                </button>
              )}
            </div>
            {tryOnError && <p className="form-message error-message">{tryOnError}</p>}
            {tryOnVideoError && <p className="form-message error-message">{tryOnVideoError}</p>}
          </div>
        </div>
      </section>

      {relatedProducts.length > 0 && (
        <section className="section">
          <div className="wrap">
            <div className="section-head"><h2>More Like This</h2><a className="view-all" href={`/search?category=${encodeURIComponent(product.category || '')}`}>View all ›</a></div>
            <div className="product-grid">{relatedProducts.map((item) => <ProductCard key={item.id} product={item} user={user} tryOn={relatedTryOns[item.id]} />)}</div>
          </div>
        </section>
      )}
      {fullscreenImage && <ImageLightbox image={fullscreenImage} onClose={() => setFullscreenImage(null)} />}
    </main>
  );
}

function StatusPanel({ text }) {
  return <div className="status-panel">{text}</div>;
}

function EmptyProducts({ search }) {
  return (
    <div className="empty-products">
      <h3>No real products yet.</h3>
      <p>{search ? `Nothing matched "${search}". Try a different search or browse the latest products.` : 'Products will appear here as soon as the catalog is available.'}</p>
      <a className="button" href="/search">Browse Products</a>
    </div>
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
      copy: 'Use one token to create a try-on image. If that same product was already generated for you, FitLook reuses the saved result.',
      meta: '1 token when new'
    },
    {
      title: 'Compare and shop',
      copy: 'Open the generated image full screen, compare it with the product photo, then continue to the brand store when ready.',
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
          <p className="kicker">How FitLook Works</p>
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

      <section className="wrap how-steps" aria-label="FitLook steps">
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

function InfoPage({ meta, children, user, ctaLabel, ctaHref }) {
  const [kicker, title, lead, image] = meta;
  const actionLabel = ctaLabel || (user ? 'Browse Products' : 'Create Profile');
  const actionHref = ctaHref || (user ? '/search' : '/signup');

  return (
    <>
      <section className="page-hero"><div className="wrap hero-grid"><div className="page-copy"><p className="kicker">{kicker}</p><h1>{title}</h1><p className="lead">{lead}</p><a className="button" href={actionHref}>{actionLabel}</a></div><div className="page-image"><img src={asset(image)} alt="" /></div></div></section>
      {children || <section className="section"><div className="wrap info-grid"><article className="info-card"><h3>AI try-on ready</h3><p>Preview selected products on your profile.</p></article><article className="info-card"><h3>Catalog shopping</h3><p>Explore styles, categories, and new arrivals.</p></article><article className="info-card"><h3>Token powered</h3><p>Use tokens only when generating previews.</p></article><article className="info-card"><h3>Privacy aware</h3><p>Your full-body photo is part of your personal profile.</p></article></div></section>}
    </>
  );
}

function PolicyPage({ meta, policy, user }) {
  const emailHref = `mailto:${supportEmail}?subject=${encodeURIComponent(policy.emailSubject || 'Lookmefy support request')}`;
  return (
    <InfoPage meta={policy.meta || meta} user={user} ctaLabel="Email Support" ctaHref={emailHref}>
      <section className="section">
        <div className="wrap info-grid">
          {policy.sections.map(([title, body]) => (
            <article className="info-card" key={title}>
              <h3>{title}</h3>
              {body.map((text) => <p key={text}>{text}</p>)}
            </article>
          ))}
        </div>
      </section>
    </InfoPage>
  );
}

function AuthPage({ mode, setUser }) {
  const bodyPhotoCameraRef = useRef(null);
  const [message, setMessage] = useState('');
  const [nameValue, setNameValue] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [usernameSuggestions, setUsernameSuggestions] = useState([]);
  const [bodyPhotoFile, setBodyPhotoFile] = useState(null);
  const [bodyPhotoPreview, setBodyPhotoPreview] = useState('');
  const [profilePhotoMode, setProfilePhotoMode] = useState('ai-full-body');
  const [phoneValue, setPhoneValue] = useState('');
  const [otpValue, setOtpValue] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [signupToken, setSignupToken] = useState('');
  const isSignup = mode === 'signup';

  useEffect(() => {
    if (!isSignup) return;
    const cleanName = nameValue.trim();
    if (!cleanName) {
      setUsernameSuggestions([]);
      if (!usernameTouched) setUsername('');
      return;
    }

    let alive = true;
    const timer = setTimeout(() => {
      api(`/auth/username-suggestions?name=${encodeURIComponent(cleanName)}`)
        .then((data) => {
          if (!alive) return;
          const suggestions = data.suggestions || [];
          setUsernameSuggestions(suggestions);
          if (!usernameTouched && suggestions[0]) setUsername(suggestions[0]);
        })
        .catch(() => {
          if (alive) setUsernameSuggestions([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [isSignup, nameValue, usernameTouched]);

  useEffect(() => () => {
    if (bodyPhotoPreview) URL.revokeObjectURL(bodyPhotoPreview);
  }, [bodyPhotoPreview]);

  const previewBodyPhoto = (event) => {
    const file = event.currentTarget.files?.[0];
    setBodyPhotoFile(file || null);
    setMessage(file && file.size > MAX_BODY_PHOTO_BYTES ? ((isHeicFile(file) || isAvifFile(file)) ? 'Large AVIF/HEIC/HEIF photo selected. Please choose one under 8 MB.' : 'Large profile photo selected. It will be optimized before upload.') : '');
    setBodyPhotoPreview(file ? URL.createObjectURL(file) : '');
  };

  const messageIsError = Boolean(message) && !/^(Working|Creating account|Sending OTP|OTP sent|Verifying OTP|Mobile verified)/i.test(message);

  const submit = async (event) => {
    event.preventDefault();
    try {
      if (isSignup && !signupToken) {
        const phone = phoneValue.trim();
        if (!phone) throw new Error('Enter your mobile number.');
        if (!otpSent) {
          setMessage('Sending OTP...');
          await api('/auth/otp/send', {
            method: 'POST',
            body: JSON.stringify({ phone, purpose: 'signup' })
          });
          setOtpSent(true);
          setMessage('OTP sent. Enter it to verify your mobile number.');
          return;
        }
        if (!otpValue.trim()) throw new Error('Enter the OTP sent to your mobile number.');
        setMessage('Verifying OTP...');
        const verified = await api('/auth/otp/verify', {
          method: 'POST',
          body: JSON.stringify({ phone, otp: otpValue.trim(), purpose: 'signup' })
        });
        if (!verified.signupToken) throw new Error('Mobile verification did not return a signup token. Please try again.');
        setSignupToken(verified.signupToken);
        setMessage('Mobile verified. Complete your profile.');
        return;
      }

      setMessage(isSignup ? 'Creating account...' : 'Working...');
      const form = event.currentTarget;
      const body = isSignup ? new FormData(form) : JSON.stringify(Object.fromEntries(new FormData(form)));
      if (isSignup) {
        const bodyPhoto = bodyPhotoFile || form.elements.bodyPhoto?.files?.[0] || bodyPhotoCameraRef.current?.files?.[0];
        if (!bodyPhoto) throw new Error('Choose or take a profile photo first.');
        body.set('bodyPhoto', await prepareBodyPhoto(bodyPhoto));
        body.set('signupToken', signupToken);
      }
      const data = await api(isSignup ? '/auth/signup/complete' : '/auth/login', { method: 'POST', body });
      localStorage.setItem('fitlook_token', data.token);
      setUser(data.user);
      window.history.pushState({}, '', '/search');
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (err) {
      setMessage(err.message);
    }
  };

  return (
    <main className="auth-layout wrap">
      <section className="auth-panel">
        <div className="auth-card">
          <p className="auth-kicker">{isSignup ? 'Create Profile' : 'Welcome Back'}</p>
          <h1>{isSignup ? 'Build your AI fitting room.' : 'Log in to your fitting room.'}</h1>
          <p className="auth-copy">{isSignup ? 'Upload a selfie or body photo. FitLook creates a full-body profile image for realistic outfit previews.' : 'Continue browsing, unlock your saved looks, and generate AI previews.'}</p>
          <form className="auth-form" onSubmit={submit}>
            {isSignup && !signupToken && (
              <>
                <label className="field"><span>Mobile number</span><input name="phone" type="tel" required value={phoneValue} onChange={(event) => { setPhoneValue(event.target.value); setOtpSent(false); setOtpValue(''); }} placeholder="+91 98765 43210" /></label>
                {otpSent && <label className="field"><span>OTP</span><input name="otp" inputMode="numeric" autoComplete="one-time-code" required value={otpValue} onChange={(event) => setOtpValue(event.target.value.replace(/\D/g, '').slice(0, 8))} /></label>}
              </>
            )}
            {isSignup && signupToken && (
              <>
                <label className="field"><span>Full name</span><input name="name" required value={nameValue} onChange={(event) => { setNameValue(event.target.value); setUsernameTouched(false); }} /></label>
                <label className="field"><span>Username</span><input name="username" required minLength="3" value={username} onChange={(event) => { setUsernameTouched(true); setUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '')); }} /></label>
                {usernameSuggestions.length > 0 && (
                  <div className="username-suggestions" aria-label="Username suggestions">
                    {usernameSuggestions.map((item) => (
                      <button type="button" key={item} onClick={() => { setUsernameTouched(true); setUsername(item); }}>{item}</button>
                    ))}
                  </div>
                )}
              </>
            )}
            {!isSignup && <label className="field"><span>Mobile, email, or username</span><input name="email" type="text" required /></label>}
            {isSignup && signupToken && (
              <label className="field">
                <span>Gender preference</span>
                <select name="genderPreference" required defaultValue="">
                  <option value="" disabled>Choose preference</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </label>
            )}
            {(!isSignup || signupToken) && <label className="field"><span>Password</span><input name="password" type="password" required minLength="8" /></label>}
            {isSignup && signupToken && (
              <>
                <label className={`upload-box ${bodyPhotoPreview ? 'has-preview' : ''}`}>
                  <input name="bodyPhoto" type="file" accept={BODY_PHOTO_ACCEPT} onChange={previewBodyPhoto} />
                  {bodyPhotoPreview ? (
                    <>
                      <img className="upload-preview" src={bodyPhotoPreview} alt="Uploaded profile preview" />
                      <span className="upload-overlay"><span className="upload-title">Change profile photo</span><span className="upload-help">Use a clear selfie or front-facing photo.</span></span>
                    </>
                  ) : (
                    <span><span className="upload-icon">↑</span><span className="upload-title">Upload a selfie or photo</span><span className="upload-help">FitLook will create your full-body try-on profile.</span></span>
                  )}
                </label>
                <input ref={bodyPhotoCameraRef} className="camera-input" type="file" accept={BODY_PHOTO_ACCEPT} capture="user" onChange={previewBodyPhoto} />
                <button className="secondary-button camera-button" type="button" onClick={() => bodyPhotoCameraRef.current?.click()}>Take Photo</button>
                <div className="tryon-model-select" role="radiogroup" aria-label="Profile photo mode">
                  <label className={profilePhotoMode === 'ai-full-body' ? 'active' : ''}>
                    <input type="radio" name="profilePhotoMode" value="ai-full-body" checked={profilePhotoMode === 'ai-full-body'} onChange={(event) => setProfilePhotoMode(event.target.value)} />
                    <span>Create full-body AI profile</span>
                  </label>
                  <label className={profilePhotoMode === 'exact' ? 'active' : ''}>
                    <input type="radio" name="profilePhotoMode" value="exact" checked={profilePhotoMode === 'exact'} onChange={(event) => setProfilePhotoMode(event.target.value)} />
                    <span>Use this exact photo</span>
                  </label>
                </div>
                <div className="photo-rules" aria-label="Allowed try-on photo guidelines">
                  <strong>Best photo for AI try-on</strong>
                  <ul>
                    <li>Use a single-person selfie, portrait, or body photo.</li>
                    <li>Face the camera with your face clearly visible.</li>
                    <li>Choose bright lighting and a simple background.</li>
                    <li>Avoid heavy filters, group photos, covered faces, or very blurry images.</li>
                  </ul>
                </div>
              </>
            )}
            <button className="submit">{isSignup ? (signupToken ? 'Create Account' : otpSent ? 'Verify Mobile' : 'Send OTP') : 'Log In'}</button>
          </form>
          {message && <p className={`form-message ${messageIsError ? 'error-message' : ''}`}>{message}</p>}
          <p className="switch">{isSignup ? 'Already have an account?' : 'New to FitLook?'} <a href={isSignup ? '/login' : '/signup'}>{isSignup ? 'Log in' : 'Create an account'}</a></p>
        </div>
        <div className="auth-visual"><img src={asset('hero2.png')} alt="" /></div>
      </section>
    </main>
  );
}

function FeatureBand() {
  return <section className="feature-band"><div className="wrap features">{['AI Try-On', 'Top Brands', 'Secure & Private', 'Easy Returns', '24/7 Support'].map((f) => <div className="feature" key={f}><div className="feature-icon">✦</div><div><p className="feature-title">{f}</p><p className="feature-copy">Designed for confident shopping</p></div></div>)}</div></section>;
}

function App() {
  const [path, setPath] = useState(normalizePath());
  const [user, setUser] = useState(null);

  useEffect(() => {
    const onPop = () => setPath(normalizePath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('fitlook_token')) return;
    api('/auth/me').then((data) => setUser(data.user)).catch(() => localStorage.removeItem('fitlook_token'));
  }, []);

  useEffect(() => {
    if (!user || (path !== '/signup' && path !== '/login')) return;
    window.history.replaceState({}, '', '/search');
    setPath('/search');
  }, [path, user]);

  const page = useMemo(() => {
    const productMatch = path.match(/^\/product\/([^/]+)$/);
    if (path === '/') return <Home user={user} />;
    if (path === '/search') return <SearchPage user={user} setUser={setUser} />;
    if (path === '/categories') return <CategoriesPage />;
    if (path === '/try-on') return user ? <SearchPage user={user} setUser={setUser} tryOnMode /> : <AuthPage mode="signup" setUser={setUser} />;
    if (path === '/closet') return <ClosetPage user={user} setUser={setUser} />;
    if (path === '/closet/add') return <ClosetAddPage user={user} setUser={setUser} />;
    if (path === '/closet/combo') return <ClosetComboPage user={user} setUser={setUser} />;
    if (path === '/closet/items') return <ClosetItemsPage user={user} setUser={setUser} />;
    if (path === '/custom-try-on') return <CustomTryOnPage user={user} setUser={setUser} />;
    if (path === '/style-bot') return <StyleBotPage user={user} setUser={setUser} />;
    if (path === '/tokens') return <TokenPage user={user} setUser={setUser} />;
    if (path === '/profile') return <ProfilePage user={user} setUser={setUser} />;
    if (productMatch) return <ProductPage id={decodeURIComponent(productMatch[1])} user={user} setUser={setUser} />;
    if ((path === '/signup' || path === '/login') && user) return <SearchPage user={user} setUser={setUser} />;
    if (path === '/signup') return <AuthPage mode="signup" setUser={setUser} />;
    if (path === '/login') return <AuthPage mode="login" setUser={setUser} />;
    if (path === '/how-it-works') return <HowItWorks user={user} />;
    if (policyPages[path]) return <PolicyPage meta={pageMeta[path]} policy={policyPages[path]} user={user} />;
    if (pageMeta[path]) return <InfoPage meta={pageMeta[path]} user={user} />;
    return <InfoPage meta={['Not Found', 'This page is not available yet.', 'Use the navigation to continue shopping with FitLook.', 'hero2.png']} user={user} ctaLabel="Back to Shop" ctaHref="/search" />;
  }, [path, user]);

  return (
    <>
      <Header user={user} setUser={setUser} />
      {page}
      <div className="floating-actions" aria-label="FitLook quick actions">
        <a className="floating-action closet" href="/closet" aria-label="Open AI closet"><span>CL</span><strong><small>Your wardrobe</small>AI Closet</strong></a>
        <a className="floating-action style" href="/style-bot" aria-label="Open style bot"><span><SearchIcon /></span><strong><small>Ask for a look</small>Style Bot</strong></a>
        <a className="floating-action custom" href="/custom-try-on" aria-label="Custom clothing try-on"><span>AI</span><strong><small>Upload clothing</small>Custom Try-On</strong></a>
      </div>
      <Footer />
    </>
  );
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

function UserIcon() {
  return <svg viewBox="0 0 24 24"><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>;
}

function HeartIcon() {
  return <svg viewBox="0 0 24 24"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" /></svg>;
}

function FullscreenIcon() {
  return <svg viewBox="0 0 24 24"><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M21 16v5h-5" /><path d="M8 21H3v-5" /></svg>;
}

function MenuIcon() {
  return <svg viewBox="0 0 24 24"><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
}

export default App;
