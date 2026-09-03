#!/usr/bin/env node
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { importProducts, REPLACE_CONFIRMATION } from '../server/services/product-import.js';

dotenv.config();

function parseArgs(argv) {
  const args = {
    provider: 'url-manifest',
    batchNumber: 1,
    commit: false,
    replaceExisting: false,
    dryRun: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--input') args.input = next, index += 1;
    else if (arg === '--provider') args.provider = next, index += 1;
    else if (arg === '--batch-number') args.batchNumber = Number(next), index += 1;
    else if (arg === '--confirm') args.confirm = next, index += 1;
    else if (arg === '--commit') args.commit = true, args.dryRun = false;
    else if (arg === '--dry-run') args.commit = false, args.dryRun = true;
    else if (arg === '--replace-existing') args.replaceExisting = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run catalog:import -- --input data/products.csv --dry-run
  npm run catalog:import -- --input data/products.csv --commit
  npm run catalog:import -- --input data/products.csv --commit --replace-existing --confirm ${REPLACE_CONFIRMATION}

Notes:
  Dry-run is the default.
  URL manifest mode imports Amazon product/SiteStripe links directly into MongoDB.
  The amazon-api provider is disabled until official Amazon API credentials are configured.
`);
}

async function connectMongo() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing. Add it to .env before running the importer.');
  }
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });
}

async function closeMongo() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  await connectMongo();
  const { report, reportPath } = await importProducts(args);
  console.log(JSON.stringify({
    dryRun: report.dryRun,
    provider: report.provider,
    attempted: report.attempted,
    inserted: report.inserted,
    updated: report.updated,
    failed: report.failed,
    reportPath
  }, null, 2));
}

process.once('SIGINT', async () => {
  await closeMongo();
  process.exit(130);
});

process.once('SIGTERM', async () => {
  await closeMongo();
  process.exit(143);
});

main()
  .catch((error) => {
    console.error((error?.message || 'Importer failed').replace(/mongodb(\+srv)?:\/\/[^@]+@/gi, 'mongodb$1://[redacted]@'));
    process.exitCode = 1;
  })
  .finally(closeMongo);
