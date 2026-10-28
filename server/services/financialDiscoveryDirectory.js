/**
 * Source-backed educational directory: all 250 WealthGenie investment families
 * independent of PostgreSQL, profile, brokerage login or licensed market feeds.
 * This is NOT a product/market-rate/recommendation API.
 */
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';

const extensions = JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8',
)).entries;

const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const asText = s => typeof s === 'string' && s.trim() ? s.trim() : null;
const httpsUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      ? url.href : null;
  } catch { return null; }
};
const missingFacts = Object.freeze({
  currentPrice: null,
  latestNav: null,
  currentInterestRate: null,
  verifiedMinimumInvestment: null,
  verifiedFees: null,
  personalizedAfterTaxReturn: null,
  marketFactAsOf: null,
});
function buildDirectory() {
  if (investmentDatabase.length !== 155 || extensions.length !== 95) {
    throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_COUNT_CHANGED');
  }
  const legacy = investmentDatabase.map(item => ({
    id: item.id, name: item.name, category: item.category,
    subcategory: item.subCategory || null,
    record_kind: 'ARCHETYPE', origin: 'LEGACY_155',
    instrumentForm: null,
    description: asText(item.description),
    // The source catalog may contain assumptions, which are NOT market quotes.
    educationalRiskLabel: asText(item.riskLabel),
    educationalRiskBasis: 'UNVERIFIED_LEGACY_CATALOG_REFERENCE',
    referenceUrl: null, referenceCheckedAsOf: null,
    productData: { ...missingFacts },
    productAvailability: 'NOT_VERIFIED',
    dataRights: 'NOT_VERIFIED',
    recommendationEligible: false,
  }));
  const expanded = extensions.map(item => ({
    id: item.id, name: item.name, category: item.category,
    subcategory: item.subCategory || null,
    record_kind: 'ARCHETYPE', origin: 'EXTENDED_95',
    instrumentForm: asText(item.instrumentForm),
    description: null, educationalRiskLabel: null,
    educationalRiskBasis: 'NOT_ESTABLISHED',
    referenceUrl: httpsUrl(item.sourceUrl),
    referenceCheckedAsOf: item.researchEvidence?.referenceCheckedAsOf ?? null,
    productData: { ...missingFacts },
    productAvailability: 'NOT_VERIFIED',
    dataRights: 'NOT_VERIFIED',
    recommendationEligible: false,
  }));
  const rows = [...legacy, ...expanded];
  const ids = new Set(), names = new Set();
  for (const item of rows) {
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(item.id)
      || !asText(item.name) || !asText(item.category)
      || ids.has(item.id) || names.has(normalize(item.name))
      || (item.origin === 'EXTENDED_95' && !item.referenceUrl)) {
      throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_INVALID_ENTRY:' + item.id);
    }
    ids.add(item.id); names.add(normalize(item.name));
  }
  if (rows.length !== 250) throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_MISSING_ENTRIES');
  return rows;
}
const DIRECTORY = Object.freeze(buildDirectory().map(row => Object.freeze(row)));
export function listFinancialDiscoveryDirectory() {
  return {
    status: 'DISCOVERY_ONLY',
    source: 'WEALTHGENIE_CATALOG_155_PLUS_95',
    totalCount: DIRECTORY.length,
    actualProductCount: 0,
    actualProductCountBasis: 'CATALOG_SOURCE_ONLY_NOT_LIVE_DATABASE',
    marketFactsAvailable: false,
    disclaimer: '250 educational investment categories, not 250 verified purchasable products. No current prices, rates, tax outcomes or personalized investment recommendations are established by this catalog.',
    items: DIRECTORY.map(item => ({ ...item, productData: { ...item.productData } })),
  };
}
