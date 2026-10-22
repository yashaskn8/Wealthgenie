import { describe, expect, it } from 'vitest';
import { assertGrowSipResponse } from './growSipResponse';

const input = Object.freeze({
  monthlyInvestment: 1000, annualReturnRate: 0.08, annualStepUpRate: 0.1,
  years: 2, returnRateConvention: 'EFFECTIVE_ANNUAL_CAGR',
  inflationRate: 0.06, downsideAnnualReturnRate: 0,
  annualIncomeGrowthRate: 0, annualExpenseGrowthRate: 0.06,
  monthlyIncome: 30000, monthlyExpenses: 18000, monthlyEmi: 3000,
  emergencySavings: 200000,
});

function validFixture() {
  return {
    schema_version: 'sip-plan-v1',
    calculation_classification: 'NON_RECOMMENDATION_STEP_UP_CALCULATION',
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: 'USER_INPUT',
    return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    contribution_timing: 'START_OF_MONTH',
    scenario_interpretation: 'ILLUSTRATIVE_CONSTANT_RETURN_PATHS_NOT_PROBABILITIES',
    warnings: ['PRE_TAX_NOT_A_TAX_ESTIMATE', 'ASSUMED_RETURNS_NOT_GUARANTEED'],
    monthly_rate_convention: 'EFFECTIVE_ANNUAL_CAGR',
    annual_return_interpretation: 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN',
    observed_market_fact: false, provider_forecast: false,
    capital_gains_tax: null, estimated_post_tax_corpus: null,
    flatFinal: 26029, stepUpFinal: 27280,
    flatInvested: 24000, stepUpInvested: 25200,
    additionalCorpus: 1251, additionalContributions: 1200,
    additionalProjectedGrowth: 51, additionalPercent: 4.807692307692313,
    flatProjectedGrowth: 2029, stepUpProjectedGrowth: 2080,
    downsideFinal: 25200, inflationAdjustedStepUpFinal: 24279,
    finalMonthlySip: 1100,
    affordability: {
      status: 'WITHIN_DECLARED_BUDGET', firstUnaffordableMonth: null,
      maxMonthlyShortfall: 0,
    },
    emergency_buffer: {
      status: 'DECLARED_BUFFER_MET', requiredAmount: 126000,
      declaredAmount: 200000,
    },
    chartData: [
      {
        year: 1, flatSIP: 12514, stepUpSIP: 12514,
        flatInvested: 12000, stepUpInvested: 12000,
        downsideStepUp: 12000, inflationAdjustedFlat: 11806, inflationAdjustedStepUp: 11806,
        monthlySip: 1000, monthlyBudgetSurplus: 8000,
      },
      {
        year: 2, flatSIP: 26029, stepUpSIP: 27280,
        flatInvested: 24000, stepUpInvested: 25200,
        downsideStepUp: 25200, inflationAdjustedFlat: 23166, inflationAdjustedStepUp: 24279,
        monthlySip: 1100, monthlyBudgetSurplus: 6820,
      },
    ],
    assumptions: {
      ...input, emergencyMonths: 6,
    },
  };
}

describe('Grow My SIP fail-closed response contract', () => {
  it('accepts a complete explicitly-CAGR scenario with financial provenance', () => {
    const fixture = validFixture();
    expect(assertGrowSipResponse(fixture, input)).toBe(fixture);
  });

  it.each([
    ['missing object', r => Object.assign(r, { schema_version: null })],
    ['wrong APR convention', r => { r.monthly_rate_convention = 'NOMINAL_APR_DIVIDED_BY_12'; }],
    ['false post-tax basis', r => { r.return_basis = 'POST_TAX'; }],
    ['false investment recommendation label', r => { r.calculation_classification = 'ADVISORY_RECOMMENDATION'; }],
    ['invented market data authority', r => { r.return_data_class = 'LIVE'; }],
    ['missing non-guarantee warning', r => { r.warnings = ['PRE_TAX_NOT_A_TAX_ESTIMATE']; }],
    ['missing CAGR interpretation', r => { delete r.annual_return_interpretation; }],
    ['market data impersonation', r => { r.observed_market_fact = true; }],
    ['doubled all projected balances (coherent forged chart)', r => {
      for (const row of r.chartData) {
        row.flatSIP *= 2; row.stepUpSIP *= 2; row.downsideStepUp *= 2;
        row.inflationAdjustedFlat *= 2; row.inflationAdjustedStepUp *= 2;
      }
      r.flatFinal *= 2; r.stepUpFinal *= 2; r.downsideFinal *= 2;
      r.inflationAdjustedStepUpFinal *= 2; r.additionalCorpus *= 2;
      r.additionalProjectedGrowth = r.additionalCorpus - r.additionalContributions;
    }],
    ['forged intermediate-year compounding', r => { r.chartData[0].flatSIP += 500; }],
    ['inflated uplift percentage', r => { r.additionalPercent *= 10; }],
    ['invented post-tax corpus', r => { r.estimated_post_tax_corpus = 1; }],
    ['non-finite result', r => { r.flatFinal = Infinity; }],
    ['negative principal', r => { r.stepUpInvested = -1; }],
    ['inconsistent uplift', r => { r.additionalCorpus += 100; }],
    ['fake zero growth', r => { r.additionalProjectedGrowth = 0; }],
    ['mismatched year count', r => { r.chartData.pop(); }],
    ['out of order timeline', r => { r.chartData[0].year = 5; }],
    ['chart-last-value collision', r => { r.chartData[1].flatSIP += 100; }],
    ['unknown budget status', r => { r.affordability.status = 'OK'; }],
    ['missing EMI lineage', r => { r.assumptions.monthlyEmi = null; }],
    ['wrong inflation assumption', r => { r.assumptions.inflationRate = 0.03; }],
    ['mismatched emergency reserve', r => { r.assumptions.emergencySavings = 90000; }],
    ['fabricated buffer threshold', r => { r.emergency_buffer.requiredAmount = 0; }],
    ['fabricated buffer status', r => { r.emergency_buffer.status = 'DECLARED_BUFFER_SHORT'; }],
    ['forged middle-year deposited principal', r => { r.chartData[0].stepUpInvested = 99999; }],
    ['hidden shortfall with positive budget status', r => { r.chartData[1].monthlyBudgetSurplus = -500; }],
    ['incorrect but plausible surplus', r => { r.chartData[1].monthlyBudgetSurplus = 6821; }],
    ['wrong maximum shortfall', r => { r.affordability.maxMonthlyShortfall = 250; }],
    ['first failed month on affordable projection', r => { r.affordability.firstUnaffordableMonth = 4; }],
  ])('blocks %s', (_label, alter) => {
    const corrupted = validFixture();
    alter(corrupted);
    expect(() => assertGrowSipResponse(corrupted, input)).toThrow(
      /invalid or incompatible financial projection/,
    );
  });

  it('never accepts a reassuring budget status without entered EMI and expenses', () => {
    const withoutEmi = { ...input };
    delete withoutEmi.monthlyEmi;
    const corrupted = validFixture();
    corrupted.assumptions.monthlyEmi = null;
    expect(() => assertGrowSipResponse(corrupted, withoutEmi)).toThrow(
      /invalid or incompatible financial projection/,
    );
  });

  it('never accepts emergency-buffer clearance without declared liquid savings', () => {
    const withoutReserve = { ...input };
    delete withoutReserve.emergencySavings;
    const corrupted = validFixture();
    corrupted.assumptions.emergencySavings = null;
    expect(() => assertGrowSipResponse(corrupted, withoutReserve)).toThrow(
      /invalid or incompatible financial projection/,
    );
  });
});

describe('signed decimal-paise affordability reconciliation', () => {
  it('accepts correctly rounded negative half-paisa deficits and rejects a one-paisa understatement', () => {
    const signedInput = {
      ...input, monthlyIncome: 0, monthlyExpenses: 100001,
      monthlyEmi: 0, annualExpenseGrowthRate: 0.125,
    };
    const fixture = validFixture();
    fixture.assumptions = { ...fixture.assumptions, ...signedInput };
    fixture.chartData[0].monthlyBudgetSurplus = -101001;
    fixture.chartData[1].monthlyBudgetSurplus = -113601.13;
    fixture.affordability = {
      status: 'OVER_DECLARED_BUDGET',
      firstUnaffordableMonth: 1,
      maxMonthlyShortfall: 113601.13,
    };
    fixture.emergency_buffer = {
      status: 'DECLARED_BUFFER_SHORT',
      requiredAmount: 600006,
      declaredAmount: 200000,
    };
    expect(assertGrowSipResponse(fixture, signedInput)).toBe(fixture);
    fixture.chartData[1].monthlyBudgetSurplus = -113601.12;
    expect(() => assertGrowSipResponse(fixture, signedInput)).toThrow(
      /invalid or incompatible financial projection/,
    );
  });
});
