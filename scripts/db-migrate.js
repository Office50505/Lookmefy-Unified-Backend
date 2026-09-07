import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Migration from '../server/models/Migration.js';

dotenv.config({ path: process.env.ENV_FILE || '.env' });

const migrationsDir = path.resolve('migrations');
const command = String(process.argv[2] || 'up').trim().toLowerCase();

async function migrationFiles() {
  const entries = await fs.readdir(migrationsDir).catch(() => []);
  return entries
    .filter((file) => /^\d{12,}_[a-z0-9-]+\.js$/i.test(file))
    .sort()
    .map((file) => path.join(migrationsDir, file));
}

async function checksum(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function loadMigration(file) {
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.up !== 'function') throw new Error(`${path.basename(file)} must export up()`);
  return {
    id: path.basename(file, '.js'),
    description: String(mod.description || '').trim(),
    up: mod.up,
    checksum: await checksum(file)
  };
}

async function status() {
  const files = await migrationFiles();
  const applied = await Migration.find({}).lean();
  const byId = new Map(applied.map((row) => [row.id, row]));
  files.forEach((file) => {
    const id = path.basename(file, '.js');
    const row = byId.get(id);
    console.log(`${row?.status || 'pending'} ${id}${row?.appliedAt ? ` ${row.appliedAt.toISOString()}` : ''}`);
  });
}

async function applyMigrations() {
  const files = await migrationFiles();
  for (const file of files) {
    const migration = await loadMigration(file);
    const existing = await Migration.findOne({ id: migration.id }).lean();
    if (existing?.status === 'applied') {
      if (existing.checksum !== migration.checksum) {
        throw new Error(`Applied migration checksum changed: ${migration.id}`);
      }
      continue;
    }
    const startedAt = new Date();
    try {
      await migration.up({ mongoose });
      await Migration.findOneAndUpdate(
        { id: migration.id },
        {
          $set: {
            description: migration.description,
            checksum: migration.checksum,
            status: 'applied',
            appliedAt: new Date(),
            failedAt: null,
            error: ''
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`[migrate] applied ${migration.id}`);
    } catch (error) {
      await Migration.findOneAndUpdate(
        { id: migration.id },
        {
          $set: {
            description: migration.description,
            checksum: migration.checksum,
            status: 'failed',
            failedAt: startedAt,
            error: String(error.message || error).slice(0, 800)
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      throw error;
    }
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'fitlook' });
  await Migration.createIndexes();
  if (command === 'status') await status();
  else if (command === 'up') await applyMigrations();
  else throw new Error('Usage: node scripts/db-migrate.js [up|status]');
}

main()
  .catch((error) => {
    console.error('[migrate] failed:', error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
