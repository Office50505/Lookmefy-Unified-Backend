import mongoose from 'mongoose';

const blockedIpSchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true, maxlength: 80, index: true },
    reason: { type: String, trim: true, maxlength: 300, default: '' },
    source: { type: String, enum: ['manual', 'auto', 'system'], default: 'manual', index: true },
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
    lastMatchedAt: Date,
    matchCount: { type: Number, min: 0, default: 0 }
  },
  { timestamps: true }
);

blockedIpSchema.index({ active: 1, expiresAt: 1 });
blockedIpSchema.index({ value: 1, active: 1 });

export default mongoose.model('BlockedIp', blockedIpSchema);
