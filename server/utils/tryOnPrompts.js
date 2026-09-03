const TRY_ON_PROMPTS = {
  upper: String.raw`Use the upper-body garment from Image 1 as the garment reference and apply it to the person in Image 2.

Replace ONLY the person's upper-body clothing with the exact upper-body garment from Image 1. Preserve the garment's original design, color, pattern, fabric texture, neckline, sleeves, fit, length, logos, prints, embroidery, and all visible details as accurately as possible.

STRICTLY preserve the person's existing lower-body clothing from Image 2 exactly as it is. Do NOT replace, modify, recolor, redesign, extend, or cover the pants, jeans, skirt, shorts, trousers, or any other lower-body garment.

The clothing transfer must stop naturally at the upper garment's actual hemline. Do not interpret Image 1 as a full outfit and do not transfer any lower-body clothing from Image 1.

Keep the person's identity, face, hair, skin tone, body shape, pose, hands, legs, proportions, background, lighting, camera angle, and framing unchanged.

Only one modification is allowed: replace the upper-body garment.

Priority:

1. Preserve the person and original image.
2. Preserve the lower-body clothing exactly.
3. Transfer only the upper-body garment from Image 1.
4. Maintain the exact appearance and details of the reference garment.
5. Produce a realistic, naturally fitted virtual try-on result.`,

  lower: String.raw`Use the lower-body garment from Image 1 as the garment reference and apply it to the person in Image 2.

Replace ONLY the person's lower-body clothing with the exact lower-body garment from Image 1. Preserve the garment's original design, color, pattern, fabric texture, waistband, fit, cut, length, pockets, stitching, prints, logos, and all visible details as accurately as possible.

STRICTLY preserve the person's existing upper-body clothing from Image 2 exactly as it is. Do NOT replace, modify, recolor, redesign, shorten, extend, or alter the shirt, T-shirt, top, blouse, jacket, sweater, kurta, or any other upper-body garment.

The clothing transfer must begin naturally at the reference lower garment's actual waistband. Do not interpret Image 1 as a full outfit and do not transfer any upper-body clothing from Image 1.

Preserve the natural layering between the existing upper garment and the new lower garment. If the original upper garment is tucked, untucked, or overlaps the waistband, maintain that appearance naturally.

Keep the person's identity, face, hair, skin tone, body shape, pose, hands, legs, proportions, footwear, accessories, background, lighting, shadows, camera angle, and framing unchanged.

Only one modification is allowed: replace the lower-body garment.

Priority:

1. Preserve the person and original image.
2. Preserve the upper-body clothing exactly.
3. Transfer only the lower-body garment from Image 1.
4. Maintain the exact appearance and details of the reference garment.
5. Maintain realistic waist alignment, fit, folds, draping, and body proportions.
6. Produce a photorealistic, naturally fitted virtual try-on result.`,

  full_outfit: String.raw`Use the complete outfit from Image 1 as the clothing reference and apply it to the person in Image 2.

Replace the person's existing clothing with the COMPLETE outfit from Image 1, including BOTH the upper-body garment and lower-body garment. Treat the upper and lower garments as one coordinated outfit and transfer both together.

Preserve the reference outfit as accurately as possible, including its exact design, colors, patterns, prints, logos, embroidery, fabric texture, material appearance, neckline, collar, sleeves, cuffs, waistband, pockets, stitching, garment lengths, fit, cut, layering, proportions, and all other visible clothing details.

Do NOT mix the original clothing from Image 2 with the reference outfit. The final result must contain the upper-body AND lower-body garments from Image 1.

Maintain the correct relationship between both garments, including natural waist alignment, tucking or untucking, overlap, layering, garment lengths, folds, draping, and how the upper garment meets the lower garment.

Do NOT transfer the person, face, body, pose, background, or environment from Image 1. Image 1 must be used ONLY as the outfit reference.

STRICTLY preserve the person from Image 2: keep the exact same identity, face, facial features, hairstyle, hair color, skin tone, body shape, body proportions, pose, hands, arms, legs, expression, footwear, accessories, background, lighting, shadows, camera angle, framing, and image composition unchanged.

Do not unnecessarily expose, hide, reshape, crop, or regenerate body parts. Adapt the reference outfit naturally to the person's existing body and pose rather than changing the person to match the reference model.

ONLY the clothing should change.

Priority:

1. Preserve the person from Image 2 exactly.
2. Transfer BOTH upper and lower garments from Image 1.
3. Preserve the complete outfit's original appearance and coordination.
4. Maintain accurate garment boundaries, layering, proportions, and fit.
5. Preserve all non-clothing elements of Image 2.
6. Produce a photorealistic, naturally fitted virtual try-on result.`,

  shoes: String.raw`Use ONLY the footwear from Image 1 as the reference and apply it to the person in Image 2.

Replace ONLY the person's existing footwear with the exact shoes, sneakers, boots, heels, sandals, slippers, or other footwear shown in Image 1.

Preserve the reference footwear as accurately as possible, including its exact type, design, shape, color, material, texture, sole, heel height, laces, straps, buckles, stitching, logos, patterns, decorations, and all other visible details.

STRICTLY ignore every other item from Image 1. Do NOT transfer any upper-body clothing, lower-body clothing, full outfit, bags, handbags, jewelry, watches, belts, hats, sunglasses, or any other accessories from the reference image.

Image 1 must be used ONLY as a footwear reference.

Keep ALL existing clothing on the person in Image 2 completely unchanged, including both upper-body and lower-body garments.

Preserve the person from Image 2 exactly: same identity, face, hairstyle, skin tone, body shape, body proportions, pose, hands, legs, feet position, expression, clothing, accessories, background, lighting, shadows, camera angle, framing, and image composition.

Fit the reference footwear naturally onto the person's existing feet without changing the person's pose or leg position. Maintain realistic foot alignment, shoe orientation, perspective, scale, contact with the ground, occlusion, lighting, and shadows.

If part of the footwear is naturally hidden by pants, a dress, or the person's pose, preserve realistic occlusion rather than altering the clothing or body to expose the footwear.

ONLY ONE MODIFICATION IS ALLOWED: replace the footwear.

Priority:

1. Preserve the person and original image exactly.
2. Preserve ALL existing clothing and accessories from Image 2.
3. Transfer ONLY the footwear from Image 1.
4. Do not transfer any other element from Image 1.
5. Preserve the exact appearance of the reference footwear.
6. Ensure realistic fit, perspective, ground contact, lighting, and shadows.
7. Produce a photorealistic virtual try-on result.`,

  watch: String.raw`Use ONLY the watch or wristwear from Image 1 as the reference and apply it to the person in Image 2.

Transfer ONLY the exact watch, smartwatch, wristband, bracelet-style watch, or other wristwear shown in Image 1. Apply it naturally to ONE clearly visible and suitable wrist of the person in Image 2.

Preserve the reference wristwear as accurately as possible, including its exact design, shape, size, color, material, watch case, dial, screen, bezel, crown, buttons, strap, band, buckle, clasp, texture, stitching, metallic finish, logos, markings, and all other visible details.

STRICTLY ignore every other element from Image 1. Do NOT transfer any upper-body clothing, lower-body clothing, footwear, bags, jewelry, necklaces, rings, earrings, sunglasses, hats, belts, or any other accessories from the reference image.

Image 1 must be used ONLY as the watch/wristwear reference.

Keep ALL existing clothing, footwear, and accessories on the person in Image 2 completely unchanged. If the person already has something on the selected wrist that conflicts with the new wristwear, replace ONLY the conflicting wrist item and leave everything else untouched.

Preserve the person from Image 2 exactly: same identity, face, hairstyle, skin tone, body shape, body proportions, pose, arm position, hand position, fingers, clothing, footwear, accessories, background, lighting, shadows, camera angle, framing, and composition.

Do NOT change the person's arm, hand, wrist, or pose to make the watch more visible. Fit the wristwear naturally around the existing wrist position.

Maintain realistic wrist alignment, strap wrapping, scale, perspective, orientation, contact with the skin, occlusion, reflections, lighting, and shadows. The wristwear must look physically worn on the wrist, not pasted, floating, oversized, distorted, or embedded into the skin.

Apply the wristwear to ONE wrist only. Do NOT duplicate it onto both wrists unless the reference itself clearly represents a matched pair intended to be worn together.

ONLY ONE MODIFICATION IS ALLOWED: add or replace the watch/wristwear.

Priority:

1. Preserve the person and Image 2 exactly.
2. Transfer ONLY the watch/wristwear from Image 1.
3. Do not transfer any other element from Image 1.
4. Preserve the exact appearance and details of the reference wristwear.
5. Keep all clothing, footwear, and unrelated accessories unchanged.
6. Ensure realistic wrist placement, scale, perspective, lighting, reflections, and shadows.
7. Produce a photorealistic and naturally worn result.`,

  hat: String.raw`Use ONLY the headwear from Image 1 as the reference and apply it to the person in Image 2.

Transfer ONLY the exact hat, cap, beanie, bucket hat, fedora, or other headwear shown in Image 1. Place it naturally and realistically on the person's existing head in Image 2.

Preserve the reference headwear as accurately as possible, including its exact type, shape, structure, size, color, material, fabric texture, brim, visor, crown, panels, seams, stitching, logos, text, embroidery, patterns, decorations, fasteners, and all other visible details.

STRICTLY ignore every other element from Image 1. Do NOT transfer any upper-body clothing, lower-body clothing, footwear, bags, watches, jewelry, sunglasses, belts, scarves, or any other accessories from the reference image.

Image 1 must be used ONLY as a headwear reference.

Keep ALL existing clothing, footwear, and unrelated accessories on the person in Image 2 completely unchanged.

STRICTLY preserve the person's identity and head: keep the exact same face, facial features, facial proportions, hairstyle, hair color, hair length, hairline, ears, skin tone, expression, head shape, and head orientation. Do NOT regenerate or alter the person's face or hairstyle.

Fit the headwear naturally onto the person's existing head without changing the person's pose or head position. The headwear must follow the exact angle, perspective, orientation, and scale of the person's head.

Allow only the minimum physically necessary interaction between the headwear and hair. Hair may be naturally occluded where the headwear covers it, but do NOT unnecessarily shorten, restyle, recolor, remove, or regenerate the hairstyle. Visible hair outside the headwear must remain consistent with Image 2.

Maintain realistic contact, depth, occlusion, fabric structure, lighting, highlights, and cast shadows so the headwear appears genuinely worn rather than pasted, floating, oversized, undersized, distorted, or embedded into the head.

Do NOT copy the reference person's head, hair, face, pose, or background from Image 1.

ONLY ONE MODIFICATION IS ALLOWED: add or replace the headwear.

Priority:

1. Preserve the person and Image 2 exactly.
2. Transfer ONLY the headwear from Image 1.
3. Preserve the person's face and hairstyle.
4. Do not transfer any other element from Image 1.
5. Preserve the exact design and appearance of the reference headwear.
6. Ensure realistic head fit, scale, perspective, hair interaction, lighting, and shadows.
7. Produce a photorealistic and naturally worn result.`,

  glasses: String.raw`Use ONLY the glasses or eyewear from Image 1 as the reference and apply them naturally to the person in Image 2.

Transfer ONLY the exact glasses, eyeglasses, sunglasses, or eyewear shown in Image 1. Do not transfer any other element from the reference image.

Preserve the reference glasses as accurately as possible, including the exact frame shape, frame thickness, size, proportions, color, material, bridge design, nose pads, temples, hinges, lens shape, lens color or tint, transparency, gradient, reflective properties, logos, decorations, and all other visible details.

STRICTLY preserve the person's identity and face from Image 2. Keep the exact same facial structure, eyes, eyebrows, nose, lips, ears, skin tone, hairstyle, expression, head shape, head angle, gaze direction, and facial proportions.

Do NOT reshape, regenerate, beautify, smooth, distort, or otherwise modify the person's face to accommodate the glasses. Adapt the glasses to the person's existing face instead.

Position the glasses anatomically correctly: the bridge must rest naturally on the nose, the lenses must align correctly with the eyes, and the temples must extend naturally toward and around the ears according to the person's head angle.

Match the exact perspective, rotation, scale, and orientation of the person's face. If the head is turned or tilted, the glasses must follow the same 3D perspective naturally.

Maintain realistic contact points, occlusion, lens transparency, refraction, reflections, highlights, and subtle shadows. The glasses must appear genuinely worn rather than pasted, floating, crooked, oversized, undersized, or embedded into the face.

For transparent or prescription lenses, keep the person's eyes naturally visible through the lenses. For tinted or sunglass lenses, preserve the reference lens tint and opacity without unnecessarily changing the surrounding face or skin.

STRICTLY ignore all other elements from Image 1. Do NOT transfer clothing, footwear, hats, watches, jewelry, bags, hairstyles, facial characteristics, body features, or other accessories.

Keep everything else in Image 2 unchanged, including the person's clothing, accessories, body, pose, hands, background, lighting, shadows, camera angle, framing, and composition.

ONLY ONE MODIFICATION IS ALLOWED: add or replace the glasses.

Priority:

1. Preserve the person's identity and facial features exactly.
2. Transfer ONLY the glasses from Image 1.
3. Preserve the exact design and appearance of the reference glasses.
4. Maintain anatomically correct placement on the nose, eyes, and ears.
5. Match the person's head angle and facial perspective.
6. Preserve realistic lenses, reflections, transparency, contact, and shadows.
7. Do not modify any unrelated part of Image 2.
8. Produce a photorealistic, naturally worn result.`
};

const FALLBACK_PROMPTS = {
  accessory: [
    'Use ONLY the accessory from the garment reference image and apply it naturally to the person image.',
    'Do not transfer clothing, face, hair, body, pose, background, or any unrelated item from the garment reference image.',
    'Preserve the person, clothing, footwear, background, lighting, shadows, camera angle, framing, and composition exactly.',
    'Only one modification is allowed: add or replace the selected accessory.',
    'Produce a photorealistic, naturally worn result.'
  ].join(' ')
};

function normalizePromptText(value = '') {
  return String(value || '')
    .replace(/\u2028/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function loadPromptSections() {
  return TRY_ON_PROMPTS;
}

function textForProduct(product = {}) {
  return [
    product.name,
    product.brand,
    product.category,
    product.gender,
    product.description,
    product.garmentPlacement,
    Array.isArray(product.tags) ? product.tags.join(' ') : product.tags,
    Array.isArray(product.bullets) ? product.bullets.join(' ') : product.bullets
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isWatchProduct(product = {}) {
  return /\b(watch(?:es)?|smart\s?watch(?:es)?|wrist\s?watch(?:es)?|wristwear|fitness\s?band(?:s)?)\b/i.test(textForProduct(product));
}

function promptKeyForProduct(product = {}, fallback = 'upper') {
  const text = textForProduct(product);
  if (isWatchProduct(product)) return 'watch';
  if (/\b(sunglasses?|eyeglasses?|glasses|eyewear|spectacles?|frames?)\b/i.test(text)) return 'glasses';
  if (/\b(hats?|caps?|beanies?|bucket\s?hats?|fedoras?|headwear|head\s?wear)\b/i.test(text)) return 'hat';
  if (/\b(shoes?|sneakers?|boots?|heels?|sandals?|slippers?|loafers?|footwear)\b/i.test(text)) return 'shoes';
  if (product.garmentPlacement === 'accessory') return 'accessory';
  if (product.garmentPlacement === 'full-body') return 'full_outfit';
  if (/\b(outfits?|sets?|co-?ords?|coordinated|tracksuits?|suits?|jumpsuits?|rompers?|dress(?:es)?|gowns?|sarees?|lehenga|kurta\s?sets?)\b/i.test(text)) return 'full_outfit';
  if (/\b(pants?|trousers?|jeans?|denim|shorts?|skirts?|leggings?|joggers?|palazzos?|bottoms?|lower)\b/i.test(text)) return 'lower';
  if (/\b(tops?|shirts?|t-?shirts?|tees?|blouses?|sweaters?|sweatshirts?|hoodies?|jackets?|coats?|blazers?|kurtas?|upper)\b/i.test(text)) return 'upper';
  if (/\b(bags?|handbags?|purses?|totes?|backpacks?|wallets?|belts?|scarves?|jewelry|jewellery|necklaces?|rings?|earrings?|bracelets?)\b/i.test(text)) return 'accessory';
  if (product.garmentPlacement === 'bottom') return 'lower';
  return fallback;
}

function promptForKey(key, product = {}) {
  const prompts = loadPromptSections();
  const selected = prompts[key] || FALLBACK_PROMPTS[key] || prompts.upper || prompts.full_outfit || '';
  const productName = String(product?.name || 'the selected item').trim();
  const productBrand = String(product?.brand || '').trim();
  const descriptor = productBrand ? `${productName} by ${productBrand}` : productName;

  return [
    `Product context: ${descriptor}.`,
    selected
      .replace(/\bImage 1\b/g, 'the garment reference image')
      .replace(/\bimage 1\b/g, 'the garment reference image')
      .replace(/\bImage 2\b/g, 'the person image')
      .replace(/\bimage 2\b/g, 'the person image')
  ]
    .filter(Boolean)
    .join('\n\n');
}

function promptForProduct(product = {}, fallback = 'upper') {
  const key = promptKeyForProduct(product, fallback);
  return {
    key,
    prompt: promptForKey(key, product)
  };
}

export {
  isWatchProduct,
  promptForKey,
  promptForProduct,
  promptKeyForProduct
};
