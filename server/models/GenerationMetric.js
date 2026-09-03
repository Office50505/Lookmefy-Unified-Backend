import mongoose from 'mongoose';

function analyticsRetentionDate() {
  const configuredDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 180);
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 180;
  return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

const generationMetricSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', index: true },
    type: {
      type: String,
      enum: ['product_image', 'custom_image', 'external_image', 'closet_image', 'product_video'],
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['succeeded', 'failed', 'reused', 'rejected'],
      required: true,
      index: true
    },
    provider: { type: String, trim: true, maxlength: 80, default: 'unknown' },
    model: { type: String, trim: true, maxlength: 160, default: 'unknown' },
    durationMs: { type: Number, min: 0, default: 0 },
    tokensCharged: { type: Number, min: 0, default: 0 },
    tokensRefunded: { type: Number, min: 0, default: 0 },
    providerCostUsd: { type: Number, min: 0, default: 0 },
    errorCategory: { type: String, trim: true, maxlength: 80, default: '' },
    purgeAt: { type: Date, default: analyticsRetentionDate }
  },
  { timestamps: true }
);

generationMetricSchema.index({ createdAt: -1 });
generationMetricSchema.index({ type: 1, status: 1, createdAt: -1 });
generationMetricSchema.index({ provider: 1, createdAt: -1 });
generationMetricSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('GenerationMetric', generationMetricSchema);
