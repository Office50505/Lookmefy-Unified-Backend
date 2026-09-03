import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_PAGES,
  ADMIN_SECTIONS,
  PAGE_COPY,
  adminCanAccessPage,
  adminPage,
  adminSectionForPage,
  firstAdminPage,
  visibleAdminSections
} from '../admin/src/adminNavigation.js';

test('admin navigation exposes three sections with unique page ids', () => {
  assert.deepEqual(ADMIN_SECTIONS.map((section) => section.id), ['user-operations', 'system-management', 'cost-management']);
  assert.equal(new Set(ADMIN_PAGES.map((page) => page.id)).size, ADMIN_PAGES.length);
  assert.equal(ADMIN_PAGES.every((page) => PAGE_COPY[page.id]?.title === page.label), true);
});

test('cost provider routes map directly to their provider detail id', () => {
  const providerPages = ADMIN_PAGES.filter((page) => page.provider);
  assert.equal(providerPages.length, 8);
  providerPages.forEach((page) => assert.equal(page.id, `cost-${page.provider}`));
});

test('page lookup returns the owning sidebar section', () => {
  assert.equal(adminPage('cost-bunny')?.provider, 'bunny');
  assert.equal(adminSectionForPage('generation-pipeline').id, 'system-management');
  assert.equal(adminSectionForPage('inventory').id, 'user-operations');
});

test('master sees Roles while full developers see all operational sections without Roles', () => {
  const master = { role: 'master', sectionAccess: [], canManageRoles: true };
  const developer = { role: 'developer', sectionAccess: ADMIN_SECTIONS.map((section) => section.id), canManageRoles: false };
  assert.equal(adminCanAccessPage(master, 'roles'), true);
  assert.equal(adminCanAccessPage(developer, 'roles'), false);
  assert.deepEqual(visibleAdminSections(developer).map((section) => section.id), ADMIN_SECTIONS.map((section) => section.id));
});

test('scoped developers see only assigned sections and receive an allowed default page', () => {
  const developer = { role: 'developer', sectionAccess: ['cost-management'], canManageRoles: false };
  assert.deepEqual(visibleAdminSections(developer).map((section) => section.id), ['cost-management']);
  assert.equal(adminCanAccessPage(developer, 'inventory'), false);
  assert.equal(firstAdminPage(developer), 'cost-overview');
});

test('pending administrators have no visible pages', () => {
  const pending = { role: 'developer', status: 'pending', sectionAccess: [], canManageRoles: false };
  assert.deepEqual(visibleAdminSections(pending), []);
  assert.equal(firstAdminPage(pending), '');
});
