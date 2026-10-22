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

  if (value.additionalCorpus !== value.stepUpFinal - value.flatFinal
    || Math.abs(value.additionalContributions - (value.stepUpInvested - value.flatInvested)) > 0.011
    || Math.abs(value.additionalProjectedGrowth - (value.additionalCorpus - value.additionalContributions)) > 0.011
    || value.stepUpFinal < value.flatFinal
    || value.stepUpInvested + 0.001 < value.flatInvested) invalid();

  const years = input.years;
  for (let i = 0; i < years; i++) {
    const row = value.chartData[i];
    if (!row || row.year !== i + 1
      || !validAmount(row.flatSIP) || !validAmount(row.stepUpSIP)
      || !validAmount(row.downsideStepUp)
      || !validAmount(row.flatInvested) || !validAmount(row.stepUpInvested)
      || !validAmount(row.inflationAdjustedStepUp) || !validAmount(row.monthlySip)
      || !(row.monthlyBudgetSurplus === null || validSigned(row.monthlyBudgetSurplus))) invalid();
  }
  const last = value.chartData[years - 1];
  if (last.flatSIP !== value.flatFinal || last.stepUpSIP !== value.stepUpFinal
    || last.stepUpInvested !== value.stepUpInvested || last.flatInvested !== value.flatInvested
    || last.downsideStepUp !== value.downsideFinal
    || last.inflationAdjustedStepUp !== value.inflationAdjustedStepUpFinal
    || Math.abs(last.monthlySip - value.finalMonthlySip) > 0.001) invalid();

  const budget = value.affordability;
  if ((budget.status === 'WITHIN_DECLARED_BUDGET' && budget.firstUnaffordableMonth !== null)
    || (budget.status === 'OVER_DECLARED_BUDGET'
      && (!Number.isInteger(budget.firstUnaffordableMonth) || budget.firstUnaffordableMonth < 1
        || budget.firstUnaffordableMonth > years * 12
        || !validAmount(budget.maxMonthlyShortfall) || budget.maxMonthlyShortfall <= 0))
    || (budget.status === 'NOT_ASSESSED' && budget.firstUnaffordableMonth !== null)) invalid();

  return value;
}
