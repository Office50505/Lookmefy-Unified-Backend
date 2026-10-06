import mongoose from 'mongoose';
import { documentId, tryOnMediaUrl } from '../utils/mediaAccess.js';

const tryOnSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
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
    },
    video: {
      filename: String,
      path: String,
      url: String,
      storage: String,
      mimetype: String,
      size: Number,
      model: String,
      prompt: String,
      tokenCost: Number,
      generatedAt: Date
    }
  },
  { timestamps: true }
);

tryOnSchema.index({ user: 1, product: 1 }, { unique: true });
tryOnSchema.index({ user: 1, createdAt: -1 });
tryOnSchema.index({ product: 1, createdAt: -1 });
tryOnSchema.index({ user: 1, updatedAt: -1 });

function tryOnToClient(tryOn) {
  const id = tryOn._id.toString();
  const userId = documentId(tryOn.user);
  const hasImage = Boolean(tryOn.image?.path || tryOn.image?.url || tryOn.image?.sourceUrl);
  const hasVideo = Boolean(tryOn.video?.path || tryOn.video?.url);
  return {
    id,
    productId: tryOn.product.toString(),
    imageUrl: hasImage ? tryOnMediaUrl({ kind: 'image', scope: 'product', id, userId }) : null,
    videoUrl: hasVideo ? tryOnMediaUrl({ kind: 'video', scope: 'product', id, userId }) : null,
    videoModel: tryOn.video?.model || '',
    videoTokenCost: tryOn.video?.tokenCost || 0,
    videoGeneratedAt: tryOn.video?.generatedAt || null,
    provider: tryOn.provider,
    model: tryOn.model,
    quality: tryOn.quality,
    tokenCost: tryOn.tokenCost,
    createdAt: tryOn.createdAt,
    updatedAt: tryOn.updatedAt
  };
}

tryOnSchema.methods.toClient = function toClient() {
  return tryOnToClient(this);
};

export default mongoose.model('TryOn', tryOnSchema);
export { tryOnToClient };
