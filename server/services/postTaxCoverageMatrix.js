import { investmentDatabase } from '../data/investmentDatabase.js';
import { getWhereToInvestProviderCoverageMatrix } from './RecommendationPipeline.js';
import {
  getProductTaxMetadata,
  getRequiredTaxInputs,
  NIFTYBEES_PRODUCT_TAX_EVIDENCE,
  PRODUCT_TAX_CLASSES,
} from './productTaxAuthority.js';
import { getSupportedFiscalYears, getTaxPolicyMetadata } from './taxEngine.js';
import {
  getPostTaxSourceRightsRegister,
  resolvePostTaxProviderRights,
} from './postTaxSourceRights.js';
import { getUserDeclaredScenarioCapability } from './userDeclaredPostTaxScenario.js';

export const POST_TAX_COVERAGE_MATRIX_VERSION = 'post-tax-coverage-1.0.0';

const IMPLEMENTED_NUMERIC_TAX_CLASSES = new Set([
  PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST,
  PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST,
  PRODUCT_TAX_CLASSES.EQUITY_MF_112A,
  PRODUCT_TAX_CLASSES.EQUITY_MF_ELSS,
  PRODUCT_TAX_CLASSES.DEBT_MF_50AA,
]);
const CATALOG_COVERAGE_TEST = 'server/test/postTaxSourceRights.test.js::generated matrix covers the complete canonical catalog and matches its checked-in snapshot';

function classifyParentTaxCoverage(parentInstrumentId) {
  const metadata = getProductTaxMetadata({}, parentInstrumentId);
  if (metadata.sourceQualified && metadata.taxClass) {
    return {
      status: 'SOURCE_QUALIFIED_PARENT_CLASS',
      taxClass: metadata.taxClass,
      scope: 'PARENT_INSTRUMENT',
      exactProductId: null,
      effectiveDate: metadata.effectiveDate || null,
      requiredTaxInputs: getRequiredTaxInputs(metadata.taxClass),
    };
  }
  if (parentInstrumentId === 'nifty_etf') {
    return {
      status: 'EXACT_PRODUCT_ONLY',
      taxClass: PRODUCT_TAX_CLASSES.EQUITY_MF_112A,
      scope: 'EXACT_CANONICAL_PRODUCT',
      exactProductId: NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.canonicalProductId,
      effectiveDate: NIFTYBEES_PRODUCT_TAX_EVIDENCE.documentDate,
      requiredTaxInputs: getRequiredTaxInputs(PRODUCT_TAX_CLASSES.EQUITY_MF_112A),
    };
  }
  return {
    status: 'UNAVAILABLE',
    taxClass: null,
    scope: null,
    exactProductId: null,
    effectiveDate: null,
    requiredTaxInputs: [],
  };
}

function classifyTaxCalculationCapability(taxClassification) {
  if (taxClassification.status === 'UNAVAILABLE') return 'TAX_CLASSIFICATION_UNAVAILABLE';
  if ([PRODUCT_TAX_CLASSES.PPF_EEE, PRODUCT_TAX_CLASSES.SSY_EEE].includes(taxClassification.taxClass)) {
    return 'REQUIRES_QUALIFIED_ACCOUNT_FACTS';
  }
  if (!IMPLEMENTED_NUMERIC_TAX_CLASSES.has(taxClassification.taxClass)) {
    return 'TAX_CALCULATOR_NOT_IMPLEMENTED';
  }
  return 'IMPLEMENTED_REQUIRES_PRODUCT_FACTS_AND_TAX_INPUTS';
}

function classifyCalculation(providerPath, rights, taxClassification, taxCalculationCapability) {
  if (!providerPath) return 'NO_QUALIFIED_PROVIDER_PATH';
  if (!rights.productionPostTaxUseAllowed) return 'BLOCKED_SOURCE_RIGHTS';
  if (taxCalculationCapability === 'TAX_CLASSIFICATION_UNAVAILABLE') return 'TAX_CLASSIFICATION_UNAVAILABLE';
  if (taxCalculationCapability === 'REQUIRES_QUALIFIED_ACCOUNT_FACTS') return 'REQUIRES_QUALIFIED_ACCOUNT_FACTS';
  if (taxCalculationCapability === 'TAX_CALCULATOR_NOT_IMPLEMENTED') return 'TAX_CALCULATOR_NOT_IMPLEMENTED';
  return 'REQUIRES_PRODUCT_FACTS_AND_TAX_INPUTS';
}

function requiredWork(providerPath, rights, taxClassification) {
  const remaining = [];
  if (providerPath && !rights.productionPostTaxUseAllowed) {
    remaining.push('Obtain and record production permission for extraction, derived calculations, storage, public display, commercial use, and any redistribution required by this data path.');
  }
  if (!providerPath) remaining.push('Add an exact, source-qualified product discovery path or keep this parent unavailable.');
  if (taxClassification.status === 'UNAVAILABLE') {
    remaining.push('Qualify an exact product tax classification against current law and product evidence; do not infer it from the catalog label.');
  }
  if (taxClassification.status === 'EXACT_PRODUCT_ONLY') {
    remaining.push('Keep the exact-product class bound to its canonical product identity; do not generalize it to sibling ETFs.');
  }
  if ([PRODUCT_TAX_CLASSES.PPF_EEE, PRODUCT_TAX_CLASSES.SSY_EEE].includes(taxClassification.taxClass)) {
    remaining.push('Add qualified account eligibility, contribution/payment, and withdrawal/maturity facts before any conditional exclusion can be calculated.');
  }
  if (taxClassification.taxClass === PRODUCT_TAX_CLASSES.SGB) {
    remaining.push('Implement and adversarially qualify the separate SGB coupon and redemption transaction calculation; the current WTI calculator does not yet calculate this tax class.');
  }
  if (providerPath && taxClassification.status !== 'UNAVAILABLE') {
    remaining.push('Qualify product-level identity and current facts, collect required investor transaction/tax inputs, then verify each returned product independently.');
  }
  return remaining;
}

export function buildPostTaxCoverageMatrix() {
  const providerCoverage = getWhereToInvestProviderCoverageMatrix();
  const providerCoverageById = new Map(providerCoverage.map(row => [row.parentInstrumentId, row]));
  const taxPolicyLineage = getSupportedFiscalYears().map(fiscalYear => {
    const policy = getTaxPolicyMetadata(fiscalYear);
    return {
      fiscalYear,
      policyVersion: policy.policyVersion,
      statute: policy.statuteMetadata?.statute || null,
      effectiveFrom: policy.statuteMetadata?.effectiveFrom || null,
      taxYear: policy.statuteMetadata?.taxYear || null,
    };
  });

  const rows = investmentDatabase.map((instrument, index) => {
    const providerRow = providerCoverageById.get(instrument.id);
    const provider = providerRow?.provider || null;
    const sourceRights = provider ? resolvePostTaxProviderRights(provider) : {
      provider: null,
      status: 'SOURCE_UNAVAILABLE',
      termsUrls: [],
      sources: [],
      productionPostTaxUseAllowed: false,
      basis: 'No qualified provider path is registered for this catalog parent.',
    };
    const taxClassification = classifyParentTaxCoverage(instrument.id);
    const userDeclaredScenario = getUserDeclaredScenarioCapability(instrument.id);
    const hasProviderPath = Boolean(providerRow?.productOptionsAvailable);
    const taxCalculationCapability = classifyTaxCalculationCapability(taxClassification);
    const calculationStatus = classifyCalculation(hasProviderPath, sourceRights, taxClassification, taxCalculationCapability);
    return {
      catalogIndex: index + 1,
      category: instrument.category,
      canonicalInstrumentId: instrument.id,
      name: instrument.name,
      economicType: instrument.type,
      productDiscovery: {
        provider,
        status: providerRow?.status || 'NO_PROVIDER_PATH',
        productOptionsAvailable: hasProviderPath,
      },
      sourceRights: {
        status: sourceRights.status,
        productionUseAllowed: sourceRights.productionPostTaxUseAllowed,
        sourceIds: sourceRights.sourceIds || sourceRights.sources.map(source => source.sourceId).filter(Boolean),
        termsUrls: sourceRights.termsUrls,
        basis: sourceRights.basis,
      },
      taxClassification,
      userDeclaredScenario,
      calculation: {
        status: calculationStatus,
        taxCalculationCapability,
        numericProductionResultEligible: calculationStatus === 'REQUIRES_PRODUCT_FACTS_AND_TAX_INPUTS',
        evidenceBackedProductCount: null,
        calculatedProductCount: null,
        missingInputProductCount: null,
        sourceBlockedProductCount: null,
        observationDate: null,
        lastVerifiedTest: CATALOG_COVERAGE_TEST,
        liveVerificationStatus: 'NOT_RUN',
      },
      remainingWork: requiredWork(hasProviderPath, sourceRights, taxClassification),
    };
  });

  const providerPathRows = rows.filter(row => row.productDiscovery.productOptionsAvailable);
  const categories = {};
  for (const row of rows) categories[row.category] = (categories[row.category] || 0) + 1;
  return {
    schemaVersion: POST_TAX_COVERAGE_MATRIX_VERSION,
    catalog: {
      source: 'server/data/investmentDatabase.js:investmentDatabase',
      instrumentCount: rows.length,
      categoryCounts: categories,
    },
    summary: {
      qualifiedProviderPathCount: providerPathRows.length,
      productionRightsQualifiedPathCount: providerPathRows.filter(row => row.sourceRights.productionUseAllowed).length,
      productionSourceBlockedPathCount: providerPathRows.filter(row => !row.sourceRights.productionUseAllowed).length,
      sourceQualifiedParentTaxClassCount: rows.filter(row => row.taxClassification.status === 'SOURCE_QUALIFIED_PARENT_CLASS').length,
      exactProductOnlyTaxClassCount: rows.filter(row => row.taxClassification.status === 'EXACT_PRODUCT_ONLY').length,
      userDeclaredScenarioImplementedParentCount: rows.filter(row => row.userDeclaredScenario.status === 'IMPLEMENTED').length,
      userDeclaredScenarioAccountFactsRequiredCount: rows.filter(row => row.userDeclaredScenario.status === 'REQUIRES_QUALIFIED_ACCOUNT_FACTS').length,
      userDeclaredScenarioUnavailableCount: rows.filter(row => row.userDeclaredScenario.status === 'TAX_CLASSIFICATION_UNAVAILABLE').length,
      liveVerifiedInstrumentCount: rows.filter(row => row.calculation.liveVerificationStatus === 'LIVE_SOURCE_VERIFIED').length,
      numericProductionResultEligibleCount: rows.filter(row => row.calculation.numericProductionResultEligible).length,
    },
    taxPolicyLineage,
    sourceRightsRegister: getPostTaxSourceRightsRegister(),
    rows,
  };
}
