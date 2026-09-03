import mongoose from 'mongoose';

const orderItemSchema = {
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, trim: true, required: true },
  brand: { type: String, trim: true, default: '' },
  category: { type: String, trim: true, default: '' },
  imageUrl: { type: String, trim: true, default: '' },
  variant: { type: String, trim: true, default: 'Standard' },
  quantity: { type: Number, required: true, min: 1, max: 10 },
  unitPrice: { type: Number, required: true, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'INR' }
};

const productOrderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    items: { type: [orderItemSchema], validate: (items) => Array.isArray(items) && items.length > 0 },
    contact: {
      fullName: { type: String, trim: true, required: true },
      mobile: { type: String, trim: true, required: true },
      email: { type: String, trim: true, lowercase: true, default: '' }
    },
    address: {
      houseStreet: { type: String, trim: true, required: true },
      area: { type: String, trim: true, default: '' },
      landmark: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, required: true },
      district: { type: String, trim: true, default: '' },
      state: { type: String, trim: true, required: true },
      pincode: { type: String, trim: true, required: true },
      country: { type: String, trim: true, default: 'India' }
    },
    subtotal: { type: Number, required: true, min: 0 },
    deliveryFee: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: 'INR' },
    paymentMode: {
      type: String,
      enum: ['demo', 'phonepe'],
      default: 'demo',
      index: true
    },
    paymentStatus: {
      type: String,
      enum: ['created', 'pending', 'paid', 'failed', 'cancelled', 'refunded'],
      default: 'created',
      index: true
    },
    fulfillmentStatus: {
      type: String,
      enum: ['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'],
      default: 'new',
      index: true
    },
    merchantOrderId: { type: String, trim: true, unique: true, sparse: true },
    phonePeOrderId: { type: String, trim: true },
    idempotencyKey: { type: String, trim: true },
    providerState: { type: String, trim: true },
    redirectUrl: { type: String, trim: true },
    paidAt: Date,
    providerResponse: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

productOrderSchema.index({ createdAt: -1 });
productOrderSchema.index({ user: 1, createdAt: -1 });
productOrderSchema.index({ paymentStatus: 1, createdAt: -1 });
productOrderSchema.index({ fulfillmentStatus: 1, createdAt: -1 });
productOrderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { user: { $exists: true }, idempotencyKey: { $type: 'string' } } }
);

productOrderSchema.methods.toClient = function toClient() {
  return {
    id: this._id.toString(),
    items: (this.items || []).map((item) => ({
      productId: item.product?.toString?.() || String(item.product || ''),
      name: item.name,
      brand: item.brand || '',
      category: item.category || '',
      imageUrl: item.imageUrl || '',
      variant: item.variant || 'Standard',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      currency: item.currency || this.currency || 'INR'
    })),
    contact: this.contact,
    address: this.address,
    subtotal: this.subtotal,
    deliveryFee: this.deliveryFee,
    total: this.total,
    currency: this.currency || 'INR',
    paymentMode: this.paymentMode || 'demo',
    paymentStatus: this.paymentStatus,
    fulfillmentStatus: this.fulfillmentStatus,
    merchantOrderId: this.merchantOrderId || '',
    phonePeOrderId: this.phonePeOrderId || '',
    providerState: this.providerState || '',
    redirectUrl: this.redirectUrl || '',
    paidAt: this.paidAt || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

export default mongoose.model('ProductOrder', productOrderSchema);
