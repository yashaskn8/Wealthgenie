import crypto from 'crypto';
import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { getIncompleteProfileFallback, getMLPrediction } from './mlClient.js';
import {
  runPipeline,
  assertPortfolioSuitable,
  resolveConcentrationCap,
} from './RecommendationPipeline.js';
import { applyProfileSafeMarketContextAdjustment } from './regimeRotationEngine.js';
import { getLatestQualifiedMarketContextForRecommendation } from './marketContextService.js';
import {
  buildRecommendationProfile,
  buildRecommendationProfileHash,
  buildMlProfileInput,
  getMissingMlProfileFields,
  getUnknownOptionalProfileFields,
  deriveRecommendationMetrics,
  RECOMMENDATION_POLICY_VERSION,
  FINANCIAL_PROFILE_SCHEMA_VERSION,
} from './recommendationProfile.js';
import { assessSuitabilityRisk, RISK_CAPACITY_POLICY } from './riskProfiler.js';
import {
  RISK_FREE_RATE,
  DISCLAIMER,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_VERSION,
} from './instrumentConstants.js';
import { generatePortfolioProjection } from './projectionEngine.js';
import { getCurrentRegulatoryRuleVersion } from './taxEngine.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { normalizeAllocationWeights } from '../utils/allocationWeights.js';
import { persistRecommendationMarketAdjustment } from './recommendationMarketProvenance.js';

export const CORE_RECOMMENDATION_VERSION = 'core-recommendation-1.0.0';

function buildPortfolioReturnAssumption(instruments) {
  const weights = normalizeAllocationWeights(instruments.map(instrument => Number(instrument.allocationWeight)));
  return Number(instruments.reduce(
    (sum, instrument, index) => sum + Number(instrument.nominalReturn) * weights[index],
    0,
  ).toFixed(2));
}

function buildAssetClassAllocation(instruments) {
  const weights = normalizeAllocationWeights(instruments.map(instrument => Number(instrument.allocationWeight)));
  return Object.fromEntries(Object.entries(instruments.reduce((totals, instrument, index) => {
    const assetClass = instrument.assetClass || 'Other';
    totals[assetClass] = (totals[assetClass] || 0) + (weights[index] * 100);
    return totals;
  }, {})).map(([assetClass, percentage]) => [assetClass, Number(percentage.toFixed(2))]));
}

function buildDashboardProjection(profile, instruments) {
  const metrics = deriveRecommendationMetrics(profile);
  return generatePortfolioProjection({
    monthlyContribution: profile.monthlySavings,
    initialLumpSum: metrics.deployableLumpSum ?? 0,
    horizonYears: profile.investmentHorizonYears,
    instruments,
  });
}

function unavailableMarketAdjustment(reasonCode, marketContext = null) {
  return {
    status: 'UNAVAILABLE',
    contextStatus: marketContext?.status ?? 'MARKET_CONTEXT_UNAVAILABLE',
    context: marketContext?.context ?? null,
    policyVersion: marketContext?.policyVersion ?? null,
    observedAt: marketContext?.marketSnapshot?.observedAt ?? marketContext?.observedAt ?? null,
    evaluatedAt: marketContext?.evaluatedAt ?? null,
    reasonCodes: [reasonCode, ...(marketContext?.reasonCodes || [])],
    adjustmentVersion: 'market-context-adjustment-1.0.0',
    applied: false,
    maxTotalTiltPct: 0,
    actualTotalTiltPct: 0,
    suitabilityValidation: 'NOT_RUN',
    concentrationValidation: 'NOT_RUN',
  };
}

function buildMarketAdjustmentMetadata(adjustment, marketContext) {
  return {
    status: adjustment.applied ? 'APPLIED' : 'NOT_APPLIED',
    contextStatus: adjustment.contextStatus,
    context: adjustment.context,
    policyVersion: marketContext?.policyVersion ?? null,
    observedAt: marketContext?.marketSnapshot?.observedAt ?? marketContext?.observedAt ?? null,
    evaluatedAt: marketContext?.evaluatedAt ?? null,
    reasonCodes: adjustment.reasonCodes || [],
    adjustmentVersion: adjustment.adjustmentVersion,
    applied: adjustment.applied,
    maxTotalTiltPct: adjustment.maxTotalTiltPct,
    actualTotalTiltPct: adjustment.actualTotalTiltPct,
    baseWeights: adjustment.baseWeights,
    adjustedWeights: adjustment.adjustedWeights,
    changedInstruments: adjustment.explanations || [],
    suitabilityValidation: adjustment.suitabilityRevalidated ? 'PASSED' : 'NOT_RUN',
    concentrationValidation: adjustment.concentrationCapsRevalidated ? 'PASSED' : 'NOT_RUN',
    recommendationUsability: marketContext?.recommendationUsability ?? null,
  };
}

function currentAllocationSourceFor(marketAdjustment) {
  return marketAdjustment?.applied ? 'MARKET_CONTEXT_ADJUSTED' : 'ORIGINAL_RECOMMENDATION';
}

export function buildRecommendationCacheKey(userId, profileId, profile, modelVersion) {
  if (typeof modelVersion !== 'string' || !modelVersion.trim()) {
    throw new TypeError('A model version is required for recommendation cache keys');
  }
  return `recommendation:${userId}:${profileId}:${buildRecommendationProfileHash(profile, { modelVersion })}`;
}

export function canonicalAuditInputs(profile, suitability, modelVersion, regulatoryRuleVersion) {
  const metrics = deriveRecommendationMetrics(profile);
  return {
    financial_profile_schema_version: FINANCIAL_PROFILE_SCHEMA_VERSION,
    recommendation_policy_version: RECOMMENDATION_POLICY_VERSION,
    regulatory_rule_version: regulatoryRuleVersion,
    risk_capacity_policy_version: RISK_CAPACITY_POLICY.version,
    model_version: modelVersion,
    monthly_take_home: profile.monthlyTakeHome,
    monthly_savings: profile.monthlySavings,
    age: profile.age,
    risk_tolerance: profile.riskTolerance,
    sold_property_proceeds: profile.soldPropertyProceeds,
    has_lump_sum: profile.hasLumpSum,
    lump_sum_amount: profile.lumpSumAmount,
    liquid_savings: profile.liquidSavings,
    emi_burden_pct: profile.emiBurdenPct,
    financial_dependents: profile.financialDependents,
    emergency_fund_months: profile.emergencyFundMonths,
    investment_goals: [...profile.investmentGoals],
    investment_horizon_years: profile.investmentHorizonYears,
    deployable_lump_sum: metrics.deployableLumpSum,
    risk_capacity_score: suitability.capacityScore,
    final_suitability_risk: suitability.finalRisk,
    suitability_reason_codes: [...suitability.reasonCodes],
  };
}

function safeMarketContext(marketContext) {
  return marketContext;
}

export function marketContextIdentity(marketContext) {
  return canonicalSha256({
    schemaVersion: marketContext?.marketSnapshot?.schemaVersion ?? null,
    status: marketContext?.status ?? null,
    context: marketContext?.context ?? null,
    policyVersion: marketContext?.policyVersion ?? marketContext?.marketSnapshot?.policyOutput?.policyVersion ?? null,
    observedAt: marketContext?.marketSnapshot?.observedAt ?? marketContext?.observedAt ?? null,
  });
}

export async function readRecommendationMarketContext() {
  try {
    return await getLatestQualifiedMarketContextForRecommendation();
  } catch (error) {
    logger.warn('Recommendation market context read failed closed', { error: error.message });
    return {
      status: 'MARKET_CONTEXT_UNAVAILABLE',
      context: null,
      reasonCodes: ['MARKET_CONTEXT_READ_FAILED_CLOSED'],
      recommendationUsability: { status: 'NOT_USABLE', reasonCodes: ['MARKET_CONTEXT_READ_FAILED_CLOSED'] },
    };
  }
}

function assertConcentrationCaps(instruments) {
  const totals = new Map();
  for (const instrument of instruments || []) {
    const cap = resolveConcentrationCap(instrument);
    if (cap) totals.set(cap.key, (totals.get(cap.key) || 0) + Number(instrument.allocationWeight) * 100);
  }
  for (const [key, total] of totals.entries()) {
    const cap = resolveConcentrationCap(instruments.find(instrument => resolveConcentrationCap(instrument)?.key === key));
    if (cap && total > cap.maxPct + 0.01) {
      const error = new Error(`Final allocation exceeds ${key} concentration cap of ${cap.maxPct}%`);
      error.code = 'PORTFOLIO_CONCENTRATION_VIOLATION';
      throw error;
    }
  }
}

export function assertCoreResultFinalSafety(profileInput, coreResult) {
  const profile = buildRecommendationProfile(profileInput);
  const instruments = coreResult?.recommendationData?.instruments || coreResult?.response?.instruments || [];
  if (!Array.isArray(instruments) || instruments.length === 0) {
    throw new Error('Final recommendation contains no instruments');
  }
  assertPortfolioSuitable(profile, instruments.map(instrument => instrument.id));
  assertConcentrationCaps(instruments);
  const totalWeight = instruments.reduce((sum, instrument) => sum + Number(instrument.allocationWeight), 0);
  if (!Number.isFinite(totalWeight) || Math.abs(totalWeight - 1) > 0.001) {
    throw new Error('Final recommendation allocation weights are invalid');
  }
}

function makeRecommendationIds() {
  return {
    recommendationId: new mongoose.Types.ObjectId(),
    auditId: new mongoose.Types.ObjectId(),
  };
}

function buildCorePersistencePayload({
  profile,
  profileVersion,
  userId,
  profileId,
  correlationId,
  traceId,
  modelVersion,
  regulatoryRuleVersion,
  mlResult,
  pipelineResult,
  marketAdjustment,
  marketContext,
  response,
  recommendationId,
  auditId,
  timestamp,
}) {
  const { confidenceScores } = pipelineResult;
  const portfolioReturnAssumption = buildPortfolioReturnAssumption(pipelineResult.instruments);
  const inputHash = buildRecommendationProfileHash(profile, { modelVersion });
  const inputs = canonicalAuditInputs(profile, assessSuitabilityRisk(profile), modelVersion, regulatoryRuleVersion);
  return {
    recommendationData: {
      _id: recommendationId,
      userId,
      profileId,
      instruments: pipelineResult.instruments,
      advisoryText: null,
      advisoryMetadata: { status: 'PENDING' },
      confidenceScores,
      mlFallback: Boolean(mlResult.fallback),
      modelVersion,
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      regulatoryRuleVersion,
      profileInputHash: inputHash,
      profileVersion,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
      marketAdjustment: persistRecommendationMarketAdjustment(marketAdjustment, marketContext),
      currentAllocationSource: marketAdjustment.currentAllocationSource,
    },
    auditRecordData: {
      _id: auditId,
      userId,
      profileId,
      recommendationId,
      correlationId,
      traceId: traceId || '',
      version_id: modelVersion,
      regulatory_rule_version: regulatoryRuleVersion,
      input_hash: inputHash,
      inputs,
      recommendations: {
        instruments: pipelineResult.instruments,
        confidenceScores,
        portfolioReturnAssumption,
        returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
        returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
        modelVersion,
        recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
        marketAdjustment: persistRecommendationMarketAdjustment(marketAdjustment, marketContext),
        advisorySummary: '',
      },
      cited_rag_chunk_ids: mlResult.cited_chunk_ids || [],
      engine: mlResult.fallback ? 'rule_fallback' : 'ml_service',
      timestamp,
    },
    response: {
      ...response,
      profileId: String(profileId),
      recommendationId,
      audit_id: auditId,
      audit_hash: inputHash,
      return_assumption_hash: PROJECTION_ASSUMPTION_POLICY_HASH,
    },
  };
}

/**
 * The single non-persistent recommendation authority used by the legacy
 * recommendation endpoint, profile precompute, and profile completion.
 * It intentionally returns persistence-shaped data but performs no writes.
 */
export async function computeCoreRecommendation({
  canonicalProfile,
  profileVersion = null,
  userId,
  profileId = null,
  correlationId = null,
  traceId = null,
  userRole = null,
  marketContext: suppliedMarketContext = null,
} = {}) {
  const totalStart = performance.now();
  const profile = buildRecommendationProfile(canonicalProfile);
  const suitability = assessSuitabilityRisk(profile);
  const regulatoryRuleVersion = getCurrentRegulatoryRuleVersion();
  if (!regulatoryRuleVersion) {
    const error = new Error('No verified regulatory policy is available for the current fiscal year.');
    error.status = 503;
    error.clientMessage = 'Regulatory policy metadata is temporarily unavailable.';
    error.code = 'REGULATORY_POLICY_UNAVAILABLE';
    throw error;
  }

  const effectiveProfileId = profileId || new mongoose.Types.ObjectId();
  const missingMlProfileFields = getMissingMlProfileFields(profile);
  const unknownOptionalProfileFields = getUnknownOptionalProfileFields(profile);
  const mlStart = performance.now();
  const mlPromise = missingMlProfileFields.length > 0
    ? Promise.resolve(getIncompleteProfileFallback(profile, suitability))
    : getMLPrediction(
      buildMlProfileInput(profile, suitability),
      correlationId,
      userId,
      userRole,
    );
  const marketStart = performance.now();
  const marketPromise = suppliedMarketContext ? Promise.resolve(suppliedMarketContext) : readRecommendationMarketContext();
  const [mlResult, marketContext] = await Promise.all([mlPromise, marketPromise]);
  const ml = performance.now() - mlStart;
  const marketRead = performance.now() - marketStart;

  const modelVersion = mlResult.model_version;
  if (typeof modelVersion !== 'string' || !modelVersion.trim()) {
    const error = new Error('ML result did not include a model version');
    error.status = 502;
    error.clientMessage = 'Recommendation model metadata is unavailable.';
    error.code = 'ML_MODEL_VERSION_UNAVAILABLE';
    throw error;
  }

  const pipelineStart = performance.now();
  const pipelineResult = runPipeline(profile, mlResult);
  if (!pipelineResult.instruments.length) {
    const error = new Error('No instruments passed the suitability boundary');
    error.status = 422;
    error.clientMessage = 'No suitable instruments were found for this profile.';
    throw error;
  }

  let marketAdjustment;
  let adjustedInstruments = pipelineResult.instruments;
  try {
    const adjustment = applyProfileSafeMarketContextAdjustment({
      profile,
      instruments: pipelineResult.instruments,
      marketContext: safeMarketContext(marketContext),
    });
    adjustedInstruments = adjustment.adjustedInstruments;
    marketAdjustment = buildMarketAdjustmentMetadata(adjustment, marketContext);
  } catch (error) {
    logger.warn('Recommendation market adjustment failed closed', { error: error.message, code: error.code });
    marketAdjustment = unavailableMarketAdjustment('MARKET_CONTEXT_ADJUSTMENT_FAILED_CLOSED', marketContext);
  }

  const instruments = adjustedInstruments;
  assertPortfolioSuitable(profile, instruments.map(instrument => instrument.id));
  assertConcentrationCaps(instruments);
  marketAdjustment.currentAllocationSource = currentAllocationSourceFor(marketAdjustment);
  const pipeline = performance.now() - pipelineStart;

  const portfolioReturnAssumption = buildPortfolioReturnAssumption(instruments);
  const assetClassAllocation = buildAssetClassAllocation(instruments);
  const projectionStart = performance.now();
  const dashboardProjection = buildDashboardProjection(profile, instruments);
  const projection = performance.now() - projectionStart;
  const { confidenceScores, riskReconciliation, computedWeights } = pipelineResult;
  const { recommendationId, auditId } = makeRecommendationIds();
  const timestamp = new Date();
  const baseResponse = {
    instruments,
    ranked: true,
    advisory_text: null,
    advisory_explanation: { status: 'PENDING' },
    confidence_scores: confidenceScores,
    decision_path: mlResult.decision_path,
    explanation: mlResult.explanation || null,
    ml_fallback: Boolean(mlResult.fallback),
    model_version: modelVersion,
    recommendation_policy_version: RECOMMENDATION_POLICY_VERSION,
    financial_profile_schema_version: FINANCIAL_PROFILE_SCHEMA_VERSION,
    portfolio_return_assumption: portfolioReturnAssumption,
    return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    return_assumption_version: PROJECTION_ASSUMPTION_VERSION,
    return_assumption_source: PROJECTION_ASSUMPTION_SOURCE,
    return_assumption_hash: PROJECTION_ASSUMPTION_POLICY_HASH,
    observed_market_fact: false,
    provider_forecast: false,
    asset_class_allocation: assetClassAllocation,
    dashboard_projection: dashboardProjection,
    return_basis: 'PRE_TAX_NOMINAL',
    risk_free_rate: Number((RISK_FREE_RATE * 100).toFixed(2)),
    disclaimer: DISCLAIMER,
    final_risk_tier: riskReconciliation.final_risk_tier,
    capacity_score: riskReconciliation.capacity_score,
    preference_score: riskReconciliation.preference_score,
    reconciliation_note: riskReconciliation.reconciliation_note,
    advisory_note: riskReconciliation.advisory_note,
    suitability_reason_codes: riskReconciliation.reason_codes,
    optional_profile_fields_unknown: unknownOptionalProfileFields,
    ml_input_fields_unknown: missingMlProfileFields,
    excluded_due_to_eligibility: riskReconciliation.excluded_due_to_eligibility,
    // Generation-specific diagnostics must never impersonate a manual revision's choices.
    generation_candidate_counts: riskReconciliation.candidate_counts,
    generation_eligible_alternatives: riskReconciliation.eligible_not_selected,
    computed_weights: computedWeights,
    market_adjustment: marketAdjustment,
    current_allocation_source: marketAdjustment.currentAllocationSource,
  };
  const persistence = buildCorePersistencePayload({
    profile,
    profileVersion,
    userId,
    profileId: effectiveProfileId,
    correlationId: correlationId || traceId || crypto.randomUUID(),
    traceId: traceId || correlationId || '',
    modelVersion,
    regulatoryRuleVersion,
    mlResult,
    pipelineResult: { ...pipelineResult, instruments },
    marketAdjustment,
    marketContext,
    response: baseResponse,
    recommendationId,
    auditId,
    timestamp,
  });

  return {
    ...persistence,
    canonicalProfile: profile,
    suitability,
    modelVersion,
    regulatoryRuleVersion,
    marketContext,
    marketContextIdentity: marketContextIdentity(marketContext),
    profileInputHash: persistence.recommendationData.profileInputHash,
    recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
    financialProfileSchemaVersion: FINANCIAL_PROFILE_SCHEMA_VERSION,
    timings: {
      ml: Number(ml.toFixed(2)),
      marketContext: Number(marketRead.toFixed(2)),
      pipeline: Number(pipeline.toFixed(2)),
      projection: Number(projection.toFixed(2)),
      total: Number((performance.now() - totalStart).toFixed(2)),
    },
  };
}

/** Rebind a server-generated candidate result to the profile being committed. */
export function rebindCoreRecommendation(coreResult, { userId, profileId, correlationId, traceId } = {}) {
  const profile = buildRecommendationProfile(coreResult.canonicalProfile);
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const timestamp = new Date();
  const recommendationData = {
    ...coreResult.recommendationData,
    _id: recommendationId,
    userId,
    profileId,
  };
  const auditRecordData = {
    ...coreResult.auditRecordData,
    _id: auditId,
    userId,
    profileId,
    recommendationId,
    correlationId: correlationId || coreResult.auditRecordData.correlationId,
    traceId: traceId || coreResult.auditRecordData.traceId || '',
    timestamp,
  };
  const response = {
    ...coreResult.response,
    profileId: String(profileId),
    recommendationId,
    audit_id: auditId,
  };
  const rebound = {
    ...coreResult,
    canonicalProfile: profile,
    recommendationData,
    auditRecordData,
    response,
  };
  assertCoreResultFinalSafety(profile, rebound);
  return rebound;
}

export { buildPortfolioReturnAssumption, buildAssetClassAllocation, buildDashboardProjection };
