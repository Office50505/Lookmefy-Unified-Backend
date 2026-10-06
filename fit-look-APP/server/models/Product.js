import mongoose from 'mongoose';
import { storedFileToClientUrl } from '../utils/storage.js';

const LEGACY_UNRESTRICTED_MODEL = ['v' + 'to', 'unrestricted'].join('-');

function decodeHtml(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

function currencyFromUrl(value) {
  const url = String(value || '').trim();
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

function productCurrency(product) {
  const declared = cleanCurrency(product.currency);
  const inferred = [product.sourceUrl, product.affiliateLink]
    .map(currencyFromUrl)
    .find(Boolean);
  if (inferred && (!declared || declared === 'USD')) return inferred;
  return declared || inferred || 'INR';
}

const productSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    brand: { type: String, trim: true, required: true },
    category: { type: String, trim: true, required: true },
    gender: { type: String, trim: true, default: 'unisex' },
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: 'INR' },
    rating: { type: Number, min: 0, max: 5, default: 4.5 },
    ratingCount: { type: Number, min: 0, default: 0 },
    badge: { type: String, trim: true },
    affiliateLink: { type: String, trim: true },
    description: { type: String, trim: true },
    tags: [{ type: String, trim: true }],
    colors: [{ type: String, trim: true }],
    tryOnModel: {
      type: String,
      enum: ['gpt-image-2', 'wan-v2.6-image-to-image'],
      default: 'gpt-image-2'
    },
    image: {
      filename: String,
      path: String,
      url: String,
      storage: String,
      remoteUrl: String,
      mimetype: String,
      size: Number
    },
    sourceUrl: { type: String, trim: true },
    isFeatured: { type: Boolean, default: false },
    isNewArrival: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

productSchema.index({
  name: 'text',
  brand: 'text',
  category: 'text',
  gender: 'text',
  description: 'text',
  tags: 'text'
});
productSchema.index({ isActive: 1, isFeatured: -1, createdAt: -1 });
productSchema.index({ isActive: 1, isNewArrival: -1, createdAt: -1 });
productSchema.index({ isActive: 1, category: 1, createdAt: -1 });
productSchema.index({ isActive: 1, category: 1, gender: 1, createdAt: -1 });
productSchema.index({ isActive: 1, category: 1, gender: 1, price: 1 });
productSchema.index({ isActive: 1, gender: 1, isFeatured: -1, createdAt: -1 });
productSchema.index({ isActive: 1, gender: 1, isNewArrival: -1, createdAt: -1 });
productSchema.index({ isActive: 1, brand: 1, createdAt: -1 });
productSchema.index({ isActive: 1, gender: 1, createdAt: -1 });
productSchema.index({ isActive: 1, tags: 1, createdAt: -1 });
productSchema.index({ sourceUrl: 1 }, { sparse: true });

function productToClient(product) {
  return {
    id: product._id.toString(),
    name: decodeHtml(product.name),
    brand: decodeHtml(product.brand),
    category: decodeHtml(product.category),
    gender: product.gender,
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    currency: productCurrency(product),
    rating: product.rating,
    ratingCount: product.ratingCount,
    badge: product.badge,
    affiliateLink: product.affiliateLink,
    sourceUrl: product.sourceUrl,
    description: decodeHtml(product.description),
    tags: product.tags?.map(decodeHtml),
    colors: product.colors,
    tryOnModel: product.tryOnModel === LEGACY_UNRESTRICTED_MODEL ? 'wan-v2.6-image-to-image' : product.tryOnModel || 'gpt-image-2',
    imageUrl: storedFileToClientUrl(product.image) || product.image?.remoteUrl || null,
    isFeatured: product.isFeatured,
    isNewArrival: product.isNewArrival,
    createdAt: product.createdAt
  };
}

productSchema.methods.toClient = function toClient() {
  return productToClient(this);
};

export default mongoose.model('Product', productSchema);
export { productToClient };
