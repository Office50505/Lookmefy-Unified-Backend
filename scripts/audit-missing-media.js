import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { mediaMigrationPlans, localUploadKey } from './migrate-uploads-to-bunny.js';
import {
  bunnyObjectExists,
  cleanKey,
  localPathForKey,
  pathForKey,
  useBunny
} from '../server/utils/storage.js';

dotenv.config();

const STATUS = {
  LOCAL_PRESENT: 'LOCAL_PRESENT',
  BUNNY_PRESENT: 'BUNNY_PRESENT',
  MISSING_EVERYWHERE: 'MISSING_EVERYWHERE'
};

const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
const sampleLimitArg = process.argv.find((arg) => arg.startsWith('--sample-limit='));
const sampleLimit = Math.min(Math.max(Number(sampleLimitArg?.split('=')[1] || 25), 0), 500);

function supportedFieldGroup(modelName, field) {
  if (modelName === 'User' && ['avatarPhoto', 'bodyPhoto', 'bodyPhoto.original'].includes(field)) {
    return `User/${field}`;
  }
  return `${modelName}/${field}`;
}

function emptyCounts() {
  return {
    total_references: 0,
    unique_paths: 0,
    local_present: 0,
    bunny_present: 0,
    missing_everywhere: 0
  };
}

function incrementStatus(counts, status) {
  if (status === STATUS.LOCAL_PRESENT) counts.local_present += 1;
  else if (status === STATUS.BUNNY_PRESENT) counts.bunny_present += 1;
  else if (status === STATUS.MISSING_EVERYWHERE) counts.missing_everywhere += 1;
}

function getFieldValue(doc, field) {
  return typeof doc.get === 'function' ? doc.get(field) : field.split('.').reduce((value, key) => value?.[key], doc);
}

function localStyleReferenceFromField(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const key = localUploadKey(value);
    return key ? { raw: value, path: key, sourceProperty: 'value' } : null;
  }
  const pathKey = localUploadKey(value.path);
  if (pathKey) return { raw: value.path, path: pathKey, sourceProperty: 'path' };
  const urlKey = localUploadKey(value.url);
  if (urlKey) return { raw: value.url, path: urlKey, sourceProperty: 'url' };
  return null;
}

function migrationFilter(plan) {
  return {
    $or: [
      ...plan.fields.map((field) => ({ [`${field}.path`]: /^\/?uploads\// })),
      ...plan.fields.map((field) => ({ [`${field}.url`]: /^\/?uploads\// })),
      ...(plan.urlFields || []).map((field) => ({ [field]: /^\/?uploads\// }))
    ]
  };
}

function classifyFromBooleans({ localPresent, bunnyPresent }) {
  if (localPresent) return STATUS.LOCAL_PRESENT;
  if (bunnyPresent) return STATUS.BUNNY_PRESENT;
  return STATUS.MISSING_EVERYWHERE;
}

async function localExists(uploadPath) {
  try {
    await fs.access(localPathForKey(uploadPath));
    return true;
  } catch {
    return false;
  }
}

async function classifyUniquePath(uploadPath) {
  const localPresent = await localExists(uploadPath);
  if (localPresent) {
    return {
      status: STATUS.LOCAL_PRESENT,
      localPresent,
      bunnyPresent: false,
      storedPath: pathForKey(uploadPath),
      bunnyObjectKey: cleanKey(uploadPath)
    };
  }

  const bunnyPresent = await bunnyObjectExists(uploadPath);
  return {
    status: classifyFromBooleans({ localPresent, bunnyPresent }),
    localPresent,
    bunnyPresent,
    storedPath: pathForKey(uploadPath),
    bunnyObjectKey: cleanKey(uploadPath)
  };
}

async function collectReferences() {
  const references = [];
  for (const plan of mediaMigrationPlans) {
    const docs = await plan.model.find(migrationFilter(plan));
    for (const doc of docs) {
      for (const field of plan.fields) {
        const reference = localStyleReferenceFromField(getFieldValue(doc, field));
        if (!reference) continue;
        references.push({
          model: plan.model.modelName,
          collection: plan.model.collection.name,
          documentId: String(doc._id),
          field,
          group: supportedFieldGroup(plan.model.modelName, field),
          sourceProperty: reference.sourceProperty,
          path: reference.path,
          bunnyObjectKey: cleanKey(reference.path)
        });
      }
      for (const field of plan.urlFields || []) {
        const reference = localStyleReferenceFromField(getFieldValue(doc, field));
        if (!reference) continue;
        references.push({
          model: plan.model.modelName,
          collection: plan.model.collection.name,
          documentId: String(doc._id),
          field,
          group: supportedFieldGroup(plan.model.modelName, field),
          sourceProperty: reference.sourceProperty,
          path: reference.path,
          bunnyObjectKey: cleanKey(reference.path)
        });
      }
    }
  }
  return references;
}

function addSample(samples, status, reference) {
  if (sampleLimit <= 0 || samples[status].length >= sampleLimit) return;
  samples[status].push({
    model: reference.model,
    documentId: reference.documentId,
    field: reference.field,
    path: reference.path,
    bunnyObjectKey: reference.bunnyObjectKey
  });
}

async function buildReport() {
  if (process.env.STORAGE_PROVIDER !== 'bunny' || !useBunny()) {
    throw new Error('Set STORAGE_PROVIDER=bunny before auditing Bunny storage.');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing.');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB || 'fitlook'
  });

  const references = await collectReferences();
  const uniqueByPath = new Map();
  for (const reference of references) {
    if (!uniqueByPath.has(reference.path)) uniqueByPath.set(reference.path, []);
    uniqueByPath.get(reference.path).push(reference);
  }

  const classifications = new Map();
  for (const uploadPath of uniqueByPath.keys()) {
    classifications.set(uploadPath, await classifyUniquePath(uploadPath));
  }

  const totals = emptyCounts();
  const byGroup = {};
  const uniqueGroupPaths = {};
  const samples = {
    [STATUS.LOCAL_PRESENT]: [],
    [STATUS.BUNNY_PRESENT]: [],
    [STATUS.MISSING_EVERYWHERE]: []
  };

  for (const reference of references) {
    const classification = classifications.get(reference.path);
    totals.total_references += 1;
    incrementStatus(totals, classification.status);
    byGroup[reference.group] ||= emptyCounts();
    uniqueGroupPaths[reference.group] ||= new Set();
    byGroup[reference.group].total_references += 1;
    incrementStatus(byGroup[reference.group], classification.status);
    uniqueGroupPaths[reference.group].add(reference.path);
    addSample(samples, classification.status, reference);
  }

  totals.unique_paths = uniqueByPath.size;
  for (const [group, paths] of Object.entries(uniqueGroupPaths)) {
    byGroup[group].unique_paths = paths.size;
  }

  const unique_paths = [...uniqueByPath.entries()].map(([uploadPath, refs]) => {
    const classification = classifications.get(uploadPath);
    return {
      path: uploadPath,
      storedPath: classification.storedPath,
      bunnyObjectKey: classification.bunnyObjectKey,
      status: classification.status,
      referenceCount: refs.length,
      references: refs.map((ref) => ({
        model: ref.model,
        documentId: ref.documentId,
        field: ref.field,
        sourceProperty: ref.sourceProperty
      }))
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    mode: 'read-only',
    writes: {
      mongodb: false,
      bunny: false,
      local_uploads: false,
      report_file: Boolean(outputArg)
    },
    mapping: {
      localReferencePattern: 'uploads/...',
      storedPath: 'pathForKey(value) => uploads/{cleanKey(value)}',
      bunnyObjectKey: 'cleanKey(value): strips URL host, leading slashes, and leading uploads/',
      bunnyStorageRequestPath: '${BUNNY_STORAGE_ENDPOINT or https://{region}.storage.bunnycdn.com}/${BUNNY_STORAGE_ZONE}/{encodeURIComponent path segments of bunnyObjectKey}',
      existenceCheck: 'HEAD via storage.bunnyObjectExists'
    },
    coveredFields: mediaMigrationPlans.map((plan) => ({
      model: plan.model.modelName,
      fields: plan.fields,
      urlFields: plan.urlFields || []
    })),
    totals,
    byGroup,
    samples,
    unique_paths
  };
}

async function main() {
  try {
    const report = await buildReport();
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (outputArg) {
      const outPath = path.resolve(outputArg.split('=').slice(1).join('='));
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, json, { mode: 0o600 });
      console.log(`[audit] wrote read-only report to ${outPath}`);
    } else {
      process.stdout.write(json);
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (process.argv[1]?.endsWith('audit-missing-media.js')) {
  main().catch((error) => {
    console.error('[audit] failed:', error.message);
    process.exitCode = 1;
  });
}

export {
  STATUS,
  classifyFromBooleans,
  localStyleReferenceFromField,
  migrationFilter,
  supportedFieldGroup
};
