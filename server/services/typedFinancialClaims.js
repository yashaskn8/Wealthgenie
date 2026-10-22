const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FINANCIAL_NUMBER = /(?:[+\-−]\s*)?(?:₹\s*(?:[+\-−]\s*)?\d[\d,]*(?:\.\d+)?|\b(?:INR|Rs\.?)\s*(?:[+\-−]\s*)?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\b)/gi;
const CLAIM_FIELDS = Object.freeze([
  'type', 'value', 'unit', 'timePeriod', 'source', 'evidenceId',
  'jurisdiction', 'effectivePeriod', 'statement',
]);

export const FINANCIAL_CLAIM_TYPES = Object.freeze([
  'CURRENT_RATE', 'HISTORICAL_RETURN', 'EXPECTED_RETURN', 'PROJECTED_RETURN',
  'POST_TAX_RETURN', 'ALLOCATION_WEIGHT', 'TAX_RATE', 'CURRENT_COUPON',
  'MATURITY_AMOUNT', 'CONTRIBUTION', 'RISK_SCORE', 'GOAL_TARGET', 'GOAL_MONTHLY_BASELINE',
]);

export const FINANCIAL_CLAIM_UNITS = Object.freeze([
  'PERCENT', 'PERCENT_PER_ANNUM', 'INR', 'INR_PER_MONTH', 'SCORE',
]);

const INDIA_SOURCE_PROVIDERS = new Set(['AMFI', 'NSE', 'UPSTOX', 'GOVERNMENT_OF_INDIA', 'SBI', 'RBI']);
const CURRENT_RATE_CONTRACTS = Object.freeze({
  GOVERNMENT_OF_INDIA: {
    dataClass: 'QUARTERLY_OFFICIAL_RATE',
    rateBasis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM',
    productId: /^government:india-post:[a-z0-9-]+$/,
  },
  SBI: {
    dataClass: 'OFFICIAL_BANK_PUBLISHED_RATE',
    rateBasis: 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM',
    productId: /^deposit:sbi:retail-domestic:[a-z0-9-]+:(?:public|senior)$/,
  },
});
const RBI_FRSB_PRODUCT_ID = 'government:rbi:frsb-2020-taxable';
const VALID_POST_TAX_CLASSES = new Set([
  'CURRENT_RATE_POST_TAX_ILLUSTRATION',
  'HISTORICAL_RETURN_POST_TAX_ILLUSTRATION',
  'MODELLED_POST_TAX_PROJECTION',
  'TRANSACTION_TAX_ESTIMATE',
]);

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Keep the validator independent of floating-point division and independently
// recompute the monthly obligation in integer paise. Round *up* to the paise.
function checkedPaise(value) {
  if (!finite(value) || value < 0 || value > 100_000_000_000) return null;
  const scaled = Math.round(value * 100);
  if (!Number.isSafeInteger(scaled) || Math.abs(value - scaled / 100) > 1e-8) return null;
  return BigInt(scaled);
}

function exactGoalMonthlyAmount(target, savings, months) {
  const targetPaise = checkedPaise(target);
  const savedPaise = checkedPaise(savings);
  if (targetPaise === null || savedPaise === null || !Number.isSafeInteger(months)
      || months < 1 || targetPaise <= savedPaise) return null;
  return Number((targetPaise - savedPaise + BigInt(months) - 1n) / BigInt(months)) / 100;
}

function validIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function providerFor(entry) {
  return typeof entry?.source?.provider === 'string' && entry.source.provider.trim()
    ? entry.source.provider
    : null;
}

function sourceJurisdiction(entry, provider) {
  if (typeof entry?.source?.jurisdiction === 'string' && entry.source.jurisdiction.trim()) {
    return entry.source.jurisdiction.trim().toUpperCase();
  }
  return INDIA_SOURCE_PROVIDERS.has(provider) ? 'IN' : null;
}

function effectivePeriod(from, to) {
  return { from, to: to ?? null };
}

function expectedClaimForEvidence(entry, type) {
  if (!entry || typeof entry.id !== 'string' || !/^E_[A-Z0-9_:-]+$/.test(entry.id)) return null;
  const value = entry.value;
  const provider = providerFor(entry);
  const backendSource = entry.authority === 'WEALTHGENIE_BACKEND' ? entry.authority : null;
  const base = { type, evidenceId: entry.id };

  if (type === 'ALLOCATION_WEIGHT'
      && entry.kind === 'RECOMMENDATION'
      && entry.dataClass === 'AUTHORITATIVE_BACKEND_RESULT'
      && finite(value?.allocationPct)) {
    return { ...base, value: value.allocationPct, unit: 'PERCENT', timePeriod: 'CURRENT_PLAN', source: backendSource, jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'GOAL_TARGET'
      && entry.id === 'E_GOAL_STATED_TARGET'
      && entry.kind === 'GOAL_TARGET'
      && entry.dataClass === 'USER_INPUT'
      && finite(value?.targetAmount)
      && value.targetAmount > 0
      && ['CURRENT_USER_MESSAGE', 'TRUSTED_FINANCIAL_CHAT'].includes(value.sourceScope)
      && entry.authority === 'USER_INPUT') {
    return { ...base, value: value.targetAmount, unit: 'INR', timePeriod: 'STATED_GOAL',
      source: 'USER_INPUT', jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'GOAL_MONTHLY_BASELINE'
      && entry.id === 'E_GOAL_MONTHLY_BASELINE'
      && entry.kind === 'GOAL_CALCULATION'
      && entry.dataClass === 'DETERMINISTIC_NO_RETURN_ILLUSTRATION'
      && finite(value?.monthlyRequiredAmount) && value.monthlyRequiredAmount > 0
      && finite(value.targetAmount) && finite(value.earmarkedSavingsAmount)
      && Number.isSafeInteger(value.horizonMonths) && value.horizonMonths > 0
      && value.earmarkedSavingsAmount >= 0 && value.earmarkedSavingsAmount <= value.targetAmount
      && value.monthlyRequiredAmount === exactGoalMonthlyAmount(
        value.targetAmount, value.earmarkedSavingsAmount, value.horizonMonths)
      && value.assumedGrowthRate === null && value.inflationRate === null
      && value.returnForecast === false && ['CURRENT_USER_MESSAGE', 'TRUSTED_FINANCIAL_CHAT'].includes(value.sourceScope)
      && (value.scenario === 'DECLARED_SAVINGS'
        || (value.scenario === 'ZERO_START_CONDITIONAL' && value.earmarkedSavingsAmount === 0))
      && entry.authority === 'WEALTHGENIE_BACKEND') {
    return { ...base, value: value.monthlyRequiredAmount, unit: 'INR_PER_MONTH',
      timePeriod: 'MONTHLY_ZERO_RETURN_BASELINE', source: 'WEALTHGENIE_BACKEND',
      jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'CONTRIBUTION'
      && entry.id === 'E_PROFILE_SAVINGS'
      && entry.kind === 'PROFILE'
      && entry.dataClass === 'USER_INPUT'
      && finite(value)) {
    return { ...base, value, unit: 'INR_PER_MONTH', timePeriod: 'MONTHLY', source: 'USER_INPUT', jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'CURRENT_RATE'
      && entry.kind === 'PRODUCT_FACT'
      && CURRENT_RATE_CONTRACTS[provider]?.dataClass === entry.dataClass
      && CURRENT_RATE_CONTRACTS[provider].rateBasis === value?.rateBasis
      && CURRENT_RATE_CONTRACTS[provider].productId.test(value?.productId || '')
      && finite(value?.ratePctPerAnnum)
      && validIsoDate(value.effectiveFrom)
      && (value.effectiveTo == null || validIsoDate(value.effectiveTo))
      && provider && sourceJurisdiction(entry, provider)) {
    const period = effectivePeriod(value.effectiveFrom, value.effectiveTo);
    return { ...base, value: value.ratePctPerAnnum, unit: 'PERCENT_PER_ANNUM', timePeriod: `${period.from}/${period.to || 'OPEN'}`, source: provider, jurisdiction: sourceJurisdiction(entry, provider), effectivePeriod: period };
  }
  if (type === 'CURRENT_COUPON'
      && entry.kind === 'PRODUCT_FACT'
      && provider === 'RBI'
      && entry.dataClass === 'OFFICIAL_RBI_FLOATING_COUPON_RATE'
      && value?.productId === RBI_FRSB_PRODUCT_ID
      && value?.rateBasis === 'NSC_REFERENCE_RATE_PLUS_35_BPS'
      && finite(value?.ratePctPerAnnum)
      && validIsoDate(value.effectiveFrom)
      && (value.effectiveTo == null || validIsoDate(value.effectiveTo))
      && provider && sourceJurisdiction(entry, provider)) {
    const period = effectivePeriod(value.effectiveFrom, value.effectiveTo);
    return { ...base, value: value.ratePctPerAnnum, unit: 'PERCENT_PER_ANNUM', timePeriod: `${period.from}/${period.to || 'OPEN'}`, source: provider, jurisdiction: sourceJurisdiction(entry, provider), effectivePeriod: period };
  }
  if (type === 'HISTORICAL_RETURN'
      && entry.kind === 'HISTORICAL_RETURN'
      && entry.dataClass === 'VERIFIED_HISTORICAL_FACT'
      && finite(value?.historicalReturnPct)
      && validIsoDate(value.periodStart)
      && validIsoDate(value.periodEnd)
      && value.periodStart < value.periodEnd
      && typeof value.basis === 'string' && value.basis.trim()
      && provider && sourceJurisdiction(entry, provider)) {
    const period = effectivePeriod(value.periodStart, value.periodEnd);
    return { ...base, value: value.historicalReturnPct, unit: 'PERCENT', timePeriod: `${period.from}/${period.to}`, source: provider, jurisdiction: sourceJurisdiction(entry, provider), effectivePeriod: period };
  }
  if (type === 'EXPECTED_RETURN'
      && entry.kind === 'PROJECTION'
      && entry.dataClass === 'MODEL_ASSUMPTION'
      && value?.providerForecast === false
      && finite(value?.annualReturnAssumptionPct)
      && typeof value.assumptionVersion === 'string' && value.assumptionVersion.trim()
      && provider === 'WEALTHGENIE_MODEL_POLICY') {
    return { ...base, value: value.annualReturnAssumptionPct, unit: 'PERCENT', timePeriod: 'ANNUAL_MODEL_ASSUMPTION', source: provider, jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'PROJECTED_RETURN'
      && entry.kind === 'PROJECTION_RESULT'
      && entry.dataClass === 'SIMULATION'
      && finite(value?.projectedReturnPct)
      && finite(value?.horizonYears) && value.horizonYears > 0
      && provider === 'SIMULATION') {
    return { ...base, value: value.projectedReturnPct, unit: 'PERCENT', timePeriod: `HORIZON:${value.horizonYears}Y`, source: provider, jurisdiction: null, effectivePeriod: null };
  }
  if (type === 'POST_TAX_RETURN'
      && entry.kind === 'POST_TAX_RESULT'
      && entry.dataClass === 'AUTHORITATIVE_BACKEND_RESULT'
      && finite(value?.postTaxReturnPct)
      && VALID_POST_TAX_CLASSES.has(value?.calculationClass)
      && /^FY20\d{2}-\d{2}$/.test(value?.fiscalYear || '')
      && value?.jurisdiction === 'IN'
      && entry.authority === 'WEALTHGENIE_TAX_ENGINE') {
    return { ...base, value: value.postTaxReturnPct, unit: 'PERCENT', timePeriod: value.fiscalYear, source: entry.authority, jurisdiction: 'IN', effectivePeriod: null };
  }
  if (type === 'TAX_RATE'
      && entry.kind === 'TAX_POLICY'
      && entry.dataClass === 'DETERMINISTIC_BACKEND_RESULT'
      && finite(value?.taxRatePct)
      && /^FY20\d{2}-\d{2}$/.test(value?.fiscalYear || '')
      && value?.jurisdiction === 'IN'
      && entry.authority === 'WEALTHGENIE_TAX_ENGINE') {
    return { ...base, value: value.taxRatePct, unit: 'PERCENT', timePeriod: value.fiscalYear, source: entry.authority, jurisdiction: 'IN', effectivePeriod: null };
  }
  if (type === 'MATURITY_AMOUNT'
      && entry.kind === 'MATURITY_RESULT'
      && entry.dataClass === 'AUTHORITATIVE_BACKEND_RESULT'
      && finite(value?.maturityAmount)
      && validIsoDate(value?.maturityDate)
      && value?.jurisdiction === 'IN'
      && entry.authority === 'WEALTHGENIE_FIXED_INCOME_ENGINE') {
    return { ...base, value: value.maturityAmount, unit: 'INR', timePeriod: `MATURITY:${value.maturityDate}`, source: entry.authority, jurisdiction: 'IN', effectivePeriod: null };
  }
  if (type === 'RISK_SCORE'
      && entry.kind === 'SUITABILITY'
      && entry.dataClass === 'DERIVED_VALUE'
      && finite(value?.riskScore)
      && backendSource) {
    return { ...base, value: value.riskScore, unit: 'SCORE', timePeriod: 'CURRENT_PROFILE', source: backendSource, jurisdiction: null, effectivePeriod: null };
  }
  return null;
}

function inferredType(statement) {
  const text = String(statement || '').toLowerCase();
  const matches = [];
  const rules = [
    ['CURRENT_RATE', /\b(?:current|official|published)\s+(?:annual\s+)?rate\b/],
    ['HISTORICAL_RETURN', /\b(?:historical|trailing|past)\s+(?:one[- ]year\s+)?return\b/],
    ['EXPECTED_RETURN', /\bexpected\s+(?:annual\s+)?return\b/],
    ['PROJECTED_RETURN', /\bprojected\s+(?:annual\s+)?return\b/],
    ['POST_TAX_RETURN', /\bpost[- ]tax\s+(?:historical\s+)?return\b/],
    ['ALLOCATION_WEIGHT', /\b(?:allocation(?:\s+weight)?|portfolio\s+weight)\b/],
    ['TAX_RATE', /\btax rate\b/],
    ['CURRENT_COUPON', /\bcurrent coupon\b/],
    ['MATURITY_AMOUNT', /\bmaturity\s+(?:amount|value|proceeds)\b/],
    ['CONTRIBUTION', /\b(?:contribution|monthly savings)\b/],
    ['GOAL_TARGET', /\bgoal target\b/],
    ['GOAL_MONTHLY_BASELINE', /\bfunding-only baseline\b/],
    ['RISK_SCORE', /\brisk score\b/],
  ];
  for (const [type, pattern] of rules) if (pattern.test(text)) matches.push(type);
  return matches.length === 1 ? matches[0] : null;
}

function withoutKnownDateNumbers(text) {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?Z?)?)?\b/g, match => ' '.repeat(match.length))
    .replace(/\bFY\s*20\d{2}-\d{2}\b/gi, match => ' '.repeat(match.length))
    .replace(/\b(?:Regulations?|Acts?|Rules?),\s*(?:19|20)\d{2}\b/gi, match => ' '.repeat(match.length));
}

function financialMentions(text) {
  const source = withoutKnownDateNumbers(text);
  const mentions = [];
  for (const match of source.matchAll(FINANCIAL_NUMBER)) {
    const raw = match[0];
    const valueMatch = raw.match(/\d[\d,]*(?:\.\d+)?/);
    if (!valueMatch) continue;
    const signCharacters = raw.match(/[+\-−]/g) || [];
    if (signCharacters.length > 1) continue;
    const number = Number(valueMatch[0].replace(/,/g, ''));
    if (!Number.isFinite(number)) continue;
    const before = source.slice(Math.max(0, match.index - 42), match.index);
    const rangeSeparator = signCharacters.length === 1
      && /[-−]/.test(signCharacters[0])
      && /\d[\d,]*(?:\.\d+)?\s*$/.test(before);
    const signedNumber = signCharacters.length === 1 && /[-−]/.test(signCharacters[0]) && !rangeSeparator
      ? -number
      : number;
    const after = source.slice(match.index + raw.length, match.index + raw.length + 42);
    const markedCurrency = /₹|\bINR\s*|\bRs\.?\s*$/i.test(before);
    const markedPercent = /%/.test(raw);
    const decimalValue = valueMatch[0].includes('.');
    const integerDigits = valueMatch[0].replace(/\D/g, '').length;
    const yearLike = Number.isInteger(number) && number >= 1900 && number <= 2100;
    const context = `${before} ${after}`;
    const financialContext = Boolean(inferredType(context))
      || /\b(?:p\.a\.|per annum|per month|monthly|rupees?|amount|investment|corpus|savings|contribution|risk score|tax|rate|return|allocation|coupon|maturity)\b/i.test(context);
    if (!markedCurrency && !markedPercent && !decimalValue && !financialContext && (yearLike || integerDigits < 4)) continue;
    mentions.push({ value: signedNumber, start: match.index, end: match.index + raw.length, raw });
  }
  FINANCIAL_NUMBER.lastIndex = 0;
  return mentions;
}

function statementUnitMatches(claim, statement) {
  const text = String(statement || '');
  const mentions = financialMentions(text);
  if (mentions.length !== 1) return false;
  const hasPercent = /%/.test(text);
  const hasCurrency = /₹|\bINR\b|\bRs\.?\s*\d/i.test(text);
  if (claim.unit === 'PERCENT' && !hasPercent) return false;
  if (claim.unit === 'PERCENT_PER_ANNUM' && (!hasPercent || !/(?:\bp\.a\.|\bper annum\b|\bannual(?:ly)?\b)/i.test(text))) return false;
  if ((claim.unit === 'INR' || claim.unit === 'INR_PER_MONTH') && !hasCurrency) return false;
  if (claim.unit === 'INR_PER_MONTH' && !/\b(?:per month|monthly|\/month)\b/i.test(text)) return false;
  if (claim.unit === 'SCORE' && (hasPercent || hasCurrency || !/\bscore\b/i.test(text))) return false;
  return mentions[0].value === claim.value;
}

function samePeriod(left, right) {
  if (left === null || right === null) return left === right;
  return left && right && typeof left === 'object' && typeof right === 'object'
    && left.from === right.from && left.to === right.to
    && Object.keys(left).length === 2 && Object.keys(right).length === 2;
}

function claimMatchesExpected(claim, expected) {
  return claim.type === expected.type
    && claim.value === expected.value
    && claim.unit === expected.unit
    && claim.timePeriod === expected.timePeriod
    && claim.source === expected.source
    && claim.evidenceId === expected.evidenceId
    && claim.jurisdiction === expected.jurisdiction
    && samePeriod(claim.effectivePeriod, expected.effectivePeriod);
}

function semanticTypeMatches(claim) {
  if (inferredType(claim.statement) !== claim.type) return false;
  if (claim.type === 'EXPECTED_RETURN') {
    const statesAssumption = /\bexpected\s+(?:annual\s+)?return\s+assumption\b/i.test(claim.statement);
    const assertsCertainty = /\b(?:is|are|will be|remains|stays)\s+(?:fully\s+)?(?:guaranteed|assured|fixed)\b|\b(?:guaranteed|assured)\s+(?:(?:expected|annual|model)\s+)*(?:return|rate|income|growth)\b|\b(?:return|rate|income|growth)\s+(?:is|are|remains|stays)\s+(?:fully\s+)?(?:guaranteed|assured|fixed)\b|\bwill\s+(?:earn|return|deliver|yield)\b|\brisk[- ]free\b/i.test(claim.statement);
    return statesAssumption && !assertsCertainty;
  }
  return true;
}

/**
 * Verify model-authored numeric statements against explicit, backend-shaped
 * evidence fields. Labels, display names, and caller-supplied provenance never
 * establish a fact; each claim must match a supported authority contract.
 */
export function validateTypedFinancialClaims({ claims = [], narrative = '', evidenceEntries = [] } = {}) {
  const errors = new Set();
  const numericMentions = financialMentions(narrative);
  if (!Array.isArray(claims) || claims.length > 40) {
    return { passed: false, status: 'UNVERIFIED_TYPED_NUMERIC_CLAIM', claimCount: 0, errors: ['CLAIMS_ARRAY_INVALID'] };
  }
  const entries = Array.isArray(evidenceEntries) ? evidenceEntries : [];
  const entriesById = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || entriesById.has(entry.id)) errors.add('EVIDENCE_ID_INVALID_OR_DUPLICATE');
    else entriesById.set(entry.id, entry);
  }
  if (numericMentions.length > 0 && claims.length === 0) errors.add('TYPED_CLAIM_REQUIRED');
  const claimStatements = [];
  const seen = new Set();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)
        || Object.keys(claim).sort().join(',') !== [...CLAIM_FIELDS].sort().join(',')) {
      errors.add('CLAIM_SCHEMA_INVALID');
      continue;
    }
    if (!FINANCIAL_CLAIM_TYPES.includes(claim.type)) errors.add('CLAIM_TYPE_UNSUPPORTED');
    if (!finite(claim.value) || !FINANCIAL_CLAIM_UNITS.includes(claim.unit)
        || typeof claim.timePeriod !== 'string' || !claim.timePeriod.trim()
        || typeof claim.source !== 'string' || !claim.source.trim()
        || typeof claim.evidenceId !== 'string' || !/^E_[A-Z0-9_:-]+$/.test(claim.evidenceId)
        || !(claim.jurisdiction === null || (typeof claim.jurisdiction === 'string' && /^[A-Z]{2,3}$/.test(claim.jurisdiction)))
        || !(claim.effectivePeriod === null || (claim.effectivePeriod && typeof claim.effectivePeriod === 'object'
          && typeof claim.effectivePeriod.from === 'string'
          && (claim.effectivePeriod.to === null || typeof claim.effectivePeriod.to === 'string')))
        || typeof claim.statement !== 'string' || !claim.statement.trim()) {
      errors.add('CLAIM_SCHEMA_INVALID');
      continue;
    }
    const key = `${claim.type}:${claim.evidenceId}`;
    if (seen.has(key)) errors.add('CLAIM_DUPLICATE');
    seen.add(key);
    const expected = expectedClaimForEvidence(entriesById.get(claim.evidenceId), claim.type);
    if (!expected || !claimMatchesExpected(claim, expected)) errors.add('CLAIM_AUTHORITY_MISMATCH');
    if (!semanticTypeMatches(claim)) errors.add('CLAIM_SEMANTIC_TYPE_MISMATCH');
    if (!claim.statement.includes(`[${claim.evidenceId}]`)) errors.add('CLAIM_EVIDENCE_CITATION_REQUIRED');
    const statementIndex = String(narrative).indexOf(claim.statement);
    if (statementIndex < 0) errors.add('CLAIM_STATEMENT_NOT_IN_NARRATIVE');
    else claimStatements.push({ start: statementIndex, end: statementIndex + claim.statement.length });
    if (!statementUnitMatches(claim, claim.statement)) errors.add('CLAIM_VALUE_OR_UNIT_MISMATCH');
  }
  for (const mention of numericMentions) {
    if (!claimStatements.some(statement => mention.start >= statement.start && mention.end <= statement.end)) {
      errors.add('UNBOUND_FINANCIAL_NUMBER');
    }
  }
  const passed = errors.size === 0;
  return {
    passed,
    status: passed
      ? (claims.length > 0 ? 'TYPED_FINANCIAL_CLAIMS_VERIFIED' : 'NO_FINANCIAL_CLAIM')
      : 'UNVERIFIED_TYPED_NUMERIC_CLAIM',
    claimCount: claims.length,
    errors: [...errors].sort(),
  };
}
