import assert from 'node:assert/strict';
import test from 'node:test';
import AdminUser from '../server/models/AdminUser.js';
import { requireAdminPermission, requireAdminSection } from '../server/utils/adminAccess.js';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ADMIN_SECTIONS,
  ALL_ADMIN_SECTIONS,
  adminHasPermission,
  adminHasSection,
  adminSectionsFor,
  adminToClient,
  normalizeAdminSections,
  removesActiveMaster
} from '../server/utils/adminPermissions.js';

test('master access always includes every admin section and role management', () => {
  const admin = { role: ADMIN_ROLES.MASTER, sectionAccess: [] };
  assert.deepEqual(adminSectionsFor(admin), ALL_ADMIN_SECTIONS);
  assert.equal(adminHasPermission(admin, ADMIN_PERMISSIONS.MANAGE_ROLES), true);
});

test('developer access is limited to assigned section tags', () => {
  const admin = { role: ADMIN_ROLES.DEVELOPER, sectionAccess: [ADMIN_SECTIONS.SYSTEM_MANAGEMENT] };
  assert.equal(adminHasSection(admin, ADMIN_SECTIONS.SYSTEM_MANAGEMENT), true);
  assert.equal(adminHasSection(admin, ADMIN_SECTIONS.COST_MANAGEMENT), false);
  assert.equal(adminHasPermission(admin, ADMIN_PERMISSIONS.MANAGE_ROLES), false);
});

test('pending identities fail closed even if stored role data is malformed', () => {
  const pending = { role: ADMIN_ROLES.MASTER, status: 'pending', sectionAccess: [...ALL_ADMIN_SECTIONS] };
  assert.deepEqual(adminSectionsFor(pending), []);
  assert.equal(adminHasPermission(pending, ADMIN_PERMISSIONS.MANAGE_ROLES), false);
  assert.deepEqual(adminToClient(pending).sectionAccess, []);
  assert.equal(adminToClient(pending).role, ADMIN_ROLES.DEVELOPER);
});

test('section normalization rejects unknown and duplicate access values', () => {
  assert.deepEqual(
    normalizeAdminSections(['unknown', ADMIN_SECTIONS.COST_MANAGEMENT, ADMIN_SECTIONS.COST_MANAGEMENT]),
    [ADMIN_SECTIONS.COST_MANAGEMENT]
  );
});

test('admin client payload never exposes credential material', () => {
  const payload = adminToClient({
    id: 'admin-1',
    name: 'Dev',
    email: 'DEV@LOOKMEFY.COM',
    role: ADMIN_ROLES.DEVELOPER,
    sectionAccess: [ADMIN_SECTIONS.USER_OPERATIONS],
    credentialHash: 'secret-hash',
    credentialVersion: 9
  });
  assert.equal(payload.email, 'dev@lookmefy.com');
  assert.equal(payload.credentialHash, undefined);
  assert.equal(payload.credentialVersion, undefined);
});

function middlewareResult(middleware, admin) {
  const result = { status: 200, body: null, next: false };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    }
  };
  middleware({ admin }, res, () => {
    result.next = true;
  });
  return result;
}

test('admin middleware returns 403 for missing section and master-only permissions', () => {
  const developer = { role: ADMIN_ROLES.DEVELOPER, sectionAccess: [ADMIN_SECTIONS.USER_OPERATIONS] };
  assert.equal(middlewareResult(requireAdminSection(ADMIN_SECTIONS.USER_OPERATIONS), developer).next, true);
  assert.equal(middlewareResult(requireAdminSection(ADMIN_SECTIONS.COST_MANAGEMENT), developer).status, 403);
  assert.equal(middlewareResult(requireAdminPermission(ADMIN_PERMISSIONS.MANAGE_ROLES), developer).status, 403);
});

test('pending admins have no permissions while active developers need section access', async () => {
  const pending = new AdminUser({
    name: 'Restricted Dev',
    email: 'restricted@lookmefy.com',
    credentialHash: 'hashed',
    role: ADMIN_ROLES.DEVELOPER,
    sectionAccess: [],
    status: 'pending'
  });
  await pending.validate();
  assert.deepEqual(pending.sectionAccess, []);

  const active = new AdminUser({
    name: 'Active Dev',
    email: 'active@lookmefy.com',
    credentialHash: 'hashed',
    role: ADMIN_ROLES.DEVELOPER,
    sectionAccess: [],
    status: 'active'
  });
  await assert.rejects(active.validate(), /at least one section/i);
});

test('last-master protection only applies when active master access is removed', () => {
  const current = { role: ADMIN_ROLES.MASTER, status: 'active' };
  assert.equal(removesActiveMaster(current, { role: ADMIN_ROLES.DEVELOPER, status: 'active' }), true);
  assert.equal(removesActiveMaster(current, { role: ADMIN_ROLES.MASTER, status: 'disabled' }), true);
  assert.equal(removesActiveMaster(current, { role: ADMIN_ROLES.MASTER, status: 'active' }), false);
});
