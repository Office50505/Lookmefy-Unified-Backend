import mongoose from 'mongoose';

function analyticsRetentionDate() {
  const configuredDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 180);
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 180;
  return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

const userEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['page_view', 'search', 'wishlist', 'wishlist_remove', 'product_view', 'product_click', 'recommendation_impression', 'recommendation_click', 'try_on', 'shop_click', 'style_bot_query', 'custom_tryon', 'filter'],
      required: true,
      index: true
    },
    session: { type: mongoose.Schema.Types.ObjectId, ref: 'UserSession', index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true },
    query: { type: String, trim: true },
    path: { type: String, trim: true, maxlength: 200 },
    source: { type: String, trim: true, maxlength: 80 },
    weight: { type: Number, default: 1 },
    metadata: mongoose.Schema.Types.Mixed,
    purgeAt: { type: Date, default: analyticsRetentionDate }
  },
  { timestamps: true }
);

userEventSchema.index({ user: 1, createdAt: -1 });
userEventSchema.index({ product: 1, createdAt: -1 });
userEventSchema.index({ type: 1, createdAt: -1 });
userEventSchema.index({ createdAt: -1 });
userEventSchema.index({ session: 1, createdAt: -1 });
userEventSchema.index({ source: 1, type: 1, createdAt: -1 });
userEventSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('UserEvent', userEventSchema);
