import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aiStudioIntent,
  aiStudioFallbackReply,
  aiStudioKnowledgeReply,
  aiStudioQueryTerms,
  aiStudioSuggestions,
  retrieveAiStudioKnowledge,
  scoreAiStudioKnowledge
} from '../server/routes/recommendations.js';

test('AI Studio compatibility extracts useful fashion query terms', () => {
  assert.deepEqual(aiStudioQueryTerms('show me black party dresses under 2000'), ['black', 'party', 'dresses', '2000']);
  assert.deepEqual(aiStudioQueryTerms('find oversized white shirts'), ['oversized', 'white', 'shirts']);
});

test('AI Studio compatibility returns helpful empty-result reply', () => {
  const reply = aiStudioFallbackReply('office blazer', []);
  assert.match(reply, /could not find/i);
  assert.match(reply, /fashion search/i);
});

test('AI Studio compatibility scores local token knowledge', () => {
  const doc = {
    title: 'Token Rules',
    content: 'Tokens are Lookmefy credits used for AI try-on images and video try-ons.'
  };
  const result = scoreAiStudioKnowledge(doc, 'how many credits does video try-on cost?');

  assert.equal(result.title, 'Token Rules');
  assert.ok(result.score >= 24);
  assert.ok(result.matchedTerms.includes('credits'));
});

test('AI Studio compatibility builds knowledge-backed token replies', async () => {
  const knowledge = await retrieveAiStudioKnowledge('how do Lookmefy credits work?');
  const reply = aiStudioKnowledgeReply('how do Lookmefy credits work?', knowledge);

  assert.equal(aiStudioIntent('how do Lookmefy credits work?', knowledge), 'token_help');
  assert.match(reply, /Tokens are Lookmefy credits/i);
  assert.match(reply, /try-on/i);
});

test('AI Studio compatibility recognizes wardrobe help without product search', async () => {
  const knowledge = await retrieveAiStudioKnowledge('make an outfit from my wardrobe');
  const reply = aiStudioFallbackReply('make an outfit from my wardrobe', [], knowledge);

  assert.equal(aiStudioIntent('make an outfit from my wardrobe', knowledge), 'wardrobe_help');
  assert.match(reply, /wardrobe/i);
  assert.doesNotMatch(reply, /could not find a strong catalog match/i);
});

test('AI Studio compatibility suggestions are mobile chip strings', () => {
  const suggestions = aiStudioSuggestions('black jeans', [
    { category: 'Jeans' },
    { category: 'Shirts' }
  ]);

  assert.deepEqual(suggestions, ['More Jeans', 'black alternatives', 'Try wardrobe match']);
  assert.ok(suggestions.every((suggestion) => typeof suggestion === 'string' && suggestion.length > 0));
});
