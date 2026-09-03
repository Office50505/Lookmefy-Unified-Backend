import { buildProductDraft } from '../routes/products.js';

const DEFAULT_MARKETPLACE = 'www.amazon.in';
const DEFAULT_ASSOCIATE_TAG = '';

function safeUrl(value, base = `https://${DEFAULT_MARKETPLACE}`) {
  if (!value) return null;
  try {
    return new URL(String(value).trim(), base);
  } catch {
    return null;
  }
}

function extractAsin(value) {
  const text = String(value || '');
  const url = safeUrl(text);
  const pathname = url?.pathname || text;
  const match = pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)?/i);
  return match?.[1]?.toUpperCase() || '';
}

function canonicalAmazonUrl(value, marketplace = DEFAULT_MARKETPLACE) {
  const asin = extractAsin(value);
  if (!asin) return '';
  return `https://${marketplace}/dp/${asin}`;
}

function withAssociateTag(value, associateTag = DEFAULT_ASSOCIATE_TAG, marketplace = DEFAULT_MARKETPLACE) {
  const canonical = canonicalAmazonUrl(value, marketplace);
  if (!canonical) return '';
  const url = new URL(canonical);
  if (associateTag) url.searchParams.set('tag', associateTag);
  return url.toString();
}

function createUrlManifestProvider(options = {}) {
  const marketplace = options.marketplace || process.env.AMAZON_MARKETPLACE || DEFAULT_MARKETPLACE;
  const associateTag = options.associateTag || process.env.AMAZON_ASSOCIATE_TAG || DEFAULT_ASSOCIATE_TAG;
  const draftBuilder = options.buildProductDraft || buildProductDraft;

  return {
    name: 'url-manifest',
    async getProduct(entry) {
      const rawUrl = entry.affiliateLink || entry.sourceUrl;
      const asin = extractAsin(rawUrl);
      if (!asin) throw new Error('Amazon ASIN is missing from URL');
      const sourceUrl = canonicalAmazonUrl(rawUrl, marketplace);
      const affiliateLink = withAssociateTag(rawUrl, associateTag, marketplace);
      const draft = await draftBuilder(affiliateLink);
      return {
        ...draft,
        sourceUrl,
        affiliateLink,
        sourceProvider: 'amazon',
        sourceProductId: asin
      };
    }
  };
}

function createAmazonApiProvider() {
  const required = ['AMAZON_API_ACCESS_KEY', 'AMAZON_API_SECRET_KEY', 'AMAZON_ASSOCIATE_TAG'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    return {
      name: 'amazon-api',
      disabled: true,
      async getProducts() {
        throw new Error(`Official Amazon API provider is disabled. Add ${missing.join(', ')} or use URL manifest mode.`);
      }
    };
  }

  return {
    name: 'amazon-api',
    disabled: true,
    async getProducts() {
      throw new Error('Official Amazon API provider is prepared but not implemented until valid API access is available.');
    }
  };
}

export {
  canonicalAmazonUrl,
  createAmazonApiProvider,
  createUrlManifestProvider,
  extractAsin,
  withAssociateTag
};
