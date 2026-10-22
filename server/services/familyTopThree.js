import { buildRecommendationProfile } from './recommendationProfile.js';
import { assessSuitabilityRisk } from './riskProfiler.js';
import { createFinancialStore } from '../postgres/financialStore.js';

export const FAMILY_TOP_THREE_VERSION = 'family-product-comparison-1.0.0';
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value);
const numeric = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const unavailable = (familyId, reasonCode, extra = {}) => ({
  status: 'NO_QUALIFIED_PRODUCTS', reasonCode, version: FAMILY_TOP_THREE_VERSION,
  familyId, maxResults: 3, products: [], ...extra,
});

/**
 * Ranking is an evidence-backed COMPARISON, never an allocation authority.
 * No cache survives rights revocation, observation expiry, or profile changes.
 */
export async function compareQualifiedFamilyProducts({
  pool, familyId, profileInput, now = new Date(), store = null, adviceAuthorized = false,
} = {}) {
  if (!validId(familyId)) throw new TypeError('FAMILY_ID_INVALID');
  if (!pool || typeof pool.query !== 'function') throw new TypeError('FINANCIAL_POSTGRES_REQUIRED');
  if (!(now instanceof Date) || !Number.isFinite(+now)) throw new TypeError('INVALID_COMPARISON_TIME');
  const profile = buildRecommendationProfile(profileInput);
  const suitability = assessSuitabilityRisk(profile);
  const family = await pool.query([
    'SELECT p.id,p.name,c.label AS category',
    'FROM finance.products p JOIN finance.categories c ON c.id=p.category_id',
    "WHERE p.id=$1 AND p.record_kind='ARCHETYPE'",
  ].join(' '), [familyId]);
  if (family.rows.length !== 1) return unavailable(familyId, 'FAMILY_NOT_FOUND');
  const familyName = family.rows[0].name;
  if (!adviceAuthorized) return unavailable(familyId, 'PERSONALIZED_ADVICE_AUTHORIZATION_REQUIRED', { familyName });

  const response = await pool.query([
    'SELECT q.family_id,q.product_id,q.source_id,q.observation_type,q.status,q.reviewed_at,q.valid_until,',
    'q.risk_level,q.min_investment_inr::text AS min_investment_inr,q.min_horizon_years,',
    'q.lock_in_months,q.annual_fee_bps,q.min_age,q.max_age,q.retail_access,',
    'q.requires_demat,q.requires_accreditation,q.requires_nps_account,q.requires_child_eligibility,',
    'q.evidence_url,q.terms_evidence_url,q.risk_evidence_url,q.review_version,',
    'p.name AS product_name,p.availability,p.record_kind,p.recommendation_eligible,',
    'p.qualified_tax_class,p.tax_class_reviewed_at,r.source_id AS right_source_id',
    'FROM finance.family_product_qualifications q',
    'JOIN finance.products p ON p.id=q.product_id',
    'LEFT JOIN finance.provider_rights r ON r.source_id=q.source_id',
    'AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed',
    'AND r.derivation_allowed AND r.public_display_allowed AND r.commercial_use_allowed',
    'AND r.redistribution_allowed AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL',
    'AND r.reviewed_at<=$2 AND r.revoked_at IS NULL',
    'AND (r.expires_at IS NULL OR r.expires_at>$2)',
    'WHERE q.family_id=$1 ORDER BY q.product_id LIMIT 501',
  ].join(' '), [familyId, now]);
  if (response.rows.length > 500) return unavailable(familyId, 'FAMILY_QUALIFICATION_SET_TOO_LARGE', { familyName });

  const exclusions = {};
  const exclude = reason => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
  const eligible = [];
  const observations = store || createFinancialStore(pool);
  const riskLimit = suitability.finalLevel;
  for (const q of response.rows) {
    let reason = null;
    if (q.status !== 'ACTIVE' || new Date(q.valid_until) <= now
      || new Date(q.reviewed_at) > now) reason = 'REVIEW_EXPIRED_OR_SUSPENDED';
    else if (q.record_kind !== 'ACTUAL_PRODUCT' || q.availability !== 'AVAILABLE'
      || q.recommendation_eligible !== true
      || !q.qualified_tax_class || ['UNVERIFIED', 'OTHER_UNSUPPORTED'].includes(q.qualified_tax_class)
      || !q.tax_class_reviewed_at || new Date(q.tax_class_reviewed_at) > now) {
      reason = 'PRODUCT_NOT_FINANCIALLY_QUALIFIED';
    } else if (q.right_source_id !== q.source_id) reason = 'DATA_RIGHTS_REVOKED_OR_EXPIRED';
    else if (!q.retail_access || q.requires_accreditation || q.requires_nps_account
      || q.requires_child_eligibility || q.requires_demat) reason = 'INVESTOR_ELIGIBILITY_UNVERIFIED';
    else if (!Number.isInteger(q.risk_level) || q.risk_level > riskLimit) reason = 'RISK_EXCEEDS_CAPACITY_OR_PREFERENCE';
    else if (!Number.isInteger(q.min_age) || !Number.isInteger(q.max_age)
      || profile.age < q.min_age || profile.age > q.max_age) reason = 'INVESTOR_AGE_OUTSIDE_PRODUCT';
    else if (!Number.isInteger(q.min_horizon_years) || !Number.isInteger(q.lock_in_months)
      || q.min_horizon_years > profile.investmentHorizonYears
      || q.lock_in_months > profile.investmentHorizonYears * 12) reason = 'INVESTMENT_HORIZON_TOO_SHORT';
    else if (numeric(q.min_investment_inr) === null || numeric(q.min_investment_inr) <= 0
      || numeric(q.min_investment_inr) > Math.max(profile.monthlySavings,
        profile.hasLumpSum === true ? profile.lumpSumAmount : 0)) reason = 'MINIMUM_INVESTMENT_NOT_MET';
    if (reason) { exclude(reason); continue; }

    // Revalidate rights + identifier + retention + freshness + corrections in SQL.
    const fact = await observations.latestPublishableObservation(q.product_id, q.observation_type, now, q.source_id);
    if (!fact || fact.source_id !== q.source_id) { exclude('VERIFIED_MARKET_FACT_UNAVAILABLE'); continue; }
    const value = numeric(fact.value);
    if (value === null || value < 0 || (q.observation_type !== 'PUBLISHED_RATE' && value === 0)) {
      exclude('VERIFIED_MARKET_FACT_INVALID'); continue;
    }
    const fee = Number(q.annual_fee_bps);
    if (!Number.isInteger(fee) || fee < 0 || fee > 10000) { exclude('PRODUCT_FEES_UNVERIFIED'); continue; }
    // Return/nominal yield cannot safely be compared across product families.
    // Rank within-family on fit, explicit fees and liquidity, never forecast profit.
    const fit = Math.max(0, 100 - 12 * Math.abs(riskLimit - q.risk_level)
      - Math.min(30, fee / 15)
      - 12 * q.lock_in_months / Math.max(12, profile.investmentHorizonYears * 12));
    eligible.push({
      id: q.product_id, name: q.product_name, familyId,
      matchScore: Number(fit.toFixed(2)), reviewVersion: q.review_version,
      riskLevel: q.risk_level, minimumInvestmentInr: numeric(q.min_investment_inr),
      minimumHorizonYears: q.min_horizon_years, lockInMonths: q.lock_in_months,
      annualFeeBps: fee, verifiedTaxClass: q.qualified_tax_class,
      marketFact: { type: q.observation_type, value, unit: fact.unit,
        asOf: fact.observed_at, dataClass: fact.data_class,
        sourceId: fact.source_id, observationId: String(fact.id) },
      evidence: { product: q.evidence_url, terms: q.terms_evidence_url,
        risk: q.risk_evidence_url, reviewedAt: q.reviewed_at, expiresAt: q.valid_until },
      reasons: ['WITHIN_VERIFIED_RISK_BOUNDARY', 'REVIEWED_PRODUCT_TERMS',
        'PUBLISHABLE_SOURCE_BOUND_MARKET_FACT'],
    });
  }
  eligible.sort((a, b) => b.matchScore - a.matchScore || a.annualFeeBps - b.annualFeeBps
    || a.lockInMonths - b.lockInMonths || a.id.localeCompare(b.id));
  // The permission or current observation can change while other products are
  // evaluated. Re-read the winning evidence before publishing each of at most 3.
  const selected = [];
  for (const product of eligible) {
    if (selected.length === 3) break;
    const current = await observations.latestPublishableObservation(
      product.id, product.marketFact.type, now, product.marketFact.sourceId,
    );
    if (!current || current.source_id !== product.marketFact.sourceId
      || String(current.id) !== product.marketFact.observationId
      || numeric(current.value) !== product.marketFact.value) {
      exclude('MARKET_SOURCE_CHANGED_DURING_COMPARISON');
      continue;
    }
    selected.push(product);
  }
  const hasThree = selected.length === 3;
  return {
    status: hasThree ? 'AVAILABLE' : 'INSUFFICIENT_VERIFIED_PRODUCTS',
    reasonCode: hasThree ? null : 'FEWER_THAN_THREE_SUITABLE_VERIFIED_PRODUCTS',
    version: FAMILY_TOP_THREE_VERSION, familyId, familyName, maxResults: 3,
    qualifyingCount: eligible.length, examinedCount: response.rows.length,
    requiredProductCount:3,verifiedProductCount:selected.length,
    exclusionCounts: exclusions, products: hasThree ? selected : [],
    disclosure: 'Exactly three independently qualified products are required for this comparison; no assured return, tax forecast, trade execution or automatic portfolio change.',
    profileBasis: { riskLevelCeiling: riskLimit, investmentHorizonYears: profile.investmentHorizonYears },
  };
}
