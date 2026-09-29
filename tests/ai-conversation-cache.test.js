import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiConversationStore } from '../server/services/aiStudio.js';
import { createFakeRedisServer } from './fakeRedis.js';

test('AI conversation context is visible across independent Redis-backed service instances', async () => {
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 1000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createAiConversationStore(options);
  const instanceB = createAiConversationStore(options);

  const conversation = await instanceA.getOrCreate({ userId: 'user-1', conversationId: 'conversation-1' });
  conversation.language = 'hinglish';
  conversation.pendingProductChoice = { kind: 'product', message: 'black kurta' };
  conversation.turns.push({ role: 'user', text: 'show me a black kurta' });
  await instanceA.save(conversation);

  const shared = await instanceB.getOrCreate({ userId: 'user-1', conversationId: 'conversation-1' });
  assert.equal(shared.language, 'hinglish');
  assert.equal(shared.pendingProductChoice.message, 'black kurta');
  assert.deepEqual(shared.turns, [{ role: 'user', text: 'show me a black kurta' }]);
});

test('AI conversation context expires and can be reset across service instances', async () => {
  const redis = createFakeRedisServer();
  const options = {
    ttlMs: 1000,
    requireRedis: true,
    getRedisClient: async () => redis.createClient()
  };
  const instanceA = createAiConversationStore(options);
  const instanceB = createAiConversationStore(options);

  const expiring = await instanceA.getOrCreate({ userId: 'user-2', conversationId: 'expiring' });
  expiring.language = 'hinglish';
  await instanceA.save(expiring);
  redis.advanceBy(1001);
  assert.equal((await instanceB.getOrCreate({ userId: 'user-2', conversationId: 'expiring' })).language, '');

  const reset = await instanceA.getOrCreate({ userId: 'user-2', conversationId: 'reset' });
  reset.pendingProductChoice = { kind: 'outfit', message: 'office look' };
  await instanceA.save(reset);
  await instanceB.remove({ userId: 'user-2', conversationId: 'reset' });
  assert.equal((await instanceA.getOrCreate({ userId: 'user-2', conversationId: 'reset' })).pendingProductChoice, null);
});
