import mongoose from 'mongoose';
import { effectiveDevMode, signupDevModeDefault } from '../utils/devMode.js';
import { profileMediaUrl } from '../utils/mediaAccess.js';
import { storedFileToClientUrl } from '../utils/storage.js';

function signupTokens() {
  const value = Number(process.env.SIGNUP_FREE_TOKENS || 8);
  return Number.isFinite(value) && value >= 0 ? value : 8;
}

function defaultDevMode() {
  return signupDevModeDefault();
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
    passwordHash: { type: String, required: true },
    passwordSetAt: Date,
    genderPreference: {
      type: String,
      enum: ['male', 'female', 'other'],
      default: 'other'
    },
    tokens: { type: Number, default: signupTokens },
    devMode: { type: Boolean, default: defaultDevMode },
    subscription: {
      planId: { type: String, trim: true },
      status: { type: String, trim: true, default: 'none' },
      provider: { type: String, trim: true },
      merchantSubscriptionId: { type: String, trim: true },
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
      storage: String,
      mimetype: String,
      size: Number,
      source: { type: String, trim: true },
      uploadedAt: Date
    },
    bodyPhoto: {
      filename: String,
      path: String,
      url: String,
      storage: String,
      mimetype: String,
      size: Number,
      status: { type: String, enum: ['uploaded', 'generating', 'ready', 'failed'], default: 'uploaded' },
      source: { type: String, trim: true },
      generatedAt: Date,
      error: String
    },
    avatarCrop: {
      scale: { type: Number, min: 0.5, max: 5 },
      translateX: { type: Number, min: -200, max: 200 },
      translateY: { type: Number, min: -200, max: 200 },
      updatedAt: Date
    }
  },
  { timestamps: true }
);

userSchema.index({ genderPreference: 1, createdAt: -1 });
userSchema.index({ 'subscription.status': 1, 'subscription.currentPeriodEnd': 1 });
userSchema.index({ 'subscription.appleOriginalTransactionId': 1 }, { sparse: true });
userSchema.index({ 'subscription.appleTransactionId': 1 }, { sparse: true });

userSchema.methods.toClient = function toClient() {
  const bodyPhotoUrl = storedFileToClientUrl(this.bodyPhoto);
  const storedAvatarPhotoUrl = storedFileToClientUrl(this.avatarPhoto);
  const bodyPhotoIsFullBody = this.bodyPhoto?.source === 'fal-full-body';
  const avatarPhotoIsCustomTryOn = this.avatarPhoto?.source === 'custom-try-on';
  const uploadedAvatarPhotoUrl = avatarPhotoIsCustomTryOn ? '' : storedAvatarPhotoUrl;
  const avatarPhotoUrl = bodyPhotoIsFullBody
    ? bodyPhotoUrl || uploadedAvatarPhotoUrl
    : uploadedAvatarPhotoUrl || bodyPhotoUrl;
  const avatarPhotoField = bodyPhotoIsFullBody && bodyPhotoUrl
    ? 'body'
    : uploadedAvatarPhotoUrl
      ? 'avatar'
      : bodyPhotoUrl
        ? 'body'
        : '';
  const avatarPhotoSource = avatarPhotoIsCustomTryOn ? '' : this.avatarPhoto?.source || '';

  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    phone: this.phone || '',
    phoneVerified: Boolean(this.phoneVerifiedAt),
    hasPassword: Boolean(this.passwordSetAt),
    username: this.username,
    genderPreference: this.genderPreference || 'other',
    tokens: this.tokens,
    subscription: {
      planId: this.subscription?.planId || null,
      status: this.subscription?.status || 'none',
      provider: this.subscription?.provider || null,
      merchantSubscriptionId: this.subscription?.merchantSubscriptionId || null,
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
    devMode: effectiveDevMode(this),
    joinedAt: this.createdAt,
    avatarPhotoUrl: avatarPhotoField ? profileMediaUrl(avatarPhotoField, this._id, this._id) : null,
    avatarPhotoSource,
    bodyPhotoUrl: bodyPhotoUrl ? profileMediaUrl('body', this._id, this._id) : null,
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
