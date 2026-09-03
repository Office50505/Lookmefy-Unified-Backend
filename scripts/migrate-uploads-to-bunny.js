import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import ClosetItem from '../server/models/ClosetItem.js';
import ClosetOutfit from '../server/models/ClosetOutfit.js';
import CustomTryOn from '../server/models/CustomTryOn.js';
import ExternalTryOn from '../server/models/ExternalTryOn.js';
import Product from '../server/models/Product.js';
import TryOn from '../server/models/TryOn.js';
import User from '../server/models/User.js';
import { localPathForKey, saveBuffer } from '../server/utils/storage.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const plans = [
  { model: User, fields: ['bodyPhoto'] },
  { model: Product, fields: ['image'] },
  { model: TryOn, fields: ['image', 'transparentImage', 'video'] },
  { model: CustomTryOn, fields: ['garment', 'image', 'transparentImage'] },
  { model: ExternalTryOn, fields: ['image', 'transparentImage'] },
  { model: ClosetItem, fields: ['image'] },
  { model: ClosetOutfit, fields: ['garment', 'image', 'transparentImage'] }
];

function shouldMigrate(file) {
  return Boolean(
    file &&
    file.path &&
    !file.url &&
    file.storage !== 'bunny' &&
    !file.remoteUrl &&
    String(file.path).replace(/^\/+/, '').startsWith('uploads/')
  );
}

async function migrateField({ doc, field, stats }) {
  const file = doc[field];
  if (!shouldMigrate(file)) return null;

  const path = file.path;
  let buffer;
  try {
    buffer = await fs.readFile(localPathForKey(path));
  } catch {
    stats.missing += 1;
    console.warn(`[migrate] missing local file ${doc.constructor.modelName}.${field} ${doc._id}: ${path}`);
    return null;
  }

  stats.candidates += 1;
  if (!apply) {
    console.log(`[migrate:dry-run] ${doc.constructor.modelName}.${field} ${doc._id}: ${path}`);
    return null;
  }

  const stored = await saveBuffer({
    key: path,
    buffer,
    mimetype: file.mimetype || 'application/octet-stream',
    filename: file.filename
  });
  stats.uploaded += 1;
  return stored;
}

async function migrateModel(plan, stats) {
  const filter = {
    $or: plan.fields.map((field) => ({
      [`${field}.path`]: /^uploads\//,
      [`${field}.url`]: { $exists: false },
      [`${field}.storage`]: { $ne: 'bunny' }
    }))
  };
  const docs = await plan.model.find(filter);
  for (const doc of docs) {
    const updates = {};
    for (const field of plan.fields) {
      const stored = await migrateField({ doc, field, stats });
      if (stored) {
        const existing = typeof doc[field]?.toObject === 'function' ? doc[field].toObject() : doc[field];
        updates[field] = { ...existing, ...stored };
      }
    }
    if (Object.keys(updates).length) {
      await plan.model.updateOne({ _id: doc._id }, { $set: updates });
      stats.updated += 1;
      console.log(`[migrate] updated ${plan.model.modelName} ${doc._id}`);
    }
  }
}

async function main() {
  if (process.env.STORAGE_PROVIDER !== 'bunny') {
    throw new Error('Set STORAGE_PROVIDER=bunny before migrating uploads.');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing.');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });

  const stats = { candidates: 0, uploaded: 0, updated: 0, missing: 0 };
  console.log(`[migrate] mode=${apply ? 'apply' : 'dry-run'}`);
  for (const plan of plans) await migrateModel(plan, stats);
  await mongoose.disconnect();
  console.log(`[migrate] done ${JSON.stringify(stats)}`);
  if (!apply) console.log('[migrate] dry run only. Re-run with --apply to update Mongo records.');
}

main().catch(async (error) => {
  console.error('[migrate] failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
