import dotenv from 'dotenv';
import mongoose from 'mongoose';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CreditEvent from '../models/CreditEvent.js';
import CustomTryOn from '../models/CustomTryOn.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import Job from '../models/Job.js';
import Product from '../models/Product.js';
import TokenOrder from '../models/TokenOrder.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const models = [
  ClosetItem,
  ClosetOutfit,
  CreditEvent,
  CustomTryOn,
  ExternalTryOn,
  Job,
  Product,
  TokenOrder,
  TryOn,
  User,
  UserEvent,
  UserPreference
];

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });

  for (const model of models) {
    logger.info('mongo_create_indexes_start', { model: model.modelName });
    await model.createIndexes();
    logger.info('mongo_create_indexes_done', { model: model.modelName });
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  logger.error('mongo_create_indexes_failed', { error });
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
