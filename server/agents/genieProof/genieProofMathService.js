/**
 * GenieProof deterministic financial illustrations.
 *
 * These are mathematical checks of USER-SUPPLIED assumptions, not verification
 * of interest rates, products, taxes, guarantees or realizable returns.
 * Money is represented as integer paise and all periodic interest is rounded
 * half-up to the nearest paise. No binary floating-point money calculations.
 */

const RATE_DENOMINATOR = 12_000_000n; // annual percent with four decimals / (100 * 12)
const STEP_UP_DENOMINATOR = 1_000_000n; // annual percent with four decimals / 100
const MAX_MONTHS = 600;
const MAX_INPUT_RUPEES = 1_000_000_000n;

function parseFixed(value, decimals, label, maxWhole) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(label + ' must be an unsigned decimal string without scientific notation.');
  }
  const parts = value.split('.');
  if ((parts[1] || '').length > decimals || parts[0].length > 19) {
    throw new RangeError(label + ' has excess precision.');
  }
  const scale = 10n ** BigInt(decimals);
  const scaled = BigInt(parts[0]) * scale
    + BigInt((parts[1] || '').padEnd(decimals, '0') || '0');
  if (scaled > maxWhole * scale) throw new RangeError(label + ' is outside supported limits.');
  return scaled;
}

function roundHalfUp(numerator, divisor) {
  if (numerator < 0n || divisor <= 0n) throw new RangeError('Invalid interest computation');
  return (numerator + divisor / 2n) / divisor;
}

function formattedMoney(paise) {
  if (paise < 0n) throw new RangeError('Negative balance is not allowed');
  const rupees = paise / 100n;
  const subunits = (paise % 100n).toString().padStart(2, '0');
  return rupees.toString() + '.' + subunits;
}

function interestForMonth(principalPaise, rateScaled) {
  return roundHalfUp(principalPaise * rateScaled, RATE_DENOMINATOR);
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Scenario must be an object.');
  }
  const keys = Object.keys(input);
  const allowed = new Set(['type', 'amountRupees', 'annualRatePercent', 'months', 'stepUpPercent', 'claimedResultRupees']);
  if (keys.some(k => !allowed.has(k))) throw new TypeError('Unknown scenario field.');
  if (!['LUMPSUM', 'SIP', 'EMI'].includes(input.type)) {
    throw new RangeError('Calculation type must be LUMPSUM, SIP or EMI.');
  }
  if (!Number.isSafeInteger(input.months) || input.months < 1 || input.months > MAX_MONTHS) {
    throw new RangeError('Duration must be 1 to 600 whole months.');
  }
  const money = parseFixed(input.amountRupees, 2, 'Amount', MAX_INPUT_RUPEES);
  if (money <= 0n) throw new RangeError('Amount must be positive.');
  const annualRate = parseFixed(input.annualRatePercent, 4, 'Annual nominal interest rate', 100n);
  if (input.type !== 'SIP' && input.stepUpPercent !== undefined) {
    throw new TypeError('Annual step-up is only supported for SIP.');
  }
  const stepUp = input.type === 'SIP'
    ? parseFixed(input.stepUpPercent === undefined ? '0' : input.stepUpPercent, 4, 'SIP annual step-up', 100n)
    : 0n;
  if (stepUp > 25n * 10_000n) throw new RangeError('SIP annual step-up is capped at 25%.');
  const claimed = input.claimedResultRupees === undefined
    ? null : parseFixed(input.claimedResultRupees, 2, 'Claimed result', 1_000_000_000_000_000_000n);
  return { money, annualRate, stepUp, claimed };
}

export function calculateGenieProofScenario(input) {
  const { money, annualRate, stepUp, claimed } = validate(input);
  let result;
  let metric;
  let contributions = 0n;
  let interest = 0n;
  let finalInstallment = null;
  let convention;

  if (input.type === 'LUMPSUM') {
    let balance = money;
    for (let month = 0; month < input.months; month++) {
      const earned = interestForMonth(balance, annualRate);
      balance += earned;
      interest += earned;
    }
    contributions = money;
    result = balance;
    metric = 'FUTURE_VALUE';
    convention = 'One initial deposit; nominal annual rate divided by 12; monthly interest rounded half-up to paise.';
  } else if (input.type === 'SIP') {
    let balance = 0n;
    let payment = money;
    for (let month = 0; month < input.months; month++) {
      if (month !== 0 && month % 12 === 0) {
        payment += roundHalfUp(payment * stepUp, STEP_UP_DENOMINATOR);
      }
      const earned = interestForMonth(balance, annualRate);
      interest += earned;
      balance += earned + payment;
      contributions += payment;
    }
    result = balance;
    metric = 'FUTURE_VALUE';
    convention = 'Monthly SIP paid at the END of each month, with step-up before month 13, 25, etc; rate is nominal annual divided by 12; interest and annual payment increases rounded half-up to paise.';
  } else {
    const remaining = monthlyPayment => {
      let balance = money;
      for (let month = 0; month < input.months && balance > 0n; month++) {
        balance += interestForMonth(balance, annualRate);
        if (monthlyPayment >= balance) return 0n;
        balance -= monthlyPayment;
      }
      return balance;
    };
    // Binary-search the smallest constant paise instalment that fully
    // amortizes the principal with interest rounded to paise each month.
    let lo = 0n;
    let hi = money + interestForMonth(money, annualRate);
    while (lo < hi) {
      const middle = (lo + hi) / 2n;
      if (remaining(middle) === 0n) hi = middle;
      else lo = middle + 1n;
    }
    result = lo;
    let balance = money;
    let totalPaid = 0n;
    for (let month = 0; month < input.months && balance > 0n; month++) {
      const earned = interestForMonth(balance, annualRate);
      interest += earned;
      balance += earned;
      const payment = balance < result ? balance : result;
      balance -= payment;
      totalPaid += payment;
      finalInstallment = payment;
    }
    if (balance !== 0n) throw new Error('Amortization failed');
    contributions = totalPaid;
    metric = 'MONTHLY_EMI';
    convention = 'Fixed monthly EMI due at month-end; reducing-balance interest at nominal annual rate / 12; monthly interest rounded half-up to paise; last instalment adjusted.';
  }

  const difference = claimed === null ? null : claimed > result ? claimed - result : result - claimed;
  return {
    ok: true,
    mode: 'USER_INPUT_MATH_CHECK',
    type: input.type,
    metric,
    months: input.months,
    assumptionRatePercent: input.annualRatePercent,
    assumptionSource: 'USER_SUPPLIED_NOT_VERIFIED',
    amountRupees: input.amountRupees,
    stepUpPercent: input.type === 'SIP' ? (input.stepUpPercent || '0') : null,
    resultRupees: formattedMoney(result),
    totalPaidOrContributedRupees: formattedMoney(contributions),
    totalInterestRupees: formattedMoney(interest),
    lastInstallmentRupees: finalInstallment === null ? null : formattedMoney(finalInstallment),
    claimedResultRupees: claimed === null ? null : formattedMoney(claimed),
    absoluteDifferenceRupees: difference === null ? null : formattedMoney(difference),
    arithmeticFinding: claimed === null
      ? 'CALCULATED_ONLY'
      : difference <= 1n ? 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE' : 'DIFFERS_FROM_ASSUMPTIONS',
    convention,
    exclusions: ['TAXES', 'FEES', 'INFLATION', 'RATE_CHANGES', 'PRODUCT_TERMS', 'MARKET_RETURNS'],
    caveat: 'Only the arithmetic is checked. The rate, investment product, repayment terms and realized returns are NOT verified. Actual amounts may differ.',
    saved: false,
  };
}
