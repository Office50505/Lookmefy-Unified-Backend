import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../server/models/User.js';
import UserEvent from '../server/models/UserEvent.js';
import UserPreference from '../server/models/UserPreference.js';
import { clearRecommendationCaches, getForYouRecommendations } from '../server/services/recommendationEngine.js';
import { isUsefulQueryTerm } from '../server/services/recommendationScoring.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function objectEntries(value) {
  if (!value) return [];
  if (value instanceof Map) return [...value.entries()];
  if (typeof value === 'object') return Object.entries(value);
  return [];
}

function topMap(value, limit = 12) {
  return objectEntries(value)
    .map(([key, score]) => ({ key, score: Number(score) || 0 }))
    .filter((entry) => entry.key && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function noisyPreferenceTags(preference) {
  return objectEntries(preference?.tags)
    .map(([key, score]) => ({ key, score: Number(score) || 0 }))
    .filter((entry) => entry.key && !isUsefulQueryTerm(entry.key))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

async function latestPreferenceUser() {
  const preference = await UserPreference.findOne({}).sort({ updatedAt: -1 }).lean();
  return preference?.user || null;
}

async function resolveUser() {
  const id = argValue('user');
  const email = argValue('email');
  const phone = argValue('phone');
  if (id) return User.findById(id);
  if (email) return User.findOne({ email: email.trim().toLowerCase() });
  if (phone) return User.findOne({ phone: phone.trim() });
  const latestUserId = await latestPreferenceUser();
  return latestUserId ? User.findById(latestUserId) : null;
}

async function applyNoiseCleanup(userId, noisyTags) {
  if (!noisyTags.length) return { removed: 0 };
  const unset = Object.fromEntries(noisyTags.map((entry) => [`tags.${entry.key}`, '']));
  await UserPreference.updateOne({ user: userId }, { $unset: unset });
  return { removed: noisyTags.length };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'fitlook' });
  const user = await resolveUser();
  if (!user) throw new Error('No user found. Pass --user, --email, or --phone.');

  const limit = Math.min(24, Math.max(1, Number(argValue('limit', 8)) || 8));
  const surface = argValue('surface', 'home');
  const client = argValue('client', 'web');
  const since = new Date(Date.now() - (Number(argValue('hours', 24)) || 24) * 60 * 60 * 1000);
  let preference = await UserPreference.findOne({ user: user._id }).lean();
  let noisyTags = noisyPreferenceTags(preference);
  const cleanup = hasFlag('apply-clean-noise')
    ? await applyNoiseCleanup(user._id, noisyTags)
    : { removed: 0, dryRun: true };
  if (cleanup.removed) {
    preference = await UserPreference.findOne({ user: user._id }).lean();
    noisyTags = noisyPreferenceTags(preference);
  }

  const events = await UserEvent.find({ user: user._id, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  await clearRecommendationCaches();
  const recommendations = await getForYouRecommendations({
    user,
    limit,
    surface,
    client,
    includeDiagnostics: true
  });

  console.log(JSON.stringify({
    user: {
      id: String(user._id),
      email: user.email || '',
      phone: user.phone || '',
      genderPreference: user.genderPreference || ''
    },
    preference: {
      categories: topMap(preference?.categories),
      brands: topMap(preference?.brands),
      tags: topMap(preference?.tags),
      colors: topMap(preference?.colors),
      garmentPlacements: topMap(preference?.garmentPlacements),
      occasions: topMap(preference?.occasions),
      formalities: topMap(preference?.formalities),
      priceBands: topMap(preference?.priceBands),
      noisyTags: noisyTags.slice(0, 30),
      noiseCleanup: cleanup
    },
    recentEvents: events.map((event) => ({
      type: event.type,
      query: event.query || '',
      source: event.source || '',
      metadata: event.metadata || {},
      createdAt: event.createdAt
    })),
    recommendations: {
      requestId: recommendations.requestId,
      surface: recommendations.surface,
      client: recommendations.client,
      personalized: recommendations.personalized,
      algorithmVersion: recommendations.algorithmVersion,
      scoringProfile: recommendations.scoringProfile,
      signalCount: recommendations.signalCount,
      topProducts: recommendations.products.map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category,
        brand: product.brand,
        score: product.recommendationScore,
        reasons: product.recommendationReasons,
        sources: product.recommendationContext?.candidateSources || []
      })),
      diagnostics: recommendations.recommendationDiagnostics
    }
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message || error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
