/**
 * WealthGenie — Backend Authoritative Investment Catalog
 * ──────────────────────────────────────────────────────
 * Adapts the canonical JSON master database for the backend.
 * Dynamically loads investment_master.json and flattens properties
 * to maintain 100% backward compatibility with all scoring, ranking,
 * seed scripts, and test suites.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const masterCatalog = JSON.parse(
  readFileSync(resolve(__dirname, 'investment_master.json'), 'utf8')
);

const TAX_CATALOG_UNAVAILABLE = Object.freeze({
  status: 'TAX_CLASSIFICATION_UNAVAILABLE',
  label: 'Tax treatment requires a current server calculation',
  desc: 'Static catalog tax fields are legacy references, not current tax authority. Use an explicit fiscal-year calculation with qualified product and taxpayer facts.',
});

const TAX_CLAIM_TEXT = /\b(?:tax(?:ation|able|free|es|ed)?|eee|ltcg|stcg|section\s*(?:80|87|111|112|115|50)\w*)\b/i;

function sanitizeStaticTaxClaims(value, key = '') {
  if (key === 'taxation') return { ...TAX_CATALOG_UNAVAILABLE };
  if (typeof value === 'string') return TAX_CLAIM_TEXT.test(value) ? TAX_CATALOG_UNAVAILABLE.desc : value;
  if (Array.isArray(value)) return value.map(item => sanitizeStaticTaxClaims(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeStaticTaxClaims(childValue, childKey),
    ]));
  }
  return value;
}

// ─── TAX INFO LOOKUP ──────────────────────────────────────────────
export const TAX_INFO = {
  eee: {
    label: "EEE — Exempt-Exempt-Exempt",
    desc: "Tax treatment depends on account eligibility, applicable fiscal-year law and the specific contribution, accrual and withdrawal facts."
  },
  slab: {
    label: "Taxed at Income Slab Rate",
    desc: "Tax treatment depends on the selected fiscal-year law and verified product classification.",
    debtNote: "Debt-fund tax treatment depends on acquisition date, holding period, product classification and the selected fiscal-year policy."
  },
  ltcg: {
    label: "Long-term capital-gains treatment",
    desc: "The applicable fiscal-year policy determines the tax treatment from the verified product class, holding period and taxpayer inputs."
  },
  elss: {
    label: "ELSS — fiscal-year eligibility applies",
    desc: "Tax treatment depends on the selected fiscal year, tax regime, holding period and verified product classification."
  },
  nps: {
    label: "NPS — fiscal-year contribution rules apply",
    desc: "NPS contribution and withdrawal treatment depends on the selected fiscal year, tax regime, contribution type and exit facts."
  },
  sgb: {
    label: "2.5% Interest Taxable · Maturity Tax Depends on Acquisition Facts",
    desc: "2.5% annual interest is taxed at your slab rate. A maturity exemption requires an original-issue subscription and continuous holding until maturity; secondary-market and premature-redemption treatment must be established separately."
  }
};

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

// Public-instrument compatibility type. Personalized recommendation code uses
// the separate, fail-closed recommendationType below.
const LEGACY_TYPE_MAP = {
  'Government':           'Government',
  'Gold':                 'Gold',
  'Retirement':           'Government',
  'Bank Deposits':        'FD',
  'Debt Mutual Funds':    'Mutual_Fund',
  'Equity Mutual Funds':  'Mutual_Fund',
  'ETFs':                 'ETF',
  'REITs & InvITs':       'ETF',
  'Bonds & Debentures':   'Government',
  'Insurance-linked':     'Mutual_Fund',
  'Direct Equity':        'ETF',
  'Other':                'Mutual_Fund',
};

// Specific ID overrides for legacy test assertions
const SPECIFIC_ID_TYPE_MAP = {
  'scss': 'SCSS',
  'ppf': 'PPF',
  'rbi_bonds': 'RBI_Bond',
  'rbi_retail_direct_gilt': 'G-Sec',
  'g_sec': 'G-Sec',
  'term_mf_combo': 'Planning_Strategy',
  'ulip': 'Insurance_Archetype',
  'endowment_plan': 'Insurance_Archetype',
  'bluechip_stocks': 'Equity_Archetype',
  'aa_corporate_bond': 'Bond_Archetype',
};

const EXACT_RECOMMENDATION_TYPES = Object.freeze({
  ppf: 'PPF',
  scss: 'SCSS',
  sukanya: 'SSY',
  rbi_bonds: 'RBI_Bond',
  rbi_retail_direct_gilt: 'G-Sec',
  g_sec: 'G-Sec',
  sgb: 'SGB',
  arbitrage_mf: 'Arbitrage_MF',
});

export function recommendationTypeForCatalogInstrument(instrument) {
  const exact = EXACT_RECOMMENDATION_TYPES[instrument?.id];
  if (exact) return exact;
  const id = String(instrument?.id || '');
  const category = instrument?.category;
  const assetClass = instrument?.assetClass;
  if (category === 'Bank Deposits') return 'FD';
  if (category === 'Debt Mutual Funds') {
    return ['liquid_mf', 'overnight_mf', 'money_market_mf'].includes(id) ? 'Liquid_MF' : 'Debt_MF';
  }
  if (category === 'Equity Mutual Funds') {
    if (id === 'elss' || id.endsWith('_elss')) return 'ELSS';
    if (id.includes('smallcap')) return 'Smallcap_MF';
    if (id.includes('midcap')) return 'Midcap_MF';
    if (id.includes('hybrid') || id === 'multi_asset_allocation_mf' || id === 'equity_savings_mf') return 'Hybrid_MF';
    if (id.includes('index') || id === 'value_factor_mf') return 'Index_MF';
    return 'Equity_MF';
  }
  if (category === 'ETFs') {
    if (id === 'liquid_etf') return 'Liquid_MF';
    if (assetClass === 'Gold') return 'Gold';
    return 'ETF';
  }
  if (category === 'Gold') return 'Gold';
  if (category === 'Retirement' && (id === 'nps' || id === 'nps_tier_2')) return 'NPS';
  return null;
}

// Map masterCatalog instruments to the old flat structure for backward compatibility
export const investmentDatabase = masterCatalog.instruments.map(inst => {
  const safeStaticData = sanitizeStaticTaxClaims(inst.staticData);
  const unavailableDiscovery = ['term_mf_combo', 'ulip', 'endowment_plan', 'bluechip_stocks', 'aa_corporate_bond'].includes(inst.id);
  if (unavailableDiscovery && (inst.dynamicData?.expectedReturn?.dataClass !== 'UNAVAILABLE'
      || inst.dynamicData.expectedReturn.avg !== null || inst.dynamicData.topSchemes.length !== 0)) {
    throw new Error('DISCOVERY_CATALOG_UNQUALIFIED:' + inst.id);
  }
  const safeDynamicData = { ...inst.dynamicData, topSchemes: [] };
  const legacyType = SPECIFIC_ID_TYPE_MAP[inst.id] || (
    inst.dynamicData?.taxType === 'elss' || inst.taxType === 'elss'
      ? 'ELSS'
      : (LEGACY_TYPE_MAP[inst.category] || 'Mutual_Fund')
  );

  return {
    id: inst.id,
    type: legacyType,
    recommendationType: recommendationTypeForCatalogInstrument(inst),
    slug: inst.slug,
    name: inst.name,
    abbr: inst.abbr,
    category: inst.category,
    subCategory: inst.subCategory ?? null,
    cat: inst.category, // cat mapped to category for compat
    assetClass: inst.assetClass,
    color: inst.color,
    eligibility: inst.eligibility,
    metadata: inst.metadata,
    
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
    returnDataClass: unavailableDiscovery ? 'UNAVAILABLE' : PROJECTION_ASSUMPTION_DATA_CLASS,
    returnAssumptionVersion: unavailableDiscovery ? null : PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: unavailableDiscovery ? null : PROJECTION_ASSUMPTION_POLICY_HASH,
    returnSource: unavailableDiscovery ? null : PROJECTION_ASSUMPTION_SOURCE,
    observedMarketFact: false,
    providerForecast: false,
    rate: inst.dynamicData.interestRates,
    returnRange: {
      min: inst.dynamicData.expectedReturn.min,
      max: inst.dynamicData.expectedReturn.max
    },
    riskLevel: inst.dynamicData.risk.value,
    risk: inst.dynamicData.risk.value,
    riskLabel: inst.dynamicData.risk.level,
    volatility: inst.dynamicData.risk.volatility,
    liquidityScore: inst.dynamicData.liquidity.score,
    lockIn: inst.dynamicData.liquidity.lockIn,
    taxType: unavailableDiscovery ? null : inst.dynamicData.taxType,
    taxEfficiencyScore: unavailableDiscovery ? null : inst.dynamicData.taxEfficiencyScore,
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
