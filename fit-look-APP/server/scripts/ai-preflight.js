import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { aiPreflightSnapshot } from '../utils/aiPreflight.js';

const args = process.argv.slice(2);
const targetProduction = args.includes('--production');
const envFile = args.find((arg) => !arg.startsWith('--')) || '.env';
const envPath = path.resolve(process.cwd(), envFile);

if (!existsSync(envPath)) {
  console.error(`AI preflight could not find ${envFile}`);
  process.exit(1);
}

dotenv.config({ path: envPath, override: true });

const snapshot = aiPreflightSnapshot({ targetProduction });
const icon = (status) => {
  if (status === 'ready') return '[ok]';
  if (status === 'degraded') return '[warn]';
  return '[block]';
};

console.log(`AI preflight for ${envFile}`);
console.log(`Runtime: ${snapshot.runtime.nodeEnv}`);
if (targetProduction) console.log('Target: AWS production');
console.log(`Overall: ${snapshot.ok ? 'ready' : 'blocked'}`);
console.log('');
console.log('Services');
for (const item of snapshot.services) {
  console.log(`${icon(item.status)} ${item.name}: ${item.status}${item.notes ? ` - ${item.notes}` : ''}`);
}

if (snapshot.issues.length) {
  console.log('');
  console.log('Issues');
  for (const issue of snapshot.issues) {
    console.log(`${issue.severity === 'error' ? '[block]' : '[warn]'} ${issue.message}`);
  }
}

console.log('');
console.log('Masked config');
console.log(JSON.stringify({
  providers: snapshot.providers,
  backend: {
    mongodb: snapshot.backend.mongodb,
    redis: snapshot.backend.redis,
    jwtSecret: snapshot.backend.jwtSecret,
    adminKey: snapshot.backend.adminKey,
    storage: snapshot.backend.storage,
    jobs: snapshot.backend.jobs
  },
  origins: snapshot.origins
}, null, 2));

process.exit(snapshot.ok ? 0 : 1);
