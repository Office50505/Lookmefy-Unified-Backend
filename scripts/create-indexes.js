import dotenv from 'dotenv';
import mongoose from 'mongoose';
import AdminAuditLog from '../server/models/AdminAuditLog.js';
import AdminUser from '../server/models/AdminUser.js';
import ClosetItem from '../server/models/ClosetItem.js';
import ClosetOutfit from '../server/models/ClosetOutfit.js';
import CustomTryOn from '../server/models/CustomTryOn.js';
import ExternalTryOn from '../server/models/ExternalTryOn.js';
import GenerationMetric from '../server/models/GenerationMetric.js';
import OtpDeliveryMetric from '../server/models/OtpDeliveryMetric.js';
import Product from '../server/models/Product.js';
import ProductOrder from '../server/models/ProductOrder.js';
import StorefrontSetting from '../server/models/StorefrontSetting.js';
import TokenOrder from '../server/models/TokenOrder.js';
import TryOn from '../server/models/TryOn.js';
import User from '../server/models/User.js';
import UserEvent from '../server/models/UserEvent.js';
import UserPreference from '../server/models/UserPreference.js';
import RequestMetric from '../server/models/RequestMetric.js';
import UserSession from '../server/models/UserSession.js';
import SystemIncident from '../server/models/SystemIncident.js';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const models = [
  AdminAuditLog,
  AdminUser,
  ClosetItem,
  ClosetOutfit,
  CustomTryOn,
  ExternalTryOn,
  GenerationMetric,
  OtpDeliveryMetric,
  Product,
  ProductOrder,
  StorefrontSetting,
  TokenOrder,
  TryOn,
  User,
  UserEvent,
  UserPreference,
  RequestMetric,
  UserSession,
  SystemIncident
];

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing. Set it before running index creation.');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });

  for (const model of models) {
    console.log(`[indexes] creating indexes for ${model.modelName}`);
    await model.createIndexes();
  }

  await mongoose.disconnect();
  console.log('[indexes] done');
}

main().catch(async (error) => {
  console.error('[indexes] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
