/**
 * Enrich only independently qualified comparison winners with the existing
 * source-bound contractual after-tax ledger. A fund NAV or bond yield is not
 * a contractual post-tax return, and no scenario without dated personal tax
 * inputs can produce an exact net return.
 */
import { calculateSourceBoundContractCashflow } from './qualifiedPostgresCashflow.js';

export async function attachSourceBoundAfterTaxReturns({
  pool, comparison, principal, taxEventContext, now = new Date(),
  calculate = calculateSourceBoundContractCashflow,
} = {}) {
  if (comparison?.status !== 'AVAILABLE' || !Array.isArray(comparison.products)
    || ![2, 3].includes(comparison.products.length)) return comparison;
  if (!Number.isFinite(principal) || principal <= 0 || principal > 1e10
    || !taxEventContext || typeof taxEventContext !== 'object') {
    return comparison;
  }
  const products = [];
  for (const product of comparison.products) {
    // A valid product ranking is not itself proof of a taxable cash-flow
    // schedule. This calculator only understands select official contracts.
    const result = await calculate({
      pool, productId: product.id, principal, taxEventContext, now,
    });
    const observation = product.marketFact;
    const bound = result?.status === 'CALCULATED'
      && result.postTaxStatus === 'CALCULATED'
      && result.dataClass === 'QUALIFIED_PUBLISHED_RATE'
      && observation?.type === 'PUBLISHED_RATE'
      && result.officialSourceId === observation.sourceId
      && String(result.officialObservationId) === observation.observationId
      && Number.isFinite(new Date(result.sourceObservationTime).getTime())
      && new Date(result.sourceObservationTime).getTime()
        === new Date(observation.asOf).getTime()
      && typeof result.source?.nominalAnnualRatePct === 'number'
      && Number.isFinite(result.source.nominalAnnualRatePct)
      && result.source.nominalAnnualRatePct === Number(observation.value)
      && result.canonicalProductId === product.id
      && Number.isFinite(result.postTaxXirr)
      && result.postTaxXirr > -1 && result.postTaxXirr < 1000
      && Number.isFinite(result.postTaxProceeds)
      && result.postTaxProceeds >= 0
      && result.sourceTermsReviewedIndependently === true;
    products.push({
      ...product,
      ...(bound ? { afterTax: {
        status: 'CALCULATED',
        metric: 'ANNUALIZED_AFTER_TAX_CASHFLOW_XIRR',
        valuePercent: Math.round(result.postTaxXirr * 100 * 1e6) / 1e6,
        basis: 'VERIFIED_CONTRACT_AND_EXPLICIT_DATED_INVESTOR_TAX_FACTS',
        sourceId: observation.sourceId,
        observationId: observation.observationId,
        observedAt: observation.asOf,
        principalInr: principal,
        taxContextSource: 'EXPLICIT_REQUEST_NOT_STORED',
      } } : {}),
    });
  }
  return { ...comparison, products };
}
