const accessoryCategoryAliases = [
  'accessories',
  'accessory',
  'bags',
  'bag',
  'watches',
  'watch',
  'eyewear',
  'sunglasses',
  'jewellery',
  'jewelry',
  'caps',
  'hats',
  'scarves',
  'belts',
  'wallets',
  'purses'
];

const accessoryProductRules = [
  ['watch', /\b(?:watch(?:es)?|smart\s*watch(?:es)?|smartwatch(?:es)?|chronographs?)\b/i],
  ['wallet', /\bwallets?\b/i],
  ['bag', /\b(?:bags?|handbags?|backpacks?|purses?|totes?|sling\s+bags?|crossbody(?:\s+bags?)?|duffels?|clutches?|satchels?|shoulder\s+bags?|laptop\s+bags?)\b/i],
  ['belt', /\bbelts?\b/i],
  ['cap', /\b(?:caps?|baseball\s+caps?|skull\s+caps?)\b/i],
  ['hat', /\b(?:hats?|beanies?|fedoras?|bucket\s+hats?|sun\s+hats?)\b/i],
  ['scarf', /\b(?:scarfs?|scarves?|shawls?|wraps?|stoles?|mufflers?|bandanas?)\b/i],
  ['sunglasses', /\b(?:sun\s*glasses?|sunglasses?|goggles?|aviators?|wayfarers?)\b/i],
  ['eyeglasses', /\b(?:eye\s*glasses?|eyeglasses?|spectacles?|optical\s+frames?|eyewear)\b/i],
  ['earrings', /\bearrings?\b/i],
  ['necklace', /\bnecklaces?\b/i],
  ['bracelet', /\b(?:bracelets?|bangles?)\b/i],
  ['ring', /\brings?\b/i],
  ['jewellery', /\b(?:jewellery|jewelry|pendants?|brooches?|anklets?)\b/i],
  ['tie', /\b(?:ties|tie|bow\s*ties?)\b/i],
  ['gloves', /\bgloves?\b/i],
  ['socks', /\bsocks?\b/i],
  ['hair accessory', /\b(?:hair\s+accessor(?:y|ies)|headbands?|hair\s+bands?|hair\s+clips?|scrunchies?)\b/i]
];

const genericAccessoryPattern = /\baccessor(?:y|ies)\b/i;
const accessoryIdentityPattern = new RegExp(
  `(?:${accessoryProductRules.map(([, pattern]) => pattern.source).join('|')}|${genericAccessoryPattern.source})`,
  'i'
);

function accessoryTypeFromText(value = '') {
  const text = String(value || '');
  return accessoryProductRules
    .map(([label, pattern], order) => ({ label, order, index: text.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index || a.order - b.order)[0]?.label || '';
}

function accessoryPatternForType(type = '') {
  return accessoryProductRules.find(([label]) => label === type)?.[1] || null;
}

function isAccessoryText(value = '') {
  return accessoryIdentityPattern.test(String(value || ''));
}

export {
  accessoryCategoryAliases,
  accessoryIdentityPattern,
  accessoryPatternForType,
  accessoryProductRules,
  accessoryTypeFromText,
  isAccessoryText
};
