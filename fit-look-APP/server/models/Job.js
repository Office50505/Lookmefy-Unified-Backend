import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema(
  {
    type: { type: String, trim: true, required: true, index: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed'],
      default: 'queued',
      index: true
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    key: { type: String, trim: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: mongoose.Schema.Types.Mixed,
    error: {
      message: String,
      stack: String,
      code: String
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    priority: { type: Number, default: 0 },
    runAfter: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lockedBy: String,
    startedAt: Date,
    finishedAt: Date,
    expiresAt: Date
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, runAfter: 1, priority: -1, createdAt: 1 });
jobSchema.index({ status: 1, lockedAt: 1 });
jobSchema.index({ user: 1, status: 1, createdAt: -1 });
jobSchema.index({ type: 1, key: 1, status: 1, createdAt: -1 });
jobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, sparse: true });

export default mongoose.model('Job', jobSchema);
