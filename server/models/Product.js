import mongoose from 'mongoose';
import { productAvailabilityStatus } from '../utils/productAvailability.js';

const LEGACY_UNRESTRICTED_MODEL = ['v' + 'to', 'unrestricted'].join('-');

function inferGarmentPlacement(product = {}) {
  if (['top', 'bottom', 'accessory', 'full-body'].includes(product.garmentPlacement)) return product.garmentPlacement;
  const text = [
    product.name,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(outfits?|sets?|co-?ords?|coordinated|tracksuits?|suits?|jumpsuits?|rompers?|playsuits?|dress(?:es)?|gowns?|sarees?|saris?|lehenga(?:s)?|kurta\s?sets?)\b/.test(text)) return 'full-body';
  if (/\b(pants?|trousers?|jeans?|denim|shorts?|skirts?|leggings?|joggers?|palazzos?|bottoms?|lower)\b/.test(text)) return 'bottom';
  return 'top';
}

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

const productSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    brand: { type: String, trim: true, required: true },
    category: { type: String, trim: true, required: true },
    gender: { type: String, trim: true, default: 'unisex' },
    garmentPlacement: {
      type: String,
      enum: ['top', 'bottom', 'accessory', 'full-body'],
      default: 'top',
      index: true
    },
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
    sizes: [{ type: String, trim: true }],
    sizeNotes: { type: String, trim: true },
    tryOnModel: {
      type: String,
      enum: ['gpt-image-2', 'wan-v2.6-image-to-image'],
      default: 'gpt-image-2'
    },
    image: {
      filename: String,
      path: String,
      url: String,
      storage: { type: String, trim: true },
      remoteUrl: String,
      mimetype: String,
      size: Number
    },
    sourceUrl: { type: String, trim: true },
    sourceProvider: { type: String, trim: true },
    sourceProductId: { type: String, trim: true },
    importBatchId: { type: String, trim: true },
    catalogApproved: { type: Boolean, default: false, index: true },
    lastSyncedAt: { type: Date },
    isFeatured: { type: Boolean, default: false },
    isNewArrival: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    availabilityStatus: {
      type: String,
      enum: ['draft', 'available', 'out_of_stock', 'unavailable', 'archived'],
      default: 'available',
      index: true
    },
    availabilityCheckedAt: Date,
    availabilitySource: { type: String, trim: true, default: 'manual' },
    inventoryNotes: { type: String, trim: true }
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
productSchema.index({ isActive: 1, brand: 1, createdAt: -1 });
productSchema.index({ isActive: 1, gender: 1, createdAt: -1 });
productSchema.index({ isActive: 1, tags: 1, createdAt: -1 });
productSchema.index({ availabilityStatus: 1, updatedAt: -1 });
productSchema.index(
  { sourceProvider: 1, sourceProductId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceProvider: { $type: 'string' },
      sourceProductId: { $type: 'string' }
    }
  }
);

productSchema.pre('validate', function synchronizeAvailability() {
  const status = productAvailabilityStatus(this);
  this.availabilityStatus = status;
  this.isActive = status === 'available';
});

function productToClient(product) {
  return {
    id: product._id.toString(),
    name: decodeHtml(product.name),
    brand: decodeHtml(product.brand),
    category: decodeHtml(product.category),
    gender: product.gender,
    garmentPlacement: inferGarmentPlacement(product),
    price: product.price,
    compareAtPrice: product.compareAtPrice,
    currency: product.currency || 'INR',
    rating: product.rating,
    ratingCount: product.ratingCount,
    badge: product.badge,
    affiliateLink: product.affiliateLink,
    sourceUrl: product.sourceUrl,
    description: decodeHtml(product.description),
    tags: product.tags?.map(decodeHtml),
    colors: product.colors,
    sizes: product.sizes?.map(decodeHtml),
    sizeNotes: decodeHtml(product.sizeNotes),
    tryOnModel: product.tryOnModel === LEGACY_UNRESTRICTED_MODEL ? 'wan-v2.6-image-to-image' : product.tryOnModel || 'gpt-image-2',
    imageUrl: product.image?.url || (product.image?.path ? `/${product.image.path}` : product.image?.remoteUrl || null),
    isFeatured: product.isFeatured,
    isNewArrival: product.isNewArrival,
    availabilityStatus: productAvailabilityStatus(product),
    availabilityCheckedAt: product.availabilityCheckedAt || null,
    availabilitySource: product.availabilitySource || null,
    createdAt: product.createdAt
  };
}

function productToAdminClient(product) {
  return {
    ...productToClient(product),
    inventoryNotes: product.inventoryNotes || '',
    isActive: product.isActive !== false,
    updatedAt: product.updatedAt || null
  };
}

productSchema.methods.toClient = function toClient() {
  return productToClient(this);
};

export default mongoose.model('Product', productSchema);
export { productToAdminClient, productToClient };
