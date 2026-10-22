/**
 * Restricted, fail-closed ordinary-income calculator for Indian individuals.
 * TY 2026-27 only. This is NOT a complete income-tax return computation.
 * Amounts are decimal strings; no JS floating-point amount arithmetic.
 * Source of truth: Income-tax Act, 2025 §§19, 156, 202, 516.
 */
const POLICY = Object.freeze({
  taxYear: '2026-27',
  policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
  sources: Object.freeze([
    'https://wmstatic-prd.incometaxindia.gov.in/web/guest/w/section-202-78',
    'https://wmstatic-prd.incometaxindia.gov.in/web/guest/w/section-19-199',
    'https://www.incometaxindia.gov.in/w/tax-rates-and-computation',
    'https://www.incometaxindia.gov.in/w/how-to-round-off-the-tax-liability-',
  ]),
});
const U = 10000n; // One rupee in 1/10,000-rupee accounting units.
const PAISA = 100n;
const LIMIT = 1_000_000_000n;
const SLABS = Object.freeze([
  [0n, 400000n, 0n],
  [400000n, 800000n, 5n],
  [800000n, 1200000n, 10n],
  [1200000n, 1600000n, 15n],
  [1600000n, 2000000n, 20n],
  [2000000n, 2400000n, 25n],
  [2400000n, null, 30n],
]);

function min(a, b) { return a < b ? a : b; }
function max(a, b) { return a > b ? a : b; }

function paise(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) {
    throw Object.assign(new TypeError(label + ' must be a non-negative decimal rupee string with at most two decimal places'), { code: 'INVALID_MONEY' });
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * PAISA + BigInt(fraction.padEnd(2, '0') || '0');
  if (amount > LIMIT * PAISA) {
    throw Object.assign(new RangeError(label + ' exceeds the supported maximum'), { code: 'INVALID_MONEY' });
  }
  return amount;
}

function roundTenAfterTruncatingPaise(amountInPaise) {
  const rupeesIgnoringPaise = amountInPaise / PAISA;
  return ((rupeesIgnoringPaise + 5n) / 10n) * 10n;
}

function roundTenFromUnits(amountInUnits) {
  const rupeesIgnoringPaise = amountInUnits / U;
  return ((rupeesIgnoringPaise + 5n) / 10n) * 10n;
}
function exact(units) {
  return (units / U).toString() + '.' + (units % U).toString().padStart(4, '0');
}
function slabTax(rupees) {
  return SLABS.reduce((sum, [floor, ceiling, percent]) => {
    if (rupees <= floor) return sum;
    const inSlab = (ceiling === null ? rupees : min(rupees, ceiling)) - floor;
    return sum + (inSlab * U * percent) / 100n;
  }, 0n);
}

function surchargeRate(rupees) {
  if (rupees <= 5000000n) return 0n;
  if (rupees <= 10000000n) return 10n;
  if (rupees <= 20000000n) return 15n;
  return 25n; // Section 202 new-regime surcharge cap.
}
function surchargeMarginalRelief(rupees, taxAfterRebate, surcharge) {
  if (rupees <= 5000000n) return 0n;
  const threshold = rupees > 20000000n ? 20000000n
    : rupees > 10000000n ? 10000000n : 5000000n;
  const thresholdRate = surchargeRate(threshold);
  const liabilityAtThreshold = slabTax(threshold) * (100n + thresholdRate) / 100n;
  const permitted = liabilityAtThreshold + (rupees - threshold) * U;
  return max(0n, taxAfterRebate + surcharge - permitted);
}

function base() {
  return { taxYear: POLICY.taxYear, policyVersion: POLICY.policyVersion, sourceReferences: POLICY.sources };
}

export function calculateVerifiedNewRegime(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new TypeError('Expected a tax request object'), { code: 'INVALID_TAX_REQUEST' });
  }
  const keys = ['taxYear', 'incomeType', 'primaryIncome', 'otherOrdinaryIncome', 'residency', 'specialRateIncome', 'confirmedOrdinaryOnly'];
  if (Object.keys(input).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(input, key))) {
    throw Object.assign(new TypeError('Tax request fields are missing or unsupported'), { code: 'INVALID_TAX_REQUEST' });
  }
  if (input.taxYear !== POLICY.taxYear) {
    throw Object.assign(new RangeError('Unsupported tax year; no tax calculated'), { code: 'UNSUPPORTED_TAX_YEAR' });
  }
  if (!['salary', 'pension', 'already_taxable'].includes(input.incomeType)
      || !['resident', 'non_resident', 'unknown'].includes(input.residency)
      || !['no', 'yes', 'unknown'].includes(input.specialRateIncome)
      || typeof input.confirmedOrdinaryOnly !== 'boolean') {
    throw Object.assign(new TypeError('Unsupported tax context'), { code: 'INVALID_TAX_REQUEST' });
  }
  const primary = paise(input.primaryIncome, 'primaryIncome');
  const additional = paise(input.otherOrdinaryIncome, 'otherOrdinaryIncome');
  if (primary + additional > LIMIT * PAISA) {
    throw Object.assign(new RangeError('Combined income exceeds the supported maximum'), { code: 'INVALID_MONEY' });
  }
  const echoedInputs = { ...input };
  if (input.residency === 'unknown' || input.specialRateIncome !== 'no' || !input.confirmedOrdinaryOnly) {
    const reasons = [
      ...(input.residency === 'unknown' ? ['RESIDENCY_UNKNOWN'] : []),
      ...(input.specialRateIncome !== 'no' ? ['SPECIAL_RATE_INCOME_REQUIRES_FULL_RETURN'] : []),
      ...(!input.confirmedOrdinaryOnly ? ['ADJUSTMENTS_NOT_CONFIRMED'] : []),
    ];
    return { ...base(), status: 'UNAVAILABLE', unavailableReasons: reasons, inputsUsed: echoedInputs, finalTax: null };
  }
  const standardDeduction = input.incomeType === 'salary' || input.incomeType === 'pension'
    ? min(primary, 75000n * PAISA) : 0n;
  const unroundedTaxablePaise = max(0n, primary + additional - standardDeduction);
  const taxableRu = roundTenAfterTruncatingPaise(unroundedTaxablePaise);
  const rawSlabTax = slabTax(taxableRu);
  let rebate = 0n;
  if (input.residency === 'resident') {
    if (taxableRu <= 1200000n) {
      rebate = min(rawSlabTax, 60000n * U);
    } else {
      const incomeAboveRebateLimit = (taxableRu - 1200000n) * U;
      rebate = max(0n, rawSlabTax - incomeAboveRebateLimit);
    }
  }
  const afterRebate = rawSlabTax - rebate;
  const surcharge = afterRebate * surchargeRate(taxableRu) / 100n;
  const surchargeRelief = surchargeMarginalRelief(taxableRu, afterRebate, surcharge);
  const beforeCess = afterRebate + surcharge - surchargeRelief;
  const cess = beforeCess * 4n / 100n;
  const beforeRounding = beforeCess + cess;
  const finalTax = roundTenFromUnits(beforeRounding);

  const slabBreakdown = SLABS.flatMap(([floor, ceiling, percent]) => {
    const taxableInSlab = taxableRu <= floor ? 0n
      : (ceiling === null ? taxableRu : min(taxableRu, ceiling)) - floor;
    if (taxableInSlab === 0n) return [];
    return [{
      from: floor.toString(), to: ceiling?.toString() ?? null, percent: Number(percent),
      taxableInSlab: taxableInSlab.toString(),
      tax: exact(taxableInSlab * U * percent / 100n),
    }];
  });

  return {
    ...base(),
    status: 'CALCULATED',
    inputsUsed: echoedInputs,
    unavailableReasons: [],
    calculationClass: 'SIMPLE_ORDINARY_INCOME_ONLY',
    grossPrimaryIncome: exact(primary * U / PAISA),
    otherOrdinaryIncome: exact(additional * U / PAISA),
    standardDeduction: exact(standardDeduction * U / PAISA),
    taxableIncomeBeforeRounding: exact(unroundedTaxablePaise * U / PAISA),
    taxableIncome: taxableRu.toString(),
    taxBeforeRebate: exact(rawSlabTax),
    rebate: exact(rebate),
    taxAfterRebate: exact(afterRebate),
    surcharge: exact(surcharge),
    surchargeMarginalRelief: exact(surchargeRelief),
    cess: exact(cess),
    taxBeforeStatutoryRounding: exact(beforeRounding),
    finalTax: finalTax.toString(),
    slabBreakdown,
  };
}
