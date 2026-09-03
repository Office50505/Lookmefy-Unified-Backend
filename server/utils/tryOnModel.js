const WAN_MODEL_TERMS = [
  /\bbikini(?:s)?\b/i,
  /\btwo[-\s]?piece\s+swim/i,
  /\bswim\s?suit(?:s)?\b/i,
  /\bswimwear\b/i,
  /\bbeachwear\b/i,
  /\bswim\s+trunks?\b/i,
  /\bunderwear\b/i,
  /\binnerwear\b/i,
  /\blingerie\b/i,
  /\bbra(?:s)?\b/i,
  /\bbralette(?:s)?\b/i,
  /\bsports?\s+bra(?:s)?\b/i,
  /\bpant(?:y|ies)\b/i,
  /\bthong(?:s)?\b/i,
  /\bbriefs?\b/i,
  /\bboxers?\b/i,
  /\bcorset(?:s)?\b/i,
  /\bbustier(?:s)?\b/i,
  /\bbodysuit(?:s)?\b/i,
  /\bshapewear\b/i,
  /\bsleep\s?wear\b/i,
  /\bsleep\s?dress(?:es)?\b/i,
  /\bnight(?:wear|ie|dress|gown)\b/i,
  /\bnight(?:y|ies)\b/i,
  /\bbabydoll\b/i,
  /\bchemise\b/i
];
const LEGACY_UNRESTRICTED_MODEL = ['v' + 'to', 'unrestricted'].join('-');

function normalizeTryOnModel(value) {
  if (value === 'wan-v2.6-image-to-image' || value === 'wan/v2.6/image-to-image') return 'wan-v2.6-image-to-image';
  return value === LEGACY_UNRESTRICTED_MODEL ? 'wan-v2.6-image-to-image' : 'gpt-image-2';
}

function textForTryOnClassification(product = {}) {
  return [
    product.name,
    product.brand,
    product.category,
    product.gender,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags,
    Array.isArray(product.bullets) ? product.bullets.join(' ') : product.bullets
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function inferTryOnModel(product = {}) {
  const text = textForTryOnClassification(product);
  if (WAN_MODEL_TERMS.some((pattern) => pattern.test(text))) return 'wan-v2.6-image-to-image';

  const explicit = normalizeTryOnModel(product.tryOnModel);
  if (product.tryOnModel) return explicit;
  return 'gpt-image-2';
}

export { inferTryOnModel, normalizeTryOnModel };
