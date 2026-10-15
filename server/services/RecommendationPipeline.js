import { investmentDatabase, CONCENTRATION_CAPS } from '../data/investmentDatabase.js';
import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from './instrumentConstants.js';
import { buildRecommendationProfile } from './recommendationProfile.js';
import { assessSuitabilityRisk } from './riskProfiler.js';
import {
  fetchAmfiHistoricalNavSnapshot,
  fetchAmfiProductSnapshot,
  fetchGovernmentSavingsSnapshot,
  fetchSbiTermDepositSnapshot,
  fetchRbiFloatingRateSavingsBondSnapshot,
} from './marketDataService.js';
import {
  rankVerifiedMutualFundProducts,
  supportsAmfiParentCategory,
} from './mutualFundProductRanking.js';
import {
  rankQualifiedNiftyEtfProducts,
  supportsQualifiedEtfParentCategory,
} from './niftyEtfProductRanking.js';
import {
  compareVerifiedFixedIncomeProducts,
  fixedIncomeProviderForParent,
  supportsFixedIncomeParentCategory,
} from './fixedIncomeProductRanking.js';
import { enrichProductsWithPostTaxAndSuitability } from './productPostTaxCalculator.js';
import { PROVIDERS } from './marketData/contracts.js';
import { resolvePostTaxProviderRights } from './postTaxSourceRights.js';

function reportPipelineTiming(onStageTiming, stage, startedAt, status = 'COMPLETED', error = null) {
  if (typeof onStageTiming !== 'function') return;
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : null;
  const safeStatus = typeof status === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(status)
    ? status
    : 'COMPLETED';
  try {
    onStageTiming({
      stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      status: safeStatus,
      ...(code ? { code } : {}),
    });
  } catch { /* diagnostics must not change recommendation behavior */ }
}

export const PIPELINE_CONFIG = Object.freeze({
  version: 'recommendation-pipeline-4.0.0',
  topN: 8,
  scoreWeights: Object.freeze({
    expectedReturn: 0.25,
    riskFit: 0.25,
    liquidity: 0.15,
    goalFit: 0.15,
    horizonFit: 0.10,
    cost: 0.05,
  }),
});

export const INSTRUMENT_KEY_MAP = Object.freeze({
  ppf: 'PPF', scss: 'SCSS', sukanya: 'SSY', ssy: 'SSY', rbi_bonds: 'RBI_Bond',
  rbi_retail_direct_gilt: 'G-Sec', g_sec: 'G-Sec', sgb: 'SGB', nps: 'NPS',
});

const RISK_LABEL_SCORE = Object.freeze({
  'Very Low': 1, Low: 1, 'Low-Medium': 2, 'Medium-Low': 2,
  Medium: 3, 'Medium-High': 4, High: 4, 'Very High': 5,
});

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isEstablishedNumber = value => (
  value !== null && value !== undefined && value !== '' && typeof value !== 'boolean'
  && Number.isFinite(Number(value))
);

export function resolveBackendType(instrument = {}) {
  const id = String(instrument.id || '').toLowerCase();
  if (INSTRUMENT_KEY_MAP[id]) return INSTRUMENT_KEY_MAP[id];
  if (instrument.recommendationType === null) return null;
  const recommendationType = String(instrument.recommendationType || '');
  if (INSTRUMENT_PARAMS[recommendationType]) return recommendationType;
  const explicit = String(instrument.type || '');
  if (INSTRUMENT_PARAMS[explicit]) return explicit;
  return null;
}

export function resolveInstrumentModelKey(input) {
  const key = String(input || '').trim();
  if (!key) return null;

  const exactCatalog = investmentDatabase.find(instrument => instrument.id === key);
  if (exactCatalog) return resolveBackendType(exactCatalog);

  return INSTRUMENT_PARAMS[key] ? key : null;
}

function supportedGoalTags(instrument = {}) {
  const tags = instrument.goalTags ?? instrument.dynamicData?.goalTags;
  if (!Array.isArray(tags)) throw new TypeError('Instrument goal classification is not established');
  return [...new Set(tags.filter(tag => [
    'Retirement', 'Wealth Growth', 'Tax Saving', 'Emergency Fund',
  ].includes(tag)))];
}

export function getInstrumentRisk(instrument = {}) {
  const numeric = Number(instrument.dynamicData?.risk?.value ?? instrument.riskLevel ?? instrument.risk);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 5) return numeric;
  const label = instrument.dynamicData?.risk?.level || instrument.riskLabel || instrument.riskLevel || instrument.risk;
  return RISK_LABEL_SCORE[label] ?? null;
}

export function instrumentRiskTier(instrument = {}) {
  const score = getInstrumentRisk(instrument);
  if (score === null) return 'UNKNOWN';
  if (score <= 2) return 'LOW';
  if (score === 3) return 'MEDIUM';
  return 'HIGH';
}

export function reconcileRisk(profileInput) {
  const suitability = assessSuitabilityRisk(profileInput);
  return {
    final_risk_tier: suitability.finalRisk,
    final_score: suitability.finalLevel,
    capacity_score: suitability.capacityScore,
    capacity_tier: suitability.capacityRisk,
    preference_score: suitability.preferenceLevel,
    preference_tier: suitability.preferenceRisk,
    reconciliation_note: suitability.finalLevel < suitability.preferenceLevel
      ? 'Risk capacity reduced the stated risk preference.'
      : 'Risk preference is within measured capacity.',
    advisory_note: suitability.finalLevel < suitability.preferenceLevel
      ? 'Recommendations are capped below the stated preference because of financial capacity.'
      : '',
    reason_codes: [...suitability.reasonCodes],
    excluded_due_to_eligibility: [],
  };
}

function eligibilityExclusionReason(instrument, profile) {
  if (!instrument.eligibility || typeof instrument.eligibility !== 'object'
      || Array.isArray(instrument.eligibility)) return 'ELIGIBILITY_NOT_ESTABLISHED';
  const eligibility = instrument.eligibility;
  const requiredEligibilityFields = [
    'minAge', 'maxAge', 'minAnnualIncome', 'minMonthlySavings', 'hasGirlChild', 'requiresDemat',
  ];
  if (requiredEligibilityFields.some(field => !Object.hasOwn(eligibility, field))) {
    return 'ELIGIBILITY_NOT_ESTABLISHED';
  }
  const minAgeEstablished = eligibility.minAge === null || (isEstablishedNumber(eligibility.minAge)
    && Number(eligibility.minAge) >= 0 && Number(eligibility.minAge) <= 120);
  const maxAgeEstablished = eligibility.maxAge === null || (isEstablishedNumber(eligibility.maxAge)
    && Number(eligibility.maxAge) >= 0 && Number(eligibility.maxAge) <= 120);
  const minIncomeEstablished = isEstablishedNumber(eligibility.minAnnualIncome)
    && Number(eligibility.minAnnualIncome) >= 0;
  const minMonthlyEstablished = isEstablishedNumber(eligibility.minMonthlySavings)
    && Number(eligibility.minMonthlySavings) >= 0;
  const childRequirementEstablished = eligibility.hasGirlChild === null
    || typeof eligibility.hasGirlChild === 'boolean';
  const dematRequirementEstablished = eligibility.requiresDemat === null
    || typeof eligibility.requiresDemat === 'boolean';
  if (!minAgeEstablished || !maxAgeEstablished || !minIncomeEstablished || !minMonthlyEstablished
      || !childRequirementEstablished || !dematRequirementEstablished) {
    return 'ELIGIBILITY_NOT_ESTABLISHED';
  }
  if (eligibility.minAge !== null && eligibility.maxAge !== null
      && Number(eligibility.minAge) > Number(eligibility.maxAge)) return 'ELIGIBILITY_NOT_ESTABLISHED';
  if (eligibility.minAge !== null && profile.age < Number(eligibility.minAge)) return 'MINIMUM_AGE_NOT_MET';
  if (eligibility.maxAge !== null && profile.age > Number(eligibility.maxAge)) return 'MAXIMUM_AGE_EXCEEDED';
  if (Number(eligibility.minAnnualIncome) > 0) return 'GROSS_INCOME_ELIGIBILITY_NOT_ESTABLISHED';
  if (eligibility.hasGirlChild === true) return 'GIRL_CHILD_ELIGIBILITY_NOT_ESTABLISHED';
  if (eligibility.requiresDemat === true) return 'DEMAT_ELIGIBILITY_NOT_ESTABLISHED';

  if (profile.monthlySavings < Number(eligibility.minMonthlySavings)) return 'MINIMUM_INVESTMENT_NOT_MET';
  return null;
}

function exclusionReason(instrument, profile, finalLevel) {
  if (!resolveBackendType(instrument)) return 'INSTRUMENT_TYPE_NOT_ESTABLISHED';
  const risk = getInstrumentRisk(instrument);
  if (risk === null) return 'RISK_CLASSIFICATION_NOT_ESTABLISHED';
  if (risk > finalLevel) return 'RISK_EXCEEDS_FINAL_SUITABILITY';

  const expectedReturn = instrument.expectedReturn ?? instrument.dynamicData?.expectedReturn?.avg;
  if (!isEstablishedNumber(expectedReturn)) return 'RETURN_ASSUMPTION_NOT_ESTABLISHED';
  const liquidityScore = instrument.liquidityScore ?? instrument.dynamicData?.liquidity?.score;
  if (!isEstablishedNumber(liquidityScore)
      || Number(liquidityScore) < 0 || Number(liquidityScore) > 5) return 'LIQUIDITY_CLASSIFICATION_NOT_ESTABLISHED';
  const expenseRatio = instrument.expenseRatio ?? instrument.dynamicData?.expenseRatio;
  if (!isEstablishedNumber(expenseRatio)
      || Number(expenseRatio) < 0 || Number(expenseRatio) > 1) return 'COST_ASSUMPTION_NOT_ESTABLISHED';
  const goalTags = instrument.goalTags ?? instrument.dynamicData?.goalTags;
  if (!Array.isArray(goalTags)) return 'GOAL_CLASSIFICATION_NOT_ESTABLISHED';

  const eligibilityReasonCode = eligibilityExclusionReason(instrument, profile);
  if (eligibilityReasonCode) return eligibilityReasonCode;

  const minimumHorizonRaw = instrument.idealHorizon?.min ?? instrument.dynamicData?.idealHorizon?.min;
  const maximumHorizonRaw = instrument.idealHorizon?.max ?? instrument.dynamicData?.idealHorizon?.max;
  const lockInRaw = instrument.lockIn ?? instrument.dynamicData?.liquidity?.lockIn;
  if (!isEstablishedNumber(minimumHorizonRaw) || Number(minimumHorizonRaw) < 0) return 'MINIMUM_HORIZON_NOT_ESTABLISHED';
  if (!isEstablishedNumber(maximumHorizonRaw) || Number(maximumHorizonRaw) < Number(minimumHorizonRaw)) return 'MAXIMUM_HORIZON_NOT_ESTABLISHED';
  if (!isEstablishedNumber(lockInRaw) || Number(lockInRaw) < 0) return 'LOCK_IN_NOT_ESTABLISHED';
  const minimumHorizon = Number(minimumHorizonRaw);
  const lockIn = Number(lockInRaw);
  if (Number.isFinite(minimumHorizon) && minimumHorizon > profile.investmentHorizonYears) return 'HORIZON_BELOW_MINIMUM';
  if (Number.isFinite(lockIn) && lockIn > profile.investmentHorizonYears) return 'LOCK_IN_EXCEEDS_HORIZON';
  return null;
}

export function filterEligible(instruments, profileInput, reconciledTier = null) {
  const profile = buildRecommendationProfile(profileInput);
  const finalLevel = reconciledTier ?? assessSuitabilityRisk(profile).finalLevel;
  const eligible = [];
  const excluded = [];
  for (const instrument of instruments || []) {
    const reasonCode = exclusionReason(instrument, profile, finalLevel);
    if (reasonCode) excluded.push({ id: instrument.id, name: instrument.name, reasonCode });
    else eligible.push(instrument);
  }
  return { eligible, excluded };
}

export function parseProfile(profileInput) {
  const profile = buildRecommendationProfile(profileInput);
  const suitability = assessSuitabilityRisk(profile);
  return Object.freeze({
    age: profile.age,
    monthlyTakeHome: profile.monthlyTakeHome,
    monthlySavings: profile.monthlySavings,
    risk: suitability.finalRisk,
    riskLevel: suitability.finalLevel,
    horizon: profile.investmentHorizonYears,
    goals: [...profile.investmentGoals],
    liquidSavings: profile.liquidSavings,
    emergencyFundMonths: profile.emergencyFundMonths,
    emiBurdenPct: profile.emiBurdenPct,
    financialDependents: profile.financialDependents,
  });
}

export function deriveWeights(parsedProfile) {
  const shortHorizon = parsedProfile.horizon <= 3;
  const emergencyPriority = parsedProfile.goals.includes('Emergency Fund')
    || parsedProfile.emergencyFundMonths === null
    || parsedProfile.emergencyFundMonths < 3;
  const goalWeight = parsedProfile.goals.length > 1 ? 0.17 : 0.13;
  const weights = {
    expectedReturn: shortHorizon ? 0.15 : 0.25,
    riskFit: parsedProfile.riskLevel <= 2 ? 0.32 : 0.25,
    liquidity: emergencyPriority ? 0.24 : 0.15,
    goalFit: goalWeight,
    horizonFit: shortHorizon ? 0.14 : 0.10,
    cost: 0.05,
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.freeze(Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, value / total])));
}

export const scoreReturn = instrument => {
  const value = Number(instrument.expectedReturn ?? instrument.dynamicData?.expectedReturn?.avg);
  if (!Number.isFinite(value)) throw new TypeError('Instrument expected return is not established');
  return clamp(value / 20 * 100, 0, 100);
};
export const scoreRisk = (instrument, profile) => clamp(100 - Math.abs(getInstrumentRisk(instrument) - profile.riskLevel) * 20, 0, 100);
export const scoreLiquidity = instrument => {
  const value = Number(instrument.liquidityScore ?? instrument.dynamicData?.liquidity?.score);
  if (!Number.isFinite(value)) throw new TypeError('Instrument liquidity classification is not established');
  return clamp(value * 20, 0, 100);
};
export const scoreCost = instrument => {
  const value = Number(instrument.expenseRatio ?? instrument.dynamicData?.expenseRatio);
  if (!Number.isFinite(value)) throw new TypeError('Instrument cost assumption is not established');
  return clamp(100 - value * 2000, 0, 100);
};
export const scoreGoal = (instrument, profile) => {
  const tags = supportedGoalTags(instrument);
  return profile.goals.some(goal => tags.includes(goal)) ? 100 : 35;
};
export const scoreHorizon = (instrument, profile) => {
  const range = instrument.idealHorizon || instrument.dynamicData?.idealHorizon || {};
  if (!Number.isFinite(Number(range.min)) || !Number.isFinite(Number(range.max))) {
    throw new TypeError('Instrument horizon classification is not established');
  }
  return profile.horizon >= Number(range.min) && profile.horizon <= Number(range.max) ? 100 : 40;
};
export function normaliseConfidenceScores(mlResult = {}) {
  const source = mlResult.confidence_scores || mlResult.confidenceScores || {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`ML confidence for ${key} must be between 0 and 1`);
    }
    result[key] = value;
  }
  return result;
}

export function computeInstrumentScore(instrument, profile, weights) {
  const factors = {
    expectedReturn: scoreReturn(instrument),
    riskFit: scoreRisk(instrument, profile),
    liquidity: scoreLiquidity(instrument),
    goalFit: scoreGoal(instrument, profile),
    horizonFit: scoreHorizon(instrument, profile),
    cost: scoreCost(instrument),
  };
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + factors[key] * weight, 0);
  return { score: round(score), factors };
}

export function rankInstruments(instruments, profile, weights) {
  return [...instruments].map(instrument => ({
    instrument,
    ...computeInstrumentScore(instrument, profile, weights),
  })).sort((a, b) => b.score - a.score || String(a.instrument.id).localeCompare(String(b.instrument.id)));
}

export function enforceDiversity(ranked, topN = PIPELINE_CONFIG.topN, minAssetClasses = 3) {
  const selected = ranked.slice(0, topN);
  const represented = new Set(selected.map(row => row.instrument.assetClass || row.instrument.category));
  if (represented.size >= minAssetClasses) return selected;
  for (const candidate of ranked.slice(topN)) {
    const assetClass = candidate.instrument.assetClass || candidate.instrument.category;
    if (!represented.has(assetClass)) {
      selected[selected.length - 1] = candidate;
      represented.add(assetClass);
      if (represented.size >= minAssetClasses) break;
    }
  }
  return selected.sort((a, b) => b.score - a.score);
}

export function resolveConcentrationCap(instrument = {}) {
  const text = `${instrument.id || ''} ${instrument.type || ''} ${instrument.name || ''}`.toLowerCase();
  const entries = [
    ['smallcap_mf', /small.?cap/], ['midcap_mf', /mid.?cap/], ['direct_equity', /direct.?equity|stock/],
    ['sgb', /sovereign gold|\bsgb\b/], ['gold_etf', /gold.*etf|etf.*gold/], ['nps', /\bnps\b|national pension/],
  ];
  const match = entries.find(([, pattern]) => pattern.test(text));
  if (!match) return null;
  return { key: match[0], maxPct: CONCENTRATION_CAPS[match[0]].maxPct };
}

export function enforceAllocationTargets(instruments) {
  if (!instruments.length) return instruments;
  if (instruments.some(item => !Number.isFinite(item.score))) {
    throw new TypeError('Every allocation candidate must have a finite score');
  }
  const totalScore = instruments.reduce((sum, item) => sum + Math.max(0, item.score), 0);
  if (totalScore <= 0) throw new RangeError('Allocation scores must contain a positive value');
  const allocations = instruments.map(item => ({
    ...item,
    allocation_pct: Math.max(0, item.score) / totalScore * 100,
  }));

  for (let pass = 0; pass < 10; pass += 1) {
    let overflow = 0;
    const groups = new Map();
    allocations.forEach((item, index) => {
      const cap = resolveConcentrationCap(item);
      if (!cap) return;
      if (!groups.has(cap.key)) groups.set(cap.key, { cap: cap.maxPct, indexes: [] });
      groups.get(cap.key).indexes.push(index);
    });
    const cappedIndexes = new Set();
    groups.forEach(group => {
      const total = group.indexes.reduce((sum, index) => sum + allocations[index].allocation_pct, 0);
      if (total > group.cap + 1e-8) {
        const scale = group.cap / total;
        group.indexes.forEach(index => {
          overflow += allocations[index].allocation_pct * (1 - scale);
          allocations[index].allocation_pct *= scale;
          cappedIndexes.add(index);
        });
      }
    });
    if (overflow < 1e-8) break;
    const recipients = allocations.map((_, index) => index).filter(index => !cappedIndexes.has(index) && !resolveConcentrationCap(allocations[index]));
    if (!recipients.length) {
      throw new RangeError('Concentration caps leave no uncapped instrument for the remaining allocation');
    }
    const base = recipients.reduce((sum, index) => sum + allocations[index].allocation_pct, 0);
    recipients.forEach(index => {
      allocations[index].allocation_pct += overflow * (base > 0 ? allocations[index].allocation_pct / base : 1 / recipients.length);
    });
  }

  const sum = allocations.reduce((total, item) => total + item.allocation_pct, 0);
  if (!Number.isFinite(sum) || sum <= 0) throw new RangeError('Capped allocations have no positive total');
  let assignedWeight = 0;
  const normalized = allocations.map((item, index) => {
    const allocationWeight = index === allocations.length - 1
      ? round(1 - assignedWeight, 4)
      : round(item.allocation_pct / sum, 4);
    if (allocationWeight < 0 || allocationWeight > 1) {
      throw new RangeError('Rounded allocation weights fall outside the valid range');
    }
    assignedWeight = round(assignedWeight + allocationWeight, 4);
    return {
      ...item,
      allocation_pct: round(allocationWeight * 100),
      allocationWeight,
    };
  });
  const grouped = new Map();
  normalized.forEach(item => {
    const cap = resolveConcentrationCap(item);
    if (cap) grouped.set(cap.key, (grouped.get(cap.key) || 0) + item.allocationWeight * 100);
  });
  for (const [key, total] of grouped.entries()) {
    const cap = CONCENTRATION_CAPS[key]?.maxPct;
    if (!Number.isFinite(cap) || total > cap + 0.01) {
      throw new RangeError(`Final allocation exceeds the ${key} concentration cap`);
    }
  }
  return normalized;
}

function presentationInstrument(row) {
  const instrument = row.instrument;
  const backendType = resolveBackendType(instrument);
  const nominalReturn = round(Number(instrument.expectedReturn ?? instrument.dynamicData?.expectedReturn?.avg));
  const riskScore = getInstrumentRisk(instrument);
  return {
    id: instrument.id,
    name: instrument.name,
    type: backendType,
    assetClass: instrument.assetClass || instrument.category,
    nominalReturn,
    effectiveYield: nominalReturn,
    postTaxReturn: null,
    returnBasis: 'PRE_TAX_NOMINAL',
    returnDataClass: PROJECTION_ASSUMPTION_DATA_CLASS,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: INSTRUMENT_PARAMS[backendType]?.assumptionHash || null,
    returnSource: PROJECTION_ASSUMPTION_SOURCE,
    observedMarketFact: false,
    providerForecast: false,
    expenseRatio: Number(instrument.expenseRatio ?? instrument.dynamicData?.expenseRatio),
    riskLevel: instrument.riskLabel || instrument.dynamicData?.risk?.level || `Risk ${riskScore}`,
    riskScore,
    lockIn: Number(instrument.lockIn ?? instrument.dynamicData?.liquidity?.lockIn),
    tags: supportedGoalTags(instrument),
    taxNotes: 'Tax impact is not personalized because gross taxable income and deductions are outside the Financial Profile.',
    score: row.score,
    scoreFactors: row.factors,
  };
}

export function runPipeline(profileInput, mlResult = {}, options = {}) {
  const canonical = buildRecommendationProfile(profileInput);
  const riskReconciliation = reconcileRisk(canonical);
  const parsed = parseProfile(canonical);
  const computedWeights = deriveWeights(parsed);
  // ML output is telemetry-only. Malformed or unavailable telemetry must not
  // affect whether the deterministic financial pipeline can produce a result.
  let confidenceScores = {};
  try {
    confidenceScores = normaliseConfidenceScores(mlResult);
  } catch {
    confidenceScores = {};
  }
  const { eligible, excluded } = filterEligible(investmentDatabase, canonical, riskReconciliation.final_score);
  const ranked = rankInstruments(eligible, parsed, computedWeights);
  const topN = options.topN === undefined ? PIPELINE_CONFIG.topN : options.topN;
  const minAssetClasses = options.minAssetClasses === undefined ? 3 : options.minAssetClasses;
  if (!Number.isInteger(topN) || topN < 1 || topN > 20) throw new RangeError('topN must be an integer from 1 to 20');
  if (!Number.isInteger(minAssetClasses) || minAssetClasses < 1 || minAssetClasses > topN) {
    throw new RangeError('minAssetClasses must be an integer from 1 to topN');
  }
  const selected = enforceDiversity(ranked, topN, minAssetClasses);
  const instruments = enforceAllocationTargets(selected.map(presentationInstrument));
  if (instruments.some(instrument => instrument.riskScore > riskReconciliation.final_score)) {
    throw new Error('Suitability invariant failed after ranking');
  }
  riskReconciliation.excluded_due_to_eligibility = excluded;
  return { instruments, confidenceScores, riskReconciliation, computedWeights };
}

function attachWtiMetadata(products, metadata) {
  Object.defineProperty(products, 'metadata', { value: metadata, enumerable: false });
  return products;
}

function historicalTargetDate(snapshot) {
  const candidates = (snapshot?.facts || [])
    .map(fact => Date.parse(fact?.observedAt))
    .filter(Number.isFinite);
  const reference = candidates.length > 0
    ? new Date(Math.max(...candidates))
    : new Date(snapshot?.fetchedAt);
  if (Number.isNaN(reference.getTime())) return null;
  reference.setUTCFullYear(reference.getUTCFullYear() - 1);
  return reference.toISOString().slice(0, 10);
}

function referenceMetadata(parent) {
  return {
    dataClass: 'REFERENCE_METADATA',
    title: `Where to invest in ${parent.name}`,
    note: 'Only qualified provider responses supply product facts. Legacy catalog instructions are not source-qualified and are unavailable.',
    howToStart: null,
    riskLevel: parent.riskScore,
  };
}

export function getWhereToInvestProviderCoverageMatrix() {
  return investmentDatabase.map(instrument => {
    const fixedIncomeProvider = fixedIncomeProviderForParent(instrument.id);
    const hasAmfiProductPath = supportsAmfiParentCategory(instrument.id)
      || supportsQualifiedEtfParentCategory(instrument.id);
    const provider = fixedIncomeProvider || (hasAmfiProductPath ? PROVIDERS.AMFI : null);
    const sourceRights = provider ? resolvePostTaxProviderRights(provider) : null;
    const canBeRecommended = resolveBackendType(instrument) !== null && getInstrumentRisk(instrument) !== null;
    return {
      parentInstrumentId: instrument.id,
      parentName: instrument.name,
      canBeRecommended,
      category: instrument.category,
      provider,
      qualifiedWtiProvider: provider,
      productOptionsAvailable: Boolean(provider),
      sourceRightsStatus: sourceRights?.status || 'SOURCE_UNAVAILABLE',
      productionSourceUseAllowed: sourceRights?.productionPostTaxUseAllowed === true,
      sourceRightsTerms: sourceRights?.termsUrls || [],
      status: provider ? 'QUALIFIED_PROVIDER_PATH' : 'UNSUPPORTED_FAIL_CLOSED',
      currentFailureMode: provider
        ? 'QUALIFIED_PROVIDER_RESPONSE_REQUIRED'
        : 'NO_QUALIFIED_WTI_PROVIDER_FAIL_CLOSED',
      identityAuthority: supportsQualifiedEtfParentCategory(instrument.id) ? 'NSE_SCHEME_DISCLOSURE' : null,
      benchmarkAuthority: supportsQualifiedEtfParentCategory(instrument.id) ? 'ISSUER_SCHEME_INVESTMENT_PHILOSOPHY' : null,
      productSubstitutionAllowed: false,
    };
  });
}

/**
 * WTI is an alternate presentation of the same hard parent-level suitability
 * decision. Phase 2 sources mutual-fund products and ranking evidence from
 * AMFI. The legacy catalog contributes reference text only.
 */
export async function rankWhereToInvestBackend(profileInput, options = {}, dependencies = {}) {
  const canonical = buildRecommendationProfile(profileInput);
  const riskReconciliation = reconcileRisk(canonical);
  const catalog = investmentDatabase.find(instrument => String(instrument.id) === String(options.parentInstrumentId));
  const excluded = [];
  if (!catalog) {
    excluded.push({
      id: options.parentInstrumentId,
      reasonCode: 'CATALOG_INSTRUMENT_NOT_ESTABLISHED',
    });
    return attachWtiMetadata([], { excluded, riskReconciliation, catalog: null, ranking: null });
  }
  const reasonCode = exclusionReason(catalog, canonical, riskReconciliation.final_score);
  if (reasonCode) {
    excluded.push({ id: catalog.id, name: catalog.name, reasonCode });
    return attachWtiMetadata([], { excluded, riskReconciliation, catalog: null, ranking: null });
  }

  const parent = { id: catalog.id, name: catalog.name, riskScore: getInstrumentRisk(catalog), suitabilityStatus: 'PASSED' };
  const catalogMetadata = {
    ...referenceMetadata(parent),
    providerCoverage: getWhereToInvestProviderCoverageMatrix().find(item => item.parentInstrumentId === catalog.id),
  };
  const taxCalculationContext = options.taxCalculationContext
    ? {
      ...options.taxCalculationContext,
      // The persisted Financial Profile is the server-owned age fact used for
      // old-regime slab selection; do not trust a client override.
      userAge: canonical.age,
    }
    : null;
  const formatOutput = (resultProducts, metadata) => {
    const startedAt = performance.now();
    try {
      const enriched = enrichProductsWithPostTaxAndSuitability(resultProducts, {
        profile: canonical,
        parentCatalog: parent,
        taxCalculationContext,
        enforceSourceRights: dependencies.isProductionEnvironment ?? (process.env.NODE_ENV === 'production'),
      });
      reportPipelineTiming(dependencies.onStageTiming, 'tax_enrichment', startedAt);
      return attachWtiMetadata(enriched, metadata);
    } catch (error) {
      reportPipelineTiming(dependencies.onStageTiming, 'tax_enrichment', startedAt, 'ERROR', error);
      throw error;
    }
  };

  if (supportsFixedIncomeParentCategory(catalog.id)) {
    const provider = fixedIncomeProviderForParent(catalog.id);
    const productionEnvironment = dependencies.isProductionEnvironment ?? (process.env.NODE_ENV === 'production');
    const sourceRights = resolvePostTaxProviderRights(provider);
    if (productionEnvironment && !sourceRights.productionPostTaxUseAllowed) {
      const disclosure = 'This official data source is not cleared for WealthGenie production display or post-tax calculations. Product data remains unavailable until its exact reuse permissions are verified.';
      return formatOutput([], {
        excluded,
        riskReconciliation,
        catalog: catalogMetadata,
        ranking: {
          version: 'wti-source-rights-gate-1.0.0',
          status: 'UNAVAILABLE',
          authority: 'NONE',
          method: null,
          hasUniqueLeader: false,
          reasonCodes: ['SOURCE_RIGHTS_UNQUALIFIED'],
          warning: disclosure,
        },
        comparisonUniverse: {
          parentInstrumentId: catalog.id,
          sourceProvider: provider,
          returnedProductCount: 0,
          sourceRightsStatus: sourceRights.status,
          productionSourceUseAllowed: false,
          disclosure,
        },
      });
    }
    let fetchSnapshot = null;
    if (provider === PROVIDERS.GOVERNMENT_OF_INDIA) {
      fetchSnapshot = dependencies.fetchGovernmentSavingsSnapshot || fetchGovernmentSavingsSnapshot;
    } else if (provider === PROVIDERS.SBI) {
      fetchSnapshot = dependencies.fetchSbiTermDepositSnapshot || fetchSbiTermDepositSnapshot;
    } else if (provider === PROVIDERS.RBI) {
      fetchSnapshot = dependencies.fetchRbiFloatingRateSavingsBondSnapshot || fetchRbiFloatingRateSavingsBondSnapshot;
    }

    if (!fetchSnapshot) {
      const result = compareVerifiedFixedIncomeProducts({
        parentInstrumentId: catalog.id,
        snapshot: null,
        profile: canonical,
        now: dependencies.now || new Date(),
      });
      return formatOutput(result.products, {
        excluded,
        riskReconciliation,
        catalog: catalogMetadata,
        ranking: result.ranking,
        comparisonUniverse: result.comparisonUniverse,
      });
    }

    const snapshot = await fetchSnapshot();
    const result = compareVerifiedFixedIncomeProducts({
      parentInstrumentId: catalog.id,
      snapshot,
      profile: canonical,
      now: dependencies.now || new Date(),
    });
    return formatOutput(result.products, {
      excluded,
      riskReconciliation,
      catalog: catalogMetadata,
      ranking: result.ranking,
      comparisonUniverse: result.comparisonUniverse,
    });
  }

  const hasQualifiedEtfPath = supportsQualifiedEtfParentCategory(catalog.id);
  if (!supportsAmfiParentCategory(catalog.id) && !hasQualifiedEtfPath) {
    const result = rankVerifiedMutualFundProducts({
      parentInstrumentId: catalog.id,
      currentSnapshot: null,
      historicalSnapshot: null,
    });
    return formatOutput(result.products, {
      excluded,
      riskReconciliation,
      catalog: catalogMetadata,
      ranking: result.ranking,
      comparisonUniverse: result.comparisonUniverse,
    });
  }

  const productionEnvironment = dependencies.isProductionEnvironment ?? (process.env.NODE_ENV === 'production');
  const sourceRights = resolvePostTaxProviderRights(PROVIDERS.AMFI);
  if (productionEnvironment && !sourceRights.productionPostTaxUseAllowed) {
    const disclosure = 'AMFI data-use rights have not been qualified for WealthGenie production display or post-tax calculations. No fund or ETF data is shown until the required permission is recorded.';
    return formatOutput([], {
      excluded,
      riskReconciliation,
      catalog: catalogMetadata,
      ranking: {
        version: 'wti-source-rights-gate-1.0.0',
        status: 'UNAVAILABLE',
        authority: 'NONE',
        method: null,
        hasUniqueLeader: false,
        reasonCodes: ['SOURCE_RIGHTS_UNQUALIFIED'],
        warning: disclosure,
      },
      comparisonUniverse: {
        parentInstrumentId: catalog.id,
        sourceProvider: PROVIDERS.AMFI,
        returnedProductCount: 0,
        sourceRightsStatus: sourceRights.status,
        productionSourceUseAllowed: false,
        disclosure,
      },
    });
  }

  const fetchCurrent = dependencies.fetchAmfiProductSnapshot || fetchAmfiProductSnapshot;
  const fetchHistorical = dependencies.fetchAmfiHistoricalNavSnapshot || fetchAmfiHistoricalNavSnapshot;
  const persistAmfiSnapshots = dependencies.persistAmfiSnapshots !== false;
  const currentSnapshot = await fetchCurrent({
    onStageTiming: dependencies.onStageTiming,
    persist: persistAmfiSnapshots,
  });
  const targetDate = historicalTargetDate(currentSnapshot);
  const historicalSnapshot = targetDate
    ? await fetchHistorical({
      targetDate,
      onStageTiming: dependencies.onStageTiming,
      persist: persistAmfiSnapshots,
    })
    : null;
  const qualificationStage = hasQualifiedEtfPath ? 'exact_etf_qualification' : 'product_qualification';
  const qualificationStartedAt = performance.now();
  let result;
  try {
    result = hasQualifiedEtfPath
      ? rankQualifiedNiftyEtfProducts({
        parentInstrumentId: catalog.id,
        currentSnapshot,
        historicalSnapshot,
      })
      : rankVerifiedMutualFundProducts({
        parentInstrumentId: catalog.id,
        currentSnapshot,
        historicalSnapshot,
        now: dependencies.now || new Date(),
      });
    reportPipelineTiming(dependencies.onStageTiming, qualificationStage, qualificationStartedAt,
      result.ranking?.status || 'COMPLETED');
  } catch (error) {
    reportPipelineTiming(dependencies.onStageTiming, qualificationStage, qualificationStartedAt, 'ERROR', error);
    throw error;
  }
  return formatOutput(result.products, {
    excluded,
    riskReconciliation,
    catalog: catalogMetadata,
    ranking: result.ranking,
    comparisonUniverse: result.comparisonUniverse,
  });
}

export function assertPortfolioSuitable(profileInput, instruments) {
  const canonical = buildRecommendationProfile(profileInput);
  const suitability = assessSuitabilityRisk(canonical);
  const violations = [];
  for (const input of instruments || []) {
    const exactCatalog = investmentDatabase.find(instrument => instrument.id === input);
    const mappedCatalogEntries = investmentDatabase.filter(instrument => resolveBackendType(instrument) === input);
    const mappedCatalog = mappedCatalogEntries[0] || null;
    if (exactCatalog) {
      const reasonCode = exclusionReason(exactCatalog, canonical, suitability.finalLevel);
      if (reasonCode) violations.push({ instrument: input, reasonCode });
      continue;
    }
    const modelParams = INSTRUMENT_PARAMS[input];
    if (modelParams) {
      // A unique model-key mapping is still a specific catalog product. Preserve
      // its explicit age, contribution, child, and account-eligibility gates
      // before applying the generic model risk and lock-in checks.
      if (mappedCatalogEntries.length === 1) {
        const eligibilityReasonCode = eligibilityExclusionReason(mappedCatalog, canonical);
        if (eligibilityReasonCode) violations.push({ instrument: input, reasonCode: eligibilityReasonCode });
      }
      const risk = getInstrumentRisk(modelParams);
      if (risk === null) violations.push({ instrument: input, reasonCode: 'RISK_CLASSIFICATION_NOT_ESTABLISHED' });
      else if (risk > suitability.finalLevel) violations.push({ instrument: input, reasonCode: 'RISK_EXCEEDS_FINAL_SUITABILITY' });
      else if (!Number.isFinite(modelParams.lockIn)) violations.push({ instrument: input, reasonCode: 'LOCK_IN_NOT_ESTABLISHED' });
      else if (modelParams.lockIn > canonical.investmentHorizonYears) violations.push({ instrument: input, reasonCode: 'LOCK_IN_EXCEEDS_HORIZON' });
      continue;
    }
    if (mappedCatalog) {
      const reasonCode = exclusionReason(mappedCatalog, canonical, suitability.finalLevel);
      if (reasonCode) violations.push({ instrument: input, reasonCode });
    } else {
      violations.push({ instrument: input, reasonCode: 'CATALOG_INSTRUMENT_NOT_ESTABLISHED' });
    }
  }
  if (violations.length) {
    const error = new Error('Portfolio contains instruments outside the profile suitability boundary.');
    error.code = 'PORTFOLIO_SUITABILITY_VIOLATION';
    error.violations = violations;
    throw error;
  }
  return suitability;
}

export const normalizeProfile = buildRecommendationProfile;

export default {
  runPipeline,
  rankWhereToInvestBackend,
  filterEligible,
  reconcileRisk,
  assertPortfolioSuitable,
};
