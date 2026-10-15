import { PROVIDERS } from './marketData/contracts.js';
import { AMFI_NAV_URL } from './marketData/AmfiNavProvider.js';
import { AMFI_NAV_HISTORY_URL } from './marketData/AmfiNavHistoryProvider.js';
import { INDIA_POST_SAVINGS_URL } from './marketData/GovernmentSmallSavingsProvider.js';
import { SBI_TERM_DEPOSIT_URL } from './marketData/SbiTermDepositProvider.js';
import { RBI_FRSB_NOTIFICATION_URL } from './marketData/RbiFloatingRateSavingsBondProvider.js';

export const POST_TAX_SOURCE_RIGHTS_STATES = Object.freeze({
  APPROVED_FOR_INTENDED_USE: 'APPROVED_FOR_INTENDED_USE',
  APPROVED_LIMITED_USE: 'APPROVED_LIMITED_USE',
  DEVELOPMENT_RESEARCH_ONLY: 'DEVELOPMENT_RESEARCH_ONLY',
  PERSONAL_USE_ONLY: 'PERSONAL_USE_ONLY',
  BLOCKED_REUSE_RIGHTS: 'BLOCKED_REUSE_RIGHTS',
  BLOCKED_AUTOMATED_ACCESS: 'BLOCKED_AUTOMATED_ACCESS',
  LICENSE_UNVERIFIED: 'LICENSE_UNVERIFIED',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
});

const { APPROVED_FOR_INTENDED_USE, APPROVED_LIMITED_USE, DEVELOPMENT_RESEARCH_ONLY,
  BLOCKED_REUSE_RIGHTS, LICENSE_UNVERIFIED } = POST_TAX_SOURCE_RIGHTS_STATES;

const UNKNOWN_RIGHTS = Object.freeze({
  access: LICENSE_UNVERIFIED,
  extraction: LICENSE_UNVERIFIED,
  derivedCalculation: LICENSE_UNVERIFIED,
  storage: LICENSE_UNVERIFIED,
  publicDisplay: LICENSE_UNVERIFIED,
  commercialUse: LICENSE_UNVERIFIED,
  redistribution: LICENSE_UNVERIFIED,
  userProvidedDataProcessing: LICENSE_UNVERIFIED,
});

function sourceRecord({
  sourceId,
  provider,
  url,
  matchPath,
  status,
  termsUrl,
  rights,
  basis,
  scopes = [],
}) {
  return Object.freeze({
    sourceId,
    provider,
    url,
    matchPath,
    status,
    termsUrl,
    rights: Object.freeze(rights),
    approvedScopes: Object.freeze(scopes),
    basis,
  });
}

const SOURCE_RECORDS = Object.freeze([
  sourceRecord({
    sourceId: 'AMFI_CURRENT_NAV', provider: PROVIDERS.AMFI, url: AMFI_NAV_URL,
    matchPath: '/spages/NAVAll.txt', status: BLOCKED_REUSE_RIGHTS,
    termsUrl: 'https://www.amfiindia.com/terms-of-use',
    rights: {
      access: APPROVED_LIMITED_USE, extraction: LICENSE_UNVERIFIED,
      derivedCalculation: BLOCKED_REUSE_RIGHTS, storage: BLOCKED_REUSE_RIGHTS,
      publicDisplay: BLOCKED_REUSE_RIGHTS, commercialUse: BLOCKED_REUSE_RIGHTS,
      redistribution: BLOCKED_REUSE_RIGHTS, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'AMFI terms limit use to personal, non-commercial permitted uses; broader publication, derivative works, and significant electronic storage are restricted absent a separate written agreement.',
  }),
  sourceRecord({
    sourceId: 'AMFI_HISTORICAL_NAV', provider: PROVIDERS.AMFI, url: AMFI_NAV_HISTORY_URL,
    matchPath: '/DownloadNAVHistoryReport_Po.aspx', status: BLOCKED_REUSE_RIGHTS,
    termsUrl: 'https://www.amfiindia.com/terms-of-use',
    rights: {
      access: APPROVED_LIMITED_USE, extraction: LICENSE_UNVERIFIED,
      derivedCalculation: BLOCKED_REUSE_RIGHTS, storage: BLOCKED_REUSE_RIGHTS,
      publicDisplay: BLOCKED_REUSE_RIGHTS, commercialUse: BLOCKED_REUSE_RIGHTS,
      redistribution: BLOCKED_REUSE_RIGHTS, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'AMFI terms limit use to personal, non-commercial permitted uses; broader publication, derivative works, and significant electronic storage are restricted absent a separate written agreement.',
  }),
  sourceRecord({
    sourceId: 'INDIA_POST_SMALL_SAVINGS', provider: PROVIDERS.GOVERNMENT_OF_INDIA,
    url: INDIA_POST_SAVINGS_URL, matchPath: '/banking-services/savings', status: BLOCKED_REUSE_RIGHTS,
    termsUrl: 'https://www.indiapost.gov.in/website-policy',
    rights: {
      access: APPROVED_LIMITED_USE, extraction: LICENSE_UNVERIFIED,
      derivedCalculation: LICENSE_UNVERIFIED, storage: LICENSE_UNVERIFIED,
      publicDisplay: BLOCKED_REUSE_RIGHTS, commercialUse: BLOCKED_REUSE_RIGHTS,
      redistribution: BLOCKED_REUSE_RIGHTS, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'India Post says site access does not grant reproduction or distribution rights and requires prior approval for those uses.',
  }),
  sourceRecord({
    sourceId: 'SBI_RETAIL_TERM_DEPOSIT', provider: PROVIDERS.SBI,
    url: SBI_TERM_DEPOSIT_URL, matchPath: '/web/interest-rates/deposit-rates/retail-domestic-term-deposits',
    status: BLOCKED_REUSE_RIGHTS, termsUrl: SBI_TERM_DEPOSIT_URL,
    rights: {
      ...UNKNOWN_RIGHTS,
      publicDisplay: BLOCKED_REUSE_RIGHTS,
      commercialUse: BLOCKED_REUSE_RIGHTS,
    },
    basis: 'The SBI rate-card page states that its content must not be displayed or printed, in part or whole, without prior written SBI approval. Other extraction, storage, and derived-calculation rights remain unverified.',
  }),
  sourceRecord({
    sourceId: 'RBI_FRSB_NOTIFICATION', provider: PROVIDERS.RBI,
    url: RBI_FRSB_NOTIFICATION_URL, matchPath: '/scripts/NotificationUser.aspx',
    status: LICENSE_UNVERIFIED, termsUrl: null,
    rights: { ...UNKNOWN_RIGHTS },
    basis: 'The official RBI source establishes bond-rule evidence; no exact automated retrieval, storage, derived-calculation, public-display, or commercial-use permission record is present in the repository.',
  }),
]);

const POTENTIAL_SOURCE_RECORDS = Object.freeze([
  ...SOURCE_RECORDS,
  sourceRecord({
    sourceId: 'NSE_MCP_BHAVCOPY', provider: 'NSE_MCP',
    url: 'https://mcp.nseindia.in/bhavcopy/cm/mcp', matchPath: '/bhavcopy/cm/mcp',
    status: DEVELOPMENT_RESEARCH_ONLY, termsUrl: 'https://www.nseindia.com/nse-mcp',
    rights: {
      access: DEVELOPMENT_RESEARCH_ONLY, extraction: DEVELOPMENT_RESEARCH_ONLY,
      derivedCalculation: DEVELOPMENT_RESEARCH_ONLY, storage: LICENSE_UNVERIFIED,
      publicDisplay: BLOCKED_REUSE_RIGHTS, commercialUse: BLOCKED_REUSE_RIGHTS,
      redistribution: BLOCKED_REUSE_RIGHTS, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'NSE limits MCP access to educational and informational purposes and expressly excludes commercial deployment and commercial exploitation.',
  }),
  sourceRecord({
    sourceId: 'NSE_MCP_CASH_MARKET', provider: 'NSE_MCP',
    url: 'https://mcp.nseindia.in/cmmkt/mcp', matchPath: '/cmmkt/mcp',
    status: DEVELOPMENT_RESEARCH_ONLY, termsUrl: 'https://www.nseindia.com/nse-mcp',
    rights: {
      access: DEVELOPMENT_RESEARCH_ONLY, extraction: DEVELOPMENT_RESEARCH_ONLY,
      derivedCalculation: DEVELOPMENT_RESEARCH_ONLY, storage: LICENSE_UNVERIFIED,
      publicDisplay: BLOCKED_REUSE_RIGHTS, commercialUse: BLOCKED_REUSE_RIGHTS,
      redistribution: BLOCKED_REUSE_RIGHTS, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'NSE limits MCP access to educational and informational purposes and expressly excludes commercial deployment and commercial exploitation.',
  }),
  sourceRecord({
    sourceId: 'DEA_SMALL_SAVINGS_NOTIFICATIONS', provider: 'DEA',
    url: 'https://dea.gov.in/budget-division/475', matchPath: '/budget-division/475',
    status: LICENSE_UNVERIFIED, termsUrl: null,
    rights: { ...UNKNOWN_RIGHTS },
    basis: 'The official listing showed the Q3 FY2026-27 small-savings notification dated 30 September 2026, but no exact reuse terms or automated production permission were qualified.',
  }),
  sourceRecord({
    sourceId: 'RBI_PUBLIC_DATA', provider: 'RBI', url: 'https://www.rbi.org.in/', matchPath: '/',
    status: LICENSE_UNVERIFIED, termsUrl: null,
    rights: { ...UNKNOWN_RIGHTS },
    basis: 'RBI releases and datasets have source-specific provenance; no exact terms covering automated extraction, storage, calculation, commercial use, and public display for the proposed product facts were qualified.',
  }),
  sourceRecord({
    sourceId: 'PFRDA_NPS_NAV', provider: 'PFRDA',
    url: 'https://pfrda.org.in/en/research-publications/statistics/statistical-data',
    matchPath: '/en/research-publications/statistics/statistical-data', status: LICENSE_UNVERIFIED,
    termsUrl: 'https://www.pfrda.org.in/web/pfrda/get-to-know/website-policies',
    rights: {
      access: APPROVED_LIMITED_USE, extraction: LICENSE_UNVERIFIED,
      derivedCalculation: LICENSE_UNVERIFIED, storage: LICENSE_UNVERIFIED,
      publicDisplay: LICENSE_UNVERIFIED, commercialUse: LICENSE_UNVERIFIED,
      redistribution: LICENSE_UNVERIFIED, userProvidedDataProcessing: LICENSE_UNVERIFIED,
    },
    basis: 'PFRDA policy allows reproduction of PFRDA-owned material with credit, but the exact downloaded scheme NAV content and third-party rights were not qualified for commercial use.',
  }),
  sourceRecord({
    sourceId: 'LIC_ULIP_NAV', provider: 'LIC', url: 'https://www.licindia.in/en/plan-nav1',
    matchPath: '/en/plan-nav1', status: LICENSE_UNVERIFIED,
    termsUrl: 'https://web.licindia.in/web/guest/copyright-policy',
    rights: { ...UNKNOWN_RIGHTS },
    basis: 'LIC copyright policy permits accurate attributed reproduction of LIC-owned material, but excludes third-party material. Ownership of each ULIP NAV series and automated retrieval scope were not established.',
  }),
  sourceRecord({
    sourceId: 'OGD_DATASET', provider: 'DATA_GOV_IN', url: 'https://data.gov.in/', matchPath: '/',
    status: LICENSE_UNVERIFIED, termsUrl: 'https://www.data.gov.in/terms-of-use',
    rights: { ...UNKNOWN_RIGHTS },
    basis: 'The portal directs users to each dataset record’s license metadata and excludes third-party-owned content from blanket permission. No exact keyless dataset with a suitable dataset-level license for this product was identified.',
  }),
]);

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function matchesRecord(record, provider, rawUrl) {
  if (record.provider !== provider) return false;
  const candidate = normalizedUrl(rawUrl);
  const expected = normalizedUrl(record.url);
  return Boolean(candidate && expected
    && candidate.hostname.toLowerCase() === expected.hostname.toLowerCase()
    && candidate.pathname === record.matchPath);
}

function isAuthorizedForProduction(record) {
  const intendedUseRights = ['access', 'extraction', 'derivedCalculation', 'storage', 'publicDisplay', 'commercialUse'];
  const rightsAreApproved = intendedUseRights.every(key => record.rights[key] === APPROVED_FOR_INTENDED_USE
    || record.rights[key] === APPROVED_LIMITED_USE);
  if (!rightsAreApproved) return false;
  if (record.status === APPROVED_FOR_INTENDED_USE) return true;
  return record.status === APPROVED_LIMITED_USE
    && record.approvedScopes.includes('PRODUCTION_POST_TAX_DISPLAY_AND_CALCULATION');
}

function unknownDecision(provider, url = null) {
  return {
    sourceId: null,
    provider: provider || null,
    url: url || null,
    status: LICENSE_UNVERIFIED,
    termsUrl: null,
    rights: { ...UNKNOWN_RIGHTS },
    approvedScopes: [],
    productionPostTaxUseAllowed: false,
    basis: 'No exact provider, endpoint, and intended-use permission record is qualified.',
  };
}

function decisionForRecord(record) {
  return {
    sourceId: record.sourceId,
    provider: record.provider,
    url: record.url,
    status: record.status,
    termsUrl: record.termsUrl,
    rights: { ...record.rights },
    approvedScopes: [...record.approvedScopes],
    productionPostTaxUseAllowed: isAuthorizedForProduction(record),
    basis: record.basis,
  };
}

export function resolvePostTaxSourceRights({ provider, url } = {}) {
  const record = SOURCE_RECORDS.find(candidate => matchesRecord(candidate, provider, url));
  if (record) return decisionForRecord(record);
  const potential = POTENTIAL_SOURCE_RECORDS.find(candidate => matchesRecord(candidate, provider, url));
  if (potential) return decisionForRecord(potential);
  return unknownDecision(provider, url);
}

export function resolvePostTaxProviderRights(provider) {
  const records = SOURCE_RECORDS.filter(record => record.provider === provider);
  if (records.length === 0) return unknownDecision(provider);
  const decisions = records.map(decisionForRecord);
  const order = [
    POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS,
    POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_AUTOMATED_ACCESS,
    POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY,
    POST_TAX_SOURCE_RIGHTS_STATES.PERSONAL_USE_ONLY,
    POST_TAX_SOURCE_RIGHTS_STATES.LICENSE_UNVERIFIED,
    POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_LIMITED_USE,
    POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_FOR_INTENDED_USE,
  ];
  const status = order.find(value => decisions.some(decision => decision.status === value))
    || POST_TAX_SOURCE_RIGHTS_STATES.SOURCE_UNAVAILABLE;
  return {
    sourceIds: decisions.map(decision => decision.sourceId),
    provider,
    status,
    termsUrls: [...new Set(decisions.map(decision => decision.termsUrl).filter(Boolean))],
    sources: decisions,
    productionPostTaxUseAllowed: decisions.length > 0
      && decisions.every(decision => decision.productionPostTaxUseAllowed),
    basis: decisions.map(decision => decision.basis).join(' '),
  };
}

function productSources(product, taxMetadata = product?.taxMetadata) {
  const sources = [];
  const historySource = product?.historicalReturn?.source;
  const historyObservationUrls = [historySource?.startObservationUrl, historySource?.endObservationUrl].filter(Boolean);
  for (const candidate of [
    product?.source,
    product?.primaryFact?.source,
    product?.officialRate?.source,
    product?.officialRate?.referenceRateFact?.source,
    product?.nav?.source,
    ...(historyObservationUrls.length === 0 ? [historySource] : []),
  ]) {
    if (candidate?.provider) sources.push({ provider: candidate.provider, url: candidate.url || null });
  }
  for (const url of historyObservationUrls) {
    if (historySource?.provider) sources.push({ provider: historySource.provider, url });
  }
  const classificationSources = [
    ...(Array.isArray(taxMetadata?.sourceReferences) ? taxMetadata.sourceReferences : []),
    ...(Array.isArray(product?.taxMetadata?.sourceReferences) ? product.taxMetadata.sourceReferences : []),
  ];
  for (const reference of classificationSources) {
    const provider = reference?.provider || reference?.authority;
    if (provider && reference?.url) sources.push({ provider, url: reference.url });
  }
  const productEvidenceUrl = taxMetadata?.productEvidence?.officialSourceUrl
    || product?.taxMetadata?.productEvidence?.officialSourceUrl;
  const productEvidenceProvider = taxMetadata?.productEvidence?.provider
    || product?.taxMetadata?.productEvidence?.provider;
  if (productEvidenceProvider && productEvidenceUrl) {
    sources.push({ provider: productEvidenceProvider, url: productEvidenceUrl });
  }
  if (sources.length === 0 && product?.provider) {
    sources.push({ provider: product.provider, url: null });
  }
  const unique = new Map(sources.map(source => [`${source.provider}|${source.url || ''}`, source]));
  return [...unique.values()];
}

export function resolvePostTaxProductRights(product = {}, taxMetadata = product?.taxMetadata) {
  const sources = productSources(product, taxMetadata).map(resolvePostTaxSourceRights);
  if (sources.length === 0) return unknownDecision(null);
  const order = [
    POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_REUSE_RIGHTS,
    POST_TAX_SOURCE_RIGHTS_STATES.BLOCKED_AUTOMATED_ACCESS,
    POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY,
    POST_TAX_SOURCE_RIGHTS_STATES.PERSONAL_USE_ONLY,
    POST_TAX_SOURCE_RIGHTS_STATES.LICENSE_UNVERIFIED,
    POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_LIMITED_USE,
    POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_FOR_INTENDED_USE,
  ];
  return {
    provider: sources.length === 1 ? sources[0].provider : 'MULTIPLE_SOURCES',
    status: order.find(status => sources.some(source => source.status === status))
      || POST_TAX_SOURCE_RIGHTS_STATES.SOURCE_UNAVAILABLE,
    termsUrls: [...new Set(sources.map(source => source.termsUrl).filter(Boolean))],
    sources,
    productionPostTaxUseAllowed: sources.every(source => source.productionPostTaxUseAllowed),
    basis: sources.map(source => source.basis).join(' '),
  };
}

export function isPostTaxSourceProductionAllowed(provider) {
  return resolvePostTaxProviderRights(provider).productionPostTaxUseAllowed;
}

export function getPostTaxSourceRightsRegister() {
  return POTENTIAL_SOURCE_RECORDS.map(record => decisionForRecord(record));
}
