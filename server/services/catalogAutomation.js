const DEFAULT_QUANTITY = 10;
const MAX_QUANTITY = 12;

const COLOR_NAMES = [
  'black',
  'white',
  'red',
  'blue',
  'green',
  'yellow',
  'pink',
  'purple',
  'orange',
  'brown',
  'grey',
  'gray',
  'beige',
  'cream',
  'navy',
  'maroon',
  'olive',
  'gold',
  'silver'
];

const CATEGORY_INTENTS = [
  ['ethnic wear', /\b(sarees?|saris?|lehengas?|dupattas?|kurtas?|kurtis?|salwars?|anarkali|palazzos?|shararas?)\b/i],
  ['eyewear', /\b(sunglasses?|eyeglasses?|spectacles?|optical\s+frames?|goggles?|aviators?|wayfarers?)\b/i],
  ['innerwear', /\b(underwear|briefs?|boxers?|trunks?|innerwear|lingerie|bras?|bralettes?|pant(?:y|ies)|shapewear|bikinis?|swimsuits?)\b/i],
  ['sleepwear', /\b(night(?:y|ie|wear|gown|suit|dress)|sleepwear|pajamas?|pyjamas?|loungewear|robes?)\b/i],
  ['dresses', /\b(dress(?:es)?|gowns?|bodycon|maxi|midi|mini\s+dress|a-line\s+dress|wrap\s+dress)\b/i],
  ['skirts', /\b(skirts?|skorts?)\b/i],
  ['watches', /\b(watches?|smart\s*watches?|smartwatches?|chronographs?)\b/i],
  ['shoes', /\b(shoes?|sneakers?|boots?|loafers?|sandals?|slippers?|heels?|pumps?|flats?|footwear|trainers?)\b/i],
  ['bags', /\b(wallets?|purses?|backpacks?|handbags?|totes?|sling\s+bags?|crossbody|duffels?|clutches?)\b/i],
  ['accessories', /\b(belts?|caps?|hats?|scarves?|ties?|jewellery|jewelry|necklaces?|bracelets?|earrings?|accessor(?:y|ies))\b/i],
  ['jeans', /\b(jeans?|denim\s*(?:jeans|pants|trousers)?)\b/i],
  ['shorts', /\b(shorts?|bermudas?)\b/i],
  ['pants', /\b(pants?|trousers?|joggers?|leggings?|chinos?|cargo\s+pants?|track\s+pants?|bottomwear)\b/i],
  ['sweatshirts', /\b(hoodies?|sweatshirts?|sweaters?|pullovers?|jumpers?)\b/i],
  ['jackets', /\b(jackets?|overshirts?|blazers?|coats?|windcheaters?|parkas?|shrugs?)\b/i],
  ['t-shirts', /\b(t\s*-?\s*shirts?|tshirts?|tees?|polo\s*(?:shirts?)?)\b/i],
  ['shirts', /\b(shirts?|button\s*(?:down|up)|formal\s+shirt|casual\s+shirt)\b/i],
  ['tops', /\b(tops?|blouses?|tunics?|crop\s+tops?|tank\s+tops?|camis?)\b/i]
];

const ACCESSORY_CATEGORIES = new Set(['accessories', 'bags', 'eyewear', 'shoes', 'watches']);
const FULL_BODY_CATEGORIES = new Set(['dresses', 'ethnic wear']);
const BOTTOM_CATEGORIES = new Set(['jeans', 'pants', 'shorts', 'skirts']);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function boundedQuantity(value, fallback = DEFAULT_QUANTITY, max = MAX_QUANTITY) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function categoryFromText(value) {
  const text = compact(value);
  return CATEGORY_INTENTS.find(([, pattern]) => pattern.test(text))?.[0] || '';
}

function colorsFromText(value) {
  const text = compact(value).toLowerCase();
  return [...new Set(COLOR_NAMES.filter((color) => new RegExp(`\\b${color}\\b`, 'i').test(text))
    .map((color) => color === 'gray' ? 'grey' : color))];
}

function parseCatalogCommand(value, options = {}) {
  const command = compact(value);
  if (!command) throw new Error('Describe the products to fetch');
  if (command.length > 180) throw new Error('Keep the catalog request under 180 characters');

  const maxQuantity = boundedQuantity(options.maxQuantity, MAX_QUANTITY, 25);
  const quantityMatch = command.match(/^\s*(?:(?:find|fetch|add|import|get|create|bring|show)\s+)?(\d{1,3})\b/i) ||
    command.match(/\b(?:find|fetch|add|import|get|create|bring|show)\s+(\d{1,3})\b/i);
  const requestedQuantity = quantityMatch ? Number(quantityMatch[1]) : DEFAULT_QUANTITY;
  if (requestedQuantity > maxQuantity) {
    throw new Error(`A single smart fetch can add at most ${maxQuantity} drafts`);
  }

  let query = command
    .replace(/^\s*(?:please\s+)?(?:find|fetch|add|import|get|create|bring|show)\s+/i, '')
    .replace(/^\s*\d{1,3}\s*(?:x\s*)?/i, '')
    .replace(/\s+(?:and\s+)?(?:add|create|save|import)\s+(?:them\s+)?(?:to|in|into)\s+(?:the\s+)?catalog\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query || !/[a-z]/i.test(query)) throw new Error('Include a product type, such as black T-shirts or white dresses');

  const category = categoryFromText(query);
  const gender = /\b(women|woman|female|girls?|ladies)\b/i.test(query)
    ? 'women'
    : /\b(men|man|male|boys?|gentlemen)\b/i.test(query)
      ? 'men'
      : category === 'dresses'
        ? 'women'
        : 'unisex';
  const itemType = ACCESSORY_CATEGORIES.has(category) ? 'accessory' : 'auto';
  const garmentPlacement = itemType === 'accessory'
    ? 'accessory'
    : FULL_BODY_CATEGORIES.has(category)
      ? 'full-body'
      : BOTTOM_CATEGORIES.has(category)
        ? 'bottom'
        : 'top';

  return {
    command,
    quantity: boundedQuantity(requestedQuantity, DEFAULT_QUANTITY, maxQuantity),
    query,
    gender,
    genderPreference: gender === 'women' ? 'female' : gender === 'men' ? 'male' : '',
    category,
    itemType,
    garmentPlacement,
    colors: colorsFromText(query)
  };
}

function productText(product = {}) {
  return compact([
    product.name,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags,
    Array.isArray(product.colors) ? product.colors.join(' ') : product.colors
  ].filter(Boolean).join(' '));
}

function catalogIntentCompatibility(product = {}, intent = {}, options = {}) {
  const text = productText(product);
  const productCategory = compact(product.category).toLowerCase();
  if (intent.category) {
    const categoryPattern = CATEGORY_INTENTS.find(([category]) => category === intent.category)?.[1];
    if (productCategory !== intent.category && categoryPattern && !categoryPattern.test(text)) {
      return { compatible: false, reason: `Result did not match the requested ${intent.category} category` };
    }
  }

  if (intent.colors?.length) {
    const normalizedText = text.toLowerCase().replace(/\bgray\b/g, 'grey');
    const missingColors = intent.colors.filter((color) => !new RegExp(`\\b${color}\\b`, 'i').test(normalizedText));
    if (missingColors.length === intent.colors.length) {
      const mentionedColors = colorsFromText(normalizedText);
      if (options.allowUnverifiedColor && mentionedColors.length === 0) {
        return { compatible: true, unverifiedColors: [...intent.colors] };
      }
      if (options.allowUnverifiedColor && mentionedColors.length > 0) {
        return {
          compatible: false,
          reason: `Result mentioned ${mentionedColors.join(', ')} instead of the requested color: ${intent.colors.join(', ')}`
        };
      }
      return { compatible: false, reason: `Result did not mention the requested color: ${intent.colors.join(', ')}` };
    }
  }

  return { compatible: true };
}

function amazonAsin(value) {
  const match = compact(value).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)?/i);
  return match?.[1]?.toUpperCase() || '';
}

export {
  DEFAULT_QUANTITY,
  MAX_QUANTITY,
  amazonAsin,
  catalogIntentCompatibility,
  categoryFromText,
  colorsFromText,
  parseCatalogCommand
};
