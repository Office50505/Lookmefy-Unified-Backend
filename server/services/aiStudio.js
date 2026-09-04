import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import Product, { productToClient } from '../models/Product.js';
import UserEvent from '../models/UserEvent.js';
import { genderCompatibility, genderedSearchQuery, genderPreferenceForQuery } from '../utils/genderPreference.js';
import { inferTryOnModel } from '../utils/tryOnModel.js';
import { availableStatusClause } from '../utils/productAvailability.js';
import { safeFetchText } from '../utils/security.js';
import { wearableCompatibility } from '../utils/wearable.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const knowledgeDir = path.resolve(__dirname, '..', 'knowledge', 'ai-studio');

const stopWords = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does',
  'for', 'from', 'give', 'how', 'i', 'in', 'is', 'it', 'like', 'me', 'my', 'of', 'on', 'or', 'our',
  'should', 'show', 'that', 'the', 'this', 'to', 'use', 'what', 'when', 'with', 'you', 'your'
]);

const categoryAliases = {
  tops: ['tops', 'shirts', 'shirt', 't-shirts', 'tshirts', 'tees', 'blouses', 'hoodies'],
  bottoms: ['bottoms', 'pants', 'trousers', 'jeans', 'shorts', 'skirts', 'joggers'],
  outerwear: ['outerwear', 'jackets', 'jacket', 'blazers', 'blazer', 'coats'],
  accessories: ['accessories', 'bags', 'bag', 'watches', 'watch', 'eyewear', 'jewellery', 'jewelry'],
  ethnic: ['ethnic', 'ethnic wear', 'kurta', 'kurti', 'saree', 'lehenga'],
  dresses: ['dresses', 'dress', 'gown', 'frock'],
  shoes: ['shoes', 'shoe', 'sneakers', 'sneaker', 'loafers', 'heels', 'sandals', 'boots'],
  innerwear: ['innerwear', 'underwear', 'lingerie', 'bra', 'bralette'],
  swimwear: ['swimwear', 'bikini', 'swimsuit'],
  costumes: ['costumes', 'costume', 'cosplay']
};

const eventProfiles = {
  office: {
    key: 'office',
    label: 'office',
    aliases: ['work', 'meeting', 'interview', 'formal'],
    requiredGroups: [['tops'], ['bottoms'], ['shoes', 'outerwear']],
    searchCategories: ['tops', 'bottoms', 'shoes', 'outerwear'],
    signals: ['office', 'work', 'formal', 'classic', 'tailored', 'blazer', 'loafer', 'trouser'],
    searchTerms: ['formal shirt', 'tailored trousers', 'office shoes'],
    minSignalItems: 1
  },
  party: {
    key: 'party',
    label: 'party',
    aliases: ['club', 'night out'],
    requiredGroups: [['dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['accessories', 'outerwear']],
    searchCategories: ['dresses', 'tops', 'bottoms', 'shoes', 'accessories'],
    signals: ['party', 'classy', 'satin', 'dress', 'gown', 'night', 'statement'],
    searchTerms: ['party dress', 'satin shirt', 'party heels', 'statement accessories'],
    minSignalItems: 1
  },
  wedding: {
    key: 'wedding',
    label: 'wedding',
    aliases: ['festive', 'reception', 'sangeet'],
    requiredGroups: [['ethnic', 'dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['accessories', 'outerwear']],
    searchCategories: ['ethnic', 'dresses', 'bottoms', 'shoes', 'accessories'],
    signals: ['wedding', 'festive', 'ethnic', 'kurta', 'saree', 'lehenga', 'embroidered', 'silk'],
    searchTerms: ['festive kurta', 'wedding dress', 'ethnic footwear', 'gold accessories'],
    minSignalItems: 2
  },
  diwali: {
    key: 'diwali',
    label: 'festival',
    aliases: ['eid', 'holi', 'festival', 'festive'],
    requiredGroups: [['ethnic', 'dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['accessories']],
    searchCategories: ['ethnic', 'dresses', 'accessories', 'shoes'],
    signals: ['diwali', 'eid', 'holi', 'festive', 'ethnic', 'kurta', 'saree', 'lehenga', 'embroidered'],
    searchTerms: ['festive kurta', 'ethnic dress', 'saree', 'festive accessories'],
    minSignalItems: 1
  },
  farewell: {
    key: 'farewell',
    label: 'farewell',
    aliases: ['freshers', 'prom', 'graduation', 'send off'],
    requiredGroups: [['dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['accessories', 'outerwear']],
    searchCategories: ['dresses', 'tops', 'bottoms', 'shoes', 'accessories'],
    signals: ['farewell', 'party', 'classy', 'formal', 'blazer', 'trouser', 'loafer', 'satin', 'dress'],
    searchTerms: ['farewell outfit', 'formal party shirt', 'dressy shoes', 'statement accessories'],
    minSignalItems: 2
  },
  beach: {
    key: 'beach',
    label: 'beach vacation',
    aliases: ['vacation', 'resort', 'pool', 'holiday'],
    requiredGroups: [['tops', 'dresses'], ['bottoms', 'dresses'], ['shoes']],
    searchCategories: ['tops', 'bottoms', 'dresses', 'shoes'],
    signals: ['beach', 'vacation', 'resort', 'pool', 'linen', 'summer', 'sandals', 'shorts', 'breathable'],
    searchTerms: ['linen resort shirt', 'linen shorts', 'beach sandals', 'vacation dress'],
    minSignalItems: 2
  },
  gym: {
    key: 'gym',
    label: 'gym',
    aliases: ['workout', 'training', 'active'],
    requiredGroups: [['tops'], ['bottoms'], ['shoes']],
    searchCategories: ['tops', 'bottoms', 'shoes'],
    signals: ['gym', 'workout', 'training', 'active', 'sport', 'running', 'breathable', 'stretch'],
    searchTerms: ['training tee', 'workout joggers', 'running shoes'],
    minSignalItems: 2
  },
  dinner: {
    key: 'dinner',
    label: 'dinner',
    aliases: ['date', 'date night'],
    requiredGroups: [['dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['outerwear', 'accessories']],
    searchCategories: ['dresses', 'tops', 'bottoms', 'shoes', 'accessories'],
    signals: ['dinner', 'date', 'classy', 'satin', 'black', 'evening'],
    searchTerms: ['dinner outfit', 'evening dress', 'dressy shoes'],
    minSignalItems: 1
  },
  travel: {
    key: 'travel',
    label: 'travel',
    aliases: ['airport', 'trip'],
    requiredGroups: [['tops'], ['bottoms'], ['shoes']],
    searchCategories: ['tops', 'bottoms', 'shoes'],
    signals: ['travel', 'comfortable', 'casual', 'sneaker', 'relaxed'],
    searchTerms: ['comfortable travel top', 'relaxed travel pants', 'travel sneakers'],
    minSignalItems: 1
  },
  casual: {
    key: 'casual',
    label: 'casual',
    aliases: ['college', 'brunch'],
    requiredGroups: [['tops'], ['bottoms'], ['shoes']],
    searchCategories: ['tops', 'bottoms', 'shoes'],
    signals: ['casual', 'comfortable', 'denim', 'sneaker', 'relaxed', 'brunch', 'college'],
    searchTerms: ['casual top', 'straight jeans', 'white sneakers'],
    minSignalItems: 1
  }
};

const conversations = new Map();
let knowledgeCache = null;

function envFlag(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off|disabled)$/i.test(String(value).trim());
}

function positiveNumber(name, fallback, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

const conversationTtlMs = positiveNumber('AI_STUDIO_CONVERSATION_TTL_DAYS', 1, { min: 1, max: 90 }) * 24 * 60 * 60 * 1000;
const productResultLimit = Math.floor(positiveNumber('AI_STUDIO_PRODUCT_RESULT_LIMIT', 8, { min: 2, max: 12 }));
const amazonResultLimit = Math.floor(positiveNumber('AI_STUDIO_AMAZON_RESULT_LIMIT', 4, { min: 1, max: 6 }));
const amazonTimeoutMs = positiveNumber('AI_STUDIO_AMAZON_TIMEOUT_MS', 2500, { min: 500, max: 8000 });
const falTimeoutMs = positiveNumber('FAL_AI_STUDIO_TIMEOUT_MS', 20000, { min: 1000, max: 60000 });
const falMaxTokens = Math.floor(positiveNumber('FAL_AI_STUDIO_MAX_TOKENS', 720, { min: 160, max: 2000 }));
const falTemperature = positiveNumber('FAL_AI_STUDIO_TEMPERATURE', 0.25, { min: 0, max: 1 });

function cleanText(value = '', limit = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalize(value = '') {
  return cleanText(value, 2000).toLowerCase();
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textHasTerm(text = '', term = '') {
  const cleaned = normalize(term);
  if (!cleaned) return false;
  return new RegExp(`\\b${escapeRegExp(cleaned).replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalize(text));
}

function titleCaseWords(value = '') {
  return cleanText(value)
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function queryTerms(value = '', limit = 8) {
  return [...new Set(normalize(value).match(/[a-z0-9]{3,}/g) || [])].slice(0, limit);
}

function tokenize(value = '') {
  return [...new Set(normalize(value).match(/[a-z0-9]{3,}/g) || [])]
    .filter((token) => !stopWords.has(token))
    .slice(0, 36);
}

function aiStudioQueryTerms(message = '') {
  return queryTerms(message)
    .filter((term) => !['show', 'find', 'search', 'want', 'need', 'with', 'under', 'look', 'style'].includes(term))
    .slice(0, 5);
}

function mentionsLookmefy(message = '') {
  const lower = normalize(message);
  const compact = lower.replace(/[^a-z]+/g, '');
  return /\blook\s*mefy\b|\blookmefy\b/.test(lower) || compact.includes('lookmefy');
}

function canonicalGreetingToken(token = '') {
  return normalize(token).replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
}

function isGreetingOnly(message = '') {
  const raw = cleanText(message);
  if (!raw) return false;
  const lower = normalize(raw).replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  if (/^h+i+$/.test(compact) || /^h+e+(?:y+)?$/.test(compact) || /^h+e+l+o+$/.test(compact)) return true;
  if (/^go+d+(morning|afternoon|evening)$/.test(compact)) return true;
  const tokens = lower.match(/[a-z0-9]+/g) || [];
  if (!tokens.length || tokens.length > 4) return false;
  const greetingWords = new Set(['hi', 'hey', 'he', 'helo', 'hello', 'hlo', 'hlw', 'hay', 'hai', 'hola', 'yo', 'sup', 'gm', 'morning', 'afternoon', 'evening', 'namaste', 'namaskar', 'salam']);
  const fillerWords = new Set(['bro', 'brother', 'bruh', 'yaar', 'sir', 'dude', 'there', 'dear', 'buddy', 'ji', 'lookmefy', 'lm', 'ai']);
  const canonical = tokens.map(canonicalGreetingToken);
  if (canonical.join('') === 'goodmorning' || canonical.join('') === 'goodafternoon' || canonical.join('') === 'goodevening') return true;
  return canonical.some((token) => greetingWords.has(token))
    && canonical.every((token) => greetingWords.has(token) || fillerWords.has(token));
}

function isCasualGreetingPrefix(message = '') {
  const lower = normalize(message).replace(/[^\w\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = lower.match(/[a-z0-9]+/g) || [];
  if (tokens.length < 2 || tokens.length > 5) return false;
  const first = canonicalGreetingToken(tokens[0]);
  const greetingWords = new Set(['hi', 'hey', 'he', 'helo', 'hello', 'hlo', 'hlw', 'hay', 'hai', 'hola', 'yo', 'sup', 'gm', 'namaste', 'namaskar', 'salam']);
  const fillerWords = new Set(['bro', 'brother', 'bruh', 'yaar', 'sir', 'dude', 'there', 'dear', 'buddy', 'ji', 'lookmefy', 'lm', 'ai']);
  return (greetingWords.has(first) || /^h+i+$/.test(tokens[0]) || /^h+e+(?:y+)?$/.test(tokens[0]))
    && tokens.slice(1).map(canonicalGreetingToken).every((token) => fillerWords.has(token));
}

function isSmallTalk(message = '') {
  const lower = normalize(message).trim();
  return /^(thanks|thank you|thx|cool|nice|great|perfect|okay|ok|k|lol|haha|love it|looks good|sounds good)[!.\s]*$/.test(lower)
    || /\b(how are you|what'?s up|who are you|what can you do|i am bored|i'm bored|tell me a joke)\b/.test(lower)
    || /\b(kya kar raha|kya kar rahe|kya chal raha|kaise ho|kya scene|kya kar raha hai)\b/.test(lower);
}

function detectLanguagePreference(message = '') {
  const lower = normalize(message);
  if (/\b(hinglish|hindi\s*english|hindi-english)\b/.test(lower)) return 'hinglish';
  if (/\b(talk|speak|reply|respond|baat)\b.*\b(hindi)\b/.test(lower)) return 'hindi';
  if (/\b(talk|speak|reply|respond)\b.*\benglish\b/.test(lower)) return 'english';
  return '';
}

function messageLooksHinglish(message = '') {
  return /\b(kya|kar|raha|rahe|hai|hain|haan|nahi|batao|kaise|achha|acha|chahiye|pehnu|kapde|scene|matlab)\b/i.test(String(message || ''));
}

function containsAbuse(message = '') {
  return /\b(lawde|laude|lode|lund|chutiya|chutia|madarchod|maderchod|bhenchod|behenchod|bsdk|bhosdike|gandu|gaandu|randi|harami|fuck|fucking|asshole|bitch|bastard|shut\s*up|stfu)\b/i.test(String(message || ''));
}

function detectCelebrityStyleRequest(message = '') {
  const text = cleanText(message);
  const patterns = [
    /\b(?:dress|dressing|look|style|outfit|wear)\s+(?:like|as|inspired\s+by)\s+([a-z][a-z .'-]{2,60})/i,
    /\b([a-z][a-z .'-]{2,60})\s+(?:style|inspired\s+look|inspired\s+outfit)\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]
      ?.replace(/\b(?:for|under|below|with|in|from|on|outfit|look|style|dress|clothes?)\b.*$/i, '')
      .trim();
    if (name && !mentionsLookmefy(name) && name.split(/\s+/).length <= 5) return { name: titleCaseWords(name) };
  }
  return null;
}

function hasLookmefyScope(message = '', filters = {}) {
  const lower = normalize(message);
  if (mentionsLookmefy(message)) return true;
  if (filters.category || filters.occasion || filters.style || filters.color || filters.budget || filters.fit || filters.material) return true;
  return /\b(lookmefy|fashion|style|styling|outfit|wear|wardrobe|closet|shop|shopping|buy|find|search|products?|try\s*on|preview|generate|tokens?|credits?|wishlist|profile|history|dress|shirt|top|pants|trouser|jeans|shoe|sneaker|loafer|heel|sandal|jacket|blazer|coat|watch|bag|belt|jewellery|jewelry|accessory|ethnic|kurta|saree|costume|cosplay|halloween|bra|bralette|lingerie|underwear|innerwear|bikini|swimsuit|swimwear|wedding|party|dinner|date|farewell|freshers|prom|christmas|diwali|eid|holi|office|college|travel|vacation|resort|beach|pool|gym|workout|brunch|interview|change|swap|replace|another|other|different|remove|avoid|without|bolder|cleaner|classy|casual|formal)\b/.test(lower);
}

function isOutOfScope(message = '', filters = {}) {
  return !(isGreetingOnly(message) || isCasualGreetingPrefix(message) || isSmallTalk(message) || detectLanguagePreference(message) || hasLookmefyScope(message, filters));
}

function budgetPattern() {
  return /(?:under|below|upto|up to|less than)\s*(?:rs\.?|inr)?\s*\d{2,6}/i;
}

function isListAllProductsPrompt(message = '') {
  const lower = normalize(message).trim();
  return /\b(list|show|display|view|see|get)\b.*\ball\b.*\bproducts?\b/.test(lower)
    || /\ball\s+products?\b/.test(lower)
    || /^products?$/.test(lower);
}

function extractFilters(message = '', profile = {}) {
  const lower = normalize(message);
  const celebrityStyle = detectCelebrityStyleRequest(message);
  const budget = lower.match(/(?:under|below|upto|up to|less than)\s*(?:rs\.?|inr)?\s*(\d{2,6})/)?.[1];
  const color = lower.match(/\b(black|white|cream|beige|blue|navy|green|red|pink|brown|grey|gray|gold|silver|maroon|purple|lavender|yellow|orange)\b/)?.[1] || '';
  const occasionMatch = lower.match(/\b(new year|christmas|diwali|eid|holi|office|party|wedding|weeding|date|dinner|college|collage|travel|vacation|resort|beach|pool|gym|workout|casual|formal|brunch|interview|festive|farewell|freshers|prom|graduation)\b/)?.[1] || '';
  const occasionAliases = {
    weeding: 'wedding',
    vacation: 'beach',
    resort: 'beach',
    pool: 'beach',
    workout: 'gym',
    collage: 'college',
    festive: 'wedding',
    freshers: 'farewell',
    prom: 'farewell',
    graduation: 'farewell'
  };
  const categoryMap = [
    ['costumes', /\b(halloween|costumes?|cosplay|fancy\s*dress)\b/],
    ['swimwear', /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|one\s*piece\s+swimsuits?)\b/],
    ['innerwear', /\b(underwear|undergarments?|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear)\b/],
    ['shoes', /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?)\b/],
    ['ethnic', /\b(kurtas?|kurtis?|sarees?|saris?|lehengas?|dupattas?|salwars?|anarkali|churidar|sharara|ethnic)\b/],
    ['tops', /\b(shirts?|t-?shirts?|tops?|blouses?|hoodies?|tees?)\b/],
    ['bottoms', /\b(pants?|trousers?|jeans?|shorts?|skirts?|joggers?)\b/],
    ['outerwear', /\b(jackets?|blazers?|coats?|cardigans?)\b/],
    ['accessories', /\b(watches?|bags?|belts?|jewellery|jewelry|earrings?|necklaces?|sunglasses?|eyewear)\b/],
    ['dresses', /\b(dress(?:es)?|gowns?|frocks?)\b/]
  ];
  let category = categoryMap.find(([, pattern]) => pattern.test(lower))?.[0] || '';
  if (celebrityStyle && category === 'dresses' && /\bdress(?:ing)?\s+like\b/.test(lower) && !/\b(dresses|gowns?|frocks?|midi|maxi|bodycon|a-line|fit\s*&?\s*flare)\b/.test(lower)) {
    category = '';
  }
  return {
    category,
    gender: profile.genderPreference || '',
    color,
    occasion: occasionAliases[occasionMatch] || occasionMatch,
    style: lower.match(/\b(classy|minimal|street|formal|casual|ethnic|old money|party|comfortable|sporty|active|festive|resort)\b/)?.[1] || (celebrityStyle ? 'celebrity-inspired' : ''),
    budget: budget ? Number(budget) : null,
    fit: lower.match(/\b(oversized|slim|regular|relaxed|straight|wide-leg)\b/)?.[1] || '',
    material: lower.match(/\b(leather|cotton|linen|denim|satin|silk|wool|mesh|knit)\b/)?.[1] || '',
    brand: ''
  };
}

function aiStudioIntent(message = '', knowledge = []) {
  const lower = normalize(message);
  const filters = extractFilters(message);
  if (containsAbuse(message)) return 'abuse_guard';
  if (detectLanguagePreference(message)) return 'language_preference';
  if (isGreetingOnly(message) || isCasualGreetingPrefix(message)) return 'greeting';
  if (isSmallTalk(message)) return 'small_talk';
  if (isOutOfScope(message, filters)) return 'out_of_scope';
  if (/\b(tokens?|credits?|balance|refunds?|cost|price|pricing|charge|payment)\b/i.test(message)) return 'token_help';
  if (/\btry\s*on|try-on|generate|generation|video|profile photo|body photo|preview on me|on me\b/i.test(message)) return 'tryon_help';
  if (/\bwardrobe|closet|owned|mine\b/i.test(message)) return 'wardrobe_help';
  if (/\b(shop|search|buy|amazon|product|catalog|under|below)\b/i.test(message) || budgetPattern().test(message)) return 'fashion_search';
  if (mentionsLookmefy(message) || knowledge.length) return 'lookmefy_help';
  if (/\b(wear|style|recommend|look|party|office|wedding|beach|gym|dinner|date|travel|casual)\b/.test(lower)) return 'outfit_recommendation';
  return 'style_advice';
}

function docBoost(doc = '', message = '') {
  const lower = normalize(message);
  const boosts = [
    ['token-rules.md', /\b(tokens?|credits?|refunds?|cancel|payment|charge)\b/],
    ['tryon-rules.md', /\b(try\s*on|generate|preview|photo|body|image)\b/],
    ['lookmefy-features.md', /\b(lookmefy|feature|help|delete|privacy|profile|history)\b/],
    ['faq.md', /\b(faq|help|how|what|why)\b/],
    ['fashion-rules.md', /\b(style|outfit|fashion|wardrobe|wear|classy|casual|formal)\b/],
    ['wardrobe-rules.md', /\b(style|outfit|fashion|wardrobe|wear|classy|casual|formal)\b/],
    ['product-search-rules.md', /\b(find|buy|shop|product|search|price|under|below)\b/]
  ];
  return boosts.some(([name, pattern]) => name === doc && pattern.test(lower)) ? 8 : 0;
}

function chunkDocument(doc, raw = '') {
  const title = raw.match(/^#\s+(.+)$/m)?.[1] || doc.replace(/\.md$/, '').replace(/-/g, ' ');
  const sections = raw
    .split(/\n(?=##?\s+)/)
    .map((section) => section.trim())
    .filter(Boolean);
  const chunks = sections.length ? sections : raw.split(/\n{2,}/).map((section) => section.trim()).filter(Boolean);
  return chunks.map((content, index) => {
    const heading = content.match(/^#+\s+(.+)$/m)?.[1] || title;
    return {
      id: `${doc}:${index + 1}`,
      doc,
      title: heading,
      content: content.replace(/^#+\s+.+\n?/, '').trim().slice(0, 1200),
      tokens: tokenize(`${doc} ${title} ${heading} ${content}`)
    };
  });
}

async function loadAiStudioKnowledge() {
  if (knowledgeCache) return knowledgeCache;
  try {
    const files = (await readdir(knowledgeDir)).filter((file) => file.endsWith('.md')).sort();
    const chunks = [];
    for (const file of files) {
      const content = await readFile(path.join(knowledgeDir, file), 'utf8');
      chunks.push(...chunkDocument(file, content));
    }
    knowledgeCache = chunks;
  } catch (error) {
    console.warn('[ai-studio] knowledge load failed', error.message);
    knowledgeCache = [];
  }
  return knowledgeCache;
}

function scoreAiStudioKnowledge(doc = {}, message = '') {
  const text = `${doc.title || ''} ${doc.content || ''}`.toLowerCase();
  const terms = queryTerms(message, 24).filter((term) => term.length >= 3);
  const matchedTerms = terms.filter((term) => text.includes(term));
  let score = matchedTerms.length * 4;
  if (/\b(tokens?|credits?|balance|refunds?|cost|price|pricing|charge|payment)\b/i.test(message) && /tokens?|credits?|refunds?|cost|price|pricing|charge|payment/i.test(text)) score += 24;
  if (/\btry\s*on|try-on|generate|generation|video|profile photo|body photo\b/i.test(message) && /try-on|generation|profile|body photo|video/i.test(text)) score += 24;
  if (/\bwardrobe|closet|owned|mine|outfit\b/i.test(message) && /wardrobe|closet|outfit/i.test(text)) score += 24;
  if (/\bshop|search|buy|amazon|product|catalog|price|under|below\b/i.test(message) && /product search|amazon|catalog|budget|fashion products/i.test(text)) score += 24;
  if (mentionsLookmefy(message) && /lookmefy|ai studio/i.test(text)) score += 16;
  score += docBoost(doc.doc || doc.file || '', message);
  return { ...doc, matchedTerms, score };
}

async function retrieveAiStudioKnowledge(message = '', limit = 5) {
  const docs = await loadAiStudioKnowledge();
  return docs
    .map((doc) => scoreAiStudioKnowledge(doc, message))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map(({ tokens, ...doc }) => doc);
}

function knowledgeExcerpt(doc = {}) {
  return cleanText(doc.content, 420);
}

function aiStudioKnowledgeReply(message = '', knowledge = []) {
  const primary = knowledge[0];
  if (!primary) return '';
  const intent = aiStudioIntent(message, knowledge);
  const excerpt = knowledgeExcerpt(primary);
  if (!excerpt) return '';
  if (intent === 'token_help') return `Tokens are Lookmefy credits for generation actions. ${excerpt}`;
  if (intent === 'tryon_help') return `For try-on, Lookmefy needs a ready profile/body photo and enough credits. ${excerpt}`;
  if (intent === 'wardrobe_help') return `For wardrobe styling, Lookmefy should use items saved in your wardrobe first. ${excerpt}`;
  if (intent === 'lookmefy_help') return excerpt;
  return '';
}

function aiStudioFallbackReply(message = '', products = [], knowledge = []) {
  const intent = aiStudioIntent(message, knowledge);
  if (intent === 'greeting' || intent === 'small_talk') return naturalChatReply(message);
  const knowledgeReply = aiStudioKnowledgeReply(message, knowledge);
  if (knowledgeReply && (!products.length || intent !== 'fashion_search')) return knowledgeReply;
  const count = products.length;
  if (!count) return 'I could not find a strong catalog match for that yet. Try a clearer fashion search with product type, color, occasion, or budget.';
  const terms = aiStudioQueryTerms(message);
  const searchText = terms.length ? ` for ${terms.join(', ')}` : '';
  return `I found ${count} style ${count === 1 ? 'option' : 'options'}${searchText}. You can open a product, try it on, or refine the search with color, occasion, fit, or budget.`;
}

function aiStudioSuggestions(message = '', products = [], actions = []) {
  const actionPrompts = (actions || [])
    .map((action) => cleanText(action.prompt || action.label, 90))
    .filter(Boolean)
    .slice(0, 3);
  if (actionPrompts.length) return actionPrompts;
  const categories = [...new Set((products || []).map((product) => cleanText(product.category, 40)).filter(Boolean))];
  const colors = String(message || '').match(/\b(black|white|red|pink|blue|green|yellow|beige|brown|maroon|purple|lavender|grey|gray|cream)\b/gi) || [];
  return [
    categories[0] ? `More ${categories[0]}` : 'Show casual outfits',
    colors[0] ? `${colors[0]} alternatives` : 'Under INR 2000',
    'Try wardrobe match'
  ].slice(0, 3);
}

function sourceLabel(source = '') {
  const value = normalize(source);
  if (value.includes('amazon')) return 'Amazon result';
  if (value.includes('catalog')) return 'Lookmefy catalog';
  if (value.includes('wardrobe') || value.includes('closet')) return 'Wardrobe item';
  if (value.includes('hybrid')) return 'Mixed look';
  return 'Result';
}

function productSourceType(product = {}, fallback = '') {
  const sourceText = normalize([
    product.source,
    product.searchSource,
    product.sourceLabel,
    product.brand,
    product.sourceUrl,
    product.affiliateLink,
    fallback
  ].filter(Boolean).join(' '));
  if (sourceText.includes('wardrobe') || sourceText.includes('closet')) return 'wardrobe';
  if (sourceText.includes('amazon') || sourceText.includes('amzn.in')) return 'amazon';
  if (sourceText.includes('catalog') || sourceText.includes('mongo')) return 'lookmefy_catalog';
  if (sourceText.includes('hybrid')) return 'hybrid';
  return fallback || 'unknown';
}

function withSourceMetadata(item = {}, fallback = '') {
  const source = productSourceType(item, fallback);
  return {
    ...item,
    source,
    sourceLabel: sourceLabel(source)
  };
}

function uniqueById(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item?.id || item?._id || item?.sourceUrl || item?.affiliateLink || item?.name || JSON.stringify(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function annotateVisibleSources(plan = {}, productSearch = null) {
  const productFallback = productSourceType({ source: productSearch?.source || '' }, productSearch?.source || '');
  const annotateProducts = (products = [], fallback = productFallback) => products.map((product) => withSourceMetadata(product, fallback));
  const outfits = (plan.outfits || []).map((outfit) => ({
    ...outfit,
    source: outfit.source || 'wardrobe',
    sourceLabel: sourceLabel(outfit.source || 'wardrobe'),
    items: annotateProducts(outfit.items || [], 'wardrobe'),
    products: annotateProducts(outfit.products || [], productFallback)
  }));
  return {
    ...plan,
    outfits,
    products: annotateProducts(plan.products || [], productFallback)
  };
}

function rememberVisibleResults(conversation, plan = {}, message = '') {
  const outfitProducts = (plan.outfits || []).flatMap((outfit) => outfit.products || []);
  const wardrobeItems = (plan.outfits || []).flatMap((outfit) => outfit.items || []);
  const products = uniqueById([...(plan.products || []), ...outfitProducts]);
  const outfits = plan.outfits || [];
  if (outfits[0]) conversation.currentOutfit = { ...outfits[0], lastMessage: message };
  if (products.length || wardrobeItems.length || outfits.length) {
    conversation.lastVisible = {
      message,
      products,
      wardrobeItems,
      outfits,
      sources: [...new Set([
        ...products.map((item) => item.source || productSourceType(item)),
        ...wardrobeItems.map((item) => item.source || productSourceType(item, 'wardrobe')),
        ...outfits.map((item) => item.source || 'wardrobe')
      ].filter(Boolean))],
      updatedAt: new Date().toISOString()
    };
  }
}

function visibleSourceQuestion(message = '') {
  const lower = normalize(message);
  const hasReference = /\b(these|this|those|them|they|products?|items?|options?|cards?|results?)\b/.test(lower);
  const asksSource = /\b(from|of|in|belong|source|amazon|online|wardrobe|closet|mine|owned|lookmefy|catalog|website|site)\b/.test(lower);
  return hasReference && asksSource;
}

function visibleSourcePlan(message = '', conversation = {}) {
  if (!visibleSourceQuestion(message)) return null;
  const lower = normalize(message);
  const last = conversation.lastVisible || {};
  const products = last.products || [];
  const wardrobeItems = last.wardrobeItems || [];
  const outfits = last.outfits || [];
  const productSources = [...new Set(products.map((product) => productSourceType(product)).filter(Boolean))];
  const hasVisible = products.length || wardrobeItems.length || outfits.length;
  const asksWardrobe = /\b(wardrobe|closet|mine|owned|already\s+have|have\s+these|have\s+this)\b/.test(lower);
  const asksAmazon = /\b(amazon|online|shopping|shop)\b/.test(lower);
  const asksCatalog = /\b(lookmefy|catalog|website|site)\b/.test(lower);
  const hasWardrobe = wardrobeItems.length || outfits.some((outfit) => productSourceType(outfit, outfit.source || 'wardrobe') === 'wardrobe');
  const hasAmazon = productSources.includes('amazon');
  const hasCatalog = productSources.includes('lookmefy_catalog');

  let reply = '';
  if (!hasVisible) {
    reply = 'I do not have any visible product or wardrobe cards in this chat yet. Ask me to search products or check your wardrobe first.';
  } else if (asksWardrobe && products.some((product) => productSourceType(product) !== 'wardrobe')) {
    const sourceNames = productSources.map(sourceLabel).join(', ') || 'shopping results';
    reply = `No. Those visible product cards are ${sourceNames}, not items from your wardrobe. I can check your wardrobe separately for a similar look.`;
  } else if (asksWardrobe && hasWardrobe) {
    reply = 'Yes. The visible outfit cards are built from wardrobe items. Shopping cards, if shown inside the same look, are separate add-ons.';
  } else if (asksAmazon) {
    reply = hasAmazon
      ? 'Yes, those visible product cards are Amazon shopping results. They are not saved wardrobe items unless you add them yourself.'
      : 'No, the visible cards are not Amazon results. I can run a fresh online search for shopping options.';
  } else if (asksCatalog) {
    reply = hasCatalog
      ? 'Yes, those visible product cards came from the Lookmefy catalog. They are product results, not wardrobe items.'
      : 'No, those visible cards did not come from the Lookmefy catalog.';
  } else {
    const sourceNames = [...new Set([...(last.sources || []), ...productSources].map(sourceLabel))].join(', ') || 'visible results';
    reply = `The visible cards are ${sourceNames}. Wardrobe items and shopping results are separate.`;
  }

  return {
    intent: 'visible_source_question',
    mode: 'context_answer',
    filters: {},
    reply,
    outfits: [],
    products: [],
    actions: [
      { type: 'check_wardrobe', label: 'Check wardrobe', prompt: 'Check wardrobe for this' },
      { type: 'search_products', label: 'Search products', prompt: 'Search online for this' }
    ],
    brain: 'local',
    model: ''
  };
}

function replyForLanguage(conversation, variants = {}) {
  const language = conversation?.language || 'english';
  return variants[language] || variants.english || variants.hinglish || variants.hindi || '';
}

function naturalChatReply(message = '', conversation) {
  const lower = normalize(message).trim();
  const hasCurrentLook = Boolean(conversation?.currentOutfit?.items?.length);
  if (isGreetingOnly(message) || isCasualGreetingPrefix(message)) {
    return replyForLanguage(conversation, {
      english: hasCurrentLook ? 'Hey. Want to keep tuning this look, or should we start fresh?' : 'Hey. What are we dressing for today?',
      hinglish: hasCurrentLook ? 'Hey. Is look ko tune karein ya fresh start karein?' : 'Hey. Aaj kis occasion ke liye outfit chahiye?',
      hindi: hasCurrentLook ? 'Theek hai. Is look ko tune karein ya naya look banayein?' : 'Namaste. Aaj kis occasion ke liye outfit chahiye?'
    });
  }
  if (/\b(how are you|what'?s up)\b/.test(lower)) {
    return replyForLanguage(conversation, {
      english: 'I am good, ready to put a look together. What are we dressing for?',
      hinglish: 'Main ready hoon. Batao, kis occasion ke liye look banana hai?',
      hindi: 'Main taiyaar hoon. Bataiye, kis occasion ke liye look banana hai?'
    });
  }
  if (/\b(who are you|what can you do)\b/.test(lower)) {
    return replyForLanguage(conversation, {
      english: 'I can style your wardrobe, find missing pieces, explain Lookmefy, and help plan a try-on.',
      hinglish: 'Main wardrobe style kar sakta hoon, missing pieces dhoondh sakta hoon, Lookmefy explain kar sakta hoon, aur try-on plan kar sakta hoon.',
      hindi: 'Main wardrobe style kar sakta hoon, missing pieces dhoondh sakta hoon, Lookmefy explain kar sakta hoon, aur try-on plan kar sakta hoon.'
    });
  }
  return replyForLanguage(conversation, {
    english: hasCurrentLook ? 'Got it. We can adjust this look or start a new one.' : 'Tell me what you are dressing for and I will help.',
    hinglish: hasCurrentLook ? 'Got it. Is look ko adjust karein ya naya start karein?' : 'Batao kis occasion ke liye outfit chahiye, main help karta hoon.',
    hindi: hasCurrentLook ? 'Theek hai. Is look ko adjust karein ya naya look start karein?' : 'Bataiye kis occasion ke liye outfit chahiye, main help karta hoon.'
  });
}

function outOfScopeReply() {
  return 'I can only help with Lookmefy, fashion, wardrobe, shopping, products, tokens, profile, and AI try-on. Try "beach outfit", "kurta for wedding", "black shirt under 1000", or "how do Lookmefy tokens work?"';
}

function localLookmefyHelpReply(message = '', knowledge = []) {
  const knowledgeReply = aiStudioKnowledgeReply(message, knowledge);
  if (knowledgeReply) return knowledgeReply;
  const lower = normalize(message);
  if (/\b(tokens?|credits?|charge|cost|free)\b/.test(lower)) return 'Lookmefy uses tokens for AI generation actions like product try-ons, custom try-ons, and video try-ons. Browsing, product search, and opening shopping links do not consume tokens.';
  if (/\b(try\s*on|preview|generation|generate|video)\b/.test(lower)) return 'Lookmefy can create AI try-on previews from product cards or custom clothing uploads. I can plan the action here; generation runs through the app try-on flow.';
  if (/\b(wardrobe|closet|outfit|style)\b/.test(lower)) return 'Lookmefy can use your wardrobe as styling context, build outfit ideas, and suggest missing shopping pieces when your saved items do not fully match the occasion.';
  return 'Lookmefy is an AI fashion app for discovering products, styling your wardrobe, planning AI try-ons, managing wishlists, and using tokens for generation features.';
}

function languagePreferenceReply(conversation) {
  return replyForLanguage(conversation, {
    english: 'Done, I will reply in English. What are we styling today?',
    hinglish: 'Done, ab main Hinglish mein baat karunga. Batao, kis occasion ke liye look banana hai?',
    hindi: 'Theek hai, ab main Hindi mein baat karunga. Bataiye, kis occasion ke liye look banana hai?'
  });
}

function abuseGuardReply(conversation) {
  return replyForLanguage(conversation, {
    english: 'I am here to help, but keep it respectful. Tell me the occasion or item you want and I will style it.',
    hinglish: 'Main help karunga, bas tone respectful rakho. Occasion ya item batao, main look bana deta hoon.',
    hindi: 'Main help karunga, bas tone respectful rakhiye. Occasion ya item bataiye, main look bana deta hoon.'
  });
}

function categoryAliasMatch(itemCategory = '', targetCategory = '') {
  if (!targetCategory) return true;
  const normalized = normalize(itemCategory);
  return (categoryAliases[targetCategory] || [targetCategory]).some((alias) => normalize(alias) === normalized);
}

function categoryMatchesFilter(item = {}, filters = {}) {
  if (!filters.category) return true;
  return itemMatchesCategoryName(item, filters.category);
}

function categoryLabel(category = '') {
  const labels = {
    bottoms: 'bottom',
    dresses: 'dress',
    shoes: 'shoes',
    accessories: 'accessory',
    tops: 'top',
    outerwear: 'outerwear',
    ethnic: 'ethnic wear',
    innerwear: 'innerwear',
    swimwear: 'swimwear',
    costumes: 'costume'
  };
  return labels[category] || String(category || 'item').replace(/s$/, '');
}

function standaloneCategory(category = '') {
  return ['dresses', 'innerwear', 'swimwear', 'costumes'].includes(category);
}

function itemMatchesCategoryName(item = {}, category = '') {
  if (!category) return true;
  const itemCategory = normalize(item.category);
  const haystack = normalize([item.name, item.title, item.category, item.description, ...(item.tags || [])].join(' '));
  if (category === 'tops') return categoryAliasMatch(itemCategory, category) || /\b(shirt|t-?shirt|tee|top|blouse|hoodie|sweatshirt)\b/.test(haystack);
  if (category === 'bottoms') return categoryAliasMatch(itemCategory, category) || /\b(pants?|trousers?|jeans?|shorts?|skirts?|joggers?|leggings?)\b/.test(haystack);
  if (category === 'outerwear') return categoryAliasMatch(itemCategory, category) || /\b(jacket|blazer|coat|cardigan|shrug)\b/.test(haystack);
  if (category === 'accessories') return categoryAliasMatch(itemCategory, category) || /\b(watch|bag|belt|jewellery|jewelry|earring|necklace|sunglasses|eyewear|accessory)\b/.test(haystack);
  if (category === 'ethnic') return ['ethnic', 'ethnic wear'].includes(itemCategory) || /\b(ethnic|kurta|kurti|saree|sari|lehenga|salwar|anarkali|churidar|sharara|dupatta|traditional indian)\b/.test(haystack);
  if (category === 'dresses') return itemCategory === 'dresses' || /\b(dress|gown|frock)\b/.test(haystack);
  if (category === 'costumes') return categoryAliasMatch(itemCategory, category) || /\b(halloween|costume|cosplay|fancy dress)\b/.test(haystack);
  if (category === 'innerwear') return /\b(underwear|innerwear|lingerie|bra|bralette|panty|panties|brief|boxer|camisole|shapewear)\b/.test(haystack);
  if (category === 'swimwear') return itemCategory === 'swimwear' || /\b(bikini|swimsuit|swimwear|monokini|tankini)\b/.test(haystack);
  if (category === 'shoes') return categoryAliasMatch(itemCategory, category) || /\b(shoe|sneaker|loafer|heel|sandal|boot)\b/.test(haystack);
  return itemCategory === category;
}

function eventProfileForMessage(message = '', filters = {}) {
  const lower = normalize(message);
  const directKey = filters.occasion === 'date' ? 'dinner' : filters.occasion;
  if (eventProfiles[directKey]) return eventProfiles[directKey];
  return Object.values(eventProfiles).find((profile) => (
    [profile.key, profile.label, ...(profile.aliases || [])].some((term) => new RegExp(`\\b${escapeRegExp(term).replace(/\s+/g, '\\s+')}\\b`).test(lower))
  )) || null;
}

function itemScore(item = {}, filters = {}) {
  const haystack = normalize([item.name, item.title, item.category, item.color, item.fabric, item.formality, ...(item.tags || []), ...(item.occasions || [])].join(' '));
  let score = 0;
  if (filters.category && itemMatchesCategoryName(item, filters.category)) score += 18;
  if (filters.color && haystack.includes(filters.color)) score += 10;
  if (filters.occasion && haystack.includes(filters.occasion)) score += 12;
  if (filters.style && haystack.includes(filters.style)) score += 8;
  if (filters.material && haystack.includes(filters.material)) score += 8;
  if (!filters.category) score += 4;
  return score;
}

function bestItem(items = [], categories = [], filters = {}) {
  return items
    .filter((item) => categories.some((category) => itemMatchesCategoryName(item, category)))
    .map((item) => ({ item, score: itemScore(item, filters) }))
    .sort((a, b) => b.score - a.score)[0] || null;
}

function titleForCombo(items = [], filters = {}) {
  const occasion = filters.occasion || filters.style || 'today';
  if (!items.length) return `Look for ${occasion}`;
  return `${items[0].name} look`;
}

function reasonForCombo(items = [], missing = [], filters = {}, eventProfile = null, wardrobeFit = '') {
  const owned = items.map((item) => item.name).join(', ');
  const occasion = eventProfile?.label || filters.occasion || filters.style || 'your request';
  if (missing.length) return `Uses ${owned}. Missing ${missing.map(categoryLabel).join(', ')} for a complete ${occasion} look.`;
  if (wardrobeFit === 'partial') return `Uses ${owned}, but the event match is not strong enough to rely on wardrobe alone.`;
  if (wardrobeFit === 'weak') return `The wardrobe pieces do not strongly match ${occasion}, so shopping support is needed.`;
  return `Strong wardrobe-first match for ${occasion} using ${owned}.`;
}

function buildWardrobeCombos(items = [], filters = {}) {
  const templates = [
    ['tops', 'bottoms', 'shoes', 'outerwear'],
    ['dresses', 'shoes', 'outerwear', 'accessories'],
    ['tops', 'bottoms', 'shoes', 'accessories'],
    ['ethnic', 'bottoms', 'shoes', 'accessories']
  ];
  return templates.map((template) => {
    const selected = [];
    const missing = [];
    for (const category of template) {
      const categories = category === 'tops' ? ['tops', 'ethnic'] : [category];
      const match = bestItem(items, categories, filters);
      if (match?.item && !selected.some((item) => item.id === match.item.id)) selected.push(match.item);
      else if (!['outerwear', 'accessories'].includes(category)) missing.push(category);
    }
    if (filters.category && !selected.some((item) => itemMatchesCategoryName(item, filters.category))) missing.push(filters.category);
    const uniqueMissing = [...new Set(missing)];
    const score = selected.reduce((sum, item) => sum + itemScore(item, filters), 0) + selected.length * 8 - uniqueMissing.length * 18;
    return {
      id: selected.map((item) => item.id).join(':') || template.join(':'),
      title: titleForCombo(selected, filters),
      source: 'wardrobe',
      sourceLabel: sourceLabel('wardrobe'),
      items: selected.map((item) => withSourceMetadata(item, 'wardrobe')),
      products: [],
      missing: uniqueMissing,
      score,
      reason: reasonForCombo(selected, uniqueMissing, filters)
    };
  }).filter((combo) => combo.items.length).sort((a, b) => b.score - a.score);
}

function comboSignalScore(items = [], profile = null) {
  if (!profile) return { score: 0, signalItems: 0, signals: [] };
  const signals = [];
  let score = 0;
  let signalItems = 0;
  for (const item of items) {
    const haystack = normalize([item.name, item.category, item.color, item.formality, ...(item.tags || []), ...(item.occasions || [])].join(' '));
    const itemSignals = (profile.signals || []).filter((signal) => textHasTerm(haystack, signal));
    if (itemSignals.length) {
      signalItems += 1;
      signals.push(...itemSignals);
      score += Math.min(itemSignals.length, 3) * 8;
    }
  }
  return { score, signalItems, signals: [...new Set(signals)] };
}

function rankWardrobeCombos(combos = [], filters = {}, profile = null) {
  if (!profile) {
    return combos.map((combo) => ({
      ...combo,
      suitability: combo.score,
      wardrobeFit: combo.missing.length ? 'partial' : 'strong',
      eventMissing: combo.missing,
      eventKey: ''
    }));
  }

  return combos.map((combo) => {
    const items = combo.items || [];
    const missing = new Set(combo.missing || []);
    let coverageScore = 0;
    let coveredGroups = 0;
    for (const group of profile.requiredGroups || []) {
      const covered = group.some((category) => items.some((item) => itemMatchesCategoryName(item, category)));
      if (covered) {
        coveredGroups += 1;
        coverageScore += 18;
      } else {
        missing.add(group[0]);
      }
    }
    if (filters.category && !items.some((item) => categoryMatchesFilter(item, filters))) missing.add(filters.category);
    const signal = comboSignalScore(items, profile);
    const colorScore = filters.color && items.some((item) => normalize(item.color) === filters.color) ? 8 : 0;
    const missingPenalty = missing.size * 18;
    const weakSignalPenalty = signal.signalItems < (profile.minSignalItems || 0) ? 30 : 0;
    const suitability = Math.round(coverageScore + signal.score + colorScore + items.length * 3 - missingPenalty - weakSignalPenalty);
    const hasRequiredCoverage = coveredGroups >= (profile.requiredGroups || []).length;
    const hasRequiredSignals = signal.signalItems >= (profile.minSignalItems || 0);
    const wardrobeFit = hasRequiredCoverage && hasRequiredSignals && !missing.size && suitability >= 58
      ? 'strong'
      : suitability >= 34 && items.length >= 2 && hasRequiredCoverage && signal.signalItems > 0
        ? 'partial'
        : 'weak';
    const uniqueMissing = [...missing];
    return {
      ...combo,
      score: suitability,
      suitability,
      wardrobeFit,
      eventKey: profile.key,
      eventLabel: profile.label,
      eventSignals: signal.signals,
      eventMissing: uniqueMissing,
      missing: uniqueMissing,
      reason: reasonForCombo(items, uniqueMissing, filters, profile, wardrobeFit)
    };
  }).sort((a, b) => b.suitability - a.suitability);
}

function wardrobeCheckOutfit(items = [], filters = {}, query = '') {
  const label = filters.category ? categoryLabel(filters.category) : 'matching item';
  return {
    id: `wardrobe-check:${items.map((item) => item.id).join(':') || label}`,
    title: 'Found in your wardrobe',
    source: 'wardrobe',
    sourceLabel: sourceLabel('wardrobe'),
    score: items.reduce((sum, item) => sum + (item.score || 0), 0),
    suitability: items.reduce((sum, item) => sum + (item.score || 0), 0),
    wardrobeFit: 'item_match',
    missing: [],
    reason: `I found ${items.length} ${items.length === 1 ? label : `${label}s`} in your wardrobe for "${query}".`,
    items: items.map((item) => withSourceMetadata(item, 'wardrobe')),
    products: []
  };
}

function searchWardrobeItems(items = [], filters = {}, query = '', eventProfile = null) {
  const queryTokens = tokenize(query);
  const eventSignals = eventProfile?.signals || [];
  const hasSpecificFilter = Boolean(filters.category || filters.color || filters.occasion || filters.style || filters.material);
  return items
    .filter((item) => !filters.category || categoryMatchesFilter(item, filters))
    .filter((item) => !filters.color || normalize(item.color) === filters.color || normalize(item.name).includes(filters.color))
    .filter((item) => !filters.material || normalize([item.name, item.fabric, ...(item.tags || [])].join(' ')).includes(filters.material))
    .map((item) => {
      const haystack = normalize([item.name, item.category, item.color, item.formality, ...(item.tags || []), ...(item.occasions || [])].join(' '));
      const queryMatches = queryTokens.filter((token) => haystack.includes(token)).length;
      const eventMatches = eventSignals.filter((signal) => textHasTerm(haystack, signal)).length;
      return { ...item, score: itemScore(item, filters) + queryMatches * 6 + eventMatches * 6 };
    })
    .filter((item) => hasSpecificFilter ? item.score > 0 : item.score > 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

function specificProductLabel(message = '', filters = {}) {
  const lower = normalize(message);
  const category = filters.category || '';
  const rules = [
    ['kurta', /\b(kurtas?|kurtis?)\b/, ['ethnic']],
    ['saree', /\b(sarees?|saris?)\b/, ['ethnic']],
    ['lehenga', /\blehengas?\b/, ['ethnic']],
    ['salwar suit', /\b(salwars?|anarkali|churidar|sharara)\b/, ['ethnic']],
    ['shoes', /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/, ['shoes']],
    ['dress', /\b(dress(?:es)?|gowns?|frocks?)\b/, ['dresses']],
    ['shirt', /\b(shirts?|t-?shirts?|tops?|blouses?|hoodies?)\b/, ['tops']],
    ['bikini swimwear', /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?)\b/, ['swimwear']],
    ['bra innerwear', /\b(bras?|bralettes?|lingerie|underwear|innerwear)\b/, ['innerwear']],
    ['halloween costume', /\b(halloween|costumes?|cosplay|fancy\s*dress)\b/, ['costumes']]
  ];
  const match = rules.find(([, pattern, categories]) => pattern.test(lower) && (!category || categories.includes(category)));
  return match?.[0] || '';
}

function categorySearchLabel(category = '') {
  const labels = {
    tops: 'shirt top',
    bottoms: 'pants trousers',
    dresses: 'dress',
    shoes: 'shoes',
    accessories: 'accessories',
    outerwear: 'jacket blazer',
    ethnic: 'kurta ethnic wear',
    innerwear: 'innerwear lingerie bra underwear',
    swimwear: 'bikini swimwear swimsuit',
    costumes: 'halloween costume outfit'
  };
  return labels[category] || categoryLabel(category);
}

function productSearchTargets({ filters = {}, bestCombo = null, eventProfile = null }) {
  if (filters.category) return [filters.category];
  if (eventProfile?.searchCategories?.length) return eventProfile.searchCategories;
  return bestCombo?.missing || [];
}

function buildProductSearchQuery({ message = '', filters = {}, bestCombo = null, eventProfile = null }) {
  const targets = productSearchTargets({ filters, bestCombo, eventProfile });
  const genderTerm = filters.gender === 'male' ? 'men' : filters.gender === 'female' ? 'women' : filters.gender;
  const celebrityStyle = detectCelebrityStyleRequest(message);
  if (celebrityStyle && !filters.category && !eventProfile) {
    const lower = normalize(message);
    const vibe = lower.match(/\b(airport|casual|party|glam|ethnic|festive|red carpet|formal|classy)\b/g)?.join(' ') || 'fashion';
    return [genderTerm, vibe, 'outfit dress top trousers shoes'].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  const specificLabel = specificProductLabel(message, filters);
  const targetLabel = targets.slice(0, filters.category ? 2 : 0).map(categorySearchLabel).join(' ');
  const eventSearchTerms = !filters.category && eventProfile?.searchTerms?.length ? eventProfile.searchTerms.slice(0, 4).join(' ') : '';
  if (isListAllProductsPrompt(message)) return [genderTerm, 'fashion clothing products'].filter(Boolean).join(' ').trim();
  const parts = [
    genderTerm,
    filters.color,
    filters.material,
    filters.style,
    eventProfile?.label || filters.occasion,
    specificLabel,
    eventSearchTerms,
    targetLabel,
    filters.budget ? `under ${filters.budget}` : ''
  ].filter(Boolean);
  const query = parts.join(' ').replace(/\s+/g, ' ').trim();
  return query && query !== genderTerm ? query : message;
}

function readPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0];
  return numeric ? Number(numeric) : null;
}

function inferCategoryFromText(value = '') {
  const lower = normalize(value);
  if (/\b(dress|gown|frock)\b/.test(lower)) return 'dresses';
  if (/\b(kurta|kurti|saree|sari|lehenga|salwar|anarkali|churidar|sharara|dupatta|ethnic|traditional indian)\b/.test(lower)) return 'ethnic';
  if (/\b(shoe|sneaker|loafer|heel|sandal|boot)\b/.test(lower)) return 'shoes';
  if (/\b(pant|trouser|jean|short|skirt|jogger|legging)\b/.test(lower)) return 'bottoms';
  if (/\b(jacket|blazer|coat|cardigan)\b/.test(lower)) return 'outerwear';
  if (/\b(watch|bag|belt|jewellery|jewelry|earring|necklace|sunglasses|accessory)\b/.test(lower)) return 'accessories';
  if (/\b(shirt|t-?shirt|top|blouse|hoodie|tee)\b/.test(lower)) return 'tops';
  return '';
}

function inferColorFromText(value = '') {
  return normalize(value).match(/\b(black|white|cream|beige|blue|navy|green|red|pink|brown|grey|gray|gold|silver|maroon|purple|lavender|yellow|orange)\b/)?.[1] || '';
}

function normalizeBackendProduct(product = {}, index = 0, source = 'catalog-api') {
  const name = product.name || product.title || product.label || '';
  const textValue = [name, product.category, product.subcategory, product.description, product.brand, ...(product.tags || [])].join(' ');
  const category = product.category || inferCategoryFromText(textValue);
  const sourceUrl = product.sourceUrl || product.url || '';
  const affiliateLink = product.affiliateLink || '';
  const normalizedSource = product.source || source;
  return {
    ...product,
    id: String(product.id || product._id || sourceUrl || affiliateLink || `${source}-${index}`),
    external: Boolean(product.external || /amazon/i.test(normalizedSource) || affiliateLink || sourceUrl),
    name,
    title: name,
    category,
    color: product.color || product.colors?.[0] || inferColorFromText(textValue),
    price: readPrice(product.price ?? product.salePrice ?? product.currentPrice ?? product.mrp),
    brand: product.brand || product.badge || sourceLabel(normalizedSource),
    description: product.description || '',
    tags: [...new Set([...(product.tags || []), product.badge, normalizedSource].filter(Boolean).map(String))],
    imageUrl: product.imageUrl || product.remoteImageUrl || product.thumbnail || product.image?.url || product.image?.remoteUrl || product.image || '',
    sourceUrl,
    affiliateLink,
    source: normalizedSource,
    sourceLabel: product.sourceLabel || sourceLabel(normalizedSource),
    searchSource: product.searchSource || normalizedSource,
    searchLink: Boolean(product.searchLink),
    tryOnModel: product.tryOnModel || inferTryOnModel({ ...product, name, category })
  };
}

function productSearchText(product = {}) {
  return normalize([
    product.name,
    product.title,
    product.category,
    product.color,
    product.brand,
    product.description,
    ...(Array.isArray(product.colors) ? product.colors : []),
    ...(product.tags || [])
  ].filter(Boolean).join(' '));
}

function productHasRequestedTerm(product = {}, term = '') {
  if (!term) return true;
  return textHasTerm(productSearchText(product), term);
}

function productPriceWithinBudget(product = {}, filters = {}) {
  if (!filters.budget) return true;
  const price = readPrice(product.price);
  return price !== null && price <= filters.budget;
}

function productMatchesSpecificLabel(product = {}, specificLabel = '') {
  if (!specificLabel) return true;
  const textValue = productSearchText(product);
  const checks = {
    kurta: /\b(kurtas?|kurtis?)\b/,
    saree: /\b(sarees?|saris?)\b/,
    lehenga: /\blehengas?\b/,
    'salwar suit': /\b(salwars?|anarkali|churidar|sharara)\b/,
    shoes: /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/,
    dress: /\b(dress(?:es)?|gowns?|frocks?)\b/,
    shirt: /\b(shirts?|t-?shirts?|tops?|blouses?|hoodies?)\b/,
    'bikini swimwear': /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?)\b/,
    'bra innerwear': /\b(bras?|bralettes?|lingerie|underwear|innerwear)\b/,
    'halloween costume': /\b(halloween|costumes?|cosplay|fancy dress)\b/
  };
  return (checks[specificLabel] || new RegExp(`\\b${escapeRegExp(specificLabel)}\\b`)).test(textValue);
}

function productSatisfiesHardFilters(product = {}, filters = {}, { specificLabel = '' } = {}) {
  if (product.searchLink) return true;
  if (filters.category && !itemMatchesCategoryName(product, filters.category)) return false;
  if (specificLabel && !productMatchesSpecificLabel(product, specificLabel)) return false;
  if (filters.color && !productHasRequestedTerm(product, filters.color)) return false;
  if (filters.material && !productHasRequestedTerm(product, filters.material)) return false;
  if (filters.fit && !productHasRequestedTerm(product, filters.fit)) return false;
  if (!productPriceWithinBudget(product, filters)) return false;
  return true;
}

function scoreCatalogProduct(product = {}, filters = {}, query = '', eventProfile = null) {
  const textValue = productSearchText(product);
  const queryTokens = tokenize(query);
  let score = 0;
  if (filters.category && itemMatchesCategoryName(product, filters.category)) score += 40;
  if (filters.color && textHasTerm(textValue, filters.color)) score += 14;
  if (filters.material && textHasTerm(textValue, filters.material)) score += 12;
  if (filters.style && textHasTerm(textValue, filters.style)) score += 8;
  if (filters.occasion && textHasTerm(textValue, filters.occasion)) score += 10;
  if (filters.budget && Number(product.price) <= filters.budget) score += 12;
  score += queryTokens.filter((token) => textValue.includes(token)).length * 6;
  score += (eventProfile?.signals || []).filter((signal) => textHasTerm(textValue, signal)).length * 8;
  if (product.imageUrl) score += 4;
  if (product.price) score += 3;
  return score;
}

function rankCatalogProducts(products = [], { query = '', filters = {}, eventProfile = null, requireMatch = true, specificLabel = '' } = {}) {
  const hasFilters = Boolean(filters.category || filters.color || filters.material || filters.style || filters.occasion || filters.budget);
  const queryTokens = tokenize(query);
  return products
    .map((product, index) => ({ ...product, _index: index, score: scoreCatalogProduct(product, filters, query, eventProfile) }))
    .filter((product) => {
      if (!productSatisfiesHardFilters(product, filters, { specificLabel })) return false;
      if (!requireMatch || isListAllProductsPrompt(query)) return true;
      return product.score > 0 || (!hasFilters && queryTokens.length > 0);
    })
    .sort((a, b) => b.score - a.score || a._index - b._index)
    .map(({ _index, score, ...product }) => ({ ...product, rankScore: score }))
    .slice(0, productResultLimit);
}

function botAmazonRecord() {
  return {
    badge: 'Amazon',
    $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }]
  };
}

function catalogFilter(extra = {}) {
  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const filter = { ...extra };
  delete filter.$and;
  return { ...filter, isActive: true, $nor: [botAmazonRecord()], $and: [availableStatusClause(), ...extraAnd] };
}

function categoryQuery(category = '') {
  const aliases = categoryAliases[category] || [category];
  const terms = aliases.map((alias) => escapeRegExp(alias));
  return {
    $or: terms.flatMap((term) => [
      { category: new RegExp(`^${term}$`, 'i') },
      { name: new RegExp(`\\b${term}\\b`, 'i') },
      { tags: new RegExp(`\\b${term}\\b`, 'i') }
    ])
  };
}

function genderQuery(gender = '') {
  if (gender === 'male') return { gender: { $in: [/^men'?s?$/i, /^male$/i, /^unisex$/i, /^other$/i, /^$/] } };
  if (gender === 'female') return { gender: { $in: [/^women'?s?$/i, /^female$/i, /^unisex$/i, /^other$/i, /^$/] } };
  return null;
}

async function searchCatalogProducts({ query = '', filters = {}, eventProfile = null, listAll = false, specificLabel = '' } = {}) {
  const clauses = [];
  if (filters.category) clauses.push(categoryQuery(filters.category));
  if (filters.gender) {
    const genderClause = genderQuery(filters.gender);
    if (genderClause) clauses.push(genderClause);
  }
  const baseFilter = catalogFilter({
    ...(filters.budget ? { price: { $lte: filters.budget } } : {}),
    ...(clauses.length ? { $and: clauses } : {})
  });
  const projection = {
    name: 1,
    brand: 1,
    category: 1,
    gender: 1,
    price: 1,
    compareAtPrice: 1,
    currency: 1,
    rating: 1,
    ratingCount: 1,
    badge: 1,
    affiliateLink: 1,
    sourceUrl: 1,
    description: 1,
    tags: 1,
    colors: 1,
    tryOnModel: 1,
    image: 1,
    isFeatured: 1,
    isNewArrival: 1,
    createdAt: 1
  };
  const batches = [];
  if (query && !listAll) {
    try {
      const textMatches = await Product.find({ ...baseFilter, $text: { $search: query } }, { ...projection, score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
        .limit(80)
        .maxTimeMS(1800)
        .lean();
      batches.push(textMatches);
    } catch {
      // Local databases may not have text indexes synced.
    }
  }
  const broadMatches = await Product.find(baseFilter, projection)
    .sort({ isFeatured: -1, isNewArrival: -1, createdAt: -1 })
    .limit(listAll ? 120 : 200)
    .maxTimeMS(2200)
    .lean();
  batches.push(broadMatches);
  const products = uniqueById(batches.flat()
    .map((product, index) => normalizeBackendProduct(productToClient(product), index, 'lookmefy_catalog'))
    .filter((product) => product.name));
  return rankCatalogProducts(products, { query, filters, eventProfile, requireMatch: !listAll, specificLabel });
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(value = '') {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function cleanUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function amazonSearchBaseUrl() {
  const configured = cleanUrl(process.env.AMAZON_SEARCH_BASE_URL || process.env.AMAZON_BASE_URL || 'https://www.amazon.in');
  try {
    const url = new URL(configured);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return 'https://www.amazon.in';
  }
}

function withAmazonAssociateTag(value = '') {
  const tag = process.env.AMAZON_ASSOCIATE_TAG;
  if (!tag || !value) return value;
  try {
    const url = new URL(value);
    url.searchParams.set('tag', tag);
    return url.toString();
  } catch {
    return value;
  }
}

function amazonProductUrl(value = '', base = 'https://www.amazon.in') {
  if (!value) return '';
  try {
    let url = new URL(decodeHtml(value), base);
    const nested = url.searchParams.get('url') || url.searchParams.get('u');
    if (nested && /\/(?:dp|gp\/product)\//i.test(nested)) url = new URL(decodeURIComponent(nested), base);
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (!match) return '';
    return `${url.origin}/dp/${match[1].toUpperCase()}`;
  } catch {
    return '';
  }
}

function amazonPrice(region = '') {
  const text = stripTags(region);
  const match = text.match(/(?:Rs\.?|INR)\s*([0-9,]+(?:\.\d+)?)/i) || text.match(/([0-9,]+(?:\.\d+)?)\s*(?:Rs\.?|INR)/i);
  return readPrice(match?.[1]);
}

function amazonCurrency(baseUrl = '') {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.endsWith('.in')) return 'INR';
    if (host.endsWith('.co.uk')) return 'GBP';
    if (host.endsWith('.ca')) return 'CAD';
    if (host.endsWith('.com.au')) return 'AUD';
  } catch {
    // Best effort.
  }
  return 'INR';
}

function highResolutionAmazonImageUrl(value = '') {
  const url = cleanUrl(value);
  if (!url) return '';
  return url.replace(/\._AC_[A-Z0-9_,]+_\./i, '.').replace(/\._[A-Z0-9_,]+_\./i, '.');
}

function extractAmazonSearchResults(html = '', baseUrl = '') {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/\shref=["']([^"']+)["']/gi)) {
    const sourceUrl = amazonProductUrl(match[1], baseUrl);
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
    const region = html.slice(Math.max(0, match.index - 4500), Math.min(html.length, match.index + 6500));
    const image =
      region.match(/<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
      region.match(/<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*s-image[^"']*["']/i)?.[1] ||
      '';
    const name =
      region.match(/<img[^>]+class=["'][^"']*s-image[^"']*["'][^>]+alt=["']([^"']+)["']/i)?.[1] ||
      region.match(/<h2[^>]*>[\s\S]{0,800}?<span[^>]*>([\s\S]{8,500}?)<\/span>/i)?.[1] ||
      region.match(/aria-label=["']([^"']{8,220})["']/i)?.[1] ||
      '';
    const title = stripTags(name);
    if (!title || /sponsored|results|amazon/i.test(title) && title.length < 16) continue;
    const imageUrl = image ? highResolutionAmazonImageUrl(new URL(decodeHtml(image), baseUrl).toString()) : '';
    results.push({
      id: `external:${Buffer.from(sourceUrl).toString('base64url')}`,
      external: true,
      sourceUrl,
      affiliateLink: withAmazonAssociateTag(sourceUrl),
      name: cleanText(title, 180),
      title: cleanText(title, 180),
      brand: 'Amazon',
      category: inferCategoryFromText(title),
      color: inferColorFromText(title),
      price: amazonPrice(region),
      currency: amazonCurrency(baseUrl),
      badge: 'Amazon',
      tags: ['amazon', 'online-search'],
      imageUrl,
      source: 'amazon',
      sourceLabel: sourceLabel('amazon'),
      searchSource: 'amazon-search-page'
    });
  }
  return results;
}

function amazonSearchLinkProduct(query = '', filters = {}, reason = '') {
  const cleanQuery = cleanText(query || 'fashion products', 180);
  const url = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(cleanQuery)}`;
  return {
    id: `amazon-search:${Buffer.from(url).toString('base64url')}`,
    external: true,
    name: `Amazon search: ${cleanQuery}`,
    title: `Amazon search: ${cleanQuery}`,
    category: filters.category || 'fashion search',
    color: filters.color || '',
    price: null,
    brand: 'Amazon',
    tags: ['Amazon', 'search-link'],
    imageUrl: '',
    sourceUrl: url,
    affiliateLink: url,
    source: 'amazon',
    sourceLabel: sourceLabel('amazon'),
    searchSource: 'amazon-search-link',
    searchLink: true,
    searchFallbackReason: reason
  };
}

async function searchAmazonProducts({ query = '', filters = {}, limit = amazonResultLimit } = {}) {
  const searchQuery = genderedSearchQuery(query, filters.gender || '');
  const searchUrl = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(searchQuery || query || 'fashion products')}`;
  if (!envFlag('AI_STUDIO_DIRECT_AMAZON_ENABLED', true)) {
    return { products: [amazonSearchLinkProduct(searchQuery || query, filters, 'Direct Amazon search is disabled.')], source: 'amazon-search-link', error: '' };
  }
  try {
    const { response, text, finalUrl } = await safeFetchText(searchUrl, {
      maxBytes: 5 * 1024 * 1024,
      timeoutMs: amazonTimeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error('Amazon search did not respond');
    const genderPreference = genderPreferenceForQuery(searchQuery, filters.gender || '');
    const specificLabel = specificProductLabel(query, filters);
    const products = extractAmazonSearchResults(text, finalUrl || searchUrl)
      .map((product, index) => normalizeBackendProduct(product, index, 'amazon'))
      .filter((product) => product.name)
      .filter((product) => productSatisfiesHardFilters(product, filters, { specificLabel }))
      .filter((product) => wearableCompatibility(product, { query }).compatible)
      .filter((product) => genderCompatibility(product, genderPreference).compatible)
      .slice(0, limit);
    if (products.length) return { products, source: 'amazon', error: '' };
    throw new Error('Amazon did not expose compatible product cards for this search.');
  } catch (error) {
    const reason = cleanText(error.message || 'Amazon search failed.', 220);
    return { products: [amazonSearchLinkProduct(searchQuery || query, filters, reason)], source: 'amazon-search-link', error: reason };
  }
}

async function searchProductsForPlan({ message, filters, bestCombo, eventProfile, sourcePreference = 'auto' }) {
  const targets = productSearchTargets({ filters, bestCombo, eventProfile });
  const query = buildProductSearchQuery({ message, filters, bestCombo, eventProfile });
  const listAll = isListAllProductsPrompt(message);
  const specificLabel = specificProductLabel(message, filters);
  const searchFilters = !listAll && !filters.category && !eventProfile && targets[0]
    ? { ...filters, category: targets[0] }
    : filters;

  if (sourcePreference === 'online') {
    const online = await searchAmazonProducts({ query, filters: searchFilters });
    return { query, targets, ...online };
  }

  const catalog = await searchCatalogProducts({ query, filters: searchFilters, eventProfile, listAll, specificLabel });
  if (sourcePreference === 'catalog' || catalog.length) {
    return {
      query,
      targets,
      products: catalog,
      source: catalog.length ? 'lookmefy_catalog' : 'catalog-empty',
      error: catalog.length ? '' : 'Lookmefy catalog did not return matching products.'
    };
  }

  const online = await searchAmazonProducts({ query, filters: searchFilters });
  return { query, targets, ...online };
}

function closetImageUrl(image = {}) {
  if (image?.url) return image.url;
  if (image?.path) return `/${image.path}`;
  return '';
}

function closetItemToClient(item = {}) {
  const visual = item.visualProfile || {};
  return withSourceMetadata({
    id: String(item._id || item.id || ''),
    name: item.name || 'Wardrobe item',
    title: item.name || 'Wardrobe item',
    category: item.category || 'other',
    color: item.color || visual.primaryColor || '',
    fabric: item.fabric || visual.fabricGuess || '',
    pattern: item.pattern || visual.pattern || '',
    season: item.season || 'all-season',
    formality: item.formality || visual.formality || 'any',
    occasions: item.occasions || visual.occasions || [],
    tags: [...new Set([...(item.tags || []), ...(visual.styleTags || [])].filter(Boolean))],
    favorite: Boolean(item.favorite),
    imageUrl: closetImageUrl(item.image),
    visualProfile: visual || null,
    source: 'wardrobe'
  }, 'wardrobe');
}

function closetOutfitToClient(outfit = {}, itemById = new Map()) {
  const itemIds = (outfit.itemIds || []).map((id) => String(id));
  return {
    id: String(outfit._id || outfit.id || ''),
    title: outfit.title || 'Saved outfit',
    source: 'wardrobe',
    sourceLabel: sourceLabel('wardrobe'),
    occasion: outfit.occasion || '',
    reason: outfit.notes || outfit.occasion || 'Saved wardrobe outfit.',
    itemIds,
    items: itemIds.map((id) => itemById.get(id)).filter(Boolean),
    products: [],
    imageUrl: closetImageUrl(outfit.image),
    transparentImageUrl: closetImageUrl(outfit.transparentImage) || outfit.imageProcessing?.transparentImageUrl || '',
    createdAt: outfit.createdAt
  };
}

function userProfile(user = {}) {
  const client = typeof user.toClient === 'function' ? user.toClient() : user;
  return {
    id: String(user._id || client.id || ''),
    name: client.name || user.name || 'User',
    genderPreference: client.genderPreference || user.genderPreference || 'other',
    stylePreferences: client.stylePreferences || [],
    sizes: client.sizes || {},
    tokens: Number(client.tokens ?? user.tokens ?? 0),
    bodyPhotoUrl: client.bodyPhotoUrl || '',
    bodyPhotoOriginalUrl: client.bodyPhotoOriginalUrl || '',
    bodyPhotoStatus: client.bodyPhotoStatus || user.bodyPhoto?.status || 'uploaded'
  };
}

async function loadContext(user) {
  const profile = userProfile(user);
  const [items, outfits, recentEvents] = await Promise.all([
    ClosetItem.find({ user: user._id }).sort({ favorite: -1, updatedAt: -1 }).limit(80).lean(),
    ClosetOutfit.find({ user: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
    UserEvent.find({ user: user._id }).sort({ createdAt: -1 }).limit(12).lean()
  ]);
  const wardrobe = items.map(closetItemToClient).filter((item) => item.id);
  const itemById = new Map(wardrobe.map((item) => [String(item.id), item]));
  return {
    source: 'backend',
    profile,
    wardrobe,
    outfits: outfits.map((outfit) => closetOutfitToClient(outfit, itemById)).filter((outfit) => outfit.id),
    recentActivity: recentEvents.map((event) => ({
      type: event.type,
      query: event.query || '',
      path: event.path || '',
      source: event.source || '',
      createdAt: event.createdAt
    }))
  };
}

function pruneConversations() {
  const now = Date.now();
  for (const [key, conversation] of conversations) {
    if (now - Number(conversation.updatedAt || 0) > conversationTtlMs) conversations.delete(key);
  }
  if (conversations.size <= 1000) return;
  const sorted = [...conversations.entries()].sort((a, b) => Number(a[1].updatedAt || 0) - Number(b[1].updatedAt || 0));
  sorted.slice(0, conversations.size - 1000).forEach(([key]) => conversations.delete(key));
}

function nextConversation({ userId, conversationId = '', history = [] } = {}) {
  pruneConversations();
  const id = cleanText(conversationId, 80) || `studio-${randomUUID()}`;
  const key = `${userId || 'guest'}:${id}`;
  if (!conversations.has(key)) {
    conversations.set(key, {
      id,
      key,
      turns: Array.isArray(history) ? history.slice(-8).map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        text: cleanText(turn.text || turn.content || '', 600)
      })).filter((turn) => turn.text) : [],
      currentOutfit: null,
      lastVisible: null,
      pendingProductChoice: null,
      language: '',
      updatedAt: Date.now()
    });
  }
  const conversation = conversations.get(key);
  conversation.updatedAt = Date.now();
  return conversation;
}

function detectProductChoice(message = '', conversation = {}) {
  if (!conversation?.pendingProductChoice?.message) return '';
  const lower = normalize(message);
  if (/\b(both|all options|both options|give me both|show me both)\b/.test(lower)
    || (/\bwardrobe|closet\b/.test(lower) && /\bonline|amazon|shop|search|catalog\b/.test(lower))) return 'both';
  if (/\bcatalog\b|\blookmefy\s+(?:catalog|products?|shop|store)\b|\b(search|find|shop|buy)\b.*\blookmefy\b/.test(lower)) return 'catalog';
  if (/\b(check|wardrobe|closet|owned|mine|already have|have it)\b/.test(lower)) return 'wardrobe';
  if (/\b(search|online|shop|buy|amazon|web|internet)\b/.test(lower)) return 'online';
  return '';
}

function detectExplicitProductPath(message = '') {
  const lower = normalize(message);
  if (/\b(check|look)\b.*\b(wardrobe|closet)\b|\b(wardrobe|closet)\b.*\b(check|find|search)\b/.test(lower)) return 'wardrobe';
  if (/\b(search|find|shop|buy)\b.*\b(lookmefy|catalog|website|site)\b|\b(lookmefy\s+catalog|catalog)\b/.test(lower)) return 'catalog';
  if (/\b(search|find|shop|buy)\b.*\b(online|amazon|web|internet)\b|\bonline\b|\bamazon\b/.test(lower)) return 'online';
  return '';
}

function isGenericOnlineSearchPrompt(message = '') {
  return /^(?:search\s*(?:online|amazon)?|try\s*amazon\s*again|run\s*product\s*search|refresh\s*shopping\s*options)$/i.test(cleanText(message));
}

function isBudgetOnlyPrompt(message = '') {
  const value = cleanText(message);
  if (!budgetPattern().test(value)) return false;
  return !value.replace(budgetPattern(), '').replace(/[,\s-]/g, '').trim();
}

function lastSearchableMessage(conversation = {}) {
  if (conversation.currentOutfit?.lastMessage && !isGenericOnlineSearchPrompt(conversation.currentOutfit.lastMessage)) return conversation.currentOutfit.lastMessage;
  return [...(conversation.turns || [])].reverse().find((turn) => turn.role === 'user' && !isGenericOnlineSearchPrompt(turn.text))?.text || '';
}

function defaultOnlineSearchMessage(context = {}) {
  const genderWord = context.profile?.genderPreference === 'male' ? 'men' : context.profile?.genderPreference === 'female' ? 'women' : '';
  return `${genderWord} office fashion outfit`.replace(/\s+/g, ' ').trim();
}

function wordCount(message = '') {
  return normalize(message).match(/[a-z0-9]+/g)?.length || 0;
}

function isBareProductSearchPrompt(message = '', filters = {}) {
  const lower = normalize(message).trim();
  const words = wordCount(lower);
  if (!words || words > 4) return false;
  if (isGreetingOnly(lower) || isSmallTalk(lower) || detectLanguagePreference(lower)) return false;
  if (/\b(outfit|look|wear|style me|what should i wear|pair with|goes with)\b/.test(lower)) return false;
  if (isListAllProductsPrompt(lower)) return true;
  return Boolean(filters.category || filters.budget);
}

function isDirectProductSearchRequest(message = '', filters = {}, intent = '') {
  const lower = normalize(message);
  const hasProductSignal = Boolean(filters.category || filters.budget || filters.color || filters.material || filters.brand);
  if (!hasProductSignal) return false;
  if (/\b(what should i wear|outfit|look|style me|style this|pair with|goes with|wear for)\b/.test(lower)) return false;
  if (/\b(search|find|shop|buy|amazon|product|price|under|below)\b/.test(lower) || budgetPattern().test(lower)) return true;
  if (/\b(give|show|suggest|recommend|get|want|need|looking for)\b/.test(lower) && filters.category) return true;
  return intent === 'product_search' && Boolean(filters.category);
}

function isOutfitChoiceRequest(message = '', filters = {}, intent = '') {
  if (!['outfit_recommendation', 'style_advice'].includes(intent)) return false;
  const lower = normalize(message);
  if (/\b(change|swap|replace|another|more classy|more casual|different|make it|try\s*on|generate)\b/.test(lower)) return false;
  return Boolean(filters.occasion)
    || /\b(what should i wear|outfit|look|style me|wear for|dress for|office today|party today|wedding|date night|brunch|college|travel)\b/.test(lower);
}

function isOutfitRevisionRequest(message = '') {
  const lower = normalize(message);
  const revisionVerb = /\b(change|swap|replace|another|other|different|remove|avoid|without|more classy|more casual|bolder|cleaner|make it|make this|with black|black leather)\b/.test(lower);
  const rejection = /\b(don'?t want|do not want|not want|don'?t like|do not like|not wearing|not wear|won'?t wear|no more|no)\b/.test(lower);
  const fashionTarget = /\b(outfit|look|dress|shirt|top|pants|trouser|jeans|shoe|sneaker|loafer|heel|sandal|jacket|blazer|coat|watch|bag|belt|accessory|colour|color|vibe|piece)\b/.test(lower);
  return revisionVerb || (rejection && fashionTarget);
}

function outfitHasWardrobeCategory(outfit = {}, filters = {}) {
  if (!filters.category) return true;
  return (outfit.items || []).some((item) => categoryMatchesFilter(item, filters));
}

function outfitMatchesRequestedCategory(outfit = {}, filters = {}) {
  if (!filters.category) return true;
  return (outfit.items || []).some((item) => categoryMatchesFilter(item, filters))
    || (outfit.products || []).some((item) => categoryMatchesFilter(item, filters));
}

function sourceChoiceActions(message = '') {
  const topic = cleanText(message || 'this look', 140) || 'this look';
  return [
    { type: 'check_wardrobe', label: 'Check wardrobe', prompt: `Check wardrobe for ${topic}` },
    { type: 'search_catalog', label: 'Search Lookmefy catalog', prompt: `Search Lookmefy catalog for ${topic}` },
    { type: 'search_online', label: 'Search online', prompt: `Search online for ${topic}` }
  ];
}

function itemText(item = {}) {
  return normalize([item.name, item.category, item.color, item.brand, ...(item.tags || []), ...(item.occasions || [])].join(' '));
}

function messageMentionsItem(message = '', item = {}) {
  const lower = normalize(message);
  const itemName = normalize(item.name);
  const itemTokens = tokenize(itemName);
  const nameOverlap = itemTokens.filter((token) => lower.includes(token)).length;
  const categoryMentioned = item.category && itemMatchesCategoryName({ name: message, category: '', tags: [] }, item.category);
  const colorMentioned = item.color && new RegExp(`\\b${escapeRegExp(normalize(item.color))}\\b`).test(lower);
  if (itemName && lower.includes(itemName)) return true;
  if (nameOverlap >= Math.min(2, itemTokens.length)) return true;
  return Boolean(categoryMentioned && (!item.color || colorMentioned || /\b(it|this|that|one|piece)\b/.test(lower)));
}

function findRejectedItems(message = '', currentItems = []) {
  const lower = normalize(message);
  const hasRejection = /\b(don'?t want|do not want|not want|don'?t like|do not like|not wearing|not wear|won'?t wear|remove|avoid|without|no)\b/.test(lower);
  if (!hasRejection) return [];
  return currentItems.filter((item) => messageMentionsItem(message, item));
}

function replacementMatchesRejected(replacement = {}, rejectedItems = [], filters = {}) {
  const replacementText = itemText(replacement);
  return rejectedItems.some((item) => {
    if (replacement.id && item.id && String(replacement.id) === String(item.id)) return true;
    const sameCategory = item.category && categoryMatchesFilter(replacement, { category: item.category });
    const sameColor = item.color && normalize(replacement.color) === normalize(item.color);
    const rejectedNameTokens = tokenize(item.name).filter((token) => token.length > 3);
    const sameSpecificName = rejectedNameTokens.length && rejectedNameTokens.every((token) => replacementText.includes(token));
    return sameSpecificName || (sameCategory && sameColor && filters.color === normalize(item.color));
  });
}

function revisionReply(rejectedItems = [], replacement = null, replaceCategory = '') {
  const rejectedName = rejectedItems[0]?.name || categoryLabel(replaceCategory || 'item');
  if (replacement) return `Done, I swapped ${rejectedName} for ${replacement.name}.`;
  const unavailableLabel = replaceCategory === 'shoes' ? 'another pair of shoes' : `another ${categoryLabel(replaceCategory || rejectedItems[0]?.category || 'item')}`;
  return `I do not see ${unavailableLabel} in your wardrobe. Want me to search online?`;
}

function reviseOutfit(conversation = {}, context = {}, filters = {}, message = '') {
  const current = conversation.currentOutfit;
  const currentItems = current?.items || [];
  const rejectedItems = findRejectedItems(message, currentItems);
  let replaceCategory = filters.category || '';
  if (!replaceCategory && rejectedItems[0]?.category) replaceCategory = rejectedItems[0].category;
  if (!replaceCategory && /shoe|sneaker|loafer|heel|sandal/i.test(message)) replaceCategory = 'shoes';
  if (!replaceCategory && currentItems.length) replaceCategory = currentItems[currentItems.length - 1].category;
  const targetedItems = rejectedItems.length
    ? rejectedItems
    : currentItems.filter((item) => replaceCategory && categoryMatchesFilter(item, { category: replaceCategory })).slice(0, 1);
  const replacementFilters = { ...filters, color: '' };
  const wardrobeCandidates = (context.wardrobe || []).filter((item) => !currentItems.some((used) => used.id === item.id));
  const wardrobeReplacement = bestItem(wardrobeCandidates, [replaceCategory], replacementFilters)?.item;
  const replacement = [wardrobeReplacement].filter(Boolean).find((item) => !replacementMatchesRejected(item, targetedItems, filters));
  const itemShouldBeReplaced = (item) => {
    if (targetedItems.some((rejected) => String(rejected.id || rejected.name) === String(item.id || item.name))) return true;
    return replaceCategory && item.category === replaceCategory;
  };
  if (!replacement) {
    return {
      ...current,
      id: `${current?.id || 'outfit'}:no-wardrobe-alternative:${replaceCategory || 'item'}`,
      title: 'No wardrobe alternative found',
      items: [],
      products: [],
      missing: [...new Set([replaceCategory].filter(Boolean))],
      reason: revisionReply(targetedItems, null, replaceCategory),
      revisionSummary: revisionReply(targetedItems, null, replaceCategory),
      noWardrobeAlternative: true,
      replaceCategory
    };
  }
  const nextItems = currentItems.map((item) => itemShouldBeReplaced(item) ? replacement : item);
  return {
    ...current,
    id: `${current?.id || 'outfit'}:swap:${replaceCategory}:${replacement.id || replacement.name}`,
    title: `${current?.title || 'Recommended outfit'} with ${replacement.name}`,
    source: current?.source || 'wardrobe',
    sourceLabel: sourceLabel(current?.source || 'wardrobe'),
    items: nextItems,
    products: [],
    missing: (current?.missing || []).filter((category) => category !== replaceCategory),
    reason: revisionReply(targetedItems, replacement, replaceCategory),
    revisionSummary: revisionReply(targetedItems, replacement, replaceCategory)
  };
}

function tryOnActionFor(context = {}, outfit = null, product = null) {
  const profile = context.profile || {};
  const status = profile.bodyPhotoStatus || 'uploaded';
  const hasPhoto = Boolean(profile.bodyPhotoUrl || profile.bodyPhotoOriginalUrl);
  const hasTokens = Number(profile.tokens || 0) > 0;
  const disabledReason = !hasPhoto
    ? 'Upload a profile photo before starting an AI try-on.'
    : status === 'generating'
      ? 'Your full-body try-on profile is still preparing.'
      : status === 'failed'
        ? 'Upload a clearer profile photo before trying on products.'
        : !hasTokens
          ? 'You need at least 1 credit to generate a try-on.'
          : '';
  return {
    type: 'plan_try_on',
    label: product ? 'Try this on me' : 'Try this look on me',
    prompt: product ? `Try on ${product.name}` : 'Try this look on me',
    disabled: Boolean(disabledReason),
    disabledReason,
    payload: {
      outfitId: outfit?.id || '',
      productId: product?.id || ''
    }
  };
}

function localPlan({ message, conversation, context, intent, filters, wardrobeCombos, bestCombo, eventProfile }) {
  let mode = 'style_advice';
  let reply = '';
  let outfits = [];
  let products = [];
  let actions = [];
  let wardrobeWeak = false;
  let pendingProductChoice = null;
  const lower = normalize(message);
  const celebrityStyle = detectCelebrityStyleRequest(message);
  const wantsOutfitPlan = ['outfit_recommendation', 'style_advice'].includes(intent)
    && (Boolean(filters.category || filters.occasion || filters.style)
      || /\b(wear|outfit|style|recommend|look|dress|event|occasion|party|office|wedding|beach|vacation|resort|gym|workout|dinner|date|travel)\b/.test(lower));
  const explicitStandaloneMissing = Boolean(filters.category && standaloneCategory(filters.category) && bestCombo && !outfitHasWardrobeCategory(bestCombo, filters));
  const localSearchQuery = buildProductSearchQuery({ message, filters, bestCombo, eventProfile });
  const targetCategories = productSearchTargets({ filters, bestCombo, eventProfile });
  const vagueCelebrityStyle = Boolean(celebrityStyle
    && !filters.category
    && !filters.occasion
    && !filters.color
    && !filters.budget
    && !/\b(find|buy|shop|search|amazon|online|product|price|under|below|wardrobe|closet)\b/.test(lower));

  if (intent === 'abuse_guard') {
    mode = 'safety_guard';
    reply = abuseGuardReply(conversation);
  } else if (intent === 'language_preference') {
    mode = 'chat_control';
    reply = languagePreferenceReply(conversation);
  } else if (intent === 'greeting' || intent === 'small_talk') {
    mode = 'chat_control';
    reply = naturalChatReply(message, conversation);
  } else if (intent === 'out_of_scope') {
    mode = 'chat_control';
    reply = outOfScopeReply();
  } else if (intent === 'lookmefy_help' || intent === 'token_help' || intent === 'tryon_help') {
    mode = 'rag_help';
    reply = localLookmefyHelpReply(message);
  } else if (vagueCelebrityStyle) {
    mode = 'source_choice';
    pendingProductChoice = { kind: 'outfit', message: `${celebrityStyle.name} inspired outfit`, filters, createdAt: Date.now() };
    reply = `I can build a ${celebrityStyle.name}-inspired look, but I will keep it as a general style direction instead of pretending I know the exact outfit. Pick a vibe and I will make it specific.`;
    actions = [
      { type: 'style_option', label: 'Airport casual', prompt: `${celebrityStyle.name} inspired airport casual outfit` },
      { type: 'style_option', label: 'Party glam', prompt: `${celebrityStyle.name} inspired party glam outfit` },
      { type: 'style_option', label: 'Ethnic festive', prompt: `${celebrityStyle.name} inspired ethnic festive outfit` },
      { type: 'search_online', label: 'Shop similar', prompt: `Search online for ${celebrityStyle.name} inspired outfit` }
    ];
  } else if (intent === 'outfit_source_choice') {
    mode = 'source_choice';
    pendingProductChoice = { kind: 'outfit', message, filters, createdAt: Date.now() };
    reply = 'Do you want me to check your wardrobe, search the Lookmefy catalog, or search online?';
    actions = sourceChoiceActions(message);
  } else if (intent === 'product_search') {
    mode = 'product_choice';
    pendingProductChoice = { kind: 'product', message, filters, createdAt: Date.now() };
    reply = 'Do you want me to check your wardrobe, search the Lookmefy catalog, or search online?';
    actions = sourceChoiceActions(message);
  } else if (intent === 'both_outfit_sources') {
    mode = bestCombo ? 'hybrid_wardrobe_shopping' : 'product_search';
    wardrobeWeak = true;
    outfits = bestCombo ? [{
      ...bestCombo,
      source: 'hybrid',
      sourceLabel: sourceLabel('hybrid'),
      reason: `${bestCombo.reason} I will also show shopping options for comparison.`
    }] : [];
    reply = bestCombo ? 'Here is both: a wardrobe look first, plus shopping options to compare.' : 'I could not build a wardrobe look, so I will search shopping options for this.';
    actions = [{ type: 'search_online', label: 'Refresh shopping options', prompt: `Search online for ${message}` }];
  } else if (intent === 'both_product_sources') {
    mode = 'hybrid_wardrobe_shopping';
    wardrobeWeak = true;
    const matches = searchWardrobeItems(context.wardrobe, filters, message, eventProfile);
    outfits = matches.length ? [wardrobeCheckOutfit(matches, filters, message)] : [];
    reply = matches.length ? 'Here is both: matching wardrobe items and shopping options.' : 'I did not find a wardrobe match, so I will search shopping options for this.';
    actions = [{ type: 'search_online', label: 'Refresh shopping options', prompt: `Search online for ${message}` }];
  } else if (intent === 'wardrobe_outfit_check') {
    mode = bestCombo ? 'wardrobe_first' : 'wardrobe_check';
    pendingProductChoice = { kind: 'outfit', message, filters, createdAt: Date.now() };
    if (bestCombo) {
      outfits = [bestCombo];
      reply = bestCombo.wardrobeFit === 'strong'
        ? 'I checked your wardrobe and found a strong look for this.'
        : 'I checked your wardrobe and found a possible base, but it may need one better piece.';
      actions = [{ type: 'search_online', label: 'Search online too', prompt: `Search online for ${message}` }];
    } else {
      reply = 'I checked your wardrobe and could not find a strong look for this. Want me to search online?';
      actions = [{ type: 'search_online', label: 'Search online', prompt: `Search online for ${message}` }];
    }
  } else if (intent === 'wardrobe_product_check') {
    mode = 'wardrobe_check';
    pendingProductChoice = { kind: 'product', message, filters, createdAt: Date.now() };
    const matches = searchWardrobeItems(context.wardrobe, filters, message, eventProfile);
    if (matches.length) {
      outfits = [wardrobeCheckOutfit(matches, filters, message)];
      reply = `I checked your wardrobe and found ${matches.length} matching item${matches.length === 1 ? '' : 's'}.`;
      actions = [{ type: 'search_online', label: 'Search online too', prompt: `Search online for ${message}` }];
    } else {
      const label = filters.category ? categoryLabel(filters.category) : 'that item';
      reply = `I checked your wardrobe and did not find a strong match for ${label}. Want me to search online?`;
      actions = [{ type: 'search_online', label: 'Search online', prompt: `Search online for ${message}` }];
    }
  } else if (intent === 'product_search_confirmed') {
    mode = 'product_search';
    reply = 'I will search product options for that request.';
    actions = [{ type: 'search_online', label: 'Search online', prompt: `Search online for ${message}` }];
  } else if (intent === 'outfit_revision') {
    mode = 'outfit_revision';
    const revised = reviseOutfit(conversation, context, filters, message);
    outfits = revised && !revised.noWardrobeAlternative ? [revised] : [];
    reply = revised ? (revised.revisionSummary || revised.reason) : 'I need a current outfit before I can revise it.';
    if (revised?.noWardrobeAlternative) {
      actions = [{ type: 'search_online', label: 'Search online', prompt: `Search online for different ${categoryLabel(revised.replaceCategory || filters.category || 'item')}` }];
      pendingProductChoice = { kind: 'product', message: `different ${categoryLabel(revised.replaceCategory || filters.category || 'item')}`, filters: { ...filters, category: revised.replaceCategory || filters.category || '' }, createdAt: Date.now() };
    }
  } else if (intent === 'try_on_request') {
    mode = 'try_on_plan';
    const outfit = conversation.currentOutfit || bestCombo;
    if (outfit) {
      outfits = [outfit];
      reply = 'This look is ready for a try-on plan. Use the try-on action when you want to generate it.';
      actions = [tryOnActionFor(context, outfit)];
    } else {
      reply = 'I need an outfit or product selection first, then I can plan the try-on.';
    }
  } else if (wantsOutfitPlan && explicitStandaloneMissing) {
    mode = 'product_search';
    wardrobeWeak = true;
    reply = `I do not see a ${categoryLabel(filters.category)} in your wardrobe yet, so I will search options you can shop.`;
    actions = [{ type: 'search_products', label: 'Search products', prompt: `Search online for ${message}` }];
  } else if (wantsOutfitPlan && bestCombo?.wardrobeFit === 'strong' && !bestCombo.missing.length) {
    mode = 'wardrobe_first';
    outfits = [bestCombo];
    reply = 'Your wardrobe already has a strong look for this. I would show this before searching products.';
    actions = [tryOnActionFor(context, bestCombo)];
  } else if (wantsOutfitPlan && bestCombo?.wardrobeFit === 'partial') {
    mode = 'hybrid_wardrobe_shopping';
    wardrobeWeak = true;
    outfits = [{ ...bestCombo, source: 'hybrid', sourceLabel: sourceLabel('hybrid') }];
    reply = 'Your wardrobe gives us a base, but I will add a searched piece so it actually fits the occasion.';
    actions = [{ type: 'search_products', label: 'Find missing pieces', prompt: `Search online for ${targetCategories.map(categoryLabel).join(' ') || message}` }];
  } else if (wantsOutfitPlan && eventProfile) {
    mode = 'product_search';
    wardrobeWeak = true;
    reply = `Your saved wardrobe does not strongly match ${eventProfile.label}, so I will search shopping options instead.`;
    actions = [{ type: 'search_products', label: 'Search products', prompt: `Search online for ${message}` }];
  } else if (bestCombo && bestCombo.score >= 32 && !bestCombo.missing.length) {
    mode = 'wardrobe_first';
    outfits = [bestCombo];
    reply = 'Your wardrobe already has a strong look for this. I would show this before searching products.';
    actions = [tryOnActionFor(context, bestCombo)];
  } else if (bestCombo && bestCombo.missing.length) {
    mode = 'hybrid_wardrobe_shopping';
    wardrobeWeak = true;
    outfits = [{ ...bestCombo, source: 'hybrid', sourceLabel: sourceLabel('hybrid') }];
    reply = 'Your wardrobe is missing a key piece. I will search only for that missing item.';
    actions = [{ type: 'search_products', label: 'Find missing pieces', prompt: `Search online for ${bestCombo.missing.map(categoryLabel).join(' ')}` }];
  } else {
    mode = 'style_advice';
    reply = 'Tell me the occasion, item, budget, color, or vibe and I will make this specific.';
    actions = sourceChoiceActions(message);
  }

  return {
    intent,
    mode,
    filters,
    reply,
    outfits,
    products,
    actions,
    brain: 'local',
    model: '',
    eventProfile: eventProfile ? { key: eventProfile.key, label: eventProfile.label } : null,
    wardrobeFit: bestCombo?.wardrobeFit || '',
    wardrobeWeak,
    productSearchQuery: localSearchQuery,
    pendingProductChoice
  };
}

function flattenText(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  for (const key of ['output', 'output_text', 'text', 'content', 'message', 'response']) {
    const found = flattenText(value[key], depth + 1);
    if (found) return found;
  }
  if (value.choices) return flattenText(value.choices, depth + 1);
  return Object.values(value).map((item) => flattenText(item, depth + 1)).filter(Boolean).join('\n');
}

function parseJsonFromText(value = '') {
  const cleaned = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI response did not include JSON');
  }
}

function compactItem(item = {}) {
  return {
    id: item.id || item._id || '',
    name: item.name || item.title || '',
    category: item.category || '',
    color: item.color || item.colors?.[0] || '',
    brand: item.brand || '',
    price: item.price || null,
    imageUrl: item.imageUrl || item.remoteImageUrl || item.thumbnail || item.image || '',
    sourceUrl: item.sourceUrl || item.url || '',
    affiliateLink: item.affiliateLink || '',
    source: item.source || item.searchSource || '',
    sourceLabel: item.sourceLabel || '',
    searchLink: Boolean(item.searchLink),
    tags: item.tags || [],
    occasions: item.occasions || [],
    missing: item.missing || []
  };
}

function compactOutfit(outfit = {}) {
  return {
    id: outfit.id || '',
    title: outfit.title || '',
    source: outfit.source || '',
    score: outfit.score || 0,
    suitability: outfit.suitability || outfit.score || 0,
    wardrobeFit: outfit.wardrobeFit || '',
    eventKey: outfit.eventKey || '',
    missing: outfit.missing || [],
    eventMissing: outfit.eventMissing || [],
    reason: outfit.reason || '',
    items: (outfit.items || []).map(compactItem),
    products: (outfit.products || []).map(compactItem)
  };
}

function falSystemPrompt() {
  return [
    'You are Lookmefy AI Studio, the single AI brain for fashion, wardrobe, shopping, styling, try-on, and Lookmefy support.',
    'Stay inside Lookmefy scope: Lookmefy features, app help, fashion styling, wardrobe planning, shopping/product discovery, tokens, profile, wishlist, orders, and try-on planning.',
    'Do not answer unrelated general knowledge, politics, news, coding, medical, legal, finance, homework, or current-events questions. Redirect briefly back to Lookmefy and fashion.',
    'Decide intent, mode, reply, and dry-run actions using only the supplied wardrobe, product candidates, conversation, and knowledge snippets.',
    'Use visibleMemory to answer source questions. If visible products came from Amazon or the Lookmefy catalog, never call them wardrobe items.',
    'Use source labels honestly: Amazon results are shopping cards, Lookmefy catalog results are app product cards, wardrobe items are owned/saved clothing.',
    'Prioritize wardrobe-first outfit recommendations only when wardrobeFit is strong. Use hybrid mode when wardrobeFit is partial. Use product_search when wardrobeFit is weak or the user clearly asks to buy/find/shop.',
    'For celebrity-inspired prompts, do not claim exact celebrity facts or exact wardrobe knowledge. Translate the name into a general style direction.',
    'Respect replyLanguage. Use natural Roman Hinglish for hinglish, simple Hindi wording for hindi, and English for english.',
    'Never claim that an actual try-on was generated. For try-on requests, plan the try-on action only.',
    'Do not invent product cards, wardrobe items, prices, sources, or app capabilities. Select candidates by id only.',
    'Return only valid JSON. No markdown, no prose outside JSON.'
  ].join('\n');
}

function falPrompt({ message, conversation, context, filters, knowledge, localPlan: plan, wardrobeCombos, productCandidates, eventProfile, productSearch }) {
  return JSON.stringify({
    task: 'Return a structured AI Studio plan.',
    outputSchema: {
      intent: 'string',
      mode: 'string',
      filters: 'object',
      reply: '2-4 short helpful sentences for the user',
      selectedOutfitIds: ['candidate outfit ids to render'],
      selectedProductIds: ['candidate product ids to render'],
      actions: [{ type: 'string', label: 'short label', prompt: 'optional follow-up prompt' }]
    },
    latestUserMessage: message,
    extractedFilters: filters,
    profile: {
      name: context.profile?.name || 'User',
      genderPreference: context.profile?.genderPreference || '',
      stylePreferences: context.profile?.stylePreferences || [],
      sizes: context.profile?.sizes || {},
      tokens: context.profile?.tokens
    },
    recentActivity: context.recentActivity || [],
    replyLanguage: conversation.language || 'english',
    recentConversation: (conversation.turns || []).slice(-8),
    currentOutfit: conversation.currentOutfit ? compactOutfit(conversation.currentOutfit) : null,
    visibleMemory: conversation.lastVisible ? {
      message: conversation.lastVisible.message,
      sources: conversation.lastVisible.sources,
      products: (conversation.lastVisible.products || []).slice(0, 8).map(compactItem),
      wardrobeItems: (conversation.lastVisible.wardrobeItems || []).slice(0, 8).map(compactItem),
      outfits: (conversation.lastVisible.outfits || []).slice(0, 3).map(compactOutfit)
    } : null,
    eventProfile: eventProfile ? {
      key: eventProfile.key,
      label: eventProfile.label,
      requiredGroups: eventProfile.requiredGroups,
      searchCategories: eventProfile.searchCategories,
      signals: eventProfile.signals
    } : null,
    ragSnippets: knowledge.map((item) => ({
      doc: item.doc,
      title: item.title,
      score: item.score,
      matchedTerms: item.matchedTerms,
      content: item.content
    })),
    wardrobeCandidates: wardrobeCombos.slice(0, 4).map(compactOutfit),
    productCandidates: productCandidates.map(compactItem),
    productSearch: productSearch ? {
      query: productSearch.query,
      source: productSearch.source,
      targets: productSearch.targets
    } : null,
    fallbackLocalPlan: {
      intent: plan.intent,
      mode: plan.mode,
      filters: plan.filters,
      reply: plan.reply,
      outfitIds: (plan.outfits || []).map((item) => item.id),
      productIds: (plan.products || []).map((item) => item.id),
      actions: plan.actions,
      wardrobeFit: plan.wardrobeFit,
      wardrobeWeak: plan.wardrobeWeak,
      productSearchQuery: plan.productSearchQuery
    }
  }, null, 2);
}

async function callFalPlanner(payload) {
  if (!envFlag('FAL_AI_STUDIO_ENABLED', true)) throw new Error('FAL AI Studio planner is disabled');
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY is missing');
  const endpoint = String(process.env.FAL_AI_STUDIO_ENDPOINT || process.env.FAL_CLOSET_VISION_ENDPOINT || 'openrouter/router/vision').replace(/^\/+|\/+$/g, '');
  const model = String(process.env.FAL_AI_STUDIO_MODEL || process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash-lite');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), falTimeoutMs);
  try {
    const response = await fetch(`https://fal.run/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        prompt: falPrompt(payload),
        system_prompt: falSystemPrompt(),
        max_tokens: falMaxTokens,
        temperature: falTemperature
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(flattenText(data) || `FAL request failed (${response.status})`);
    const output = flattenText(data).trim();
    if (!output) throw new Error('FAL returned an empty response');
    return { plan: parseJsonFromText(output), usage: data.usage || null, model };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('FAL planner timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeActions(actions = [], fallback = []) {
  const source = Array.isArray(actions) && actions.length ? actions : fallback;
  return source
    .map((action) => {
      if (typeof action === 'string') return { type: 'message', label: cleanText(action, 80), prompt: cleanText(action, 180) };
      if (!action || typeof action !== 'object') return null;
      return {
        type: cleanText(action.type || 'message', 40),
        label: cleanText(action.label || action.type || 'Action', 80),
        prompt: cleanText(action.prompt || '', 180),
        disabled: Boolean(action.disabled),
        disabledReason: cleanText(action.disabledReason || '', 160),
        payload: action.payload && typeof action.payload === 'object' ? action.payload : undefined
      };
    })
    .filter((action) => action?.label)
    .slice(0, 4);
}

function selectCandidatesById(candidates = [], ids = []) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const selected = new Set(ids.map((id) => String(id)));
  return candidates.filter((candidate) => selected.has(String(candidate?.id)));
}

function mergeFalPlan({ falPlan, localPlan: fallbackPlan, candidateOutfits, candidateProducts }) {
  const selectedOutfits = selectCandidatesById(candidateOutfits, falPlan?.selectedOutfitIds);
  const selectedProducts = selectCandidatesById(candidateProducts, falPlan?.selectedProductIds);
  const localProductOnly = Boolean(fallbackPlan.mode === 'product_search'
    && (fallbackPlan.wardrobeWeak || fallbackPlan.intent === 'product_search_confirmed'));
  let mode = cleanText(falPlan?.mode || fallbackPlan.mode, 60);
  if (localProductOnly) mode = 'product_search';
  if (fallbackPlan.wardrobeWeak && mode === 'wardrobe_first') mode = fallbackPlan.mode;
  const allowsOutfits = !localProductOnly && ['outfit_revision', 'try_on_plan', 'wardrobe_first', 'hybrid_wardrobe_shopping'].includes(mode);
  const needsProducts = localProductOnly || fallbackPlan.wardrobeWeak || mode === 'product_search' || mode === 'hybrid_wardrobe_shopping';
  const mergedFilters = falPlan?.filters && typeof falPlan.filters === 'object'
    ? { ...fallbackPlan.filters, ...falPlan.filters }
    : fallbackPlan.filters;
  const requestedCategoryProducts = selectedProducts.length
    ? selectedProducts
    : candidateProducts.filter((product) => categoryMatchesFilter(product, mergedFilters));
  const mergedOutfits = allowsOutfits
    ? (selectedOutfits.length ? selectedOutfits : fallbackPlan.outfits).filter((outfit) => outfitMatchesRequestedCategory(outfit, mergedFilters))
    : [];
  const visibleOutfits = standaloneCategory(mergedFilters.category)
    ? mergedOutfits.filter((outfit) => outfitHasWardrobeCategory(outfit, mergedFilters))
    : mergedOutfits;
  const categoryRequestedButMissing = Boolean(mergedFilters.category && allowsOutfits && !mergedOutfits.length);
  const finalMode = localProductOnly || categoryRequestedButMissing ? 'product_search' : mode;
  const finalOutfits = localProductOnly ? [] : visibleOutfits;
  const finalProducts = localProductOnly
    ? candidateProducts
    : selectedProducts.length
      ? selectedProducts
      : needsProducts || categoryRequestedButMissing
        ? requestedCategoryProducts
        : [];
  return {
    ...fallbackPlan,
    intent: localProductOnly ? fallbackPlan.intent : cleanText(falPlan?.intent || fallbackPlan.intent, 80),
    mode: finalMode,
    filters: mergedFilters,
    reply: cleanText(falPlan?.reply || '', 800) || fallbackPlan.reply,
    outfits: finalOutfits,
    products: finalProducts,
    actions: sanitizeActions(falPlan?.actions, fallbackPlan.actions),
    brain: 'fal',
    model: String(process.env.FAL_AI_STUDIO_MODEL || process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash-lite')
  };
}

function replyFingerprint(value = '') {
  return normalize(value).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function replyWasRepeated(reply = '', conversation = {}) {
  const next = replyFingerprint(reply);
  if (!next) return false;
  return (conversation.turns || [])
    .filter((turn) => turn.role === 'assistant')
    .slice(-5)
    .some((turn) => replyFingerprint(turn.text) === next);
}

function antiRepeatReply(plan = {}, conversation = {}) {
  if (!replyWasRepeated(plan.reply, conversation)) return plan;
  if (plan.mode === 'chat_control') {
    return {
      ...plan,
      reply: plan.intent === 'greeting'
        ? 'Still here. Give me an occasion, item, budget, color, or vibe and I will style it.'
        : 'Got it. Give me one detail: occasion, budget, color, or item.'
    };
  }
  return {
    ...plan,
    reply: plan.mode === 'product_search'
      ? 'I found product options for this. Want me to narrow them by budget, color, or vibe?'
      : 'Got it. Want a cleaner, bolder, or more casual version?'
  };
}

function appendProductsToHybridOutfits(outfits = [], productSearch = {}) {
  const products = productSearch.products || [];
  if (!products.length) return outfits;
  return outfits.map((outfit) => ({
    ...outfit,
    products,
    reason: `${outfit.reason || 'Uses wardrobe pieces as the base.'} Add ${products[0].searchLink ? 'the linked shopping search' : products[0].name} to complete it.`
  }));
}

function productSearchReply(productSearch = {}) {
  const count = productSearch.products?.length || 0;
  const suffix = count === 1 ? '' : 's';
  if (productSearch.source === 'amazon-search-link') return 'Amazon did not expose product cards, so I made a direct Amazon search link for this.';
  if (/amazon/i.test(productSearch.source || '')) return `I found ${count} live Amazon product option${suffix} for this.`;
  return `I found ${count} product option${suffix} for this.`;
}

async function orchestrateAiStudio({ user, message, conversationId = '', history = [] } = {}) {
  const prompt = cleanText(message, 600);
  if (!prompt) {
    const error = new Error('Message AI Studio first');
    error.statusCode = 400;
    throw error;
  }

  const context = await loadContext(user);
  const conversation = nextConversation({ userId: context.profile.id, conversationId, history });
  const languagePreference = detectLanguagePreference(prompt);
  if (languagePreference) conversation.language = languagePreference;
  else if (!conversation.language && messageLooksHinglish(prompt)) conversation.language = 'hinglish';

  const sourcePlan = visibleSourcePlan(prompt, conversation);
  if (sourcePlan) {
    const plan = annotateVisibleSources(sourcePlan);
    conversation.turns.push({ role: 'user', text: prompt }, { role: 'assistant', text: plan.reply, mode: plan.mode, intent: plan.intent });
    conversation.updatedAt = Date.now();
    return {
      conversationId: conversation.id,
      dryRun: true,
      contextSource: context.source,
      brain: plan.brain || 'local',
      model: plan.model || '',
      intent: plan.intent,
      mode: plan.mode,
      filters: plan.filters,
      reply: plan.reply,
      outfits: plan.outfits || [],
      products: plan.products || [],
      actions: sanitizeActions(plan.actions),
      suggestions: aiStudioSuggestions(prompt, plan.products || [], plan.actions || []),
      rag: []
    };
  }

  const pendingChoice = detectProductChoice(prompt, conversation);
  const explicitPath = pendingChoice ? '' : detectExplicitProductPath(prompt);
  const budgetFollowUpMessage = !pendingChoice && isBudgetOnlyPrompt(prompt) ? lastSearchableMessage(conversation) : '';
  const fallbackSearchMessage = !pendingChoice && explicitPath === 'online' && isGenericOnlineSearchPrompt(prompt)
    ? lastSearchableMessage(conversation) || defaultOnlineSearchMessage(context)
    : '';
  const planningMessage = pendingChoice
    ? conversation.pendingProductChoice.message
    : fallbackSearchMessage || (budgetFollowUpMessage ? `${budgetFollowUpMessage} ${prompt}` : prompt);
  const pendingChoiceKind = conversation.pendingProductChoice?.kind || 'product';
  const filters = pendingChoice && conversation.pendingProductChoice.filters
    ? { ...conversation.pendingProductChoice.filters }
    : extractFilters(planningMessage, context.profile);
  let detectedIntent = aiStudioIntent(planningMessage);
  if (detectedIntent === 'fashion_search') {
    detectedIntent = 'product_search_confirmed';
  }
  if (detectedIntent === 'wardrobe_help') {
    detectedIntent = /\b(outfit|look|wear|style|dress for|what should)\b/i.test(planningMessage)
      ? 'wardrobe_outfit_check'
      : 'wardrobe_product_check';
  }
  if (detectedIntent === 'tryon_help' && /\b(try\s*this|try\s*on|preview on me|on me|generate)\b/i.test(planningMessage) && !/\b(how|what|why|cost|tokens?|credits?|work)\b/i.test(planningMessage)) {
    detectedIntent = 'try_on_request';
  }
  if (pendingChoice === 'wardrobe') {
    detectedIntent = pendingChoiceKind === 'outfit' ? 'wardrobe_outfit_check' : 'wardrobe_product_check';
  } else if (pendingChoice === 'both') {
    detectedIntent = pendingChoiceKind === 'outfit' ? 'both_outfit_sources' : 'both_product_sources';
  } else if (pendingChoice === 'catalog') {
    detectedIntent = 'product_search_confirmed';
  } else if (explicitPath === 'wardrobe') {
    detectedIntent = isOutfitChoiceRequest(planningMessage, filters, detectedIntent) ? 'wardrobe_outfit_check' : 'wardrobe_product_check';
  } else if (pendingChoice === 'online' || explicitPath === 'online' || explicitPath === 'catalog') {
    detectedIntent = 'product_search_confirmed';
  } else if (detectedIntent !== 'outfit_revision' && isOutfitRevisionRequest(planningMessage)) {
    detectedIntent = 'outfit_revision';
  } else if (detectedIntent !== 'outfit_revision' && isBareProductSearchPrompt(planningMessage, filters)) {
    detectedIntent = 'product_search_confirmed';
  } else if (detectedIntent !== 'outfit_revision' && isDirectProductSearchRequest(planningMessage, filters, detectedIntent)) {
    detectedIntent = 'product_search_confirmed';
  } else if (isOutfitChoiceRequest(planningMessage, filters, detectedIntent)) {
    detectedIntent = 'outfit_source_choice';
  }

  const intent = containsAbuse(prompt)
    ? 'abuse_guard'
    : detectedIntent === 'language_preference'
      ? detectedIntent
      : isOutOfScope(planningMessage, filters) ? 'out_of_scope' : detectedIntent;
  const knowledge = await retrieveAiStudioKnowledge(planningMessage, 5);
  const eventProfile = eventProfileForMessage(planningMessage, filters);
  const wardrobeCombos = rankWardrobeCombos(buildWardrobeCombos(context.wardrobe, filters), filters, eventProfile);
  const bestCombo = wardrobeCombos[0] || null;
  let plan = localPlan({ message: planningMessage, conversation, context, intent, filters, wardrobeCombos, bestCombo, eventProfile });
  if (['rag_help'].includes(plan.mode)) plan = { ...plan, reply: localLookmefyHelpReply(planningMessage, knowledge) };
  if (plan.pendingProductChoice) conversation.pendingProductChoice = plan.pendingProductChoice;
  else if (pendingChoice) conversation.pendingProductChoice = null;

  const localOnlyIntent = ['greeting', 'small_talk', 'language_preference', 'abuse_guard', 'out_of_scope'].includes(intent)
    || plan.mode === 'product_choice'
    || plan.mode === 'source_choice'
    || plan.mode === 'rag_help';
  let productSearch = { query: plan.productSearchQuery || '', targets: [], source: 'not-needed', error: '', products: [] };

  if (!localOnlyIntent) {
    const needsSearch = plan.wardrobeWeak || ['product_search', 'hybrid_wardrobe_shopping'].includes(plan.mode);
    const sourcePreference = pendingChoice === 'catalog' || explicitPath === 'catalog'
      ? 'catalog'
      : pendingChoice === 'online' || explicitPath === 'online'
        ? 'online'
        : 'auto';
    if (needsSearch) {
      productSearch = await searchProductsForPlan({ message: planningMessage, filters, bestCombo, eventProfile, sourcePreference });
      if (productSearch.products.length) {
        plan = {
          ...plan,
          products: plan.mode === 'hybrid_wardrobe_shopping' ? [] : productSearch.products,
          productSearchQuery: productSearch.query,
          productSearchSource: productSearch.source,
          reply: plan.mode === 'product_search' ? productSearchReply(productSearch) : plan.reply,
          outfits: plan.mode === 'hybrid_wardrobe_shopping' ? appendProductsToHybridOutfits(plan.outfits || [], productSearch) : plan.outfits
        };
      } else {
        plan = {
          ...plan,
          products: [],
          productSearchQuery: productSearch.query,
          productSearchSource: productSearch.source,
          reply: `I could not find usable product cards yet. ${productSearch.error || 'Try a more specific item, color, or budget.'}`,
          actions: [{ type: 'search_online', label: 'Try online again', prompt: `Search online for ${planningMessage}` }],
          outfits: (plan.outfits || []).map((outfit) => ({ ...outfit, products: [] }))
        };
      }
    }

    const productCandidates = uniqueById([...(plan.products || []), ...(plan.outfits || []).flatMap((outfit) => outfit.products || []), ...(productSearch.products || [])]);
    const candidateOutfits = uniqueById([...(plan.outfits || []), ...wardrobeCombos.slice(0, 4)]);
    try {
      const result = await callFalPlanner({
        message: planningMessage,
        conversation,
        context,
        filters,
        knowledge,
        localPlan: plan,
        wardrobeCombos,
        productCandidates,
        eventProfile,
        productSearch
      });
      plan = mergeFalPlan({
        falPlan: result.plan,
        localPlan: plan,
        candidateOutfits,
        candidateProducts: productCandidates
      });
      plan.falUsage = result.usage;
      plan.model = result.model;
    } catch (error) {
      plan = { ...plan, falError: error.message || 'AI planner failed' };
    }
  }

  plan = antiRepeatReply(plan, conversation);
  plan = annotateVisibleSources(plan, productSearch);
  rememberVisibleResults(conversation, plan, prompt);
  if (intent === 'product_search_confirmed' || pendingChoice === 'both') conversation.pendingProductChoice = null;
  conversation.turns.push({ role: 'user', text: prompt }, { role: 'assistant', text: plan.reply, mode: plan.mode, intent: plan.intent });
  conversation.turns = conversation.turns.slice(-16);
  conversation.updatedAt = Date.now();

  const allProducts = uniqueById([
    ...(plan.products || []),
    ...(plan.outfits || []).flatMap((outfit) => outfit.products || [])
  ]);
  const actions = sanitizeActions(plan.actions);
  return {
    conversationId: conversation.id,
    dryRun: true,
    contextSource: context.source,
    brain: plan.brain || 'local',
    model: plan.model || '',
    intent: plan.intent,
    mode: plan.mode,
    filters: plan.filters,
    reply: plan.reply,
    outfits: plan.outfits || [],
    products: allProducts,
    actions,
    suggestions: aiStudioSuggestions(planningMessage, allProducts, actions),
    rag: knowledge.map(({ id, doc, title, matchedTerms, score }) => ({ id, doc, title, matchedTerms, score })),
    debug: envFlag('AI_STUDIO_DEBUG', false) ? {
      falError: plan.falError || '',
      productSearch: {
        query: productSearch.query,
        source: productSearch.source,
        targets: productSearch.targets,
        error: productSearch.error
      },
      eventProfile: eventProfile ? { key: eventProfile.key, label: eventProfile.label } : null,
      wardrobeCount: context.wardrobe.length,
      conversationTurns: conversation.turns.length
    } : undefined
  };
}

export {
  aiStudioFallbackReply,
  aiStudioIntent,
  aiStudioKnowledgeReply,
  aiStudioQueryTerms,
  aiStudioSuggestions,
  buildProductSearchQuery,
  extractFilters as extractAiStudioFilters,
  orchestrateAiStudio,
  retrieveAiStudioKnowledge,
  scoreAiStudioKnowledge,
  sourceLabel
};
