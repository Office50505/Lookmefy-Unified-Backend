function clean(value = '') {
  return String(value || '').trim().toLowerCase();
}

const womenSpecificFashionPattern = /\b(bras?|bralettes?|sports?\s+bras?|lingerie|pant(?:y|ies)|bikinis?|swimsuits?|swimwear|one\s*piece\s+swimsuits?|monokinis?)\b/i;
const malePreferencePattern = /\b(?:men'?s?|man'?s?|male|gentlemen|boys?)\b/gi;
const femalePreferencePattern = /\b(?:women'?s?|woman'?s?|female|lad(?:y|ies)|girls?)\b/gi;

export function normalizeGenderPreference(value = '') {
  const gender = clean(value);
  if (['male', 'man', 'men'].includes(gender)) return 'male';
  if (['female', 'woman', 'women'].includes(gender)) return 'female';
  if (['other', 'non-binary', 'nonbinary', 'unisex'].includes(gender)) return 'other';
  return '';
}

export function productGenderForPreference(value = '') {
  const preference = normalizeGenderPreference(value);
  if (preference === 'male') return 'men';
  if (preference === 'female') return 'women';
  return '';
}

export function explicitGenderPreferenceForText(value = '') {
  const text = clean(value);
  const mentions = [
    ...Array.from(text.matchAll(malePreferencePattern), (match) => ({ gender: 'male', index: match.index ?? -1 })),
    ...Array.from(text.matchAll(femalePreferencePattern), (match) => ({ gender: 'female', index: match.index ?? -1 }))
  ].sort((left, right) => left.index - right.index);
  return mentions.at(-1)?.gender || '';
}

export function genderPreferenceForQuery(query = '', preference = '') {
  const explicitPreference = explicitGenderPreferenceForText(query);
  if (explicitPreference) return explicitPreference;
  if (womenSpecificFashionPattern.test(String(query || ''))) return 'female';
  return normalizeGenderPreference(preference);
}

export function genderedSearchQuery(query = '', preference = '') {
  const target = productGenderForPreference(genderPreferenceForQuery(query, preference));
  if (!target) return String(query || '').trim();
  const withoutGender = String(query || '')
    .replace(/\b(male|female|men'?s?|women'?s?|mans?|womans?|boys?|girls?|ladies|gentlemen)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${target} ${withoutGender}`.trim();
}

export function genderCompatibility(product = {}, preference = '') {
  const target = productGenderForPreference(preference);
  if (!target) return { compatible: true };

  const productGender = clean(product.gender);
  const text = [
    product.name,
    product.brand,
    product.category,
    product.description,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags
  ].filter(Boolean).join(' ');
  const isMens = /\b(men'?s?|male|boys?|gentlemen)\b/i.test(text);
  const isWomens = /\b(women'?s?|female|girls?|ladies)\b/i.test(text);
  const isUnisex = ['unisex', 'other'].includes(productGender) || /\bunisex\b/i.test(text) || (isMens && isWomens);

  if (isUnisex) return { compatible: true };

  if (target === 'women' && (productGender === 'men' || isMens)) {
    return { compatible: false, reason: 'This result is for men, but your profile preference is female.' };
  }
  if (target === 'men' && (productGender === 'women' || isWomens)) {
    return { compatible: false, reason: 'This result is for women, but your profile preference is male.' };
  }

  return { compatible: true };
}
