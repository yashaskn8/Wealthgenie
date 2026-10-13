import { isPresentFiniteNumber } from './financialValues';

export function formatINR(value) {
  if (!isPresentFiniteNumber(value)) return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `₹${Math.round(number).toLocaleString('en-IN')}` : '—';
}

export function assertBackendRecommendationInstrument(instrument) {
  if (!instrument || typeof instrument !== 'object' || Array.isArray(instrument)) {
    throw new TypeError('Backend recommendation instrument must be an object.');
  }
  if (typeof instrument.id !== 'string' || !instrument.id.trim()) {
    throw new TypeError('Backend recommendation instrument id is required.');
  }
  if (typeof instrument.name !== 'string' || !instrument.name.trim()) {
    throw new TypeError(`Backend recommendation name is required for ${instrument.id}.`);
  }
  for (const field of ['type', 'assetClass', 'riskLevel']) {
    if (typeof instrument[field] !== 'string' || !instrument[field].trim()) {
      throw new TypeError(`Backend recommendation ${field} is required for ${instrument.id}.`);
    }
  }
  const numericRanges = [
    ['allocationWeight', 0, 1], ['allocation_pct', 0, 100], ['nominalReturn', -100, 100],
    ['effectiveYield', -100, 100], ['riskScore', 1, 5], ['lockIn', 0, 100],
    ['expenseRatio', 0, 1], ['score', 0, 100],
  ];
  for (const [field, min, max] of numericRanges) {
    const number = instrument[field];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      throw new TypeError(`Backend recommendation ${field} is invalid for ${instrument.id}.`);
    }
  }
  if (Math.abs(instrument.allocation_pct - instrument.allocationWeight * 100) > 0.011) {
    throw new TypeError(`Backend allocation representations disagree for ${instrument.id}.`);
  }
  if (instrument.effectiveYield !== instrument.nominalReturn) {
    throw new TypeError(`Backend effective yield must equal the pre-tax nominal return for ${instrument.id}.`);
  }
  if (instrument.returnBasis !== 'PRE_TAX_NOMINAL' || instrument.postTaxReturn !== null) {
    throw new TypeError(`Backend recommendation return basis is invalid for ${instrument.id}.`);
  }
  if (!Array.isArray(instrument.tags)) {
    throw new TypeError(`Backend recommendation tags are invalid for ${instrument.id}.`);
  }
  if (!instrument.scoreFactors || typeof instrument.scoreFactors !== 'object' || Array.isArray(instrument.scoreFactors)) {
    throw new TypeError(`Backend recommendation score factors are invalid for ${instrument.id}.`);
  }
  return instrument;
}

export function getWhy(recommendation) {
  const reasons = [];
  if (recommendation.returnBasis === 'PRE_TAX_NOMINAL') reasons.push('The return input is a pre-tax nominal model assumption, not a provider forecast.');
  if (isPresentFiniteNumber(recommendation.riskScore)) reasons.push(`Risk tier ${recommendation.riskScore} passed the server suitability ceiling.`);
  if (recommendation.tags?.length) reasons.push(`Supports: ${recommendation.tags.slice(0, 3).join(', ')}.`);
  if (recommendation.scoreFactors?.goalFit >= 80) reasons.push('Strong match for the selected Financial Profile goals.');
  if (recommendation.scoreFactors?.liquidity >= 80) reasons.push('High catalog liquidity score.');
  return reasons.length ? reasons : ['Selected by the authoritative backend recommendation pipeline.'];
}
