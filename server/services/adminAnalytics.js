import GenerationMetric from '../models/GenerationMetric.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import UserSession from '../models/UserSession.js';
import { DAY_MS } from '../utils/analyticsPeriod.js';
import { availableStatusClause } from '../utils/productAvailability.js';

const FUNNEL_STAGES = [
  ['recommendation_impression', 'Recommendations shown'],
  ['product_view', 'Products viewed'],
  ['wishlist', 'Products wishlisted'],
  ['try_on', 'AI try-ons'],
  ['shop_click', 'Shop clicks']
];

function dateMatch(period) {
  return { createdAt: { $gte: period.from, $lt: period.to } };
}

function percent(value, total) {
  return total > 0 ? Math.round((Number(value || 0) / Number(total)) * 1000) / 10 : 0;
}

function changePercent(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function fillDailyTrend(rows, period) {
  const byDate = new Map(rows.map((row) => [row._id, row]));
  const output = [];
  for (let cursor = new Date(period.from); cursor < period.to; cursor = new Date(cursor.getTime() + DAY_MS)) {
    const date = cursor.toISOString().slice(0, 10);
    const row = byDate.get(date);
    output.push({ date, events: Number(row?.events || 0), users: Number(row?.users || 0) });
  }
  return output;
}

async function sessionSummary(period) {
  const [summary] = await UserSession.aggregate([
    { $match: { loginAt: { $gte: period.from, $lt: period.to } } },
    {
      $group: {
        _id: null,
        sessions: { $sum: 1 },
        users: { $addToSet: '$user' },
        activeDurationMs: { $sum: '$activeDurationMs' },
        pageViews: { $sum: '$pageViewCount' }
      }
    }
  ]);
  const returning = await UserSession.aggregate([
    { $match: { loginAt: { $gte: period.from, $lt: period.to } } },
    { $group: { _id: '$user', sessions: { $sum: 1 } } },
    { $match: { sessions: { $gte: 2 } } },
    { $count: 'users' }
  ]);
  return {
    sessions: Number(summary?.sessions || 0),
    users: Number(summary?.users?.length || 0),
    activeDurationMs: Number(summary?.activeDurationMs || 0),
    pageViews: Number(summary?.pageViews || 0),
    returningUsers: Number(returning[0]?.users || 0)
  };
}

async function productDimension(period, field, { unwind = false } = {}) {
  const pipeline = [
    { $match: { ...dateMatch(period), product: { $exists: true, $ne: null } } },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
    { $unwind: '$product' }
  ];
  if (unwind) pipeline.push({ $unwind: `$product.${field}` });
  pipeline.push(
    { $match: { [`product.${field}`]: { $exists: true, $nin: ['', null] } } },
    { $group: { _id: `$product.${field}`, count: { $sum: 1 }, weight: { $sum: '$weight' } } },
    { $sort: { weight: -1, count: -1 } },
    { $limit: 10 }
  );
  const rows = await UserEvent.aggregate(pipeline);
  return rows.map((row) => ({
    key: String(row._id).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    label: String(row._id).replace(/_/g, ' '),
    count: Number(row.count || 0),
    weight: Math.round(Number(row.weight || 0) * 10) / 10
  }));
}

async function generationSummary(period) {
  const rows = await GenerationMetric.aggregate([
    { $match: dateMatch(period) },
    {
      $facet: {
        totals: [{
          $group: {
            _id: null,
            succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            reused: { $sum: { $cond: [{ $eq: ['$status', 'reused'] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
            durationTotal: { $sum: { $cond: [{ $in: ['$status', ['succeeded', 'failed']] }, '$durationMs', 0] } },
            durationCount: { $sum: { $cond: [{ $in: ['$status', ['succeeded', 'failed']] }, 1, 0] } },
            tokensCharged: { $sum: '$tokensCharged' },
            tokensRefunded: { $sum: '$tokensRefunded' },
            providerCostUsd: { $sum: '$providerCostUsd' }
          }
        }],
        providers: [
          { $group: { _id: '$provider', total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } },
          { $sort: { total: -1 } }
        ],
        types: [
          { $group: { _id: '$type', total: { $sum: 1 }, succeeded: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } },
          { $sort: { total: -1 } }
        ],
        errors: [
          { $match: { status: 'failed' } },
          { $group: { _id: '$errorCategory', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 }
        ]
      }
    }
  ]);
  const result = rows[0] || {};
  const totals = result.totals?.[0] || {};
  const attempts = Number(totals.succeeded || 0) + Number(totals.failed || 0);
  return {
    attempts,
    succeeded: Number(totals.succeeded || 0),
    failed: Number(totals.failed || 0),
    reused: Number(totals.reused || 0),
    rejected: Number(totals.rejected || 0),
    successRate: percent(totals.succeeded, attempts),
    averageDurationMs: Number(totals.durationCount || 0) ? Math.round(Number(totals.durationTotal || 0) / Number(totals.durationCount)) : 0,
    tokensCharged: Number(totals.tokensCharged || 0),
    tokensRefunded: Number(totals.tokensRefunded || 0),
    providerCostUsd: Math.round(Number(totals.providerCostUsd || 0) * 10000) / 10000,
    providers: (result.providers || []).map((row) => ({ provider: row._id || 'unknown', total: row.total, succeeded: row.succeeded, failed: row.failed, successRate: percent(row.succeeded, Number(row.succeeded || 0) + Number(row.failed || 0)) })),
    types: (result.types || []).map((row) => ({ type: row._id, total: row.total, succeeded: row.succeeded, failed: row.failed, successRate: percent(row.succeeded, Number(row.succeeded || 0) + Number(row.failed || 0)) })),
    errors: (result.errors || []).map((row) => ({ category: row._id || 'unknown', count: row.count }))
  };
}

async function loadAdminAnalytics(period) {
  const currentMatch = dateMatch(period);
  const previousPeriod = { from: period.previousFrom, to: period.previousTo };
  const [eventFacet] = await UserEvent.aggregate([
    { $match: currentMatch },
    {
      $facet: {
        counts: [
          { $group: { _id: '$type', count: { $sum: 1 }, weight: { $sum: '$weight' }, users: { $addToSet: '$user' }, recommendationAttributed: { $sum: { $cond: [{ $and: [{ $in: ['$type', ['try_on', 'shop_click', 'wishlist']] }, { $ne: [{ $ifNull: ['$metadata.recommendationSource', ''] }, ''] }] }, 1, 0] } } } },
          { $sort: { count: -1 } }
        ],
        daily: [
          { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, user: '$user' }, events: { $sum: 1 } } },
          { $group: { _id: '$_id.date', events: { $sum: '$events' }, users: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ],
        funnelCohort: [
          { $group: { _id: '$user', types: { $addToSet: '$type' } } },
          {
            $project: {
              recommendation_impression: { $cond: [{ $setIsSubset: [['recommendation_impression'], '$types'] }, 1, 0] },
              product_view: { $cond: [{ $setIsSubset: [['recommendation_impression', 'product_view'], '$types'] }, 1, 0] },
              wishlist: { $cond: [{ $setIsSubset: [['recommendation_impression', 'product_view', 'wishlist'], '$types'] }, 1, 0] },
              try_on: { $cond: [{ $setIsSubset: [['recommendation_impression', 'product_view', 'wishlist', 'try_on'], '$types'] }, 1, 0] },
              shop_click: { $cond: [{ $setIsSubset: [['recommendation_impression', 'product_view', 'wishlist', 'try_on', 'shop_click'], '$types'] }, 1, 0] }
            }
          },
          { $group: { _id: null, recommendation_impression: { $sum: '$recommendation_impression' }, product_view: { $sum: '$product_view' }, wishlist: { $sum: '$wishlist' }, try_on: { $sum: '$try_on' }, shop_click: { $sum: '$shop_click' } } }
        ],
        topProducts: [
          { $match: { product: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$product',
              events: { $sum: 1 },
              weight: { $sum: '$weight' },
              views: { $sum: { $cond: [{ $eq: ['$type', 'product_view'] }, 1, 0] } },
              clicks: { $sum: { $cond: [{ $in: ['$type', ['product_click', 'recommendation_click']] }, 1, 0] } },
              recommendationImpressions: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_impression'] }, 1, 0] } },
              recommendationClicks: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_click'] }, 1, 0] } },
              wishlists: { $sum: { $cond: [{ $eq: ['$type', 'wishlist'] }, 1, 0] } },
              tryOns: { $sum: { $cond: [{ $eq: ['$type', 'try_on'] }, 1, 0] } },
              shopClicks: { $sum: { $cond: [{ $eq: ['$type', 'shop_click'] }, 1, 0] } }
            }
          },
          { $sort: { weight: -1, events: -1 } },
          { $limit: 30 },
          { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
          { $unwind: '$product' },
          { $project: { events: 1, weight: 1, views: 1, clicks: 1, recommendationImpressions: 1, recommendationClicks: 1, wishlists: 1, tryOns: 1, shopClicks: 1, name: '$product.name', brand: '$product.brand', category: '$product.category' } }
        ],
        searches: [
          { $match: { type: 'search', query: { $exists: true, $ne: '' } } },
          { $group: { _id: { $toLower: '$query' }, count: { $sum: 1 }, users: { $addToSet: '$user' }, sessions: { $addToSet: '$session' }, zeroResults: { $sum: { $cond: [{ $eq: ['$metadata.resultCount', 0] }, 1, 0] } }, lastAt: { $max: '$createdAt' } } },
          { $sort: { count: -1, lastAt: -1 } },
          { $limit: 20 }
        ],
        searchClicks: [
          { $match: { type: 'product_click', source: 'search', query: { $exists: true, $ne: '' } } },
          { $group: { _id: { $toLower: '$query' }, clicks: { $sum: 1 }, users: { $addToSet: '$user' }, sessions: { $addToSet: '$session' } } }
        ],
        recommendationSources: [
          { $match: { type: { $in: ['recommendation_impression', 'recommendation_click'] } } },
          { $group: { _id: { $ifNull: ['$source', 'unknown'] }, impressions: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_impression'] }, 1, 0] } }, clicks: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_click'] }, 1, 0] } } } },
          { $sort: { impressions: -1 } }
        ],
        algorithmVersions: [
          { $match: { type: { $in: ['recommendation_impression', 'recommendation_click'] }, 'metadata.algorithmVersion': { $exists: true, $ne: '' } } },
          { $group: { _id: '$metadata.algorithmVersion', impressions: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_impression'] }, 1, 0] } }, clicks: { $sum: { $cond: [{ $eq: ['$type', 'recommendation_click'] }, 1, 0] } } } },
          { $sort: { impressions: -1 } }
        ],
        recommendationCoverage: [
          { $match: { type: 'recommendation_impression', product: { $exists: true, $ne: null } } },
          { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'productData' } },
          { $unwind: { path: '$productData', preserveNullAndEmptyArrays: true } },
          {
            $group: {
              _id: null,
              products: { $addToSet: '$product' },
              categories: { $addToSet: '$productData.category' },
              brands: { $addToSet: '$productData.brand' },
              coldStart: { $sum: { $cond: [{ $eq: ['$metadata.personalized', false] }, 1, 0] } },
              personalized: { $sum: { $cond: [{ $eq: ['$metadata.personalized', true] }, 1, 0] } }
            }
          }
        ]
      }
    }
  ]);

  const eventCounts = (eventFacet?.counts || []).map((row) => ({ type: row._id, count: row.count, users: row.users?.length || 0, recommendationAttributed: Number(row.recommendationAttributed || 0), weight: Math.round(Number(row.weight || 0) * 10) / 10 }));
  const countByType = new Map(eventCounts.map((row) => [row.type, row]));
  const funnelCohort = eventFacet?.funnelCohort?.[0] || {};
  const funnel = FUNNEL_STAGES.map(([type, label], index) => {
    const current = countByType.get(type) || { count: 0, users: 0 };
    const users = Number(funnelCohort[type] || 0);
    const previousUsers = index ? Number(funnelCohort[FUNNEL_STAGES[index - 1][0]] || 0) : 0;
    return {
      type,
      label,
      events: Number(current.count || 0),
      users,
      conversionRate: index ? percent(users, previousUsers) : 100,
      dropOffRate: index ? Math.max(0, Math.round((100 - percent(users, previousUsers)) * 10) / 10) : 0
    };
  });
  const impressions = Number(countByType.get('recommendation_impression')?.count || 0);
  const recommendationClicks = Number(countByType.get('recommendation_click')?.count || 0);
  const coverage = eventFacet?.recommendationCoverage?.[0] || {};
  const recommendationProducts = new Set((coverage.products || []).map(String));
  const recommendationCategories = (coverage.categories || []).filter(Boolean);
  const recommendationBrands = (coverage.brands || []).filter(Boolean);
  const searchClicks = new Map((eventFacet?.searchClicks || []).map((row) => [row._id, row]));

  const [activeUsers, previousActiveUsers, previousEvents, currentSessions, previousSessions, newUsers, preferenceProfiles, catalogProducts, averagePrice, recentEvents, topCategories, topBrands, topTags, topGenders, generation] = await Promise.all([
    UserEvent.distinct('user', currentMatch),
    UserEvent.distinct('user', dateMatch(previousPeriod)),
    UserEvent.countDocuments(dateMatch(previousPeriod)),
    sessionSummary(period),
    sessionSummary(previousPeriod),
    User.countDocuments({ createdAt: { $gte: period.from, $lt: period.to }, accountStatus: { $ne: 'deleted' } }),
    UserPreference.countDocuments(),
    Product.countDocuments({ isActive: true, $and: [availableStatusClause()] }),
    UserEvent.aggregate([
      { $match: { ...currentMatch, product: { $exists: true, $ne: null }, weight: { $gt: 0 } } },
      { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $match: { 'product.price': { $gte: 0 } } },
      { $group: { _id: null, average: { $avg: '$product.price' } } }
    ]),
    UserEvent.find(currentMatch).sort({ createdAt: -1 }).limit(12).populate('product', 'name brand category').lean(),
    productDimension(period, 'category'),
    productDimension(period, 'brand'),
    productDimension(period, 'tags', { unwind: true }),
    productDimension(period, 'gender'),
    generationSummary(period)
  ]);

  const totalEvents = eventCounts.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const daily = fillDailyTrend(eventFacet?.daily || [], period);
  const lastSevenFrom = new Date(Math.max(period.from.getTime(), period.to.getTime() - (7 * DAY_MS)));
  const lastThirtyFrom = new Date(Math.max(period.from.getTime(), period.to.getTime() - (30 * DAY_MS)));
  const [wau, mau] = await Promise.all([
    UserEvent.distinct('user', { createdAt: { $gte: lastSevenFrom, $lt: period.to } }),
    UserEvent.distinct('user', { createdAt: { $gte: lastThirtyFrom, $lt: period.to } })
  ]);
  const activeDays = daily.filter((row) => row.users > 0);
  const dau = activeDays.length ? Math.round((activeDays.reduce((sum, row) => sum + row.users, 0) / activeDays.length) * 10) / 10 : 0;

  return {
    period: {
      range: period.range,
      from: period.from,
      to: period.to,
      days: period.days,
      label: period.label,
      retentionDays: 180
    },
    totals: {
      events: totalEvents,
      activeUsers: activeUsers.length,
      preferenceProfiles,
      averageInteractedPrice: Math.round(Number(averagePrice[0]?.average || 0)),
      sessions: currentSessions.sessions,
      averageSessionMinutes: currentSessions.sessions ? Math.round((currentSessions.activeDurationMs / currentSessions.sessions / 60000) * 10) / 10 : 0,
      returningUsers: currentSessions.returningUsers,
      returningRate: percent(currentSessions.returningUsers, currentSessions.users),
      newUsers,
      eventsPerUser: activeUsers.length ? Math.round((totalEvents / activeUsers.length) * 10) / 10 : 0,
      dau,
      wau: wau.length,
      mau: mau.length
    },
    comparison: {
      events: changePercent(totalEvents, previousEvents),
      activeUsers: changePercent(activeUsers.length, previousActiveUsers.length),
      sessions: changePercent(currentSessions.sessions, previousSessions.sessions)
    },
    trend: daily,
    funnel,
    eventCounts,
    recommendations: {
      impressions,
      clicks: recommendationClicks,
      ctr: percent(recommendationClicks, impressions),
      attributedTryOns: Number(countByType.get('try_on')?.recommendationAttributed || 0),
      attributedShopClicks: Number(countByType.get('shop_click')?.recommendationAttributed || 0),
      coverageProducts: recommendationProducts.size,
      catalogProducts,
      coverageRate: percent(recommendationProducts.size, catalogProducts),
      categoryDiversity: recommendationCategories.length,
      brandDiversity: recommendationBrands.length,
      coldStartImpressions: Number(coverage.coldStart || 0),
      coldStartRate: percent(coverage.coldStart, impressions),
      sources: (eventFacet?.recommendationSources || []).map((row) => ({ source: row._id || 'unknown', impressions: row.impressions, clicks: row.clicks, ctr: percent(row.clicks, row.impressions) })),
      algorithmVersions: (eventFacet?.algorithmVersions || []).map((row) => ({ version: row._id, impressions: row.impressions, clicks: row.clicks, ctr: percent(row.clicks, row.impressions) }))
    },
    generation,
    topProducts: (eventFacet?.topProducts || []).map((row) => ({
      id: String(row._id),
      name: row.name,
      brand: row.brand,
      category: row.category,
      events: row.events,
      weight: Math.round(Number(row.weight || 0) * 10) / 10,
      views: row.views,
      clicks: row.clicks,
      recommendationImpressions: row.recommendationImpressions,
      recommendationClicks: row.recommendationClicks,
      recommendationCtr: percent(row.recommendationClicks, row.recommendationImpressions),
      wishlists: row.wishlists,
      tryOns: row.tryOns,
      shopClicks: row.shopClicks,
      engagementRate: percent(Number(row.wishlists || 0) + Number(row.tryOns || 0) + Number(row.shopClicks || 0), Math.max(Number(row.views || 0), 1))
    })),
    searches: (eventFacet?.searches || []).map((row) => {
      const clickRow = searchClicks.get(row._id) || {};
      const searchedSessions = new Set((row.sessions || []).filter(Boolean).map(String));
      const clickedSessions = new Set((clickRow.sessions || []).filter(Boolean).map(String));
      const convertedSessions = [...clickedSessions].filter((session) => searchedSessions.has(session)).length;
      const clickRate = searchedSessions.size
        ? percent(convertedSessions, searchedSessions.size)
        : percent(Math.min(Number(clickRow.clicks || 0), Number(row.count || 0)), row.count);
      return { query: row._id, count: row.count, users: row.users?.length || 0, zeroResults: row.zeroResults, clicks: Number(clickRow.clicks || 0), clickRate, lastAt: row.lastAt };
    }),
    topCategories,
    topBrands,
    topTags,
    topGenders,
    recentEvents: recentEvents.map((event) => ({
      id: String(event._id),
      type: event.type,
      query: event.query || '',
      source: event.source || '',
      weight: Number(event.weight || 0),
      product: event.product ? { name: event.product.name, brand: event.product.brand, category: event.product.category } : null,
      createdAt: event.createdAt
    }))
  };
}

export { FUNNEL_STAGES, changePercent, fillDailyTrend, loadAdminAnalytics, percent };
