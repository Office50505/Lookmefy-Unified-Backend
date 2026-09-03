import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { signAdminSession } from '../server/utils/adminAccess.js';

test('admin session identifies one account and versions its credential without embedding access', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'admin-rbac-test-secret';
  try {
    const token = await signAdminSession({ id: '507f1f77bcf86cd799439011', credentialVersion: 4, role: 'master' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    assert.equal(payload.scope, 'admin');
    assert.equal(payload.sub, '507f1f77bcf86cd799439011');
    assert.equal(payload.ver, 4);
    assert.equal(payload.role, undefined);
    assert.equal(payload.sectionAccess, undefined);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('admin clients and load tooling no longer use the shared x-admin-key bypass', async () => {
  const root = path.resolve(process.cwd());
  const sources = await Promise.all([
    'admin/src/AdminApp.jsx',
    'server/utils/adminAccess.js',
    'tests/load/backend-load.k6.js'
  ].map((file) => fs.readFile(path.join(root, file), 'utf8')));
  assert.equal(sources.some((source) => source.includes('x-admin-key')), false);
});

test('admin authentication uses passwords and has no shared ADMIN_KEY bootstrap path', async () => {
  const root = path.resolve(process.cwd());
  const sources = await Promise.all([
    'server/routes/auth.js',
    'admin/src/AdminApp.jsx',
    'tests/load/backend-load.k6.js',
    '.env.example'
  ].map((file) => fs.readFile(path.join(root, file), 'utf8')));
  assert.equal(sources.some((source) => /(^|[^A-Z_])ADMIN_KEY(?:\b|=)/m.test(source)), false);
  assert.equal(sources.some((source) => source.includes('adminKey')), false);
  assert.match(sources[0], /admin-request-access/);
  assert.match(sources[0], /req\.body\?\.password/);
});
