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
    monthly_rate_convention: 'EFFECTIVE_ANNUAL_CAGR',
    annual_return_interpretation: 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN',
    observed_market_fact: false, provider_forecast: false,
    capital_gains_tax: null, estimated_post_tax_corpus: null,
    flatFinal: 27000, stepUpFinal: 28000,
    flatInvested: 24000, stepUpInvested: 25200,
    additionalCorpus: 1000, additionalContributions: 1200,
    additionalProjectedGrowth: -200, additionalPercent: 3.7,
    downsideFinal: 25200, inflationAdjustedStepUpFinal: 24920,
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
        year: 1, flatSIP: 12400, stepUpSIP: 12400,
        flatInvested: 12000, stepUpInvested: 12000,
        downsideStepUp: 12000, inflationAdjustedStepUp: 11700,
        monthlySip: 1000, monthlyBudgetSurplus: 8000,
      },
      {
        year: 2, flatSIP: 27000, stepUpSIP: 28000,
        flatInvested: 24000, stepUpInvested: 25200,
        downsideStepUp: 25200, inflationAdjustedStepUp: 24920,
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
    ['missing CAGR interpretation', r => { delete r.annual_return_interpretation; }],
    ['market data impersonation', r => { r.observed_market_fact = true; }],
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
