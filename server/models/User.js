import mongoose from 'mongoose';

function signupTokens() {
  const value = Number(process.env.SIGNUP_FREE_TOKENS || 8);
  return Number.isFinite(value) && value >= 0 ? value : 8;
}

function defaultDevMode() {
  const production = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.ENABLE_DEV_MODE || '').toLowerCase());
  const defaultEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.SIGNUP_DEV_MODE_DEFAULT || '').toLowerCase());
  return !production && enabled && defaultEnabled;
}

function storedPhotoUrl(photo, user) {
  if (photo?.url) return photo.url;
  const path = photo?.path;
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const updatedAt = photo?.generatedAt || user.updatedAt || user.createdAt;
  const version = updatedAt ? new Date(updatedAt).getTime() : 0;
  return `/${path}${version ? `?v=${version}` : ''}`;
}

function bodyPhotoUrl(user) {
  return storedPhotoUrl(user.bodyPhoto, user);
}

function bodyPhotoOriginalUrl(user) {
  return storedPhotoUrl(user.bodyPhoto?.original, user);
}

function avatarPhotoUrl(user) {
  return storedPhotoUrl(user.avatarPhoto, user);
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, unique: true, required: true },
    phone: { type: String, trim: true, unique: true, sparse: true },
    phoneVerifiedAt: Date,
    username: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true
    },
    passwordHash: { type: String, required: true, select: false },
    passwordSetAt: Date,
    authVersion: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Authentication version must be a non-negative whole number'
      }
    },
    genderPreference: {
      type: String,
      enum: ['male', 'female', 'other'],
      default: 'other'
    },
    tokens: {
      type: Number,
      default: signupTokens,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Token balance must be a non-negative whole number'
      }
    },
    accountStatus: {
      type: String,
      enum: ['active', 'banned', 'deleted'],
      default: 'active',
      index: true
    },
    bannedAt: Date,
    banReason: { type: String, trim: true },
    bannedBy: { type: String, trim: true },
    deletedAt: Date,
    devMode: { type: Boolean, default: defaultDevMode },
    wishlistProducts: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    }],
    subscription: {
      planId: { type: String, trim: true },
      status: { type: String, trim: true, default: 'none' },
      provider: { type: String, trim: true },
      merchantSubscriptionId: { type: String, trim: true },
      razorpayMode: { type: String, trim: true },
      appleProductId: { type: String, trim: true },
      appleOriginalTransactionId: { type: String, trim: true },
      appleTransactionId: { type: String, trim: true },
      appleEnvironment: { type: String, trim: true },
      amount: { type: Number, default: 0 },
      currency: { type: String, trim: true, uppercase: true, default: 'INR' },
      tokensPerMonth: { type: Number, default: 0 },
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      nextBillingAt: Date,
      cancelledAt: Date,
      revokedAt: Date,
      willAutoRenew: Boolean,
      billingRetry: Boolean,
      lastOrderId: { type: String, trim: true }
    },
    avatarPhoto: {
      filename: String,
      path: String,
      url: String,
      storage: { type: String, trim: true },
      mimetype: String,
      size: Number,
      source: { type: String, trim: true },
      uploadedAt: Date
    },
    bodyPhoto: {
      filename: String,
      path: String,
      url: String,
      storage: { type: String, trim: true },
      mimetype: String,
      size: Number,
      status: { type: String, enum: ['uploaded', 'generating', 'ready', 'failed'], default: 'uploaded' },
      source: { type: String, trim: true },
      generatedAt: Date,
      error: String,
      original: {
        filename: String,
        path: String,
        url: String,
        storage: { type: String, trim: true },
        mimetype: String,
        size: Number
      }
    },
    avatarCrop: {
      scale: { type: Number, min: 0.5, max: 5 },
      translateX: { type: Number, min: -200, max: 200 },
      translateY: { type: Number, min: -200, max: 200 },
      updatedAt: Date
    },
    onboardingSeenAt: Date
  },
  { timestamps: true }
);

userSchema.index({ createdAt: -1 });
userSchema.index({ accountStatus: 1, createdAt: -1 });
userSchema.index({ 'subscription.status': 1, 'subscription.currentPeriodEnd': 1 });
userSchema.index({ 'subscription.appleOriginalTransactionId': 1 }, { sparse: true });
userSchema.index({ 'subscription.appleTransactionId': 1 }, { sparse: true });

userSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    phone: this.phone,
    phoneVerified: Boolean(this.phoneVerifiedAt),
    hasPassword: Boolean(this.passwordSetAt || this.passwordHash),
    username: this.username,
    genderPreference: this.genderPreference || 'other',
    tokens: this.tokens,
    subscription: {
      planId: this.subscription?.planId || null,
      status: this.subscription?.status || 'none',
      provider: this.subscription?.provider || null,
      merchantSubscriptionId: this.subscription?.merchantSubscriptionId || null,
      razorpayMode: this.subscription?.razorpayMode || null,
      appleProductId: this.subscription?.appleProductId || null,
      appleOriginalTransactionId: this.subscription?.appleOriginalTransactionId || null,
      appleTransactionId: this.subscription?.appleTransactionId || null,
      appleEnvironment: this.subscription?.appleEnvironment || null,
      amount: this.subscription?.amount || 0,
      currency: this.subscription?.currency || 'INR',
      tokensPerMonth: this.subscription?.tokensPerMonth || 0,
      currentPeriodStart: this.subscription?.currentPeriodStart || null,
      currentPeriodEnd: this.subscription?.currentPeriodEnd || null,
      nextBillingAt: this.subscription?.nextBillingAt || this.subscription?.currentPeriodEnd || null,
      cancelledAt: this.subscription?.cancelledAt || null,
      revokedAt: this.subscription?.revokedAt || null,
      willAutoRenew: Boolean(this.subscription?.willAutoRenew),
      billingRetry: Boolean(this.subscription?.billingRetry)
    },
    devMode: Boolean(this.devMode),
    hasCompletedOnboarding: Boolean(this.onboardingSeenAt),
    onboardingSeenAt: this.onboardingSeenAt || null,
    wishlistCount: this.wishlistProducts?.length || 0,
    joinedAt: this.createdAt,
    avatarPhotoUrl: avatarPhotoUrl(this),
    avatarPhotoSource: this.avatarPhoto?.source || '',
    bodyPhotoUrl: bodyPhotoUrl(this),
    bodyPhotoOriginalUrl: bodyPhotoOriginalUrl(this),
    bodyPhotoStatus: this.bodyPhoto?.status || 'uploaded',
    bodyPhotoSource: this.bodyPhoto?.source || 'upload',
    bodyPhotoGeneratedAt: this.bodyPhoto?.generatedAt || null,
    avatarCrop: this.avatarCrop ? {
      scale: Number(this.avatarCrop.scale) || 1,
      translateX: Number(this.avatarCrop.translateX) || 0,
      translateY: Number(this.avatarCrop.translateY) || 0,
      updatedAt: this.avatarCrop.updatedAt || null
    } : null
  };
};

export default mongoose.model('User', userSchema);
