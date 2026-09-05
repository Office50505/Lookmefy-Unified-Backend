import mongoose from 'mongoose';

const userPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    categories: { type: Map, of: Number, default: {} },
    brands: { type: Map, of: Number, default: {} },
    genders: { type: Map, of: Number, default: {} },
    tags: { type: Map, of: Number, default: {} },
    colors: { type: Map, of: Number, default: {} },
    garmentPlacements: { type: Map, of: Number, default: {} },
    occasions: { type: Map, of: Number, default: {} },
    formalities: { type: Map, of: Number, default: {} },
    priceBands: { type: Map, of: Number, default: {} },
    avoidCategories: { type: Map, of: Number, default: {} },
    avoidBrands: { type: Map, of: Number, default: {} },
    avoidGenders: { type: Map, of: Number, default: {} },
    avoidTags: { type: Map, of: Number, default: {} },
    avoidColors: { type: Map, of: Number, default: {} },
    avoidGarmentPlacements: { type: Map, of: Number, default: {} },
    avoidOccasions: { type: Map, of: Number, default: {} },
    avoidFormalities: { type: Map, of: Number, default: {} },
    avoidPriceBands: { type: Map, of: Number, default: {} },
    priceTotal: { type: Number, default: 0 },
    priceCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

export default mongoose.model('UserPreference', userPreferenceSchema);
