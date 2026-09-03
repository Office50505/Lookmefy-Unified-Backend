import mongoose from 'mongoose';

const outfitImageSchema = {
  filename: String,
  path: String,
  url: String,
  storage: { type: String, trim: true },
  mimetype: String,
  size: Number
};

const imageProcessingSchema = {
  sourceImageUrl: String,
  transparentImageUrl: String,
  processingStatus: { type: String, enum: ['idle', 'queued', 'processing', 'completed', 'failed'], default: 'idle' },
  processingProvider: String,
  processingVersion: String,
  processedAt: Date,
  sourceWidth: Number,
  sourceHeight: Number,
  transparentWidth: Number,
  transparentHeight: Number,
  processingError: String,
  segmentationModel: String,
  segmentationModelsUsed: [String],
  failedSegmentationModels: [mongoose.Schema.Types.Mixed],
  inferenceResolution: String,
  maskSettings: mongoose.Schema.Types.Mixed,
  repairedPixels: Number,
  foregroundAreaRatio: Number,
  connectedComponents: Number,
  torsoCoverage: Number,
  footCoverage: Number,
  headCoverage: Number,
  armCoverage: Number,
  legCoverage: Number,
  internalHoleRatio: Number,
  largestInternalHoleRatio: Number,
  edgeNoiseRatio: Number,
  qualityScore: Number,
  qualityPassed: Boolean,
  qualityReasons: [String],
  retryModelUsed: String,
  debugMaskPreview: mongoose.Schema.Types.Mixed,
  cached: Boolean
};

const closetOutfitSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, trim: true, default: 'Generated outfit' },
    occasion: { type: String, trim: true, default: '' },
    weather: { type: String, trim: true, default: '' },
    mood: { type: String, trim: true, default: '' },
    backdrop: { type: String, trim: true, default: '' },
    pose: { type: String, trim: true, default: '' },
    lighting: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    plannedFor: Date,
    itemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ClosetItem' }],
    provider: { type: String, default: 'fitroom' },
    model: { type: String, default: 'fitroom/tryon-v2' },
    quality: { type: String, default: 'standard' },
    tokenCost: { type: Number, default: 1 },
    favorite: { type: Boolean, default: false },
    garment: outfitImageSchema,
    image: outfitImageSchema,
    transparentImage: outfitImageSchema,
    imageProcessing: imageProcessingSchema
  },
  { timestamps: true }
);

closetOutfitSchema.index({ user: 1, createdAt: -1 });

closetOutfitSchema.methods.toClient = function toClient(itemsById = new Map()) {
  const items = (this.itemIds || []).map((id) => itemsById.get(id.toString())).filter(Boolean);
  return {
    id: this._id.toString(),
    title: this.title,
    occasion: this.occasion || '',
    weather: this.weather || '',
    mood: this.mood || '',
    backdrop: this.backdrop || '',
    pose: this.pose || '',
    lighting: this.lighting || '',
    notes: this.notes || '',
    plannedFor: this.plannedFor || null,
    itemIds: (this.itemIds || []).map((id) => id.toString()),
    items,
    provider: this.provider,
    model: this.model,
    quality: this.quality,
    tokenCost: this.tokenCost,
    favorite: Boolean(this.favorite),
    garmentUrl: this.garment?.url || (this.garment?.path ? `/${this.garment.path}` : null),
    imageUrl: this.image?.url || (this.image?.path ? `/${this.image.path}` : null),
    transparentImageUrl: this.transparentImage?.url || (this.transparentImage?.path ? `/${this.transparentImage.path}` : (this.imageProcessing?.transparentImageUrl || null)),
    imageProcessing: this.imageProcessing || null,
    createdAt: this.createdAt
  };
};

export default mongoose.model('ClosetOutfit', closetOutfitSchema);
