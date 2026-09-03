import mongoose from 'mongoose';

function retentionDate() {
  const configuredDays = Number(process.env.OPERATIONS_RETENTION_DAYS || 180);
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 180;
  return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

const otpDeliveryMetricSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, trim: true, maxlength: 80, index: true },
    purpose: { type: String, enum: ['signup', 'login', 'other'], default: 'other', index: true },
    status: { type: String, enum: ['succeeded', 'failed'], required: true, index: true },
    durationMs: { type: Number, min: 0, default: 0 },
    estimatedCostUsd: { type: Number, min: 0, default: 0 },
    errorCategory: { type: String, trim: true, maxlength: 80, default: '' },
    purgeAt: { type: Date, default: retentionDate }
  },
  { timestamps: true }
);

otpDeliveryMetricSchema.index({ createdAt: -1 });
otpDeliveryMetricSchema.index({ provider: 1, status: 1, createdAt: -1 });
otpDeliveryMetricSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('OtpDeliveryMetric', otpDeliveryMetricSchema);
