import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminAvailabilityClause,
  availabilityUpdate,
  availableStatusClause,
  productAvailabilityStatus
} from '../server/utils/productAvailability.js';

test('legacy product availability follows the active flag', () => {
  assert.equal(productAvailabilityStatus({ isActive: true }), 'available');
  assert.equal(productAvailabilityStatus({ isActive: false }), 'archived');
  assert.equal(productAvailabilityStatus({ isActive: false, availabilityStatus: 'available' }), 'archived');
  assert.equal(productAvailabilityStatus({ isActive: true, availabilityStatus: 'out_of_stock' }), 'out_of_stock');
});

test('availability updates keep public activity synchronized', () => {
  assert.equal(availabilityUpdate('available').isActive, true);
  assert.equal(availabilityUpdate('out_of_stock').isActive, false);
  assert.equal(availabilityUpdate('unavailable').isActive, false);
  assert.equal(availabilityUpdate('draft').isActive, false);
  assert.equal(availabilityUpdate('archived').isActive, false);
  assert.throws(() => availabilityUpdate('in_stock'), /Availability must be one of/);
});

test('availability filters include compatible legacy records', () => {
  assert.equal(availableStatusClause().$or.length, 2);
  assert.equal(adminAvailabilityClause('available').$or.length, 2);
  assert.equal(adminAvailabilityClause('archived').$or.length, 2);
  assert.deepEqual(adminAvailabilityClause('draft'), { availabilityStatus: 'draft' });
  assert.equal(adminAvailabilityClause('invalid'), null);
});
