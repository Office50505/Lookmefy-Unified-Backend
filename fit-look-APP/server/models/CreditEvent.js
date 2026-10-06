import mongoose from 'mongoose';

const creditEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, trim: true, required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productTitle: { type: String, trim: true, default: 'Product' },
    productImageUrl: { type: String, trim: true },
    tokens: { type: Number, required: true },
    balanceAfter: { type: Number, default: 0 },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

creditEventSchema.index({ user: 1, createdAt: -1 });
creditEventSchema.index({ user: 1, action: 1, createdAt: -1 });
creditEventSchema.index({ product: 1, createdAt: -1 }, { sparse: true });

export function creditEventToClient(event) {
  const source = event?.toObject ? event.toObject() : event;
  return {
    id: source._id?.toString(),
    action: source.action,
    productId: source.product?.toString?.() || source.product || '',
    productTitle: source.productTitle || 'Product',
    productImageUrl: source.productImageUrl || '',
    tokens: Number(source.tokens) || 0,
    balanceAfter: Number(source.balanceAfter) || 0,
    direction: source.metadata?.direction === 'credit' ? 'credit' : 'debit',
    createdAt: source.createdAt
  };
}

export default mongoose.model('CreditEvent', creditEventSchema);
