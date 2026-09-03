import mongoose from 'mongoose';

const userPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    categories: { type: Map, of: Number, default: {} },
    brands: { type: Map, of: Number, default: {} },
    genders: { type: Map, of: Number, default: {} },
    tags: { type: Map, of: Number, default: {} },
    priceTotal: { type: Number, default: 0 },
    priceCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default mongoose.model('UserPreference', userPreferenceSchema);
