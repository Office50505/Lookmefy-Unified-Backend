import { promptForKey, promptKeyForProduct } from './tryOnPrompts.js';
import { imagePrunaCostUsd } from './prunaClient.js';

export function prunaTryOnRequest({ product = {}, personUrl, garmentUrl, promptKey, turbo = true, outputFormat = 'jpg', outputQuality = 95, preserveInputSize = true, personWidth = 2, personHeight = 3 }) {
  const key = promptKey || promptKeyForProduct(product, 'upper');
  const title = String(product.name || '');
  const ethnic = /\b(kurtas?|kurtis?|lehengas?|lehngas?|dupattas?)\b/i.test(title);
  const edit = ethnic || ['glasses', 'accessory'].includes(key)
    || (key === 'lower' && /\bjeans\b/i.test(title) && /\b(?:flared?|bootcut|bell[ -]?bottom)\b/i.test(title))
    || (key === 'lower' && /\b(?:wrap\s?skirts?|skirts?|bikini|panties|briefs?|thongs?|boxers?|underwear)\b/i.test(title))
    || (key === 'full_outfit' && !/\bt[\s\u2010-\u2015-]?shirts?\b/i.test(title));
  if (edit) {
    return {
      model: 'p-image-edit', key, turbo: false, garmentCount: 1, providerCostUsd: 0.01,
      input: {
        images: [personUrl, garmentUrl],
        prompt: promptForKey(key, product),
        aspect_ratio: closestAspectRatio(personWidth, personHeight)
      }
    };
  }
  const selection = prunaGarmentSelection({ product, garmentUrl, promptKey: key, turbo: key === 'watch' ? false : turbo });
  const garmentCount = selection.garment_images.length;
  return {
    model: 'p-image-try-on', key, turbo: selection.turbo, garmentCount,
    providerCostUsd: imagePrunaCostUsd({ turbo: selection.turbo, garmentCount }),
    input: {
      person_image: personUrl, garment_images: selection.garment_images,
      prompt: selection.prompt, turbo: selection.turbo,
      output_format: outputFormat, output_quality: outputQuality, preserve_input_size: preserveInputSize
    }
  };
}

function closestAspectRatio(width, height) {
  const ratio = Number(width) / Number(height);
  if (!Number.isFinite(ratio) || ratio <= 0) return '2:3';
  return ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
    .reduce((best, candidate) => {
      const distance = value => {
        const [w, h] = value.split(':').map(Number);
        return Math.abs(Math.log(ratio / (w / h)));
      };
      return distance(candidate) < distance(best) ? candidate : best;
    });
}

// Pruna numbers garment_images only. Its prompt selects garments; it is not
// the two-image editing instruction used by FAL (person first, garment second).
export function prunaGarmentSelection({ product = {}, garmentUrl, promptKey, turbo = true }) {
  const key = promptKey || promptKeyForProduct(product, 'upper');
  const identity = [product.name, product.category].filter(Boolean).join(' ');
  const tshirt = /\b(t[\s\u2010-\u2015-]?shirts?|tees?)\b/i.test(identity)
    && !/\b(jackets?|coats?|blazers?|hoodies?|cardigans?)\b/i.test(identity);
  const kurta = /\b(kurtas?|kurtis?)\b/i.test(identity);
  if (key === 'full_outfit' && tshirt) {
    return {
      key,
      garment_images: [garmentUrl, garmentUrl],
      prompt: `The pullover T-shirt from image 1 and the matching ${/\bshorts\b/i.test(identity) ? 'shorts' : 'trousers'} from image 2.`,
      turbo: false
    };
  }
  let garment = {
    upper: tshirt ? 'pullover T-shirt' : kurta ? 'kurta tunic' : 'upper-body garment',
    lower: 'lower-body garment', full_outfit: 'complete outfit',
    saree: 'saree', watch: 'watch', glasses: 'glasses', hat: 'hat',
    shoes: 'footwear', accessory: 'accessory'
  }[key] || 'garment';
  if (key === 'upper' && !tshirt && !kurta) {
    garment = /\bblazers?\b/i.test(identity) ? 'blazer' : /\bjackets?\b/i.test(identity) ? 'jacket'
      : /\bcardigans?\b/i.test(identity) ? 'cardigan' : /\bshirts?\b/i.test(identity) ? 'shirt' : garment;
  }
  if (key === 'lower') {
    garment = /\b(?:wrap\s?skirts?|skirts?)\b/i.test(identity) ? (/\b(?:long|maxi|ankle)\b/i.test(identity) ? 'full-length skirt' : 'skirt')
      : /\b(?:panties|briefs?|thongs?|bikini)\b/i.test(identity) ? 'underwear bottoms'
      : /\bshorts\b/i.test(identity) ? 'shorts' : /\bjeans\b/i.test(identity) ? 'jeans' : garment;
  }
  return {
    key, garment_images: [garmentUrl],
    prompt: `The ${garment} from image 1.`,
    turbo: /blazer|jacket|cardigan|skirt/.test(garment) ? false : turbo
  };
}
