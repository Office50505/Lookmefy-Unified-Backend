import mongoose from 'mongoose';

const creditEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, trim: true, required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    productTitle: { type: String, trim: true, default: 'Product' },
    productImageUrl: { type: String, trim: true },
    tokens: {
      type: Number,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Credit event token amount must be a whole number'
      }
    },
    balanceAfter: {
      type: Number,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Credit event balance must be a whole number'
      }
    },
    direction: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
      index: true
    },
    source: {
      type: String,
      trim: true,
      lowercase: true,
      default: 'system',
      index: true
    },
    sourceId: { type: String, trim: true, index: true },
    fulfillmentKey: { type: String, trim: true, unique: true, sparse: true },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

creditEventSchema.index({ user: 1, createdAt: -1 });
creditEventSchema.index({ user: 1, action: 1, createdAt: -1 });
creditEventSchema.index({ product: 1, createdAt: -1 }, { sparse: true });
creditEventSchema.index({ source: 1, sourceId: 1 }, { sparse: true });

creditEventSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    action: this.action,
    productId: this.product?.toString?.() || this.product || '',
    productTitle: this.productTitle || 'Product',
    productImageUrl: this.productImageUrl || '',
    tokens: Number(this.tokens) || 0,
    balanceAfter: Number(this.balanceAfter) || 0,
    direction: this.direction || (Number(this.tokens) >= 0 ? 'credit' : 'debit'),
    source: this.source || 'system',
    sourceId: this.sourceId || '',
    metadata: this.metadata || null,
    createdAt: this.createdAt
  };
};

export default mongoose.model('CreditEvent', creditEventSchema);
