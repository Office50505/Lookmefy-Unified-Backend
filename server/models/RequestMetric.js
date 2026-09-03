import mongoose from 'mongoose';

const requestMetricSchema = new mongoose.Schema({
  bucketStart: { type: Date, required: true },
  instanceId: { type: String, required: true, trim: true },
  endpoint: { type: String, required: true, trim: true },
  requests: { type: Number, default: 0, min: 0 },
  errors: { type: Number, default: 0, min: 0 },
  clientErrors: { type: Number, default: 0, min: 0 },
  totalMs: { type: Number, default: 0, min: 0 },
  minMs: { type: Number, min: 0 },
  maxMs: { type: Number, default: 0, min: 0 },
  histogram: {
    le100: { type: Number, default: 0, min: 0 },
    le250: { type: Number, default: 0, min: 0 },
    le500: { type: Number, default: 0, min: 0 },
    le1000: { type: Number, default: 0, min: 0 },
    le2500: { type: Number, default: 0, min: 0 },
    le5000: { type: Number, default: 0, min: 0 },
    inf: { type: Number, default: 0, min: 0 }
  },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

requestMetricSchema.index({ bucketStart: 1, instanceId: 1, endpoint: 1 }, { unique: true });
requestMetricSchema.index({ bucketStart: -1, instanceId: 1 });
requestMetricSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('RequestMetric', requestMetricSchema);
