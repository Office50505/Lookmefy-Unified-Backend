import mongoose from 'mongoose';

const tokenOrderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    merchantOrderId: { type: String, trim: true, required: true, unique: true },
    provider: { type: String, trim: true, lowercase: true, default: 'phonepe', index: true },
    phonePeOrderId: { type: String, trim: true },
    merchantSubscriptionId: { type: String, trim: true },
    razorpayOrderId: { type: String, trim: true, index: true },
    razorpaySubscriptionId: { type: String, trim: true, index: true },
    razorpayInvoiceId: { type: String, trim: true, index: true },
    razorpayPaymentId: { type: String, trim: true },
    razorpaySignature: { type: String, trim: true },
    razorpayMode: { type: String, enum: ['test', 'live'], default: 'test', index: true },
    planId: { type: String, trim: true, required: true },
    planName: { type: String, trim: true, required: true },
    orderType: {
      type: String,
      enum: ['subscription', 'topup', 'mandate_setup', 'subscription_renewal'],
      default: 'subscription',
      index: true
    },
    purchaseType: {
      type: String,
      enum: ['top_up', 'subscription_setup', 'subscription_renewal'],
      index: true
    },
    amount: { type: Number, required: true },
    dueTodayAmount: { type: Number },
    recurringAmount: { type: Number },
    billingFrequency: { type: String, trim: true },
    ratePerCredit: { type: Number, default: 0 },
    currency: { type: String, trim: true, uppercase: true, default: 'INR' },
    tokens: { type: Number, required: true },
    idempotencyKey: { type: String, trim: true },
    mandateId: { type: String, trim: true },
    parentOrderId: { type: String, trim: true },
    billingCycle: { type: Number, default: 0 },
    debitScheduledAt: Date,
    status: {
      type: String,
      enum: ['created', 'pending', 'completed', 'failed'],
      default: 'created',
      index: true
    },
    providerState: { type: String, trim: true },
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
tokenOrderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);
tokenOrderSchema.index({ createdAt: -1 });
tokenOrderSchema.index({ status: 1, createdAt: -1 });
tokenOrderSchema.index({ phonePeOrderId: 1 }, { sparse: true });
tokenOrderSchema.index({ merchantSubscriptionId: 1 }, { sparse: true });

tokenOrderSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    merchantOrderId: this.merchantOrderId,
    provider: this.provider || 'phonepe',
    phonePeOrderId: this.phonePeOrderId,
    merchantSubscriptionId: this.merchantSubscriptionId || '',
    razorpayOrderId: this.razorpayOrderId || '',
    razorpaySubscriptionId: this.razorpaySubscriptionId || '',
    razorpayInvoiceId: this.razorpayInvoiceId || '',
    razorpayPaymentId: this.razorpayPaymentId || '',
    razorpayMode: this.razorpayMode || 'test',
    planId: this.planId,
    planName: this.planName,
    orderType: this.orderType,
    purchaseType: this.purchaseType || '',
    amount: this.amount,
    dueTodayAmount: this.dueTodayAmount,
    recurringAmount: this.recurringAmount,
    billingFrequency: this.billingFrequency,
    ratePerCredit: this.ratePerCredit,
    currency: this.currency,
    tokens: this.tokens,
    mandateId: this.mandateId,
    parentOrderId: this.parentOrderId,
    billingCycle: this.billingCycle,
    debitScheduledAt: this.debitScheduledAt,
    status: this.status,
    providerState: this.providerState,
    redirectUrl: this.redirectUrl,
    creditedAt: this.creditedAt,
    currentPeriodStart: this.currentPeriodStart,
    currentPeriodEnd: this.currentPeriodEnd,
    createdAt: this.createdAt
  };
};

export default mongoose.model('TokenOrder', tokenOrderSchema);
