import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('root backend jobs are backed by BullMQ jobQueue instead of the old app Mongo Job model', async () => {
  const [routes, queue, worker] = await Promise.all([
    fs.readFile('server/routes/jobs.js', 'utf8'),
    fs.readFile('server/utils/jobQueue.js', 'utf8'),
    fs.readFile('scripts/worker.js', 'utf8')
  ]);

  assert.doesNotMatch(routes, /models\/Job/);
  assert.match(routes, /getJobStatus/);
  assert.match(queue, /await import\('bullmq'\)/);
  assert.match(worker, /startWorker\('profile'/);
  assert.match(worker, /startWorker\('tryon'/);
  assert.match(worker, /startWorker\('maintenance'/);
});

test('job polling preserves old mobile aliases while keeping queue-specific result fields', async () => {
  const source = await fs.readFile('server/routes/jobs.js', 'utf8');

  assert.match(source, /function jobStateToMobileStatus/);
  assert.match(source, /type,\s*\n\s*queue:/);
  assert.match(source, /attempts,\s*\n\s*attemptsMade:/);
  assert.match(source, /statusUrl:/);
  assert.match(source, /statusPath:/);
  assert.match(source, /result:\s*job\.result/);
});
