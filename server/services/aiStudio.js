import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ClosetItem from '../models/ClosetItem.js';
import ClosetOutfit from '../models/ClosetOutfit.js';
import Product, { productToClient } from '../models/Product.js';
import UserEvent from '../models/UserEvent.js';
import {
  explicitGenderPreferenceForText,
  genderCompatibility,
  genderedSearchQuery,
  genderPreferenceForQuery,
  normalizeGenderPreference
} from '../utils/genderPreference.js';
import { inferTryOnModel } from '../utils/tryOnModel.js';
import { availableStatusClause } from '../utils/productAvailability.js';
import { temporaryExternalAmazonFilter } from '../utils/productCatalogVisibility.js';
import {
  accessoryCategoryAliases,
  accessoryIdentityPattern,
  accessoryPatternForType,
  accessoryProductRules,
  accessoryTypeFromText,
  isAccessoryText
} from '../utils/accessoryTaxonomy.js';
import { safeFetchText } from '../utils/security.js';
import { wearableCompatibility } from '../utils/wearable.js';
import { catalogSearchProviderName, searchSerpApiAmazon } from './catalogSearchProvider.js';

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
  accessories: accessoryCategoryAliases,
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
    signals: ['office', 'work', 'workwear', 'formal', 'business', 'professional', 'classic', 'tailored', 'sheath', 'pencil', 'blazer', 'loafer', 'trouser'],
    requireSignal: true,
    excludedTerms: ['beach', 'vacation', 'resort', 'party', 'club', 'cocktail', 'sequin', 'glitter', 'cutout', 'backless', 'halter', 'nightwear', 'sleepwear'],
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
  christmas: {
    key: 'christmas',
    label: 'Christmas',
    aliases: ['christmas party', 'holiday party'],
    requiredGroups: [['dresses', 'tops'], ['bottoms', 'dresses'], ['shoes'], ['outerwear', 'accessories']],
    primaryCategories: ['dresses', 'tops', 'shoes'],
    searchCategories: ['dresses', 'tops', 'bottoms', 'shoes', 'outerwear', 'accessories'],
    signals: ['christmas', 'holiday', 'festive', 'red', 'green', 'velvet', 'sequin', 'sparkle', 'glitter'],
    requireSignal: true,
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette', 'sleepwear', 'nightwear', 'night suit', 'night dress', 'pajama', 'pyjama', 'babydoll', 'negligee', 'robe', 'saree', 'sari', 'lehenga', 'kurta', 'kurti', 'dupatta', 'ethnic'],
    searchTerms: ['christmas party dress', 'red velvet outfit', 'green satin top', 'holiday party shoes'],
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
    primaryCategories: ['swimwear', 'dresses', 'tops', 'bottoms', 'shoes', 'accessories'],
    searchCategories: ['swimwear', 'dresses', 'tops', 'bottoms', 'shoes', 'accessories'],
    signals: ['beach', 'vacation', 'resort', 'pool', 'swim', 'swimsuit', 'swimwear', 'bikini', 'monokini', 'tankini', 'cover up', 'coverup', 'kaftan', 'sarong', 'linen', 'crochet', 'summer', 'sandals', 'shorts', 'sun hat', 'sunglasses', 'breathable'],
    requireSignal: true,
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette', 'sleepwear', 'nightwear', 'night suit', 'night dress', 'pajama', 'pyjama', 'babydoll', 'negligee', 'robe', 'saree', 'sari', 'lehenga', 'kurta', 'kurti', 'dupatta', 'ethnic'],
    searchTerms: ['bikini swimsuit swimwear', 'beach cover up kaftan sarong', 'linen beach shirt shorts', 'beach sandals sunglasses sun hat'],
    searchTermsByGender: {
      female: ['bikini swimsuit swimwear', 'beach cover up kaftan sarong', 'linen beach shirt shorts', 'beach sandals sunglasses sun hat'],
      male: ['swim trunks board shorts swimwear', 'linen beach shirt shorts', 'rash guard swim shirt', 'beach sandals sunglasses sun hat'],
      other: ['swimsuit swimwear', 'beach cover up', 'linen beach shirt shorts', 'beach sandals sunglasses sun hat']
    },
    minSignalItems: 2
  },
  halloween: {
    key: 'halloween',
    label: 'Halloween',
    aliases: ['costume party', 'halloween party', 'fancy dress party'],
    requiredGroups: [['costumes', 'dresses', 'tops'], ['bottoms', 'dresses', 'costumes'], ['shoes'], ['outerwear', 'accessories']],
    primaryCategories: ['costumes', 'dresses', 'tops', 'shoes'],
    searchCategories: ['costumes', 'dresses', 'tops', 'bottoms', 'shoes', 'outerwear', 'accessories'],
    signals: ['halloween', 'costume', 'cosplay', 'black', 'orange', 'goth', 'lace', 'leather', 'velvet', 'boots', 'party'],
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette', 'sleepwear', 'nightwear', 'night suit', 'night dress', 'pajama', 'pyjama', 'babydoll', 'negligee', 'robe', 'saree', 'sari', 'lehenga', 'kurta', 'kurti', 'dupatta', 'ethnic'],
    searchTerms: ['halloween outfit', 'black party dress', 'goth top', 'costume accessories'],
    minSignalItems: 1
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
    primaryCategories: ['tops', 'bottoms', 'dresses', 'shoes'],
    searchCategories: ['tops', 'bottoms', 'dresses', 'shoes', 'outerwear', 'accessories'],
    signals: ['casual', 'comfortable', 'denim', 'sneaker', 'relaxed', 'brunch', 'college'],
    excludedTerms: ['lingerie', 'underwear', 'innerwear', 'bra', 'bralette', 'sleepwear', 'nightwear', 'night suit', 'night dress', 'pajama', 'pyjama', 'babydoll', 'negligee', 'robe'],
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
const webResultLimit = Math.floor(positiveNumber('AI_STUDIO_WEB_RESULT_LIMIT', positiveNumber('AI_STUDIO_AMAZON_RESULT_LIMIT', 10, { min: 1, max: 12 }), { min: 1, max: 12 }));
const webSearchTimeoutMs = positiveNumber('AI_STUDIO_WEB_TIMEOUT_MS', positiveNumber('AI_STUDIO_AMAZON_TIMEOUT_MS', 2500, { min: 500, max: 8000 }), { min: 500, max: 8000 });
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
    || /\b(how are you|what'?s up|who are you|what can you do)\b/.test(lower)
    || /\b(kya kar raha|kya kar rahe|kya chal raha|kaise ho|kya scene|kya kar raha hai)\b/.test(lower);
}

function isOutOfDomainSmallTalk(message = '') {
  return /\b(i am bored|i'm bored|tell me a joke)\b/i.test(String(message || ''));
}

function defaultAiStudioTimeZone() {
  const configured = process.env.AI_STUDIO_DEFAULT_TIME_ZONE || process.env.TZ || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    return 'Asia/Kolkata';
  }
}

function currentDateTimeReply(message = '') {
  if (isWeatherQuestion(message)) return '';
  const lower = normalize(message);
  const asksTime = /\b(time|clock)\b/.test(lower);
  const asksDate = /\b(date|day|today)\b/.test(lower);
  if (!asksTime && !asksDate) return '';
  const timeZone = defaultAiStudioTimeZone();
  const now = new Date();
  const dateText = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(now);
  const timeText = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(now);
  if (asksTime && asksDate) return `Current server date and time is ${dateText}, ${timeText} (${timeZone}).`;
  if (asksTime) return `Current server time is ${timeText} (${timeZone}).`;
  return `Today is ${dateText} (${timeZone}).`;
}

function isWeatherQuestion(message = '') {
  return /\b(weather|temperature|forecast|rain|raining|humidity)\b/i.test(String(message || ''));
}

function isGeneralUtilityQuestion(message = '') {
  const lower = normalize(message);
  const fashionContext = /\b(outfit|wear|style|dress|look|shirt|top|pants|trouser|jeans|shoe|sneaker|jacket|blazer|wardrobe|date\s+night)\b/.test(lower);
  if (isWeatherQuestion(message)) return true;
  if (/\b(time|clock)\b/.test(lower) && !fashionContext) return true;
  if (/\b(?:what(?:'s| is)?\s+(?:the\s+)?date|today'?s?\s+date|current\s+date|which\s+day|what\s+day)\b/.test(lower)) return true;
  return false;
}

function weatherCodeLabel(code) {
  const value = Number(code);
  if (value === 0) return 'clear';
  if ([1, 2, 3].includes(value)) return 'partly cloudy';
  if ([45, 48].includes(value)) return 'foggy';
  if ([51, 53, 55, 56, 57].includes(value)) return 'drizzly';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'rainy';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'snowy';
  if ([95, 96, 99].includes(value)) return 'stormy';
  return 'cloudy';
}

function weatherLocationFromMessage(message = '') {
  const text = cleanText(message, 180);
  const match = text.match(/\b(?:weather|temperature|forecast|rain|raining|humidity)\s+(?:in|for|at|near)?\s*([a-z][a-z\s,.'-]{1,80})/i)
    || text.match(/\b(?:in|for|at|near)\s+([a-z][a-z\s,.'-]{1,80})\s+(?:weather|temperature|forecast|rain|raining|humidity)\b/i);
  const location = match?.[1]
    ?.replace(/\b(today|tomorrow|now|right now|please|pls|outside|there)\b/gi, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
  return location || '';
}

async function currentWeatherReply(message = '') {
  if (!isWeatherQuestion(message)) return '';
  const location = weatherLocationFromMessage(message);
  if (!location) return 'Tell me the city or place and I can check the weather. For example: "weather in Mumbai" or "weather in New York".';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const geoResponse = await fetch(geocodeUrl, { signal: controller.signal });
    const geo = await geoResponse.json().catch(() => ({}));
    const place = Array.isArray(geo.results) ? geo.results[0] : null;
    if (!geoResponse.ok || !place) return `I could not find a weather location for "${location}". Try a city name.`;
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(place.latitude)}&longitude=${encodeURIComponent(place.longitude)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=auto`;
    const weatherResponse = await fetch(weatherUrl, { signal: controller.signal });
    const weather = await weatherResponse.json().catch(() => ({}));
    if (!weatherResponse.ok || !weather.current) return `I could not fetch live weather for ${place.name} right now.`;
    const current = weather.current;
    const units = weather.current_units || {};
    const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
    return `Current weather in ${placeLabel}: ${Math.round(Number(current.temperature_2m))}${units.temperature_2m || 'C'}, ${weatherCodeLabel(current.weather_code)}, feels like ${Math.round(Number(current.apparent_temperature))}${units.apparent_temperature || 'C'}, humidity ${Math.round(Number(current.relative_humidity_2m))}${units.relative_humidity_2m || '%'}, wind ${Math.round(Number(current.wind_speed_10m))} ${units.wind_speed_10m || 'km/h'}.`;
  } catch (error) {
    return 'I could not fetch live weather right now. Try again with a city name in a moment.';
  } finally {
    clearTimeout(timeout);
  }
}

function isGeneralChatRequest(message = '') {
  const lower = normalize(message);
  if (!lower) return false;
  return lower.endsWith('?')
    || /\b(?:who|what|where|when|why|how|tell me|explain|write|summarize|calculate|solve|capital|president|prime minister|minister|weather|temperature|forecast|time|date|today|news|stock|crypto|recipe|movie|song|joke|story|poem|translate)\b/.test(lower);
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

function isGeneralStyleQuestion(message = '', filters = {}) {
  const lower = normalize(message);
  if (!lower || isGreetingOnly(lower) || isSmallTalk(lower) || detectLanguagePreference(lower)) return false;
  if (isGeneralUtilityQuestion(lower)) return false;
  if (containsAbuse(lower) || isListAllProductsPrompt(lower)) return false;
  const questionLike = /\?$/.test(lower)
    || /\b(?:what\s+(?:is|are|does)|how\s+(?:to|do|should|can|would)|can\s+i|should\s+i|which\s+colou?rs?|what\s+colou?rs?|does\b.*\b(?:match|go\s+with|work\s+with)|tips?\s+for|guide\s+to|explain|meaning\s+of|difference\s+between|when\s+(?:to|should)|why)\b/.test(lower);
  if (!questionLike) return false;
  const asksForResults = /\b(?:show|find|search|shop|buy|recommend|suggest|give|get|need|want|looking\s+for)\b/.test(lower)
    || budgetPattern().test(lower);
  const asksForOutfitSelection = /\b(?:what\s+should\s+i\s+wear|which\b.*\bshould\s+i\s+wear|style\s+me|dress\s+me|outfit\s+for|look\s+for|wear\s+for)\b/.test(lower);
  if (asksForResults || asksForOutfitSelection) return false;
  const styleScope = /\b(?:fashion|style|styling|outfit|look|wear|wardrobe|closet|dress\s*code|smart\s+casual|business\s+casual|formal|casual|classy|minimal|old\s+money|streetwear|fit|fits|fitting|silhouette|proportion|layer|layers|fabric|material|linen|cotton|denim|satin|silk|wool|leather|mesh|knit|colou?r|palette|match|pair|go(?:es)?\s+with|accessori[sz]e|accessories|jewellery|jewelry|shirt|top|pants|trouser|jeans|shoe|sneaker|loafer|heel|sandal|jacket|blazer|coat|watch|bag|belt|dress|gown|kurta|saree|lehenga|bikini|swimwear|beach|party|office|wedding|dinner|date|brunch|college|travel|gym)\b/.test(lower);
  return styleScope || Boolean(filters.category || filters.color || filters.material || filters.fit || filters.occasion || filters.style);
}

function hasLookmefyScope(message = '', filters = {}) {
  const lower = normalize(message);
  if (isGeneralStyleQuestion(message, filters)) return true;
  if (mentionsLookmefy(message)) return true;
  if (filters.category || filters.occasion || filters.style || filters.color || filters.budget || filters.fit || filters.material) return true;
  return /\b(lookmefy|fashion|style|styling|outfit|wear|wardrobe|closet|shop|shopping|buy|find|search|products?|try\s*on|preview|generate|tokens?|credits?|wishlist|profile|history|dress|shirt|top|pants|trouser|jeans|shoe|sneaker|loafer|heel|sandal|jacket|blazer|coat|watch|bag|belt|jewellery|jewelry|accessory|ethnic|kurta|saree|costume|cosplay|halloween|bra|bralette|lingerie|underwear|innerwear|bikini|swimsuit|swimwear|wedding|party|dinner|date|farewell|freshers|prom|christmas|diwali|eid|holi|office|college|travel|vacation|resort|beach|pool|gym|workout|brunch|interview|change|swap|replace|another|other|different|remove|avoid|without|bolder|cleaner|classy|casual|formal)\b/.test(lower);
}

function isOutOfScope(message = '', filters = {}) {
  return !(isGreetingOnly(message) || isCasualGreetingPrefix(message) || isSmallTalk(message) || detectLanguagePreference(message) || hasLookmefyScope(message, filters));
}

function budgetPattern() {
  return /(?:under|below|upto|up to|less than)\s*(?:₹|rs\.?|inr)?\s*[\d,]{2,9}/i;
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
  const budget = lower.match(/(?:under|below|upto|up to|less than)\s*(?:₹|rs\.?|inr)?\s*([\d,]{2,9})/)?.[1]?.replace(/,/g, '');
  const color = lower.match(/\b(black|white|cream|beige|blue|navy|green|red|pink|brown|grey|gray|gold|silver|maroon|purple|lavender|yellow|orange)\b/)?.[1] || '';
  const explicitGender = explicitGenderPreferenceForText(lower);
  const occasionMatch = lower.match(/\b(new year|christmas|halloween|diwali|eid|holi|office|party|wedding|weeding|date|dinner|college|collage|travel|vacation|resort|beach|pool|gym|workout|casual|formal|brunch|interview|festive|farewell|freshers|prom|graduation)\b/)?.[1] || '';
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
    ['costumes', /\b(halloween\s+costumes?|costumes?|cosplay|fancy\s*dress)\b/],
    ['swimwear', /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|one\s*piece\s+swimsuits?|swim\s+trunks?|board\s+shorts?|rash\s+guards?)\b/],
    ['innerwear', /\b(underwear|undergarments?|briefs?|boxers?|trunks?|vests?|innerwear|lingerie|bras?|bralettes?|sports?\s+bras?|pant(?:y|ies)|camisoles?|shapewear)\b/],
    ['shoes', /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?)\b/],
    ['ethnic', /\b(kurtas?|kurtis?|sarees?|saris?|lehengas?|dupattas?|salwars?|anarkali|churidar|sharara|ethnic)\b/],
    ['tops', /\b(shirts?|t-?shirts?|tops?|blouses?|hoodies?|tees?)\b/],
    ['bottoms', /\b(pants?|trousers?|jeans?|shorts?|skirts?|joggers?)\b/],
    ['outerwear', /\b(jackets?|blazers?|coats?|cardigans?)\b/],
    ['accessories', accessoryIdentityPattern],
    ['dresses', /\b(dress(?:es)?|gowns?|frocks?)\b/]
  ];
  let category = categoryMap.find(([, pattern]) => pattern.test(lower))?.[0] || '';
  if (celebrityStyle && category === 'dresses' && /\bdress(?:ing)?\s+like\b/.test(lower) && !/\b(dresses|gowns?|frocks?|midi|maxi|bodycon|a-line|fit\s*&?\s*flare)\b/.test(lower)) {
    category = '';
  }
  const detectedProductType = specificProductLabel(message, { category });
  // "Denim" by itself describes a material, not necessarily a pair of jeans.
  // Keep the broader material signal without silently narrowing the garment type.
  const productType = detectedProductType === 'jeans' && !/\bjeans?\b/.test(lower)
    ? ''
    : detectedProductType;
  return {
    category,
    productType,
    gender: explicitGender || normalizeGenderPreference(profile.genderPreference) || '',
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
  if (isGeneralUtilityQuestion(message)) return 'general_question';
  if (isOutOfDomainSmallTalk(message)) return 'general_question';
  if (isSmallTalk(message)) return 'small_talk';
  if (isGeneralStyleQuestion(message, filters)) return 'general_style_question';
  if (isOutOfScope(message, filters)) return 'general_question';
  if (/\b(tokens?|credits?|balance|refunds?|cost|price|pricing|charge|payment)\b/i.test(message)) return 'token_help';
  if (/\btry\s*on|try-on|generate|generation|video|profile photo|body photo|preview on me|on me\b/i.test(message)) return 'tryon_help';
  if (/\bwardrobe|closet|owned|mine\b/i.test(message)) return 'wardrobe_help';
  if (/\b(shop|search|buy|amazon|product|catalog|under|below)\b/i.test(message) || budgetPattern().test(message)) return 'fashion_search';
  if (mentionsLookmefy(message) || knowledge.length) return 'lookmefy_help';
  if (/\b(wear|style|recommend|look|party|office|wedding|beach|gym|dinner|date|travel|casual)\b/.test(lower)) return 'outfit_recommendation';
  if (isGeneralChatRequest(message)) return 'general_question';
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
  if (value.includes('web') || value.includes('amazon') || value.includes('serpapi')) return 'Web find';
  if (value.includes('catalog')) return 'Lookmefy catalog';
  if (value.includes('wardrobe') || value.includes('closet')) return 'Wardrobe item';
  if (value.includes('hybrid')) return 'Mixed look';
  return 'Result';
}

function productSourceType(product = {}, fallback = '') {
  const fallbackText = normalize(fallback);
  const explicitSourceText = normalize([
    product.source,
    product.searchSource,
    product.sourceLabel
  ].filter(Boolean).join(' '));
  if (explicitSourceText.includes('catalog') || explicitSourceText.includes('mongo') || fallbackText.includes('catalog')) return 'lookmefy_catalog';
  if (explicitSourceText.includes('web') || fallbackText.includes('web')) return 'web';

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
  if (sourceText.includes('web') || sourceText.includes('amazon') || sourceText.includes('amzn.in') || sourceText.includes('serpapi')) return 'web';
  if (sourceText.includes('catalog') || sourceText.includes('mongo')) return 'lookmefy_catalog';
  if (sourceText.includes('hybrid')) return 'hybrid';
  return fallback || 'unknown';
}

function withSourceMetadata(item = {}, fallback = '') {
  const source = productSourceType(item, fallback);
  const amazonResult = source === 'web' && /amazon|amzn\.in|serpapi/i.test([
    item.source,
    item.searchSource,
    item.sourceUrl,
    item.affiliateLink
  ].filter(Boolean).join(' '));
  const externalTryOnAvailable = source === 'web'
    && !item.searchLink
    && /^https:\/\//i.test(String(item.sourceUrl || item.affiliateLink || '').trim())
    && /^https:\/\//i.test(String(item.imageUrl || item.remoteImageUrl || item.thumbnail || item.image?.url || item.image?.remoteUrl || '').trim())
    && wearableCompatibility(item).compatible;
  return {
    ...item,
    source,
    sourceLabel: amazonResult ? 'Amazon result' : sourceLabel(source),
    tryOnAvailable: source === 'web' ? externalTryOnAvailable : item.tryOnAvailable,
    aiTryOnAvailable: source === 'web' ? externalTryOnAvailable : item.aiTryOnAvailable
  };
}

function uniqueById(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const primaryKey = String(item?.id || item?._id || item?.sourceUrl || item?.affiliateLink || item?.name || JSON.stringify(item));
    const nameKey = normalize([item?.name, item?.brand].filter(Boolean).join('|'));
    const keys = [primaryKey, nameKey].filter(Boolean);
    if (!keys.length || keys.some((key) => seen.has(key))) return false;
    keys.forEach((key) => seen.add(key));
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
  const asksWeb = /\b(amazon|online|web|shopping|shop|retailer)\b/.test(lower);
  const asksCatalog = /\b(lookmefy|catalog|website|site)\b/.test(lower);
  const hasWardrobe = wardrobeItems.length || outfits.some((outfit) => productSourceType(outfit, outfit.source || 'wardrobe') === 'wardrobe');
  const hasWeb = productSources.includes('web');
  const hasCatalog = productSources.includes('lookmefy_catalog');

  let reply = '';
  if (!hasVisible) {
    reply = 'I do not have any visible product or wardrobe cards in this chat yet. Ask me to search products or check your wardrobe first.';
  } else if (asksWardrobe && products.some((product) => productSourceType(product) !== 'wardrobe')) {
    const sourceNames = productSources.map(sourceLabel).join(', ') || 'shopping results';
    reply = `No. Those visible product cards are ${sourceNames}, not items from your wardrobe. I can check your wardrobe separately for a similar look.`;
  } else if (asksWardrobe && hasWardrobe) {
    reply = 'Yes. The visible outfit cards are built from wardrobe items. Shopping cards, if shown inside the same look, are separate add-ons.';
  } else if (asksWeb) {
    reply = hasWeb
      ? 'Those are web shopping results. They are not saved wardrobe items unless you add them yourself.'
      : 'Those visible cards are not web results. I can run a fresh online search for shopping options.';
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
  return 'This request is incompatible with Lookmefy AI Stylist. I can help with Lookmefy, fashion, wardrobe, shopping/catalog searches, products, tokens, profile, wishlist, orders, and AI try-on.';
}

function styleQuestionActionTopic(message = '', filters = {}) {
  const pieces = [
    filters.color,
    filters.material,
    filters.style,
    filters.occasion,
    filters.category ? categoryLabel(filters.category) : ''
  ].filter(Boolean);
  if (pieces.length) return `${pieces.join(' ')} ideas`;
  const lower = normalize(message);
  const material = lower.match(/\b(linen|cotton|denim|satin|silk|wool|leather|mesh|knit)\b/)?.[1] || '';
  if (material) return `${material} outfit ideas`;
  if (/\bcapsule\s+wardrobe\b/.test(lower)) return 'capsule wardrobe essentials';
  return 'style ideas';
}

function generalStyleActions(message = '', filters = {}) {
  return sourceChoiceActions(styleQuestionActionTopic(message, filters));
}

function generalStyleQuestionReply(message = '', filters = {}) {
  const lower = normalize(message);
  const materials = ['linen', 'cotton', 'denim', 'satin', 'silk', 'wool', 'leather', 'mesh', 'knit'].filter((term) => textHasTerm(lower, term));
  const materialAdvice = {
    linen: 'Linen is breathable and relaxed, so it works well for summer, beach, resort, and daytime outfits. It wrinkles naturally, so keep the rest of the look clean with simple sandals, minimal jewelry, or a structured bag.',
    cotton: 'Cotton is soft, breathable, and easy for daily wear. Use it for casual shirts, tees, kurtas, and relaxed dresses when comfort matters more than shine.',
    denim: 'Denim is casual and structured. Dress it up with a crisp shirt, blazer, loafers, or clean accessories; keep it relaxed with tees, sneakers, and soft layers.',
    satin: 'Satin looks polished because of its shine and drape. It is best for party, dinner, date-night, and dressier outfits, balanced with matte shoes or simple accessories.',
    silk: 'Silk feels dressy, fluid, and premium. It works beautifully for festive, wedding, dinner, and formal looks when paired with controlled accessories.',
    wool: 'Wool adds warmth and structure. It suits winter, office, and formal looks, especially in coats, trousers, knits, and blazers.',
    leather: 'Leather adds edge and structure. Use one leather piece as the anchor, then balance it with cotton, denim, knits, or softer colors.',
    mesh: 'Mesh feels bold and party-focused. Keep it intentional with a clean base layer and avoid too many other statement pieces.',
    knit: 'Knit fabric adds softness and texture. It works for cozy casual outfits, winter layers, cardigans, sweaters, and fitted tops.'
  };
  if (/\bdifference\s+between\b/.test(lower) && materials.length >= 2) {
    return `${titleCaseWords(materials[0])}: ${materialAdvice[materials[0]]} ${titleCaseWords(materials[1])}: ${materialAdvice[materials[1]]}`;
  }
  if (materials[0]) return materialAdvice[materials[0]];
  if (/\bcapsule\s+wardrobe\b/.test(lower)) {
    return 'A capsule wardrobe is a smaller set of versatile pieces that mix well together. Start with neutral tops, one good pair of jeans or trousers, a dress or occasion piece, clean shoes, and a jacket or layer that works across outfits.';
  }
  if (/\bdress\s*code|smart\s+casual|business\s+casual|formal|casual\b/.test(lower)) {
    if (/\bsmart\s+casual\b/.test(lower)) return 'Smart casual means polished but not stiff: clean jeans or trousers, a neat shirt/top, a blazer or refined layer, and clean sneakers, loafers, flats, or low heels.';
    if (/\bbusiness\s+casual\b/.test(lower)) return 'Business casual sits between formal office wear and casual clothes. Choose tailored trousers, shirts, blouses, knit tops, loafers, flats, or a simple blazer, and avoid loud party pieces.';
    if (/\bformal\b/.test(lower)) return 'Formal dressing should look structured and intentional. Use tailored fits, cleaner colors, polished shoes, minimal accessories, and fabrics that hold shape well.';
    return 'Casual dressing should still feel intentional. Pick one clean anchor piece, keep colors controlled, and use shoes or accessories to decide whether the look feels relaxed or polished.';
  }
  if (/\b(colou?r|match|pair|go(?:es)?\s+with|work\s+with)\b/.test(lower) || filters.color) {
    const palettes = {
      black: ['white', 'cream', 'grey', 'denim blue', 'silver or gold accessories'],
      white: ['black', 'tan', 'denim blue', 'navy', 'soft pastels'],
      blue: ['white', 'cream', 'grey', 'tan', 'brown'],
      navy: ['white', 'cream', 'grey', 'tan', 'burgundy'],
      green: ['cream', 'white', 'black', 'tan', 'gold'],
      red: ['black', 'white', 'cream', 'denim', 'gold'],
      pink: ['white', 'cream', 'grey', 'denim', 'brown'],
      brown: ['cream', 'white', 'blue', 'olive', 'gold'],
      beige: ['white', 'black', 'brown', 'olive', 'denim blue'],
      gold: ['black', 'cream', 'white', 'brown', 'deep green'],
      silver: ['black', 'white', 'grey', 'navy', 'cool blue']
    };
    const color = filters.color || inferColorFromText(lower) || 'neutral';
    const item = filters.category ? ` ${categoryLabel(filters.category)}` : '';
    const matches = palettes[color] || ['white', 'black', 'denim', 'cream', 'one matching accessory'];
    return `For ${color}${item}, good matches are ${matches.join(', ')}. Keep one main color, one supporting neutral, and one small accent so the outfit does not feel random.`;
  }
  if (/\b(can\s+i|should\s+i|does\b.*\b(?:work|match|go\s+with))\b/.test(lower)) {
    return 'Yes, it can work if the occasion and proportions feel balanced. Repeat one color from the outfit, keep either the top or bottom simple, and let shoes or accessories decide whether it feels casual, polished, or party-ready.';
  }
  if (filters.occasion) {
    return `For ${filters.occasion}, start with comfort, fabric, and movement first, then choose one polished detail so it feels styled. I can also turn this into wardrobe, Lookmefy catalog, or online options.`;
  }
  if (filters.category) {
    return `For a ${categoryLabel(filters.category)}, decide the occasion first, then check fit, fabric, and color. A good outfit usually has one anchor item, one balancing piece, and one accessory or shoe choice that finishes the look.`;
  }
  return 'A good styling rule is: choose one anchor piece, repeat one color somewhere else, and balance the fit. If one piece is loose, keep another piece cleaner or more structured.';
}

function generalQuestionFallbackReply(message = '') {
  if (/\b(joke|funny)\b/i.test(message)) {
    return 'Why did the developer wear a jacket? Because the code had too many drafts.';
  }
  if (isWeatherQuestion(message)) {
    return 'Tell me the city or place and I can check the weather.';
  }
  if (/\b(news|stock|crypto|score|latest|current events?)\b/i.test(message)) {
    return 'I can help explain the topic, but I need live data to answer the very latest numbers or news accurately.';
  }
  return 'I can answer that. Give me the exact question and I will keep the reply clear and useful.';
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
  if (category === 'accessories') return categoryAliasMatch(itemCategory, category) || isAccessoryText(haystack);
  if (category === 'ethnic') return ['ethnic', 'ethnic wear'].includes(itemCategory) || /\b(ethnic|kurta|kurti|saree|sari|lehenga|salwar|anarkali|churidar|sharara|dupatta|traditional indian)\b/.test(haystack);
  if (category === 'dresses') return itemCategory === 'dresses' || /\b(dress|gown|frock)\b/.test(haystack);
  if (category === 'costumes') return categoryAliasMatch(itemCategory, category) || /\b(halloween|costume|cosplay|fancy dress)\b/.test(haystack);
  if (category === 'innerwear') return /\b(underwear|innerwear|lingerie|bra|bralette|panty|panties|brief|boxer|camisole|shapewear)\b/.test(haystack);
  if (category === 'swimwear') return itemCategory === 'swimwear' || /\b(bikini|swimsuit|swimwear|monokini|tankini|swim\s+trunks?|board\s+shorts?|rash\s+guards?|cover\s*-?up|coverup|kaftan|sarong)\b/.test(haystack);
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
    .filter((item) => !filters.productType || productMatchesSpecificLabel(item, filters.productType))
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
  const accessoryType = (!category || category === 'accessories') ? accessoryTypeFromText(lower) : '';
  const rules = [
    ['kurti', /\bkurtis?\b/, ['ethnic']],
    ['kurta', /\bkurtas?\b/, ['ethnic']],
    ['saree', /\b(sarees?|saris?)\b/, ['ethnic']],
    ['lehenga', /\blehengas?\b/, ['ethnic']],
    ['salwar suit', /\b(salwars?|anarkali|churidar|sharara)\b/, ['ethnic']],
    ['sneakers', /\bsneakers?\b/, ['shoes']],
    ['loafers', /\bloafers?\b/, ['shoes']],
    ['heels', /\bheels?\b/, ['shoes']],
    ['sandals', /\bsandals?\b/, ['shoes']],
    ['boots', /\bboots?\b/, ['shoes']],
    ['shoes', /\b(shoes?|footwear)\b/, ['shoes']],
    ['gown', /\bgowns?\b/, ['dresses']],
    ['frock', /\bfrocks?\b/, ['dresses']],
    ['dress', /\bdress(?:es)?\b/, ['dresses']],
    ['t-shirt', /\b(t-?shirts?|tees?)\b/, ['tops']],
    ['blouse', /\bblouses?\b/, ['tops']],
    ['hoodie', /\bhoodies?\b/, ['tops']],
    ['top', /\b(?:crop\s+tops?|tank\s+tops?|tops?)\b/, ['tops']],
    ['shirt', /\bshirts?\b/, ['tops']],
    ['jeans', /\b(jeans?|denims?)\b/, ['bottoms']],
    ['trousers', /\btrousers?\b/, ['bottoms']],
    ['pants', /\bpants?\b/, ['bottoms']],
    ['shorts', /\bshorts?\b/, ['bottoms']],
    ['skirt', /\bskirts?\b/, ['bottoms']],
    ['joggers', /\bjoggers?\b/, ['bottoms']],
    ['leggings', /\bleggings?\b/, ['bottoms']],
    ['jacket', /\bjackets?\b/, ['outerwear']],
    ['blazer', /\bblazers?\b/, ['outerwear']],
    ['coat', /\bcoats?\b/, ['outerwear']],
    ['cardigan', /\bcardigans?\b/, ['outerwear']],
    ['bikini swimwear', /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|swim\s+trunks?|board\s+shorts?|rash\s+guards?)\b/, ['swimwear']],
    ['bra innerwear', /\b(bras?|bralettes?|lingerie|underwear|innerwear)\b/, ['innerwear']],
    ['halloween costume', /\b(halloween\s+costumes?|costumes?|cosplay|fancy\s*dress)\b/, ['costumes']]
  ];
  const match = rules.find(([, pattern, categories]) => pattern.test(lower) && (!category || categories.includes(category)));
  return match?.[0] || accessoryType;
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

function eventSearchTermsFor(eventProfile = null, gender = '') {
  const normalizedGender = gender === 'male' || gender === 'female' ? gender : 'other';
  const tailored = eventProfile?.searchTermsByGender?.[normalizedGender];
  return Array.isArray(tailored) && tailored.length ? tailored : eventProfile?.searchTerms || [];
}

function buildProductSearchQuery({ message = '', filters = {}, bestCombo = null, eventProfile = null }) {
  const targets = productSearchTargets({ filters, bestCombo, eventProfile });
  const genderTerm = filters.gender === 'male' ? 'men' : filters.gender === 'female' ? 'women' : '';
  const celebrityStyle = detectCelebrityStyleRequest(message);
  if (celebrityStyle && !filters.category && !eventProfile) {
    const lower = normalize(message);
    const vibe = lower.match(/\b(airport|casual|party|glam|ethnic|festive|red carpet|formal|classy)\b/g)?.join(' ') || 'fashion';
    return [genderTerm, vibe, 'outfit dress top trousers shoes'].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  const specificLabel = specificProductLabel(message, filters);
  // Once the user names an exact garment, broad category synonyms dilute the
  // retailer query (for example, "jeans pants trousers"). Use category labels
  // only when there is no more specific product type to preserve.
  const targetLabel = specificLabel ? '' : targets.slice(0, filters.category ? 2 : 0).map(categorySearchLabel).join(' ');
  // Keep the primary query focused. The web-search adapter fans broad
  // occasion requests out into separate capsule queries instead of combining
  // unrelated garments into one low-quality query.
  const eventTerms = eventSearchTermsFor(eventProfile, filters.gender);
  const eventSearchTerms = !filters.category && eventTerms.length ? eventTerms[0] : '';
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
  if (/\b(bikini|swimsuit|swimwear|monokini|tankini|swim\s+trunks?|board\s+shorts?|rash\s+guards?|beach\s*cover\s*-?up|coverup|kaftan|sarong)\b/.test(lower)) return 'swimwear';
  if (/\b(lingerie|underwear|innerwear|bra|bralette|panty|panties)\b/.test(lower)) return 'innerwear';
  if (/\b(dress|gown|frock)\b/.test(lower)) return 'dresses';
  if (/\b(kurta|kurti|saree|sari|lehenga|salwar|anarkali|churidar|sharara|dupatta|ethnic|traditional indian)\b/.test(lower)) return 'ethnic';
  if (/\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?)\b/.test(lower)) return 'shoes';
  if (/\b(pants?|trousers?|jeans?|shorts?|skirts?|joggers?|leggings?)\b/.test(lower)) return 'bottoms';
  if (/\b(jackets?|blazers?|coats?|cardigans?)\b/.test(lower)) return 'outerwear';
  if (isAccessoryText(lower)) return 'accessories';
  if (/\b(shirts?|t-?shirts?|tops?|blouses?|hoodies?|tees?)\b/.test(lower)) return 'tops';
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

function productIdentitySearchText(product = {}) {
  return normalize([
    product.name,
    product.title,
    product.category,
    product.subcategory,
    product.type,
    product.color,
    ...(Array.isArray(product.colors) ? product.colors : [])
  ].filter(Boolean).join(' '));
}

function productHasRequestedTerm(product = {}, term = '') {
  if (!term) return true;
  return textHasTerm(productSearchText(product), term);
}

function productHasRequestedColor(product = {}, color = '') {
  if (!color) return true;
  const canonicalColor = (value = '') => normalize(value) === 'gray' ? 'grey' : normalize(value);
  const requestedColor = canonicalColor(color);
  const nameText = normalize([product.name, product.title].filter(Boolean).join(' '));
  const namedColors = [
    'black', 'white', 'cream', 'beige', 'blue', 'navy', 'green', 'red', 'pink',
    'brown', 'grey', 'gray', 'gold', 'silver', 'maroon', 'purple', 'lavender',
    'yellow', 'orange'
  ].filter((candidate) => textHasTerm(nameText, candidate)).map(canonicalColor);

  // A color in the canonical title identifies the pictured product and wins
  // over stale tags or multi-variant metadata. Many catalog titles omit the
  // selected color entirely, however, so in that case use the structured
  // `colors` field populated by the catalog importer when the listing
  // description independently confirms that variant.
  if (namedColors.length) return namedColors.includes(requestedColor);
  const hasStructuredColor = (Array.isArray(product.colors) ? product.colors : [])
    .map(canonicalColor)
    .includes(requestedColor);
  return hasStructuredColor && textHasTerm(normalize(product.description), color);
}

function productPriceWithinBudget(product = {}, filters = {}) {
  if (!filters.budget) return true;
  const price = readPrice(product.price);
  return price !== null && price <= filters.budget;
}

function productMatchesRequestedCategory(product = {}, category = '') {
  if (!category) return true;
  const itemCategory = normalize(product.category);
  const identityText = productIdentitySearchText(product);
  if (categoryAliasMatch(itemCategory, category)) return true;
  if (category === 'tops') return /\b(shirts?|t-?shirts?|tees?|tops?|blouses?|hoodies?|sweatshirts?)\b/.test(identityText);
  if (category === 'bottoms') return /\b(pants?|trousers?|jeans?|denims?|shorts?|skirts?|joggers?|leggings?)\b/.test(identityText);
  if (category === 'outerwear') return /\b(jackets?|blazers?|coats?|cardigans?|shrugs?)\b/.test(identityText);
  if (category === 'accessories') return isAccessoryText(identityText);
  if (category === 'ethnic') return /\b(ethnic|kurtas?|kurtis?|sarees?|saris?|lehengas?|salwars?|anarkali|churidar|sharara|dupattas?)\b/.test(identityText);
  if (category === 'dresses') return /\b(dress(?:es)?|gowns?|frocks?)\b/.test(identityText);
  if (category === 'costumes') return /\b(halloween|costumes?|cosplay|fancy\s+dress)\b/.test(identityText);
  if (category === 'innerwear') return /\b(underwear|innerwear|lingerie|bras?|bralettes?|panty|panties|briefs?|boxers?|camisoles?|shapewear)\b/.test(identityText);
  if (category === 'swimwear') return /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|swim\s+trunks?|board\s+shorts?|rash\s+guards?|cover\s*-?ups?|coverups?|kaftans?|sarongs?)\b/.test(identityText);
  if (category === 'shoes') return /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/.test(identityText);
  return textHasTerm(identityText, category);
}

function primaryProductType(textValue = '') {
  const rules = [
    ['kurti', /\bkurtis?\b/],
    ['kurta', /\bkurtas?\b/],
    ['saree', /\b(sarees?|saris?)\b/],
    ['lehenga', /\blehengas?\b/],
    ['salwar suit', /\b(salwars?|anarkali|churidar|sharara)\b/],
    ['t-shirt', /\b(t-?shirts?|tees?)\b/],
    ['blouse', /\bblouses?\b/],
    ['hoodie', /\bhoodies?\b/],
    ['top', /\b(crop\s+tops?|tank\s+tops?|tops?)\b/],
    ['shirt', /\bshirts?\b/],
    ['jeans', /\b(jeans?|denims?)\b/],
    ['trousers', /\btrousers?\b/],
    ['pants', /\b(pants?|palazzos?)\b/],
    ['shorts', /\bshorts?\b/],
    ['skirt', /\bskirts?\b/],
    ['joggers', /\bjoggers?\b/],
    ['leggings', /\bleggings?\b/],
    ['jacket', /\bjackets?\b/],
    ['blazer', /\bblazers?\b/],
    ['coat', /\bcoats?\b/],
    ['cardigan', /\bcardigans?\b/],
    ['sneakers', /\bsneakers?\b/],
    ['loafers', /\bloafers?\b/],
    ['heels', /\bheels?\b/],
    ['sandals', /\bsandals?\b/],
    ['boots', /\bboots?\b/],
    ['shoes', /\b(shoes?|footwear)\b/],
    ['gown', /\bgowns?\b/],
    ['frock', /\bfrocks?\b/],
    ['dress', /\bdress(?:es)?\b/],
    ...accessoryProductRules,
    ['bikini swimwear', /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|swim\s+trunks?|board\s+shorts?|rash\s+guards?)\b/],
    ['bra innerwear', /\b(bras?|bralettes?|lingerie|underwear|innerwear)\b/],
    ['halloween costume', /\b(halloween|costumes?|cosplay|fancy dress)\b/]
  ];
  return rules
    .map(([label, pattern], order) => ({ label, order, index: textValue.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((a, b) => a.index - b.index || a.order - b.order)[0]?.label || '';
}

function productMatchesSpecificLabel(product = {}, specificLabel = '') {
  if (!specificLabel) return true;
  // Names/titles are the only trustworthy identity evidence shared by local,
  // remote-catalog, and marketplace records. Category/type metadata may be
  // inferred or stale, so it cannot establish a requested garment by itself.
  const textValue = normalize([product.name, product.title].filter(Boolean).join(' '));
  const primaryType = primaryProductType(textValue);
  const compatibleFamilies = {
    shoes: ['shoes', 'sneakers', 'loafers', 'heels', 'sandals', 'boots'],
    bag: ['bag', 'wallet'],
    cap: ['cap', 'hat'],
    hat: ['hat', 'cap'],
    sunglasses: ['sunglasses', 'eyeglasses'],
    eyeglasses: ['eyeglasses', 'sunglasses'],
    jewellery: ['jewellery', 'earrings', 'necklace', 'bracelet', 'ring'],
    'bikini swimwear': ['bikini swimwear'],
    'bra innerwear': ['bra innerwear'],
    'halloween costume': ['halloween costume']
  };
  if (primaryType && !((compatibleFamilies[specificLabel] || [specificLabel]).includes(primaryType))) return false;
  const checks = {
    kurti: /\bkurtis?\b/,
    kurta: /\bkurtas?\b/,
    saree: /\b(sarees?|saris?)\b/,
    lehenga: /\blehengas?\b/,
    'salwar suit': /\b(salwars?|anarkali|churidar|sharara)\b/,
    sneakers: /\bsneakers?\b/,
    loafers: /\bloafers?\b/,
    heels: /\bheels?\b/,
    sandals: /\bsandals?\b/,
    boots: /\bboots?\b/,
    shoes: /\b(shoes?|sneakers?|loafers?|heels?|sandals?|boots?|footwear)\b/,
    gown: /\bgowns?\b/,
    frock: /\bfrocks?\b/,
    dress: /\bdress(?:es)?\b/,
    't-shirt': /\b(t-?shirts?|tees?)\b/,
    blouse: /\bblouses?\b/,
    hoodie: /\bhoodies?\b/,
    top: /\b(?:crop\s+tops?|tank\s+tops?|tops?)\b/,
    shirt: /\bshirts?\b/,
    jeans: /\bjeans?\b/,
    trousers: /\btrousers?\b/,
    pants: /\bpants?\b/,
    shorts: /\bshorts?\b/,
    skirt: /\bskirts?\b/,
    joggers: /\bjoggers?\b/,
    leggings: /\bleggings?\b/,
    jacket: /\bjackets?\b/,
    blazer: /\bblazers?\b/,
    coat: /\bcoats?\b/,
    cardigan: /\bcardigans?\b/,
    'bikini swimwear': /\b(bikinis?|swimsuits?|swimwear|monokinis?|tankinis?|swim\s+trunks?|board\s+shorts?|rash\s+guards?)\b/,
    'bra innerwear': /\b(bras?|bralettes?|lingerie|underwear|innerwear)\b/,
    'halloween costume': /\b(halloween|costumes?|cosplay|fancy dress)\b/
  };
  const matches = (accessoryPatternForType(specificLabel) || checks[specificLabel] || new RegExp(`\\b${escapeRegExp(specificLabel)}\\b`)).test(textValue);
  if (!matches) return false;
  const conflicts = {
    jeans: /\b(shirts?|button[-\s]?downs?|dress(?:es)?|gowns?|frocks?|shorts?|skirts?|jackets?|blazers?|coats?)\b/,
    trousers: /\b(jeans?|shorts?|skirts?|dress(?:es)?|shirts?)\b/,
    pants: /\b(jeans?|shorts?|skirts?|dress(?:es)?|shirts?)\b/,
    shorts: /\b(jeans?|trousers?|pants?|skirts?|dress(?:es)?|shirts?)\b/,
    skirt: /\b(jeans?|trousers?|pants?|shorts?|dress(?:es)?|shirts?)\b/
  };
  if (conflicts[specificLabel]?.test(textValue)) return false;
  if (specificLabel === 'shirt' && /\b(?:t-?shirts?|tees?|blouses?|hoodies?|crop\s+tops?|tank\s+tops?)\b/.test(textValue)) return false;
  return true;
}

function productMatchesEventProfile(product = {}, eventProfile = null, filters = {}) {
  if (!eventProfile) return true;
  const categories = Array.isArray(eventProfile.searchCategories) ? eventProfile.searchCategories : [];
  if (!filters.category && categories.length && !categories.some((category) => productMatchesRequestedCategory(product, category))) return false;
  const identityText = productIdentitySearchText(product);
  const excludedTerms = Array.isArray(eventProfile.excludedTerms) ? eventProfile.excludedTerms : [];
  if (excludedTerms.some((term) => textHasTerm(identityText, term))) return false;
  const signals = Array.isArray(eventProfile.signals) ? eventProfile.signals : [];
  if (!signals.length || !eventProfile.requireSignal) return true;
  const textValue = productSearchText(product);
  return signals.some((signal) => textHasTerm(textValue, signal));
}

function catalogPlaceholderRecord(product = {}) {
  const textValue = normalize([
    product.name,
    product.title,
    product.brand,
    product.sourceUrl,
    product.affiliateLink,
    ...(Array.isArray(product.tags) ? product.tags : [])
  ].filter(Boolean).join(' '));
  return /\b(load\s+test\s+product|fitlook\s+load|load-test-shirt|example\.com\/load-test)\b/.test(textValue);
}

function productHasDisallowedDefaultUse(product = {}, filters = {}, specificLabel = '') {
  const identityText = productIdentitySearchText(product);
  const requestedIntimate = filters.category === 'innerwear' || ['bra innerwear'].includes(specificLabel);
  const requestedSwim = filters.category === 'swimwear' || specificLabel === 'bikini swimwear';
  if (!requestedIntimate && !requestedSwim && /\b(underwear|innerwear|lingerie|bras?|bralettes?|panty|panties|briefs?|boxers?|camisoles?|shapewear|babydoll|negligee)\b/.test(identityText)) {
    return true;
  }
  if (!/\b(sleepwear|nightwear|night\s*(?:suit|dress|shirt|gown)|pajamas?|pyjamas?|loungewear|robe)\b/.test(String(filters.category || specificLabel))) {
    return /\b(sleepwear|nightwear|night\s*(?:suit|dress|shirt|gown)|pajamas?|pyjamas?|loungewear|robe)\b/.test(identityText);
  }
  return false;
}

function productSatisfiesHardFilters(product = {}, filters = {}, { specificLabel = '' } = {}) {
  if (product.searchLink) return true;
  const requestedProductType = specificLabel || filters.productType || '';
  if (productHasDisallowedDefaultUse(product, filters, requestedProductType)) return false;
  if (filters.category && !productMatchesRequestedCategory(product, filters.category)) return false;
  if (requestedProductType && !productMatchesSpecificLabel(product, requestedProductType)) return false;
  if (filters.color && !productHasRequestedColor(product, filters.color)) return false;
  if (filters.material && !productHasRequestedTerm(product, filters.material)) return false;
  if (filters.fit && !productHasRequestedTerm(product, filters.fit)) return false;
  if (!productPriceWithinBudget(product, filters)) return false;
  return true;
}

function scoreCatalogProduct(product = {}, filters = {}, query = '', eventProfile = null) {
  const textValue = productSearchText(product);
  const queryTokens = tokenize(query);
  let score = 0;
  if (filters.category && productMatchesRequestedCategory(product, filters.category)) score += 40;
  if (!filters.category && eventProfile?.searchCategories?.length) {
    const categoryIndex = eventProfile.searchCategories.findIndex((category) => productMatchesRequestedCategory(product, category));
    if (categoryIndex >= 0) score += Math.max(5, 24 - categoryIndex * 3);
  }
  if (!filters.category && eventProfile?.primaryCategories?.length) {
    const categoryIndex = eventProfile.primaryCategories.findIndex((category) => productMatchesRequestedCategory(product, category));
    if (categoryIndex >= 0) score += Math.max(8, 24 - categoryIndex * 4);
  }
  if (filters.color && productHasRequestedColor(product, filters.color)) score += 14;
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
  const hasFilters = Boolean(filters.category || filters.productType || filters.color || filters.material || filters.style || filters.occasion || filters.budget);
  const queryTokens = tokenize(query);
  return products
    .map((product, index) => ({ ...product, _index: index, score: scoreCatalogProduct(product, filters, query, eventProfile) }))
    .filter((product) => {
      if (catalogPlaceholderRecord(product)) return false;
      const genderPreference = genderPreferenceForQuery(query, filters.gender || '');
      if (!genderCompatibility(product, genderPreference).compatible) return false;
      if (!productSatisfiesHardFilters(product, filters, { specificLabel })) return false;
      if (!productMatchesEventProfile(product, eventProfile, filters)) return false;
      if (!requireMatch || isListAllProductsPrompt(query)) return true;
      return product.score > 0 || (!hasFilters && queryTokens.length > 0);
    })
    .sort((a, b) => b.score - a.score || a._index - b._index)
    .map(({ _index, score, ...product }) => ({ ...product, rankScore: score }))
    .slice(0, productResultLimit);
}

function catalogApiBaseUrl() {
  const raw = cleanText(
    process.env.LOOKMEFY_CATALOG_API_BASE_URL ||
    process.env.CATALOG_API_BASE_URL ||
    process.env.VITE_API_BASE_URL ||
    '',
    400
  ).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.localhost')) return '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

function catalogApiProductsUrl(baseUrl = '') {
  if (!baseUrl) return '';
  return `${baseUrl}${baseUrl.endsWith('/api') ? '/products' : '/api/products'}`;
}

function catalogGenderParam(gender = '') {
  if (gender === 'female') return 'women';
  if (gender === 'male') return 'men';
  return gender;
}

async function fetchRemoteCatalogBatch({ query = '', filters = {}, limit = 96 } = {}) {
  const baseUrl = catalogApiBaseUrl();
  if (!baseUrl) return [];
  const params = new URLSearchParams({ limit: String(Math.min(Math.max(Number(limit) || 48, 1), 96)) });
  if (query) params.set('q', query);
  if (filters.budget) params.set('maxPrice', String(filters.budget));

  const { response, text } = await safeFetchText(`${catalogApiProductsUrl(baseUrl)}?${params.toString()}`, {
    maxBytes: 3 * 1024 * 1024,
    timeoutMs: 4_000,
    headers: {
      accept: 'application/json',
      'user-agent': 'Lookmefy-AI-Stylist/1.0'
    }
  });
  if (!response.ok) throw new Error(`Catalog API returned HTTP ${response.status}`);
  const payload = JSON.parse(text);
  return Array.isArray(payload?.products) ? payload.products : [];
}

async function searchRemoteCatalogProducts({ query = '', filters = {}, eventProfile = null, specificLabel = '' } = {}) {
  const batches = [];
  try {
    if (query) batches.push(await fetchRemoteCatalogBatch({ query, filters, limit: 96 }));
    const firstCount = batches.flat().length;
    if (firstCount < productResultLimit) batches.push(await fetchRemoteCatalogBatch({ query: '', filters, limit: 96 }));
  } catch {
    return [];
  }
  const products = uniqueById(batches.flat()
    .map((product, index) => normalizeBackendProduct(product, index, 'lookmefy_catalog'))
    .filter((product) => product.name));
  return rankCatalogProducts(products, { query, filters, eventProfile, requireMatch: true, specificLabel });
}

function catalogFilter(extra = {}) {
  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const filter = { ...extra };
  delete filter.$and;
  return { ...filter, isActive: true, $nor: [temporaryExternalAmazonFilter()], $and: [availableStatusClause(), ...extraAnd] };
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
  let textMatchesPromise = null;
  if (query && !listAll) {
    textMatchesPromise = Product.find({ ...baseFilter, $text: { $search: query } }, { ...projection, score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' }, createdAt: -1 })
      .limit(80)
      .maxTimeMS(1800)
      .lean();
  }
  const broadMatchesPromise = Product.find(baseFilter, projection)
    .sort({ isFeatured: -1, isNewArrival: -1, createdAt: -1 })
    .limit(listAll ? 120 : 200)
    .maxTimeMS(2200)
    .lean();
  if (textMatchesPromise) {
    const [textMatches, broadMatches] = await Promise.allSettled([textMatchesPromise, broadMatchesPromise]);
    // Missing text indexes are recoverable, but the broad catalog query is
    // required and should still report a real database failure.
    if (textMatches.status === 'fulfilled') batches.push(textMatches.value);
    if (broadMatches.status === 'rejected') throw broadMatches.reason;
    batches.push(broadMatches.value);
  } else {
    batches.push(await broadMatchesPromise);
  }
  const products = uniqueById(batches.flat()
    .map((product, index) => normalizeBackendProduct(productToClient(product), index, 'lookmefy_catalog'))
    .filter((product) => product.name));
  const ranked = rankCatalogProducts(products, { query, filters, eventProfile, requireMatch: !listAll, specificLabel });
  if (ranked.length || listAll) return ranked;
  return searchRemoteCatalogProducts({ query, filters, eventProfile, specificLabel });
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

function isAmazonShoppingUrl(value = '') {
  const url = cleanUrl(value);
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'amzn.in'
      || hostname === 'a.co'
      || hostname === 'amazon.com'
      || hostname.startsWith('amazon.')
      || hostname.includes('.amazon.');
  } catch {
    return false;
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
  const match = text.match(/(?:₹|Rs\.?|INR)\s*([0-9,]+(?:\.\d+)?)/i) || text.match(/([0-9,]+(?:\.\d+)?)\s*(?:₹|Rs\.?|INR)/i);
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
  const cardStarts = [...html.matchAll(/<div\b[^>]*data-component-type=["']s-search-result["'][^>]*>/gi)]
    .map((match) => match.index);
  for (let cardIndex = 0; cardIndex < cardStarts.length; cardIndex += 1) {
    const start = cardStarts[cardIndex];
    const end = cardStarts[cardIndex + 1] ?? Math.min(html.length, start + 30_000);
    const region = html.slice(start, end);
    const productHref = [...region.matchAll(/\shref=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .find((href) => amazonProductUrl(href, baseUrl));
    const sourceUrl = amazonProductUrl(productHref, baseUrl);
    if (!sourceUrl || seen.has(sourceUrl)) continue;
    seen.add(sourceUrl);
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
      brand: 'Online retailer',
      category: inferCategoryFromText(title),
      color: inferColorFromText(title),
      price: amazonPrice(region),
      currency: amazonCurrency(baseUrl),
      tags: ['web-shopping', 'online-search'],
      imageUrl,
      source: 'web',
      sourceLabel: sourceLabel('web'),
      searchSource: 'web-html-search'
    });
  }
  return results;
}

function webSearchLinkProduct(query = '', filters = {}, reason = '') {
  const cleanQuery = cleanText(query || 'fashion products', 180);
  const url = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(cleanQuery)}`;
  return {
    id: `web-search:${Buffer.from(url).toString('base64url')}`,
    external: true,
    name: `Search the web: ${cleanQuery}`,
    title: `Search the web: ${cleanQuery}`,
    category: filters.category || 'fashion search',
    color: filters.color || '',
    price: null,
    brand: 'Online shopping',
    tags: ['web-shopping', 'search-link'],
    imageUrl: '',
    sourceUrl: url,
    affiliateLink: url,
    source: 'web',
    sourceLabel: sourceLabel('web'),
    searchSource: 'web-search-link',
    searchLink: true,
    searchFallbackReason: reason
  };
}

function structuredWebProduct(result = {}, index = 0) {
  const sourceUrl = cleanUrl(result.link);
  return normalizeBackendProduct({
    id: result.asin ? `web:${result.asin}` : `web:${index}:${Buffer.from(sourceUrl).toString('base64url')}`,
    external: true,
    sourceUrl,
    affiliateLink: withAmazonAssociateTag(sourceUrl),
    name: cleanText(result.name, 180),
    title: cleanText(result.name, 180),
    brand: cleanText(result.brand, 80) || 'Online retailer',
    description: cleanText(result.description, 500),
    price: result.price,
    compareAtPrice: result.compareAtPrice,
    currency: result.currency || 'INR',
    rating: result.rating,
    ratingCount: result.ratingCount,
    imageUrl: cleanUrl(result.remoteImageUrl),
    tags: ['web-shopping', 'structured-search'],
    source: 'web',
    sourceLabel: sourceLabel('web'),
    searchSource: 'structured-web-search'
  }, index, 'web');
}

function webProductHasRequiredData(product = {}, filters = {}) {
  if (product.searchLink) return true;
  if (!cleanText(product.name, 180) || !cleanUrl(product.sourceUrl || product.affiliateLink)) return false;
  if (!cleanUrl(product.imageUrl)) return false;
  if (filters.budget) {
    const price = readPrice(product.price);
    if (price === null || price <= 0 || price > filters.budget) return false;
  }
  return true;
}

function buildWebSearchQueries({ query = '', filters = {}, eventProfile = null, specificLabel = '' } = {}) {
  const fallbackQuery = genderedSearchQuery(query, filters.gender || '');
  const eventTerms = eventSearchTermsFor(eventProfile, filters.gender);
  if (specificLabel || filters.productType || filters.category || !eventTerms.length) return [fallbackQuery];
  const queryLimit = Math.floor(positiveNumber('AI_STUDIO_WEB_QUERY_LIMIT', 4, { min: 1, max: 4 }));
  const qualifiers = [
    filters.color,
    filters.material,
    filters.style,
    filters.budget ? `under ${filters.budget}` : ''
  ].filter(Boolean);
  return [...new Set(eventTerms
    .map((term) => genderedSearchQuery([...qualifiers, term].filter(Boolean).join(' '), filters.gender || ''))
    .filter(Boolean))]
    .slice(0, queryLimit);
}

function diversifyWebProducts(products = [], limit = webResultLimit) {
  const selected = [];
  const selectedIds = new Set();
  const seenGroups = new Set();
  const groupFor = (product) => normalize(product.category) || primaryProductType(normalize([product.name, product.title].join(' '))) || 'other';
  for (const product of products) {
    const group = groupFor(product);
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    selected.push(product);
    selectedIds.add(String(product.id));
    if (selected.length >= limit) return selected;
  }
  for (const product of products) {
    if (selectedIds.has(String(product.id))) continue;
    selected.push(product);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function searchWebProducts({ query = '', filters = {}, eventProfile = null, specificLabel = '', limit = webResultLimit } = {}) {
  const searchQueries = buildWebSearchQueries({ query, filters, eventProfile, specificLabel });
  const searchQuery = searchQueries[0] || genderedSearchQuery(query, filters.gender || '');
  const searchUrl = `${amazonSearchBaseUrl()}/s?k=${encodeURIComponent(searchQuery || query || 'fashion products')}`;
  const providerName = catalogSearchProviderName();
  const genderPreference = genderPreferenceForQuery(searchQuery, filters.gender || '');
  const normalizeAndRank = (candidates = []) => candidates
    .filter((product) => product.searchLink || isAmazonShoppingUrl(product.sourceUrl || product.affiliateLink))
    .filter((product) => webProductHasRequiredData(product, filters))
    .filter((product) => productSatisfiesHardFilters(product, filters, { specificLabel }))
    .filter((product) => productMatchesEventProfile(product, eventProfile, filters))
    .filter((product) => wearableCompatibility(product, { query }).compatible)
    .filter((product) => genderCompatibility(product, genderPreference).compatible)
    .map((product, index) => ({ ...product, _searchOrder: index, _searchScore: scoreCatalogProduct(product, filters, query, eventProfile) }))
    .sort((left, right) => right._searchScore - left._searchScore || left._searchOrder - right._searchOrder)
    .map(({ _searchOrder, _searchScore, ...product }) => product);
  const finishResults = (candidates = []) => {
    const ranked = normalizeAndRank(uniqueById(candidates));
    return !filters.category && eventProfile ? diversifyWebProducts(ranked, limit) : ranked.slice(0, limit);
  };

  let structuredError = '';
  if (providerName === 'serpapi') {
    try {
      const searchRequests = searchQueries.flatMap((candidateQuery) => (
        searchQueries.length === 1
          ? [1, 2].map((page) => ({ candidateQuery, page }))
          : [{ candidateQuery, page: 1 }]
      ));
      const batches = await Promise.allSettled(searchRequests.map(({ candidateQuery, page }) => (
        searchSerpApiAmazon(candidateQuery || 'fashion products', { page, timeoutMs: webSearchTimeoutMs })
      )));
      const results = batches.flatMap((batch) => batch.status === 'fulfilled' ? batch.value : []);
      const products = finishResults(results.map(structuredWebProduct));
      if (products.length) return { products, source: 'web', error: '' };
      const firstError = batches.find((batch) => batch.status === 'rejected');
      structuredError = cleanText(firstError?.reason?.message || 'The web search did not return complete matching product cards.', 220);
    } catch (error) {
      structuredError = cleanText(error.message || 'Structured web search failed.', 220);
    }
  }

  const directWebFallbackEnabled = envFlag('AI_STUDIO_DIRECT_WEB_FALLBACK_ENABLED', envFlag('AI_STUDIO_DIRECT_AMAZON_ENABLED', true));
  if (!directWebFallbackEnabled) {
    return { products: [webSearchLinkProduct(searchQuery || query, filters, structuredError || 'Direct retailer search is disabled.')], source: 'web-search-link', error: structuredError };
  }
  try {
    const { response, text, finalUrl } = await safeFetchText(searchUrl, {
      maxBytes: 5 * 1024 * 1024,
      timeoutMs: webSearchTimeoutMs,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!response.ok) throw new Error('The retailer search did not respond.');
    const products = finishResults(extractAmazonSearchResults(text, finalUrl || searchUrl)
      .map((product, index) => normalizeBackendProduct(product, index, 'web')));
    if (products.length) return { products, source: 'web', error: '' };
    throw new Error('The retailer page did not expose complete matching product cards.');
  } catch (error) {
    const reason = structuredError || cleanText(error.message || 'Web search failed.', 220);
    return { products: [webSearchLinkProduct(searchQuery || query, filters, reason)], source: 'web-search-link', error: reason };
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
    const online = await searchWebProducts({ query, filters: searchFilters, eventProfile, specificLabel });
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

  const online = await searchWebProducts({ query, filters: searchFilters, eventProfile, specificLabel });
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

async function loadContext(user, { scope = 'all' } = {}) {
  const profile = userProfile(user);
  const needsWardrobe = scope === 'all' || scope === 'wardrobe';
  const needsFullContext = scope === 'all';
  const [items, outfits, recentEvents] = await Promise.all([
    needsWardrobe ? ClosetItem.find({ user: user._id }).sort({ favorite: -1, updatedAt: -1 }).limit(80).lean() : [],
    needsFullContext ? ClosetOutfit.find({ user: user._id }).sort({ createdAt: -1 }).limit(10).lean() : [],
    needsFullContext ? UserEvent.find({ user: user._id }).sort({ createdAt: -1 }).limit(12).lean() : []
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
    || (/\bwardrobe|closet\b/.test(lower) && /\bonline|amazon|catalog|lookmefy\b/.test(lower))) return 'both';
  if (/\bcatalog\b|\blookmefy\s+(?:catalog|products?|shop|store)\b|\b(search|find|shop|buy)\b.*\blookmefy\b/.test(lower)) return 'catalog';
  if (/\b(check|wardrobe|closet|owned|mine|already have|have it)\b/.test(lower)) return 'wardrobe';
  if (/\b(search|online|shop|buy|amazon|web|internet)\b/.test(lower)) return 'online';
  return '';
}

function detectExplicitProductPath(message = '') {
  const lower = normalize(message);
  if (/\b(check|look|search|find)\b.*\b(wardrobe|closet)\b|\b(wardrobe|closet)\b.*\b(check|find|search)\b/.test(lower)) return 'wardrobe';
  if (/\b(search|find|shop|buy)\b.*\b(lookmefy|catalog|website|site)\b|\b(lookmefy\s+catalog|catalog)\b/.test(lower)) return 'catalog';
  if (/\b(search|find|shop|buy)\b.*\b(online|amazon|web|internet)\b|\bonline\b|\bamazon\b/.test(lower)) return 'online';
  return '';
}

function isGenericOnlineSearchPrompt(message = '') {
  return /^(?:search\s*(?:online|amazon)?|try\s*amazon\s*again|run\s*product\s*search|refresh\s*shopping\s*options)$/i.test(cleanText(message));
}

function isGenericSourceSelectionPrompt(message = '') {
  const value = cleanText(message).trim();
  return isGenericOnlineSearchPrompt(value)
    || /^(?:search|check|find|look\s+in)\s+(?:(?:my|your)\s+)?(?:wardrobe|closet|lookmefy\s+catalog|catalog)$/i.test(value);
}

function isBudgetOnlyPrompt(message = '') {
  const value = cleanText(message);
  if (!budgetPattern().test(value)) return false;
  return !value.replace(budgetPattern(), '').replace(/[,\s-]/g, '').trim();
}

function lastSearchableMessage(conversation = {}) {
  if (conversation.currentOutfit?.lastMessage && !isGenericSourceSelectionPrompt(conversation.currentOutfit.lastMessage)) return conversation.currentOutfit.lastMessage;
  return [...(conversation.turns || [])].reverse().find((turn) => turn.role === 'user' && !isGenericSourceSelectionPrompt(turn.text))?.text || '';
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

function freshSourceChoiceIntent(message = '', filters = {}, intent = '') {
  if (intent === 'outfit_revision') return intent;
  if (isOutfitChoiceRequest(message, filters, intent)) return 'outfit_source_choice';
  if (intent === 'fashion_search') return 'product_search';
  if (isBareProductSearchPrompt(message, filters)) return 'product_search';
  if (isDirectProductSearchRequest(message, filters, intent)) return 'product_search';
  return intent;
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
    { type: 'check_wardrobe', label: 'Search wardrobe', prompt: `Search wardrobe for ${topic}` },
    { type: 'search_catalog', label: 'Search Lookmefy catalog', prompt: `Search Lookmefy catalog for ${topic}` },
    { type: 'search_online', label: 'Search online', prompt: `Search online for ${topic}` }
  ];
}

function productRequestTopic(message = '') {
  return cleanText(message, 140)
    .replace(/^(?:search|check|find|look\s+in)\s+(?:(?:my|your)\s+)?(?:wardrobe|closet)\s*(?:for\s+)?/i, '')
    .trim() || 'this item';
}

function wardrobeFallbackActions(message = '') {
  const topic = productRequestTopic(message);
  return [
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
  } else if (intent === 'general_style_question') {
    mode = 'style_answer';
    reply = generalStyleQuestionReply(message, filters);
    actions = generalStyleActions(message, filters);
  } else if (intent === 'general_question') {
    mode = 'general_chat';
    reply = generalQuestionFallbackReply(message);
    actions = [];
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
    reply = 'Where should I look first: your wardrobe, the Lookmefy catalog, or online?';
    actions = sourceChoiceActions(message);
  } else if (intent === 'product_search') {
    mode = 'product_choice';
    pendingProductChoice = { kind: 'product', message, filters, createdAt: Date.now() };
    reply = 'Where should I look first: your wardrobe, the Lookmefy catalog, or online?';
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
      reply = 'Your wardrobe does not have matching items for this look.';
      actions = wardrobeFallbackActions(message);
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
      const label = specificProductLabel(message, filters) || (filters.category ? categoryLabel(filters.category) : 'that item');
      reply = `Your wardrobe does not have a matching ${label}.`;
      actions = wardrobeFallbackActions(message);
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
    'You are Lookmefy AI Studio, the in-app assistant for general chat plus fashion, wardrobe, shopping, styling, try-on, and Lookmefy support.',
    'Answer normal casual questions and general knowledge questions in a clear ChatGPT-like way.',
    'For live/current topics such as weather, news, prices, sports scores, stocks, or crypto, be accurate about whether live data was supplied. If no live data is supplied, say you do not have live data instead of guessing.',
    'Answer general fashion, styling, color, material, fit, dress-code, and wardrobe questions directly when the user asks for advice or explanation instead of product results.',
    'Only run product-search behavior when the user asks to search, shop, buy, find products, or chooses wardrobe/catalog/online source options.',
    'For non-fashion shopping/product requests, say the product search is incompatible with Lookmefy fashion search instead of showing cards.',
    'Decide intent, mode, reply, and dry-run actions using only the supplied wardrobe, product candidates, conversation, and knowledge snippets.',
    'Use visibleMemory to answer source questions. If visible products came from the web or the Lookmefy catalog, never call them wardrobe items.',
    'Use source labels honestly: web finds are shopping cards, Lookmefy catalog results are app product cards, wardrobe items are owned/saved clothing.',
    'Prioritize wardrobe-first outfit recommendations only when wardrobeFit is strong. Use hybrid mode when wardrobeFit is partial. Use product_search when wardrobeFit is weak or the user clearly asks to buy/find/shop.',
    'For celebrity-inspired prompts, do not claim exact celebrity facts or exact wardrobe knowledge. Translate the name into a general style direction.',
    'Respect replyLanguage. Use natural Roman Hinglish for hinglish, simple Hindi wording for hindi, and English for english.',
    'Never claim that an actual try-on was generated. For try-on requests, plan the try-on action only.',
    'Never attach product cards to general_chat answers. Do not invent product cards, wardrobe items, prices, sources, or app capabilities. Select candidates by id only.',
    'Treat extractedFilters as immutable user requirements. Never weaken, replace, or contradict an explicit product type, category, color, gender, material, fit, occasion, or budget.',
    'Every selected product must concretely fulfill the latest request. Do not treat every item in a broad clothing category as suitable for the requested occasion.',
    'For a general beach request, prioritize a varied capsule of swimwear, bikinis or swimsuits, beach cover-ups, breathable beach separates, sandals, sunglasses, and sun hats. Regular underwear is not swimwear unless the user explicitly requests innerwear.',
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
    serverDateTime: {
      iso: new Date().toISOString(),
      timeZone: defaultAiStudioTimeZone()
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

const allowedActionTypes = new Set([
  'message',
  'check_wardrobe',
  'search_catalog',
  'search_online',
  'search_products',
  'plan_try_on',
  'style_option',
  'support_answer',
  'save_look',
  'wishlist_product',
  'buy_product'
]);

const allowedPlanModes = new Set([
  'chat_control',
  'safety_guard',
  'context_answer',
  'general_chat',
  'source_choice',
  'product_choice',
  'wardrobe_check',
  'rag_help',
  'product_search',
  'outfit_revision',
  'try_on_plan',
  'wardrobe_first',
  'hybrid_wardrobe_shopping',
  'style_advice',
  'style_answer'
]);

const allowedPlanIntents = new Set([
  'greeting', 'small_talk', 'language_preference', 'abuse_guard', 'out_of_scope',
  'general_question', 'general_style_question', 'lookmefy_help', 'token_help',
  'tryon_help', 'try_on_request', 'fashion_search', 'product_search',
  'product_search_confirmed', 'visible_source_question', 'wardrobe_help',
  'wardrobe_product_check', 'wardrobe_outfit_check', 'outfit_source_choice',
  'both_product_sources', 'both_outfit_sources', 'outfit_revision',
  'outfit_recommendation', 'style_advice'
]);

function sanitizeActionList(actions = []) {
  return actions
    .map((action) => {
      if (typeof action === 'string') return { type: 'message', label: cleanText(action, 80), prompt: cleanText(action, 180) };
      if (!action || typeof action !== 'object') return null;
      const type = cleanText(action.type || 'message', 40).toLowerCase();
      if (!allowedActionTypes.has(type)) return null;
      const payload = type === 'plan_try_on' && action.payload && typeof action.payload === 'object'
        ? {
            outfitId: cleanText(action.payload.outfitId || '', 120),
            productId: cleanText(action.payload.productId || '', 120)
          }
        : undefined;
      return {
        type,
        label: cleanText(action.label || type || 'Action', 80),
        prompt: cleanText(action.prompt || '', 180),
        disabled: Boolean(action.disabled),
        disabledReason: cleanText(action.disabledReason || '', 160),
        payload
      };
    })
    .filter((action) => action?.label)
    .slice(0, 4);
}

function sanitizeActions(actions = [], fallback = []) {
  const requested = Array.isArray(actions) && actions.length ? sanitizeActionList(actions) : [];
  return requested.length ? requested : sanitizeActionList(Array.isArray(fallback) ? fallback : []);
}

function sanitizeFalFilters(filters = {}) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return {};
  const result = {};
  for (const key of ['category', 'productType', 'gender', 'color', 'occasion', 'style', 'fit', 'material', 'brand']) {
    if (typeof filters[key] === 'string') result[key] = cleanText(filters[key], 80).toLowerCase();
  }
  const budget = Number(filters.budget);
  if (Number.isFinite(budget) && budget > 0) result.budget = Math.round(budget);
  return result;
}

function selectCandidatesById(candidates = [], ids = []) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const candidatesById = new Map(candidates.map((candidate) => [String(candidate?.id), candidate]));
  const seen = new Set();
  return ids.flatMap((id) => {
    const key = String(id);
    if (seen.has(key) || !candidatesById.has(key)) return [];
    seen.add(key);
    return [candidatesById.get(key)];
  });
}

function mergeFalPlan({ falPlan, localPlan: fallbackPlan, candidateOutfits, candidateProducts, requestFilters = {}, eventProfile = null, specificLabel = '' }) {
  const safeCandidateProducts = (candidateProducts || [])
    .filter((product) => productSatisfiesHardFilters(product, requestFilters, { specificLabel }))
    .filter((product) => productMatchesEventProfile(product, eventProfile, requestFilters));
  const safeProductIds = new Set(safeCandidateProducts.map((product) => String(product?.id)));
  const sanitizeOutfit = (outfit) => ({
    ...outfit,
    products: (outfit?.products || []).filter((product) => safeProductIds.has(String(product?.id)))
  });
  const selectedOutfits = selectCandidatesById(candidateOutfits || [], falPlan?.selectedOutfitIds).map(sanitizeOutfit);
  const selectedProducts = selectCandidatesById(safeCandidateProducts, falPlan?.selectedProductIds);
  if (fallbackPlan.intent === 'general_question' || fallbackPlan.mode === 'general_chat') {
    return {
      ...fallbackPlan,
      intent: 'general_question',
      mode: 'general_chat',
      reply: cleanText(falPlan?.reply || '', 800) || fallbackPlan.reply,
      outfits: [],
      products: [],
      actions: [],
      brain: 'fal',
      model: String(process.env.FAL_AI_STUDIO_MODEL || process.env.FAL_CLOSET_VISION_MODEL || 'google/gemini-2.5-flash-lite')
    };
  }
  const localProductOnly = Boolean(fallbackPlan.mode === 'product_search'
    && (fallbackPlan.wardrobeWeak || fallbackPlan.intent === 'product_search_confirmed'));
  const requestedMode = cleanText(falPlan?.mode || '', 60);
  let mode = allowedPlanModes.has(requestedMode) ? requestedMode : fallbackPlan.mode;
  if (localProductOnly) mode = 'product_search';
  if (fallbackPlan.wardrobeWeak && mode === 'wardrobe_first') mode = fallbackPlan.mode;
  const allowsOutfits = !localProductOnly && ['outfit_revision', 'try_on_plan', 'wardrobe_first', 'hybrid_wardrobe_shopping'].includes(mode);
  const needsProducts = localProductOnly || fallbackPlan.wardrobeWeak || mode === 'product_search' || mode === 'hybrid_wardrobe_shopping';
  const mergedFilters = { ...sanitizeFalFilters(falPlan?.filters), ...requestFilters };
  const requestedCategoryProducts = selectedProducts.length
    ? selectedProducts
    : safeCandidateProducts.filter((product) => categoryMatchesFilter(product, mergedFilters));
  const mergedOutfits = allowsOutfits
    ? (selectedOutfits.length ? selectedOutfits : (fallbackPlan.outfits || []).map(sanitizeOutfit)).filter((outfit) => outfitMatchesRequestedCategory(outfit, mergedFilters))
    : [];
  const visibleOutfits = standaloneCategory(mergedFilters.category)
    ? mergedOutfits.filter((outfit) => outfitHasWardrobeCategory(outfit, mergedFilters))
    : mergedOutfits;
  const categoryRequestedButMissing = Boolean(mergedFilters.category && allowsOutfits && !mergedOutfits.length);
  const finalMode = localProductOnly || categoryRequestedButMissing ? 'product_search' : mode;
  const finalOutfits = localProductOnly ? [] : visibleOutfits;
  const finalProducts = localProductOnly
    ? (selectedProducts.length ? selectedProducts : safeCandidateProducts)
    : selectedProducts.length
      ? selectedProducts
      : needsProducts || categoryRequestedButMissing
        ? requestedCategoryProducts
        : [];
  const catalogSearchWithoutMatches = localProductOnly
    && !safeCandidateProducts.length
    && /catalog/.test(String(fallbackPlan.productSearchSource || ''));
  if (catalogSearchWithoutMatches) {
    const query = fallbackPlan.productSearchQuery || '';
    return {
      ...fallbackPlan,
      mode: 'product_search',
      filters: mergedFilters,
      reply: productSearchEmptyReply({ source: 'catalog-empty', query }, query),
      outfits: [],
      products: [],
      actions: sanitizeActions([], [{ type: 'search_online', label: 'Search online instead', prompt: `Search online for ${query}` }]),
      brain: 'local',
      model: ''
    };
  }
  const requestedIntent = cleanText(falPlan?.intent || '', 80);
  return {
    ...fallbackPlan,
    intent: localProductOnly || !allowedPlanIntents.has(requestedIntent) ? fallbackPlan.intent : requestedIntent,
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
  // Repeating an empty-result search must not turn into a false success claim.
  if (plan.mode === 'product_search' && !(plan.products || []).length) return plan;
  if (plan.mode === 'product_choice' || plan.mode === 'source_choice') return plan;
  if (plan.mode === 'general_chat') return plan;
  if (plan.intent === 'out_of_scope') return plan;
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
  if (productSearch.source === 'web-search-link') return 'I could not verify complete product cards, so I made a direct web shopping search for you.';
  if (/web/i.test(productSearch.source || '')) {
    return count === 1
      ? 'I found one strong web match. You can preview it or open the product page.'
      : `I found ${count} web option${suffix} that match your request.`;
  }
  return `I found ${count} product option${suffix} for this.`;
}

function productSearchEmptyReply(productSearch = {}, message = '') {
  const topic = cleanText(message || productSearch.query || 'that request', 140)
    .replace(/^(?:please\s+)?(?:search|find|show)\s+(?:the\s+)?(?:lookmefy\s+)?(?:catalog|online|amazon)?\s*(?:for\s+)?/i, '')
    .trim() || 'that request';
  if (productSearch.source === 'catalog-empty') {
    return `I could not find matching Lookmefy catalog products for ${topic}.`;
  }
  if (/amazon|web/i.test(productSearch.source || '')) {
    return `I could not find matching online product cards for "${topic}". Try a different color, item type, budget, or search the Lookmefy catalog.`;
  }
  return `I could not find matching product cards for "${topic}". Try a clearer item type, color, occasion, or budget.`;
}

function neutralizeMarketplaceCopy(value = '') {
  return cleanText(value, 800)
    .replace(/\blive\s+amazon\s+products?\b/gi, 'web products')
    .replace(/\bamazon\s+(?:shopping\s+)?(?:results?|options?|products?|cards?)\b/gi, (match) => match.replace(/amazon(?:\s+shopping)?/i, 'web'))
    .replace(/\bamazon\s+search\b/gi, 'web search')
    .replace(/\bon\s+amazon\b/gi, 'on the retailer site')
    .replace(/\bamazon(?:\.in)?\b/gi, 'the retailer');
}

function neutralizeWebPlanCopy(plan = {}, productSearch = {}) {
  const visibleProducts = [
    ...(plan.products || []),
    ...(plan.outfits || []).flatMap((outfit) => outfit.products || [])
  ];
  const hasWebResults = /web|amazon|serpapi/i.test(String(productSearch.source || plan.productSearchSource || ''))
    || visibleProducts.some((product) => productSourceType(product) === 'web');
  if (!hasWebResults) return plan;
  return { ...plan, reply: neutralizeMarketplaceCopy(plan.reply) };
}

function enforceSelectedSource(plan = {}, selectedSource = '') {
  if (selectedSource === 'wardrobe') {
    return {
      ...plan,
      products: [],
      outfits: (plan.outfits || []).map((outfit) => ({
        ...outfit,
        source: 'wardrobe',
        sourceLabel: sourceLabel('wardrobe'),
        items: (outfit.items || []).map((item) => withSourceMetadata(item, 'wardrobe'))
          .filter((item) => productSourceType(item, 'wardrobe') === 'wardrobe'),
        products: []
      })).filter((outfit) => outfit.items.length)
    };
  }
  if (selectedSource === 'catalog' || selectedSource === 'online') {
    const expectedSource = selectedSource === 'catalog' ? 'lookmefy_catalog' : 'web';
    return {
      ...plan,
      outfits: [],
      products: (plan.products || [])
        .filter((product) => productSourceType(product) === expectedSource)
        .map((product) => selectedSource === 'online' ? withSourceMetadata(product, 'web') : product),
      actions: selectedSource === 'online'
        ? (plan.actions || []).filter((action) => !/try[_ -]?on/i.test(`${action.type || ''} ${action.label || ''} ${action.prompt || ''}`))
        : plan.actions
    };
  }
  return plan;
}

async function orchestrateAiStudio({ user, message, conversationId = '', history = [] } = {}) {
  const prompt = cleanText(message, 600);
  if (!prompt) {
    const error = new Error('Message AI Studio first');
    error.statusCode = 400;
    throw error;
  }

  const profile = userProfile(user);
  const conversation = nextConversation({ userId: profile.id, conversationId, history });
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
      contextSource: 'backend',
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
    ? lastSearchableMessage(conversation) || defaultOnlineSearchMessage({ profile })
    : '';
  const planningMessage = pendingChoice
    ? conversation.pendingProductChoice.message
    : fallbackSearchMessage || (budgetFollowUpMessage ? `${budgetFollowUpMessage} ${prompt}` : prompt);
  const pendingChoiceKind = conversation.pendingProductChoice?.kind || 'product';
  const filters = pendingChoice && conversation.pendingProductChoice.filters
    ? { ...conversation.pendingProductChoice.filters }
    : extractFilters(planningMessage, profile);
  const selectedSource = pendingChoice || explicitPath;
  const contextScope = selectedSource === 'wardrobe'
    ? 'wardrobe'
    : ['catalog', 'online'].includes(selectedSource)
      ? 'shopping'
      : 'all';
  const context = await loadContext(user, { scope: contextScope });
  let detectedIntent = aiStudioIntent(planningMessage);
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
  } else {
    detectedIntent = freshSourceChoiceIntent(planningMessage, filters, detectedIntent);
  }

  const intent = containsAbuse(prompt)
    ? 'abuse_guard'
    : detectedIntent === 'language_preference'
      ? detectedIntent
      : detectedIntent;
  const sourceOnlyRequest = ['wardrobe', 'catalog', 'online'].includes(selectedSource);
  const knowledge = sourceOnlyRequest ? [] : await retrieveAiStudioKnowledge(planningMessage, 5);
  const eventProfile = eventProfileForMessage(planningMessage, filters);
  const wardrobeCombos = rankWardrobeCombos(buildWardrobeCombos(context.wardrobe, filters), filters, eventProfile);
  const bestCombo = wardrobeCombos[0] || null;
  let plan = localPlan({ message: planningMessage, conversation, context, intent, filters, wardrobeCombos, bestCombo, eventProfile });
  if (['rag_help'].includes(plan.mode)) plan = { ...plan, reply: localLookmefyHelpReply(planningMessage, knowledge) };
  const directGeneralReply = intent === 'general_question'
    ? (currentDateTimeReply(planningMessage) || await currentWeatherReply(planningMessage))
    : '';
  if (directGeneralReply) {
    plan = {
      ...plan,
      mode: 'general_chat',
      reply: directGeneralReply,
      products: [],
      outfits: [],
      actions: [],
      brain: 'local'
    };
  }
  if (plan.pendingProductChoice) conversation.pendingProductChoice = plan.pendingProductChoice;
  else if (pendingChoice) conversation.pendingProductChoice = null;

  const localOnlyIntent = ['greeting', 'small_talk', 'language_preference', 'abuse_guard', 'out_of_scope'].includes(intent)
    || Boolean(directGeneralReply)
    || intent === 'general_style_question'
    || plan.mode === 'product_choice'
    || plan.mode === 'source_choice'
    || plan.mode === 'rag_help'
    || ['wardrobe_product_check', 'wardrobe_outfit_check'].includes(intent);
  let productSearch = { query: plan.productSearchQuery || '', targets: [], source: 'not-needed', error: '', products: [] };

  if (!localOnlyIntent) {
    const needsSearch = plan.wardrobeWeak || ['product_search', 'hybrid_wardrobe_shopping'].includes(plan.mode);
    const sourcePreference = selectedSource === 'catalog'
      ? 'catalog'
      : selectedSource === 'online'
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
          reply: productSearchEmptyReply(productSearch, planningMessage),
          actions: [{ type: 'search_online', label: 'Search online instead', prompt: `Search online for ${planningMessage}` }],
          outfits: (plan.outfits || []).map((outfit) => ({ ...outfit, products: [] }))
        };
      }
    }

    const productCandidates = uniqueById([...(plan.products || []), ...(plan.outfits || []).flatMap((outfit) => outfit.products || []), ...(productSearch.products || [])]);
    const candidateOutfits = uniqueById([...(plan.outfits || []), ...wardrobeCombos.slice(0, 4)]);
    const canUseAiPlanner = !sourceOnlyRequest && !(plan.mode === 'product_search' && !productCandidates.length);
    if (canUseAiPlanner) {
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
          candidateProducts: productCandidates,
          requestFilters: filters,
          eventProfile,
          specificLabel: specificProductLabel(planningMessage, filters)
        });
        plan.falUsage = result.usage;
        plan.model = result.model;
      } catch (error) {
        plan = { ...plan, falError: error.message || 'AI planner failed' };
      }
    }
  }

  plan = enforceSelectedSource(plan, selectedSource);
  plan = neutralizeWebPlanCopy(antiRepeatReply(plan, conversation), productSearch);
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
  eventProfileForMessage,
  extractFilters as extractAiStudioFilters,
  freshSourceChoiceIntent,
  generalStyleQuestionReply,
  isGeneralStyleQuestion,
  outOfScopeReply,
  orchestrateAiStudio,
  productMatchesEventProfile,
  productSatisfiesHardFilters,
  retrieveAiStudioKnowledge,
  scoreAiStudioKnowledge,
  sourceChoiceActions,
  sourceLabel,
  specificProductLabel,
  detectProductChoice,
  localPlan,
  wardrobeFallbackActions,
  mergeFalPlan,
  productSearchEmptyReply,
  productSearchReply,
  rankCatalogProducts,
  extractAmazonSearchResults,
  webProductHasRequiredData
};
