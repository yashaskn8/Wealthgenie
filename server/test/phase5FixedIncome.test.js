import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GOVERNMENT_SAVINGS_CACHE_KEY,
  parseIndiaPostSavingsBundle,
  governmentSavingsCacheKeyAt,
} from '../services/marketData/GovernmentSmallSavingsProvider.js';
import {
  parseSbiRetailTermDepositPage,
  SBI_TERM_DEPOSIT_CACHE_KEY,
} from '../services/marketData/SbiTermDepositProvider.js';
import {
  compareVerifiedFixedIncomeProducts,
  selectCurrentEffectiveFact,
} from '../services/fixedIncomeProductRanking.js';
import { buildObservationOperations } from '../services/marketData/MarketDataRepository.js';
import { rankWhereToInvestBackend } from '../services/RecommendationPipeline.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import {
  calculateFrsbResetPeriod,
  RBI_FRSB_CACHE_KEY,
  rbiFrsbCacheKeyAt,
  deriveRbiFloatingRateSavingsBondSnapshot,
  parseRbiOperationalGuidelines,
  RBI_FRSB_NOTIFICATION_URL,
} from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';
import { AVAILABILITY, PROVIDERS } from '../services/marketData/contracts.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const ROWS = [
  { slNo: '01.', instrument: 'Post Office Savings Account', interestRate: '4.0%', compoundingFrequency: 'Annually' },
  { slNo: '02.', instrument: '1 Year Time Deposit', interestRate: '6.9%', compoundingFrequency: 'Quarterly' },
  { slNo: '03.', instrument: '2 Year Time Deposit', interestRate: '7.0%', compoundingFrequency: 'Quarterly' },
  { slNo: '04.', instrument: '3 Year Time Deposit', interestRate: '7.1%', compoundingFrequency: 'Quarterly' },
  { slNo: '05.', instrument: '5 Year Time Deposit', interestRate: '7.5%', compoundingFrequency: 'Quarterly' },
  { slNo: '06.', instrument: '5 Year Recurring Deposit Scheme', interestRate: '6.7%', compoundingFrequency: 'Quarterly' },
  { slNo: '07.', instrument: 'Senior Citizen Savings Scheme', interestRate: '8.2%', compoundingFrequency: 'Quarterly and Paid' },
  { slNo: '08.', instrument: 'Monthly Income Account', interestRate: '7.4%', compoundingFrequency: 'Monthly and paid' },
  { slNo: '09.', instrument: 'National Savings Certificate (VIII Issue)', interestRate: '7.7%', compoundingFrequency: 'Annually' },
  { slNo: '10.', instrument: 'Public Provident Fund Scheme', interestRate: '7.1%', compoundingFrequency: 'Annually' },
  { slNo: '11.', instrument: 'Kisan Vikas Patra', interestRate: '7.5%', compoundingFrequency: 'Annually' },
  { slNo: '13.', instrument: 'Sukanya Samriddhi Account Scheme', interestRate: '8.2%', compoundingFrequency: 'Annually' },
];

function governmentBundle(from = '01.07.2026', to = '30.09.2026', rows = ROWS) {
  return `const w=JSON.parse('${JSON.stringify(rows)}'),S=()=>"Post Office Small Savings Schemes (w.e.f ${from} to ${to})";`;
}

const SBI_TENURES = [
  ['7 days to 45 days', '3.05', '3.05', '3.55', '3.55'],
  ['46 days to 179 days', '4.90', '4.90', '5.40', '5.40'],
  ['180 days to 210 days', '5.65', '5.65', '6.15', '6.15'],
  ['211 days to less than 1 year', '5.90', '5.90', '6.40', '6.40'],
  ['1 Year to less than 2 years', '6.25', '6.25', '6.75', '6.75'],
  ['2 years to less than 3 years', '6.45', '6.40', '6.95', '6.90'],
  ['3 years to less than 5 years', '6.30', '6.30', '6.80', '6.80'],
  ['5 years and up to 10 years', '6.05', '6.05', '7.05', '7.05'],
];

function sbiPage(rows = SBI_TENURES) {
  const body = rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('');
  return `<html><table><tr><th>Tenors</th><th>Existing Rates for Public w.e.f. 15/07/2025</th><th>Revised Rates for Public w.e.f.15/12/2025</th><th>Existing Rates for Senior Citizen w.e.f. 15/07/2025</th><th>Revised Rates for Senior Citizen w.e.f. 15/12/2025</th></tr>${body}</table><p>Last Updated On : Tuesday, 16-06-2026 Interest Rates Quick Links</p></html>`;
}

test('official India Post parser preserves rate semantics and effective interval', () => {
  const snapshot = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.dataClass, 'QUARTERLY_OFFICIAL_RATE');
  assert.equal(snapshot.effectiveFrom, '2026-07-01');
  assert.equal(snapshot.effectiveTo, '2026-09-30');
  const ppf = snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':ppf'));
  assert.equal(ppf.value, 7.1);
  assert.equal(ppf.unit, 'PERCENT_PER_ANNUM');
  assert.equal(ppf.compoundingBasis, 'Annually');
  assert.equal(ppf.freshness.status, 'FRESH');
  assert.equal(ppf.source.provider, 'GOVERNMENT_OF_INDIA');
  assert.deepEqual(
    [...new Set(snapshot.facts.map(fact => fact.compoundingBasis).filter(Boolean))].sort(),
    ['Annually', 'Monthly and paid', 'Quarterly', 'Quarterly and Paid'].sort(),
  );
});

test('official India Post parser accepts published parenthetical payout and maturity details', () => {
  const sourceFormattedRows = ROWS.map(row => {
    const interestRate = {
      '1 Year Time Deposit': '6.9%(Annual Interest ₹708 for ₹10,000/-)',
      '2 Year Time Deposit': '7.0%(Annual Interest ₹719 for ₹10,000/-)',
      '3 Year Time Deposit': '7.1%(Annual Interest ₹729 for ₹10,000/-)',
      '5 Year Time Deposit': '7.5%(Annual Interest ₹771 for ₹10,000/-)',
      'Senior Citizen Savings Scheme': '8.2%(Quarterly Interest ₹205 for ₹10,000/-)',
      'Monthly Income Account': '7.4%(Monthly Interest ₹62 for ₹10,000/-)',
      'National Savings Certificate (VIII Issue)': '7.7%(Maturity Value ₹14,490 for ₹10,000/-)',
      'Kisan Vikas Patra': '7.5%(will mature in 115 months)',
    }[row.instrument] || row.interestRate;
    return { ...row, interestRate };
  });
  const snapshot = parseIndiaPostSavingsBundle(
    governmentBundle('01.10.2026', '31.12.2026', sourceFormattedRows),
    { fetchedAt: '2026-10-09T04:10:00.000Z', now: new Date('2026-10-09T04:10:00.000Z') },
  );

  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.availableFactCount, ROWS.length);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':post-office-td-1y')).value, 6.9);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':scss')).value, 8.2);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':pomis')).value, 7.4);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':nsc')).value, 7.7);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':kvp')).value, 7.5);
  assert(snapshot.facts.every(fact => fact.effectiveFrom === '2026-10-01' && fact.effectiveTo === '2026-12-31'));
});

test('official India Post parser rejects a duplicate scheme identity even when row count matches', () => {
  const duplicateNscRows = [
    ...ROWS.slice(1),
    { ...ROWS[8], slNo: '12.', interestRate: '99.0%' },
  ];
  assert.throws(() => parseIndiaPostSavingsBundle(governmentBundle(undefined, undefined, duplicateNscRows), {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /incomplete_rate_table/);
});

test('official India Post parser never converts negative or malformed rates into positive facts', () => {
  const rows = ROWS.map(row => row.instrument === 'Public Provident Fund Scheme'
    ? { ...row, interestRate: '-1.5%' }
    : row);
  const snapshot = parseIndiaPostSavingsBundle(governmentBundle('01.07.2026', '30.09.2026', rows), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const ppf = snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':ppf'));

  assert.equal(snapshot.status, 'PARTIAL');
  assert.equal(ppf.value, null);
  assert.equal(ppf.availabilityStatus, AVAILABILITY.UNAVAILABLE);
  assert.equal(compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'ppf', snapshot, profile: canonicalProfile(), now: NOW,
  }).products.length, 0);

  const malformedRows = ROWS.map(row => row.instrument === 'Public Provident Fund Scheme'
    ? { ...row, interestRate: 'approx 7.1%' }
    : row);
  const malformed = parseIndiaPostSavingsBundle(governmentBundle('01.07.2026', '30.09.2026', malformedRows), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const malformedPpf = malformed.facts.find(fact => fact.canonicalProductId.endsWith(':ppf'));
  assert.equal(malformedPpf.value, null);
  assert.equal(malformedPpf.availabilityStatus, AVAILABILITY.UNAVAILABLE);

  for (const invalidRate of ['7.1%garbage', '7.1% approx', '7.1%(Approx ₹710)', '7.1%(Annual Interest 7.1%)', 'NaN%', 'Infinity%', '', '0%']) {
    const invalidRows = ROWS.map(row => row.instrument === 'Public Provident Fund Scheme'
      ? { ...row, interestRate: invalidRate }
      : row);
    const invalidSnapshot = parseIndiaPostSavingsBundle(
      governmentBundle('01.07.2026', '30.09.2026', invalidRows),
      { fetchedAt: NOW.toISOString(), now: NOW },
    );
    const invalidPpf = invalidSnapshot.facts.find(fact => fact.canonicalProductId.endsWith(':ppf'));
    assert.equal(invalidPpf.value, null, `${JSON.stringify(invalidRate)} must not be parsed as a usable rate`);
    assert.equal(invalidPpf.availabilityStatus, AVAILABILITY.UNAVAILABLE);
  }
});

test('official India Post parser does not expose unknown compounding metadata as verified', () => {
  const rows = ROWS.map(row => row.instrument === 'Public Provident Fund Scheme'
    ? { ...row, compoundingFrequency: 'annually, guaranteed forever' }
    : row);
  const snapshot = parseIndiaPostSavingsBundle(governmentBundle('01.07.2026', '30.09.2026', rows), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const ppf = snapshot.facts.find(fact => fact.canonicalProductId.endsWith(':ppf'));

  assert.equal(ppf.value, 7.1);
  assert.equal(ppf.compoundingBasis, null);
  assert.equal(ppf.availabilityStatus, AVAILABILITY.AVAILABLE);
});

test('multiple official intervals remain distinct and latest current fact is selected', () => {
  const prior = parseIndiaPostSavingsBundle(governmentBundle('01.04.2026', '30.06.2026'), {
    fetchedAt: '2026-06-01T00:00:00.000Z', now: new Date('2026-06-01T00:00:00.000Z'),
  });
  const current = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const id = 'government:india-post:ppf';
  const selected = selectCurrentEffectiveFact([...prior.facts, ...current.facts], id, NOW);
  assert.equal(selected.effectiveFrom, '2026-07-01');
  assert.equal(buildObservationOperations(prior).length, ROWS.length);
  assert.equal(buildObservationOperations(current).length, ROWS.length);
});

test('fixed-income ranking rejects duplicate current facts and matching products in cached snapshots', () => {
  const government = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const ppfId = 'government:india-post:ppf';
  const ppfFact = government.facts.find(fact => fact.canonicalProductId === ppfId);
  const duplicateGovernmentFact = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'ppf',
    snapshot: { ...government, facts: [...government.facts, { ...ppfFact, value: 99 }] },
    profile: canonicalProfile(),
    now: NOW,
  });
  assert.equal(duplicateGovernmentFact.ranking.status, 'UNAVAILABLE');
  assert.equal(duplicateGovernmentFact.products.length, 0);

  const duplicateGovernmentProduct = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'ppf',
    snapshot: {
      ...government,
      products: [...government.products, { ...government.products.find(product => product.canonicalProductId === ppfId) }],
    },
    profile: canonicalProfile(),
    now: NOW,
  });
  assert.equal(duplicateGovernmentProduct.ranking.status, 'UNAVAILABLE');
  assert.equal(duplicateGovernmentProduct.products.length, 0);

  const sbi = parseSbiRetailTermDepositPage(sbiPage(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const profile = canonicalProfile({ age: 35, investmentHorizonYears: 2 });
  const twoYearProduct = sbi.products.find(product => product.canonicalProductId.includes(':2y-lt3y:public'));
  const twoYearFact = sbi.facts.find(fact => fact.canonicalProductId === twoYearProduct.canonicalProductId);
  const duplicateSbiFact = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'fd',
    snapshot: { ...sbi, facts: [...sbi.facts, { ...twoYearFact, value: 99 }] },
    profile,
    now: NOW,
  });
  assert.equal(duplicateSbiFact.ranking.status, 'UNAVAILABLE');
  assert.equal(duplicateSbiFact.products.length, 0);

  const duplicateSbiProduct = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'fd',
    snapshot: { ...sbi, products: [...sbi.products, { ...twoYearProduct }] },
    profile,
    now: NOW,
  });
  assert.equal(duplicateSbiProduct.ranking.status, 'UNAVAILABLE');
  assert.equal(duplicateSbiProduct.products.length, 0);
  assert.match(GOVERNMENT_SAVINGS_CACHE_KEY, /qualified-identities-2$/);
  assert.match(SBI_TERM_DEPOSIT_CACHE_KEY, /qualified-identities-2$/);
  assert.match(RBI_FRSB_CACHE_KEY, /qualified-identities-2$/);
});

test('stale or missing government source facts never become recommendations', () => {
  const stale = parseIndiaPostSavingsBundle(governmentBundle('01.04.2026', '30.06.2026'), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  assert.equal(stale.facts[0].freshness.status, 'STALE');
  const result = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'ppf', snapshot: stale, profile: canonicalProfile(), now: NOW,
  });
  assert.equal(result.products.length, 0);
  assert.deepEqual(result.ranking.reasonCodes, ['CURRENT_EFFECTIVE_SCHEME_RATE_UNAVAILABLE']);
  assert.throws(
    () => parseIndiaPostSavingsBundle(governmentBundle(undefined, undefined, ROWS.slice(0, -1)), {
      fetchedAt: NOW.toISOString(), now: NOW,
    }),
    /incomplete_rate_table/,
  );
  assert.throws(() => parseIndiaPostSavingsBundle('not the official schema', { now: NOW }), /effective_interval/);
});

test('fixed-income comparison rejects provider, source, instrument, kind, unit, and product contract mismatches', () => {
  const snapshot = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const ppfId = 'government:india-post:ppf';
  const mutatePpfFact = mutate => ({
    ...snapshot,
    facts: snapshot.facts.map(fact => fact.canonicalProductId === ppfId ? mutate(fact) : fact),
  });
  const invalidSnapshots = [
    { ...snapshot, provider: PROVIDERS.RBI },
    mutatePpfFact(fact => ({ ...fact, source: { ...fact.source, provider: PROVIDERS.RBI } })),
    mutatePpfFact(fact => ({ ...fact, source: { ...fact.source, instrumentId: 'nsc' } })),
    mutatePpfFact(fact => ({ ...fact, source: { ...fact.source, url: 'https://example.com/rate' } })),
    mutatePpfFact(fact => ({ ...fact, kind: 'TERM_DEPOSIT_RATE' })),
    mutatePpfFact(fact => ({ ...fact, unit: 'PERCENT_PER_MONTH' })),
    mutatePpfFact(fact => ({ ...fact, value: true })),
    mutatePpfFact(fact => ({ ...fact, value: '7.1' })),
    mutatePpfFact(fact => ({ ...fact, effectiveFrom: '2026-00-00', effectiveTo: '2026-99-99' })),
    {
      ...snapshot,
      products: snapshot.products.map(product => product.canonicalProductId === ppfId
        ? { ...product, source: { provider: PROVIDERS.RBI, url: 'https://example.com/rate' } }
        : product),
    },
  ];
  for (const invalid of invalidSnapshots) {
    const result = compareVerifiedFixedIncomeProducts({
      parentInstrumentId: 'ppf', snapshot: invalid, profile: canonicalProfile(), now: NOW,
    });
    assert.equal(result.products.length, 0);
    assert.equal(result.ranking.status, 'UNAVAILABLE');
  }
});

test('comparison rejects a cached fact after its Indian effective interval ends even if its stored freshness says FRESH', () => {
  const parsedAtQuarterStart = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const expired = {
    ...parsedAtQuarterStart,
    facts: parsedAtQuarterStart.facts.map(fact => ({
      ...fact,
      freshness: { ...fact.freshness, status: 'FRESH' },
    })),
  };
  const afterQuarter = new Date('2026-10-01T00:00:00.000+05:30');
  const result = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'ppf', snapshot: expired, profile: canonicalProfile(), now: afterQuarter,
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.ranking.status, 'UNAVAILABLE');
});

test('India Post effective dates and observation timestamps must be valid calendar values', () => {
  assert.throws(
    () => parseIndiaPostSavingsBundle(governmentBundle('31.02.2026', '30.09.2026'), {
      fetchedAt: NOW.toISOString(), now: NOW,
    }),
    /effective_interval/,
  );
  assert.throws(
    () => parseIndiaPostSavingsBundle(governmentBundle(), {
      fetchedAt: 'not-a-timestamp', now: NOW,
    }),
    /timestamps/,
  );
  assert.throws(
    () => parseIndiaPostSavingsBundle(governmentBundle(), {
      fetchedAt: NOW.toISOString(), now: new Date(Number.NaN),
    }),
    /timestamps/,
  );
  assert.throws(
    () => parseIndiaPostSavingsBundle(governmentBundle(), {
      fetchedAt: '2026-09-08T12:00:00.001Z', now: NOW,
    }),
    /timestamps/,
  );
});

test('SBI parser uses only revised official columns and preserves depositor and tenure classes', () => {
  const snapshot = parseSbiRetailTermDepositPage(sbiPage(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.productCount, 16);
  assert.equal(snapshot.publicationDate, '2026-06-16');
  const publicTwoYear = snapshot.products.find(product => product.canonicalProductId.includes('2y-lt3y:public'));
  const seniorTwoYear = snapshot.products.find(product => product.canonicalProductId.includes('2y-lt3y:senior'));
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId === publicTwoYear.canonicalProductId).value, 6.4);
  assert.equal(snapshot.facts.find(fact => fact.canonicalProductId === seniorTwoYear.canonicalProductId).value, 6.9);
  assert.equal(publicTwoYear.depositorType, 'GENERAL_PUBLIC');
  assert.equal(publicTwoYear.depositType, 'RETAIL_DOMESTIC_TERM_DEPOSIT_BELOW_INR_3_CRORE');
  assert.equal(publicTwoYear.riskQuality, null);
});

test('FD comparison never crosses tenure/depositor classes or pads to five', () => {
  const snapshot = parseSbiRetailTermDepositPage(sbiPage(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const result = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'fd', snapshot, profile: canonicalProfile({ age: 35, investmentHorizonYears: 2 }),
    now: NOW,
  });
  assert.equal(result.products.length, 1);
  assert.equal(result.ranking.status, 'VERIFIED_COMPARABLE_OPTIONS');
  assert.equal(result.ranking.hasUniqueLeader, false);
  assert.equal(result.products[0].depositorType, 'GENERAL_PUBLIC');
  assert.equal(result.products[0].tenure.label, '2 years to less than 3 years');
  assert.equal(result.products[0].officialRate.value, 6.4);
  assert.equal(result.products[0].expectedReturn, null);
  assert.equal(result.products[0].riskQuality, null);
});

test('SBI missing tenure and schema drift fail closed without static rates', () => {
  assert.throws(() => parseSbiRetailTermDepositPage(sbiPage(SBI_TENURES.slice(0, -1)), {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /tenure_rows/);
  assert.throws(() => parseSbiRetailTermDepositPage('<html>changed</html>'), /rate_header/);
});

test('SBI ranking rejects a source tenure identity paired with a different normalized range or label', () => {
  const parsed = parseSbiRetailTermDepositPage(sbiPage(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const baseline = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'fd',
    snapshot: parsed,
    profile: canonicalProfile({ age: 35, investmentHorizonYears: 1 }),
    now: NOW,
  });
  assert.equal(baseline.ranking.status, 'VERIFIED_COMPARABLE_OPTIONS');
  const shortTenureProduct = parsed.products.find(product => product.canonicalProductId.includes(':7d-45d:public'));
  shortTenureProduct.tenureMinDays = 365;
  shortTenureProduct.tenureMaxDaysExclusive = 730;
  shortTenureProduct.tenureLabel = '1 year to less than 2 years';

  const result = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'fd',
    snapshot: parsed,
    profile: canonicalProfile({ age: 35, investmentHorizonYears: 1 }),
    now: NOW,
  });
  assert.equal(result.ranking.status, 'UNAVAILABLE');
  assert.equal(result.products.length, 0);
});

test('SBI parser rejects duplicate tenure identities even when the row count matches', () => {
  const duplicateFiveToTenRows = [
    ...SBI_TENURES.slice(0, 6),
    SBI_TENURES[7],
    ['5 years and up to 10 years', '99.0', '99.0', '99.0', '99.0'],
  ];
  assert.throws(() => parseSbiRetailTermDepositPage(sbiPage(duplicateFiveToTenRows), {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /tenure_rows/);
});

test('SBI parser rejects impossible effective and publication dates', () => {
  const invalidEffectiveDate = sbiPage().replaceAll('15/12/2025', '31/02/2025');
  assert.throws(() => parseSbiRetailTermDepositPage(invalidEffectiveDate, {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /revised_columns/);

  const invalidPublicationDate = sbiPage().replace('16-06-2026', '31-02-2026');
  assert.throws(() => parseSbiRetailTermDepositPage(invalidPublicationDate, {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /last_updated/);
});

test('SBI long-form publication dates are parsed as calendar dates and future-effective rates are not current', () => {
  const longPublicationDate = sbiPage().replace('Tuesday, 16-06-2026', 'Tuesday, June 16, 2026');
  const snapshot = parseSbiRetailTermDepositPage(longPublicationDate, {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  assert.equal(snapshot.publicationDate, '2026-06-16');

  const impossibleLongDate = longPublicationDate.replace('June 16, 2026', 'February 31, 2026');
  assert.throws(() => parseSbiRetailTermDepositPage(impossibleLongDate, {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /last_updated/);

  const futureRate = sbiPage().replaceAll('15/12/2025', '15/12/2099');
  assert.throws(() => parseSbiRetailTermDepositPage(futureRate, {
    fetchedAt: NOW.toISOString(), now: NOW,
  }), /future_effective_rates/);
});

test('WTI runs the hard suitability gate before official fixed-income provider access', async () => {
  let calls = 0;
  const rejected = await rankWhereToInvestBackend(
    canonicalProfile({ investmentHorizonYears: 1 }),
    { parentInstrumentId: 'ppf' },
    { fetchGovernmentSavingsSnapshot: async () => { calls += 1; return null; } },
  );
  assert.equal(rejected.length, 0);
  assert.equal(rejected.metadata.excluded[0].reasonCode, 'HORIZON_BELOW_MINIMUM');
  assert.equal(calls, 0);

  const snapshot = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const accepted = await rankWhereToInvestBackend(
    canonicalProfile({ investmentHorizonYears: 15 }),
    { parentInstrumentId: 'ppf' },
    { now: NOW, fetchGovernmentSavingsSnapshot: async () => { calls += 1; return snapshot; } },
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].officialRate.value, 7.1);
  assert.equal(accepted[0].expectedReturn, null);
  assert.equal(calls, 1);
});

const RBI_RULE_FIXTURE = `
<html>
  <body>
    <h1>Floating Rate Savings Bonds, 2020 (Taxable) - FRSB 2020 (T) - Operational Guidelines</h1>
    <p>8.3 The interest on the bonds shall be paid semi-annually from the date of issue of bonds, up to 30th June / 31st December as the case may be, and thereafter half-yearly for period ending 30th June and 31st December on 1st July and 1st January respectively.</p>
    <p>8.4 The interest rate is linked/pegged with prevailing National Saving Certificate (NSC) rate with a spread of (+) 35 bps over the respective NSC rate.</p>
    <p>8.5 The interest rate will be reset every six months, the first reset being on January 01, 2021...</p>
    <p>9.1 The bonds shall be repayable on expiry of seven years from the date of subscription.</p>
  </body>
</html>
`;

test('TEST 1, 2, 3: RBI provider constructs one canonical FRSB product, NSC 7.7 + 35 bps produces 8.05 fixture, and uses PERCENT_PER_ANNUM', () => {
  const nscSnapshot = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const snapshot = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot,
    fetchedAt: NOW.toISOString(),
    now: NOW,
  });
  assert.equal(snapshot.status, 'AVAILABLE');
  assert.equal(snapshot.provider, PROVIDERS.RBI);
  assert.equal(snapshot.productCount, 1);
  assert.equal(snapshot.products.length, 1);

  // TEST 1: RBI provider constructs one canonical FRSB product
  const product = snapshot.products[0];
  assert.equal(product.canonicalProductId, 'government:rbi:frsb-2020-taxable');
  assert.equal(product.name, 'Floating Rate Savings Bonds, 2020 (Taxable)');
  assert.equal(product.providerName, 'Government of India / Reserve Bank of India');
  assert.equal(product.productType, 'GOVERNMENT_BOND');
  assert.equal(product.tenureMonths, 84);

  // TEST 2: NSC 7.7 + 35 bps produces 8.05 in a fixture
  const fact = snapshot.facts[0];
  assert.equal(fact.value, 8.05);
  assert.equal(fact.referenceRateValue, 7.7);
  assert.equal(fact.spreadBps, 35);
  assert.equal(fact.rateBasis, 'NSC_REFERENCE_RATE_PLUS_35_BPS');
  assert.equal(fact.referenceRateFact.canonicalProductId, 'government:india-post:nsc');
  assert.equal(fact.referenceRateFact.source.url, 'https://www.indiapost.gov.in/banking-services/savings');
  assert.equal(fact.referenceRateFact.value, fact.referenceRateValue);
  assert.equal(fact.referenceRateFact.effectiveFrom, '2026-07-01');
  assert.equal(fact.referenceRateFact.effectiveTo, '2026-09-30');

  // TEST 3: FRSB uses PERCENT_PER_ANNUM
  assert.equal(fact.unit, 'PERCENT_PER_ANNUM');
  assert.equal(fact.dataClass, 'OFFICIAL_RBI_FLOATING_COUPON_RATE');
});

test('TEST 4, 5, 6: FRSB effective period is six months, July reset produces July 1 -> Dec 31, Jan reset produces Jan 1 -> Jun 30', () => {
  // TEST 5: July reset produces July 1 → December 31
  const julyReset = calculateFrsbResetPeriod(new Date('2026-07-15T10:00:00.000Z'));
  assert.equal(julyReset.resetDate, '2026-07-01');
  assert.equal(julyReset.effectiveFrom, '2026-07-01');
  assert.equal(julyReset.effectiveTo, '2026-12-31');

  // TEST 6: January reset produces January 1 → June 30
  const janReset = calculateFrsbResetPeriod(new Date('2026-02-10T10:00:00.000Z'));
  assert.equal(janReset.resetDate, '2026-01-01');
  assert.equal(janReset.effectiveFrom, '2026-01-01');
  assert.equal(janReset.effectiveTo, '2026-06-30');

  // TEST 4: FRSB effective period is six months
  const julyDurationDays = (new Date(julyReset.effectiveTo) - new Date(julyReset.effectiveFrom)) / (1000 * 60 * 60 * 24) + 1;
  assert.equal(julyDurationDays, 184);
  const janDurationDays = (new Date(janReset.effectiveTo) - new Date(janReset.effectiveFrom)) / (1000 * 60 * 60 * 24) + 1;
  assert.equal(janDurationDays, 181);
});

test('government-rate cache keys roll at India quarter and FRSB reset boundaries', () => {
  assert.notEqual(
    governmentSavingsCacheKeyAt(new Date('2026-09-30T18:29:59.999Z')),
    governmentSavingsCacheKeyAt(new Date('2026-09-30T18:30:00.000Z')),
  );
  assert.notEqual(
    rbiFrsbCacheKeyAt(new Date('2026-06-30T18:29:59.999Z')),
    rbiFrsbCacheKeyAt(new Date('2026-06-30T18:30:00.000Z')),
  );
  assert.equal(
    governmentSavingsCacheKeyAt(new Date('2026-09-30T18:29:59.999Z')),
    governmentSavingsCacheKeyAt(new Date('2026-09-30T00:00:00.000Z')),
  );
});

test('TEST 7 — CRITICAL: An October NSC change does NOT mutate an already-established July–December FRSB coupon', () => {
  const julyNsc = parseIndiaPostSavingsBundle(governmentBundle('01.07.2026', '30.09.2026'), {
    fetchedAt: '2026-07-02T00:00:00.000Z', now: new Date('2026-07-02T00:00:00.000Z'),
  });
  const octRows = ROWS.map(r => r.instrument.includes('National Savings Certificate') ? { ...r, interestRate: '8.0%' } : r);
  const octoberNsc = parseIndiaPostSavingsBundle(governmentBundle('01.10.2026', '31.12.2026', octRows), {
    fetchedAt: '2026-10-02T00:00:00.000Z', now: new Date('2026-10-02T00:00:00.000Z'),
  });

  const allNscFacts = [...julyNsc.facts, ...octoberNsc.facts];
  const octDate = new Date('2026-10-15T12:00:00.000Z');

  const snapshotInOctober = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot: { ...julyNsc, facts: allNscFacts },
    fetchedAt: octDate.toISOString(),
    now: octDate,
  });

  assert.equal(snapshotInOctober.status, 'AVAILABLE');
  assert.equal(snapshotInOctober.effectiveFrom, '2026-07-01');
  assert.equal(snapshotInOctober.effectiveTo, '2026-12-31');
  assert.equal(snapshotInOctober.resetDate, '2026-07-01');
  assert.equal(snapshotInOctober.facts[0].value, 8.05);
  assert.equal(snapshotInOctober.facts[0].referenceRateValue, 7.7);
});

test('TEST 8: Missing reset-date NSC evidence returns unavailable', () => {
  const octRows = ROWS.map(r => r.instrument.includes('National Savings Certificate') ? { ...r, interestRate: '8.0%' } : r);
  const octoberNsc = parseIndiaPostSavingsBundle(governmentBundle('01.10.2026', '31.12.2026', octRows), {
    fetchedAt: '2026-10-02T00:00:00.000Z', now: new Date('2026-10-02T00:00:00.000Z'),
  });
  const octDate = new Date('2026-10-15T12:00:00.000Z');

  const snapshot = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot: octoberNsc,
    fetchedAt: octDate.toISOString(),
    now: octDate,
  });

  assert.equal(snapshot.status, 'UNAVAILABLE');
  assert.equal(snapshot.productCount, 0);
  assert.equal(snapshot.facts.length, 0);
  assert.equal(snapshot.error.code, 'FRSB_REFERENCE_NSC_RESET_RATE_UNAVAILABLE');
});

test('TEST 9: Malformed RBI source/rule fails closed', () => {
  assert.throws(() => parseRbiOperationalGuidelines(''), /RBI_EMPTY_RESPONSE/);
  assert.throws(() => parseRbiOperationalGuidelines('<html>broken content</html>'), /RBI_SCHEMA_MISMATCH/);
  assert.throws(
    () => parseRbiOperationalGuidelines('<html>Floating Rate Savings Bonds, 2020 (Taxable) no nsc link</html>'),
    /RBI_SCHEMA_MISMATCH:nsc_linkage/,
  );
  assert.throws(
    () => parseRbiOperationalGuidelines('<html>Floating Rate Savings Bonds, 2020 (Taxable) National Savings Certificate (NSC) spread of 50 bps reset every six months tenure of 7 years</html>'),
    /RBI_SCHEMA_MISMATCH:unexpected_spread/,
  );
});

test('RBI FRSB refuses stale or unqualified NSC facts and contradictory spread rules', () => {
  const qualifiedNsc = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const nscFact = qualifiedNsc.facts.find(fact => fact.canonicalProductId === 'government:india-post:nsc');
  const duplicateNscSnapshot = {
    ...qualifiedNsc,
    facts: [...qualifiedNsc.facts, { ...nscFact, value: 99 }],
  };
  const duplicateNscResult = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot: duplicateNscSnapshot,
    fetchedAt: NOW.toISOString(),
    now: NOW,
  });
  assert.equal(duplicateNscResult.status, 'UNAVAILABLE');
  assert.equal(duplicateNscResult.facts.length, 0);

  const malformedFacts = [
    { ...nscFact, schemaVersion: 'wrong-schema' },
    { ...nscFact, source: { ...nscFact.source, provider: 'ATTACKER' } },
    { ...nscFact, source: { ...nscFact.source, url: 'https://example.invalid/fake' } },
    { ...nscFact, freshness: { ...nscFact.freshness, status: 'STALE' } },
    { ...nscFact, value: true },
    { ...nscFact, value: '7.7' },
    { ...nscFact, effectiveFrom: '2026-00-00', effectiveTo: '2026-99-99' },
  ];
  for (const malformedFact of malformedFacts) {
    const malformedSnapshot = {
      ...qualifiedNsc,
      facts: qualifiedNsc.facts.map(fact => fact === nscFact ? malformedFact : fact),
    };
    const unavailable = deriveRbiFloatingRateSavingsBondSnapshot({
      rbiHtml: RBI_RULE_FIXTURE,
      nscSnapshot: malformedSnapshot,
      fetchedAt: NOW.toISOString(),
      now: NOW,
    });
    assert.equal(unavailable.status, 'UNAVAILABLE');
    assert.equal(unavailable.facts.length, 0);
  }

  const rule = parseRbiOperationalGuidelines(RBI_RULE_FIXTURE);
  assert.throws(() => deriveRbiFloatingRateSavingsBondSnapshot({
    rbiRule: { ...rule, spreadPercent: 5 },
    nscSnapshot: qualifiedNsc,
    fetchedAt: NOW.toISOString(),
    now: NOW,
  }), /unqualified_rule/);

  const validSnapshot = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiRule: rule,
    nscSnapshot: qualifiedNsc,
    fetchedAt: NOW.toISOString(),
    now: NOW,
  });
  const coercedBooleanReference = structuredClone(validSnapshot);
  coercedBooleanReference.facts[0].referenceRateValue = true;
  coercedBooleanReference.facts[0].value = 1.35;
  const booleanRejected = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'rbi_bonds',
    snapshot: coercedBooleanReference,
    profile: canonicalProfile({ investmentHorizonYears: 10 }),
    now: NOW,
  });
  assert.equal(booleanRejected.ranking.status, 'UNAVAILABLE');

  for (const mutateReference of [
    reference => ({ ...reference, observedAt: '2026-04-01T00:00:00.000Z' }),
    reference => ({ ...reference, fetchedAt: '2026-06-30T23:59:59.999Z' }),
    reference => ({ ...reference, fetchedAt: '2099-09-08T12:00:00.000Z' }),
    reference => ({
      ...reference,
      freshness: { ...reference.freshness, ageSeconds: 0 },
    }),
    reference => ({
      ...reference,
      freshness: { ...reference.freshness, maxAgeSeconds: reference.freshness.maxAgeSeconds + 1 },
    }),
  ]) {
    const inconsistentTimestamps = structuredClone(deriveRbiFloatingRateSavingsBondSnapshot({
      rbiRule: rule,
      nscSnapshot: qualifiedNsc,
      fetchedAt: NOW.toISOString(),
      now: NOW,
    }));
    inconsistentTimestamps.facts[0].referenceRateFact = mutateReference(
      inconsistentTimestamps.facts[0].referenceRateFact,
    );
    const timestampRejected = compareVerifiedFixedIncomeProducts({
      parentInstrumentId: 'rbi_bonds',
      snapshot: inconsistentTimestamps,
      profile: canonicalProfile({ investmentHorizonYears: 10 }),
      now: NOW,
    });
    assert.equal(timestampRejected.ranking.status, 'UNAVAILABLE');
  }

  validSnapshot.facts[0].value += 1;
  const rejected = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'rbi_bonds',
    snapshot: validSnapshot,
    profile: canonicalProfile({ investmentHorizonYears: 10 }),
    now: NOW,
  });
  assert.equal(rejected.ranking.status, 'UNAVAILABLE');
});

test('FRSB ranking keeps verified reset-date NSC evidence usable after its quarter ends', () => {
  const julyNow = new Date('2026-07-02T00:00:00.000Z');
  const octoberNow = new Date('2026-10-15T12:00:00.000Z');
  const julyNsc = parseIndiaPostSavingsBundle(
    governmentBundle('01.07.2026', '30.09.2026'),
    { fetchedAt: julyNow.toISOString(), now: julyNow },
  );
  const octoberFrsb = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot: julyNsc,
    fetchedAt: octoberNow.toISOString(),
    now: octoberNow,
  });

  const validPriorQuarter = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'rbi_bonds',
    snapshot: octoberFrsb,
    profile: canonicalProfile({ investmentHorizonYears: 10 }),
    now: octoberNow,
  });
  assert.equal(validPriorQuarter.ranking.status, 'VERIFIED_COMPARABLE_OPTIONS');
  assert.equal(validPriorQuarter.products[0].officialRate.resetDate, '2026-07-01');
  assert.equal(validPriorQuarter.products[0].officialRate.referenceRateFact.effectiveTo, '2026-09-30');

  for (const mutateReference of [
    reference => ({ ...reference, fetchedAt: '2026-10-01T00:00:00.000Z' }),
    reference => ({
      ...reference,
      freshness: { ...reference.freshness, status: 'STALE' },
    }),
  ]) {
    const invalidPriorQuarter = structuredClone(octoberFrsb);
    invalidPriorQuarter.facts[0].referenceRateFact = mutateReference(
      invalidPriorQuarter.facts[0].referenceRateFact,
    );
    const unavailable = compareVerifiedFixedIncomeProducts({
      parentInstrumentId: 'rbi_bonds',
      snapshot: invalidPriorQuarter,
      profile: canonicalProfile({ investmentHorizonYears: 10 }),
      now: octoberNow,
    });
    assert.equal(unavailable.ranking.status, 'UNAVAILABLE');
  }
});

test('TEST 10: No static coupon fallback', () => {
  const missingSnapshot = {
    schemaVersion: 'market-fact-1.0.0',
    provider: 'RBI',
    status: 'UNAVAILABLE',
    products: [],
    facts: [],
    error: { code: 'FRSB_REFERENCE_NSC_RESET_RATE_UNAVAILABLE' },
  };
  const result = compareVerifiedFixedIncomeProducts({
    parentInstrumentId: 'rbi_bonds',
    snapshot: missingSnapshot,
    profile: canonicalProfile({ investmentHorizonYears: 10 }),
    now: NOW,
  });
  assert.equal(result.products.length, 0);
  assert.equal(result.ranking.status, 'UNAVAILABLE');
  assert.deepEqual(result.ranking.reasonCodes, ['FRSB_REFERENCE_NSC_RESET_RATE_UNAVAILABLE']);
});

test('TEST 11, 12, 13, 14, 16, 17: WTI for rbi_bonds returns exactly one verified product with officialRate and no expectedReturn or bank wrappers', async () => {
  const nscSnapshot = parseIndiaPostSavingsBundle(governmentBundle(), {
    fetchedAt: NOW.toISOString(), now: NOW,
  });
  const rbiSnapshot = deriveRbiFloatingRateSavingsBondSnapshot({
    rbiHtml: RBI_RULE_FIXTURE,
    nscSnapshot,
    fetchedAt: NOW.toISOString(),
    now: NOW,
  });

  const result = await rankWhereToInvestBackend(
    canonicalProfile({ investmentHorizonYears: 10 }),
    { parentInstrumentId: 'rbi_bonds' },
    { fetchRbiFloatingRateSavingsBondSnapshot: async () => rbiSnapshot },
  );

  assert.equal(result.length, 1);
  assert.equal(result.metadata.ranking.status, 'VERIFIED_COMPARABLE_OPTIONS');
  assert.deepEqual(result.metadata.ranking.reasonCodes, [
    'OFFICIAL_SOURCE_FACT_VERIFIED',
    'SINGLE_CANONICAL_PRODUCT',
    'MERIT_RANKING_NOT_CLAIMED',
  ]);

  const p = result[0];
  assert.equal(p.canonicalProductId, 'government:rbi:frsb-2020-taxable');
  assert.equal(p.presentationStatus, 'VERIFIED_COMPARABLE_OPTION');

  assert.equal(p.expectedReturn, null);
  assert.equal(p.nominalReturn, null);

  assert.equal(p.officialRate.value, 8.05);
  assert.equal(p.officialRate.unit, 'PERCENT_PER_ANNUM');
  assert.equal(p.officialRate.basis, 'NSC_REFERENCE_RATE_PLUS_35_BPS');
  assert.equal(p.officialRate.dataClass, 'OFFICIAL_RBI_FLOATING_COUPON_RATE');
  assert.equal(p.officialRate.referenceRateValue, 7.7);
  assert.equal(p.officialRate.spreadBps, 35);
  assert.equal(p.officialRate.resetDate, '2026-07-01');
  assert.equal(p.officialRate.referenceRateFact.canonicalProductId, 'government:india-post:nsc');

  assert.equal(p.source.provider, 'RBI');
  assert.equal(p.source.url, RBI_FRSB_NOTIFICATION_URL);

  assert.equal(result.filter(item => item.id.includes('sbi') || item.id.includes('hdfc') || item.id.includes('icici')).length, 0);
  assert.equal(p.name, 'Floating Rate Savings Bonds, 2020 (Taxable)');
  assert.equal(p.provider, 'Government of India / Reserve Bank of India');
});

test('TEST 15: parent suitability rejection occurs before RBI provider fetch', async () => {
  let fetchCalls = 0;
  const rejected = await rankWhereToInvestBackend(
    canonicalProfile({ investmentHorizonYears: 2 }),
    { parentInstrumentId: 'rbi_bonds' },
    { fetchRbiFloatingRateSavingsBondSnapshot: async () => { fetchCalls++; return null; } },
  );

  assert.equal(rejected.length, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(rejected.metadata.excluded.length, 1);
  assert.equal(rejected.metadata.excluded[0].id, 'rbi_bonds');
  assert.equal(rejected.metadata.excluded[0].reasonCode, 'HORIZON_BELOW_MINIMUM');
});

test('KVP maturity is parsed from source annotation, never inferred from rate alone', () => {
  const rows = ROWS.map(row => row.instrument === 'Kisan Vikas Patra'
    ? { ...row, interestRate: '7.5% (will mature in 115 months)' } : row);
  const now = new Date('2026-10-21T10:00:00.000Z');
  const annotated = parseIndiaPostSavingsBundle(governmentBundle('01.10.2026','31.12.2026',rows),
    { now, fetchedAt: now.toISOString() });
  const product = annotated.products.find(p => p.canonicalProductId === 'government:india-post:kvp');
  assert.equal(product.tenureMonths, 115);
  assert.equal(product.maturityEvidence, 'INDIA_POST_RATE_ANNOTATION');
  const plain = parseIndiaPostSavingsBundle(governmentBundle('01.10.2026','31.12.2026'),
    { now, fetchedAt: now.toISOString() });
  const unqualified = plain.products.find(p => p.canonicalProductId === 'government:india-post:kvp');
  assert.equal(unqualified.tenureMonths, null);
  assert.equal(unqualified.maturityEvidence, null);
});
