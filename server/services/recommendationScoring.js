import { buildRecommendationReasons } from './recommendationReasons.js';
import { applyScoringConfig } from './recommendationScoringConfig.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_EVENT_WINDOW_DAYS = 90;
const RECENT_EVENT_HALF_LIFE_DAYS = 14;
const RECOMMENDATION_ALGORITHM_VERSION = 'hybrid-v2';
const SIMILAR_ALGORITHM_VERSION = 'similar-v1';
const DIVERSITY_CATEGORY_PENALTY = 0.9;
const DIVERSITY_BRAND_PENALTY = 0.55;

const EVENT_WEIGHTS = {
  page_view: 0.1,
  search: 1,
  filter: 1.25,
  wishlist: 4,
  wishlist_remove: 0,
  product_view: 1.5,
  product_click: 2.5,
  recommendation_impression: 0,
  recommendation_click: 2.5,
  style_bot_query: 2,
  custom_tryon: 2,
  try_on: 6,
  shop_click: 8
};

const COLOR_WORDS = new Set([
  'black',
  'white',
  'grey',
  'gray',
  'red',
  'blue',
  'green',
  'yellow',
  'pink',
  'purple',
  'violet',
  'orange',
  'brown',
  'beige',
  'cream',
  'ivory',
  'navy',
  'maroon',
  'gold',
  'silver',
  'olive',
  'teal',
  'lavender',
  'coral',
  'tan',
  'khaki'
]);

const OCCASION_TERMS = {
  work: ['work', 'office', 'interview', 'meeting', 'business'],
  party: ['party', 'club', 'nightout', 'night_out', 'celebration'],
  wedding: ['wedding', 'reception', 'sangeet', 'mehendi', 'haldi', 'bridal'],
  festival: ['diwali', 'eid', 'holi', 'christmas', 'festival', 'festive'],
  date: ['date', 'dinner', 'romantic'],
  college: ['college', 'campus', 'freshers', 'farewell', 'prom'],
  travel: ['travel', 'vacation', 'holiday', 'airport', 'resort'],
  gym: ['gym', 'workout', 'training', 'athleisure'],
  beach: ['beach', 'pool', 'swim', 'swimwear', 'bikini'],
  daily: ['daily', 'everyday', 'casual', 'regular']
};

const FORMALITY_TERMS = {
  casual: ['casual', 'daily', 'everyday', 'relaxed', 'streetwear'],
  smart_casual: ['smartcasual', 'smart_casual', 'brunch', 'date', 'resort'],
  formal: ['formal', 'office', 'business', 'interview', 'meeting'],
  festive: ['festive', 'wedding', 'ethnic', 'diwali', 'eid', 'sangeet'],
  sporty: ['sporty', 'gym', 'workout', 'athleisure']
};

const GARMENT_PLACEMENT_TERMS = {
  top: ['shirt', 'shirts', 'top', 'tops', 'tshirt', 'tshirts', 'tee', 'blouse', 'jacket', 'blazer', 'coat', 'kurta'],
  bottom: ['pants', 'trouser', 'trousers', 'jeans', 'shorts', 'skirt', 'skirts', 'leggings', 'joggers', 'bottom'],
  accessory: ['watch', 'bag', 'belt', 'jewellery', 'jewelry', 'necklace', 'earrings', 'bracelet', 'sunglasses', 'shoes', 'sneaker', 'sandals'],
  full_body: ['dress', 'dresses', 'gown', 'jumpsuit', 'romper', 'saree', 'sari', 'lehenga', 'suit', 'outfit', 'set', 'co_ord', 'coord']
};

const STYLE_BOT_LEARNING_INTENTS = new Set([
  'both_product_sources',
  'both_outfit_sources',
  'outfit_recommendation',
  'outfit_revision',
  'product_search',
  'product_search_confirmed',
  'style_advice',
  'try_on_request',
  'wardrobe_outfit_check',
  'wardrobe_product_check'
]);

const STYLE_BOT_LEARNING_MODES = new Set([
  'hybrid_wardrobe_shopping',
  'outfit_revision',
  'product_search',
  'style_advice',
  'try_on_plan',
  'wardrobe_check',
  'wardrobe_first'
]);

const QUERY_STOP_WORDS = new Set([
  'about',
  'again',
  'catalog',
  'current',
  'find',
  'for',
  'give',
  'hello',
  'help',
  'hey',
  'hii',
  'hiii',
  'hiiii',
  'hio',
  'how',
  'lookmefy',
  'me',
  'online',
  'please',
  'recommend',
  'search',
  'show',
  'some',
  'suggest',
  'tell',
  'the',
  'thing',
  'things',
  'time',
  'today',
  'under',
  'weather',
  'what',
  'with',
  'would'
]);

function normalizeKey(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function normalizeGender(value = '') {
  const key = normalizeKey(value);
  if (['male', 'man', 'men', 'mens', 'men_s', 'boy', 'boys'].includes(key)) return 'male';
  if (['female', 'woman', 'women', 'womens', 'women_s', 'girl', 'girls'].includes(key)) return 'female';
  if (['unisex', 'all', 'any'].includes(key)) return 'unisex';
  return 'other';
}

function queryTerms(value = '') {
  return [...new Set((String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .map(normalizeKey)
    .filter(isUsefulQueryTerm))]
    .slice(0, 8);
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

function uniqueKeys(values = []) {
  return [...new Set(values.map(normalizeKey).filter(Boolean))];
}

function tokenSetFromText(value = '') {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function isUsefulQueryTerm(value = '') {
  const key = normalizeKey(value);
  if (key.length < 3) return false;
  if (QUERY_STOP_WORDS.has(key)) return false;
  if (/^\d+$/.test(key)) return false;
  if (/(.)\1{3,}/.test(key)) return false;
  if (/^[a-z]{12,}$/.test(key)) {
    const vowels = (key.match(/[aeiouy]/g) || []).length;
    if (vowels / key.length < 0.22) return false;
  }
  return true;
}

function shouldLearnFromQueryEvent({ type, query, metadata = {} } = {}) {
  if (!String(query || '').trim()) return false;
  if (type !== 'style_bot_query') return true;
  const intent = normalizeKey(metadata?.intent);
  const mode = normalizeKey(metadata?.mode);
  if (STYLE_BOT_LEARNING_INTENTS.has(intent) || STYLE_BOT_LEARNING_MODES.has(mode)) return true;
  return Number(metadata?.resultCount || 0) > 0 && mode !== 'chat_control';
}

function matchingSignalKeys(tokens, dictionary) {
  const matches = [];
  for (const [key, words] of Object.entries(dictionary)) {
    if (words.some((word) => tokens.has(normalizeKey(word)))) matches.push(key);
  }
  return matches;
}

function styleSignalsFromText(value = '') {
  const normalized = String(value || '').replace(/co-ords?/gi, 'co_ord');
  const tokens = tokenSetFromText(normalized);
  return {
    colors: [...tokens].filter((token) => COLOR_WORDS.has(token)),
    garmentPlacements: matchingSignalKeys(tokens, GARMENT_PLACEMENT_TERMS),
    occasions: matchingSignalKeys(tokens, OCCASION_TERMS),
    formalities: matchingSignalKeys(tokens, FORMALITY_TERMS)
  };
}

function priceBandForPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) return '';
  if (price < 500) return 'budget';
  if (price < 1500) return 'value';
  if (price < 5000) return 'mid';
  if (price < 15000) return 'premium';
  return 'luxury';
}

function normalizedGarmentPlacement(value = '') {
  const key = normalizeKey(value);
  if (key === 'full_body') return 'full_body';
  if (['top', 'bottom', 'accessory'].includes(key)) return key;
  return '';
}

function productStyleSignals(product = {}) {
  const text = [
    product.name,
    product.category,
    product.description,
    ...listValues(product.tags),
    ...listValues(product.colors)
  ].filter(Boolean).join(' ');
  const textSignals = styleSignalsFromText(text);
  const placement = normalizedGarmentPlacement(product.garmentPlacement);
  const priceBand = priceBandForPrice(product.price);
  return {
    colors: uniqueKeys([...listValues(product.colors), ...textSignals.colors]),
    garmentPlacements: uniqueKeys([placement, ...textSignals.garmentPlacements]),
    occasions: uniqueKeys(textSignals.occasions),
    formalities: uniqueKeys(textSignals.formalities),
    priceBands: uniqueKeys([priceBand])
  };
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

function preferenceValue(map, key) {
  if (!map || !key) return 0;
  return map.get?.(key) || map[key] || 0;
}

function genderSignalValue(map, gender) {
  const normalized = normalizeGender(gender);
  const aliases = {
    male: ['male', 'man', 'men', 'mens', 'men_s', 'boy', 'boys'],
    female: ['female', 'woman', 'women', 'womens', 'women_s', 'girl', 'girls'],
    unisex: ['unisex', 'all', 'any'],
    other: ['other']
  };
  return aliases[normalized].reduce((sum, key) => sum + Number(preferenceValue(map, key) || 0), 0);
}

function eventWeight(type) {
  return EVENT_WEIGHTS[type] ?? 1;
}

function addProfileValue(map, value, weight) {
  const key = normalizeKey(value);
  if (!key || !Number.isFinite(weight) || weight <= 0) return false;
  map.set(key, (map.get(key) || 0) + weight);
  return true;
}

function productId(value) {
  const id = value?._id ?? value;
  if (!id) return '';
  return typeof id === 'string' ? id : id.toString?.() || '';
}

function createRecentProfile() {
  return {
    categories: new Map(),
    brands: new Map(),
    genders: new Map(),
    tags: new Map(),
    colors: new Map(),
    garmentPlacements: new Map(),
    occasions: new Map(),
    formalities: new Map(),
    priceBands: new Map(),
    productExposure: new Map(),
    priceTotal: 0,
    priceCount: 0,
    signalCount: 0
  };
}

function buildRecentProfile(events = [], now = new Date()) {
  const profile = createRecentProfile();
  const nowMs = new Date(now).getTime();
  const exposureScales = { product_view: 0.8, product_click: 1, wishlist: 0.15, try_on: 0.1 };

  for (const event of events) {
    const createdAtMs = new Date(event.createdAt || now).getTime();
    const ageDays = Math.max(0, (nowMs - createdAtMs) / DAY_MS);
    if (!Number.isFinite(createdAtMs) || ageDays > RECENT_EVENT_WINDOW_DAYS) continue;

    const weight = eventWeight(event.type) * Math.pow(0.5, ageDays / RECENT_EVENT_HALF_LIFE_DAYS);
    if (weight <= 0) continue;
    const source = event.product || event.metadata?.product || event.metadata || {};
    let contributed = false;
    contributed = addProfileValue(profile.categories, source.category, weight) || contributed;
    contributed = addProfileValue(profile.brands, source.brand, weight * 0.75) || contributed;
    const gender = normalizeGender(source.gender);
    contributed = addProfileValue(profile.genders, gender === 'other' ? source.gender : gender, weight * 0.8) || contributed;
    for (const tag of listValues(source.tags).slice(0, 10)) {
      contributed = addProfileValue(profile.tags, tag, weight * 0.7) || contributed;
    }
    const sourceSignals = productStyleSignals(source);
    const learnQuery = shouldLearnFromQueryEvent(event);
    for (const term of learnQuery ? queryTerms(event.query) : []) {
      contributed = addProfileValue(profile.tags, term, weight) || contributed;
    }
    const querySignals = learnQuery ? styleSignalsFromText(event.query) : styleSignalsFromText('');
    for (const color of [...sourceSignals.colors, ...querySignals.colors]) {
      contributed = addProfileValue(profile.colors, color, weight * 0.75) || contributed;
    }
    for (const placement of [...sourceSignals.garmentPlacements, ...querySignals.garmentPlacements]) {
      contributed = addProfileValue(profile.garmentPlacements, placement, weight * 0.65) || contributed;
    }
    for (const occasion of [...sourceSignals.occasions, ...querySignals.occasions]) {
      contributed = addProfileValue(profile.occasions, occasion, weight * 0.85) || contributed;
    }
    for (const formality of [...sourceSignals.formalities, ...querySignals.formalities]) {
      contributed = addProfileValue(profile.formalities, formality, weight * 0.75) || contributed;
    }
    for (const priceBand of sourceSignals.priceBands) {
      contributed = addProfileValue(profile.priceBands, priceBand, weight * 0.45) || contributed;
    }

    const price = Number(source.price);
    if (Number.isFinite(price) && price >= 0) {
      profile.priceTotal += price * weight;
      profile.priceCount += weight;
      contributed = true;
    }

    const id = productId(event.product);
    const exposureScale = exposureScales[event.type] || 0;
    if (id && exposureScale) {
      profile.productExposure.set(id, (profile.productExposure.get(id) || 0) + weight * exposureScale);
    }
    if (contributed) profile.signalCount += 1;
  }

  return profile;
}

function boundedSignal(value) {
  return Math.log1p(Math.max(0, Number(value) || 0));
}

function ratingQuality(product) {
  const rating = Math.min(5, Math.max(0, Number(product.rating) || 0));
  const ratingCount = Math.max(0, Number(product.ratingCount) || 0);
  const priorRating = 4.1;
  const priorCount = 20;
  const bayesianRating = ((rating * ratingCount) + (priorRating * priorCount)) / (ratingCount + priorCount);
  return Math.max(0, Math.min(1.6, ((bayesianRating - 3) / 2) * 1.6));
}

function freshnessQuality(product, now) {
  const createdAtMs = new Date(product.createdAt || 0).getTime();
  const ageDays = Number.isFinite(createdAtMs) && createdAtMs > 0
    ? Math.max(0, (new Date(now).getTime() - createdAtMs) / DAY_MS)
    : Number.POSITIVE_INFINITY;
  const ageBoost = Number.isFinite(ageDays) ? Math.exp(-ageDays / 45) * 0.65 : 0;
  return ageBoost + (product.isNewArrival ? 0.55 : 0) + (product.isFeatured ? 0.35 : 0);
}

function blendedPrice(preference, recentProfile) {
  const longTermPrice = Number(preference?.priceCount) > 0
    ? Number(preference.priceTotal) / Number(preference.priceCount)
    : 0;
  const recentPrice = Number(recentProfile?.priceCount) > 0
    ? Number(recentProfile.priceTotal) / Number(recentProfile.priceCount)
    : 0;
  if (longTermPrice && recentPrice) return (recentPrice * 0.7) + (longTermPrice * 0.3);
  return recentPrice || longTermPrice;
}

function productStyleKeys(product) {
  const values = [
    ...listValues(product.tags),
    ...queryTerms([product.name, product.category, product.brand].filter(Boolean).join(' '))
  ];
  return [...new Set(values.map(normalizeKey).filter(Boolean))].slice(0, 20);
}

function multiSignalScore(keys, preferenceMap, recentMap, preferenceScale, recentScale, maxMatches = 4) {
  return uniqueKeys(keys)
    .map((key) => (
      (boundedSignal(preferenceValue(preferenceMap, key)) * preferenceScale)
      + (boundedSignal(preferenceValue(recentMap, key)) * recentScale)
    ))
    .sort((a, b) => b - a)
    .slice(0, maxMatches)
    .reduce((sum, value) => sum + value, 0);
}

function avoidSignalScore(product, preference = {}) {
  const styleSignals = productStyleSignals(product);
  const tagKeys = productStyleKeys(product);
  const total = (
    (boundedSignal(preferenceValue(preference.avoidCategories, normalizeKey(product.category))) * 2.4)
    + (boundedSignal(preferenceValue(preference.avoidBrands, normalizeKey(product.brand))) * 1.15)
    + (boundedSignal(genderSignalValue(preference.avoidGenders, product.gender)) * 1.15)
    + multiSignalScore(tagKeys, preference.avoidTags, null, 0.9, 0, 4)
    + multiSignalScore(styleSignals.colors, preference.avoidColors, null, 0.85, 0, 3)
    + multiSignalScore(styleSignals.garmentPlacements, preference.avoidGarmentPlacements, null, 0.75, 0, 2)
    + multiSignalScore(styleSignals.occasions, preference.avoidOccasions, null, 0.75, 0, 3)
    + multiSignalScore(styleSignals.formalities, preference.avoidFormalities, null, 0.65, 0, 2)
    + multiSignalScore(styleSignals.priceBands, preference.avoidPriceBands, null, 0.5, 0, 1)
  );
  return -Math.min(8, total);
}

function scoreProduct(product, { preference, recentProfile = createRecentProfile(), genderPreference = 'other', scoringConfig, now = new Date() } = {}) {
  const category = normalizeKey(product.category);
  const brand = normalizeKey(product.brand);
  const gender = normalizeGender(product.gender);
  const components = {
    category: (boundedSignal(preferenceValue(preference?.categories, category)) * 2.4)
      + (boundedSignal(preferenceValue(recentProfile.categories, category)) * 3.4),
    brand: (boundedSignal(preferenceValue(preference?.brands, brand)) * 1.15)
      + (boundedSignal(preferenceValue(recentProfile.brands, brand)) * 1.7),
    genderHistory: (boundedSignal(genderSignalValue(preference?.genders, gender)) * 1.35)
      + (boundedSignal(genderSignalValue(recentProfile.genders, gender)) * 1.8),
    tags: 0,
    colors: 0,
    garmentPlacement: 0,
    occasion: 0,
    formality: 0,
    priceBand: 0,
    explicitGender: 0,
    price: 0,
    quality: ratingQuality(product),
    freshness: freshnessQuality(product, now),
    avoid: 0,
    exposure: 0
  };

  const tagMatches = productStyleKeys(product).map((key) => (
    (boundedSignal(preferenceValue(preference?.tags, key)) * 0.65)
      + (boundedSignal(preferenceValue(recentProfile.tags, key)) * 1.05)
  ));
  components.tags = tagMatches.sort((a, b) => b - a).slice(0, 4).reduce((sum, value) => sum + value, 0);
  const styleSignals = productStyleSignals(product);
  components.colors = multiSignalScore(styleSignals.colors, preference?.colors, recentProfile.colors, 0.9, 1.25, 3);
  components.garmentPlacement = multiSignalScore(styleSignals.garmentPlacements, preference?.garmentPlacements, recentProfile.garmentPlacements, 0.8, 1.15, 2);
  components.occasion = multiSignalScore(styleSignals.occasions, preference?.occasions, recentProfile.occasions, 0.95, 1.35, 3);
  components.formality = multiSignalScore(styleSignals.formalities, preference?.formalities, recentProfile.formalities, 0.8, 1.05, 2);
  components.priceBand = multiSignalScore(styleSignals.priceBands, preference?.priceBands, recentProfile.priceBands, 0.55, 0.75, 1);

  const preferredGender = normalizeGender(genderPreference);
  if (preferredGender === 'male' || preferredGender === 'female') {
    if (gender === preferredGender) components.explicitGender = 2.3;
    else if (gender === 'unisex' || gender === 'other') components.explicitGender = 0.75;
    else components.explicitGender = -2.75;
  }

  const preferredPrice = blendedPrice(preference, recentProfile);
  const price = Number(product.price);
  if (preferredPrice > 0 && Number.isFinite(price) && price > 0) {
    components.price = Math.exp(-Math.abs(Math.log(price / preferredPrice)) * 1.6) * 1.8;
  }

  components.exposure = -Math.min(2.4, boundedSignal(preferenceValue(recentProfile.productExposure, productId(product))) * 1.35);
  components.avoid = avoidSignalScore(product, preference);
  const scoredComponents = applyScoringConfig(components, scoringConfig);
  const score = Object.values(scoredComponents).reduce((sum, value) => sum + value, 0);
  const reasons = buildRecommendationReasons(scoredComponents);

  return { score, components: scoredComponents, reasons };
}

function compareScoredProducts(a, b) {
  return b.score - a.score
    || Number(b.product.ratingCount || 0) - Number(a.product.ratingCount || 0)
    || Number(b.product.rating || 0) - Number(a.product.rating || 0)
    || new Date(b.product.createdAt || 0).getTime() - new Date(a.product.createdAt || 0).getTime()
    || productId(a.product).localeCompare(productId(b.product));
}

function rerankDiverse(scoredProducts, limit) {
  const remaining = [...scoredProducts].sort(compareScoredProducts);
  const selected = [];
  const categoryCounts = new Map();
  const brandCounts = new Map();

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const category = normalizeKey(candidate.product.category);
      const brand = normalizeKey(candidate.product.brand);
      const adjustedScore = candidate.score
        - ((categoryCounts.get(category) || 0) * DIVERSITY_CATEGORY_PENALTY)
        - ((brandCounts.get(brand) || 0) * DIVERSITY_BRAND_PENALTY);
      if (adjustedScore > bestAdjustedScore
        || (adjustedScore === bestAdjustedScore && compareScoredProducts(candidate, remaining[bestIndex]) < 0)) {
        bestIndex = index;
        bestAdjustedScore = adjustedScore;
      }
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push({ ...chosen, rankScore: bestAdjustedScore });
    const category = normalizeKey(chosen.product.category);
    const brand = normalizeKey(chosen.product.brand);
    if (category) categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    if (brand) brandCounts.set(brand, (brandCounts.get(brand) || 0) + 1);
  }

  return selected;
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

export {
  DAY_MS,
  EVENT_WEIGHTS,
  RECENT_EVENT_WINDOW_DAYS,
  RECENT_EVENT_HALF_LIFE_DAYS,
  RECOMMENDATION_ALGORITHM_VERSION,
  SIMILAR_ALGORITHM_VERSION,
  boundedLimit,
  buildRecentProfile,
  createRecentProfile,
  eventWeight,
  isUsefulQueryTerm,
  listValues,
  normalizeGender,
  normalizeKey,
  priceBandForPrice,
  productStyleSignals,
  queryTerms,
  ratingQuality,
  rerankDiverse,
  scoreProduct,
  similarScore,
  shouldLearnFromQueryEvent,
  styleSignalsFromText
};
