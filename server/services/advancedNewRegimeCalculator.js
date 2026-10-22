/**
 * Narrow, source-qualified extensions to the existing TY 2026-27 tax engine.
 *
 * Not an ITR computation. Computes:
 *  - employer NPS deduction (2025 Act s124(1)-(2), capped at 14% of NPS salary),
 *  - disallowed inter-head set-off of net house-property loss (s202(2)(b)(ii)),
 *  - specified NON-ONLINE lottery/game winnings at 30% (s194(1) table 1),
 *  - resident s156 rebate restricted to ordinary-rate tax,
 *  - high-income surcharge ONLY when all income is ordinary-rate.
 *
 * All amounts are exact integer paise / 1e-4 rupee units. All other special
 * income, mixed-income surcharge, capital-loss schedules, and past-year loss
 * eligibility remain unavailable, never silently converted to zero.
 */
import { calculateVerifiedNewRegime } from './verifiedNewRegimeCalculator.js';

const PAISA = 100n;
const U = 10000n;
const MAX_PAISE = 1000000000n * PAISA;
const POLICY_VERSION = 'advanced-new-regime-TY2026-27-v1';
const SOURCES = Object.freeze([
  'https://www.incometaxindia.gov.in/w/section-202-78',
  'https://www.incometaxindia.gov.in/w/section-124-94',
  'https://www.incometaxindia.gov.in/w/section-156-84',
  'https://www.incometaxindia.gov.in/w/section-194-78',
  'https://www.incometaxindia.gov.in/w/section-516-3',
]);
const FIELDS = Object.freeze([
  'taxYear', 'incomeType', 'primaryIncome', 'otherOrdinaryIncome', 'residency',
  'employerNpsContribution', 'npsEligibleSalary', 'lotteryWinnings',
  'housePropertyLoss', 'confirmedNpsIncludedInSalary',
  'confirmedNoOtherTaxAdjustments',
]);
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const invalid = (code, message) => Object.assign(new TypeError(message), { code });

function parsePaise(s, name) {
  if (typeof s !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(s)) {
    throw invalid('INVALID_MONEY', name + ' must be a nonnegative decimal string with at most two paise digits');
  }
  const [whole, fractional = ''] = s.split('.');
  const p = BigInt(whole) * PAISA + BigInt(fractional.padEnd(2, '0') || '0');
  if (p > MAX_PAISE) throw invalid('INVALID_MONEY', name + ' exceeds the maximum supported amount');
  return p;
}
const four = u => (u / U).toString() + '.' + (u % U).toString().padStart(4, '0');
const paiseFour = p => four(p * 100n);
const units = s => BigInt(s.replace('.', ''));
const nearestTen = u => ((u / U + 5n) / 10n) * 10n;
const notesFor = (nps, house, lottery) => [
  ...(nps > 0n ? ['Section 124 employer NPS: the eligible amount is the smaller of employer contribution and 14% of declared NPS salary; the contribution must already be included in taxable gross salary.'] : []),
  ...(house > 0n ? ['Section 202 forbids offsetting a net house-property loss against salary/other income in this new regime. No such offset was applied. Carry-forward eligibility and utilisation have NOT been calculated.'] : []),
  ...(lottery > 0n ? ['Section 194 non-online lottery/game winnings are taxed at a separate 30% rate, without rebate against that special-rate tax. This is NOT for online winnings, cryptocurrency, or capital gains.'] : []),
];

export function calculateAdvancedNewRegime(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== FIELDS.length
      || FIELDS.some(k => !Object.hasOwn(input, k))
      || Object.keys(input).some(k => !FIELDS.includes(k))) {
    throw invalid('INVALID_TAX_REQUEST', 'Exact advanced tax request fields are required; unknown fields are forbidden');
  }
  if (input.taxYear !== '2026-27') {
    throw invalid('UNSUPPORTED_TAX_YEAR', 'Only Tax Year 2026-27 is supported');
  }
  if (!['salary', 'pension', 'already_taxable'].includes(input.incomeType)
      || !['resident', 'non_resident', 'unknown'].includes(input.residency)
      || typeof input.confirmedNpsIncludedInSalary !== 'boolean'
      || typeof input.confirmedNoOtherTaxAdjustments !== 'boolean') {
    throw invalid('INVALID_TAX_REQUEST', 'Unsupported income/residency type or confirmation flags');
  }

  const amounts = Object.fromEntries([
    'primaryIncome', 'otherOrdinaryIncome', 'employerNpsContribution',
    'npsEligibleSalary', 'lotteryWinnings', 'housePropertyLoss',
  ].map(k => [k, parsePaise(input[k], k)]));
  const { primaryIncome: primary, otherOrdinaryIncome: other,
    employerNpsContribution: nps, npsEligibleSalary: eligibleSalary,
    lotteryWinnings: lottery, housePropertyLoss: propertyLoss } = amounts;
  if (primary + other + lottery > MAX_PAISE) {
    throw invalid('INVALID_MONEY', 'Income components exceed the supported combined maximum');
  }
  if (nps > 0n && (input.incomeType !== 'salary' || eligibleSalary === 0n
      || eligibleSalary > primary || !input.confirmedNpsIncludedInSalary)) {
    throw invalid('INVALID_TAX_REQUEST', 'Employer NPS requires salary, correct basic/DA salary basis, and confirmation that the contribution is included in taxable gross salary');
  }
  if (nps === 0n && (eligibleSalary !== 0n || input.confirmedNpsIncludedInSalary)) {
    throw invalid('INVALID_TAX_REQUEST', 'NPS basis/confirmation must be zero/false when employer NPS contribution is zero');
  }
  const outBase = {
    taxYear: input.taxYear, policyVersion: POLICY_VERSION, inputsUsed: { ...input },
    sourceReferences: SOURCES, calculationClass: 'ADVANCED_QUALIFIED_INCOME_ONLY',
  };
  const unavailable = reasons => ({
    ...outBase, status: 'UNAVAILABLE', unavailableReasons: reasons,
    finalTax: null, notes: notesFor(nps, propertyLoss, lottery),
  });
  if (input.residency === 'unknown' || !input.confirmedNoOtherTaxAdjustments) {
    return unavailable([
      ...(input.residency === 'unknown' ? ['RESIDENCY_UNKNOWN'] : []),
      ...(!input.confirmedNoOtherTaxAdjustments ? ['RETURN_CONTEXT_UNCONFIRMED'] : []),
    ]);
  }

  const standard = input.incomeType === 'salary' || input.incomeType === 'pension'
    ? min(primary, 75000n * PAISA) : 0n;
  const npsCap = eligibleSalary * 14n / 100n;
  const allowedNps = min(nps, npsCap);
  const disallowedNps = nps - allowedNps;
  const rawOrdinary = max(0n, primary + other - standard - allowedNps);
  const rawTotal = rawOrdinary + lottery;
  if (rawTotal > MAX_PAISE) throw invalid('INVALID_MONEY', 'Computed total exceeds supported maximum');

  // Mixed special-rate surcharge and statutory component-level rounding need
  // separate, fully qualified legal calculations. Neither can be inferred.
  if (lottery > 0n && rawTotal > 5000000n * PAISA) {
    return unavailable(['MIXED_SPECIAL_RATE_SURCHARGE_NEEDS_FULL_RETURN']);
  }
  if (lottery > 0n && (rawOrdinary % (10n * PAISA) !== 0n
      || lottery % (10n * PAISA) !== 0n)) {
    return unavailable(['MIXED_INCOME_COMPONENT_ROUNDING_NEEDS_FULL_RETURN']);
  }

  const ordinary = calculateVerifiedNewRegime({
    taxYear: '2026-27', incomeType: 'already_taxable',
    primaryIncome: (rawOrdinary / PAISA).toString() + '.' + (rawOrdinary % PAISA).toString().padStart(2, '0'),
    otherOrdinaryIncome: '0',
    residency: input.residency, specialRateIncome: 'no', confirmedOrdinaryOnly: true,
  });
  // The ordinary-only engine is the single owner of surcharge and its
  // marginal relief, including 50L, 1Cr and 2Cr thresholds.
  if (lottery === 0n) {
    return {
      ...outBase, status: 'CALCULATED', unavailableReasons: [],
      grossOrdinaryIncome: paiseFour(primary + other),
      standardDeduction: paiseFour(standard), employerNpsDeduction: paiseFour(allowedNps),
      excessNpsNotDeducted: paiseFour(disallowedNps),
      housePropertyLossNotSetOff: paiseFour(propertyLoss),
      ordinaryTaxableIncome: ordinary.taxableIncome,
      specialIncomeTaxable: '0',
      totalTaxableIncome: ordinary.taxableIncome,
      ordinaryTaxBeforeRebate: ordinary.taxBeforeRebate,
      specialIncomeTax: '0.0000', rebate: ordinary.rebate,
      surcharge: ordinary.surcharge,
      surchargeMarginalRelief: ordinary.surchargeMarginalRelief,
      cess: ordinary.cess, finalTax: ordinary.finalTax,
      taxBeforeStatutoryRounding: ordinary.taxBeforeStatutoryRounding,
      notes: notesFor(nps, propertyLoss, lottery),
    };
  }
  const ordinaryTax = units(ordinary.taxBeforeRebate);
  const specialTax = lottery * U * 30n / (PAISA * 100n);
  const totalTax = ordinaryTax + specialTax;
  const totalIncomeRupees = rawTotal / PAISA; // Already a multiple of ₹10.
  const rebate = input.residency !== 'resident' ? 0n
    : totalIncomeRupees <= 1200000n
      ? min(ordinaryTax, 60000n * U)
      : min(ordinaryTax, max(0n, totalTax - (totalIncomeRupees - 1200000n) * U));
  // Rebate is never applied to lottery tax (Section 156(3)).
  const afterRebate = totalTax - rebate;
  const cess = afterRebate * 4n / 100n;
  const beforeRounding = afterRebate + cess;
  return {
    ...outBase, status: 'CALCULATED', unavailableReasons: [],
    grossOrdinaryIncome: paiseFour(primary + other),
    standardDeduction: paiseFour(standard), employerNpsDeduction: paiseFour(allowedNps),
    excessNpsNotDeducted: paiseFour(disallowedNps),
    housePropertyLossNotSetOff: paiseFour(propertyLoss),
    ordinaryTaxableIncome: ordinary.taxableIncome,
    specialIncomeTaxable: (lottery / PAISA).toString(),
    totalTaxableIncome: totalIncomeRupees.toString(),
    ordinaryTaxBeforeRebate: four(ordinaryTax),
    specialIncomeTax: four(specialTax), rebate: four(rebate),
    surcharge: '0.0000', surchargeMarginalRelief: '0.0000',
    cess: four(cess), taxBeforeStatutoryRounding: four(beforeRounding),
    finalTax: nearestTen(beforeRounding).toString(),
    notes: notesFor(nps, propertyLoss, lottery),
  };
}
