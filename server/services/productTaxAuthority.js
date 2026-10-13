import { isQualifiedNiftyEtfIdentity, supportsQualifiedEtfParentCategory } from './niftyEtfProductRanking.js';

/**
 * Source-qualified product tax authority for the WTI comparison path.
 *
 * Product names and provider display IDs are presentation text. Only the
 * exact provider-qualified parent instrument mapping below, or an explicit
 * sourceQualified taxMetadata object supplied by a qualified adapter, may
 * establish a product tax class.
 */

export const PRODUCT_TAX_CLASSES = Object.freeze({
  PPF_EEE: 'PPF_ACCOUNT_EXCLUSION_CONDITIONAL',
  SSY_EEE: 'SSY_ACCOUNT_EXCLUSION_CONDITIONAL',
  BANK_DEPOSIT_INTEREST: 'BANK_DEPOSIT_INTEREST',
  RBI_FRSB_INTEREST: 'RBI_FRSB_INTEREST',
  EQUITY_MF_112A: 'EQUITY_MF_SECTION_112A',
  EQUITY_MF_ELSS: 'EQUITY_MF_ELSS_SECTION_112A',
  DEBT_MF_50AA: 'DEBT_MF_SECTION_50AA',
  SGB: 'SGB_CONDITIONAL_MATURITY_TREATMENT',
});

const NIFTYBEES_SID_URL = 'https://mf.nipponindiaim.com/InvestorServices/SIDETF/NipponIndia-ETF-Nifty-50-BeES.pdf';
const NIFTYBEES_CANONICAL_ID = 'etf:isin:INF204KB14I2';

/** Product classification evidence; statutory rates remain owned by taxEngine. */
export const NIFTYBEES_PRODUCT_TAX_EVIDENCE = Object.freeze({
  classification: 'EQUITY_ORIENTED_FUND',
  classificationBasis: 'Taxation for Equity Oriented Schemes',
  binding: Object.freeze({
    canonicalProductId: NIFTYBEES_CANONICAL_ID,
    isin: 'INF204KB14I2',
    amfiSchemeCode: '140084',
    exchange: 'NSE',
    ticker: 'NIFTYBEES',
  }),
  provider: 'NIPPON_INDIA_MUTUAL_FUND',
  authority: 'Nippon India Mutual Fund',
  documentType: 'SCHEME_INFORMATION_DOCUMENT',
  documentTitle: 'Nippon India ETF Nifty 50 BeES',
  documentDate: '2025-11-28',
  officialSourceUrl: NIFTYBEES_SID_URL,
});

export const PRODUCT_TAX_STATUSES = Object.freeze({
  CALCULATED: 'CALCULATED',
  REQUIRES_TAX_INPUTS: 'REQUIRES_TAX_INPUTS',
  TAX_CLASSIFICATION_UNAVAILABLE: 'TAX_CLASSIFICATION_UNAVAILABLE',
  FISCAL_YEAR_UNSUPPORTED: 'FISCAL_YEAR_UNSUPPORTED',
  PRODUCT_FACTS_UNAVAILABLE: 'PRODUCT_FACTS_UNAVAILABLE',
  TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS: 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS',
  SOURCE_RIGHTS_UNQUALIFIED: 'SOURCE_RIGHTS_UNQUALIFIED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const POST_TAX_CALCULATION_CLASSES = Object.freeze({
  CURRENT_RATE_POST_TAX_ILLUSTRATION: 'CURRENT_RATE_POST_TAX_ILLUSTRATION',
  HISTORICAL_RETURN_POST_TAX_ILLUSTRATION: 'HISTORICAL_RETURN_POST_TAX_ILLUSTRATION',
  MODELLED_POST_TAX_PROJECTION: 'MODELLED_POST_TAX_PROJECTION',
  TRANSACTION_TAX_ESTIMATE: 'TRANSACTION_TAX_ESTIMATE',
});

const PPF_SOURCE = Object.freeze({
  authority: 'Income Tax Department — Government of India',
  title: 'Income-tax Act, 2025 Schedule II, Table Sl. No. 3 — conditional provident-fund exclusion',
  url: 'https://incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf',
  role: 'PRODUCT_RULE',
});
const SSY_SOURCE = Object.freeze({
  authority: 'Income Tax Department — Government of India',
  title: 'Income-tax Act, 2025 Schedule II, Table Sl. No. 5 — qualifying Sukanya account payments',
  url: 'https://incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf',
  role: 'PRODUCT_RULE',
});
const FRSB_SOURCE = Object.freeze({
  authority: 'Reserve Bank of India',
  title: 'Floating Rate Savings Bonds 2020 (Taxable) guidelines',
  url: 'https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=11924',
  role: 'PRODUCT_RULE',
});
const SGB_SOURCE = Object.freeze({
  authority: 'Income Tax Department — Government of India',
  title: 'Updated Budget 2026 FAQ — Sovereign Gold Bond maturity exemption conditions',
  url: 'https://www.incometaxindia.gov.in/documents/20117/15766092/FAQs-Budget-2026%2BUpdated.pdf/daf54d14-aca9-c4ea-b786-598fd2f8d4c4',
  role: 'PRODUCT_RULE',
});
const NIFTYBEES_PRODUCT_TAX_SOURCE = Object.freeze({
  authority: NIFTYBEES_PRODUCT_TAX_EVIDENCE.authority,
  title: `${NIFTYBEES_PRODUCT_TAX_EVIDENCE.documentTitle} — Scheme Information Document dated ${NIFTYBEES_PRODUCT_TAX_EVIDENCE.documentDate}; ${NIFTYBEES_PRODUCT_TAX_EVIDENCE.classificationBasis}`,
  url: NIFTYBEES_SID_URL,
  role: 'PRODUCT_RULE',
});

const EXACT_PARENT_TAX_METADATA = Object.freeze({
  ppf: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.PPF_EEE,
    displayName: 'Public Provident Fund',
    sourceReferences: Object.freeze([PPF_SOURCE]),
    rulesApplied: Object.freeze(['PPF_ACCOUNT_EXCLUSION_CONDITIONAL']),
    factsRequired: Object.freeze(['verifiedAccountEligibility', 'contributionHistory', 'withdrawalOrMaturityFacts']),
  }),
  sukanya: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.SSY_EEE,
    displayName: 'Sukanya Samriddhi Account',
    sourceReferences: Object.freeze([SSY_SOURCE]),
    rulesApplied: Object.freeze(['SSY_ACCOUNT_EXCLUSION_CONDITIONAL']),
    factsRequired: Object.freeze(['verifiedAccountEligibility', 'eligibleBeneficiary', 'paymentFacts']),
  }),
  fd: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST,
    displayName: 'Bank fixed deposit interest',
    sourceReferences: Object.freeze([]),
    rulesApplied: Object.freeze(['BANK_DEPOSIT_INTEREST_TAXED_AT_INCOME_TAX_RATES']),
  }),
  sbi_fd: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST,
    displayName: 'SBI retail domestic term-deposit interest',
    sourceReferences: Object.freeze([]),
    rulesApplied: Object.freeze(['BANK_DEPOSIT_INTEREST_TAXED_AT_INCOME_TAX_RATES']),
  }),
  rbi_bonds: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST,
    displayName: 'RBI Floating Rate Savings Bond 2020 (Taxable)',
    sourceReferences: Object.freeze([FRSB_SOURCE]),
    rulesApplied: Object.freeze([
      'FRSB_INTEREST_TAXABLE',
      'FRSB_COUPON_RESETS_SEMIANNUALLY',
    ]),
  }),
  sgb: Object.freeze({
    taxClass: PRODUCT_TAX_CLASSES.SGB,
    displayName: 'Sovereign Gold Bond',
    sourceReferences: Object.freeze([SGB_SOURCE]),
    rulesApplied: Object.freeze(['SGB_COUPON_TAXABLE', 'SGB_MATURITY_EXEMPTION_REQUIRES_ORIGINAL_ISSUE_AND_CONTINUOUS_HOLDING']),
    factsRequired: Object.freeze(['redemptionChannel', 'acquiredAtOriginalIssue', 'heldContinuously']),
  }),
});

const UNSUPPORTED_EXACT_PARENTS = new Set([
  'scss', 'nsc', 'kvp', 'pomis', 'po_rd', 'po_td_1yr',
]);

const VALID_EXPLICIT_CLASSES = new Set(Object.values(PRODUCT_TAX_CLASSES));

function exactExternalId(product, source, expectedValue) {
  const matches = (Array.isArray(product?.externalIds) ? product.externalIds : [])
    .filter(item => item?.source === source);
  return matches.length === 1 && String(matches[0].value) === expectedValue;
}

function isExactNiftyBeesTaxProduct(product, parentInstrumentId) {
  if (parentInstrumentId !== 'nifty_etf'
      || product?.parentInstrumentId !== 'nifty_etf'
      || product?.id !== NIFTYBEES_CANONICAL_ID
      || product?.canonicalProductId !== NIFTYBEES_CANONICAL_ID
      || product?.productType !== 'ETF'
      || product?.isin !== NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.isin
      || product?.exchange !== NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.exchange
      || product?.ticker !== NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.ticker
      || !exactExternalId(product, 'ISIN', NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.isin)
      || !exactExternalId(product, 'AMFI_SCHEME_CODE', NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.amfiSchemeCode)
      || !exactExternalId(product, 'NSE_TRADING_SYMBOL', NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.ticker)) return false;

  const evidenceByUrl = new Map((Array.isArray(product.identityEvidence) ? product.identityEvidence : [])
    .map(evidence => [evidence?.url, evidence]));
  return isQualifiedNiftyEtfIdentity({
    canonicalProductId: product.canonicalProductId,
    amfiSchemeCode: NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding.amfiSchemeCode,
    isin: product.isin,
    exchange: product.exchange,
    ticker: product.ticker,
    benchmark: product.benchmark,
    identityEvidence: evidenceByUrl.get('https://nsearchives.nseindia.com/trading_security/mf/pdf/Nippon_20032026171200_NipponMutualFund.pdf'),
    listingEvidence: evidenceByUrl.get('https://nsearchives.nseindia.com/content/circulars/CMPT74390.pdf'),
    benchmarkEvidence: product.benchmark?.source,
  });
}

function unavailableTaxMetadata(reason) {
  return {
    sourceQualified: false,
    taxClass: null,
    displayName: null,
    sourceReferences: [],
    rulesApplied: [],
    effectiveDate: null,
    facts: {},
    unavailableReason: reason,
  };
}

function claimsNiftyBeesTaxEvidence(product, parentInstrumentId, explicit) {
  return parentInstrumentId === 'nifty_etf'
    || product?.parentInstrumentId === 'nifty_etf'
    || explicit?.productEvidence?.officialSourceUrl === NIFTYBEES_SID_URL
    || (Array.isArray(explicit?.sourceReferences)
      && explicit.sourceReferences.some(reference => reference?.url === NIFTYBEES_SID_URL));
}

function copyNiftyBeesTaxMetadata() {
  return {
    sourceQualified: true,
    taxClass: PRODUCT_TAX_CLASSES.EQUITY_MF_112A,
    displayName: NIFTYBEES_PRODUCT_TAX_EVIDENCE.documentTitle,
    sourceReferences: [{ ...NIFTYBEES_PRODUCT_TAX_SOURCE }],
    rulesApplied: [],
    factsRequired: ['sttConditionAssumedSatisfied'],
    effectiveDate: NIFTYBEES_PRODUCT_TAX_EVIDENCE.documentDate,
    facts: { classification: NIFTYBEES_PRODUCT_TAX_EVIDENCE.classification },
    productEvidence: {
      ...NIFTYBEES_PRODUCT_TAX_EVIDENCE,
      binding: { ...NIFTYBEES_PRODUCT_TAX_EVIDENCE.binding },
    },
  };
}

function copyMetadata(metadata) {
  return {
    ...metadata,
    sourceReferences: (metadata.sourceReferences || []).map(source => ({ ...source })),
    rulesApplied: [...(metadata.rulesApplied || [])],
    factsRequired: [...(metadata.factsRequired || [])],
  };
}

/**
 * Return tax metadata only when its provenance is explicit and qualified.
 */
export function getProductTaxMetadata(product = {}, parentInstrumentId = product.parentInstrumentId) {
  const explicit = product?.taxMetadata;
  if (claimsNiftyBeesTaxEvidence(product, parentInstrumentId, explicit)) {
    if (!isExactNiftyBeesTaxProduct(product, parentInstrumentId)) {
      return unavailableTaxMetadata('NIFTYBEES_TAX_EVIDENCE_BINDING_MISMATCH');
    }
    return copyNiftyBeesTaxMetadata();
  }

  if (explicit?.sourceQualified === true && VALID_EXPLICIT_CLASSES.has(explicit.taxClass)) {
    return {
      sourceQualified: true,
      taxClass: explicit.taxClass,
      displayName: explicit.displayName || explicit.taxClass,
      sourceReferences: Array.isArray(explicit.sourceReferences)
        ? explicit.sourceReferences.map(source => ({ ...source }))
        : [],
      rulesApplied: Array.isArray(explicit.rulesApplied) ? [...explicit.rulesApplied] : [],
      factsRequired: Array.isArray(explicit.factsRequired) ? [...explicit.factsRequired] : [],
      effectiveDate: explicit.effectiveDate || null,
      facts: explicit.facts ? { ...explicit.facts } : {},
      ...(explicit.productEvidence ? { productEvidence: structuredClone(explicit.productEvidence) } : {}),
    };
  }

  const exactParent = typeof parentInstrumentId === 'string'
    ? EXACT_PARENT_TAX_METADATA[parentInstrumentId]
    : null;
  if (exactParent) {
    return { sourceQualified: true, ...copyMetadata(exactParent) };
  }

  return {
    sourceQualified: false,
    taxClass: null,
    displayName: null,
    sourceReferences: [],
    rulesApplied: [],
    effectiveDate: null,
    facts: {},
    unavailableReason: UNSUPPORTED_EXACT_PARENTS.has(parentInstrumentId)
      ? 'This product category has no qualified tax adapter in the current WTI contract.'
      : 'The qualified provider did not supply a tax classification for this product.',
  };
}

/**
 * Resolve tax metadata for a user-declared scenario without accepting tax
 * classes or source facts from the request. The only exact ETF scenario is
 * bound to the server-qualified canonical NIFTYBEES identity.
 */
export function getUserScenarioTaxMetadata(parentInstrumentId, canonicalProductId = null) {
  if (parentInstrumentId === 'nifty_etf') {
    if (canonicalProductId !== NIFTYBEES_CANONICAL_ID || !supportsQualifiedEtfParentCategory(parentInstrumentId)) {
      return unavailableTaxMetadata('EXACT_ETF_IDENTITY_NOT_QUALIFIED');
    }
    return copyNiftyBeesTaxMetadata();
  }
  if (canonicalProductId !== null) return unavailableTaxMetadata('CANONICAL_PRODUCT_ID_NOT_QUALIFIED_FOR_PARENT');
  return getProductTaxMetadata({}, parentInstrumentId);
}

export function getRequiredTaxInputs(taxClass) {
  if ([PRODUCT_TAX_CLASSES.PPF_EEE, PRODUCT_TAX_CLASSES.SSY_EEE].includes(taxClass)) {
    return taxClass === PRODUCT_TAX_CLASSES.PPF_EEE
      ? ['verifiedAccountEligibility', 'contributionHistory', 'withdrawalOrMaturityFacts']
      : ['verifiedAccountEligibility', 'eligibleBeneficiary', 'paymentFacts'];
  }
  if ([
    PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST,
    PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST,
  ].includes(taxClass)) {
    return ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge'];
  }
  if (taxClass === PRODUCT_TAX_CLASSES.SGB) {
    return ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge', 'redemptionChannel', 'acquiredAtOriginalIssue', 'heldContinuously'];
  }
  if (taxClass === PRODUCT_TAX_CLASSES.DEBT_MF_50AA) {
    return ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge', 'holdingPeriodMonths'];
  }
  if ([PRODUCT_TAX_CLASSES.EQUITY_MF_112A, PRODUCT_TAX_CLASSES.EQUITY_MF_ELSS].includes(taxClass)) {
    return [
      'annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear',
      'userAge',
      'holdingPeriodMonths', 'section112AExemptionUsed', 'sttConditionAssumedSatisfied',
    ];
  }
  return [];
}

export function classifySourceQualifiedProductTaxType(product, parentInstrumentId) {
  return getProductTaxMetadata(product, parentInstrumentId).taxClass
    || 'TAX_CLASSIFICATION_UNAVAILABLE';
}

export { EXACT_PARENT_TAX_METADATA, UNSUPPORTED_EXACT_PARENTS };
