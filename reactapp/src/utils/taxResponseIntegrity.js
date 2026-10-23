const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

function echoesExpectedFields(actual, expected) {
  return isRecord(actual) && Object.entries(expected).every(([key, value]) => (
    value === undefined || actual[key] === value
  ));
}

function echoesExactExpectedFields(actual, expected) {
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every(key => Object.prototype.hasOwnProperty.call(actual, key) && actual[key] === expected[key]);
}

const TAX_COMPARISON_ZERO_DEFAULTS = new Set([
  'section80C', 'nps80CCD1B', 'nps80CCD2', 'section80D',
  'hra', 'homeLoanInterest', 'section80EEA', 'savingsInterest', 'section80TTA', 'section80TTB',
]);

function echoesTaxComparisonDeductions(actual, expected) {
  if (!isRecord(actual) || !isRecord(expected)) return false;
  if (!Object.entries(expected).every(([key, value]) => value === undefined || actual[key] === value)) return false;
  return Object.entries(actual).every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(expected, key)
    || (TAX_COMPARISON_ZERO_DEFAULTS.has(key) && value === 0)
  ));
}

function echoesExpectedInstrumentList(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((instrument, index) => {
    const echoed = actual[index];
    if (!isRecord(echoed) || !isRecord(instrument)) return false;
    const expectedKeys = Object.keys(instrument).sort();
    const echoedKeys = Object.keys(echoed).sort();
    return expectedKeys.length === echoedKeys.length
      && expectedKeys.every((key, keyIndex) => key === echoedKeys[keyIndex] && echoed[key] === instrument[key]);
  });
}

function echoesExpectedResultRows(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((instrument, index) => {
    const row = actual[index];
    return isRecord(row)
      && row.instrumentIndex === index
      && (instrument.instrumentId === undefined || (
        row.instrumentId === instrument.instrumentId
        && row.exactProductReturnVerified === false
      ))
      && row.exactProductReturnVerified !== true
      && echoesExactExpectedFields(row.instrumentInput, instrument);
  });
}

function hasValidTaxSlabBreakdown(rows, regime) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const totalIndexes = rows.flatMap((row, index) => (row?.isTotalRow === true ? [index] : []));
  if (totalIndexes.length !== 1 || totalIndexes[0] !== rows.length - 1) return false;

  const total = rows[totalIndexes[0]];
  if (!isRecord(total)
      || typeof total.label !== 'string' || total.label.length === 0
      || total.rate !== ''
      || !isFiniteNumber(total.taxableInSlab)
      || total.taxableInSlab !== Math.round(regime.taxable_income)
      || !isFiniteNumber(total.taxInSlab)
      || total.taxInSlab !== regime.tax) return false;

  let rebateRows = 0;
  for (const row of rows.slice(0, -1)) {
    if (!isRecord(row) || typeof row.label !== 'string' || row.label.length === 0
        || !isFiniteNumber(row.taxableInSlab) || !isFiniteNumber(row.taxInSlab)) return false;
    if (row.isTotalRow === true) return false;
    if (row.isRebateRow === true) {
      rebateRows += 1;
      if (row.rate !== '' || row.taxableInSlab !== 0 || row.taxInSlab > 0) return false;
    } else if (!isFiniteNumber(row.rate) || row.rate < 0 || row.rate > 100
        || row.taxableInSlab <= 0 || row.taxInSlab < 0) {
      return false;
    }
  }
  return rebateRows <= 1;
}

function fail(message) {
  throw new TypeError(message);
}

export function assertTaxComparisonResponse(response, expected) {
  if (!isRecord(response)
      || response.verified !== true
      || response.fiscal_year !== expected.fiscalYear
      || response.income !== expected.annualIncome
      || typeof response.policyVersion !== 'string'
      || response.policyVersion.length === 0
      || response.calculation_classification !== 'SEPARATE_TAX_WHAT_IF') {
    fail('The tax service returned a result for a different or unverified tax request.');
  }

  const expectedContext = {
    annualIncome: expected.annualIncome,
    incomeSource: expected.incomeSource,
    fiscalYear: expected.fiscalYear,
  };
  const mismatchedContext = Object.entries(expectedContext)
    .filter(([key, value]) => response.inputsUsed?.[key] !== value).map(([key]) => key);
  if (!isRecord(response.inputsUsed?.deductions)
      || mismatchedContext.length > 0
      || !echoesTaxComparisonDeductions(response.inputsUsed.deductions, expected.deductions)) {
    const mismatched = [...mismatchedContext];
    fail(`The tax service did not confirm the submitted input fields: ${mismatched.join(', ') || 'deductions'}.`);
  }

  const regimes = [response.new_regime, response.old_regime];
  const numericRegimeFields = ['tax', 'effective_rate', 'taxable_income', 'standard_deduction', 'cess', 'nps80CCD2', 'allowed80D'];
  if (regimes.some(regime => !isRecord(regime)
      || numericRegimeFields.some(field => !isFiniteNumber(regime[field]))
      || typeof regime.rebate_applied !== 'boolean'
      || typeof regime.marginal_relief_applied !== 'boolean'
      || !isFiniteNumber(regime.marginal_relief_amount)
      || (regime === response.old_regime
        && (!isFiniteNumber(regime.old_regime_deductions) || regime.old_regime_deductions < 0))
      || !hasValidTaxSlabBreakdown(regime.slab_breakdown, regime))) {
    fail('The tax service returned an incomplete regime comparison.');
  }

  const expectedRecommendation = response.new_regime.tax <= response.old_regime.tax ? 'new' : 'old';
  const expectedSaving = Math.abs(response.new_regime.tax - response.old_regime.tax);
  if (!['new', 'old'].includes(response.recommended_regime)
      || response.recommended_regime !== expectedRecommendation
      || response.saving_with !== expectedRecommendation
      || !isFiniteNumber(response.saving) || Math.abs(response.saving - expectedSaving) > 0.01
      || !isFiniteNumber(response.saving_pct)
      || !isFiniteNumber(response.optimized_old_regime_tax)
      || !isFiniteNumber(response.potential_tax_saving)
      || !(response.crossover_breakpoint === null || isFiniteNumber(response.crossover_breakpoint))
      || !isRecord(response.deduction_limits)
      || !isRecord(response.remaining_deductions)) {
    fail('The tax service returned an inconsistent regime comparison.');
  }
}

export function assertPostTaxBatchResponse(response, expected) {
  const echoedInputs = {
    annualIncome: expected.annualIncome,
    incomeSource: expected.incomeSource,
    regime: expected.regime,
    userAge: expected.userAge,
    inflationRate: expected.inflationRate,
    fiscalYear: expected.fiscalYear,
  };
  if (!isRecord(response)
      || response.verified !== true
      || response.fiscalYear !== expected.fiscalYear
      || typeof response.policyVersion !== 'string'
      || response.policyVersion.length === 0
      || response.calculation_classification !== 'SEPARATE_TAX_WHAT_IF'
      || !echoesExpectedFields(response.inputsUsed, echoedInputs)
      || !echoesExpectedInstrumentList(response.inputsUsed?.instruments, expected.instruments)
      || !echoesExactExpectedFields(response.inputsUsed?.deductions, expected.deductions || {})
      || !echoesExpectedResultRows(response.results, expected.instruments)
      || !echoesExpectedFields(response.assumptions, echoedInputs)
      || !echoesExactExpectedFields(response.assumptions?.deductions, expected.deductions || {})
      || response.inputsUsed?.section112AExemptionUsed !== (expected.section112AExemptionUsed ?? null)) {
    fail('The tax service returned a result for a different or unverified tax request.');
  }
}

export function assertPostTaxBatchSummary(response) {
  const summary = response?.summary;
  const metrics = [
    'totalTaxDrag', 'keptPerThousand', 'erodedPerThousand',
    'retentionEfficiencyPercent', 'maxTaxRate',
  ];
  if (!isRecord(summary) || !Array.isArray(response?.results)) {
    fail('The tax service returned an incomplete portfolio summary.');
  }

  const calculatedRows = response.results.filter(row => row?.status === 'CALCULATED');
  if (calculatedRows.length === 0) {
    if (metrics.some(metric => summary[metric] !== null)) {
      fail('Unavailable tax summaries must remain null.');
    }
    return;
  }

  const rowFields = ['taxDragWealth', 'totalInvested', 'nominalFutureValue', 'postTaxFutureValue', 'taxRate'];
  if (calculatedRows.some(row => rowFields.some(field => !isFiniteNumber(row[field])))) {
    fail('Calculated tax rows are missing fields required to validate the portfolio summary.');
  }

  const totalTaxDrag = calculatedRows.reduce((sum, row) => sum + row.taxDragWealth, 0);
  const grossProfit = calculatedRows.reduce((sum, row) => (
    sum + Math.max(0, row.nominalFutureValue - row.totalInvested)
  ), 0);
  const retainedProfit = calculatedRows.reduce((sum, row) => (
    sum + Math.max(0, row.postTaxFutureValue - row.totalInvested)
  ), 0);
  const keptPerThousand = grossProfit > 0
    ? Math.max(0, Math.min(1000, Math.round((retainedProfit / grossProfit) * 1000)))
    : 1000;
  const expected = {
    totalTaxDrag,
    keptPerThousand,
    erodedPerThousand: 1000 - keptPerThousand,
    retentionEfficiencyPercent: keptPerThousand / 10,
    maxTaxRate: calculatedRows.reduce((max, row) => Math.max(max, row.taxRate || 0), 0),
  };

  if (metrics.some(metric => !isFiniteNumber(summary[metric]) || summary[metric] !== expected[metric])) {
    fail('The tax service returned a portfolio summary inconsistent with its calculated rows.');
  }
}

const USER_DECLARED_SCENARIO_STATUSES = new Set([
  'CALCULATED',
  'UNAVAILABLE',
  'TAX_CLASSIFICATION_UNAVAILABLE',
  'FISCAL_YEAR_UNSUPPORTED',
]);
const USER_DECLARED_NULL_FY_STATUSES = new Set([
  'TAX_CLASSIFICATION_UNAVAILABLE',
  'FISCAL_YEAR_UNSUPPORTED',
]);
const USER_DECLARED_FINANCIAL_FIELDS = [
  'grossGain', 'taxableGain', 'exemptionApplied', 'incrementalTax', 'cess',
  'surcharge', 'netGain', 'postTaxRatePct', 'transactionGainPct',
];
const EQUITY_SCENARIO_TAX_CLASSES = new Set([
  'EQUITY_STCG_SECTION_111A',
  'EQUITY_LTCG_SECTION_112A',
]);
const DECLARED_PRODUCT_TAX_CLASSES = Object.freeze({
  fd: 'BANK_DEPOSIT_INTEREST',
  sbi_fd: 'BANK_DEPOSIT_INTEREST',
  rbi_bonds: 'RBI_FRSB_INTEREST',
  sgb: 'SGB_CONDITIONAL_MATURITY_TREATMENT',
  nifty_etf: 'EQUITY_MF_SECTION_112A',
});

function isFiniteOrNull(value) {
  return value === null || isFiniteNumber(value);
}

function amountsMatch(actual, expected) {
  return Math.abs(actual - expected) <= 0.005;
}

function hasValidDeclaredHoldingPeriod(holdingPeriod, expected) {
  return isRecord(holdingPeriod)
    && holdingPeriod.acquisitionDate === expected.acquisitionDate
    && holdingPeriod.redemptionDate === expected.redemptionDate
    && holdingPeriod.holdingPeriodBasis === 'EXACT_TRANSACTION_DATES'
    && holdingPeriod.basis === 'EXACT_USER_DECLARED_TRANSACTION_DATES'
    && typeof holdingPeriod.isLongTerm === 'boolean'
    && Number.isInteger(holdingPeriod.thresholdMonths)
    && holdingPeriod.thresholdMonths > 0
    && Number.isInteger(holdingPeriod.holdingDays)
    && holdingPeriod.holdingDays >= 0
    && typeof holdingPeriod.thresholdDate === 'string';
}

/**
 * Verify the user-declared scenario contract before presenting any amount.
 * An unavailable result may carry partial, explicitly nullable evidence, but
 * a calculated result must include coherent scenario-specific amounts.
 */
export function assertUserDeclaredScenarioResponse(response, expected) {
  if (!isRecord(expected)
      || !isRecord(response)
      || !echoesExactExpectedFields(response.inputsUsed, expected)
      || !USER_DECLARED_SCENARIO_STATUSES.has(response.status)
      || response.calculationClass !== 'TRANSACTION_TAX_ESTIMATE'
      || response.dataClass !== 'USER_DECLARED_TRANSACTION'
      || response.inputBasis !== 'USER_DECLARED_SCENARIO'
      || response.canonicalInstrumentId !== expected.canonicalInstrumentId
      || response.canonicalProductId !== (expected.canonicalProductId ?? null)
      || !isRecord(response.taxClassificationMetadata)
      || typeof response.taxClassificationMetadata.sourceQualified !== 'boolean'
      || !Array.isArray(response.unavailableReasons)
      || response.unavailableReasons.some(reason => typeof reason !== 'string' || reason.length === 0)
      || !Array.isArray(response.sourceReferences)
      || !Array.isArray(response.assumptions)
      || typeof response.disclosure !== 'string'
      || response.disclosure.trim().length === 0) {
    fail('The tax service returned an incomplete or mismatched user-declared scenario.');
  }

  const hasFiscalYear = typeof response.fiscalYear === 'string' && response.fiscalYear.length > 0;
  if (hasFiscalYear) {
    if (response.fiscalYear !== expected.fiscalYear
        || typeof response.policyVersion !== 'string'
        || response.policyVersion.length === 0) {
      fail('The tax service returned scenario metadata for a different fiscal year or policy.');
    }
  } else if (response.fiscalYear !== null
      || response.policyVersion !== null
      || !USER_DECLARED_NULL_FY_STATUSES.has(response.status)) {
    fail('The tax service returned invalid fiscal-year metadata for the scenario.');
  }

  const metadataTaxClass = response.taxClassificationMetadata.taxClass;
  if (response.taxClassificationMetadata.sourceQualified) {
    if (typeof metadataTaxClass !== 'string' || metadataTaxClass.length === 0
        || metadataTaxClass !== DECLARED_PRODUCT_TAX_CLASSES[expected.canonicalInstrumentId]
        || typeof response.taxClass !== 'string' || response.taxClass.length === 0) {
      fail('The tax service returned incomplete source-qualified product tax metadata.');
    }
    if (expected.scenarioType === 'INTEREST_INCOME' && response.taxClass !== metadataTaxClass) {
      fail('The tax service returned a tax class inconsistent with the qualified interest product.');
    }
    if (expected.scenarioType === 'EQUITY_REALIZED_GAIN'
        && response.status === 'CALCULATED'
        && (!EQUITY_SCENARIO_TAX_CLASSES.has(response.taxClass)
          || metadataTaxClass !== 'EQUITY_MF_SECTION_112A')) {
      fail('The tax service returned an unrecognized equity tax classification.');
    }
    if (expected.scenarioType === 'EQUITY_REALIZED_GAIN'
        && response.status !== 'CALCULATED'
        && response.taxClass !== metadataTaxClass) {
      fail('The tax service returned equity metadata inconsistent with the qualified product class.');
    }
  } else if (response.status !== 'TAX_CLASSIFICATION_UNAVAILABLE'
      || metadataTaxClass !== null
      || response.taxClass !== null) {
    fail('The tax service returned a tax class without qualified classification metadata.');
  }

  for (const field of USER_DECLARED_FINANCIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(response, field) && !isFiniteOrNull(response[field])) {
      fail(`The tax service returned an invalid ${field} amount.`);
    }
  }
  const requiredNullableAmounts = ['grossGain', 'taxableGain', 'incrementalTax', 'cess', 'surcharge', 'netGain'];
  if (requiredNullableAmounts.some(field => !Object.prototype.hasOwnProperty.call(response, field)
      || !isFiniteOrNull(response[field]))) {
    fail('The tax service returned malformed financial amounts for the declared scenario.');
  }

  if (response.status !== 'CALCULATED') {
    if (response.unavailableReasons.length === 0) {
      fail('The tax service did not explain why the scenario result is unavailable.');
    }
    if (response.grossGain !== null) {
      const expectedGrossGain = expected.scenarioType === 'INTEREST_INCOME'
        ? expected.interestReceived
        : expected.saleProceeds - expected.acquisitionCostBasis;
      if (!isFiniteNumber(expectedGrossGain) || !amountsMatch(response.grossGain, expectedGrossGain)) {
        fail('The tax service returned a gross amount inconsistent with the declared scenario.');
      }
    }
    if (response.taxableGain !== null && response.taxableGain < 0) {
      fail('The tax service returned a negative taxable amount for an unavailable scenario.');
    }
    return;
  }

  if (!response.taxClassificationMetadata.sourceQualified
      || !hasFiscalYear
      || response.unavailableReasons.length !== 0
      || ['grossGain', 'taxableGain', 'exemptionApplied', 'incrementalTax', 'cess', 'surcharge', 'netGain']
        .some(field => !isFiniteNumber(response[field]) || response[field] < 0)) {
    fail('The tax service returned incomplete calculated scenario amounts.');
  }

  const expectedGrossGain = expected.scenarioType === 'INTEREST_INCOME'
    ? expected.interestReceived
    : expected.saleProceeds - expected.acquisitionCostBasis;
  if (!isFiniteNumber(expectedGrossGain)
      || !amountsMatch(response.grossGain, expectedGrossGain)
      || response.taxableGain > response.grossGain
      || !amountsMatch(response.netGain, response.grossGain - response.incrementalTax)) {
    fail('The tax service returned amounts inconsistent with the declared scenario.');
  }

  if (expected.scenarioType === 'INTEREST_INCOME') {
    if (response.taxableGain !== response.grossGain
        || response.exemptionApplied !== 0
        || response.postTaxRatePct !== null
        || response.transactionGainPct !== null
        || response.holdingPeriod !== null) {
      fail('The tax service returned invalid interest scenario fields.');
    }
    return;
  }

  if (expected.scenarioType !== 'EQUITY_REALIZED_GAIN'
      || !hasValidDeclaredHoldingPeriod(response.holdingPeriod, expected)
      || !isFiniteNumber(response.transactionGainPct)
      || !amountsMatch(
        response.transactionGainPct,
        Number(((response.netGain / expected.acquisitionCostBasis) * 100).toFixed(2)),
      )) {
    fail('The tax service returned invalid equity scenario fields.');
  }
}
