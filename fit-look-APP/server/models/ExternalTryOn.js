import mongoose from 'mongoose';
import { documentId, tryOnMediaUrl } from '../utils/mediaAccess.js';

const externalTryOnSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceUrl: { type: String, trim: true, required: true, index: true },
    affiliateLink: { type: String, trim: true },
    productName: { type: String, trim: true },
    brand: { type: String, trim: true },
    category: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    provider: { type: String, default: 'fal' },
    model: { type: String, default: 'openai/gpt-image-2/edit' },
    quality: { type: String, default: 'low' },
    prompt: { type: String, trim: true },
    tokenCost: { type: Number, default: 1 },
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

externalTryOnSchema.index({ user: 1, sourceUrl: 1 }, { unique: true });
externalTryOnSchema.index({ user: 1, createdAt: -1 });
externalTryOnSchema.index({ sourceUrl: 1, createdAt: -1 });

externalTryOnSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    sourceUrl: this.sourceUrl,
    imageUrl: this.image?.path || this.image?.url || this.image?.sourceUrl ? tryOnMediaUrl({ kind: 'image', scope: 'external', id: this._id, userId: documentId(this.user) }) : null,
    provider: this.provider,
    model: this.model,
    quality: this.quality,
    tokenCost: this.tokenCost,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

export default mongoose.model('ExternalTryOn', externalTryOnSchema);
