import express from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import ProductOrder from '../models/ProductOrder.js';
import { getStorefrontSetting } from '../models/StorefrontSetting.js';
import { recordAdminAudit } from '../utils/adminAudit.js';
import { requireAdmin, requireAdminSection } from '../utils/adminAccess.js';
import { ADMIN_SECTIONS } from '../utils/adminPermissions.js';
import { lookupPincode, normalizeIndiaState, normalizePincode } from '../utils/indiaPincode.js';
import { normalizeIndianMobile } from '../utils/phone.js';
import { availableStatusClause } from '../utils/productAvailability.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { validateConfiguredHttpsUrl } from '../utils/urlValidation.js';
import { requireUser } from './auth.js';
import {
  callbackAuthorizationHeader,
  checkoutIdempotencyKey,
  createMerchantOrderId,
  orderIdFromCallback,
  phonePeFetch,
  readablePhonePeError,
  requirePhonePeCallbackConfig,
  requirePhonePeConfig,
  validatePhonePeCallbackAuth
} from './payments.js';

const router = express.Router();
const requireUserOperationsAdmin = requireAdminSection(ADMIN_SECTIONS.USER_OPERATIONS);

const disableDemoCheckoutRateLimit = () => ['1', 'true', 'yes'].includes(String(process.env.DISABLE_DEMO_CHECKOUT_RATE_LIMIT || '').trim().toLowerCase());
const orderCreateLimiter = createRateLimiter({
  name: 'orders:create',
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Too many checkout attempts. Please wait a few minutes before trying again.',
  skip: disableDemoCheckoutRateLimit
});
const orderStatusLimiter = createRateLimiter({
  name: 'orders:status',
  windowMs: 5 * 60 * 1000,
  max: 40,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Order status checks are temporarily limited. Please try again shortly.'
});

function ensureDemoMode(setting) {
  if (!setting?.demoEcommerceMode) {
    const error = new Error('Product checkout is not enabled right now');
    error.statusCode = 404;
    throw error;
  }
}

function orderOwnerFilter(req) {
  return { _id: req.params.id, user: req.user._id };
}

function cleanText(value = '', limit = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function validEmail(value = '') {
  const email = cleanText(value, 180).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function orderContact(input = {}) {
  const fullName = cleanText(input.fullName, 120);
  const mobile = normalizeIndianMobile(input.mobile || input.phone);
  const email = validEmail(input.email);
  if (!fullName) throw new Error('Full name is required');
  if (!mobile) throw new Error('Enter a valid Indian mobile number');
  return { fullName, mobile, email };
}

function orderAddress(input = {}) {
  const pincode = normalizePincode(input.pincode);
  const pin = lookupPincode(pincode);
  const state = normalizeIndiaState(input.state) || normalizeIndiaState(pin?.state);
  const city = cleanText(input.city || pin?.city, 80);
  const houseStreet = cleanText(input.houseStreet, 180);
  if (!houseStreet) throw new Error('House / flat and street is required');
  if (!pincode) throw new Error('Enter a 6-digit pincode');
  if (!pin?.serviceable) throw new Error('This pincode is not serviceable yet');
  if (!city) throw new Error('City is required');
  if (!state) throw new Error('Choose a valid Indian state');
  return {
    houseStreet,
    area: cleanText(input.area, 120),
    landmark: cleanText(input.landmark, 120),
    city,
    district: cleanText(pin?.district, 80),
    state,
    pincode,
    country: 'India'
  };
}

function productImageUrl(product) {
  return product.image?.url || (product.image?.path ? `/${product.image.path}` : product.image?.remoteUrl || '');
}

async function orderItems(inputItems = []) {
  const requested = Array.isArray(inputItems) ? inputItems.slice(0, 10) : [];
  if (!requested.length) throw new Error('Add at least one product before checkout');
  const productIds = requested.map((item) => String(item.productId || item.id || '').trim());
  if (productIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw new Error('One or more cart products are invalid');
  const ids = [...new Set(productIds)];
  const products = await Product.find({ _id: { $in: ids }, isActive: true, $and: [availableStatusClause()] }).lean();
  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const items = requested.map((item) => {
    const productId = String(item.productId || item.id);
    const product = productsById.get(productId);
    if (!product) throw new Error('One or more products are unavailable');
    const quantity = Math.min(10, Math.max(1, Number.parseInt(item.quantity, 10) || 1));
    const unitPrice = Math.round(Number(product.price || 0) * 100) / 100;
    const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
    return {
      product: product._id,
      name: product.name,
      brand: product.brand || '',
      category: product.category || '',
      imageUrl: productImageUrl(product),
      variant: cleanText(item.variant, 80) || 'Standard',
      quantity,
      unitPrice,
      lineTotal,
      currency: product.currency || 'INR'
    };
  });
  const currency = items[0]?.currency || 'INR';
  if (items.some((item) => item.currency !== currency)) throw new Error('Cart items must use one currency');
  return items;
}

function productRedirectUrl(req, order) {
  const configured = process.env.CLIENT_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const origin = validateConfiguredHttpsUrl(configured, {
    name: 'CLIENT_ORIGIN',
    env: process.env,
    requireHttpsInProduction: true
  }).origin;
  const url = new URL(`/order/${order._id}/status`, origin);
  url.searchParams.set('merchantOrderId', order.merchantOrderId);
  return url.toString();
}

function phonePeProductStatus(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'COMPLETED') return 'paid';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'TIMEOUT', 'TIMED_OUT'].includes(normalized)) return 'failed';
  if (normalized === 'PENDING') return 'pending';
  return '';
}

async function createProductPayment(req, order) {
  requirePhonePeConfig();
  order.paymentMode = 'phonepe';
  if (!order.merchantOrderId) order.merchantOrderId = createMerchantOrderId(order._id).replace(/^FL_/, 'LFPO_');
  const redirectUrl = productRedirectUrl(req, order);
  const amount = Math.round(Number(order.total || 0) * 100);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Order total is invalid');

  const payload = {
    merchantOrderId: order.merchantOrderId,
    amount,
    expireAfter: Number(process.env.PHONEPE_ORDER_EXPIRE_SECONDS || 1200),
    paymentFlow: {
      type: 'PG_CHECKOUT',
      message: `Lookmefy order ${order._id}`,
      merchantUrls: { redirectUrl }
    },
    metaInfo: {
      udf1: order._id.toString(),
      udf2: 'product-order',
      udf3: String(order.items?.length || 0),
      udf4: 'Lookmefy',
      udf5: order.paymentStatus
    }
  };

  const data = await phonePeFetch('/checkout/v2/pay', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  order.paymentStatus = 'pending';
  order.providerState = data.state || 'PENDING';
  order.phonePeOrderId = data.orderId;
  order.redirectUrl = data.redirectUrl || redirectUrl;
  order.providerResponse = data;
  await order.save();
  return order;
}

async function markDemoOrderSuccessful(order) {
  if (!order) return null;
  if (order.paymentStatus === 'paid' && order.paymentMode === 'demo') return order;
  const paidOrder = await ProductOrder.findOneAndUpdate(
    { _id: order._id, paidAt: null },
    {
      $set: {
        paymentMode: 'demo',
        paymentStatus: 'paid',
        providerState: 'DEMO_COMPLETED',
        providerResponse: {
          mode: 'demo',
          message: 'Demo checkout completed without external payment gateway'
        },
        paidAt: new Date()
      },
      $unset: {
        redirectUrl: '',
        phonePeOrderId: ''
      }
    },
    { new: true }
  );
  return paidOrder || ProductOrder.findById(order._id);
}

async function reconcileProductOrder(order) {
  if (!order) return null;
  if (order.paidAt && order.paymentStatus === 'paid') return order;
  const status = await phonePeFetch(`/checkout/v2/order/${encodeURIComponent(order.merchantOrderId)}/status?details=true&errorContext=true`);
  const state = String(status.state || '').toUpperCase();
  if (state === 'COMPLETED') {
    const paidOrder = await ProductOrder.findOneAndUpdate(
      { _id: order._id, paidAt: null },
      { $set: { paymentStatus: 'paid', providerState: 'COMPLETED', providerResponse: status, paidAt: new Date() } },
      { new: true }
    );
    return paidOrder || ProductOrder.findById(order._id);
  }
  order.providerState = state || order.providerState;
  order.providerResponse = status;
  order.paymentStatus = phonePeProductStatus(state) || order.paymentStatus;
  await order.save();
  return order;
}

router.get('/pincode/:pincode', orderStatusLimiter, async (req, res) => {
  const pin = lookupPincode(req.params.pincode);
  if (!pin) return res.status(400).json({ message: 'Enter a 6-digit pincode' });
  res.json(pin);
});

router.post('/', requireUser, orderCreateLimiter, async (req, res) => {
  try {
    ensureDemoMode(await getStorefrontSetting());
    const items = await orderItems(req.body?.items);
    const subtotal = Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) / 100;
    const deliveryFee = 0;
    const order = await ProductOrder.create({
      user: req.user._id,
      items,
      contact: orderContact(req.body?.contact),
      address: orderAddress(req.body?.address),
      subtotal,
      deliveryFee,
      total: Math.round((subtotal + deliveryFee) * 100) / 100,
      currency: items[0]?.currency || 'INR',
      idempotencyKey: checkoutIdempotencyKey(req) || undefined
    });
    res.status(201).json({ order: order.toClient() });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message || 'Could not create order' });
  }
});

router.get('/:id', requireUser, orderStatusLimiter, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
  const order = await ProductOrder.findOne(orderOwnerFilter(req));
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json({ order: order.toClient() });
});

router.post('/:id/payment', requireUser, orderCreateLimiter, async (req, res) => {
  try {
    ensureDemoMode(await getStorefrontSetting());
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await ProductOrder.findOne(orderOwnerFilter(req));
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.paymentStatus === 'paid') return res.json({ order: order.toClient(), redirectUrl: order.redirectUrl || '' });
    const paidOrder = await markDemoOrderSuccessful(order);
    res.status(201).json({ order: paidOrder.toClient(), redirectUrl: '' });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message || 'Could not complete demo checkout' });
  }
});

router.post('/:id/demo-success', requireUser, orderCreateLimiter, async (req, res) => {
  try {
    ensureDemoMode(await getStorefrontSetting());
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await ProductOrder.findOne(orderOwnerFilter(req));
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const paidOrder = await markDemoOrderSuccessful(order);
    res.json({ order: paidOrder.toClient() });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: error.message || 'Could not complete demo checkout' });
  }
});

router.get('/:id/payment-status', requireUser, orderStatusLimiter, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await ProductOrder.findOne(orderOwnerFilter(req));
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const next = order.merchantOrderId && order.paymentStatus !== 'created'
      ? await reconcileProductOrder(order)
      : order;
    res.json({ order: next.toClient() });
  } catch (error) {
    res.status(error.statusCode || 400).json({ message: readablePhonePeError(error, 'Could not verify product payment') });
  }
});

router.post('/phonepe/callback', async (req, res) => {
  try {
    requirePhonePeCallbackConfig();
    const authorization = callbackAuthorizationHeader(req);
    if (!validatePhonePeCallbackAuth(authorization)) return res.status(401).json({ ok: false });
  } catch (error) {
    return res.status(503).json({ ok: false, message: readablePhonePeError(error, 'PhonePe callback verification is not configured') });
  }
  const id = orderIdFromCallback(req);
  const order = id ? await ProductOrder.findOne({ $or: [{ merchantOrderId: id }, { phonePeOrderId: id }] }) : null;
  if (!order) return res.status(202).json({ ok: true });
  res.status(202).json({ ok: true });
  setImmediate(async () => {
    try {
      await reconcileProductOrder(order);
    } catch (error) {
      console.error('[product-order:phonepe:callback:bg]', readablePhonePeError(error));
    }
  });
});

router.get('/admin/list', requireAdmin, requireUserOperationsAdmin, orderStatusLimiter, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 10_000);
  const query = cleanText(req.query.q, 120);
  const paymentStatus = cleanText(req.query.paymentStatus, 40);
  const fulfillmentStatus = cleanText(req.query.fulfillmentStatus, 40);
  const filter = {};
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (fulfillmentStatus) filter.fulfillmentStatus = fulfillmentStatus;
  if (query) {
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { merchantOrderId: regex },
      { phonePeOrderId: regex },
      { 'contact.fullName': regex },
      { 'contact.email': regex },
      { 'contact.mobile': regex },
      { 'address.pincode': regex }
    ];
    if (mongoose.Types.ObjectId.isValid(query)) filter.$or.push({ _id: new mongoose.Types.ObjectId(query) });
  }
  const [orders, total] = await Promise.all([
    ProductOrder.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    ProductOrder.countDocuments(filter)
  ]);
  res.json({
    orders: orders.map((order) => order.toClient()),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }
  });
});

router.patch('/admin/:id/status', requireAdmin, requireUserOperationsAdmin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'Invalid order id' });
  const fulfillmentStatus = cleanText(req.body?.fulfillmentStatus, 40);
  if (!['new', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(fulfillmentStatus)) {
    return res.status(400).json({ message: 'Invalid fulfillment status' });
  }
  const order = await ProductOrder.findByIdAndUpdate(req.params.id, { fulfillmentStatus }, { new: true });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  await recordAdminAudit(req, {
    action: 'product_order_status_changed',
    entityType: 'product_order',
    entityId: order._id.toString(),
    label: order.merchantOrderId || order._id.toString(),
    detail: { fulfillmentStatus }
  });
  res.json({ order: order.toClient() });
});

export {
  createProductPayment,
  markDemoOrderSuccessful,
  orderAddress,
  orderContact,
  orderItems,
  phonePeProductStatus,
  reconcileProductOrder
};

export default router;
