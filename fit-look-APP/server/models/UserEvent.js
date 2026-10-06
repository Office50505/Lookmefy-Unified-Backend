import mongoose from 'mongoose';

const userEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['search', 'product_view', 'product_click', 'try_on', 'shop_click', 'style_bot_query', 'custom_tryon', 'filter'],
      required: true,
      index: true
    },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true },
    query: { type: String, trim: true },
    weight: { type: Number, default: 1 },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

userEventSchema.index({ user: 1, createdAt: -1 });
userEventSchema.index({ user: 1, type: 1, createdAt: -1 });
userEventSchema.index({ user: 1, type: 1, query: 1, createdAt: -1 });
userEventSchema.index({ product: 1, createdAt: -1 });
userEventSchema.index({ type: 1, createdAt: -1 });
userEventSchema.index({ createdAt: -1 });

export default mongoose.model('UserEvent', userEventSchema);
