import { promptKeyForProduct } from './tryOnPrompts.js';

// Pruna numbers garment_images only. Its prompt selects garments; it is not
// the two-image editing instruction used by FAL (person first, garment second).
export function prunaGarmentSelection({ product = {}, garmentUrl, promptKey, turbo = true }) {
  const key = promptKey || promptKeyForProduct(product, 'upper');
  const identity = [product.name, product.category].filter(Boolean).join(' ');
  const tshirt = /\b(t[\s\u2010-\u2015-]?shirts?|tees?)\b/i.test(identity)
    && !/\b(jackets?|coats?|blazers?|hoodies?|cardigans?)\b/i.test(identity);
  if (key === 'full_outfit' && tshirt) {
    return {
      key,
      garment_images: [garmentUrl, garmentUrl],
      prompt: 'The pullover T-shirt from image 1 and the matching trousers from image 2.',
      turbo: false
    };
  }
  const garment = {
    upper: tshirt ? 'pullover T-shirt' : 'upper-body garment',
    lower: 'lower-body garment', full_outfit: 'complete outfit',
    saree: 'saree', watch: 'watch', glasses: 'glasses', hat: 'hat',
    shoes: 'footwear', accessory: 'accessory'
  }[key] || 'garment';
  return {
    key, garment_images: [garmentUrl],
    prompt: `The ${garment} from image 1.`,
    turbo
  };
}
