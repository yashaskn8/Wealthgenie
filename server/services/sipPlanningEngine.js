/**
 * Key-free, deterministic, illustrative SIP planner. No live price dependencies.
 * Cash arrives at the START of each month. Explicit monthly-rate convention, with legacy APR as default for existing API callers.
 */
const LIMIT = Number.MAX_SAFE_INTEGER / 100;
const money = n => {
  if (!Number.isFinite(n) || Math.abs(n) > LIMIT) {
    throw new RangeError('SIP_PLAN_LIMIT_EXCEEDED: amount exceeds safe currency precision');
  }
  return Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
};
// Monetary inputs and yearly SIP instalments are decimal quantities. Use exact
// rational arithmetic for paise so binary floating-point ties never lose ₹0.01.
// Returns nonnegative canonical decimal number as numerator/denominator BigInt.
function decimalFraction(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const [whole, part = ''] = mantissa.split('.');
  const digits = BigInt(whole + part);
  const exp = Number(exponentText) - part.length;
  return exp >= 0
    ? [digits * (10n ** BigInt(exp)), 1n]
    : [digits, 10n ** BigInt(-exp)];
}
const validPaise = n => {
  if (!Number.isFinite(n) || n < 0) return false;
  const [numerator, denominator] = decimalFraction(n);
  return numerator * 100n % denominator === 0n;
};
const checked = n => {
  if (!Number.isFinite(n) || n < 0 || n > LIMIT) {
    throw new RangeError('SIP_PLAN_LIMIT_EXCEEDED: projected amount exceeds safe rupee precision');
  }
  return n;
};
const rounded = n => Math.round(checked(n));
const MONTHLY_RATE_CONVENTIONS = Object.freeze([
  'NOMINAL_APR_DIVIDED_BY_12', 'EFFECTIVE_ANNUAL_CAGR',
]);
function toMonthlyRate(rate, convention) {
  return convention === 'EFFECTIVE_ANNUAL_CAGR'
    ? Math.expm1(Math.log1p(rate) / 12)
    : rate / 12;
}

export function buildSipPlan(input) {
  const {
    monthlyInvestment, annualReturnRate, annualStepUpRate, years,
    returnRateConvention = 'NOMINAL_APR_DIVIDED_BY_12',
    inflationRate = 0.06,
    downsideAnnualReturnRate = Math.min(annualReturnRate, Math.max(-0.99, annualReturnRate - 0.08)),
    monthlyIncome = null, monthlyExpenses = null, monthlyEmi = null,
    emergencySavings = null, emergencyMonths = 6,
    annualIncomeGrowthRate = 0, annualExpenseGrowthRate = 0.06,
  } = input;
  const required = [monthlyInvestment, annualReturnRate, annualStepUpRate, years,
    inflationRate, downsideAnnualReturnRate, emergencyMonths,
    annualIncomeGrowthRate, annualExpenseGrowthRate];
  if (!MONTHLY_RATE_CONVENTIONS.includes(returnRateConvention)
      || !required.every(Number.isFinite) || !Number.isInteger(years) || years < 1 || years > 50
      || monthlyInvestment <= 0 || monthlyInvestment > 10000000 || !validPaise(monthlyInvestment)
      || annualStepUpRate < 0 || annualStepUpRate > 1
      || annualReturnRate <= -1 || annualReturnRate > 1
      || downsideAnnualReturnRate <= -1 || downsideAnnualReturnRate > annualReturnRate
      || inflationRate < 0 || inflationRate > 1
      || emergencyMonths < 0 || emergencyMonths > 24
      || annualIncomeGrowthRate < 0 || annualIncomeGrowthRate > 1
      || annualExpenseGrowthRate < 0 || annualExpenseGrowthRate > 1) {
    throw new RangeError('SIP_PLAN_INVALID_INPUT: invalid planning assumptions');
  }
  for (const [key, val] of Object.entries({ monthlyIncome, monthlyExpenses, monthlyEmi, emergencySavings })) {
    if (val !== null && (!Number.isFinite(val) || val < 0 || val > (key === 'monthlyEmi' ? 10000000 : 100000000) || !validPaise(val))) {
      throw new RangeError('SIP_PLAN_INVALID_INPUT: invalid ' + key);
    }
  }
  const assessBudget = monthlyIncome !== null && monthlyExpenses !== null && monthlyEmi !== null;
  const r = toMonthlyRate(annualReturnRate, returnRateConvention);
  const downsideR = toMonthlyRate(downsideAnnualReturnRate, returnRateConvention);
  let flat = 0, stepped = 0, downside = 0, flatPaid = 0, steppedPaid = 0;
  let firstUnaffordableMonth = null, maxMonthlyShortfall = 0, worstMonthlySurplus = null;
  let lastSip = monthlyInvestment;
  const chartData = [];
  // Apply each year's step-up to the ORIGINAL initial instalment. Do not
  // recursively round last year's payment: these are different contracts.
  const [stepNumerator, stepDenominator] = decimalFraction(annualStepUpRate);
  const stepFactorNumerator = stepDenominator + stepNumerator;
  const startingPaise = BigInt(Math.round(monthlyInvestment * 100));
  let stepPowerNumerator = 1n;
  let stepPowerDenominator = 1n;

  for (let year = 1; year <= years; year += 1) {
    const exactPaiseNumerator = startingPaise * stepPowerNumerator;
    const instalmentPaise = (2n * exactPaiseNumerator + stepPowerDenominator)
      / (2n * stepPowerDenominator); // half-up; exact at a paise tie
    if (instalmentPaise > 1000000000n) {
      throw new RangeError('SIP_PLAN_LIMIT_EXCEEDED: future monthly SIP exceeds ₹1,00,00,000');
    }
    const annualSip = Number(instalmentPaise) / 100;
    stepPowerNumerator *= stepFactorNumerator;
    stepPowerDenominator *= stepDenominator;
    lastSip = annualSip;
    const available = assessBudget
      ? monthlyIncome * Math.pow(1 + annualIncomeGrowthRate, year - 1)
        - monthlyExpenses * Math.pow(1 + annualExpenseGrowthRate, year - 1) - monthlyEmi
      : null;
    // All projected budget figures must remain representable; never serialize
    // Infinity as null or claim a positive budget using unbounded growth.
    if (available !== null) {
      if (!Number.isFinite(available) || Math.abs(available) > LIMIT) {
        throw new RangeError('SIP_PLAN_LIMIT_EXCEEDED: future declared budget exceeds safe INR precision');
      }
    }
    const surplus = available === null ? null : available - annualSip;
    if (surplus !== null) {
      worstMonthlySurplus = worstMonthlySurplus === null ? surplus : Math.min(worstMonthlySurplus, surplus);
      if (surplus < -0.005) {
        if (firstUnaffordableMonth === null) firstUnaffordableMonth = (year - 1) * 12 + 1;
        maxMonthlyShortfall = Math.max(maxMonthlyShortfall, -surplus);
      }
    }
    for (let month = 0; month < 12; month += 1) {
      flat = checked((flat + monthlyInvestment) * (1 + r));
      stepped = checked((stepped + annualSip) * (1 + r));
      downside = checked((downside + annualSip) * (1 + downsideR));
      flatPaid = checked(flatPaid + monthlyInvestment);
      steppedPaid = checked(steppedPaid + annualSip);
    }
    const factor = Math.pow(1 + inflationRate, year);
    chartData.push({
      year, flatSIP: rounded(flat), stepUpSIP: rounded(stepped),
      downsideStepUp: rounded(downside),
      flatInvested: money(flatPaid), stepUpInvested: money(steppedPaid),
      inflationAdjustedFlat: rounded(flat / factor),
      inflationAdjustedStepUp: rounded(stepped / factor),
      monthlySip: money(annualSip),
      monthlyBudgetSurplus: surplus === null ? null : money(surplus),
    });
  }
  const last = chartData.at(-1);
  const emergencyRequired = monthlyExpenses === null || monthlyEmi === null
    ? null : (monthlyExpenses + monthlyEmi) * emergencyMonths;
  const emergencyStatus = emergencyRequired === null || emergencySavings === null
    ? 'NOT_ASSESSED'
    : emergencySavings >= money(emergencyRequired) ? 'DECLARED_BUFFER_MET' : 'DECLARED_BUFFER_SHORT';
  const budgetStatus = !assessBudget ? 'NOT_ASSESSED'
    : firstUnaffordableMonth === null ? 'WITHIN_DECLARED_BUDGET' : 'OVER_DECLARED_BUDGET';
  const extra = last.stepUpSIP - last.flatSIP;
  const contributedMore = last.stepUpInvested - last.flatInvested;
  const warnings = [];
  if (!assessBudget) warnings.push('AFFORDABILITY_NOT_ASSESSED');
  if (monthlyEmi === null) warnings.push('MONTHLY_EMI_NOT_DECLARED');
  if (firstUnaffordableMonth !== null) warnings.push('STEP_UP_EXCEEDS_DECLARED_BUDGET');
  if (emergencyStatus === 'DECLARED_BUFFER_SHORT') warnings.push('DECLARED_EMERGENCY_BUFFER_SHORT');
  if (emergencyStatus === 'NOT_ASSESSED') warnings.push('EMERGENCY_BUFFER_NOT_ASSESSED');
  warnings.push('PRE_TAX_NOT_A_TAX_ESTIMATE', 'ASSUMED_RETURNS_NOT_GUARANTEED');
  return {
    schema_version: 'sip-plan-v1',
    calculation_classification: 'NON_RECOMMENDATION_STEP_UP_CALCULATION',
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: 'USER_INPUT', return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    observed_market_fact: false, provider_forecast: false,
    monthly_rate_convention: returnRateConvention,
    annual_return_interpretation: returnRateConvention === 'EFFECTIVE_ANNUAL_CAGR'
      ? 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN'
      : 'USER_ASSUMED_NOMINAL_APR',
    contribution_timing: 'START_OF_MONTH',
    capital_gains_tax: null, estimated_post_tax_corpus: null,
    assumptions: { monthlyInvestment, annualReturnRate, annualStepUpRate, years, returnRateConvention,
      inflationRate, downsideAnnualReturnRate, monthlyIncome, monthlyExpenses, monthlyEmi,
      emergencySavings, emergencyMonths, annualIncomeGrowthRate, annualExpenseGrowthRate },
    chartData, flatFinal: last.flatSIP, stepUpFinal: last.stepUpSIP,
    downsideFinal: last.downsideStepUp,
    inflationAdjustedStepUpFinal: last.inflationAdjustedStepUp,
    flatInvested: last.flatInvested, stepUpInvested: last.stepUpInvested,
    additionalCorpus: extra,
    // Compute the percent from unrounded terminal values, never from two
    // separately rounded card totals. If the comparison is too tiny to
    // interpret at INR precision, withhold it instead of displaying 0%.
    additionalPercent: flat >= 0.5 && Number.isFinite(stepped / flat)
      ? ((stepped / flat) - 1) * 100 : null,
    additionalContributions: contributedMore,
    additionalProjectedGrowth: extra - contributedMore,
    flatProjectedGrowth: last.flatSIP - last.flatInvested,
    stepUpProjectedGrowth: last.stepUpSIP - last.stepUpInvested,
    finalMonthlySip: money(lastSip),
    affordability: {
      status: budgetStatus, firstUnaffordableMonth,
      maxMonthlyShortfall: money(maxMonthlyShortfall),
      worstMonthlySurplus: worstMonthlySurplus === null ? null : money(worstMonthlySurplus),
      annualContributionSchedule: chartData.map(row => ({
        year: row.year, monthlySip: row.monthlySip,
        monthlyBudgetSurplus: row.monthlyBudgetSurplus,
      })),
      assumesEmiConstant: true, incomeExpensesUserDeclared: assessBudget,
    },
    emergency_buffer: {
      status: emergencyStatus,
      requiredAmount: emergencyRequired === null ? null : money(emergencyRequired),
      declaredAmount: emergencySavings,
    },
    warnings,
    scenario_interpretation: 'ILLUSTRATIVE_CONSTANT_RETURN_PATHS_NOT_PROBABILITIES',
  };
}
