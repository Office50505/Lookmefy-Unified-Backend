const RECOMMENDATION_SURFACES = new Set([
  'for_you',
  'home',
  'explore',
  'similar',
  'complete_the_look',
  'from_your_wardrobe',
  'wishlist_next',
  'tryon_next',
  'ai_studio_search',
  'cold_start'
]);

const SURFACE_ALIASES = {
  foryou: 'for_you',
  for_you: 'for_you',
  recommendations: 'for_you',
  recommended: 'for_you',
  product: 'similar',
  product_detail: 'similar',
  product_details: 'similar',
  detail: 'similar',
  wardrobe: 'from_your_wardrobe',
  closet: 'from_your_wardrobe',
  from_wardrobe: 'from_your_wardrobe',
  wishlist: 'wishlist_next',
  tryon: 'tryon_next',
  try_on: 'tryon_next',
  ai_studio: 'ai_studio_search',
  stylist: 'ai_studio_search',
  new_user: 'cold_start'
};

const CLIENT_ALIASES = {
  browser: 'web',
  website: 'web',
  mobile_web: 'web',
  iphone: 'ios',
  ipad: 'ios',
  react_native_ios: 'ios',
  rn_ios: 'ios',
  react_native_android: 'android',
  rn_android: 'android',
  mobile: 'android',
  dashboard: 'admin'
};

function normalizeContextToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizeRecommendationSurface(value, fallback = 'for_you') {
  const normalizedFallback = RECOMMENDATION_SURFACES.has(fallback) ? fallback : 'for_you';
  const token = normalizeContextToken(value);
  if (!token) return normalizedFallback;
  const aliased = SURFACE_ALIASES[token] || token;
  return RECOMMENDATION_SURFACES.has(aliased) ? aliased : normalizedFallback;
}

function normalizeRecommendationClient(value) {
  const token = normalizeContextToken(value);
  if (!token) return 'unknown';
  const aliased = CLIENT_ALIASES[token] || token;
  return ['web', 'ios', 'android', 'admin'].includes(aliased) ? aliased : 'unknown';
}

function buildRecommendationContext({ query = {}, body = {}, headers = {}, defaultSurface = 'for_you' } = {}) {
  const surface = normalizeRecommendationSurface(body.surface || query.surface, defaultSurface);
  const client = normalizeRecommendationClient(
    body.client
      || body.platform
      || query.client
      || query.platform
      || headers['x-lookmefy-client']
      || headers['x-client-platform']
  );
  return { surface, client };
}

export {
  RECOMMENDATION_SURFACES,
  buildRecommendationContext,
  normalizeRecommendationClient,
  normalizeRecommendationSurface
};
