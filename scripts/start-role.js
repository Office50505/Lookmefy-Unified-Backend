import dotenv from 'dotenv';
import { appRole } from '../server/utils/runtime.js';

dotenv.config();

const role = appRole('api');

if (role === 'api') {
  await import('../server/index.js');
} else if (role === 'worker' || role === 'scheduler') {
  await import('./worker.js');
} else if (role === 'all') {
  await import('../server/index.js');
  await import('./worker.js');
} else {
  throw new Error(`Unsupported APP_ROLE=${role}. Use api, worker, scheduler, or all.`);
}
