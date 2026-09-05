import express from 'express';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import UserEvent from '../models/UserEvent.js';
import { loadAdminAnalytics } from '../services/adminAnalytics.js';
import { analyticsPeriodFromQuery } from '../utils/analyticsPeriod.js';
import { requireUser } from './auth.js';
import { createRateLimiter, rateLimitKeys } from '../utils/rateLimit.js';
import { requireAdmin, requireAdminSection } from '../utils/adminAccess.js';
import { ADMIN_SECTIONS } from '../utils/adminPermissions.js';
import { normalizeSessionPath, touchUserSession } from '../utils/userSessions.js';
import {
  aiStudioFallbackReply as serviceAiStudioFallbackReply,
  aiStudioIntent as serviceAiStudioIntent,
  aiStudioKnowledgeReply as serviceAiStudioKnowledgeReply,
  aiStudioQueryTerms as serviceAiStudioQueryTerms,
  aiStudioSuggestions as serviceAiStudioSuggestions,
  orchestrateAiStudio,
  retrieveAiStudioKnowledge as serviceRetrieveAiStudioKnowledge,
  scoreAiStudioKnowledge as serviceScoreAiStudioKnowledge
} from '../services/aiStudio.js';
import { buildRecommendationContext } from '../services/recommendationContext.js';
import {
  catalogFilter,
  clearRecommendationCaches,
  getForYouRecommendations,
  getSimilarRecommendations
} from '../services/recommendationEngine.js';
import { updatePreference } from '../services/recommendationPreferences.js';
import {
  EVENT_WEIGHTS,
  buildRecentProfile,
  eventWeight,
  normalizeGender,
  ratingQuality,
  rerankDiverse,
  scoreProduct
} from '../services/recommendationScoring.js';

const router = express.Router();
const requireUserOperationsAdmin = requireAdminSection(ADMIN_SECTIONS.USER_OPERATIONS);
const recommendationEventLimiter = createRateLimiter({
  name: 'recommendations:events',
  windowMs: 5 * 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKeys.user,
  message: 'Too many recommendation events. Please slow down and keep browsing.'
});
const recommendationReadLimiter = createRateLimiter({
  name: 'recommendations:read',
  windowMs: 5 * 60 * 1000,
  max: 300,
  keyGenerator: rateLimitKeys.userOrIp,
  message: 'Recommendations are temporarily limited. Please try again shortly.'
});

const EVENT_METADATA_KEYS = new Set([
  'brand',
  'algorithmVersion',
  'category',
  'color',
  'colors',
  'durationMs',
  'formality',
  'formalities',
  'gender',
  'generationType',
  'generatedForVideo',
  'garmentPlacement',
  'listId',
  'model',
  'newArrival',
  'occasion',
  'occasions',
  'personalized',
  'provider',
  'priceBand',
  'rank',
  'regenerated',
  'recommendationSource',
  'resultCount',
  'sort',
  'status',
  'tag',
  'tokensCharged',
  'tokensRefunded',
  'tryOnModel',
  'video'
]);

function safeEventMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, raw]) => {
    if (!EVENT_METADATA_KEYS.has(key)) return [];
    if (typeof raw === 'boolean') return [[key, raw]];
    if (typeof raw === 'number' && Number.isFinite(raw)) return [[key, raw]];
    if (typeof raw === 'string') return [[key, raw.trim().slice(0, 100)]];
    if (Array.isArray(raw)) {
      const values = raw
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().slice(0, 100))
        .filter(Boolean)
        .slice(0, 12);
      return values.length ? [[key, values]] : [];
    }
    return [];
  }));
}

function safeEventSource(value = '') {
  return String(value || '').trim().replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
}

function wantsRecommendationDebug(req) {
  return ['1', 'true', 'yes', 'on'].includes(String(req.query?.debug || '').trim().toLowerCase());
}

router.post('/events', requireUser, recommendationEventLimiter, async (req, res) => {
  try {
    const type = String(req.body?.type || '').trim();
    if (!Object.hasOwn(EVENT_WEIGHTS, type)) return res.json({ ok: false, ignored: true });

    const productId = String(req.body?.productId || '').trim();
    const query = String(req.body?.query || '').trim().slice(0, 240);
    const path = normalizeSessionPath(req.body?.path);
    const source = safeEventSource(req.body?.source);
    const metadata = safeEventMetadata(req.body?.metadata);
    const product = mongoose.Types.ObjectId.isValid(productId)
      ? await Product.findOne(catalogFilter({ _id: productId })).lean()
      : null;

    await Promise.all([
      UserEvent.create({
        user: req.user._id,
        session: req.userSession?._id,
        type,
        product: product?._id,
        query,
        path,
        source,
        weight: eventWeight(type),
        metadata
      }),
      touchUserSession({ userId: req.user._id, sessionId: req.sessionId, path, eventType: type }),
      updatePreference({ userId: req.user._id, type, product, query, metadata })
    ]);
    res.status(201).json({ ok: true });
  } catch (error) {
    console.warn('[recommendations:events] ignored event', error.message);
    res.json({ ok: false, ignored: true });
  }
});

router.post('/events/batch', requireUser, recommendationEventLimiter, async (req, res) => {
  try {
    const inputs = Array.isArray(req.body?.events) ? req.body.events.slice(0, 24) : [];
    const impressions = inputs.filter((item) => item?.type === 'recommendation_impression');
    const productIds = [...new Set(impressions.map((item) => String(item.productId || '')).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    const products = productIds.length ? await Product.find(catalogFilter({ _id: { $in: productIds } })).select('_id').lean() : [];
    const allowedProducts = new Set(products.map((product) => String(product._id)));
    const rows = impressions.flatMap((item) => {
      const productId = String(item.productId || '');
      if (!allowedProducts.has(productId)) return [];
      return [{
        user: req.user._id,
        session: req.userSession?._id,
        type: 'recommendation_impression',
        product: productId,
        path: normalizeSessionPath(item.path || req.body?.path),
        source: safeEventSource(item.source),
        weight: 0,
        metadata: safeEventMetadata(item.metadata)
      }];
    });
    if (rows.length) {
      await Promise.all([
        UserEvent.insertMany(rows),
        touchUserSession({ userId: req.user._id, sessionId: req.sessionId, path: rows[0].path, eventType: 'recommendation_impression' })
      ]);
    }
    res.status(201).json({ ok: true, accepted: rows.length });
  } catch (error) {
    console.warn('[recommendations:events-batch] ignored batch', error.message);
    res.json({ ok: false, ignored: true, accepted: 0 });
  }
});

router.get('/recent-searches', requireUser, recommendationReadLimiter, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 12);
  const events = await UserEvent.find({
    user: req.user._id,
    type: 'search',
    query: { $exists: true, $ne: '' }
  })
    .sort({ createdAt: -1 })
    .limit(limit * 8)
    .lean();

  const seen = new Set();
  const searches = [];
  for (const event of events) {
    const query = String(event.query || '').trim();
    const key = query.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    searches.push({ query, createdAt: event.createdAt });
    if (searches.length >= limit) break;
  }

  res.json({ searches });
});

router.post(['/studio-chat', '/stylist-chat'], requireUser, recommendationEventLimiter, async (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 600);
  if (!message) return res.status(400).json({ message: 'Message AI Studio first' });
  const path = normalizeSessionPath('/ai-stylist');

  try {
    const payload = await orchestrateAiStudio({
      user: req.user,
      message,
      conversationId: req.body?.conversationId,
      history: req.body?.history
    });
    const clientProducts = payload.products || [];
    await Promise.all([
      UserEvent.create({
        user: req.user._id,
        session: req.userSession?._id,
        type: 'style_bot_query',
        query: message,
        path,
        source: 'ai_studio',
        weight: eventWeight('style_bot_query'),
        metadata: {
          resultCount: clientProducts.length,
          mode: payload.mode,
          intent: payload.intent,
          brain: payload.brain
        }
      }),
      touchUserSession({ userId: req.user._id, sessionId: req.sessionId, path, eventType: 'style_bot_query' }),
      updatePreference({
        userId: req.user._id,
        type: 'style_bot_query',
        query: message,
        metadata: {
          resultCount: clientProducts.length,
          mode: payload.mode,
          intent: payload.intent,
          brain: payload.brain
        }
      })
    ]);
    res.json(payload);
  } catch (error) {
    console.error('[recommendations:studio-chat] failed', error.message);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'AI Studio request failed' });
  }
});

router.get('/admin/stats', requireAdmin, requireUserOperationsAdmin, async (req, res) => {
  try {
    const period = analyticsPeriodFromQuery(req.query);
    res.json(await loadAdminAnalytics(period));
  } catch (error) {
    res.status(400).json({ message: error.message || 'Could not load analytics' });
  }
});

router.get('/for-you', requireUser, recommendationReadLimiter, async (req, res) => {
  try {
    const context = buildRecommendationContext({
      query: req.query,
      headers: req.headers,
      defaultSurface: 'for_you'
    });
    res.json(await getForYouRecommendations({
      user: req.user,
      limit: req.query.limit,
      surface: context.surface,
      client: context.client,
      includeDiagnostics: wantsRecommendationDebug(req)
    }));
  } catch (error) {
    console.error('[recommendations:for-you] failed', error.message);
    res.status(500).json({ message: 'Could not load recommendations' });
  }
});

router.get('/similar/:productId', recommendationReadLimiter, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.productId)) return res.status(404).json({ message: 'Product not found' });
  try {
    const context = buildRecommendationContext({
      query: req.query,
      headers: req.headers,
      defaultSurface: 'similar'
    });
    res.json(await getSimilarRecommendations({
      productId: req.params.productId,
      limit: req.query.limit,
      client: context.client,
      includeDiagnostics: wantsRecommendationDebug(req)
    }));
  } catch (error) {
    res.status(error?.statusCode || 500).json({ message: error?.message || 'Could not load similar products' });
  }
});

export default router;
export {
  serviceAiStudioIntent as aiStudioIntent,
  serviceAiStudioFallbackReply as aiStudioFallbackReply,
  serviceAiStudioKnowledgeReply as aiStudioKnowledgeReply,
  serviceAiStudioQueryTerms as aiStudioQueryTerms,
  serviceAiStudioSuggestions as aiStudioSuggestions,
  buildRecentProfile,
  clearRecommendationCaches,
  serviceRetrieveAiStudioKnowledge as retrieveAiStudioKnowledge,
  serviceScoreAiStudioKnowledge as scoreAiStudioKnowledge,
  normalizeGender,
  ratingQuality,
  rerankDiverse,
  scoreProduct
};
