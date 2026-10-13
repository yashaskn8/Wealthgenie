import {
  benchmarkByNseIndexName,
  benchmarkByUpstoxInstrumentKey,
} from './marketBenchmarks.js';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeIsin(value) {
  const isin = clean(value).toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? isin : null;
}

export function buildAmfiProductIdentity({ schemeCode, primaryIsin, secondaryIsin }) {
  const normalizedSchemeCode = clean(String(schemeCode ?? ''));
  if (!/^\d+$/.test(normalizedSchemeCode)) {
    throw new TypeError('AMFI scheme code must be numeric.');
  }
  const isins = [...new Set([normalizeIsin(primaryIsin), normalizeIsin(secondaryIsin)].filter(Boolean))];
  return {
    canonicalProductId: `mf:amfi:${normalizedSchemeCode}`,
    externalIds: [
      { source: 'AMFI_SCHEME_CODE', value: normalizedSchemeCode },
      ...isins.map(isin => ({ source: 'ISIN', value: isin })),
    ],
  };
}

export function buildUpstoxInstrumentIdentity(instrumentKey) {
  const normalizedKey = clean(instrumentKey);
  // Keep this aligned with Upstox's documented instrument_key pattern. This
  // validates syntax only; it does not establish that a key maps to a product.
  if (!/^(?:NSE_EQ|NSE_FO|NCD_FO|BSE_EQ|BSE_FO|BCD_FO|MCX_FO|NSE_COM|NSE_INDEX|BSE_INDEX|MCX_INDEX)\|[\w ]{1,200}$/.test(normalizedKey)) {
    throw new TypeError('Upstox instrument key does not match the documented format.');
  }
  return {
    canonicalProductId: benchmarkByUpstoxInstrumentKey(normalizedKey)?.canonicalProductId
      || `market:upstox:${normalizedKey}`,
    externalIds: [{ source: 'UPSTOX_INSTRUMENT_KEY', value: normalizedKey }],
  };
}

export function buildNseIndexIdentity(indexName) {
  const normalizedName = clean(indexName).toUpperCase();
  const benchmark = benchmarkByNseIndexName(normalizedName);
  if (!benchmark) throw new TypeError(`Unsupported NSE index identity: ${normalizedName || 'missing'}`);
  return {
    canonicalProductId: benchmark.canonicalProductId,
    externalIds: [{ source: 'NSE_INDEX_NAME', value: benchmark.nseIndexName }],
  };
}
