import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import GenerationMetric from '../server/models/GenerationMetric.js';
import UserEvent from '../server/models/UserEvent.js';
import { changePercent, fillDailyTrend, percent } from '../server/services/adminAnalytics.js';
import { analyticsPeriodFromQuery } from '../server/utils/analyticsPeriod.js';
import { generationErrorCategory } from '../server/utils/generationMetrics.js';

test('analytics presets create bounded current and previous periods', () => {
  const period = analyticsPeriodFromQuery({ range: '7' }, new Date('2026-08-21T12:00:00.000Z'));
  assert.equal(period.from.toISOString(), '2026-08-15T00:00:00.000Z');
  assert.equal(period.to.toISOString(), '2026-08-21T12:00:00.000Z');
  assert.equal(period.days, 7);
  assert.equal(period.previousTo.toISOString(), period.from.toISOString());
  assert.equal(period.previousTo.getTime() - period.previousFrom.getTime(), period.to.getTime() - period.from.getTime());
});

test('analytics custom ranges include the complete final day', () => {
  const period = analyticsPeriodFromQuery({ range: 'custom', from: '2026-08-01', to: '2026-08-03' });
  assert.equal(period.from.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(period.to.toISOString(), '2026-08-04T00:00:00.000Z');
  assert.equal(period.days, 3);
});

test('analytics ranges reject malformed, reversed, and overlong input', () => {
  assert.throws(() => analyticsPeriodFromQuery({ range: '14' }), /7, 30, 90/i);
  assert.throws(() => analyticsPeriodFromQuery({ range: 'custom', from: '2026-08-10', to: '2026-08-01' }), /before or equal/i);
  assert.throws(() => analyticsPeriodFromQuery({ range: 'custom', from: '2025-01-01', to: '2026-01-01' }), /cannot exceed/i);
});

test('analytics helpers fill missing days and calculate rates', () => {
  const trend = fillDailyTrend([
    { _id: '2026-08-01', events: 4, users: 2 },
    { _id: '2026-08-03', events: 6, users: 3 }
  ], {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-04T00:00:00.000Z')
  });
  assert.deepEqual(trend, [
    { date: '2026-08-01', events: 4, users: 2 },
    { date: '2026-08-02', events: 0, users: 0 },
    { date: '2026-08-03', events: 6, users: 3 }
  ]);
  assert.equal(percent(3, 8), 37.5);
  assert.equal(changePercent(120, 100), 20);
  assert.equal(changePercent(10, 0), 100);
});

test('recommendation and generation analytics models accept the new event contract', () => {
  const user = new mongoose.Types.ObjectId();
  const product = new mongoose.Types.ObjectId();
  const impression = new UserEvent({ user, product, type: 'recommendation_impression', source: 'for_you', weight: 0 });
  assert.equal(impression.validateSync(), undefined);

  const metric = new GenerationMetric({ user, product, type: 'product_video', status: 'failed', provider: 'pixverse', durationMs: 1200, tokensCharged: 3, tokensRefunded: 3 });
  assert.equal(metric.validateSync(), undefined);
  assert.match(new GenerationMetric({ user, type: 'unknown', status: 'failed' }).validateSync().errors.type.message, /not a valid enum/i);
});

test('generation errors are grouped without retaining raw provider messages', () => {
  assert.equal(generationErrorCategory('Not enough tokens for video try-on'), 'insufficient_tokens');
  assert.equal(generationErrorCategory('Provider prediction timed out'), 'timeout');
  assert.equal(generationErrorCategory('Content policy rejected this image'), 'content_policy');
  assert.equal(generationErrorCategory('Could not save generated output'), 'storage');
});
