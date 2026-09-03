const SERPAPI_AMAZON_ENDPOINT = 'https://serpapi.com/search.json';
const DEFAULT_AMAZON_DOMAIN = 'amazon.in';

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function positiveNumber(value) {
  if (value && typeof value === 'object') {
    return positiveNumber(value.extracted_value ?? value.value ?? value.raw);
  }
  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    value = match?.[0];
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function nonNegativeNumber(value) {
  if (value && typeof value === 'object') {
    return nonNegativeNumber(value.extracted_value ?? value.value ?? value.raw);
  }
  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    value = match?.[0];
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeAmazonDomain(value = DEFAULT_AMAZON_DOMAIN) {
  const candidate = cleanText(value).toLowerCase() || DEFAULT_AMAZON_DOMAIN;
  try {
    const hostname = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname;
    return hostname.replace(/^www\./, '') || DEFAULT_AMAZON_DOMAIN;
  } catch {
    return DEFAULT_AMAZON_DOMAIN;
  }
}

function resultAsin(result = {}) {
  const explicit = cleanText(result.asin).toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(explicit)) return explicit;
  const link = cleanText(result.link_clean || result.link || result.product_link);
  return link.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)?/i)?.[1]?.toUpperCase() || '';
}

function currencyFromResult(result = {}, amazonDomain = DEFAULT_AMAZON_DOMAIN) {
  const explicit = cleanText(result.currency || result.price?.currency || result.price_currency).toUpperCase();
  if (explicit) return explicit;
  const priceText = cleanText(result.price?.raw || result.price || result.old_price);
  if (/₹|\bINR\b|\bRs\.?\b/i.test(priceText) || amazonDomain === 'amazon.in') return 'INR';
  if (/£|\bGBP\b/i.test(priceText)) return 'GBP';
  if (/€|\bEUR\b/i.test(priceText)) return 'EUR';
  if (/\$|\bUSD\b/i.test(priceText)) return 'USD';
  return '';
}

function normalizeSerpApiAmazonResult(result = {}, { amazonDomain = DEFAULT_AMAZON_DOMAIN } = {}) {
  const domain = normalizeAmazonDomain(amazonDomain);
  const asin = resultAsin(result);
  if (!asin) return null;
  const price = positiveNumber(result.extracted_price ?? result.price);
  const compareAtPrice = positiveNumber(
    result.extracted_old_price ?? result.extracted_original_price ?? result.old_price ?? result.original_price
  );

  return {
    provider: 'serpapi',
    asin,
    link: `https://www.${domain}/dp/${asin}`,
    name: cleanText(result.title || result.name),
    brand: cleanText(result.brand || result.manufacturer),
    description: cleanText(result.description || result.snippet),
    price,
    compareAtPrice: compareAtPrice && compareAtPrice > (price || 0) ? compareAtPrice : undefined,
    currency: currencyFromResult(result, domain),
    rating: nonNegativeNumber(result.rating),
    ratingCount: nonNegativeNumber(result.reviews ?? result.ratings ?? result.review_count),
    remoteImageUrl: cleanText(result.thumbnail || result.image || result.image_url)
  };
}

function catalogSearchProviderName(env = process.env) {
  const configured = cleanText(env.CATALOG_SEARCH_PROVIDER).toLowerCase();
  if (configured) return configured;
  return cleanText(env.SERPAPI_API_KEY) ? 'serpapi' : 'amazon-html';
}

async function searchSerpApiAmazon(query, { page = 1, env = process.env, fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const apiKey = cleanText(env.SERPAPI_API_KEY);
  if (!apiKey) throw new Error('SERPAPI_API_KEY is required for SerpApi catalog search');
  const amazonDomain = normalizeAmazonDomain(env.SERPAPI_AMAZON_DOMAIN || env.AMAZON_MARKETPLACE);
  const params = new URLSearchParams({
    engine: 'amazon',
    amazon_domain: amazonDomain,
    k: cleanText(query),
    page: String(Math.max(1, Number(page) || 1)),
    api_key: apiKey
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${SERPAPI_AMAZON_ENDPOINT}?${params}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('SerpApi catalog search timed out');
    throw new Error('Could not connect to SerpApi catalog search');
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`SerpApi catalog search returned HTTP ${response.status} with an invalid response`);
  }
  if (!response.ok || payload?.error) {
    const detail = cleanText(payload?.error);
    throw new Error(detail ? `SerpApi catalog search failed: ${detail}` : `SerpApi catalog search returned HTTP ${response.status}`);
  }

  const rawResults = [
    ...(Array.isArray(payload.organic_results) ? payload.organic_results : []),
    ...(Array.isArray(payload.sponsored_results) ? payload.sponsored_results : [])
  ];
  const seen = new Set();
  return rawResults
    .map((result) => normalizeSerpApiAmazonResult(result, { amazonDomain }))
    .filter((result) => {
      if (!result || seen.has(result.asin)) return false;
      seen.add(result.asin);
      return true;
    });
}

export {
  catalogSearchProviderName,
  normalizeAmazonDomain,
  normalizeSerpApiAmazonResult,
  searchSerpApiAmazon
};
