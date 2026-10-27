import { investmentDatabase } from '../data/investmentDatabase.js';

const PUBLIC_INSTRUMENT_FIELDS = Object.freeze([
  'id', 'name', 'abbr', 'type', 'category', 'cat', 'subCategory', 'assetClass', 'provider',
  'expectedReturn', 'rate', 'returnRange', 'interestRate', 'interestRateSenior',
  'returns1yr', 'returns3yr', 'returns5yr', 'riskLevel', 'risk', 'riskLabel', 'volatility',
  'liquidityScore', 'lockIn', 'lockInYears', 'taxType', 'taxEfficiencyScore', 'expenseRatio',
  'minMonthlyInvestment', 'maxAnnualInvestment', 'minInvestment', 'idealHorizon', 'goalTags',
  'maturityYears', 'eligibility', 'nav', 'aumCr', 'exitLoad', 'sebiRating', 'trackingError',
  'underlyingIndex', 'exchange', 'issuer', 'sovereignGuarantee', 'tdsApplicable',
  'prematureWithdrawalPenalty', 'color', 'desc',
]);

function plain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject({ flattenMaps: true }) : value;
}

function pick(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(fields
    .filter(field => value[field] !== undefined)
    .map(field => [field, value[field]]));
}

// Old Mongo rows may still contain fictitious category returns or blanket tax
// claims for these discovery entries. A routine seed
// preserves stored financial fields, so the public read boundary must use the
// reviewed catalog record, including when reserializing Redis cache entries.
const reviewedDiscoveryEntries = new Map(
  ['term_mf_combo', 'ulip', 'endowment_plan', 'bluechip_stocks', 'aa_corporate_bond'].map(id => {
    const entry = investmentDatabase.find(item => item.id === id);
    if (!entry || entry.returnDataClass !== 'UNAVAILABLE') {
      throw new Error('DISCOVERY_CATALOG_UNQUALIFIED:' + id);
    }
    return [id, entry];
  }),
);

/** Serialize catalog records through an explicit public allowlist. */
export function serializeInstrument(instrument) {
  const persisted = plain(instrument);
  const record = reviewedDiscoveryEntries.get(persisted?.id) || persisted;
  if (!record || typeof record.id !== 'string' || record.id.length === 0
      || typeof record.name !== 'string' || record.name.length === 0) {
    const error = new Error('Instrument catalog record is missing its public identity.');
    error.status = 503;
    error.code = 'INSTRUMENT_CATALOG_RECORD_INVALID';
    throw error;
  }
  const output = {};
  for (const field of PUBLIC_INSTRUMENT_FIELDS) {
    if (record[field] === undefined) continue;
    if (field === 'returnRange' || field === 'idealHorizon') {
      output[field] = pick(record[field], ['min', 'max']);
    } else if (field === 'eligibility') {
      output[field] = pick(record[field], [
        'minAge', 'maxAge', 'minAnnualIncome', 'minMonthlySavings', 'requiresDemat',
        'hasGirlChild', 'requires_daughter_under_10', 'notes',
      ]);
    } else if (field === 'goalTags' && Array.isArray(record[field])) {
      output[field] = [...record[field]];
    } else {
      output[field] = record[field];
    }
  }
  return output;
}

export function serializeInstrumentPage({ instruments, total, page, pageSize }) {
  return {
    instruments: instruments.map(serializeInstrument),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

/** Treat shared-cache values as untrusted persisted data and reapply the DTO allowlist. */
export function serializeCachedInstrumentPage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Array.isArray(value.instruments)
      || !Number.isSafeInteger(value.total) || value.total < 0
      || !Number.isSafeInteger(value.page) || value.page < 1
      || !Number.isSafeInteger(value.pageSize) || value.pageSize < 1) {
    return null;
  }
  try {
    return serializeInstrumentPage({
      instruments: value.instruments,
      total: value.total,
      page: value.page,
      pageSize: value.pageSize,
    });
  } catch {
    return null;
  }
}
