import dotenv from 'dotenv';
import mongoose from 'mongoose';
import AdminAuditLog from '../server/models/AdminAuditLog.js';
import User from '../server/models/User.js';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const apply = process.argv.includes('--apply');
const maximumCredits = 100;
const overLimitFilter = { tokens: { $gt: maximumCredits } };

async function creditSummary() {
  const [summary] = await User.aggregate([
    { $match: overLimitFilter },
    {
      $group: {
        _id: null,
        users: { $sum: 1 },
        totalBefore: { $sum: '$tokens' },
        highestBalance: { $max: '$tokens' }
      }
    }
  ]);
  const users = Number(summary?.users || 0);
  const totalBefore = Number(summary?.totalBefore || 0);
  return {
    users,
    totalBefore,
    highestBalance: Number(summary?.highestBalance || 0),
    creditsRemoved: Math.max(0, totalBefore - (users * maximumCredits))
  };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook',
    serverSelectionTimeoutMS: 10000
  });

  const before = await creditSummary();
  console.log(`[credit-cap] mode=${apply ? 'apply' : 'dry-run'} maximum=${maximumCredits}`);
  console.log(JSON.stringify({ before }, null, 2));
  if (!apply) {
    console.log('[credit-cap] no changes made; rerun with --apply to cap these balances');
    return;
  }

  const result = await User.updateMany(overLimitFilter, { $set: { tokens: maximumCredits } });
  const remainingAboveLimit = await User.countDocuments(overLimitFilter);
  const outcome = {
    matchedUsers: result.matchedCount || 0,
    modifiedUsers: result.modifiedCount || 0,
    creditsRemoved: before.creditsRemoved,
    remainingAboveLimit
  };
  console.log(JSON.stringify({ outcome }, null, 2));

  if (outcome.modifiedUsers > 0) {
    try {
      await AdminAuditLog.create({
        actorEmail: 'maintenance-script',
        action: 'credits_capped',
        entityType: 'user',
        entityId: 'bulk',
        label: `${maximumCredits}-credit cap`,
        detail: outcome
      });
    } catch (error) {
      console.warn('[credit-cap] balances were updated, but the audit record failed:', error.message);
    }
  }

  if (remainingAboveLimit !== 0) throw new Error(`${remainingAboveLimit} users remain above the credit cap`);
}

main()
  .catch((error) => {
    console.error('[credit-cap] failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
