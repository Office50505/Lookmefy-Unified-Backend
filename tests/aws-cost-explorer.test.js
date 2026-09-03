import assert from 'node:assert/strict';
import test from 'node:test';
import { awsCostCacheMs, collectAwsCostPages } from '../server/services/providerIntegrations.js';

test('AWS Cost Explorer cache defaults to six hours and stays within safe bounds', () => {
  assert.equal(awsCostCacheMs({}), 6 * 60 * 60_000);
  assert.equal(awsCostCacheMs({ AWS_COST_CACHE_MS: '1' }), 15 * 60_000);
  assert.equal(awsCostCacheMs({ AWS_COST_CACHE_MS: String(48 * 60 * 60_000) }), 24 * 60 * 60_000);
  assert.equal(awsCostCacheMs({ AWS_COST_CACHE_MS: 'invalid' }), 6 * 60 * 60_000);
});

test('AWS Cost Explorer pages combine spend and service breakdowns', async () => {
  const requestedTokens = [];
  const period = { start: new Date('2026-08-01T00:00:00Z'), end: new Date('2026-08-26T00:00:00Z') };
  const pages = [
    {
      ResultsByTime: [{
        Estimated: true,
        Groups: [
          { Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '12.50' } } },
          { Keys: ['Amazon S3'], Metrics: { UnblendedCost: { Amount: '1.25' } } }
        ]
      }],
      NextPageToken: 'page-2'
    },
    {
      ResultsByTime: [{
        Estimated: false,
        Groups: [
          { Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '2.50' } } },
          { Keys: ['AWS Data Transfer'], Metrics: { UnblendedCost: { Amount: '0.75' } } }
        ]
      }]
    }
  ];

  const result = await collectAwsCostPages(async (token) => {
    requestedTokens.push(token);
    return pages.shift();
  }, period);

  assert.deepEqual(requestedTokens, ['', 'page-2']);
  assert.equal(result.configured, true);
  assert.equal(result.estimated, true);
  assert.equal(result.spend, 17);
  assert.deepEqual(result.breakdown, [
    { label: 'Amazon EC2', cost: 15 },
    { label: 'Amazon S3', cost: 1.25 },
    { label: 'AWS Data Transfer', cost: 0.75 }
  ]);
  assert.equal(result.period, period);
});

test('AWS Cost Explorer rejects repeated pagination tokens', async () => {
  await assert.rejects(
    collectAwsCostPages(async () => ({ ResultsByTime: [], NextPageToken: 'same-token' }), {}),
    /repeated page token/
  );
});
