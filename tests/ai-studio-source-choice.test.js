import assert from 'node:assert/strict';
import test from 'node:test';
import ClosetItem from '../server/models/ClosetItem.js';
import {
  aiStudioIntent,
  detectProductChoice,
  eventProfileForMessage,
  extractAiStudioFilters,
  freshSourceChoiceIntent,
  generalStyleQuestionReply,
  localPlan,
  orchestrateAiStudio,
  productMatchesEventProfile,
  productSatisfiesHardFilters,
  sourceChoiceActions,
  specificProductLabel,
  wardrobeFallbackActions
} from '../server/services/aiStudio.js';

function queryResult(rows = []) {
  return {
    sort() { return this; },
    limit() { return this; },
    async lean() { return rows; }
  };
}

function freshIntent(message) {
  const filters = extractAiStudioFilters(message, { genderPreference: 'female' });
  return freshSourceChoiceIntent(message, filters, aiStudioIntent(message));
}

test('fresh occasion prompts ask the user to choose a source', () => {
  assert.equal(freshIntent('beach'), 'outfit_source_choice');
  assert.equal(freshIntent('beach dress'), 'outfit_source_choice');
  assert.equal(freshIntent('halloween'), 'outfit_source_choice');
  assert.equal(freshIntent('give me some casual outfit'), 'outfit_source_choice');
  assert.equal(freshIntent('what should i wear for beach'), 'outfit_source_choice');
});

test('fresh clothing and accessory prompts ask before searching products', () => {
  assert.equal(freshIntent('black party dress under 1000'), 'product_search');
  assert.equal(freshIntent('gold sunglasses'), 'product_search');
});

test('general style questions get direct useful answers', () => {
  assert.equal(freshIntent('what is linen fabric?'), 'general_style_question');
  assert.equal(freshIntent('how do I style black pants?'), 'general_style_question');
  assert.match(generalStyleQuestionReply('what is linen fabric?'), /breathable/i);
  assert.match(
    generalStyleQuestionReply('which colors go with black pants?', extractAiStudioFilters('which colors go with black pants?')),
    /white/i
  );
});

test('general questions stay in chat mode instead of product search', () => {
  assert.equal(freshIntent('who is the prime minister of India?'), 'general_question');
  assert.equal(freshIntent('tell me a joke'), 'general_question');
  assert.equal(freshIntent('what is the date today?'), 'general_question');
  assert.equal(freshIntent('date night outfit'), 'outfit_source_choice');
});

test('non-fashion help prompts keep their direct assistant intent', () => {
  assert.equal(freshIntent('how do tokens work'), 'token_help');
});

test('source choice actions always expose wardrobe, catalog, and online search', () => {
  assert.deepEqual(
    sourceChoiceActions('beach dress').map((action) => action.label),
    ['Search wardrobe', 'Search Lookmefy catalog', 'Search online']
  );
});

test('the wardrobe action is not mistaken for a request to search both sources', () => {
  const conversation = { pendingProductChoice: { message: 'Kurta', kind: 'product' } };
  assert.equal(detectProductChoice('Search wardrobe for Kurta', conversation), 'wardrobe');
  assert.equal(detectProductChoice('Search wardrobe and Lookmefy catalog for Kurta', conversation), 'both');
});

test('an empty wardrobe returns no products and only the two shopping choices', () => {
  const filters = extractAiStudioFilters('Kurta', { genderPreference: 'female' });
  const plan = localPlan({
    message: 'Kurta',
    conversation: {},
    context: { wardrobe: [], profile: {} },
    intent: 'wardrobe_product_check',
    filters,
    wardrobeCombos: [],
    bestCombo: null,
    eventProfile: null
  });

  assert.equal(plan.mode, 'wardrobe_check');
  assert.deepEqual(plan.products, []);
  assert.deepEqual(plan.outfits, []);
  assert.match(plan.reply, /wardrobe does not have a matching kurta/i);
  assert.deepEqual(plan.actions.map((action) => action.label), ['Search Lookmefy catalog', 'Search online']);
  assert.deepEqual(
    wardrobeFallbackActions('Search wardrobe for Kurta').map((action) => action.prompt),
    ['Search Lookmefy catalog for Kurta', 'Search online for Kurta']
  );
});

test('an explicit wardrobe search returns only matching wardrobe items without external calls', async (t) => {
  const wardrobeRows = [{
    _id: 'owned-black-shirt',
    name: 'Owned Black Satin Shirt',
    category: 'tops',
    color: 'black',
    image: { url: '/uploads/closet/owned-black-shirt.jpg' },
    tags: ['shirt', 'satin']
  }, {
    _id: 'owned-black-tshirt',
    name: 'Owned Black T-Shirt',
    category: 'tops',
    color: 'black',
    image: { url: '/uploads/closet/owned-black-tshirt.jpg' }
  }];
  t.mock.method(ClosetItem, 'find', () => queryResult(wardrobeRows));
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('wardrobe search must not call an external service');
  });

  const result = await orchestrateAiStudio({
    user: { _id: `wardrobe-only-${t.name}`, genderPreference: 'female' },
    message: 'Search wardrobe for black shirt'
  });

  assert.equal(result.brain, 'local');
  assert.deepEqual(result.products, []);
  assert.equal(result.outfits.length, 1);
  assert.deepEqual(result.outfits[0].items.map((item) => item.id), ['owned-black-shirt']);
  assert.ok(result.outfits[0].items.every((item) => item.source === 'wardrobe'));
  assert.deepEqual(result.outfits[0].products, []);
});

test('product hard filters reject random catalog items after source choice', () => {
  const filters = { category: 'tops', color: 'black' };
  const options = { specificLabel: 'shirt' };

  assert.equal(productSatisfiesHardFilters({
    name: 'Black satin shirt',
    category: 'tops',
    color: 'black',
    description: 'Eveningwear'
  }, filters, options), true);

  assert.equal(productSatisfiesHardFilters({
    name: 'Ivory button shirt',
    category: 'tops',
    color: 'white',
    tags: ['black']
  }, filters, options), false);

  assert.equal(productSatisfiesHardFilters({
    name: 'Black lace mini dress',
    category: 'dresses',
    color: 'black',
    tags: ['shirt']
  }, filters, options), false);

  assert.equal(productSatisfiesHardFilters({
    name: 'Red halter dress',
    category: 'dresses',
    color: 'red',
    description: 'Pair it with a black shirt underneath.'
  }, filters, options), false);

  assert.equal(productSatisfiesHardFilters({
    name: 'White Oxford button-down shirt',
    category: 'tops',
    color: 'white'
  }, { category: 'tops', color: 'white' }, options), true);

  for (const name of ['White floral blouse', 'White crop top', 'White cotton T-shirt', 'White hoodie']) {
    assert.equal(productSatisfiesHardFilters({
      name,
      category: 'tops',
      color: 'white'
    }, { category: 'tops', color: 'white' }, options), false, `${name} must not satisfy a shirt request`);
  }

  assert.equal(productSatisfiesHardFilters({
    name: 'White floral blouse',
    category: 'shirts',
    color: 'white'
  }, { category: 'tops', color: 'white' }, options), false, 'a misleading shirt category must not override the product name');
});

test('white shirt intent remains a strict shirt request', () => {
  const filters = extractAiStudioFilters('white shirt', { genderPreference: 'female' });
  assert.equal(filters.category, 'tops');
  assert.equal(filters.color, 'white');
  assert.equal(specificProductLabel('white shirt', filters), 'shirt');
  assert.equal(specificProductLabel('white T-shirt', filters), 't-shirt');
  assert.equal(specificProductLabel('white blouse', filters), 'blouse');
});

test('blue dress results require the requested type and trustworthy color evidence', () => {
  const filters = extractAiStudioFilters('blue dress', { genderPreference: 'female' });
  const options = { specificLabel: specificProductLabel('blue dress', filters) };

  assert.equal(productSatisfiesHardFilters({
    name: 'Grace Mode Women Blue Printed Midi Dress',
    category: 'dresses',
    colors: ['blue']
  }, filters, options), true);

  assert.equal(productSatisfiesHardFilters({
    name: 'Women Floral Printed Midi Dress',
    category: 'dresses',
    colors: ['blue'],
    tags: ['blue']
  }, filters, options), false, 'a patterned product without blue in its title must be rejected');

  assert.equal(productSatisfiesHardFilters({
    name: 'Long Printed Maxi Women Cotton Comfortable Skirt',
    category: 'dresses',
    colors: ['blue']
  }, filters, options), false, 'a skirt mislabeled in the dress category must be rejected');
});

test('kurta and kurti searches remain distinct', () => {
  const filters = extractAiStudioFilters('Kurta', { genderPreference: 'female' });
  const options = { specificLabel: specificProductLabel('Kurta', filters) };
  assert.equal(options.specificLabel, 'kurta');
  assert.equal(productSatisfiesHardFilters({
    name: 'Cotton Kurta Palazzo Set',
    category: 'ethnic wear'
  }, filters, options), true);
  assert.equal(productSatisfiesHardFilters({
    name: 'Cotton Short Kurti for Women | Ethnic Kurta for Girls',
    category: 'ethnic wear'
  }, filters, options), false);
});

test('occasion filters reject random Christmas catalog products', () => {
  const christmas = {
    searchCategories: ['dresses', 'tops', 'bottoms', 'shoes', 'outerwear', 'accessories'],
    signals: ['christmas', 'holiday', 'festive', 'red', 'green', 'velvet', 'sequin', 'sparkle', 'glitter'],
    requireSignal: true,
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette', 'saree', 'sari', 'lehenga', 'kurta', 'kurti', 'dupatta', 'ethnic']
  };

  assert.equal(productMatchesEventProfile({
    name: 'Red velvet party dress',
    category: 'dresses',
    color: 'red'
  }, christmas, {}), true);

  assert.equal(productMatchesEventProfile({
    name: 'Classic midi dress',
    category: 'dresses',
    color: 'black'
  }, christmas, {}), false);

  assert.equal(productMatchesEventProfile({
    name: 'White Oxford shirt',
    category: 'tops',
    color: 'white'
  }, christmas, { category: 'tops', color: 'white' }), false);

  assert.equal(productMatchesEventProfile({
    name: 'White sequin Christmas party shirt',
    category: 'tops',
    color: 'white'
  }, christmas, { category: 'tops', color: 'white' }), true);

  assert.equal(productMatchesEventProfile({
    name: 'Black lace lingerie robe',
    category: 'innerwear',
    color: 'black',
    tags: ['christmas']
  }, christmas, {}), false);

  assert.equal(productMatchesEventProfile({
    name: 'Gold festive saree',
    category: 'ethnic',
    color: 'gold',
    tags: ['festive']
  }, christmas, {}), false);

  assert.equal(productMatchesEventProfile({
    name: 'Gold dupatta festive accessory',
    category: 'accessories',
    color: 'gold',
    tags: ['festive']
  }, christmas, {}), false);
});

test('real Christmas profile still applies when an explicit clothing category is requested', () => {
  const filters = extractAiStudioFilters('white shirt for christmas', { genderPreference: 'female' });
  const christmas = eventProfileForMessage('white shirt for christmas', filters);
  const options = { specificLabel: specificProductLabel('white shirt for christmas', filters) };

  const valid = {
    name: 'White sequin Christmas shirt',
    category: 'tops',
    color: 'white'
  };
  const wrongType = {
    name: 'White floral blouse for parties',
    category: 'tops',
    color: 'white',
    tags: ['party']
  };
  const wrongOccasion = {
    name: 'White Oxford shirt',
    category: 'tops',
    color: 'white',
    tags: ['casual', 'office']
  };

  assert.equal(productSatisfiesHardFilters(valid, filters, options) && productMatchesEventProfile(valid, christmas, filters), true);
  assert.equal(productSatisfiesHardFilters(wrongType, filters, options) && productMatchesEventProfile(wrongType, christmas, filters), false);
  assert.equal(productSatisfiesHardFilters(wrongOccasion, filters, options) && productMatchesEventProfile(wrongOccasion, christmas, filters), false);
});

test('occasion filters allow category matches even without literal occasion tags', () => {
  const casual = {
    searchCategories: ['tops', 'bottoms', 'dresses', 'shoes', 'outerwear', 'accessories'],
    signals: ['casual', 'comfortable', 'denim', 'sneaker', 'relaxed']
  };
  const halloween = {
    searchCategories: ['costumes', 'dresses', 'tops', 'bottoms', 'shoes', 'outerwear', 'accessories'],
    signals: ['halloween', 'costume', 'black', 'orange', 'lace', 'leather'],
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette']
  };

  assert.equal(productMatchesEventProfile({
    name: 'White cotton shirt',
    category: 'tops',
    color: 'white'
  }, casual, {}), true);

  assert.equal(productMatchesEventProfile({
    name: 'Black ankle boots',
    category: 'shoes',
    color: 'black'
  }, halloween, {}), true);

  assert.equal(productMatchesEventProfile({
    name: 'Black lace bralette',
    category: 'innerwear',
    color: 'black',
    tags: ['halloween']
  }, halloween, {}), false);
});
