import mongoose from 'mongoose';

const appleTransactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    productId: { type: String, trim: true, required: true, index: true },
    productKind: {
      type: String,
      enum: ['subscription', 'consumable'],
      required: true,
      index: true
    },
    transactionId: { type: String, trim: true, required: true, unique: true },
    originalTransactionId: { type: String, trim: true, index: true },
    webOrderLineItemId: { type: String, trim: true },
    fulfillmentKey: { type: String, trim: true, unique: true, sparse: true },
    appAccountToken: { type: String, trim: true, lowercase: true, index: true },
    environment: { type: String, trim: true },
    bundleId: { type: String, trim: true },
    productType: { type: String, trim: true },
    status: {
      type: String,
      enum: ['verified', 'granted', 'expired', 'revoked', 'billing_retry', 'billing_grace', 'ignored'],
      default: 'verified',
      index: true
    },
    creditsGranted: { type: Number, default: 0 },
    purchaseDate: Date,
    originalPurchaseDate: Date,
    expiresDate: Date,
    revocationDate: Date,
    revocationReason: String,
    isUpgraded: Boolean,
    autoRenewStatus: String,
    renewalProductId: String,
    renewalDate: Date,
    expirationIntent: String,
    isInBillingRetryPeriod: Boolean,
    source: {
      type: String,
      enum: ['purchase', 'restore', 'sync', 'notification', 'history'],
      default: 'purchase'
    },
    notificationType: String,
    notificationSubtype: String,
    signedTransactionInfo: String,
    signedRenewalInfo: String,
    rawTransaction: mongoose.Schema.Types.Mixed,
    rawRenewal: mongoose.Schema.Types.Mixed,
    rawPurchase: mongoose.Schema.Types.Mixed,
    processedAt: Date,
    lastVerifiedAt: Date
  },
  { timestamps: true }
);

appleTransactionSchema.index({ user: 1, createdAt: -1 });
appleTransactionSchema.index({ user: 1, productKind: 1, purchaseDate: -1 });
appleTransactionSchema.index({ originalTransactionId: 1, productId: 1, purchaseDate: -1 });

appleTransactionSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    productId: this.productId,
    productKind: this.productKind,
    transactionId: this.transactionId,
    originalTransactionId: this.originalTransactionId,
    environment: this.environment,
    status: this.status,
    creditsGranted: this.creditsGranted,
    purchaseDate: this.purchaseDate,
    expiresDate: this.expiresDate,
    revocationDate: this.revocationDate,
    autoRenewStatus: this.autoRenewStatus,
    renewalDate: this.renewalDate,
    createdAt: this.createdAt
  };
};

export default mongoose.model('AppleTransaction', appleTransactionSchema);
