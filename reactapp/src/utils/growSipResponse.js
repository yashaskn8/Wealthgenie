/**
 * Fail-closed boundary for the Grow My SIP planner only.  Legacy GenieChat
 * callers retain the independent, backwards-compatible projection API.
 * Do not render projected money or a budget approval from partial/old data.
 */
// Must match the backend's conservative paisa-safe financial ceiling.
const MAX_AMOUNT = 10000000000000;
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
// Independent signed decimal-paisa reconciliation for annual budgets.
// Rounding negative half-paisa deficits toward zero falsely understates debt.
function roundSignedPaise(n) {
  if (!Number.isFinite(n)) return NaN;
  const [numerator, denominator] = decimalFraction(Math.abs(n));
  const cents = (2n * numerator * 100n + denominator) / (2n * denominator);
  return (n < 0 ? -Number(cents) : Number(cents)) / 100;
}

function paiseUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || Math.abs(value) > MAX_AMOUNT) return null;
  const [numerator, denominator] = decimalFraction(Math.abs(value));
  const units = numerator * 100n;
  return units % denominator === 0n
    ? (value < 0 ? -1n : 1n) * (units / denominator)
    : null;
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
    || value.calculation_classification !== 'NON_RECOMMENDATION_STEP_UP_CALCULATION'
    || value.return_basis !== 'PRE_TAX_NOMINAL'
    || value.return_data_class !== 'USER_INPUT'
    || value.return_assumption_source !== 'USER_SUPPLIED_WHAT_IF'
    || value.contribution_timing !== 'START_OF_MONTH'
    || value.scenario_interpretation !== 'ILLUSTRATIVE_CONSTANT_RETURN_PATHS_NOT_PROBABILITIES'
    || !Array.isArray(value.warnings)
    || !value.warnings.includes('PRE_TAX_NOT_A_TAX_ESTIMATE')
    || !value.warnings.includes('ASSUMED_RETURNS_NOT_GUARANTEED')
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
  let scheduledStepUpPrincipalPaise = 0n;
  const initialPaise = paiseUnits(input.monthlyInvestment);
  if (initialPaise === null || initialPaise <= 0n) invalid();
  // Independent monthly compounding reconciliation: agreeing headline and
  // chart values are not sufficient if both have been inflated or shifted.
  const monthlyRate = Math.expm1(Math.log1p(input.annualReturnRate) / 12);
  const downsideMonthlyRate = Math.expm1(Math.log1p(input.downsideAnnualReturnRate) / 12);
  let flatCorpus = 0, stepCorpus = 0, downsideCorpus = 0;
  if (![monthlyRate, downsideMonthlyRate].every(Number.isFinite)
    || input.downsideAnnualReturnRate > input.annualReturnRate) invalid();
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
    for (let month = 0; month < 12; month++) {
      flatCorpus = (flatCorpus + input.monthlyInvestment) * (1 + monthlyRate);
      stepCorpus = (stepCorpus + expectedSip) * (1 + monthlyRate);
      downsideCorpus = (downsideCorpus + expectedSip) * (1 + downsideMonthlyRate);
    }
    const purchasingPower = Math.pow(1 + input.inflationRate, i + 1);
    if (![flatCorpus, stepCorpus, downsideCorpus, purchasingPower].every(Number.isFinite)
      || !validAmount(flatCorpus) || !validAmount(stepCorpus) || !validAmount(downsideCorpus)
      || !validAmount(row.inflationAdjustedFlat)
      || row.flatSIP !== Math.round(flatCorpus)
      || row.stepUpSIP !== Math.round(stepCorpus)
      || row.downsideStepUp !== Math.round(downsideCorpus)
      || row.inflationAdjustedFlat !== Math.round(flatCorpus / purchasingPower)
      || row.inflationAdjustedStepUp !== Math.round(stepCorpus / purchasingPower)) invalid();
    const expectedSipUnits = paiseUnits(expectedSip);
    if (expectedSipUnits === null) invalid();
    const expectedFlatPaidUnits = initialPaise * BigInt(12 * (i + 1));
    scheduledStepUpPrincipalPaise += expectedSipUnits * 12n;
    if (paiseUnits(row.monthlySip) !== expectedSipUnits
      || paiseUnits(row.flatInvested) !== expectedFlatPaidUnits
      || paiseUnits(row.stepUpInvested) !== scheduledStepUpPrincipalPaise
      || row.stepUpInvested + 0.011 < row.flatInvested
      || row.stepUpSIP < row.flatSIP
      || row.downsideStepUp > row.stepUpSIP
      || row.inflationAdjustedStepUp > row.stepUpSIP) invalid();
  }
  const last = value.chartData[years - 1];
  const investedDifferencePaise = scheduledStepUpPrincipalPaise
    - initialPaise * BigInt(12 * years);
  if (paiseUnits(value.additionalContributions) !== investedDifferencePaise
    || paiseUnits(value.additionalProjectedGrowth)
      !== BigInt(value.additionalCorpus) * 100n - investedDifferencePaise
    || paiseUnits(value.flatProjectedGrowth)
      !== BigInt(value.flatFinal) * 100n - initialPaise * BigInt(12 * years)
    || paiseUnits(value.stepUpProjectedGrowth)
      !== BigInt(value.stepUpFinal) * 100n - scheduledStepUpPrincipalPaise) invalid();
  const expectedUplift = flatCorpus >= 0.5 && Number.isFinite(stepCorpus / flatCorpus)
    ? ((stepCorpus / flatCorpus) - 1) * 100 : null;
  if (!(expectedUplift === null
    ? value.additionalPercent === null
    : typeof value.additionalPercent === 'number'
      && Number.isFinite(value.additionalPercent)
      && Math.abs(value.additionalPercent - expectedUplift) < 1e-7)
    || !validSigned(value.flatProjectedGrowth)
    || !validSigned(value.stepUpProjectedGrowth)
    || Math.abs(value.flatProjectedGrowth - (value.flatFinal - value.flatInvested)) > 0.011
    || Math.abs(value.stepUpProjectedGrowth - (value.stepUpFinal - value.stepUpInvested)) > 0.011) invalid();
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
  let worstRawSurplus = null;
  if (!Array.isArray(budget.annualContributionSchedule)
    || budget.annualContributionSchedule.length !== years
    || budget.assumesEmiConstant !== true
    || budget.incomeExpensesUserDeclared !== hasBudget) invalid();
  for (let i = 0; i < years; i++) {
    const row = value.chartData[i];
    const statedSchedule = budget.annualContributionSchedule[i];
    if (!statedSchedule || statedSchedule.year !== row.year
      || statedSchedule.monthlySip !== row.monthlySip
      || statedSchedule.monthlyBudgetSurplus !== row.monthlyBudgetSurplus) invalid();
    if (!hasBudget) {
      if (row.monthlyBudgetSurplus !== null) invalid();
      continue;
    }
    const available = input.monthlyIncome * Math.pow(1 + input.annualIncomeGrowthRate, i)
      - input.monthlyExpenses * Math.pow(1 + input.annualExpenseGrowthRate, i)
      - input.monthlyEmi;
    const surplus = available - row.monthlySip;
    worstRawSurplus = worstRawSurplus === null ? surplus : Math.min(worstRawSurplus, surplus);
    if (!Number.isFinite(surplus) || !validSigned(surplus)
      || !matchingNumber(row.monthlyBudgetSurplus, roundSignedPaise(surplus))) invalid();
    if (surplus < -0.005) {
      if (firstUnfundedMonth === null) firstUnfundedMonth = i * 12 + 1;
      largestShortfall = Math.max(largestShortfall, -surplus);
    }
  }
  if (budget.worstMonthlySurplus !== (hasBudget ? roundSignedPaise(worstRawSurplus) : null)
    || (!hasBudget && budget.maxMonthlyShortfall !== 0)) invalid();
  if (hasBudget) {
    const expectedStatus = firstUnfundedMonth === null
      ? 'WITHIN_DECLARED_BUDGET' : 'OVER_DECLARED_BUDGET';
    if (budget.status !== expectedStatus
      || budget.firstUnaffordableMonth !== firstUnfundedMonth
      || !matchingNumber(budget.maxMonthlyShortfall,
        roundSignedPaise(largestShortfall))) invalid();
  }
  if ((hasBudget && budget.status === 'NOT_ASSESSED')
    || (!hasBudget && budget.status !== 'NOT_ASSESSED')) invalid();
  const buffer = value.emergency_buffer;
  if ((hasEmergency && buffer.status === 'NOT_ASSESSED')
    || (!hasEmergency && buffer.status !== 'NOT_ASSESSED')) invalid();
  // Even unassessed buffer metadata must stay honest. If expenses/EMI are
  // known, the threshold is computable without declared savings. If either
  // expense is unknown, requiredAmount must remain null, never fabricated.
  const hasExpenseInputs = ['monthlyExpenses', 'monthlyEmi']
    .every(key => input[key] !== undefined && input[key] !== null);
  const expectedEmergencyRequirement = hasExpenseInputs
    ? roundSignedPaise((input.monthlyExpenses + input.monthlyEmi)
      * (input.emergencyMonths ?? 6))
    : null;
  const declared = input.emergencySavings === undefined ? null : input.emergencySavings;
  if (buffer.requiredAmount !== expectedEmergencyRequirement
    || buffer.declaredAmount !== declared) invalid();
  if (hasEmergency) {
    const expectedStatus = input.emergencySavings >= expectedEmergencyRequirement
      ? 'DECLARED_BUFFER_MET' : 'DECLARED_BUFFER_SHORT';
    if (buffer.status !== expectedStatus) invalid();
  }

  // Every published warning must match the underlying status. Omissions or
  // contradictory flags can mislead other clients even if this UI ignores them.
  for (const [code, shouldExist] of [
    ['AFFORDABILITY_NOT_ASSESSED', !hasBudget],
    ['MONTHLY_EMI_NOT_DECLARED', input.monthlyEmi === undefined || input.monthlyEmi === null],
    ['STEP_UP_EXCEEDS_DECLARED_BUDGET', firstUnfundedMonth !== null],
    ['DECLARED_EMERGENCY_BUFFER_SHORT', buffer.status === 'DECLARED_BUFFER_SHORT'],
    ['EMERGENCY_BUFFER_NOT_ASSESSED', buffer.status === 'NOT_ASSESSED'],
  ]) {
    if (value.warnings.includes(code) !== shouldExist) invalid();
  }

  if ((budget.status === 'WITHIN_DECLARED_BUDGET' && budget.firstUnaffordableMonth !== null)
    || (budget.status === 'OVER_DECLARED_BUDGET'
      && (!Number.isInteger(budget.firstUnaffordableMonth) || budget.firstUnaffordableMonth < 1
        || budget.firstUnaffordableMonth > years * 12
        || !validAmount(budget.maxMonthlyShortfall) || budget.maxMonthlyShortfall <= 0))
    || (budget.status === 'NOT_ASSESSED' && budget.firstUnaffordableMonth !== null)) invalid();

  return value;
}
