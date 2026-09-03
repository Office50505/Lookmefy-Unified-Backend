import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Product from '../server/models/Product.js';
import User from '../server/models/User.js';

dotenv.config();

const apply = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'fitlook' });

  const checks = {
    negativeTokenUsers: await User.countDocuments({ tokens: { $lt: 0 } }),
    usersMissingStatus: await User.countDocuments({ accountStatus: { $exists: false } }),
    activeProductsMissingAvailability: await Product.countDocuments({ availabilityStatus: { $exists: false }, isActive: { $ne: false } }),
    inactiveProductsMissingAvailability: await Product.countDocuments({ availabilityStatus: { $exists: false }, isActive: false })
  };

  console.log(`[repair] mode=${apply ? 'apply' : 'dry-run'}`);
  console.log(JSON.stringify(checks, null, 2));
  if (!apply) {
    console.log('[repair] no changes made; rerun with --apply to repair these records');
    return;
  }

  const now = new Date();
  const [tokens, users, availableProducts, archivedProducts] = await Promise.all([
    User.updateMany({ tokens: { $lt: 0 } }, { $set: { tokens: 0 } }),
    User.updateMany({ accountStatus: { $exists: false } }, { $set: { accountStatus: 'active' } }),
    Product.updateMany(
      { availabilityStatus: { $exists: false }, isActive: { $ne: false } },
      { $set: { availabilityStatus: 'available', availabilityCheckedAt: now, availabilitySource: 'migration' } }
    ),
    Product.updateMany(
      { availabilityStatus: { $exists: false }, isActive: false },
      { $set: { availabilityStatus: 'archived', availabilityCheckedAt: now, availabilitySource: 'migration' } }
    )
  ]);

  console.log(JSON.stringify({
    tokenBalancesRepaired: tokens.modifiedCount || 0,
    userStatusesBackfilled: users.modifiedCount || 0,
    availableProductsBackfilled: availableProducts.modifiedCount || 0,
    archivedProductsBackfilled: archivedProducts.modifiedCount || 0
  }, null, 2));
}

main()
  .catch((error) => {
    console.error('[repair] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
