import mongoose from 'mongoose';

function analyticsRetentionDate() {
  const configuredDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 180);
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 180;
  return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

const userSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sessionHash: { type: String, required: true, unique: true },
    authMethod: {
      type: String,
      enum: ['password', 'otp', 'signup'],
      required: true
    },
    status: {
      type: String,
      enum: ['active', 'logged_out', 'revoked'],
      default: 'active',
      index: true
    },
    loginAt: { type: Date, default: Date.now, required: true },
    lastSeenAt: { type: Date, default: Date.now, required: true },
    logoutAt: Date,
    endedAt: Date,
    expiresAt: { type: Date, required: true },
    activeDurationMs: { type: Number, default: 0, min: 0 },
    pageViewCount: { type: Number, default: 0, min: 0 },
    eventCount: { type: Number, default: 0, min: 0 },
    lastPath: { type: String, trim: true, maxlength: 200 },
    deviceType: {
      type: String,
      enum: ['desktop', 'mobile', 'tablet', 'bot', 'unknown'],
      default: 'unknown'
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'macos', 'windows', 'linux', 'unknown'],
      default: 'unknown',
      index: true
    },
    browser: { type: String, trim: true, maxlength: 32, default: 'Unknown' },
    purgeAt: { type: Date, default: analyticsRetentionDate }
  },
  { timestamps: true }
);

userSessionSchema.index({ user: 1, loginAt: -1 });
userSessionSchema.index({ user: 1, lastSeenAt: -1 });
userSessionSchema.index({ status: 1, lastSeenAt: -1 });
userSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('UserSession', userSessionSchema);
