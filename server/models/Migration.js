import mongoose from 'mongoose';

const migrationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    checksum: { type: String, required: true, trim: true, maxlength: 128 },
    status: { type: String, enum: ['applied', 'failed'], required: true, index: true },
    appliedAt: Date,
    failedAt: Date,
    error: { type: String, trim: true, maxlength: 800, default: '' }
  },
  { timestamps: true }
);

migrationSchema.index({ status: 1, appliedAt: -1 });

export default mongoose.model('Migration', migrationSchema);
