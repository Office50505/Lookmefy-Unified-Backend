import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function source(file) {
  return fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

test('user-operation admin routes require the user-operation section gate', async () => {
  const [auth, products, recommendations] = await Promise.all([
    source('server/routes/auth.js'),
    source('server/routes/products.js'),
    source('server/routes/recommendations.js')
  ]);
  assert.match(auth, /router\.get\('\/admin\/users', requireAdmin, requireUserOperationsAdmin/);
  assert.match(auth, /router\.get\('\/admin\/storage', requireAdmin, requireUserOperationsAdmin/);
  assert.match(auth, /router\.patch\('\/admin\/users\/:id\/tokens', requireAdmin, requireUserOperationsAdmin/);
  assert.match(products, /router\.get\('\/admin\/catalog', requireAdmin, requireUserOperationsAdmin/);
  assert.match(products, /router\.post\('\/preview-link', requireAdmin, requireUserOperationsAdmin/);
  assert.match(recommendations, /router\.get\('\/admin\/stats', requireAdmin, requireUserOperationsAdmin/);
});

test('system, cost, audit, metrics, and Roles routes use their dedicated gates', async () => {
  const [admin, auth, index] = await Promise.all([
    source('server/routes/admin.js'),
    source('server/routes/auth.js'),
    source('server/index.js')
  ]);
  assert.match(admin, /router\.use\('\/system', requireSystemAdmin\)/);
  assert.match(admin, /router\.use\('\/costs', requireCostAdmin\)/);
  assert.match(admin, /router\.use\('\/roles', requireRoleManager\)/);
  assert.match(auth, /router\.get\('\/admin\/audit-log', requireAdmin, requireSystemAdmin/);
  assert.match(index, /app\.get\('\/api\/admin\/metrics', requireAdmin, requireSystemAdmin/);
});
