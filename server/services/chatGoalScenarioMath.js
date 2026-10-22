/**
 * Financial-goal scenario mathematics. All amounts are integer paise; all
 * percentage inputs must come from authenticated user text, never an LLM.
 * Annual rates are EFFECTIVE rates (CAGR), converted to equivalent monthly
 * multipliers. Monthly deposits arrive at the END of each month. Existing
 * earmarked savings are held constant (not assumed invested).
 *
 * Fixed-point multipliers are conservative: investment-growth roots round
 * downward and inflation roots upward. Final obligations round UP to a paisa.
 * This is a mathematical illustration, not a return/tax/product forecast.
 */
const SCALE = 10n ** 24n;
const HUNDRED_PERCENT_UNITS = 100_000_000n;
const MAX_PAISE = 100_000_000_000n * 100n;

const ceilDiv = (a, b) => (a + b - 1n) / b;

function exactPaise(value) {
  const raw = String(value);
  const parts = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!parts) return null;
  const paise = BigInt(parts[1]) * 100n + BigInt((parts[2] || '').padEnd(2, '0') || '0');
  return paise <= MAX_PAISE ? paise : null;
}

function percentParts(raw) {
  if (raw === null || raw === undefined) return null;
  const match = String(raw).match(/^(-?)(\d{1,3})(?:\.(\d{1,4}))?$/);
  if (!match) return null;
  const value = BigInt(match[2]) * 10_000n + BigInt((match[3] || '').padEnd(4, '0') || '0');
  const signed = match[1] === '-' ? -value : value;
  // A negative annual CAGR cannot be <= -100%. Outsize positive values are
  // refused rather than emitted as a plausible personal projection.
  if (signed <= -1_000_000n || signed > 1_000_000n) return null;
  return signed;
}

function monthlyFactor(annualPercent, roundUp) {
  const fraction = percentParts(annualPercent);
  if (fraction === null) return null;
  const annualNumerator = HUNDRED_PERCENT_UNITS + fraction * 100n;
  if (annualNumerator <= 0n) return null;
  // 12th root of an effective annual factor with <= 10^-24 precision.
  // Integer comparison avoids rounding error in Number/Math.pow.
  const annualTarget = annualNumerator * (SCALE ** 12n);
  let lower = 0n;
  let upper = SCALE * 2n;
  while (lower + 1n < upper) {
    const middle = (lower + upper) / 2n;
    if (middle ** 12n * HUNDRED_PERCENT_UNITS <= annualTarget) lower = middle;
    else upper = middle;
  }
  return roundUp && lower ** 12n * HUNDRED_PERCENT_UNITS < annualTarget
    ? lower + 1n : lower;
}

/** Rate is the user's annual EFFECTIVE rate, not an external/market estimate. */
export function calculateGoalCompoundingScenario({
  target, earmarkedSavings = 0, months, annualReturnPercent,
  annualInflationPercent = null, targetIsPresentValue = false,
}) {
  if (!Number.isSafeInteger(months) || months < 1 || months > 600) return null;
  const targetPaise = exactPaise(target);
  const savedPaise = exactPaise(earmarkedSavings);
  if (targetPaise === null || savedPaise === null || targetPaise <= 0n
      || savedPaise > targetPaise) return null;
  const growthFactor = monthlyFactor(annualReturnPercent, false);
  if (growthFactor === null) return null;
  if (annualInflationPercent !== null && !targetIsPresentValue) return null;
  const monthsBig = BigInt(months);
  const scaleN = SCALE ** monthsBig;
  let futureTargetPaise = targetPaise;
  if (annualInflationPercent !== null) {
    const inflationFactor = monthlyFactor(annualInflationPercent, true);
    if (inflationFactor === null) return null;
    futureTargetPaise = ceilDiv(targetPaise * inflationFactor ** monthsBig, scaleN);
  }
  if (futureTargetPaise > MAX_PAISE) return null;
  const gap = futureTargetPaise > savedPaise ? futureTargetPaise - savedPaise : 0n;
  const scaleNMinusOne = SCALE ** (monthsBig - 1n);
  // Geometric sum: 1 + f + f^2 + ... + f^(n-1), scaled by SCALE^(n-1).
  const sum = growthFactor === SCALE
    ? monthsBig * scaleNMinusOne
    : (growthFactor ** monthsBig - scaleN) / (growthFactor - SCALE);
  if (sum <= 0n) return null;
  const monthlyPaise = ceilDiv(gap * scaleNMinusOne, sum);
  if (monthlyPaise > MAX_PAISE) return null;
  const projectedFromExactRoundedPayments = savedPaise * scaleNMinusOne
    + monthlyPaise * sum;
  if (projectedFromExactRoundedPayments < futureTargetPaise * scaleNMinusOne) {
    throw new Error('GOAL_SCENARIO_INVARIANT_FAILED');
  }
  return Object.freeze({
    requiredMonthlyContribution: Number(monthlyPaise) / 100,
    inflatedTarget: Number(futureTargetPaise) / 100,
    startBalance: Number(savedPaise) / 100,
    months,
    annualReturnPercent: Number(annualReturnPercent),
    annualInflationPercent: annualInflationPercent === null ? null : Number(annualInflationPercent),
    rateConvention: 'EFFECTIVE_ANNUAL_CAGR',
    monthlyPaymentTiming: 'END_OF_MONTH',
    savedBalanceGrowth: 'NONE',
    treatment: 'GROSS_BEFORE_TAX_FEES_AND_UNMODELED_COSTS',
    illustrativeOnly: true,
  });
}
