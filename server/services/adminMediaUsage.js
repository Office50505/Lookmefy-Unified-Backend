import mongoose from 'mongoose';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import CustomTryOn from '../models/CustomTryOn.js';
import ExternalTryOn from '../models/ExternalTryOn.js';
import Product from '../models/Product.js';
import TryOn from '../models/TryOn.js';
import User from '../models/User.js';
import { cleanKey, deleteStoredFile, listBunnyInventory, useBunny } from '../utils/storage.js';

const mediaSources = [
  { group: 'profile', Model: User, field: 'bodyPhoto', userField: '_id' },
  { group: 'profile', Model: User, field: 'bodyPhoto.original', userField: '_id' },
  { group: 'tryon', Model: TryOn, field: 'image' },
  { group: 'tryon', Model: TryOn, field: 'transparentImage' },
  { group: 'video', Model: TryOn, field: 'video' },
  { group: 'tryon', Model: CustomTryOn, field: 'image' },
  { group: 'tryon', Model: CustomTryOn, field: 'transparentImage' },
  { group: 'tryon', Model: ExternalTryOn, field: 'image' },
  { group: 'tryon', Model: ExternalTryOn, field: 'transparentImage' },
  { group: 'tryon', Model: ClosetOutfit, field: 'image' },
  { group: 'tryon', Model: ClosetOutfit, field: 'transparentImage' },
  { group: 'closet', Model: CustomTryOn, field: 'garment' },
  { group: 'closet', Model: ClosetOutfit, field: 'garment' },
  { group: 'closet', Model: ClosetItem, field: 'image' },
  { group: 'product', Model: Product, field: 'image', userField: null }
];

function storedFieldClause(field) {
  return {
    $or: [
      { [`${field}.path`]: { $type: 'string', $ne: '' } },
      { [`${field}.storage`]: { $in: ['bunny', 'local'] } }
    ]
  };
}

function withTotal(values) {
  return { ...values, all: Object.values(values).reduce((total, value) => total + Number(value || 0), 0) };
}

async function adminMediaUsage(userId = '') {
  const counts = { profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };
  const bytes = { profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };
  const bunnyBytes = { profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };
  const bunnyCounts = { profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };
  const unknownSize = { profile: 0, tryon: 0, video: 0, closet: 0, product: 0 };
  const results = await Promise.all(mediaSources.map(async (source) => {
    const userField = source.userField === null ? null : (source.userField || 'user');
    if (userId && !userField) return { group: source.group, count: 0, bytes: 0, bunnyBytes: 0, bunnyCount: 0, unknownSize: 0 };
    const clauses = [storedFieldClause(source.field)];
    if (userId) clauses.push({ [userField]: new mongoose.Types.ObjectId(userId) });
    const sizeField = `$${source.field}.size`;
    const storageField = `$${source.field}.storage`;
    const pathField = `$${source.field}.path`;
    const bunnyFile = useBunny()
      ? {
          $or: [
            { $eq: [storageField, 'bunny'] },
            {
              $and: [
                { $eq: [{ $ifNull: [storageField, ''] }, ''] },
                { $ne: [{ $ifNull: [pathField, ''] }, ''] }
              ]
            }
          ]
        }
      : { $eq: [storageField, 'bunny'] };
    const [result] = await source.Model.aggregate([
      { $match: clauses.length === 1 ? clauses[0] : { $and: clauses } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          bytes: { $sum: { $ifNull: [sizeField, 0] } },
          bunnyBytes: { $sum: { $cond: [bunnyFile, { $ifNull: [sizeField, 0] }, 0] } },
          bunnyCount: { $sum: { $cond: [bunnyFile, 1, 0] } },
          unknownSize: { $sum: { $cond: [{ $gt: [{ $ifNull: [sizeField, 0] }, 0] }, 0, 1] } }
        }
      }
    ]);
    return {
      group: source.group,
      count: Number(result?.count || 0),
      bytes: Number(result?.bytes || 0),
      bunnyBytes: Number(result?.bunnyBytes || 0),
      bunnyCount: Number(result?.bunnyCount || 0),
      unknownSize: Number(result?.unknownSize || 0)
    };
  }));

  results.forEach((result) => {
    counts[result.group] += result.count;
    bytes[result.group] += result.bytes;
    bunnyBytes[result.group] += result.bunnyBytes;
    bunnyCounts[result.group] += result.bunnyCount;
    unknownSize[result.group] += result.unknownSize;
  });

  return {
    counts: withTotal(counts),
    usage: {
      bytes: withTotal(bytes),
      bunnyBytes: withTotal(bunnyBytes),
      bunnyCounts: withTotal(bunnyCounts),
      unknownSize: withTotal(unknownSize)
    }
  };
}

function nestedValue(record, field) {
  return field.split('.').reduce((value, key) => value?.[key], record);
}

function bunnyBacked(file) {
  return Boolean(file?.path && (file.storage === 'bunny' || (!file.storage && useBunny())));
}

async function referencedBunnyKeys() {
  const references = new Map();
  for (const source of mediaSources) {
    const cursor = source.Model.find(storedFieldClause(source.field)).select({ [source.field]: 1 }).lean().cursor();
    for await (const record of cursor) {
      const file = nestedValue(record, source.field);
      if (!bunnyBacked(file)) continue;
      const key = cleanKey(file.path);
      if (!key) continue;
      const current = references.get(key) || [];
      current.push({ model: source.Model.modelName, id: String(record._id), field: source.field, group: source.group });
      references.set(key, current);
    }
  }
  return references;
}

async function reconcileBunnyInventory() {
  if (!useBunny()) return { configured: false, reason: 'Bunny storage is not enabled' };
  const [inventory, references] = await Promise.all([listBunnyInventory(), referencedBunnyKeys()]);
  const filesByKey = new Map(inventory.files.map((file) => [cleanKey(file.key), file]));
  const orphans = inventory.files
    .filter((file) => !references.has(cleanKey(file.key)))
    .map((file) => ({ ...file, key: cleanKey(file.key) }))
    .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
  const missing = [...references.entries()]
    .filter(([key]) => !filesByKey.has(key))
    .map(([key, refs]) => ({ key, references: refs }));
  return {
    configured: true,
    generatedAt: new Date(),
    scannedFiles: inventory.files.length,
    scannedBytes: inventory.files.reduce((sum, file) => sum + Number(file.size || 0), 0),
    referencedFiles: references.size,
    orphanFiles: orphans.length,
    orphanBytes: orphans.reduce((sum, file) => sum + Number(file.size || 0), 0),
    missingFiles: missing.length,
    orphans: orphans.slice(0, 500),
    missing: missing.slice(0, 500),
    truncated: inventory.truncated || orphans.length > 500 || missing.length > 500,
    limits: { maxFiles: inventory.maxFiles, maxDepth: inventory.maxDepth }
  };
}

async function deleteBunnyOrphans(keys = []) {
  const requested = [...new Set(keys.map(cleanKey).filter(Boolean))];
  if (!requested.length) throw new Error('Select at least one orphan file');
  if (requested.length > 100) throw new Error('At most 100 orphan files can be deleted at once');
  const reconciliation = await reconcileBunnyInventory();
  if (!reconciliation.configured) throw new Error(reconciliation.reason || 'Bunny storage is not configured');
  if (reconciliation.truncated) {
    throw new Error('Orphan deletion is disabled because the Bunny inventory scan was truncated');
  }
  const orphanByKey = new Map(reconciliation.orphans.map((file) => [file.key, file]));
  const minAgeDays = Math.max(1, Number(process.env.MEDIA_ORPHAN_DELETE_MIN_AGE_DAYS || 7));
  const cutoff = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
  const selected = requested.map((key) => {
    const file = orphanByKey.get(key);
    if (!file) throw new Error(`${key} is not a currently verified orphan`);
    const createdAt = new Date(file.createdAt || file.updatedAt || 0).getTime();
    if (!createdAt || createdAt > cutoff) throw new Error(`${key} is newer than the ${minAgeDays}-day safety window`);
    return file;
  });
  await Promise.all(selected.map((file) => deleteStoredFile({ path: file.key, storage: 'bunny' })));
  return {
    deleted: selected.map((file) => ({ key: file.key, size: file.size })),
    deletedBytes: selected.reduce((sum, file) => sum + Number(file.size || 0), 0),
    minAgeDays
  };
}

export { adminMediaUsage, deleteBunnyOrphans, reconcileBunnyInventory, referencedBunnyKeys };
