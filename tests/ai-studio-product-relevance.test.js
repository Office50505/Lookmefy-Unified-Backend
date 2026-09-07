import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractAiStudioFilters,
  mergeFalPlan,
  productSearchEmptyReply,
  productSatisfiesHardFilters,
  rankCatalogProducts,
  specificProductLabel
} from '../server/services/aiStudio.js';

const query = 'black jeans';
const filters = extractAiStudioFilters(query);
const options = { specificLabel: 'jeans' };
const noMatchesReply = 'I could not find matching Lookmefy catalog products for black jeans.';

const blackJeans = {
  id: 'black-jeans',
  name: 'Women Black Wide Leg Jeans',
  category: 'bottoms',
  price: 999,
  imageUrl: '/black-jeans.jpg',
  source: 'lookmefy_catalog'
};
const blueJeans = {
  id: 'blue-jeans',
  name: 'Women Blue Wide Leg Jeans',
  category: 'jeans',
  color: 'black',
  colors: ['black', 'blue'],
  tags: ['black', 'jeans'],
  description: 'Shop our black jeans collection.',
  imageUrl: '/blue-jeans.jpg',
  source: 'lookmefy_catalog'
};
const denimShirt = {
  id: 'denim-shirt',
  name: 'Women Blue Denim Button-Down Shirt',
  category: 'jeans',
  color: 'black',
  colors: ['black', 'blue'],
  tags: ['black', 'jeans'],
  source: 'lookmefy_catalog'
};
const denimShorts = {
  id: 'denim-shorts',
  name: 'Women Black Denim Shorts | Jeans for Women',
  category: 'jeans',
  color: 'black',
  tags: ['black', 'jeans'],
  source: 'lookmefy_catalog'
};

function catalogPlan(overrides = {}) {
  return {
    mode: 'product_search',
    intent: 'product_search_confirmed',
    filters,
    reply: 'I found products.',
    products: [],
    outfits: [],
    actions: [],
    productSearchSource: 'lookmefy_catalog',
    productSearchQuery: query,
    ...overrides
  };
}

function mergePlan({ falPlan = {}, localPlan = catalogPlan(), candidateProducts = [], candidateOutfits = [] } = {}) {
  return mergeFalPlan({
    falPlan,
    localPlan,
    candidateProducts,
    candidateOutfits,
    requestFilters: filters,
    specificLabel: 'jeans'
  });
}

test('black jeans extracts both explicit color and product type from catalog requests', () => {
  for (const message of [query, 'Search Lookmefy catalog for black jeans']) {
    const extracted = extractAiStudioFilters(message);
    assert.equal(extracted.color, 'black');
    assert.equal(extracted.productType, 'jeans');
    assert.equal(extracted.category, 'bottoms');
    assert.equal(specificProductLabel(message, extracted), 'jeans');
  }
});

test('Women Black Wide Leg Jeans satisfies black jeans with title evidence alone', () => {
  assert.equal(productSatisfiesHardFilters(blackJeans, filters, options), true);
  assert.equal(productSatisfiesHardFilters({ title: blackJeans.name }, filters, options), true);
});

test('blue jeans incorrectly tagged and assigned black colors are rejected', () => {
  assert.equal(productSatisfiesHardFilters(blueJeans, filters, options), false);
});

test('a denim button-down shirt categorized as jeans is rejected', () => {
  assert.equal(productSatisfiesHardFilters(denimShirt, filters, options), false);
  assert.equal(productSatisfiesHardFilters({ ...denimShirt, name: 'Women Black Denim Button-Down Shirt' }, filters, options), false);
});

test('denim shorts with jeans in their SEO title are rejected', () => {
  assert.equal(productSatisfiesHardFilters(denimShorts, filters, options), false);
});

test('every conflicting garment is rejected even when jeans appears first in its title', () => {
  for (const garment of ['Shirt', 'Button-Down', 'Button Downs', 'Dress', 'Shorts', 'Skirt', 'Jacket']) {
    assert.equal(productSatisfiesHardFilters({
      name: `Black Jeans Denim ${garment} for Women`,
      category: 'jeans',
      type: 'jeans',
      tags: ['black', 'jeans']
    }, filters, options), false, `${garment} must not satisfy a jeans request`);
  }
});

test('only corroborated structured variant colors can supply a color omitted from the title', () => {
  for (const metadata of [
    { color: 'black' },
    { tags: ['black'] },
    { description: 'Classic black jeans' },
    { category: 'black jeans' },
    { color: 'black', tags: ['black'], description: 'Black jeans' }
  ]) {
    assert.equal(productSatisfiesHardFilters({ name: 'Women Wide Leg Jeans', ...metadata }, filters, options), false);
  }
  assert.equal(productSatisfiesHardFilters({ name: 'Women Wide Leg Jeans', colors: ['black'] }, filters, options), false);
  assert.equal(productSatisfiesHardFilters({ name: 'Women Wide Leg Jeans', colors: ['black'], description: 'Selected in Black' }, filters, options), true);
  assert.equal(productSatisfiesHardFilters({ name: 'Women Blue Wide Leg Jeans', colors: ['black', 'blue'] }, filters, options), false);
});

test('untrusted type metadata cannot supply missing garment evidence', () => {
  for (const metadata of [
    { category: 'jeans' },
    { subcategory: 'jeans' },
    { type: 'jeans' },
    { tags: ['jeans'] },
    { description: 'Black jeans with a comfortable fit' }
  ]) {
    assert.equal(productSatisfiesHardFilters({ name: 'Women Black Wide Leg', ...metadata }, filters, options), false);
  }
});

test('denim is material evidence and cannot establish the jeans garment type', () => {
  const denimFilters = extractAiStudioFilters('black denim');
  assert.equal(denimFilters.material, 'denim');
  assert.notEqual(denimFilters.productType, 'jeans');
  for (const name of ['Women Black Denim', 'Women Black Denim Pants', 'Women Black Denim Trousers']) {
    assert.equal(productSatisfiesHardFilters({ name, category: 'jeans' }, filters, options), false, name);
  }
});

test('filter extraction preserves the specific type when no label option is supplied', () => {
  assert.equal(productSatisfiesHardFilters(blackJeans, filters), true);
  assert.equal(productSatisfiesHardFilters({ name: 'Women Black Shorts', category: 'bottoms' }, filters), false);
});

test('catalog ranking validates every retrieved product before scoring can expose it', () => {
  const retrieved = [blueJeans, denimShirt, denimShorts, blackJeans];
  for (const requireMatch of [true, false]) {
    const results = rankCatalogProducts(retrieved, { query, filters, specificLabel: 'jeans', requireMatch });
    assert.deepEqual(results.map((product) => product.id), [blackJeans.id]);
  }
});

test('AI selection cannot weaken requested filters or restore invalid or invented products', () => {
  const result = mergePlan({
    candidateProducts: [blackJeans, blueJeans, denimShirt, denimShorts],
    falPlan: {
      mode: 'hybrid_wardrobe_shopping',
      filters: { color: 'blue', productType: 'shirt', category: 'tops' },
      selectedProductIds: [blueJeans.id, denimShirt.id, denimShorts.id, 'invented-id', blackJeans.id],
      products: [{ id: 'invented-id', name: 'Black Jeans' }, { ...blueJeans, name: 'Black Jeans' }],
      reply: 'Here are the selections.'
    }
  });
  assert.equal(result.filters.color, 'black');
  assert.equal(result.filters.productType, 'jeans');
  assert.equal(result.filters.category, 'bottoms');
  assert.deepEqual(result.products.map((product) => product.id), [blackJeans.id]);
  assert.equal(result.products[0].name, blackJeans.name);
});

test('the AI may rank valid catalog products while preserving canonical product data', () => {
  const otherBlackJeans = { ...blackJeans, id: 'black-straight-jeans', name: 'Women Black Straight Jeans' };
  const result = mergePlan({
    candidateProducts: [blackJeans, blueJeans, otherBlackJeans],
    falPlan: {
      selectedProductIds: [otherBlackJeans.id, blueJeans.id, blackJeans.id, otherBlackJeans.id],
      products: [{ ...otherBlackJeans, name: 'AI invented name' }]
    }
  });
  assert.deepEqual(result.products.map((product) => product.id), [otherBlackJeans.id, blackJeans.id]);
  assert.equal(result.products[0].name, otherBlackJeans.name);
});

test('AI-selected hybrid outfits cannot expose rejected or invented nested products', () => {
  const outfit = {
    id: 'hybrid-outfit',
    items: [{ id: 'wardrobe-jeans', name: 'Black Jeans', category: 'bottoms' }],
    products: [blackJeans, blueJeans, denimShirt, denimShorts, { id: 'invented-id', name: 'Black Jeans' }]
  };
  const result = mergePlan({
    localPlan: catalogPlan({ mode: 'hybrid_wardrobe_shopping', intent: 'outfit_revision', outfits: [outfit] }),
    candidateProducts: [blackJeans, blueJeans, denimShirt, denimShorts],
    candidateOutfits: [outfit],
    falPlan: { mode: 'hybrid_wardrobe_shopping', selectedOutfitIds: [outfit.id] }
  });
  assert.equal(result.outfits.length, 1);
  assert.deepEqual(result.outfits[0].products.map((product) => product.id), [blackJeans.id]);
  assert.deepEqual(result.products.map((product) => product.id), [blackJeans.id]);
});

test('the catalog empty response uses the exact requested text', () => {
  assert.equal(productSearchEmptyReply({ source: 'catalog-empty', query }, query), noMatchesReply);
});

test('no exact matches overrides AI success claims and returns no cards plus another search', () => {
  for (const candidateProducts of [[], [blueJeans, denimShirt, denimShorts]]) {
    const result = mergePlan({
      candidateProducts,
      falPlan: {
        reply: 'I found some black jeans for you in the Lookmefy catalog.',
        selectedProductIds: [blueJeans.id, denimShirt.id, denimShorts.id, 'invented-id'],
        actions: [{ type: 'try_on', label: 'Try these on' }]
      }
    });
    assert.equal(result.reply, noMatchesReply);
    assert.deepEqual(result.products, []);
    assert.deepEqual(result.outfits, []);
    assert.ok(result.actions.some((action) => /search/i.test(`${action.type} ${action.label} ${action.prompt}`)), 'empty results should offer another search');
    assert.ok(!result.actions.some((action) => action.type === 'try_on'), 'empty results must not offer unavailable product actions');
  }
});

test('unknown AI modes, intents, filters, and actions fail closed', () => {
  const result = mergePlan({
    candidateProducts: [blackJeans],
    falPlan: {
      mode: 'execute_purchase',
      intent: 'system_override',
      filters: { category: 'tops', productType: 'shirt', color: 'blue', untrusted: 'value' },
      selectedProductIds: [blackJeans.id],
      actions: [{ type: 'delete_account', label: 'Run hidden action', payload: { admin: true } }],
      reply: 'Here is the requested product.'
    }
  });

  assert.equal(result.mode, 'product_search');
  assert.equal(result.intent, 'product_search_confirmed');
  assert.equal(result.filters.category, 'bottoms');
  assert.equal(result.filters.productType, 'jeans');
  assert.equal(result.filters.color, 'black');
  assert.equal(result.filters.untrusted, undefined);
  assert.deepEqual(result.products.map((product) => product.id), [blackJeans.id]);
  assert.deepEqual(result.actions, []);
});
