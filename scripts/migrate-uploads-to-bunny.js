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
  { model: User, fields: ['avatarPhoto', 'bodyPhoto', 'bodyPhoto.original'] },
  { model: Product, fields: ['image'] },
  { model: TryOn, fields: ['image', 'transparentImage', 'video'], urlFields: ['imageProcessing.sourceImageUrl', 'imageProcessing.transparentImageUrl'] },
  { model: CustomTryOn, fields: ['garment', 'image', 'transparentImage'], urlFields: ['imageProcessing.sourceImageUrl', 'imageProcessing.transparentImageUrl'] },
  { model: ExternalTryOn, fields: ['image', 'transparentImage'], urlFields: ['imageProcessing.sourceImageUrl', 'imageProcessing.transparentImageUrl'] },
  { model: ClosetItem, fields: ['image'] },
  { model: ClosetOutfit, fields: ['garment', 'image', 'transparentImage'], urlFields: ['imageProcessing.sourceImageUrl', 'imageProcessing.transparentImageUrl'] }
];

function localUploadKey(value) {
  const raw = String(value || '').trim();
  return /^\/?uploads\//i.test(raw) ? raw.replace(/^\/+/, '') : '';
}

function shouldMigrate(file) {
  return Boolean(
    file &&
    file.storage !== 'bunny' &&
    !file.remoteUrl &&
    (localUploadKey(file.path) || localUploadKey(file.url))
  );
}

function mediaMigrationCandidates(doc, plan) {
  return [
    ...plan.fields.filter((field) => shouldMigrate(doc.get(field))),
    ...(plan.urlFields || []).filter((field) => localUploadKey(doc.get(field)))
  ];
}

async function migrateField({ doc, field, stats }) {
  const file = doc.get(field);
  if (!shouldMigrate(file)) return null;

  const path = localUploadKey(file.path) || localUploadKey(file.url);
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
    $or: [
      ...plan.fields.map((field) => ({ [`${field}.path`]: /^\/?uploads\// })),
      ...plan.fields.map((field) => ({ [`${field}.url`]: /^\/?uploads\// })),
      ...(plan.urlFields || []).map((field) => ({ [field]: /^\/?uploads\// }))
    ]
  };
  const docs = await plan.model.find(filter);
  for (const doc of docs) {
    const updates = {};
    for (const field of plan.fields) {
      const stored = await migrateField({ doc, field, stats });
      if (stored) {
        const value = doc.get(field);
        const existing = typeof value?.toObject === 'function' ? value.toObject() : value;
        updates[field] = { ...existing, ...stored };
      }
    }
    for (const field of plan.urlFields || []) {
      const key = localUploadKey(doc.get(field));
      if (!key) continue;
      let buffer;
      try {
        buffer = await fs.readFile(localPathForKey(key));
      } catch {
        stats.missing += 1;
        console.warn(`[migrate] missing local file ${doc.constructor.modelName}.${field} ${doc._id}: ${key}`);
        continue;
      }
      stats.candidates += 1;
      if (!apply) {
        console.log(`[migrate:dry-run] ${doc.constructor.modelName}.${field} ${doc._id}: ${key}`);
        continue;
      }
      const stored = await saveBuffer({ key, buffer });
      updates[field] = stored.url;
      stats.uploaded += 1;
    }
    if (updates.bodyPhoto && updates['bodyPhoto.original']) {
      updates.bodyPhoto.original = updates['bodyPhoto.original'];
      delete updates['bodyPhoto.original'];
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

if (process.argv[1]?.endsWith('migrate-uploads-to-bunny.js')) {
  main().catch(async (error) => {
    console.error('[migrate] failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

export { plans as mediaMigrationPlans, localUploadKey, mediaMigrationCandidates, shouldMigrate };
