/**
 * WealthGenie — Generated Frontend Investment Catalog Adapter
 * ──────────────────────────────────────────────────────
 * Adapts the committed frontend mirror generated from the canonical backend
 * file at server/data/investment_master.json. Never edit the mirror directly;
 * run `npm run catalog:sync` from server and commit both files.
 * Dynamically loads investment_master.json and flattens properties
 * to maintain 100% backward compatibility with all UI pages, charts,
 * and non-personalized comparison/details views. It is never a browser-side
 * recommendation or ranking authority.
 */

import masterCatalog from './data/investment_master.json' with { type: 'json' };

// Legacy keys are retained for UI compatibility, but no current tax conclusion is
// embedded in this presentation catalog. Authoritative tax output requires the
// user's explicit fiscal year, regime, income and product classification.
const UNAVAILABLE_TAX_REFERENCE = Object.freeze({
  label: 'Reference tax tag',
  desc: 'Unavailable here. Use the Tax view with explicit inputs and current versioned rules.',
});
const UNAVAILABLE_STATIC_TAX_DETAIL = 'Legacy catalog tax tags are not current tax authority. Use the backend tax view with explicit fiscal-year and product facts.';
const TAX_CLAIM_TEXT = /\b(?:tax(?:ation|able|free|es|ed)?|eee|ltcg|stcg|section\s*(?:80|87|111|112|115|50)\w*)\b/i;

function sanitizeStaticTaxClaims(value, key = '') {
  if (key === 'taxation') return UNAVAILABLE_TAX_REFERENCE;
  if (typeof value === 'string') return TAX_CLAIM_TEXT.test(value) ? UNAVAILABLE_STATIC_TAX_DETAIL : value;
  if (Array.isArray(value)) return value.map(item => sanitizeStaticTaxClaims(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeStaticTaxClaims(childValue, childKey),
    ]));
  }
  return value;
}
export const TAX_INFO = Object.freeze({
  eee: UNAVAILABLE_TAX_REFERENCE,
  slab: UNAVAILABLE_TAX_REFERENCE,
  ltcg: UNAVAILABLE_TAX_REFERENCE,
  elss: UNAVAILABLE_TAX_REFERENCE,
  nps: UNAVAILABLE_TAX_REFERENCE,
  sgb: UNAVAILABLE_TAX_REFERENCE,
});

// ─── RISK COLORS ──────────────────────────────────────────────────
export const RISK_COLORS = {
  "Very Low": "#14b8a6",
  "Low": "#10b981",
  "Low-Medium": "#22d3ee",
  "Medium-Low": "#22d3ee",
  "Medium": "#f59e0b",
  "High": "#ef4444",
  "Very High": "#fca5a5"
};

// ─── CHART COLORS ──────────────────────────────────────────────────
export const CHART_COLORS = [
  "#f59e0b", "#10b981", "#a855f7", "#3b82f6", "#14b8a6",
  "#06b6d4", "#ef4444", "#f97316", "#8b5cf6", "#6366f1",
  "#eab308", "#ec4899", "#22d3ee", "#dc2626", "#16a34a",
  "#ca8a04", "#84cc16", "#0ea5e9", "#4f46e5", "#db2777"
];

// ─── CONCENTRATION CAPS ──────────────────────────────────────────
export const CONCENTRATION_CAPS = {
  smallcap_mf: { maxPct: 15, badge: "Cap at 15% of portfolio" },
  midcap_mf: { maxPct: 20, badge: "Cap at 20% of portfolio" },
  direct_equity: { maxPct: 20, badge: "Cap at 20% of portfolio" },
  sgb: { maxPct: 10, badge: "Cap at 10% of portfolio" },
  gold_etf: { maxPct: 10, badge: "Cap at 10% of portfolio" },
  nps: { maxPct: 25, badge: "Illiquid until age 60 — plan accordingly" },
};

// Extract TRUST_BADGES from canonical JSON to maintain single source of truth
export const TRUST_BADGES = {};
masterCatalog.instruments.forEach(inst => {
  if (inst.staticData.trustBadge) {
    TRUST_BADGES[inst.id] = {
      type: inst.staticData.trustBadge.type,
      label: inst.staticData.trustBadge.label,
      body: inst.staticData.trustBadge.body,
      desc: inst.staticData.trustBadge.desc
    };
  }
});

// Map masterCatalog instruments to the old flat structure for backward compatibility
export const investmentDatabase = masterCatalog.instruments.map(inst => {
  const isBankDeposit = inst.category === 'Bank Deposits';
  const unavailableDiscovery = ['term_mf_combo', 'ulip', 'endowment_plan', 'bluechip_stocks'].includes(inst.id);
  const sanitizedStaticData = sanitizeStaticTaxClaims(inst.staticData);
  const safeStaticData = isBankDeposit
    ? {
      ...sanitizedStaticData,
      description: `${inst.name} rates depend on the bank, tenure, deposit amount, and depositor category. This catalog does not provide a current bank quote; confirm current rates and terms directly with the bank.`,
      pros: (sanitizedStaticData.pros || []).map((pro, index) => index === 0
        ? 'Interest rates and payout options depend on the bank and chosen deposit terms; confirm the current quote directly with the bank.'
        : pro),
      explainer: sanitizedStaticData.explainer
        ? { ...sanitizedStaticData.explainer, example: null }
        : sanitizedStaticData.explainer,
    }
    : sanitizedStaticData;
  const safeDynamicData = {
    ...inst.dynamicData,
    topSchemes: [],
    ...(isBankDeposit ? {
      expectedReturn: {
        ...inst.dynamicData.expectedReturn,
        min: null,
        avg: null,
        max: null,
        source: null,
        lastUpdated: null,
      },
      interestRates: null,
      topSchemes: [],
    } : {}),
    // Legacy catalog aliases/scores are not fiscal-year-specific tax outcomes.
    taxType: null,
    taxEfficiencyScore: null,
  };
  return {
    id: inst.id,
    slug: inst.slug,
    name: inst.name,
    abbr: inst.abbr,
    category: inst.category,
    cat: inst.category, // cat mapped to category for compat
    assetClass: inst.assetClass,
    color: inst.color,
    eligibility: inst.eligibility,
    metadata: isBankDeposit
      ? { ...inst.metadata, sourceConfidence: 'Not established' }
      : inst.metadata,
    
    // Static fields flattened
    description: safeStaticData.description,
    desc: safeStaticData.description, // desc mapped to description
    pros: safeStaticData.pros,
    cons: safeStaticData.cons,
    faq: safeStaticData.faq,
    taxation: safeStaticData.taxation,
    suitability: safeStaticData.suitability,
    trustBadge: safeStaticData.trustBadge,
    alternatives: safeStaticData.alternatives,
    explainer: safeStaticData.explainer,
    cardSubtitle: safeStaticData.cardSubtitle,
    
    // Dynamic fields flattened
    expectedReturn: safeDynamicData.expectedReturn.avg,
    returnDataClass: isBankDeposit || unavailableDiscovery ? 'UNAVAILABLE' : 'MODEL_ASSUMPTION',
    returnAssumptionVersion: isBankDeposit || unavailableDiscovery ? null : 'wealthgenie-projection-assumptions-1.1.5',
    returnSource: isBankDeposit || unavailableDiscovery ? null : 'WEALTHGENIE_MODEL_POLICY',
    observedMarketFact: false,
    providerForecast: false,
    rate: safeDynamicData.interestRates,
    returnRange: {
      min: safeDynamicData.expectedReturn.min,
      max: safeDynamicData.expectedReturn.max
    },
    riskLevel: inst.dynamicData.risk.value,
    risk: inst.dynamicData.risk.value,
    riskLabel: inst.dynamicData.risk.level,
    volatility: inst.dynamicData.risk.volatility,
    liquidityScore: inst.dynamicData.liquidity.score,
    lockIn: inst.dynamicData.liquidity.lockIn,
    taxType: null,
    taxEfficiencyScore: null,
    expenseRatio: inst.dynamicData.expenseRatio,
    minMonthlyInvestment: inst.dynamicData.minMonthlyInvestment,
    maxAnnualInvestment: inst.dynamicData.maxAnnualInvestment,
    idealHorizon: inst.dynamicData.idealHorizon,
    goalTags: inst.dynamicData.goalTags,
    
    // Keep nested references for new code
    staticData: safeStaticData,
    dynamicData: safeDynamicData
  };
});
