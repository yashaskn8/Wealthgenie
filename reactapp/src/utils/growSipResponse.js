/**
 * Fail-closed boundary for the Grow My SIP planner only.  Legacy GenieChat
 * callers retain the independent, backwards-compatible projection API.
 * Do not render projected money or a budget approval from partial/old data.
 */
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER / 100;
const BUDGET_STATES = new Set(['NOT_ASSESSED', 'WITHIN_DECLARED_BUDGET', 'OVER_DECLARED_BUDGET']);
const BUFFER_STATES = new Set(['NOT_ASSESSED', 'DECLARED_BUFFER_MET', 'DECLARED_BUFFER_SHORT']);
const validAmount = value => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= MAX_AMOUNT;
const validSigned = value => typeof value === 'number' && Number.isFinite(value)
  && Math.abs(value) <= MAX_AMOUNT;

// Independent decimal paise oracle for annual contribution schedules.
// Do not reconstruct monetary deposits with Math.pow() floating-point ties.
function decimalFraction(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const [whole, part = ''] = mantissa.split('.');
  const digits = BigInt(whole + part);
  const exp = Number(exponentText) - part.length;
  return exp >= 0
    ? [digits * (10n ** BigInt(exp)), 1n]
    : [digits, 10n ** BigInt(-exp)];
}
function expectedAnnualSipPaise(startingAmount, annualStepRate, yearIndex) {
  const [stepNumerator, stepDenominator] = decimalFraction(annualStepRate);
  const initialPaise = BigInt(Math.round(startingAmount * 100));
  const numerator = initialPaise * ((stepDenominator + stepNumerator) ** BigInt(yearIndex));
  const denominator = stepDenominator ** BigInt(yearIndex);
  return Number((2n * numerator + denominator) / (2n * denominator)) / 100;
}

export function assertGrowSipResponse(value, input) {
  const invalid = () => { throw new Error('Grow My SIP received an invalid or incompatible financial projection. No results were displayed.'); };
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || value.schema_version !== 'sip-plan-v1'
    || value.monthly_rate_convention !== 'EFFECTIVE_ANNUAL_CAGR'
    || value.annual_return_interpretation !== 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN'
    || value.observed_market_fact !== false || value.provider_forecast !== false
    || value.capital_gains_tax !== null || value.estimated_post_tax_corpus !== null) invalid();

  const required = [
    'flatFinal', 'stepUpFinal', 'downsideFinal',
    'flatInvested', 'stepUpInvested', 'finalMonthlySip',
    'inflationAdjustedStepUpFinal', 'additionalContributions',
  ];
  if (!required.every(key => validAmount(value[key]))
    || !validSigned(value.additionalCorpus) || !validSigned(value.additionalProjectedGrowth)
    || !(value.additionalPercent === null || validSigned(value.additionalPercent))
    || !BUDGET_STATES.has(value.affordability?.status)
    || !BUFFER_STATES.has(value.emergency_buffer?.status)
    || !Array.isArray(value.chartData)
    || value.chartData.length !== input.years) invalid();

  const matchingNumber = (a, b) => typeof a === 'number'
    && typeof b === 'number' && Math.abs(a - b) < 1e-9;
  if (!value.assumptions
    || !matchingNumber(value.assumptions.monthlyInvestment, input.monthlyInvestment)
    || !matchingNumber(value.assumptions.annualReturnRate, input.annualReturnRate)
    || !matchingNumber(value.assumptions.annualStepUpRate, input.annualStepUpRate)
    || value.assumptions.years !== input.years
    || value.assumptions.returnRateConvention !== 'EFFECTIVE_ANNUAL_CAGR') invalid();

  // Validation must bind the entire scenario (not just the SIP amount).
  for (const key of ['inflationRate', 'downsideAnnualReturnRate',
    'annualIncomeGrowthRate', 'annualExpenseGrowthRate']) {
    if (key in input && !matchingNumber(value.assumptions[key], input[key])) invalid();
  }
  for (const key of ['monthlyIncome', 'monthlyExpenses', 'monthlyEmi', 'emergencySavings']) {
    const expected = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : null;
    if (expected === null) {
      if (value.assumptions[key] !== null) invalid();
    } else if (!matchingNumber(value.assumptions[key], expected)) invalid();
  }
  if (value.assumptions.emergencyMonths !== (input.emergencyMonths ?? 6)) invalid();

  if (value.additionalCorpus !== value.stepUpFinal - value.flatFinal
    || Math.abs(value.additionalContributions - (value.stepUpInvested - value.flatInvested)) > 0.011
    || Math.abs(value.additionalProjectedGrowth - (value.additionalCorpus - value.additionalContributions)) > 0.011
    || value.stepUpFinal < value.flatFinal
    || value.stepUpInvested + 0.001 < value.flatInvested) invalid();

  const years = input.years;
  let scheduledStepUpPrincipal = 0;
  for (let i = 0; i < years; i++) {
    const row = value.chartData[i];
    if (!row || row.year !== i + 1
      || !validAmount(row.flatSIP) || !validAmount(row.stepUpSIP)
      || !validAmount(row.downsideStepUp)
      || !validAmount(row.flatInvested) || !validAmount(row.stepUpInvested)
      || !validAmount(row.inflationAdjustedStepUp) || !validAmount(row.monthlySip)
      || !(row.monthlyBudgetSurplus === null || validSigned(row.monthlyBudgetSurplus))) invalid();
    // Prevent forged intermediate-year charts: contribution schedule, nominal
    // and downside ordering must hold for every year, not only the endpoint.
    const expectedSip = expectedAnnualSipPaise(
      input.monthlyInvestment, input.annualStepUpRate, i,
    );
    const expectedFlatPaid = Math.round(input.monthlyInvestment * 12 * (i + 1) * 100) / 100;
    scheduledStepUpPrincipal += expectedSip * 12;
    const expectedStepUpPaid = Math.round(scheduledStepUpPrincipal * 100) / 100;
    if (Math.abs(row.monthlySip - expectedSip) > 0.00001
      || Math.abs(row.flatInvested - expectedFlatPaid) > 0.02
      || Math.abs(row.stepUpInvested - expectedStepUpPaid) > 0.02
      || row.stepUpInvested + 0.011 < row.flatInvested
      || row.stepUpSIP < row.flatSIP
      || row.downsideStepUp > row.stepUpSIP
      || row.inflationAdjustedStepUp > row.stepUpSIP) invalid();
  }
  const last = value.chartData[years - 1];
  if (last.flatSIP !== value.flatFinal || last.stepUpSIP !== value.stepUpFinal
    || last.stepUpInvested !== value.stepUpInvested || last.flatInvested !== value.flatInvested
    || last.downsideStepUp !== value.downsideFinal
    || last.inflationAdjustedStepUp !== value.inflationAdjustedStepUpFinal
    || Math.abs(last.monthlySip - value.finalMonthlySip) > 0.001) invalid();

  // An 'approved' budget or met emergency buffer needs the corresponding
  // *declared* financial inputs. Otherwise an old/corrupt backend could
  // promote unknown income, expenses, or EMI to a reassuring status.
  const hasBudget = ['monthlyIncome', 'monthlyExpenses', 'monthlyEmi']
    .every(key => input[key] !== undefined && input[key] !== null);
  const hasEmergency = ['monthlyExpenses', 'monthlyEmi', 'emergencySavings']
    .every(key => input[key] !== undefined && input[key] !== null);
  const budget = value.affordability;
  let firstUnfundedMonth = null;
  let largestShortfall = 0;
  for (let i = 0; i < years; i++) {
    const row = value.chartData[i];
    if (!hasBudget) {
      if (row.monthlyBudgetSurplus !== null) invalid();
      continue;
    }
    const available = input.monthlyIncome * Math.pow(1 + input.annualIncomeGrowthRate, i)
      - input.monthlyExpenses * Math.pow(1 + input.annualExpenseGrowthRate, i)
      - input.monthlyEmi;
    const surplus = available - row.monthlySip;
    if (!Number.isFinite(surplus) || !validSigned(surplus)
      || !matchingNumber(row.monthlyBudgetSurplus, Math.round((surplus
        + Math.sign(surplus) * Number.EPSILON) * 100) / 100)) invalid();
    if (surplus < -0.005) {
      if (firstUnfundedMonth === null) firstUnfundedMonth = i * 12 + 1;
      largestShortfall = Math.max(largestShortfall, -surplus);
    }
  }
  if (hasBudget) {
    const expectedStatus = firstUnfundedMonth === null
      ? 'WITHIN_DECLARED_BUDGET' : 'OVER_DECLARED_BUDGET';
    if (budget.status !== expectedStatus
      || budget.firstUnaffordableMonth !== firstUnfundedMonth
      || !matchingNumber(budget.maxMonthlyShortfall,
        Math.round(largestShortfall * 100) / 100)) invalid();
  }
  if ((hasBudget && budget.status === 'NOT_ASSESSED')
    || (!hasBudget && budget.status !== 'NOT_ASSESSED')) invalid();
  const buffer = value.emergency_buffer;
  if ((hasEmergency && buffer.status === 'NOT_ASSESSED')
    || (!hasEmergency && buffer.status !== 'NOT_ASSESSED')) invalid();
  if (hasEmergency) {
    const required = Math.round(((input.monthlyExpenses + input.monthlyEmi)
      * (input.emergencyMonths ?? 6) + Number.EPSILON) * 100) / 100;
    const expectedStatus = input.emergencySavings >= required
      ? 'DECLARED_BUFFER_MET' : 'DECLARED_BUFFER_SHORT';
    if (buffer.status !== expectedStatus
      || !matchingNumber(buffer.requiredAmount, required)
      || !matchingNumber(buffer.declaredAmount, input.emergencySavings)) invalid();
  }

  if ((budget.status === 'WITHIN_DECLARED_BUDGET' && budget.firstUnaffordableMonth !== null)
    || (budget.status === 'OVER_DECLARED_BUDGET'
      && (!Number.isInteger(budget.firstUnaffordableMonth) || budget.firstUnaffordableMonth < 1
        || budget.firstUnaffordableMonth > years * 12
        || !validAmount(budget.maxMonthlyShortfall) || budget.maxMonthlyShortfall <= 0))
    || (budget.status === 'NOT_ASSESSED' && budget.firstUnaffordableMonth !== null)) invalid();

  return value;
}
