import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Product from '../models/Product.js';
import { inferTryOnModel } from '../utils/tryOnModel.js';
import { clearReadCachesAfterProductWrite } from '../routes/products.js';
import {
  canonicalAmazonUrl,
  createAmazonApiProvider,
  createUrlManifestProvider,
  extractAsin,
  withAssociateTag
} from './amazon-product-provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DEFAULT_TAXONOMY_PATH = path.join(ROOT_DIR, 'config/clothing-categories.json');
const DEFAULT_REPORTS_DIR = path.join(ROOT_DIR, 'reports');
const REPLACE_CONFIRMATION = 'REPLACE_ACTIVE_CATALOG';

const ACCESSORY_PATTERN = /\b(bags?|handbags?|backpacks?|wallets?|purses?|jewellery|jewelry|watches?|belts?|sunglasses|eyewear|caps?|hats?|scarves?|ties?|bow\s*ties?|gloves?|socks?|shoes?|sandals?|slippers?|footwear|cosmetics?|perfumes?|electronics?|toys?|home|stationery|fabric\s*only|mannequins?|costume\s+accessor(?:y|ies))\b/i;
const CLOTHING_PATTERN = /\b(cloth(?:e|es|ing)?|garments?|apparel|shirts?|t\s*-?\s*shirts?|tops?|blouses?|tunics?|kurtas?|kurtis?|sarees?|lehengas?|dress(?:es)?|gowns?|jumpsuits?|co-ords?|jeans?|trousers?|pants?|chinos?|joggers?|leggings?|palazzos?|skirts?|shorts?|hoodies?|sweatshirts?|sweaters?|jackets?|blazers?|suits?|sherwanis?|dhotis?|lungis?|pajamas?|pyjamas?|night(?:ies|y|wear|suits?)|vests?|briefs?|trunks?|boxers?|bras?|panties|lingerie|camisoles?|slips?|shapewear|swimwear|bikinis?)\b/i;
const BOTTOM_PATTERN = /\b(jeans?|trousers?|chinos?|cargo\s+pants?|joggers?|track\s+pants?|shorts?|skirts?|leggings?|palazzos?|pajama\s+bottoms?|pyjama\s+bottoms?|dhotis?|lungis?)\b/i;
const FULL_BODY_PATTERN = /\b(dress(?:es)?|sarees?|gowns?|jumpsuits?|nighties|suits?|co-ord\s+sets?|kurta\s+sets?|salwar\s+suits?|lehengas?|sherwanis?)\b/i;
const UNAVAILABLE_PATTERN = /\b(currently\s+unavailable|out\s+of\s+stock|temporarily\s+unavailable|not\s+available)\b/i;

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(compact).filter(Boolean);
  return compact(value).split(',').map(compact).filter(Boolean);
}

function normalizeKey(value) {
  return compact(value).toLowerCase();
}

function normalizeGender(value) {
  const gender = normalizeKey(value);
  if (gender === 'man' || gender === 'male' || gender === 'men') return 'men';
  if (gender === 'woman' || gender === 'female' || gender === 'women') return 'women';
  return '';
}

function productText(product = {}) {
  return [
    product.name,
    product.brand,
    product.category,
    product.gender,
    product.description,
    ...(product.tags || [])
  ].map(compact).filter(Boolean).join(' ');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      if (row.some((item) => compact(item))) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((item) => compact(item))) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => compact(header));
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, compact(values[index])])));
}

async function readManifest(inputPath) {
  if (!inputPath) throw new Error('Manifest input is required. Pass --input data/products.csv');
  const absolutePath = path.resolve(ROOT_DIR, inputPath);
  const text = await fs.readFile(absolutePath, 'utf8');
  if (inputPath.endsWith('.json')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.products || [];
  }
  return parseCsv(text);
}

async function readTaxonomy(taxonomyPath = DEFAULT_TAXONOMY_PATH) {
  const parsed = JSON.parse(await fs.readFile(taxonomyPath, 'utf8'));
  return parsed;
}

function categoryMapFor(taxonomy, gender) {
  const categories = taxonomy?.genders?.[gender]?.categories || [];
  return new Map(categories.map((category) => [normalizeKey(category), category]));
}

function normalizeCategoryForGender(category, gender, taxonomy) {
  const map = categoryMapFor(taxonomy, gender);
  return map.get(normalizeKey(category)) || '';
}

function inferPlacement(product = {}) {
  const explicit = normalizeKey(product.garmentPlacement);
  if (explicit === 'bottom' || explicit === 'top' || explicit === 'accessory' || explicit === 'full-body') return explicit;
  const text = productText(product);
  if (FULL_BODY_PATTERN.test(text)) return 'full-body';
  if (BOTTOM_PATTERN.test(text)) return 'bottom';
  return 'top';
}

function isFullBody(product = {}) {
  return FULL_BODY_PATTERN.test(`${product.category || ''} ${product.name || ''}`);
}

function sanitizeError(error) {
  return compact(error?.message || error || 'Unknown error')
    .replace(/mongodb(\+srv)?:\/\/[^@]+@/gi, 'mongodb$1://[redacted]@')
    .replace(/(MASTER_ADMIN_PASSWORD|MONGODB_URI|AMAZON_API_SECRET_KEY)=\S+/gi, '$1=[redacted]');
}

function validateAndBuildProduct(draft, entry, context = {}) {
  const taxonomy = context.taxonomy;
  const asin = draft.sourceProductId || extractAsin(draft.sourceUrl || draft.affiliateLink || entry.sourceUrl || entry.affiliateLink);
  const expectedGender = normalizeGender(entry.expectedGender || draft.gender);
  const draftGender = normalizeGender(draft.gender);
  const gender = expectedGender || draftGender;
  const category = normalizeCategoryForGender(entry.expectedCategory || draft.category, gender, taxonomy);
  const text = productText({ ...draft, category, tags: [...splitList(entry.tags), ...(draft.tags || [])] });
  const imageUrl = compact(draft.remoteImageUrl || draft.image?.remoteUrl);
  const price = Number(draft.price);
  const compareAtPrice = Number(draft.compareAtPrice);
  const errors = [];

  if (!asin) errors.push('ASIN is missing');
  if (!compact(draft.name)) errors.push('Name is missing');
  if (!compact(draft.brand)) errors.push('Brand is missing');
  if (!category) errors.push('Category is missing or not enabled for gender');
  if (!gender) errors.push('Gender must be men or women');
  if (!Number.isFinite(price) || price <= 0) errors.push('Price must be a positive number');
  if (compact(draft.currency || 'INR') !== 'INR') errors.push('Currency must be INR');
  if (!imageUrl) errors.push('Image URL is missing');
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) errors.push('Image URL must be HTTPS');
  if (!draft.sourceUrl) errors.push('Source URL is missing');
  if (ACCESSORY_PATTERN.test(text)) errors.push('Accessory or non-clothing item rejected');
  if (!CLOTHING_PATTERN.test(text)) errors.push('Product does not look like a clothing garment');
  if (UNAVAILABLE_PATTERN.test(text)) errors.push('Product appears unavailable or out of stock');
  if (context.seenAsins?.has(asin)) errors.push('Duplicate ASIN in this batch');

  if (errors.length) {
    const error = new Error(errors.join('; '));
    error.reasons = errors;
    throw error;
  }

  context.seenAsins?.add(asin);
  const tags = [...new Set([...splitList(entry.tags), ...(draft.tags || []), category, gender, 'amazon-import'].map(compact).filter(Boolean))];
  if (isFullBody({ ...draft, category })) tags.push('full-body');

  return {
    name: compact(draft.name),
    brand: compact(draft.brand),
    category,
    gender,
    garmentPlacement: inferPlacement({ ...draft, ...entry, category }),
    price,
    compareAtPrice: Number.isFinite(compareAtPrice) && compareAtPrice > price ? compareAtPrice : undefined,
    currency: 'INR',
    rating: Number.isFinite(Number(draft.rating)) ? Number(draft.rating) : 0,
    ratingCount: Number.isFinite(Number(draft.ratingCount)) ? Number(draft.ratingCount) : 0,
    badge: 'Amazon',
    affiliateLink: withAssociateTag(draft.affiliateLink || draft.sourceUrl),
    sourceUrl: canonicalAmazonUrl(draft.sourceUrl || draft.affiliateLink),
    description: compact(draft.description),
    tags,
    colors: splitList(entry.colors),
    sizes: splitList(entry.sizes || draft.sizes),
    sizeNotes: compact(entry.sizeNotes || draft.sizeNotes),
    tryOnModel: inferTryOnModel({ ...draft, category, tags }),
    image: { remoteUrl: imageUrl },
    sourceProvider: 'amazon',
    sourceProductId: asin,
    importBatchId: context.batchId,
    catalogApproved: true,
    lastSyncedAt: new Date(),
    isFeatured: false,
    isNewArrival: true,
    isActive: true,
    availabilityStatus: 'available',
    availabilityCheckedAt: new Date(),
    availabilitySource: 'import'
  };
}

function dedupeFilter(product) {
  const asin = product.sourceProductId;
  const asinPattern = new RegExp(`/(?:dp|gp/product)/${asin}(?:[/?#]|$)?`, 'i');
  return {
    $or: [
      { sourceProvider: product.sourceProvider, sourceProductId: asin },
      { sourceUrl: asinPattern },
      { affiliateLink: asinPattern },
      { sourceUrl: product.sourceUrl },
      { affiliateLink: product.affiliateLink }
    ]
  };
}

async function maybeLean(query) {
  if (!query) return null;
  if (typeof query.lean === 'function') return query.lean();
  return query;
}

async function findExisting(model, product) {
  return maybeLean(model.findOne(dedupeFilter(product)));
}

function createReport(options = {}) {
  return {
    batchId: options.batchId,
    batchNumber: options.batchNumber,
    provider: options.providerName,
    dryRun: !options.commit,
    replaceExisting: Boolean(options.replaceExisting),
    categoriesRequested: options.categoriesRequested || [],
    attempted: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    grouped: {},
    duplicateAsins: [],
    rejectedAccessories: [],
    productsWithMissingFields: [],
    productIdsWritten: [],
    oldProductsDeactivated: [],
    errors: []
  };
}

function rememberGroup(report, product, status) {
  report.grouped[product.gender] ||= {};
  report.grouped[product.gender][product.category] ||= { attempted: 0, inserted: 0, updated: 0, skipped: 0, failed: 0 };
  report.grouped[product.gender][product.category][status] += 1;
}

async function writeReport(report, reportsDir = DEFAULT_REPORTS_DIR) {
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `catalog-import-${stamp}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function importProducts(options = {}) {
  const taxonomy = options.taxonomy || await readTaxonomy(options.taxonomyPath);
  const batchId = options.batchId || `catalog-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const providerName = options.provider || 'url-manifest';
  const provider = options.productProvider || (providerName === 'amazon-api' ? createAmazonApiProvider() : createUrlManifestProvider(options));
  const model = options.productModel || Product;
  const entries = options.entries || await readManifest(options.input);
  const categoriesRequested = options.categoriesRequested || [
    ...new Set(entries.map((entry) => `${normalizeGender(entry.expectedGender) || 'unknown'}:${compact(entry.expectedCategory)}`).filter((item) => !item.endsWith(':')))
  ];
  const report = createReport({ ...options, batchId, providerName, categoriesRequested });
  const seenAsins = new Set();
  const acceptedByCategory = new Map();
  const batchSize = Number(taxonomy.batchSize || 20);
  const products = [];
  const existingByAsin = new Map();

  if (provider.disabled) throw new Error('Amazon API provider is disabled. Use --input with URL manifest mode until API credentials are available.');
  if (options.replaceExisting && options.commit && options.confirm !== REPLACE_CONFIRMATION) {
    throw new Error(`--replace-existing requires --confirm ${REPLACE_CONFIRMATION}`);
  }

  for (const entry of entries) {
    report.attempted += 1;
    try {
      const draft = await provider.getProduct(entry);
      const product = validateAndBuildProduct(draft, entry, { taxonomy, seenAsins, batchId });
      const categoryKey = `${product.gender}:${product.category}`;
      if ((acceptedByCategory.get(categoryKey) || 0) >= batchSize) {
        report.skipped += 1;
        rememberGroup(report, product, 'skipped');
        continue;
      }
      acceptedByCategory.set(categoryKey, (acceptedByCategory.get(categoryKey) || 0) + 1);
      const existing = await findExisting(model, product);
      products.push(product);
      if (existing?._id) existingByAsin.set(product.sourceProductId, existing._id.toString());
      if (existing) {
        report.updated += 1;
        rememberGroup(report, product, 'updated');
      } else {
        report.inserted += 1;
        rememberGroup(report, product, 'inserted');
      }
    } catch (error) {
      const rawUrl = entry.sourceUrl || entry.affiliateLink || '';
      const asin = extractAsin(rawUrl);
      const message = sanitizeError(error);
      report.failed += 1;
      if (/duplicate asin/i.test(message) && asin) report.duplicateAsins.push(asin);
      if (/accessory|non-clothing/i.test(message)) report.rejectedAccessories.push({ asin, url: rawUrl, reason: message });
      if (/missing|required|enabled/.test(message)) report.productsWithMissingFields.push({ asin, url: rawUrl, reason: message });
      report.errors.push({ asin, url: rawUrl, message });
    }
  }

  if (!options.commit) {
    const reportPath = await writeReport(report, options.reportsDir);
    return { report, reportPath };
  }

  if (!products.length) {
    const reportPath = await writeReport(report, options.reportsDir);
    return { report, reportPath };
  }

  const operations = products.map((product) => ({
    updateOne: {
      filter: dedupeFilter(product),
      update: { $set: product },
      upsert: true
    }
  }));

  const result = await model.bulkWrite(operations, { ordered: false });
  const upsertedIds = Object.values(result.upsertedIds || {}).map((value) => value?.toString?.() || String(value));
  report.productIdsWritten.push(...upsertedIds);
  report.productIdsWritten.push(...[...existingByAsin.values()]);

  if (options.replaceExisting) {
    const keepIds = report.productIdsWritten.filter(Boolean);
    const deactivateResult = await model.updateMany(
      { isActive: true, _id: { $nin: keepIds }, importBatchId: { $ne: batchId } },
      {
        $set: {
          isActive: false,
          availabilityStatus: 'archived',
          availabilityCheckedAt: new Date(),
          availabilitySource: 'import-replacement'
        }
      }
    );
    report.oldProductsDeactivated = [{ count: deactivateResult.modifiedCount || 0, batchId }];
  }

  await clearReadCachesAfterProductWrite();
  const reportPath = await writeReport(report, options.reportsDir);
  return { report, reportPath };
}

export {
  ACCESSORY_PATTERN,
  REPLACE_CONFIRMATION,
  dedupeFilter,
  inferPlacement,
  importProducts,
  normalizeCategoryForGender,
  parseCsv,
  readManifest,
  readTaxonomy,
  sanitizeError,
  validateAndBuildProduct,
  writeReport
};
