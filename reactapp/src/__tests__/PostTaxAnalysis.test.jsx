/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PostTaxAnalysis from '../PostTaxAnalysis';
import * as apiModule from '../services/api';
import { assertPostTaxBatchResponse, assertPostTaxBatchSummary, assertTaxComparisonResponse } from '../utils/taxResponseIntegrity';

vi.mock('../services/api', () => ({
  computePostTaxReturnBatch: vi.fn(),
  getTaxPolicyMetadata: vi.fn(async () => ({
    currentFiscalYear: 'FY2026-27',
    currentFiscalYearVerified: true,
    verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
  })),
}));

const demoProfile = { profileId: 'profile-a', version: 1, age: 30, investment_horizon_years: 3 };
const demoRecommendations = [{ id: 'fd', name: 'Fixed Deposit', type: 'FD', nominalReturn: 7, monthly_allocation: 10000 }];
const calculatedSipReturnMetrics = {
  basis: 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE',
  status: 'CALCULATED',
  unavailableReason: null,
  preTaxAnnualizedReturnPercent: 7.25,
  postTaxAnnualizedReturnPercent: 7,
  realPostTaxAnnualizedReturnPercent: 0.9434,
  taxDragAnnualizedPercentagePoints: 0.25,
};
const unavailableSipReturnMetrics = (unavailableReason = 'PROJECTION_UNAVAILABLE') => ({
  basis: 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE',
  status: 'UNAVAILABLE',
  unavailableReason,
  preTaxAnnualizedReturnPercent: null,
  postTaxAnnualizedReturnPercent: null,
  realPostTaxAnnualizedReturnPercent: null,
  taxDragAnnualizedPercentagePoints: null,
});
const fdInstrumentInput = { instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000 };
const etfInstrumentInput = { ...fdInstrumentInput, instrumentType: 'ETF' };
const calculated = {
  calculation_classification: 'SEPARATE_TAX_WHAT_IF',
  fiscalYear: 'FY2026-27',
  policyVersion: 'tax-policy-FY2026-27-v2',
  verified: true,
  inputsUsed: {
    annualIncome: 1000000, incomeSource: 'salary', regime: 'new', userAge: 30,
    inflationRate: 0.06, fiscalYear: 'FY2026-27', section112AExemptionUsed: null,
    instruments: [fdInstrumentInput],
    deductions: {},
  },
  portfolioStatus: 'COMPLETE',
  assumptions: {
    annualIncome: 1000000, incomeSource: 'salary', regime: 'new', userAge: 30,
    inflationRate: 0.06, fiscalYear: 'FY2026-27', deductions: {},
  },
  results: [{ instrumentIndex: 0, instrumentInput: fdInstrumentInput, instrumentType: 'FD', status: 'CALCULATED', taxType: 'Slab Rate', nominalReturnPercent: 7,
    postTaxReturnPercent: 0, realReturnPercent: -5.66, effectiveTaxPercent: 0, taxRate: 0,
    postTaxGain: 0, taxDragWealth: 123456.7, taxDragCAGR: 0.025, totalInvested: 360000,
    nominalFutureValue: 400000, postTaxFutureValue: 360000,
    sipReturnMetrics: calculatedSipReturnMetrics }],
  summary: { totalTaxDrag: 123456.7, keptPerThousand: 0, erodedPerThousand: 1000, retentionEfficiencyPercent: 0, maxTaxRate: 0 },
};
async function explicitInputs() {
  await waitFor(() => expect(screen.getByLabelText(/Fiscal year/i).value).toBe('FY2026-27'));
  fireEvent.change(screen.getByLabelText(/Gross annual income before allowed deductions/i), { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText(/Tax regime/i), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText('Your age on March 31'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '6' } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: /calculate explicit tax what-if/i }));

describe('PostTaxAnalysis separate tax what-if', () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); });

  it('rejects selected-year ages outside the supported 18-to-120 range', async () => {
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs();
    const form = screen.getByRole('button', { name: /calculate explicit tax what-if/i }).closest('form');

    for (const age of ['17', '121']) {
      fireEvent.change(screen.getByLabelText('Your age on March 31'), { target: { value: age } });
      // Submit the form event directly so browser-native min/max validation
      // does not prevent exercising the component's server-boundary guard.
      fireEvent.submit(form);
      expect(await screen.findByRole('alert')).toHaveTextContent(/valid age for the selected fiscal year/i);
      expect(apiModule.computePostTaxReturnBatch).not.toHaveBeenCalled();
    }
  });
  it('renders every server metric exactly, including zero, negative real return and Indian grouping', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue(calculated);
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    const row = within(await screen.findByTestId('post-tax-row-fd'));
    expect(row.getByTestId('nominal-return')).toHaveTextContent('7.0%');
    expect(row.getByTestId('pre-tax-sip-return')).toHaveTextContent('7.3%');
    expect(row.getByTestId('post-tax-return')).toHaveTextContent('7.0%');
    expect(row.getByTestId('real-return')).toHaveTextContent('+0.9%');
    expect(row.getByTestId('post-tax-gain')).toHaveTextContent('₹0');
    expect(row.getByTestId('total-invested')).toHaveTextContent('₹3,60,000');
    expect(row.getByTestId('effective-tax')).toHaveTextContent('0.0%');
    expect(row.getByTestId('tax-drag-wealth')).toHaveTextContent('₹1,23,457');
    expect(row.getByTestId('tax-drag-cagr')).toHaveTextContent('0.25 pp');
  });

  it('rejects swapped response rows for same-type instruments even when echoed inputs remain ordered', async () => {
    const recommendations = [
      demoRecommendations[0],
      { ...demoRecommendations[0], id: 'fd-second', name: 'Second Fixed Deposit', nominalReturn: 8, monthly_allocation: 20000 },
    ];
    const requestInstruments = [
      { instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000 },
      { instrumentType: 'FD', nominalRate: 0.08, holdingYears: 3, monthlySIP: 20000 },
    ];
    const firstRow = { ...calculated.results[0], instrumentIndex: 0, instrumentInput: requestInstruments[0], postTaxReturnPercent: 1, postTaxGain: 111 };
    const secondRow = { ...calculated.results[0], instrumentIndex: 1, instrumentInput: requestInstruments[1], postTaxReturnPercent: 9, postTaxGain: 999 };
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: { ...calculated.inputsUsed, instruments: requestInstruments },
      results: [
        { ...secondRow, instrumentIndex: 0 },
        { ...firstRow, instrumentIndex: 1 },
      ],
    });

    render(<PostTaxAnalysis profile={demoProfile} recommendations={recommendations} />);
    await explicitInputs(); submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/different or unverified tax request/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
    expect(screen.queryByTestId('post-tax-row-fd-second')).toBeNull();
  });

  it('renders an exact-zero real return neutrally without an up or down icon', async () => {
    const zeroRealReturn = structuredClone(calculated);
    zeroRealReturn.results[0].realReturnPercent = 0;
    zeroRealReturn.results[0].sipReturnMetrics.realPostTaxAnnualizedReturnPercent = 0;
    apiModule.computePostTaxReturnBatch.mockResolvedValue(zeroRealReturn);
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    const row = within(await screen.findByTestId('post-tax-row-fd'));
    const realReturn = row.getByTestId('real-return');
    expect(realReturn).toHaveTextContent('0.0%');
    expect(realReturn).toHaveClass('pta-td--dim');
    expect(realReturn).not.toHaveClass('pta-td--green');
    expect(realReturn).not.toHaveClass('pta-td--rose');
    expect(realReturn.querySelector('svg')).toBeNull();
  });

  it('hides persisted calculations immediately when tax inputs or the allocation identity change', async () => {
    apiModule.computePostTaxReturnBatch
      .mockResolvedValueOnce(calculated)
      .mockResolvedValueOnce({
        ...calculated,
        inputsUsed: { ...calculated.inputsUsed, inflationRate: 0.07 },
        assumptions: { ...calculated.assumptions, inflationRate: 0.07 },
      });
    const view = render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} recommendationMeta={{ recommendationId: 'r1' }} />);
    await explicitInputs(); submit();
    await screen.findByTestId('post-tax-row-fd');
    fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '7' } });
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
    expect(screen.getByText(/Recalculate this result before using it/i)).toBeVisible();
    submit(); await screen.findByTestId('post-tax-row-fd');
    view.rerender(<PostTaxAnalysis profile={{ ...demoProfile, version: 2 }} recommendations={demoRecommendations} recommendationMeta={{ recommendationId: 'r2' }} />);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
    expect(apiModule.computePostTaxReturnBatch).toHaveBeenCalledTimes(2);
  });

  it('ignores a late result for the old profile even when the transport ignores abort', async () => {
    let resolve;
    apiModule.computePostTaxReturnBatch.mockReturnValue(new Promise(done => { resolve = done; }));
    const view = render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    const signal = apiModule.computePostTaxReturnBatch.mock.calls[0][7].signal;
    view.rerender(<PostTaxAnalysis profile={{ ...demoProfile, profileId: 'profile-b' }} recommendations={demoRecommendations} />);
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(calculated));
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
    expect(screen.queryByText('₹1,23,457')).toBeNull();
  });

  it('never sends a null nominal-return fact to the backend as zero', async () => {
    render(<PostTaxAnalysis profile={demoProfile} recommendations={[{ ...demoRecommendations[0], nominalReturn: null }]} />);
    await explicitInputs(); submit();
    expect(apiModule.computePostTaxReturnBatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/missing required return or allocation facts/i);
  });

  it('keeps partial results explicit and rejects an incomplete calculated row', async () => {
    const unavailable = { instrumentIndex: 1, instrumentInput: { ...fdInstrumentInput }, instrumentType: 'FD', status: 'MODEL_TAX_CLASS_UNAVAILABLE', nominalReturnPercent: 7, postTaxReturnPercent: null, realReturnPercent: null, totalInvested: 360000,
      sipReturnMetrics: unavailableSipReturnMetrics() };
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: {
        ...calculated.inputsUsed,
        instruments: [...calculated.inputsUsed.instruments, { ...calculated.inputsUsed.instruments[0] }],
      },
      portfolioStatus: 'PARTIAL', results: [calculated.results[0], unavailable],
    });
    render(<PostTaxAnalysis profile={demoProfile} recommendations={[...demoRecommendations, { ...demoRecommendations[0], id: 'etf', name: 'ETF' }]} />);
    await explicitInputs(); submit();
    const row = within(await screen.findByTestId('post-tax-row-etf'));
    expect(row.getByTestId('post-tax-return')).toHaveTextContent('—');
    expect(row.getByTestId('post-tax-gain')).toHaveTextContent('—');
    await waitFor(() => expect(screen.getByText(/1 of 2 instruments are included/i)).toBeVisible(), { timeout: 5000 });
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: {
        ...calculated.inputsUsed,
        instruments: [...calculated.inputsUsed.instruments, { ...calculated.inputsUsed.instruments[0] }],
      },
      results: [{ ...calculated.results[0], postTaxGain: null }, unavailable],
    });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete instrument analysis/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
  });

  it('rejects a portfolio status that contradicts the row calculation statuses', async () => {
    const unavailable = {
      instrumentIndex: 1, instrumentInput: etfInstrumentInput, instrumentType: 'ETF', status: 'MODEL_TAX_CLASS_UNAVAILABLE',
      nominalReturnPercent: 7, postTaxReturnPercent: null, realReturnPercent: null,
      totalInvested: 360000,
      sipReturnMetrics: unavailableSipReturnMetrics(),
    };
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: {
        ...calculated.inputsUsed,
        instruments: [
          calculated.inputsUsed.instruments[0],
          etfInstrumentInput,
        ],
      },
      portfolioStatus: 'COMPLETE',
      summary: { ...calculated.summary, status: 'COMPLETE' },
      results: [calculated.results[0], unavailable],
    });
    render(<PostTaxAnalysis
      profile={demoProfile}
      recommendations={[...demoRecommendations, { ...demoRecommendations[0], id: 'etf', name: 'ETF', type: 'ETF' }]}
    />);
    await explicitInputs(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/contradictory portfolio status/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
    expect(screen.queryByTestId('post-tax-row-etf')).toBeNull();
  });

  it.each([
    { ...calculated.results[0], instrumentType: 'PPF' },
    { ...calculated.results[0], nominalReturnPercent: '7' },
    { ...calculated.results[0], status: 'MODEL_TAX_CLASS_UNAVAILABLE' },
  ])('rejects mismatched instrument identity, malformed numbers and non-null unavailable financial outputs', async result => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({ ...calculated, results: [result] });
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete instrument analysis/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
  });

  it.each([
    ['omitted instrument echo', undefined],
    ['changed instrument type', [{ instrumentType: 'PPF', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000 }]],
    ['changed nominal rate', [{ instrumentType: 'FD', nominalRate: 0.08, holdingYears: 3, monthlySIP: 10000 }]],
    ['changed holding period', [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 4, monthlySIP: 10000 }]],
    ['changed SIP amount', [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 1 }]],
    ['extra unsupported input fact', [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000, acquisitionDate: '2025-04-01' }]],
  ])('rejects a response with %s in the echoed batch inputs', async (_description, instruments) => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: { ...calculated.inputsUsed, instruments },
    });
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/different or unverified tax request/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
  });

  it('matches the ordered batch echo including supported optional instrument facts', () => {
    const first = {
      instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000,
      acquisitionDate: '2025-04-01', redemptionDate: '2028-04-01',
      redemptionChannel: 'MATURITY_REDEMPTION', acquiredAtOriginalIssue: true,
      heldContinuously: true, couponRate: 0.065, annuityFraction: 0.25,
      retirementTiming: 'before retirement',
    };
    const second = { instrumentType: 'ETF', nominalRate: 0.1, holdingYears: 5, monthlySIP: 2000 };
    const expected = {
      annualIncome: 1000000, incomeSource: 'salary', regime: 'new', userAge: 30,
      inflationRate: 0.06, fiscalYear: 'FY2026-27', deductions: {},
      instruments: [first, second],
    };
    const response = {
      ...calculated,
      inputsUsed: { ...calculated.inputsUsed, instruments: [{ ...first }, { ...second }] },
      results: [
        { ...calculated.results[0], instrumentIndex: 0, instrumentInput: { ...first } },
        { ...calculated.results[0], instrumentIndex: 1, instrumentInput: { ...second } },
      ],
    };

    expect(() => assertPostTaxBatchResponse(response, expected)).not.toThrow();
    expect(() => assertPostTaxBatchResponse({
      ...response,
      inputsUsed: { ...response.inputsUsed, instruments: [{ ...second }, { ...first }] },
    }, expected)).toThrow(/different or unverified tax request/i);
    expect(() => assertPostTaxBatchResponse({
      ...response,
      inputsUsed: {
        ...response.inputsUsed,
        instruments: [{ ...first, heldContinuously: false }, second],
      },
    }, expected)).toThrow(/different or unverified tax request/i);
    expect(() => assertPostTaxBatchResponse({
      ...response,
      inputsUsed: { ...response.inputsUsed, deductions: { unsupportedClaim: 0 } },
    }, expected)).toThrow(/different or unverified tax request/i);
    expect(() => assertPostTaxBatchResponse({
      ...response,
      assumptions: { ...response.assumptions, deductions: { unsupportedClaim: 0 } },
    }, expected)).toThrow(/different or unverified tax request/i);
    expect(() => assertPostTaxBatchResponse({
      ...response,
      results: [
        { ...response.results[0], instrumentInput: { ...first, monthlySIP: 1 } },
        response.results[1],
      ],
    }, expected)).toThrow(/different or unverified tax request/i);
  });

  it.each([
    ['total tax drag', 'totalTaxDrag', 1],
    ['retained profits per thousand', 'keptPerThousand', 1],
    ['eroded profits per thousand', 'erodedPerThousand', 999],
    ['retention percentage', 'retentionEfficiencyPercent', 0.1],
    ['maximum tax rate', 'maxTaxRate', 0.1],
  ])('rejects a portfolio summary whose %s disagrees with calculated rows', (_label, field, value) => {
    expect(() => assertPostTaxBatchSummary({
      ...calculated,
      summary: { ...calculated.summary, [field]: value },
    })).toThrow(/portfolio summary inconsistent with its calculated rows/i);
  });

  it('requires null summary metrics when no response rows are calculated', () => {
    const response = {
      results: [{ status: 'MODEL_TAX_CLASS_UNAVAILABLE' }],
      summary: {
        totalTaxDrag: null, keptPerThousand: null, erodedPerThousand: null,
        retentionEfficiencyPercent: null, maxTaxRate: null,
      },
    };
    expect(() => assertPostTaxBatchSummary(response)).not.toThrow();
    expect(() => assertPostTaxBatchSummary({
      ...response,
      summary: { ...response.summary, keptPerThousand: 1000 },
    })).toThrow(/unavailable tax summaries must remain null/i);
  });

  it('rejects unrequested tax-comparison deductions while accepting documented normalized zero defaults', () => {
    const fiscalYear = 'FY2026-27';
    const regime = {
      tax: 0, effective_rate: 0, taxable_income: 0, standard_deduction: 0, cess: 0,
      nps80CCD2: 0, allowed80D: 0, rebate_applied: false,
      marginal_relief_applied: false, marginal_relief_amount: 0,
      slab_breakdown: [{ label: 'Your Total Tax', rate: '', taxableInSlab: 0, taxInSlab: 0, isTotalRow: true }],
    };
    const response = {
      verified: true,
      fiscal_year: fiscalYear,
      income: 100000,
      policyVersion: 'tax-policy-FY2026-27-v2',
      calculation_classification: 'SEPARATE_TAX_WHAT_IF',
      inputsUsed: {
        annualIncome: 100000, incomeSource: 'salary', fiscalYear,
        deductions: { age: 30, section80C: 0, nps80CCD2: 0 },
      },
      new_regime: regime,
      old_regime: { ...regime, old_regime_deductions: 0 },
      recommended_regime: 'new', saving: 0, saving_pct: 0, saving_with: 'new',
      optimized_old_regime_tax: 0, potential_tax_saving: 0, crossover_breakpoint: null,
      deduction_limits: {}, remaining_deductions: {},
    };
    const expected = {
      annualIncome: 100000, incomeSource: 'salary', fiscalYear,
      deductions: { age: 30, section80C: 0 },
    };

    expect(() => assertTaxComparisonResponse(response, expected)).not.toThrow();
    expect(() => assertTaxComparisonResponse({
      ...response,
      inputsUsed: { ...response.inputsUsed, deductions: { ...response.inputsUsed.deductions, unsupportedClaim: 0 } },
    }, expected)).toThrow(/submitted input fields.*deductions/i);
    expect(() => assertTaxComparisonResponse({
      ...response,
      inputsUsed: { ...response.inputsUsed, deductions: { ...response.inputsUsed.deductions, nps80CCD1B: 50 } },
    }, expected)).toThrow(/submitted input fields.*deductions/i);
  });
  it('requires a selected-fiscal-year age instead of substituting the profile age', async () => {
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await waitFor(() => expect(screen.getByLabelText(/Fiscal year/i).value).toBe('FY2026-27'));
    fireEvent.change(screen.getByLabelText(/Gross annual income before allowed deductions/i), { target: { value: '1000000' } });
    fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Tax regime/i), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '6' } });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/age for the selected fiscal year/i);
    expect(apiModule.computePostTaxReturnBatch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Your age on March 31')).toHaveValue(null);
  });

  it('clears the selected-year age when the fiscal year changes', async () => {
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs();
    fireEvent.change(screen.getByLabelText(/Fiscal year/i), { target: { value: 'FY2025-26' } });
    expect(screen.getByLabelText('Your age on March 31')).toHaveValue(null);
  });
  it('does not infer gross income and submits every explicit tax input', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      calculation_classification: 'SEPARATE_TAX_WHAT_IF',
      portfolioStatus: 'COMPLETE',
      assumptions: calculated.assumptions,
      results: [{
        instrumentIndex: 0,
        instrumentInput: fdInstrumentInput,
        instrumentType: 'FD',
        status: 'CALCULATED',
        taxRate: 0,
        postTaxReturn: 0.07,
        taxType: 'Slab Rate (0%)',
        effectiveTaxPercent: 0,
        postTaxGain: 38218,
        taxDragWealth: 0,
        taxDragCAGR: 0,
        totalInvested: 360000,
        nominalFutureValue: 360000,
        postTaxFutureValue: 360000,
        nominalReturnPercent: 7,
        postTaxReturnPercent: 7,
        realReturnPercent: 0.9434,
        sipReturnMetrics: calculatedSipReturnMetrics,
      }],
      summary: {
        totalTaxDrag: 0,
        keptPerThousand: 1000,
        erodedPerThousand: 0,
        retentionEfficiencyPercent: 100,
        maxTaxRate: 0,
      },
      insights: [{ title: 'No Estimated Tax Drag', body: 'No drag.', icon: 'shield', color: 'green' }],
    });
    render(<PostTaxAnalysis
      profile={{ age: 30, investment_horizon_years: 3 }}
      recommendations={[{
        id: 'fd', name: 'Fixed Deposit', type: 'FD', nominalReturn: 7, monthly_allocation: 10000,
      }]}
    />);
    expect(apiModule.computePostTaxReturnBatch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(/Fiscal year/i).value).toBe('FY2026-27'));
    fireEvent.change(screen.getByLabelText(/Gross annual income before allowed deductions/i), { target: { value: '1000000' } });
    fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Tax regime/i), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText(/Fiscal year/i), { target: { value: 'FY2026-27' } });
  fireEvent.change(screen.getByLabelText('Your age on March 31'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /calculate explicit tax what-if/i }));
    await waitFor(() => expect(apiModule.computePostTaxReturnBatch).toHaveBeenCalledWith(
      [{ instrumentType: 'FD', nominalRate: 0.07, holdingYears: 3, monthlySIP: 10000 }],
      1000000, 'new', 30, 'salary', 0.06, 'FY2026-27',
      { body: { deductions: {} }, signal: expect.any(AbortSignal) },
    ));
    expect((await screen.findAllByText('7.0%')).length).toBeGreaterThan(0);
    expect(screen.getByText(/MODELLED_POST_TAX_PROJECTION/i)).toBeInTheDocument();
  });

  it('labels tax drag as not calculated before the user submits an explicit what-if', async () => {
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    const totalTaxDrag = document.querySelector('.pta-kpi-card--erosion');
    expect(totalTaxDrag).toHaveTextContent('Not calculated');
    expect(screen.getByTestId('post-tax-asset-count')).toHaveTextContent('1 asset');
    expect(screen.getByText(/After-tax estimates have not been calculated for 1 asset/i)).toBeInTheDocument();
    expect(screen.queryByTestId('post-tax-unavailable-explanation')).toBeNull();
  });

  it.each([
    { ...calculated, fiscalYear: 'FY2025-26' },
    { ...calculated, inputsUsed: { ...calculated.inputsUsed, annualIncome: 900000 } },
  ])('rejects a post-tax result that does not echo the selected year and financial inputs', async response => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue(response);
    render(<PostTaxAnalysis profile={demoProfile} recommendations={demoRecommendations} />);
    await explicitInputs(); submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/different or unverified tax request/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
  });
  it('keeps an unavailable portfolio summary unavailable in the UI', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: {
        ...calculated.inputsUsed,
        instruments: [{ ...calculated.inputsUsed.instruments[0], instrumentType: 'ETF', nominalRate: 0.12 }],
      },
      portfolioStatus: 'UNAVAILABLE',
      assumptions: calculated.assumptions,
      results: [{
        instrumentIndex: 0,
        instrumentInput: { ...calculated.inputsUsed.instruments[0], instrumentType: 'ETF', nominalRate: 0.12 },
        instrumentType: 'ETF', status: 'MODEL_TAX_CLASS_UNAVAILABLE',
        unavailableReasons: ['MODEL_TAX_CLASS_UNAVAILABLE_FOR_GENERIC_INSTRUMENT_TYPE'],
        sipReturnMetrics: unavailableSipReturnMetrics(),
      }],
      summary: {
        status: 'UNAVAILABLE',
        totalTaxDrag: null,
        keptPerThousand: null,
        erodedPerThousand: null,
        retentionEfficiencyPercent: null,
        maxTaxRate: null,
      },
      insights: [{ title: 'Post-Tax Projection Unavailable', body: 'Unavailable.', icon: 'shield', color: 'amber' }],
    });
    render(<PostTaxAnalysis
      profile={{ age: 30, investment_horizon_years: 3 }}
      recommendations={[{ id: 'etf', name: 'Generic ETF', type: 'ETF', nominalReturn: 12, monthly_allocation: 10000 }]}
    />);
    await waitFor(() => expect(screen.getByLabelText(/Fiscal year/i).value).toBe('FY2026-27'));
    fireEvent.change(screen.getByLabelText(/Gross annual income before allowed deductions/i), { target: { value: '1000000' } });
    fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Tax regime/i), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText(/Fiscal year/i), { target: { value: 'FY2026-27' } });
  fireEvent.change(screen.getByLabelText('Your age on March 31'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /calculate explicit tax what-if/i }));
    expect(await screen.findByText(/Profit retention unavailable/i)).toBeInTheDocument();
    expect(await screen.findByTestId('post-tax-unavailable-explanation'))
      .toHaveTextContent(/No source-qualified tax treatment is established for this investment type/i);
    expect(screen.getByTestId('post-tax-unavailable-explanation'))
      .not.toHaveTextContent('MODEL_TAX_CLASS_UNAVAILABLE_FOR_GENERIC_INSTRUMENT_TYPE');
    expect(screen.queryByText('RETAINED')).not.toBeInTheDocument();
  });

  it('keeps tax projection status while showing SIP return as unavailable when monthly contributions are zero', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
      inputsUsed: {
        ...calculated.inputsUsed,
        instruments: [{ ...calculated.inputsUsed.instruments[0], monthlySIP: 0 }],
      },
      results: [{
        ...calculated.results[0],
        instrumentInput: { ...calculated.inputsUsed.instruments[0], monthlySIP: 0 },
        totalInvested: 0,
        taxDragWealth: 0,
        taxRate: 0,
        nominalFutureValue: 0,
        postTaxFutureValue: 0,
        sipReturnMetrics: unavailableSipReturnMetrics('NO_MONTHLY_CONTRIBUTIONS'),
      }],
      summary: {
        totalTaxDrag: 0,
        keptPerThousand: 1000,
        erodedPerThousand: 0,
        retentionEfficiencyPercent: 100,
        maxTaxRate: 0,
      },
    });
    render(<PostTaxAnalysis
      profile={demoProfile}
      recommendations={[{ ...demoRecommendations[0], monthly_allocation: 0 }]}
    />);
    await explicitInputs(); submit();
    const row = within(await screen.findByTestId('post-tax-row-fd'));
    expect(row.getByTestId('post-tax-return')).toHaveTextContent('—');
    expect(row.getByTestId('pre-tax-sip-return')).toHaveTextContent('—');
    expect(row.getByTestId('real-return')).toHaveTextContent('—');
    expect(row.getByTestId('sip-return-unavailable-explanation'))
      .toHaveTextContent(/No monthly contributions were supplied/i);
    expect(row.getByTestId('effective-tax')).toHaveTextContent('0.0%');
  });
});
