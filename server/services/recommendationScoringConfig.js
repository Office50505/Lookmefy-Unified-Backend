const DEFAULT_SCORING_PROFILE_ID = 'balanced-v1';
const DEFAULT_COMPONENT_WEIGHTS = {
  category: 1,
  brand: 1,
  genderHistory: 1,
  tags: 1,
  colors: 1,
  garmentPlacement: 1,
  occasion: 1,
  formality: 1,
  priceBand: 1,
  explicitGender: 1,
  price: 1,
  quality: 1,
  freshness: 1,
  avoid: 1,
  exposure: 1
};

const SURFACE_SCORING_PROFILES = {
  for_you: { id: 'for-you-balanced-v1', componentWeights: {} },
  home: { id: 'home-balanced-v1', componentWeights: {} },
  explore: { id: 'explore-balanced-v1', componentWeights: {} },
  complete_the_look: { id: 'complete-look-balanced-v1', componentWeights: {} },
  from_your_wardrobe: { id: 'wardrobe-balanced-v1', componentWeights: {} },
  wishlist_next: { id: 'wishlist-balanced-v1', componentWeights: {} },
  tryon_next: { id: 'tryon-balanced-v1', componentWeights: {} },
  ai_studio_search: { id: 'ai-studio-balanced-v1', componentWeights: {} },
  cold_start: { id: 'cold-start-balanced-v1', componentWeights: {} }
};

const CLIENT_SCORING_PROFILES = {
  web: { id: 'web', componentWeights: {} },
  ios: { id: 'app-ios', componentWeights: {} },
  android: { id: 'app-android', componentWeights: {} },
  admin: { id: 'admin', componentWeights: {} },
  unknown: { id: 'unknown-client', componentWeights: {} }
};

function boundedComponentWeight(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(4, number));
}

function normalizeComponentWeights(...sources) {
  const weights = { ...DEFAULT_COMPONENT_WEIGHTS };
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(DEFAULT_COMPONENT_WEIGHTS)) {
      if (source[key] === undefined) continue;
      weights[key] = boundedComponentWeight(source[key], weights[key]);
    }
  }
  return weights;
}

function scoringConfigForContext({ surface = 'for_you', client = 'unknown' } = {}) {
  const normalizedSurface = SURFACE_SCORING_PROFILES[surface] ? surface : 'for_you';
  const normalizedClient = CLIENT_SCORING_PROFILES[client] ? client : 'unknown';
  const surfaceProfile = SURFACE_SCORING_PROFILES[normalizedSurface];
  const clientProfile = CLIENT_SCORING_PROFILES[normalizedClient];
  return {
    id: `${surfaceProfile.id}:${clientProfile.id}`,
    surface: normalizedSurface,
    client: normalizedClient,
    componentWeights: normalizeComponentWeights(
      surfaceProfile.componentWeights,
      clientProfile.componentWeights
    )
  };
}

function applyScoringConfig(components = {}, scoringConfig = {}) {
  const weights = normalizeComponentWeights(scoringConfig.componentWeights);
  return Object.fromEntries(Object.entries(components).map(([key, value]) => [
    key,
    Number(value || 0) * (weights[key] ?? 1)
  ]));
}

export {
  DEFAULT_COMPONENT_WEIGHTS,
  DEFAULT_SCORING_PROFILE_ID,
  applyScoringConfig,
  boundedComponentWeight,
  normalizeComponentWeights,
  scoringConfigForContext
};
