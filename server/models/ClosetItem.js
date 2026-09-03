import mongoose from 'mongoose';

const closetImageSchema = {
  filename: String,
  path: String,
  url: String,
  storage: { type: String, trim: true },
  mimetype: String,
  size: Number
};

const closetVisualProfileSchema = {
  source: { type: String, trim: true, default: '' },
  model: { type: String, trim: true, default: '' },
  analyzedAt: Date,
  cost: { type: Number, default: 0 },
  confidence: { type: Number, default: 0 },
  subcategory: { type: String, trim: true, default: '' },
  primaryColor: { type: String, trim: true, default: '' },
  secondaryColors: [{ type: String, trim: true }],
  pattern: { type: String, trim: true, default: '' },
  fabricGuess: { type: String, trim: true, default: '' },
  texture: { type: String, trim: true, default: '' },
  fit: { type: String, trim: true, default: '' },
  silhouette: { type: String, trim: true, default: '' },
  formality: { type: String, trim: true, default: '' },
  occasions: [{ type: String, trim: true }],
  seasons: [{ type: String, trim: true }],
  styleTags: [{ type: String, trim: true }],
  pairingNotes: { type: String, trim: true, default: '' },
  rawDescription: { type: String, trim: true, default: '' }
};

const closetItemSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, trim: true, required: true },
    category: {
      type: String,
      enum: ['tops', 'bottoms', 'dresses', 'suits', 'outerwear', 'shoes', 'accessories', 'activewear', 'ethnic', 'other'],
      default: 'other',
      index: true
    },
    color: { type: String, trim: true, default: '' },
    fabric: { type: String, trim: true, default: '' },
    pattern: { type: String, trim: true, default: '' },
    season: { type: String, trim: true, default: 'all-season' },
    formality: { type: String, enum: ['casual', 'smart-casual', 'formal', 'party', 'active', 'any'], default: 'any' },
    occasions: [{ type: String, trim: true }],
    tags: [{ type: String, trim: true }],
    favorite: { type: Boolean, default: false },
    wearCount: { type: Number, default: 0 },
    lastWornAt: Date,
    image: closetImageSchema,
    visualProfile: closetVisualProfileSchema
  },
  { timestamps: true }
);

closetItemSchema.index({ user: 1, category: 1, createdAt: -1 });
closetItemSchema.index({ user: 1, favorite: 1, updatedAt: -1 });

closetItemSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    name: this.name,
    category: this.category,
    color: this.color || '',
    fabric: this.fabric || '',
    pattern: this.pattern || '',
    season: this.season || 'all-season',
    formality: this.formality || 'any',
    occasions: this.occasions || [],
    tags: this.tags || [],
    favorite: Boolean(this.favorite),
    wearCount: this.wearCount || 0,
    lastWornAt: this.lastWornAt || null,
    imageUrl: this.image?.url || (this.image?.path ? `/${this.image.path}` : null),
    visualProfile: this.visualProfile || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

export default mongoose.model('ClosetItem', closetItemSchema);
