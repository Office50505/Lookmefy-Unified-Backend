import mongoose from 'mongoose';

const tokenOrderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    merchantOrderId: { type: String, trim: true, required: true, unique: true },
    phonePeOrderId: { type: String, trim: true },
    merchantSubscriptionId: { type: String, trim: true },
    planId: { type: String, trim: true, required: true },
    planName: { type: String, trim: true, required: true },
    purchaseType: {
      type: String,
      enum: ['top_up', 'subscription_setup', 'subscription_renewal'],
      default: 'subscription_setup',
      index: true
    },
    billingFrequency: { type: String, trim: true },
    ratePerCredit: { type: Number, default: 0 },
    amount: { type: Number, required: true },
    currency: { type: String, trim: true, uppercase: true, default: 'INR' },
    tokens: { type: Number, required: true },
    status: {
      type: String,
      enum: ['created', 'pending', 'completed', 'failed'],
      default: 'created',
      index: true
    },
    providerState: { type: String, trim: true },
    subscriptionState: { type: String, trim: true },
    redirectUrl: { type: String, trim: true },
    creditedAt: { type: Date, default: null },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    providerResponse: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

tokenOrderSchema.index({ user: 1, createdAt: -1 });
tokenOrderSchema.index({ user: 1, status: 1, createdAt: -1 });
tokenOrderSchema.index({ status: 1, createdAt: -1 });
tokenOrderSchema.index({ phonePeOrderId: 1 }, { sparse: true });
tokenOrderSchema.index({ merchantSubscriptionId: 1 }, { sparse: true });

tokenOrderSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    merchantOrderId: this.merchantOrderId,
    phonePeOrderId: this.phonePeOrderId,
    merchantSubscriptionId: this.merchantSubscriptionId,
    planId: this.planId,
    planName: this.planName,
    purchaseType: this.purchaseType,
    billingFrequency: this.billingFrequency,
    ratePerCredit: this.ratePerCredit,
    amount: this.amount,
    currency: this.currency,
    tokens: this.tokens,
    status: this.status,
    providerState: this.providerState,
    subscriptionState: this.subscriptionState,
    redirectUrl: this.redirectUrl,
    creditedAt: this.creditedAt,
    currentPeriodStart: this.currentPeriodStart,
    currentPeriodEnd: this.currentPeriodEnd,
    createdAt: this.createdAt
  };
};

export default mongoose.model('TokenOrder', tokenOrderSchema);
