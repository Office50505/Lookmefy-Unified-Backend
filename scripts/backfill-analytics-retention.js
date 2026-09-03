import dotenv from 'dotenv';
import mongoose from 'mongoose';
import UserEvent from '../server/models/UserEvent.js';
import UserSession from '../server/models/UserSession.js';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  const configuredDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 180);
  const days = Number.isFinite(configuredDays) && configuredDays > 0 ? configuredDays : 180;

  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'fitlook' });
  for (const model of [UserEvent, UserSession]) {
    const result = await model.updateMany(
      { purgeAt: { $exists: false } },
      [{ $set: { purgeAt: { $dateAdd: { startDate: '$createdAt', unit: 'day', amount: days } } } }]
    );
    console.log(`[analytics-retention] updated ${result.modifiedCount || 0} legacy ${model.collection.collectionName} records`);
  }
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[analytics-retention] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
