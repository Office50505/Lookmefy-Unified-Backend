import mongoose from 'mongoose';

const tryOnImageSchema = {
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

const externalTryOnSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceUrl: { type: String, trim: true, required: true, index: true },
    affiliateLink: { type: String, trim: true },
    productName: { type: String, trim: true },
    brand: { type: String, trim: true },
    category: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    provider: { type: String, default: 'fal' },
    model: { type: String, default: 'openai/gpt-image-2/edit' },
    quality: { type: String, default: 'low' },
    prompt: { type: String, trim: true },
    promptKey: { type: String, trim: true },
    providerPredictionId: { type: String, trim: true },
    providerCostUsd: { type: Number },
    turbo: { type: Boolean },
    garmentCount: { type: Number },
    tokenCost: { type: Number, default: 1 },
    image: tryOnImageSchema,
    transparentImage: tryOnImageSchema,
    imageProcessing: imageProcessingSchema
  },
  { timestamps: true }
);

externalTryOnSchema.index({ user: 1, sourceUrl: 1 }, { unique: true });

externalTryOnSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    sourceUrl: this.sourceUrl,
    imageUrl: this.image?.url || (this.image?.path ? `/${this.image.path}` : null),
    transparentImageUrl: this.transparentImage?.url || (this.transparentImage?.path ? `/${this.transparentImage.path}` : (this.imageProcessing?.transparentImageUrl || null)),
    imageProcessing: this.imageProcessing || null,
    provider: this.provider,
    model: this.model,
    quality: this.quality,
    promptKey: this.promptKey || '',
    providerCostUsd: this.providerCostUsd || 0,
    turbo: Boolean(this.turbo),
    garmentCount: this.garmentCount || 1,
    tokenCost: this.tokenCost,
    createdAt: this.createdAt
  };
};

export default mongoose.model('ExternalTryOn', externalTryOnSchema);
