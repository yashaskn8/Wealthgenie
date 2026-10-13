export const TAX_UNAVAILABLE_NUMERIC_FIELDS = Object.freeze([
  'grossGain',
  'taxableGain',
  'postTaxReturn',
  'effectiveYield',
  'taxRate',
  'incrementalTax',
  'what_if_nominal_gain',
  'what_if_estimated_tax',
  'what_if_net_gain',
]);

const TAX_STATUSES = new Set([
  'CALCULATED',
  'REQUIRES_TAX_INPUTS',
  'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS',
  'MODEL_TAX_CLASS_UNAVAILABLE',
  'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE',
]);

const REQUIRED_PROJECTION_METRICS = [
  'totalInvested',
  'investmentMaturity',
  'investmentReal',
  'benchmarkMaturity',
  'benchmarkReal',
  'estimatedReturns',
  'opportunityCost',
  'purchasingPowerLost',
  'benchmarkRealAnnualRate',
];

const REQUIRED_YEARLY_FIELDS = [
  'invested',
  'investmentNominal',
  'investmentReal',
  'benchmarkNominal',
  'benchmarkReal',
  'gains',
];

const REQUIRED_CHART_FIELDS = ['investment', 'benchmark', 'inflation'];

export function isExplicitFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function sameNumber(actual, expected) {
  return isExplicitFiniteNumber(actual) && isExplicitFiniteNumber(expected) && actual === expected;
}

export function isProjectionInputValid(assumptions) {
  return Boolean(assumptions)
    && isExplicitFiniteNumber(assumptions.monthlyInvestment)
    && assumptions.monthlyInvestment > 0
    && assumptions.monthlyInvestment <= 10000000
    && isExplicitFiniteNumber(assumptions.annualReturnRate)
    && assumptions.annualReturnRate > -1
    && assumptions.annualReturnRate <= 1
    && isExplicitFiniteNumber(assumptions.benchmarkRate)
    && assumptions.benchmarkRate > -1
    && assumptions.benchmarkRate <= 1
    && isExplicitFiniteNumber(assumptions.inflationRate)
    && assumptions.inflationRate >= 0
    && assumptions.inflationRate <= 1
    && Number.isInteger(assumptions.years)
    && assumptions.years >= 1
    && assumptions.years <= 50;
}

export function isProjectionResponseValid(response, expectedAssumptions) {
  if (!response || typeof response !== 'object' || !isProjectionInputValid(expectedAssumptions)) return false;
  if (response.calculation_classification !== 'NON_RECOMMENDATION_PROJECTION_COMPARISON'
    || response.return_basis !== 'PRE_TAX_NOMINAL_WITH_EXPLICIT_INFLATION_VIEW'
    || response.return_data_class !== 'USER_INPUT'
    || response.return_assumption_source !== 'USER_SUPPLIED_WHAT_IF'
    || response.observed_market_fact !== false
    || response.provider_forecast !== false) return false;

  const echoed = response.assumptions;
  if (!echoed || typeof echoed !== 'object') return false;
  for (const key of ['monthlyInvestment', 'annualReturnRate', 'benchmarkRate', 'inflationRate', 'years']) {
    if (!sameNumber(echoed[key], expectedAssumptions[key])) return false;
  }

  if (!REQUIRED_PROJECTION_METRICS.every(key => isExplicitFiniteNumber(response[key]))) return false;
  if (response.inflationHalfLifeYears !== null && !isExplicitFiniteNumber(response.inflationHalfLifeYears)) return false;
  if (expectedAssumptions.inflationRate === 0 && response.inflationHalfLifeYears !== null) return false;
  if (expectedAssumptions.inflationRate > 0
    && (!isExplicitFiniteNumber(response.inflationHalfLifeYears) || response.inflationHalfLifeYears <= 0)) return false;

  const yearly = response.yearlyBreakdown;
  const chart = response.normalizedChart;
  if (!Array.isArray(yearly) || yearly.length !== expectedAssumptions.years
    || !Array.isArray(chart) || chart.length !== expectedAssumptions.years) return false;

  for (let index = 0; index < expectedAssumptions.years; index += 1) {
    const row = yearly[index];
    const point = chart[index];
    if (!row || row.year !== index + 1 || !REQUIRED_YEARLY_FIELDS.every(key => isExplicitFiniteNumber(row[key]))) return false;
    if (!point || point.year !== 'Year ' + (index + 1)
      || !REQUIRED_CHART_FIELDS.every(key => isExplicitFiniteNumber(point[key]))) return false;
  }

  const final = yearly[yearly.length - 1];
  return response.totalInvested === final.invested
    && response.investmentMaturity === final.investmentNominal
    && response.investmentReal === final.investmentReal
    && response.benchmarkMaturity === final.benchmarkNominal
    && response.benchmarkReal === final.benchmarkReal
    && response.estimatedReturns === final.gains
    && response.opportunityCost === response.investmentReal - response.benchmarkReal
    && response.purchasingPowerLost === response.totalInvested - response.benchmarkReal;
}

function sameInputEcho(inputsUsed, key, expected) {
  return Boolean(inputsUsed && hasOwn(inputsUsed, key) && inputsUsed[key] === expected);
}

export function isTaxResponseValid(response, expectedInputs) {
  if (!response || typeof response !== 'object' || !expectedInputs) return false;
  if (response.calculation_classification !== 'SEPARATE_TAX_WHAT_IF'
    || response.calculationClass !== 'MODELLED_POST_TAX_PROJECTION'
    || response.dataClass !== 'MODEL_ASSUMPTION'
    || !TAX_STATUSES.has(response.status)
    || response.what_if_principal !== 100000
    || response.fiscalYear !== expectedInputs.fiscalYear
    || typeof response.policyVersion !== 'string'
    || response.policyVersion.trim() === '') return false;

  const inputs = response.inputsUsed;
  const expectedEchoes = {
    instrumentType: expectedInputs.instrumentType,
    nominalRate: expectedInputs.nominalRate,
    annualIncome: expectedInputs.annualIncome,
    holdingYears: expectedInputs.holdingYears,
    regime: expectedInputs.regime,
    monthlySIP: expectedInputs.monthlySIP,
    userAge: expectedInputs.userAge,
    incomeSource: expectedInputs.incomeSource,
    fiscalYear: expectedInputs.fiscalYear,
    section112AExemptionUsed: expectedInputs.section112AExemptionUsed,
  };
  if (!inputs || typeof inputs !== 'object'
    || !Object.entries(expectedEchoes).every(([key, value]) => sameInputEcho(inputs, key, value))) return false;

  if (!Array.isArray(response.unavailableReasons)
    || response.unavailableReasons.some(reason => typeof reason !== 'string')) return false;

  if (response.status !== 'CALCULATED') {
    return TAX_UNAVAILABLE_NUMERIC_FIELDS.every(key => hasOwn(response, key) && response[key] === null);
  }

  if (response.fiscalYear !== expectedInputs.fiscalYear
    || !isExplicitFiniteNumber(response.postTaxReturn)
    || !isExplicitFiniteNumber(response.effectiveYield)
    || !isExplicitFiniteNumber(response.taxRate)
    || !isExplicitFiniteNumber(response.grossGain)
    || !isExplicitFiniteNumber(response.taxableGain)
    || !isExplicitFiniteNumber(response.incrementalTax)
    || !isExplicitFiniteNumber(response.what_if_nominal_gain)
    || !isExplicitFiniteNumber(response.what_if_estimated_tax)
    || !isExplicitFiniteNumber(response.what_if_net_gain)) return false;

  if (response.taxRate < 0 || response.taxRate > 1
    || response.postTaxReturn < 0 || response.postTaxReturn > expectedInputs.nominalRate
    || response.grossGain < 0 || response.taxableGain < 0
    || response.incrementalTax < 0 || response.what_if_estimated_tax < 0
    || response.what_if_net_gain < 0) return false;

  const expectedNominalGain = Math.round(response.what_if_principal * expectedInputs.nominalRate);
  const expectedNetGain = Math.round(response.what_if_principal * response.postTaxReturn);
  return Math.abs(response.effectiveYield - response.postTaxReturn * 100) <= 0.011
    && response.what_if_nominal_gain === expectedNominalGain
    && response.what_if_net_gain === expectedNetGain
    && response.what_if_estimated_tax === Math.max(0, expectedNominalGain - expectedNetGain);
}

const TAX_REASON_COPY = Object.freeze({
  section112AExemptionUsed: 'Enter how much of the Section 112A exemption you used earlier in this financial year. Enter 0 if none was used.',
  holdingPeriodMonths: 'The holding period is needed before this tax result can be calculated.',
  acquisitionDate: 'The purchase date is needed before this tax result can be calculated.',
  redemptionDate: 'The sale or redemption date is needed before this tax result can be calculated.',
  redemptionChannel: 'The sale or redemption method is needed before this tax result can be calculated.',
  couponRate: 'A verified coupon rate is needed before this tax result can be calculated.',
  annuityFraction: 'The annuity share is needed before this tax result can be calculated.',
  retirementTiming: 'Retirement timing is needed before this tax result can be calculated.',
  TAX_CLASSIFICATION_UNAVAILABLE: 'A qualified tax classification is not available for this investment.',
  TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS: 'More purchase or holding details are required before this tax result can be calculated.',
  PROJECTION_FIELDS_UNAVAILABLE: 'The server could not calculate all required tax details.',
});

export function describeTaxUnavailableResponse(response) {
  const reasons = Array.isArray(response?.unavailableReasons) ? response.unavailableReasons : [];
  const copy = reasons.map(reason => TAX_REASON_COPY[reason]).filter(Boolean);
  if (copy.length) return Array.from(new Set(copy)).join(' ');
  return 'The tax result is unavailable because the required tax classification or verified inputs are missing.';
}
