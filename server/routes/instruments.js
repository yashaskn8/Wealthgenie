import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { rankWtiProfileSchema, validateStrict } from '../validation/financialSchemas.js';
import { instrumentListQuerySchema, validateQuery } from '../validation/schemas.js';
import Instrument from '../models/Instrument.js';
import FinancialProfile from '../models/FinancialProfile.js';
import { getCache, setCache } from '../config/redis.js';
import { serializeCachedInstrumentPage, serializeInstrumentPage } from '../services/instrumentDto.js';
import { rankWtiAgainstCurrentState } from '../services/currentWtiRanking.js';
import logger from '../utils/logger.js';

const router = Router();

const SAFE_WTI_TIMING_STAGES = new Set([
  'rank_wti_request',
  'amfi_current_fetch',
  'amfi_current_persistence',
  'amfi_historical_fetch',
  'amfi_historical_persistence',
  'exact_etf_qualification',
  'product_qualification',
  'tax_enrichment',
]);
const SAFE_WTI_TIMING_STATUSES = new Set([
  'COMPLETED', 'ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'MALFORMED_JSON', 'HTTP_UNKNOWN',
  'AVAILABLE', 'PARTIAL', 'UNAVAILABLE', 'PROVIDER_NOT_CONFIGURED', 'SOURCE_ERROR',
  'NOT_PERSISTED', 'NOT_REQUESTED', 'PERSISTED', 'PERSISTENCE_ERROR',
  'PERSISTENCE_UNAVAILABLE', 'VERIFIED_COMPARABLE_OPTIONS', 'EVIDENCE_RANKED',
]);
const SAFE_WTI_TIMING_CODES = new Set([
  'ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'ESOCKETTIMEDOUT', 'HTTP_STATUS', 'MARKET_PERSISTENCE_FAILED', 'NO_HTTP_RESPONSE',
  'RECOMMENDATION_PARENT_MISMATCH', 'FINANCIAL_STATE_CHANGED', 'UND_ERR_CONNECT_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'MARKET_PERSISTENCE_COALESCED', 'PERSISTENCE_NOT_REQUESTED',
]);

export function sanitizeWtiTiming(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || !SAFE_WTI_TIMING_STAGES.has(event.stage)
      || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) return null;

  const status = typeof event.status === 'string' && SAFE_WTI_TIMING_STATUSES.has(event.status)
    ? event.status
    : typeof event.status === 'string' && /^HTTP_[1-5]\d{2}$/.test(event.status)
      ? event.status
      : 'UNKNOWN';
  const sanitized = {
    stage: event.stage,
    elapsedMs: Math.min(600_000, Math.round(event.elapsedMs)),
    status,
  };
  if (typeof event.code === 'string' && SAFE_WTI_TIMING_CODES.has(event.code)) sanitized.code = event.code;
  if (event.provider === 'AMFI') sanitized.provider = 'AMFI';
  return sanitized;
}

function safeWtiTimingCode(value) {
  return typeof value === 'string' && SAFE_WTI_TIMING_CODES.has(value) ? value : undefined;
}

function recordRankWtiTiming(req, res, next) {
  const startedAt = performance.now();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    try {
      const status = Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599
        ? res.statusCode
        : 500;
      logger.info('WTI request timing', {
        stage: 'rank_wti_request',
        elapsedMs: Math.min(600_000, Math.max(0, Math.round(performance.now() - startedAt))),
        httpStatus: status,
        ...(safeWtiTimingCode(req.wtiTimingCode) ? { code: safeWtiTimingCode(req.wtiTimingCode) } : {}),
      });
    } catch { /* observability must not affect the response */ }
  };
  res.once('finish', record);
  res.once('close', record);
  next();
}

// Allowed sort fields to prevent injection via sort parameter
const ALLOWED_SORT_FIELDS = new Set(['name', 'interestRate', 'returns1yr', 'returns3yr', 'returns5yr', 'riskLevel', 'aumCr', 'expenseRatio']);

/**
 * GET /api/instruments [Public]
 * List instruments with filtering, sorting, and pagination.
 */
router.get('/', validateQuery(instrumentListQuerySchema), asyncHandler(async (req, res) => {
  const { type, category, subCategory, sort, order, limit, page } = req.query;

  const cacheKey = `instruments:public-v3:${JSON.stringify([type ?? null, category ?? null, subCategory ?? null, sort ?? 'name', order ?? 'asc', page ?? 1, limit ?? 20])}`;

  // Check Redis cache
  const cached = await getCache(cacheKey);
  const cachedPage = serializeCachedInstrumentPage(cached);
  if (cachedPage) return res.json(cachedPage);

  // Build query
  const query = {};
  if (type) query.type = type;
  if (category) query.category = category;
  if (subCategory) query.subCategory = subCategory;

  // Validate sort field to prevent NoSQL injection
  const sortField = (sort === 'rate' ? 'interestRate' : sort) || 'name';
  const safeSortField = ALLOWED_SORT_FIELDS.has(sortField) ? sortField : 'name';
  const sortOrder = order === 'desc' ? -1 : 1;

  // Pagination with bounds
  const pageSize = limit === undefined ? 20 : Number(limit);
  const pageNum = page === undefined ? 1 : Number(page);
  const skip = (pageNum - 1) * pageSize;

  const [instruments, total] = await Promise.all([
    Instrument.find(query).sort({ [safeSortField]: sortOrder, id: 1 }).skip(skip).limit(pageSize).lean(),
    Instrument.countDocuments(query),
  ]);

  const result = serializeInstrumentPage({ instruments, total, page: pageNum, pageSize });

  // Bound category-refresh staleness until explicit catalog version invalidation is available.
  await setCache(cacheKey, result, 300);

  res.json(result);
}));

/**
 * POST /api/instruments/rank-wti [Protected]
 * Returns a suitability-filtered, source-qualified product comparison. Phase 2
 * supports exact AMFI mutual-fund categories and fails closed for other classes.
 */
router.post('/rank-wti', recordRankWtiTiming, verifyJWT, validateStrict(rankWtiProfileSchema), asyncHandler(async (req, res) => {
  const {
    profileId,
    profileVersion,
    recommendationId,
    expectedAllocationRevision,
    expectedAllocationRevisionId,
    expectedPortfolioFingerprint,
    expectedRecommendationFingerprint,
    parentInstrumentId,
    taxCalculationContext,
  } = req.body;
  const profile = await FinancialProfile.findOne({ _id: profileId, userId: req.user.userId }).lean();
  if (!profile) {
    return sendError(req, res, 404, 'Profile not found or access denied', 'PROFILE_NOT_FOUND');
  }

  const requestedBinding = {
    profileId: String(profileId),
    profileVersion: Number(profileVersion),
    recommendationId: String(recommendationId),
    allocationRevision: Number(expectedAllocationRevision),
    allocationRevisionId: String(expectedAllocationRevisionId),
    portfolioFingerprint: expectedPortfolioFingerprint,
    recommendationFingerprint: expectedRecommendationFingerprint,
  };
  let result;
  try {
    result = await rankWtiAgainstCurrentState({
      userId: req.user.userId,
      profileId,
      parentInstrumentId,
      expectedBinding: requestedBinding,
      taxCalculationContext,
      dependencies: {
        onStageTiming: timing => {
          const safeTiming = sanitizeWtiTiming(timing);
          if (safeTiming) logger.info('WTI stage timing', safeTiming);
        },
      },
    });
  } catch (error) {
    req.wtiTimingCode = safeWtiTimingCode(error?.code);
    if (['FINANCIAL_STATE_CHANGED', 'RECOMMENDATION_PARENT_MISMATCH'].includes(error?.code)) {
      return sendError(req, res, error.status || 409, error.clientMessage || error.message, error.code);
    }
    throw error;
  }

  return res.json({
    success: true,
    financialStateBinding: result.financialStateBinding,
    total: result.ranked.length,
    products: result.ranked,
    excluded: result.ranked.metadata?.excluded || [],
    suitability: result.ranked.metadata?.riskReconciliation || null,
    catalog: result.ranked.metadata?.catalog || null,
    ranking: result.ranked.metadata?.ranking || null,
    comparisonUniverse: result.ranked.metadata?.comparisonUniverse || null,
  });
}));

export default router;
