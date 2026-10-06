import mongoose from 'mongoose';
import { closetMediaUrl } from '../utils/mediaAccess.js';

const outfitImageSchema = {
  filename: String,
  path: String,
  url: String,
  storage: String,
  mimetype: String,
  size: Number
};

const closetOutfitSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, trim: true, default: 'Generated outfit' },
    occasion: { type: String, trim: true, default: '' },
    weather: { type: String, trim: true, default: '' },
    mood: { type: String, trim: true, default: '' },
    backdrop: { type: String, trim: true, default: '' },
    pose: { type: String, trim: true, default: '' },
    lighting: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    plannedFor: Date,
    itemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ClosetItem' }],
    provider: { type: String, default: 'fitroom' },
    model: { type: String, default: 'fitroom/tryon-v2' },
    quality: { type: String, default: 'standard' },
    tokenCost: { type: Number, default: 1 },
    favorite: { type: Boolean, default: false },
    garment: outfitImageSchema,
    image: outfitImageSchema
  },
  { timestamps: true }
);

closetOutfitSchema.index({ user: 1, createdAt: -1 });
closetOutfitSchema.index({ user: 1, favorite: 1, createdAt: -1 });
closetOutfitSchema.index({ user: 1, plannedFor: 1, createdAt: -1 });

closetOutfitSchema.methods.toClient = function toClient(itemsById = new Map()) {
  const items = (this.itemIds || []).map((id) => itemsById.get(id.toString())).filter(Boolean);
  return {
    id: this._id.toString(),
    title: this.title,
    occasion: this.occasion || '',
    weather: this.weather || '',
    mood: this.mood || '',
    backdrop: this.backdrop || '',
    pose: this.pose || '',
    lighting: this.lighting || '',
    notes: this.notes || '',
    plannedFor: this.plannedFor || null,
    itemIds: (this.itemIds || []).map((id) => id.toString()),
    items,
    provider: this.provider,
    model: this.model,
    quality: this.quality,
    tokenCost: this.tokenCost,
    favorite: Boolean(this.favorite),
    garmentUrl: this.garment?.path || this.garment?.url ? closetMediaUrl({ kind: 'garment', id: this._id, userId: this.user }) : null,
    imageUrl: this.image?.path || this.image?.url ? closetMediaUrl({ kind: 'outfit', id: this._id, userId: this.user }) : null,
    createdAt: this.createdAt
  };
};

export default mongoose.model('ClosetOutfit', closetOutfitSchema);
