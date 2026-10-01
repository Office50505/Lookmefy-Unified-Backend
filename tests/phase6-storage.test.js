import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import User from '../server/models/User.js';
import { serveUploadedMedia } from '../server/utils/security.js';
import { mediaMigrationPlans, mediaMigrationCandidates, shouldMigrate } from '../scripts/migrate-uploads-to-bunny.js';
import { classifyFromBooleans, localStyleReferenceFromField } from '../scripts/audit-missing-media.js';
import { generateFullBodyProfileInBackground, profileFullBodyJobSource, runProfileFullBodyJob } from '../server/routes/auth.js';
import {
  bunnyObjectExists,
  deleteStoredFile,
  localPathForKey,
  readStoredFile,
  saveBuffer
} from '../server/utils/storage.js';

function restoreEnvironment(t, names) {
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function configureBunnyProduction(t) {
  restoreEnvironment(t, [
    'NODE_ENV',
    'STORAGE_PROVIDER',
    'BUNNY_STORAGE_ZONE',
    'BUNNY_STORAGE_API_KEY',
    'BUNNY_CDN_BASE_URL'
  ]);
  process.env.NODE_ENV = 'production';
  process.env.STORAGE_PROVIDER = 'bunny';
  process.env.BUNNY_STORAGE_ZONE = 'lookmefy-test';
  process.env.BUNNY_STORAGE_API_KEY = 'test-key';
  process.env.BUNNY_CDN_BASE_URL = 'https://cdn.lookmefy.test';
}

function mockFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test('production persistent upload uses Bunny shared storage', async (t) => {
  configureBunnyProduction(t);
  const calls = [];
  mockFetch(t, async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    return new Response('', { status: 201 });
  });

  const saved = await saveBuffer({
    key: 'users/user-1/profile/avatar.jpg',
    buffer: Buffer.from('image-bytes'),
    mimetype: 'image/jpeg',
    filename: 'avatar.jpg'
  });

  assert.equal(saved.storage, 'bunny');
  assert.equal(saved.path, 'uploads/users/user-1/profile/avatar.jpg');
  assert.equal(saved.url, 'https://cdn.lookmefy.test/users/user-1/profile/avatar.jpg');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.toString(), 'image-bytes');
});

test('production /uploads reads Bunny even when no EC2-local file exists', async (t) => {
  configureBunnyProduction(t);
  const key = 'product-cross-instance.jpg';
  await assert.rejects(fs.stat(localPathForKey(key)), { code: 'ENOENT' });
  let requested = '';
  mockFetch(t, async (url) => {
    requested = String(url);
    return new Response(Buffer.from('shared-image'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    status(value) { this.statusCode = value; return this; },
    end() { return this; }
  };
  await serveUploadedMedia()({ path: `/${key}` }, res);
  assert.equal(res.body.toString(), 'shared-image');
  assert.match(requested, /product-cross-instance\.jpg$/);
});

test('media migration inventories nested body photo originals and every media-bearing model', () => {
  const byModel = new Map(mediaMigrationPlans.map((plan) => [plan.model.modelName, plan]));
  assert.deepEqual(byModel.get('User').fields, ['avatarPhoto', 'bodyPhoto', 'bodyPhoto.original']);
  for (const name of ['Product', 'TryOn', 'CustomTryOn', 'ExternalTryOn', 'ClosetItem', 'ClosetOutfit']) {
    assert.ok(byModel.get(name)?.fields.length, `${name} must be inventoried`);
  }
  assert.equal(shouldMigrate({ path: 'uploads/users/abc/original.jpg', storage: 'local' }), true);
  assert.equal(shouldMigrate({ url: '/uploads/users/abc/original.jpg', storage: 'local' }), true);
  assert.equal(shouldMigrate({ path: 'uploads/users/abc/original.jpg', storage: 'bunny' }), false);
  const user = new User({
    name: 'Migration Test',
    email: 'media-migration@example.test',
    passwordHash: 'test-hash',
    bodyPhoto: { original: { path: 'uploads/users/abc/original.jpg', storage: 'local' } }
  });
  assert.deepEqual(mediaMigrationCandidates(user, byModel.get('User')), ['bodyPhoto.original']);
});

test('missing media audit reads the same local-style field values without writes', () => {
  assert.deepEqual(localStyleReferenceFromField({ path: '/uploads/users/u/body.jpg' }), {
    raw: '/uploads/users/u/body.jpg',
    path: 'uploads/users/u/body.jpg',
    sourceProperty: 'path'
  });
  assert.deepEqual(localStyleReferenceFromField({ url: 'uploads/users/u/body.jpg' }), {
    raw: 'uploads/users/u/body.jpg',
    path: 'uploads/users/u/body.jpg',
    sourceProperty: 'url'
  });
  assert.deepEqual(localStyleReferenceFromField('uploads/users/u/transparent.png'), {
    raw: 'uploads/users/u/transparent.png',
    path: 'uploads/users/u/transparent.png',
    sourceProperty: 'value'
  });
  assert.equal(localStyleReferenceFromField('https://cdn.example.test/users/u/remote.jpg'), null);
  assert.equal(classifyFromBooleans({ localPresent: true, bunnyPresent: true }), 'LOCAL_PRESENT');
  assert.equal(classifyFromBooleans({ localPresent: false, bunnyPresent: true }), 'BUNNY_PRESENT');
  assert.equal(classifyFromBooleans({ localPresent: false, bunnyPresent: false }), 'MISSING_EVERYWHERE');
});

test('Bunny existence audit uses ranged GET with storage cleanKey mapping without reading body', async (t) => {
  configureBunnyProduction(t);
  const calls = [];
  let canceled = false;
  let read = false;
  mockFetch(t, async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers });
    return {
      ok: true,
      status: 206,
      body: {
        cancel() {
          canceled = true;
          return Promise.resolve();
        },
        getReader() {
          read = true;
          return { read: async () => ({ done: true }) };
        }
      }
    };
  });

  const exists = await bunnyObjectExists('uploads/users/64f000000000000000000001/profile/body photo.jpg');

  assert.equal(exists, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Range, 'bytes=0-0');
  assert.match(calls[0].url, /\/lookmefy-test\/users\/64f000000000000000000001\/profile\/body%20photo\.jpg$/);
  assert.equal(calls[0].headers.AccessKey, 'test-key');
  assert.equal(canceled, true);
  assert.equal(read, false);
});

test('production shared storage failure throws controlled dependency error without local fallback', async (t) => {
  configureBunnyProduction(t);
  mockFetch(t, async () => new Response('upstream down', { status: 503 }));

  await assert.rejects(
    saveBuffer({
      key: 'users/user-1/profile/fail.jpg',
      buffer: Buffer.from('image-bytes'),
      mimetype: 'image/jpeg'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );

  await assert.rejects(fs.stat(localPathForKey('users/user-1/profile/fail.jpg')), { code: 'ENOENT' });
});

test('production local persistent storage is rejected instead of silently succeeding', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'STORAGE_PROVIDER']);
  process.env.NODE_ENV = 'production';
  process.env.STORAGE_PROVIDER = 'local';

  await assert.rejects(
    saveBuffer({
      key: 'users/user-1/profile/local.jpg',
      buffer: Buffer.from('image-bytes'),
      mimetype: 'image/jpeg'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
});

test('development local storage remains explicitly usable', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'STORAGE_PROVIDER']);
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_PROVIDER = 'local';
  const key = `phase6/dev-local-${Date.now()}.jpg`;

  const saved = await saveBuffer({
    key,
    buffer: Buffer.from('dev-image'),
    mimetype: 'image/jpeg',
    filename: 'dev-local.jpg'
  });
  t.after(() => fs.unlink(localPathForKey(key)).catch(() => {}));

  assert.equal(saved.storage, 'local');
  assert.equal(saved.url, undefined);
  assert.equal(await fs.readFile(localPathForKey(key), 'utf8'), 'dev-image');
});

test('profile full-body durable job payload contains a shared-safe media reference', async (t) => {
  configureBunnyProduction(t);
  restoreEnvironment(t, ['PROFILE_FULL_BODY_GENERATION', 'PROFILE_FULL_BODY_QUEUE_MODE']);
  process.env.PROFILE_FULL_BODY_GENERATION = 'true';
  process.env.PROFILE_FULL_BODY_QUEUE_MODE = 'worker';
  let queued = null;

  await generateFullBodyProfileInBackground('64f000000000000000000001', {
    filename: 'body.jpg',
    path: 'uploads/users/64f000000000000000000001/profile/body.jpg',
    storage: 'bunny',
    mimetype: 'image/jpeg',
    size: 1234,
    buffer: Buffer.from('api-local-buffer-must-not-enter-job')
  }, {
    enqueueCritical: async (queueName, jobName, data, options) => {
      queued = { queueName, jobName, data, options };
      return { id: options.jobId };
    }
  });

  assert.equal(queued.queueName, 'profile');
  assert.equal(queued.jobName, 'full-body');
  assert.equal(queued.data.sourceBodyPhoto.storage, 'bunny');
  assert.equal(queued.data.sourceBodyPhoto.path, 'uploads/users/64f000000000000000000001/profile/body.jpg');
  assert.equal(queued.data.sourceBodyPhoto.buffer, undefined);
  assert.match(queued.options.jobId, /^profile-full-body-/);
});

test('profile full-body source accepts Bunny storage with stored path', async (t) => {
  configureBunnyProduction(t);

  const source = profileFullBodyJobSource({
    filename: 'body.jpg',
    path: 'uploads/users/64f000000000000000000001/profile/body.jpg',
    storage: 'bunny',
    mimetype: 'image/jpeg'
  });

  assert.equal(source.storage, 'bunny');
  assert.equal(source.path, 'uploads/users/64f000000000000000000001/profile/body.jpg');
});

test('profile full-body source accepts explicit remote shared URL', async (t) => {
  configureBunnyProduction(t);

  const source = profileFullBodyJobSource({
    filename: 'remote.jpg',
    remoteUrl: 'https://provider.example.test/users/64f000000000000000000001/profile/body.jpg',
    mimetype: 'image/jpeg'
  });

  assert.equal(source.remoteUrl, 'https://provider.example.test/users/64f000000000000000000001/profile/body.jpg');
});

test('profile full-body source rejects app uploads URL without shared metadata in production', async (t) => {
  configureBunnyProduction(t);

  assert.throws(
    () => profileFullBodyJobSource({
      filename: 'legacy.jpg',
      url: 'https://api.example.com/uploads/legacy.jpg',
      mimetype: 'image/jpeg'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
});

test('profile full-body source rejects bare uploads path without storage metadata in production', async (t) => {
  configureBunnyProduction(t);

  assert.throws(
    () => profileFullBodyJobSource({
      filename: 'legacy.jpg',
      path: 'uploads/users/64f000000000000000000001/profile/legacy.jpg',
      mimetype: 'image/jpeg'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
});

test('independent worker can resolve shared profile media without producer local disk', async (t) => {
  configureBunnyProduction(t);
  process.env.BUNNY_CDN_BASE_URL = 'https://93.184.216.34';
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  mockFetch(t, async () => new Response(tinyPng, {
    status: 200,
    headers: { 'content-type': 'image/png' }
  }));

  const stored = await readStoredFile({
    path: 'uploads/users/64f000000000000000000001/profile/body.jpg',
    storage: 'bunny',
    mimetype: 'image/jpeg'
  }, 'profile media');

  assert.deepEqual(stored.buffer, tinyPng);
  assert.equal(stored.mimetype, 'image/jpeg');
});

test('production profile full-body jobs reject local-only media references', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'STORAGE_PROVIDER']);
  process.env.NODE_ENV = 'production';
  process.env.STORAGE_PROVIDER = 'local';

  assert.throws(
    () => profileFullBodyJobSource({
      filename: 'local.jpg',
      path: 'uploads/profile/local.jpg',
      storage: 'local',
      mimetype: 'image/jpeg'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
});

test('non-production profile full-body source allows intended buffer and local path fallback', async (t) => {
  restoreEnvironment(t, ['NODE_ENV', 'STORAGE_PROVIDER']);
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_PROVIDER = 'local';

  const buffered = profileFullBodyJobSource({
    filename: 'buffer.jpg',
    buffer: Buffer.from('local-dev-buffer'),
    mimetype: 'image/jpeg'
  });
  const local = profileFullBodyJobSource({
    filename: 'local.jpg',
    path: 'uploads/profile/local.jpg',
    storage: 'local',
    mimetype: 'image/jpeg'
  });

  assert.equal(buffered.filename, 'buffer.jpg');
  assert.equal(local.path, 'uploads/profile/local.jpg');
});

test('profile full-body failure update targets normalized original shared path', async (t) => {
  configureBunnyProduction(t);
  restoreEnvironment(t, ['PROFILE_FULL_BODY_GENERATION']);
  process.env.PROFILE_FULL_BODY_GENERATION = 'true';
  process.env.BUNNY_CDN_BASE_URL = 'https://93.184.216.34';
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  let fetches = 0;
  mockFetch(t, async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(tinyPng, {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    }
    throw new Error('simulated provider failure');
  });
  const originalError = console.error;
  console.error = () => {};
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const updates = [];
  User.findOneAndUpdate = async (filter, update) => {
    updates.push({ filter, update });
    return null;
  };
  t.after(() => {
    console.error = originalError;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  });

  await assert.rejects(() => runProfileFullBodyJob({
      userId: '64f000000000000000000001',
      sourceBodyPhoto: {
        path: 'uploads/users/64f000000000000000000001/profile/generated-placeholder.jpg',
        original: {
          filename: 'original.jpg',
          path: 'uploads/users/64f000000000000000000001/profile/original.jpg',
          storage: 'bunny',
          mimetype: 'image/jpeg'
        }
      }
    }));

  assert.equal(updates[0].filter['bodyPhoto.path'], 'uploads/users/64f000000000000000000001/profile/original.jpg');
  assert.equal(updates[0].update.$set['bodyPhoto.status'], 'failed');
});

test('profile full-body validation failure marks best available source path failed', async (t) => {
  configureBunnyProduction(t);
  const originalError = console.error;
  console.error = () => {};
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  const updates = [];
  User.findOneAndUpdate = async (filter, update) => {
    updates.push({ filter, update });
    return null;
  };
  t.after(() => {
    console.error = originalError;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  });

  await assert.rejects(
    () => runProfileFullBodyJob({
      userId: '64f000000000000000000001',
      sourceBodyPhoto: {
        path: 'uploads/users/64f000000000000000000001/profile/current.jpg',
        original: {
          filename: 'legacy.jpg',
          path: 'uploads/users/64f000000000000000000001/profile/legacy.jpg',
          mimetype: 'image/jpeg'
        }
      }
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );

  assert.equal(updates[0].filter['bodyPhoto.path'], 'uploads/users/64f000000000000000000001/profile/legacy.jpg');
  assert.equal(updates[0].update.$set['bodyPhoto.status'], 'failed');
});

test('shared delete is authoritative and reports Bunny failures', async (t) => {
  configureBunnyProduction(t);
  const calls = [];
  mockFetch(t, async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response('delete failed', { status: 500 });
  });

  await assert.rejects(
    deleteStoredFile({
      path: 'uploads/users/64f000000000000000000001/profile/body.jpg',
      storage: 'bunny'
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.statusCode === 503
  );
  assert.equal(calls[0].method, 'DELETE');
});
