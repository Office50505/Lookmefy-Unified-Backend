import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGenerationProvider } from '../server/services/adminManagement.js';
import { cleanText, incidentFingerprint } from '../server/utils/systemIncidents.js';

test('generation providers are grouped into cost-management accounts', () => {
  assert.equal(normalizeGenerationProvider('pruna'), 'pruna');
  assert.equal(normalizeGenerationProvider('PixVerse'), 'fal-pixverse');
  assert.equal(normalizeGenerationProvider('fal-ai'), 'fal-pixverse');
  assert.equal(normalizeGenerationProvider('FitRoom'), 'fitroom');
  assert.equal(normalizeGenerationProvider('custom-provider'), 'custom-provider');
});

test('incident text removes common credential values and URL queries', () => {
  const cleaned = cleanText('FAL_KEY=secret-value failed at https://provider.example/job?id=sensitive');
  assert.equal(cleaned.includes('secret-value'), false);
  assert.equal(cleaned.includes('id=sensitive'), false);
});

test('incident fingerprints are stable for the same service failure', () => {
  const entry = { service: 'mongodb', kind: 'health_check', title: 'MongoDB health check failed' };
  assert.equal(incidentFingerprint(entry), incidentFingerprint(entry));
  assert.notEqual(incidentFingerprint(entry), incidentFingerprint({ ...entry, service: 'redis' }));
});
