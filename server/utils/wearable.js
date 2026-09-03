const WEARABLE_CATEGORIES = new Set([
  'accessories',
  'bags',
  'dresses',
  'ethnic wear',
  'eyewear',
  'innerwear',
  'jackets',
  'jeans',
  'pants',
  'shirts',
  'shoes',
  'shorts',
  'skirts',
  'sleepwear',
  'sweatshirts',
  't-shirts',
  'tops',
  'watches'
]);

const wearableSignals = [
  [/\b(cloth(?:e|es|ing)?|apparel|garments?|outfits?|fashion|wearable|style|look)\b/i, 2],
  [/\b(sarees?|saris?|lehenga(?:s)?|dupatta(?:s)?|kurta(?:s)?|kurtis?|salwar(?:s)?|churidar(?:s)?|anarkali|palazzo(?:s)?|sharara(?:s)?)\b/i, 4],
  [/\b(sun\s*glasses|sunglasses|eye\s*glasses|eyeglasses|spectacles?|optical\s*frames?|goggles?|aviator|wayfarer)\b/i, 4],
  [/\b(underwear|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear|bikinis?|swimsuits?|swimwear|monokinis?)\b/i, 4],
  [/\b(night(?:y|ie|wear|gown|suit|dress)|sleepwear|pajamas?|pyjamas?|loungewear|robe)\b/i, 4],
  [/\b(dress(?:es)?|gowns?|suits?|bodycon|maxi|midi|mini\s*dress|a-line\s*dress|wrap\s*dress|party\s*dress)\b/i, 4],
  [/\b(skirts?|skorts?|jeans?|pants?|trousers?|joggers?|leggings?|chinos?|shorts?|bermudas?)\b/i, 4],
  [/\b(hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?|jackets?|overshirts?|blazers?|coats?|windcheaters?|parkas?|shrugs?)\b/i, 4],
  [/\b(t\s*-?\s*shirts?|tshirts?|tees?|polo\s*(?:shirts?)?|shirts?|button\s*(?:down|up)|tops?|blouses?|tunics?|crop\s*tops?|tank\s*tops?)\b/i, 4],
  [/\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?)\b/i, 4],
  [/\b(watch(?:es)?|smart\s*watch(?:es)?|smartwatch(?:es)?|chronograph)\b/i, 3],
  [/\b(wallets?|purses?|backpacks?|handbags?|totes?|sling\s*bags?|crossbody|duffels?|clutches?)\b/i, 3],
  [/\b(belts?|baseball\s*caps?|hats?|scarves?|ties?|jewellery|jewelry|necklaces?|bracelets?|earrings?|accessor(?:y|ies))\b/i, 3]
];

const nonWearableSignals = [
  ['an oral care product', /\b(tooth\s*paste|toothpaste|toote\s*paste|tooth\s*brush|toothbrush|mouth\s*wash|mouthwash|dental|oral\s+care|colgate|sensodyne|pepsodent)\b/i, 6],
  ['a beauty or hygiene product', /\b(shampoo|conditioner|soap|body\s*wash|face\s*wash|cleanser|lotion|cream|moisturi[sz]er|deodorant|perfume|makeup|cosmetics?|serum|sunscreen)\b/i, 5],
  ['a food or grocery product', /\b(food|grocery|snacks?|chocolate|candy|tea|coffee|rice|flour|oil|spices?|sauce|drink|beverage|juice|protein\s*powder)\b/i, 5],
  ['an electronics product', /\b(phone|mobile|laptop|tablet|camera|charger|cable|adapter|headphones?|earbuds?|speaker|keyboard|mouse|monitor|television|tv)\b/i, 5],
  ['a home product', /\b(furniture|chair|table|mattress|bedsheet|curtain|lamp|bottle|mug|plate|cookware|utensils?|detergent|cleaner|toilet|kitchen|bathroom)\b/i, 5],
  ['a book or stationery product', /\b(books?|notebooks?|pens?|pencils?|markers?|stationery|diary|paper)\b/i, 4],
  ['medicine or a supplement', /\b(medicine|tablet|capsules?|syrup|vitamins?|supplements?|pain\s*relief|antiseptic)\b/i, 5]
];

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function productText(product = {}, query = '') {
  return [
    query,
    product.name,
    product.brand,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].map(compactText).filter(Boolean).join(' ');
}

function scorePatterns(text, patterns) {
  return patterns.reduce((total, [, pattern, score]) => total + (pattern.test(text) ? score : 0), 0);
}

function wearableScoreFor(text, category) {
  const signalScore = wearableSignals.reduce((total, [pattern, score]) => total + (pattern.test(text) ? score : 0), 0);
  return signalScore + (WEARABLE_CATEGORIES.has(category) ? 4 : 0);
}

export function wearableCompatibility(product = {}, options = {}) {
  const category = compactText(product.category).toLowerCase();
  const text = productText(product, options.query);
  const wearableScore = wearableScoreFor(text, category);
  const nonWearableScore = scorePatterns(text, nonWearableSignals);
  const blockedType = nonWearableSignals.find(([, pattern]) => pattern.test(text))?.[0] || 'non-fashion product';

  if (nonWearableScore > 0 && nonWearableScore >= wearableScore) {
    return {
      compatible: false,
      reason: `This is not a compatible product type for AI try-on. Style Bot only supports wearable fashion items, and this looks like ${blockedType}.`
    };
  }

  if (wearableScore > 0) return { compatible: true };

  return {
    compatible: false,
    reason: 'This is not a compatible product type for AI try-on. Try clothes, shoes, watches, bags, eyewear, or accessories.'
  };
}
