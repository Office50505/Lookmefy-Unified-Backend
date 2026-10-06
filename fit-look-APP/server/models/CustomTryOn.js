import mongoose from 'mongoose';
import { documentId, tryOnMediaUrl } from '../utils/mediaAccess.js';

const customTryOnSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    provider: { type: String, default: 'fal' },
    model: { type: String, default: 'openai/gpt-image-2/edit' },
    quality: { type: String, default: 'low' },
    prompt: { type: String, trim: true },
    tokenCost: { type: Number, default: 1 },
    garment: {
      filename: String,
      path: String,
      url: String,
      sourceUrl: String,
      storage: String,
      mimetype: String,
      size: Number
    },
    image: {
      filename: String,
      path: String,
      url: String,
      sourceUrl: String,
      storage: String,
      mimetype: String,
      size: Number
    }
  },
  { timestamps: true }
);

customTryOnSchema.index({ user: 1, createdAt: -1 });

function customTryOnImageUrl(image, id, userId) {
  if (image?.storage === 'remote-pending' && !image?.sourceUrl) return '';
  return image?.path || image?.url || image?.sourceUrl ? tryOnMediaUrl({ kind: 'image', scope: 'custom', id, userId }) : '';
}

customTryOnSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    imageUrl: customTryOnImageUrl(this.image, this._id, this.user),
    garmentUrl: this.garment?.path || this.garment?.url ? tryOnMediaUrl({ kind: 'garment', scope: 'custom', id: this._id, userId: documentId(this.user) }) : null,
    provider: this.provider,
    model: this.model,
    quality: this.quality,
    tokenCost: this.tokenCost,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

export default mongoose.model('CustomTryOn', customTryOnSchema);
