import mongoose from 'mongoose';

const systemIncidentSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, unique: true, index: true },
    service: { type: String, required: true, trim: true, maxlength: 80, index: true },
    kind: { type: String, required: true, trim: true, maxlength: 80, index: true },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      default: 'warning',
      index: true
    },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'resolved'],
      default: 'open',
      index: true
    },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    message: { type: String, trim: true, maxlength: 800, default: '' },
    occurrences: { type: Number, min: 0, default: 0 },
    firstSeenAt: { type: Date, default: Date.now, required: true },
    lastSeenAt: { type: Date, default: Date.now, required: true, index: true },
    acknowledgedAt: Date,
    resolvedAt: Date,
    note: { type: String, trim: true, maxlength: 500, default: '' },
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

systemIncidentSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
systemIncidentSchema.index({ service: 1, lastSeenAt: -1 });

export default mongoose.model('SystemIncident', systemIncidentSchema);
