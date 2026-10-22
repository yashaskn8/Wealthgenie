import crypto from 'crypto';

/**
 * The only user-controlled facts permitted to cross the investment-suitability
 * boundary.  Keep this list closed: new database or transport fields are not
 * recommendation inputs until this contract is deliberately versioned.
 */
export const RECOMMENDATION_PROFILE_KEYS = Object.freeze([
  'monthlyTakeHome',
  'monthlySavings',
  'age',
  'riskTolerance',
  'soldPropertyProceeds',
  'hasLumpSum',
  'lumpSumAmount',
  'liquidSavings',
  'emiBurdenPct',
  'financialDependents',
  'emergencyFundMonths',
  'investmentGoals',
  'investmentHorizonYears',
]);

export const OPTIONAL_RECOMMENDATION_PROFILE_KEYS = Object.freeze([
  'soldPropertyProceeds',
  'hasLumpSum',
  'lumpSumAmount',
  'liquidSavings',
  'emiBurdenPct',
  'financialDependents',
  'emergencyFundMonths',
]);

const ML_REQUIRED_PROFILE_KEYS = Object.freeze([
  'hasLumpSum',
  'liquidSavings',
  'emiBurdenPct',
  'financialDependents',
  'emergencyFundMonths',
]);

export const SUPPORTED_INVESTMENT_GOALS = Object.freeze([
  'Retirement',
  'Wealth Growth',
  'Tax Saving',
  'Emergency Fund',
]);

export const FINANCIAL_PROFILE_SCHEMA_VERSION = 'financial-profile-1.1.0';
export const RECOMMENDATION_POLICY_VERSION = 'suitability-freeze-1.2.0';

const GOALS = new Set(SUPPORTED_INVESTMENT_GOALS);
const RISKS = new Set(['Conservative', 'Moderate', 'Aggressive']);

const ALIASES = Object.freeze({
  // monthlyIncome/monthly_income were historically the application's monthly
  // cash-flow field. Plain `income` is intentionally excluded because old
  // callers used it for both monthly and annual amounts.
  monthlyTakeHome: ['monthlyTakeHome', 'monthly_take_home', 'monthlyIncome', 'monthly_income'],
  monthlySavings: ['monthlySavings', 'monthly_savings', 'savings'],
  age: ['age'],
  riskTolerance: ['riskTolerance', 'risk_tolerance'],
  soldPropertyProceeds: ['soldPropertyProceeds', 'sold_property_proceeds', 'soldPropertyAmount', 'sold_property_amount'],
  hasLumpSum: ['hasLumpSum', 'has_lump_sum'],
  lumpSumAmount: ['lumpSumAmount', 'lump_sum_amount'],
  liquidSavings: ['liquidSavings', 'liquid_savings'],
  // Only ratio-valued aliases are equivalent. Historical existingDebt /
  // existing_debt fields were amounts in some records and must never be
  // guessed to be percentages.
  emiBurdenPct: ['emiBurdenPct', 'emi_burden_pct', 'existing_debt_emi_ratio_pct'],
  financialDependents: ['financialDependents', 'financial_dependents', 'dependents'],
  emergencyFundMonths: ['emergencyFundMonths', 'emergency_fund_months'],
  investmentGoals: ['investmentGoals', 'investment_goals', 'coreInvestmentGoals', 'goals'],
  investmentHorizonYears: ['investmentHorizonYears', 'investment_horizon_years', 'investmentHorizon', 'investment_horizon'],
});

export class RecommendationProfileValidationError extends Error {
  constructor(details) {
    super(`Invalid recommendation profile: ${details.join('; ')}`);
    this.name = 'RecommendationProfileValidationError';
    this.code = 'RECOMMENDATION_PROFILE_INVALID';
    this.details = details;
  }
}

function sourceObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.toObject === 'function' ? value.toObject({ virtuals: false }) : value;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function aliasValuesEquivalent(key, left, right) {
  if (left === null || right === null) return left === right;
  if (key === 'investmentGoals') {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  }
  if (['riskTolerance', 'hasLumpSum'].includes(key)) return left === right;
  const leftNumber = asFiniteNumber(left);
  const rightNumber = asFiniteNumber(right);
  return leftNumber !== null && rightNumber !== null && leftNumber === rightNumber;
}

function asFiniteNumber(value) {
  if (value === '' || value === undefined || value === null || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * PICK-only normalizer. It never spreads a raw document and it intentionally
 * has no suitability-changing defaults. Missing core facts and invalid supplied
 * facts fail closed; omitted optional facts remain explicitly unknown.
 */
export function buildRecommendationProfile(rawProfile) {
  const source = sourceObject(rawProfile);
  if (!source) throw new RecommendationProfileValidationError(['profile must be an object']);

  const picked = {};
  const errors = [];
  for (const key of RECOMMENDATION_PROFILE_KEYS) {
    const definedAliases = ALIASES[key]
      .filter(alias => Object.prototype.hasOwnProperty.call(source, alias) && source[alias] !== undefined)
      .map(alias => ({ alias, value: source[alias] }));
    if (definedAliases.length > 1
        && definedAliases.slice(1).some(entry => !aliasValuesEquivalent(key, definedAliases[0].value, entry.value))) {
      errors.push(`conflicting aliases for ${key}: ${definedAliases.map(entry => entry.alias).join(', ')}`);
    }
    picked[key] = firstDefined(source, ALIASES[key]);
  }

  const requiredNumberFields = [
    'monthlyTakeHome', 'monthlySavings', 'age', 'investmentHorizonYears',
  ];
  for (const key of requiredNumberFields) {
    const parsed = asFiniteNumber(picked[key]);
    if (parsed === null) errors.push(`${key} is required and must be a finite number`);
    picked[key] = parsed;
  }
  const optionalNumberFields = [
    'soldPropertyProceeds', 'lumpSumAmount', 'liquidSavings', 'emiBurdenPct',
    'financialDependents', 'emergencyFundMonths',
  ];
  for (const key of optionalNumberFields) {
    const rawValue = picked[key];
    const parsed = asFiniteNumber(rawValue);
    if (rawValue !== undefined && rawValue !== null && rawValue !== '' && parsed === null) {
      errors.push(`${key} must be a finite number when provided`);
    }
    picked[key] = parsed;
  }

  if (picked.monthlyTakeHome !== null && (!(picked.monthlyTakeHome > 0) || picked.monthlyTakeHome > 100000000)) errors.push('monthlyTakeHome must be greater than 0 and no more than 100000000');
  if (picked.monthlySavings !== null && (!(picked.monthlySavings > 0) || picked.monthlySavings > 100000000)) errors.push('monthlySavings must be greater than 0 and no more than 100000000');
  if (picked.monthlySavings !== null && picked.monthlyTakeHome !== null && picked.monthlySavings >= picked.monthlyTakeHome) {
    errors.push('monthlySavings must be less than monthlyTakeHome');
  }
  if (!Number.isInteger(picked.age) || picked.age < 18 || picked.age > 80) errors.push('age must be an integer from 18 to 80');
  if (!RISKS.has(picked.riskTolerance)) errors.push('riskTolerance must be Conservative, Moderate, or Aggressive');
  if (picked.soldPropertyProceeds !== null && (picked.soldPropertyProceeds < 0 || picked.soldPropertyProceeds > 10000000000)) errors.push('soldPropertyProceeds must be from 0 to 10000000000');
  if (picked.hasLumpSum === undefined || picked.hasLumpSum === '') picked.hasLumpSum = null;
  if (picked.hasLumpSum !== null && typeof picked.hasLumpSum !== 'boolean') errors.push('hasLumpSum must be a boolean or null');
  if (picked.lumpSumAmount !== null && (picked.lumpSumAmount < 0 || picked.lumpSumAmount > 10000000000)) errors.push('lumpSumAmount must be from 0 to 10000000000');
  if (picked.hasLumpSum === false && picked.lumpSumAmount !== 0) errors.push('lumpSumAmount must equal 0 when hasLumpSum is false');
  if (picked.hasLumpSum === true && !(picked.lumpSumAmount > 0)) errors.push('lumpSumAmount must be greater than 0 when hasLumpSum is true');
  if (picked.hasLumpSum === null && picked.lumpSumAmount !== null) errors.push('lumpSumAmount must be null when hasLumpSum is unknown');
  if (picked.liquidSavings !== null && (picked.liquidSavings < 0 || picked.liquidSavings > 1000000000)) errors.push('liquidSavings must be from 0 to 1000000000');
  if (picked.emiBurdenPct !== null && (picked.emiBurdenPct < 0 || picked.emiBurdenPct > 100)) errors.push('emiBurdenPct must be from 0 to 100');
  if (picked.financialDependents !== null
      && (!Number.isInteger(picked.financialDependents) || picked.financialDependents < 0 || picked.financialDependents > 15)) errors.push('financialDependents must be an integer from 0 to 15');
  if (picked.emergencyFundMonths !== null && (picked.emergencyFundMonths < 0 || picked.emergencyFundMonths > 120)) errors.push('emergencyFundMonths must be from 0 to 120');
  if (!Array.isArray(picked.investmentGoals) || picked.investmentGoals.length === 0) {
    errors.push('investmentGoals must contain at least one supported goal');
  } else {
    const unsupported = picked.investmentGoals.filter(goal => !GOALS.has(goal));
    if (unsupported.length) errors.push(`unsupported investmentGoals: ${[...new Set(unsupported)].join(', ')}`);
    if (new Set(picked.investmentGoals).size !== picked.investmentGoals.length) errors.push('investmentGoals must not contain duplicates');
  }
  if (!Number.isInteger(picked.investmentHorizonYears) || picked.investmentHorizonYears < 1 || picked.investmentHorizonYears > 30) {
    errors.push('investmentHorizonYears must be an integer from 1 to 30');
  }

  if (errors.length) throw new RecommendationProfileValidationError(errors);

  const canonical = {
    monthlyTakeHome: picked.monthlyTakeHome,
    monthlySavings: picked.monthlySavings,
    age: picked.age,
    riskTolerance: picked.riskTolerance,
    soldPropertyProceeds: picked.soldPropertyProceeds,
    hasLumpSum: picked.hasLumpSum,
    lumpSumAmount: picked.hasLumpSum === true ? picked.lumpSumAmount : picked.hasLumpSum === false ? 0 : null,
    liquidSavings: picked.liquidSavings,
    emiBurdenPct: picked.emiBurdenPct,
    financialDependents: picked.financialDependents,
    emergencyFundMonths: picked.emergencyFundMonths,
    investmentGoals: Object.freeze(SUPPORTED_INVESTMENT_GOALS.filter(goal => picked.investmentGoals.includes(goal))),
    investmentHorizonYears: picked.investmentHorizonYears,
  };
  return Object.freeze(canonical);
}

export function deriveRecommendationMetrics(profileInput) {
  const profile = buildRecommendationProfile(profileInput);
  return Object.freeze({
    savingsRate: profile.monthlySavings / profile.monthlyTakeHome,
    monthlyDiscretionaryAfterSavings: profile.monthlyTakeHome - profile.monthlySavings,
    estimatedMonthlyEmi: profile.emiBurdenPct === null
      ? null
      : profile.monthlyTakeHome * profile.emiBurdenPct / 100,
    deployableLumpSum: profile.hasLumpSum === true
      ? profile.lumpSumAmount
      : profile.hasLumpSum === false ? 0 : null,
    liquidityBuffer: profile.liquidSavings,
    emergencyCoverageMonths: profile.emergencyFundMonths,
  });
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function buildRecommendationProfileHash(profileInput, versions) {
  const profile = buildRecommendationProfile(profileInput);
  if (!versions || typeof versions.modelVersion !== 'string' || !versions.modelVersion.trim()) {
    throw new TypeError('modelVersion is required when building a recommendation profile hash');
  }
  const payload = {
    profile,
    modelVersion: versions.modelVersion,
    policyVersion: versions.policyVersion ?? RECOMMENDATION_POLICY_VERSION,
    schemaVersion: FINANCIAL_PROFILE_SCHEMA_VERSION,
  };
  return crypto.createHash('sha256').update(canonicalStringify(payload)).digest('hex');
}

export function toProfileApiResponse(rawProfile) {
  const profile = buildRecommendationProfile(rawProfile);
  return {
    profileId: rawProfile?._id ? String(rawProfile._id) : rawProfile?.profileId,
    version: rawProfile?.version ?? 1,
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
    monthly_investment_capacity: profile.monthlySavings,
    one_time_investment_capacity: profile.hasLumpSum === true
      ? profile.lumpSumAmount
      : profile.hasLumpSum === false ? 0 : null,
    profile_schema_version: FINANCIAL_PROFILE_SCHEMA_VERSION,
  };
}

export function toProfilePersistence(rawProfile, suitability) {
  const profile = buildRecommendationProfile(rawProfile);
  if (!suitability || !Number.isFinite(suitability.capacityScore)
      || !Number.isInteger(suitability.capacityLevel)
      || typeof suitability.finalRisk !== 'string'
      || !Array.isArray(suitability.reasonCodes)) {
    throw new TypeError('Complete deterministic suitability output is required for profile persistence');
  }
  return {
    monthlyTakeHome: profile.monthlyTakeHome,
    monthlySavings: profile.monthlySavings,
    age: profile.age,
    riskTolerance: profile.riskTolerance,
    soldPropertyProceeds: profile.soldPropertyProceeds,
    hasLumpSum: profile.hasLumpSum,
    lumpSumAmount: profile.lumpSumAmount,
    liquidSavings: profile.liquidSavings,
    emiBurdenPct: profile.emiBurdenPct,
    financialDependents: profile.financialDependents,
    emergencyFundMonths: profile.emergencyFundMonths,
    investmentGoals: [...profile.investmentGoals],
    investmentHorizonYears: profile.investmentHorizonYears,
    riskCapacityScore: suitability.capacityScore,
    riskCapacityLevel: suitability.capacityLevel,
    finalSuitabilityRisk: suitability.finalRisk,
    suitabilityReasonCodes: [...suitability.reasonCodes],
    recommendationProfileVersion: FINANCIAL_PROFILE_SCHEMA_VERSION,
  };
}

export function buildMlProfileInput(profileInput, suitability) {
  const profile = buildRecommendationProfile(profileInput);
  const missingFields = getMissingMlProfileFields(profile);
  if (missingFields.length > 0) {
    throw new RecommendationProfileValidationError([
      `ML input unavailable because optional facts are unknown: ${missingFields.join(', ')}`,
    ]);
  }
  const metrics = deriveRecommendationMetrics(profile);
  return Object.freeze({
    feature_schema_version: 'recommendation-features-4.0.0',
    age: profile.age,
    monthly_take_home: profile.monthlyTakeHome,
    monthly_savings: profile.monthlySavings,
    liquid_savings: profile.liquidSavings,
    emi_burden_pct: profile.emiBurdenPct,
    financial_dependents: profile.financialDependents,
    emergency_fund_months: profile.emergencyFundMonths,
    risk_tolerance: profile.riskTolerance,
    investment_goals: [...profile.investmentGoals],
    investment_horizon_years: profile.investmentHorizonYears,
    deployable_lump_sum: metrics.deployableLumpSum,
    risk_capacity_score: suitability.capacityScore,
    final_suitability_risk: suitability.finalRisk,
  });
}

export function getMissingMlProfileFields(profileInput) {
  const profile = buildRecommendationProfile(profileInput);
  const missing = ML_REQUIRED_PROFILE_KEYS.filter(key => profile[key] === null);
  if (profile.hasLumpSum === true && profile.lumpSumAmount === null) missing.push('lumpSumAmount');
  return Object.freeze(missing);
}

export function getUnknownOptionalProfileFields(profileInput) {
  const profile = buildRecommendationProfile(profileInput);
  return Object.freeze(OPTIONAL_RECOMMENDATION_PROFILE_KEYS.filter(key => profile[key] === null));
}

export function buildLlmFinancialContext(profileInput, suitability) {
  const profile = buildRecommendationProfile(profileInput);
  const metrics = deriveRecommendationMetrics(profile);
  return Object.freeze({
    monthlyTakeHome: profile.monthlyTakeHome,
    monthlySavings: profile.monthlySavings,
    savingsRate: metrics.savingsRate,
    age: profile.age,
    riskTolerance: profile.riskTolerance,
    suitabilityRisk: suitability.finalRisk,
    liquidSavings: profile.liquidSavings,
    emiBurdenPct: profile.emiBurdenPct,
    financialDependents: profile.financialDependents,
    emergencyFundMonths: profile.emergencyFundMonths,
    investmentGoals: [...profile.investmentGoals],
    investmentHorizonYears: profile.investmentHorizonYears,
    deployableLumpSum: metrics.deployableLumpSum,
    suitabilityReasonCodes: [...suitability.reasonCodes],
    taxEligibilityStatus: 'NOT_EVALUATED',
  });
}

export function buildProfileGroundedSimulation(profileInput, request) {
  const profile = buildRecommendationProfile(profileInput);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new RecommendationProfileValidationError(['simulation request must be an object']);
  }
  const requestedMonthly = asFiniteNumber(request.monthlyInvestment);
  if (!(requestedMonthly > 0) || requestedMonthly > profile.monthlySavings) {
    throw new RecommendationProfileValidationError([
      `monthlyInvestment must be greater than 0 and no more than monthlySavings (${profile.monthlySavings})`,
    ]);
  }
  const requestedYears = asFiniteNumber(request.years);
  if (!Number.isInteger(requestedYears) || requestedYears < 1 || requestedYears > profile.investmentHorizonYears) {
    throw new RecommendationProfileValidationError([
      `years must be an integer from 1 to the profile horizon (${profile.investmentHorizonYears})`,
    ]);
  }
  return Object.freeze({
    classification: 'PROFILE_GROUNDED',
    monthlyContribution: requestedMonthly,
    initialCapital: profile.hasLumpSum === true ? profile.lumpSumAmount : 0,
    years: requestedYears,
  });
}
