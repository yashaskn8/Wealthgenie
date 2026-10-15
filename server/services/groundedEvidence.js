import crypto from 'crypto';

export const GROUNDED_EVIDENCE_VERSION = 'grounded-financial-evidence-1.0.0';

export const EXTERNAL_LLM_PROFILE_FIELDS = Object.freeze([
  'age',
  'monthlySavings',
  'riskTolerance',
  'suitabilityRisk',
  'investmentHorizonYears',
  'investmentGoals',
  'suitabilityReasonCodes',
]);

const CONDITIONAL_PROFILE_FIELDS = Object.freeze({
  monthlyTakeHome: /\b(?:my income|my salary|my take[- ]?home|my monthly pay)\b/i,
  savingsRate: /\b(?:my savings rate|my savings capacity|what share of my income)\b/i,
  liquidSavings: /\b(?:my liquid savings|my cash reserve|my emergency savings)\b/i,
  emiBurdenPct: /\b(?:my emi|my debt burden|my loan payments)\b/i,
  financialDependents: /\b(?:my dependents|my family responsibilities)\b/i,
  emergencyFundMonths: /\b(?:my emergency fund|my emergency savings)\b/i,
  deployableLumpSum: /\b(?:my lump[ -]?sum|my one[ -]?time capital|money i can invest now)\b/i,
});

const PROFILE_FIELD_QUESTION_PATTERNS = Object.freeze({
  age: /\b(?:my age|my current age|based on my age)\b/i,
  monthlySavings: /\b(?:my monthly savings|my sip|my monthly contribution|how much can i save|can i afford)\b/i,
  riskTolerance: /\b(?:my risk tolerance|my risk profile|my suitability|why (?:is )?(?:this|my|the current) recommendation|my (?:recommendation|allocation|portfolio|plan)|your plan|for me|suitable for me|fit my profile|given my profile|what should i invest|which (?:fund|product|instrument) should i)\b/i,
  suitabilityRisk: /\b(?:my risk tolerance|my risk profile|my suitability|why (?:is )?(?:this|my|the current) recommendation|my (?:recommendation|allocation|portfolio|plan)|your plan|for me|suitable for me|fit my profile|given my profile|what should i invest|which (?:fund|product|instrument) should i)\b/i,
  investmentHorizonYears: /\b(?:my horizon|my time frame|my timeframe|my investment period|years? should i invest|my retirement plan)\b/i,
  investmentGoals: /\b(?:my goal|my goals|my retirement|based on my goals|my financial milestone)\b/i,
  suitabilityReasonCodes: /\b(?:why (?:is )?(?:this|my|the current) recommendation|why.*my (?:plan|portfolio|allocation)|reason.*(?:my recommendation|this recommendation|my suitability))\b/i,
  ...CONDITIONAL_PROFILE_FIELDS,
});

const RECOMMENDATION_QUESTION_PATTERN = /\b(?:my recommendation|why (?:is )?(?:this|my|the current) recommendation|my allocation|my portfolio|my plan|my expected return|my projection|my future value|expected return for my (?:plan|portfolio|investment)|projection for my (?:plan|portfolio|investment)|your plan|for me|suitable for me|fit my profile|given my profile|what should i invest|which (?:fund|product|instrument) should i)\b/i;

export function isPersonalizedRecommendationQuestion(question) {
  return RECOMMENDATION_QUESTION_PATTERN.test(String(question || ''));
}

function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function hashGroundedEvidence(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function entry(id, kind, value, {
  dataClass,
  displayValue = null,
  source = null,
  observedAt = null,
  freshness = null,
  authority = 'WEALTHGENIE_BACKEND',
} = {}) {
  return Object.freeze({
    id,
    kind,
    value,
    displayValue,
    dataClass,
    source,
    observedAt,
    freshness,
    authority,
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.values(value).forEach(deepFreeze);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function compactSource(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    provider: source.provider ?? null,
    url: source.url ?? null,
    publicationDate: source.publicationDate ?? null,
    instrumentId: source.instrumentId ?? null,
  };
}

function selectedProfileFields(profile, question, purpose) {
  if (!profile || purpose === 'PLAN_REVIEW') return [];
  if (purpose === 'RECOMMENDATION_EXPLANATION') {
    return ['riskTolerance', 'suitabilityRisk', 'suitabilityReasonCodes']
      .filter(field => profile[field] !== undefined && profile[field] !== null);
  }
  return Object.entries(PROFILE_FIELD_QUESTION_PATTERNS)
    .filter(([field, pattern]) => profile[field] !== undefined
      && profile[field] !== null
      && pattern.test(question || ''))
    .map(([field]) => field);
}

function profileEntries(profile, fields) {
  if (!profile || fields.length === 0) return [];
  const fieldSet = new Set(fields);
  const rows = [];
  if (fieldSet.has('age')) {
    rows.push(entry('E_PROFILE_AGE', 'PROFILE', profile.age, {
      dataClass: 'USER_INPUT', displayValue: `${profile.age} years`,
    }));
  }
  if (fieldSet.has('monthlySavings')) {
    rows.push(entry('E_PROFILE_SAVINGS', 'PROFILE', profile.monthlySavings, {
      dataClass: 'USER_INPUT',
      displayValue: `INR ${Number(profile.monthlySavings).toLocaleString('en-IN')} per month`,
    }));
  }
  if (fieldSet.has('riskTolerance') || fieldSet.has('suitabilityRisk')) {
    const value = {
      ...(fieldSet.has('riskTolerance') ? { statedRiskTolerance: profile.riskTolerance } : {}),
      ...(fieldSet.has('suitabilityRisk') ? { finalSuitabilityRisk: profile.suitabilityRisk } : {}),
    };
    rows.push(entry('E_PROFILE_RISK', 'SUITABILITY', value, {
      dataClass: 'DERIVED_VALUE',
      displayValue: fieldSet.has('suitabilityRisk')
        ? `${profile.suitabilityRisk} final suitability ceiling`
        : `${profile.riskTolerance} stated risk tolerance`,
    }));
  }
  if (fieldSet.has('investmentHorizonYears')) {
    rows.push(entry('E_PROFILE_HORIZON', 'PROFILE', profile.investmentHorizonYears, {
      dataClass: 'USER_INPUT', displayValue: `${profile.investmentHorizonYears} years`,
    }));
  }
  if (fieldSet.has('investmentGoals')) {
    rows.push(entry('E_PROFILE_GOALS', 'PROFILE', profile.investmentGoals, {
      dataClass: 'USER_INPUT', displayValue: (profile.investmentGoals || []).join(', '),
    }));
  }
  if (fieldSet.has('suitabilityReasonCodes')) {
    rows.push(entry('E_SUITABILITY_REASONS', 'SUITABILITY', profile.suitabilityReasonCodes || [], {
      dataClass: 'DERIVED_VALUE',
      displayValue: (profile.suitabilityReasonCodes || []).join(', ') || 'No reason codes available',
    }));
  }
  for (const field of fields) {
    if (['age', 'monthlySavings', 'riskTolerance', 'suitabilityRisk', 'investmentHorizonYears', 'investmentGoals', 'suitabilityReasonCodes'].includes(field)) continue;
    const id = `E_PROFILE_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
    rows.push(entry(id, 'PROFILE', profile[field], {
      dataClass: field === 'savingsRate' ? 'DERIVED_VALUE' : 'USER_INPUT',
      displayValue: String(profile[field]),
    }));
  }
  return rows;
}

function recommendationEntries(recommendation) {
  if (!recommendation || !Array.isArray(recommendation.instruments) || recommendation.instruments.length === 0) return [];
  const rows = [entry('E_REC_POLICY', 'RECOMMENDATION', {
    modelVersion: recommendation.modelVersion ?? null,
  }, {
    dataClass: 'AUTHORITATIVE_BACKEND_RESULT',
    displayValue: `Recommendation model ${recommendation.modelVersion || 'unavailable'}`,
  })];
  recommendation.instruments.slice(0, 8).forEach((instrument, index) => {
    const allocationPct = Number.isFinite(Number(instrument.allocation_pct))
      ? Number(instrument.allocation_pct)
      : Number(instrument.allocationWeight) * 100;
    const modelReturnAssumptionPct = Number.isFinite(Number(instrument.nominalReturn))
      ? Number(instrument.nominalReturn)
      : null;
    rows.push(entry(`E_REC_${String(index + 1).padStart(3, '0')}`, 'RECOMMENDATION', {
      instrumentId: instrument.id,
      name: instrument.name,
      type: instrument.type,
      allocationPct,
      modelReturnAssumptionPct,
      returnDataClass: instrument.returnDataClass || 'MODEL_ASSUMPTION',
      returnAssumptionVersion: instrument.returnAssumptionVersion ?? null,
      providerForecast: false,
      riskLevel: instrument.riskLevel ?? null,
    }, {
      dataClass: 'AUTHORITATIVE_BACKEND_RESULT',
      displayValue: modelReturnAssumptionPct === null
        ? `${instrument.name}: ${allocationPct}% allocation; return assumption unavailable`
        : `${instrument.name}: ${allocationPct}% allocation; ${modelReturnAssumptionPct}% pre-tax nominal model assumption`,
    }));
  });
  return rows;
}

export function buildGroundedEvidencePacket({
  question,
  profile,
  recommendation = null,
  additionalEntries = [],
  unavailableFacts = [],
  purpose = 'FINANCIAL_EXPLANATION',
}) {
  const profileFields = selectedProfileFields(profile, question, purpose);
  const includeRecommendation = purpose === 'PLAN_REVIEW'
    || purpose === 'RECOMMENDATION_EXPLANATION'
    || isPersonalizedRecommendationQuestion(question);
  const entries = [
    ...profileEntries(profile, profileFields),
    ...(includeRecommendation ? recommendationEntries(recommendation) : []),
    ...additionalEntries,
    entry('E_REGULATORY_NOTICE', 'DISCLOSURE', 'For informational purposes only. Not registered investment advice under SEBI (IA) Regulations, 2013. Consult a SEBI-registered adviser before investing. Mutual fund investments are subject to market risks.', {
      dataClass: 'REFERENCE_METADATA',
      displayValue: 'For informational purposes only. Not registered investment advice under SEBI (IA) Regulations, 2013.',
    }),
  ];
  const uniqueEntries = [...new Map(entries.map(item => [item.id, item])).values()];
  const packet = {
    groundingVersion: GROUNDED_EVIDENCE_VERSION,
    purpose,
    entries: uniqueEntries,
    unavailableFacts: [...new Set(unavailableFacts.filter(Boolean))],
    privacy: {
      sentProfileFields: profileFields,
      excludedFields: ['email', 'phone', 'passwordHash', 'jwt', 'address', 'mongoUserId'],
    },
  };
  return deepFreeze({ ...packet, evidenceHash: hashGroundedEvidence(packet) });
}

export function evidenceEntryFromMarketContext(context) {
  if (!context || context.status !== 'MARKET_CONTEXT_AVAILABLE') return null;
  return entry('E_MARKET_CONTEXT', 'MARKET_CONTEXT', {
    context: context.context,
    candidateContext: context.candidateContext,
    policyVersion: context.policyVersion,
    reasonCodes: context.reasonCodes || [],
    signals: context.signals || context.features || null,
    sources: (context.sources || []).map(compactSource),
    authorityRole: 'DETERMINISTIC_POLICY_CHAMPION',
  }, {
    dataClass: 'DETERMINISTIC_POLICY_RESULT',
    displayValue: `${context.context} deterministic market context`,
    observedAt: context.observedAt ?? context.evaluatedAt ?? null,
    freshness: context.freshness ?? null,
    source: compactSource(context.sources?.[0]),
  });
}

export function evidenceEntryFromOfficialRate(product, index = 0) {
  const rate = product?.officialRate;
  if (!product || !rate || !Number.isFinite(Number(rate.value))) return null;
  return entry(`E_OFFICIAL_RATE_${String(index + 1).padStart(3, '0')}`, 'PRODUCT_FACT', {
    productId: product.id,
    name: product.name,
    ratePctPerAnnum: Number(rate.value),
    rateBasis: rate.basis,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    tenure: product.tenure ?? null,
    depositorType: product.depositorType ?? null,
    comparisonStatus: product.presentationStatus,
  }, {
    dataClass: rate.dataClass || 'VERIFIED_PRODUCT_FACT',
    displayValue: `${product.name}: ${rate.value}% p.a. effective ${rate.effectiveFrom}${rate.effectiveTo ? ` to ${rate.effectiveTo}` : ''}`,
    source: compactSource(product.source),
    observedAt: rate.observedAt ?? null,
    freshness: product.freshness ?? null,
  });
}

export function evidenceEntryFromProjectionAssumption(instrumentId, assumption) {
  if (!assumption) return null;
  return entry(`E_PROJECTION_ASSUMPTION_${String(instrumentId).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`, 'PROJECTION', {
    instrumentId,
    annualReturnAssumptionPct: typeof assumption.mean === 'number' && Number.isFinite(assumption.mean) ? assumption.mean * 100 : null,
    annualVolatilityAssumptionPct: typeof assumption.stdDev === 'number' && Number.isFinite(assumption.stdDev) ? assumption.stdDev * 100 : null,
    assumptionVersion: assumption.assumptionVersion,
    providerForecast: false,
  }, {
    dataClass: 'MODEL_ASSUMPTION',
    displayValue: `${instrumentId} uses WealthGenie model assumptions; provider forecast is false`,
    source: { provider: assumption.source || 'WEALTHGENIE_MODEL_POLICY', url: null, publicationDate: null, instrumentId },
  });
}

export function makeEvidenceEntry(...args) {
  return entry(...args);
}
