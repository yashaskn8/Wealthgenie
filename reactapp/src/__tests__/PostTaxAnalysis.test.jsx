/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PostTaxAnalysis from '../PostTaxAnalysis';
import * as apiModule from '../services/api';

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
const calculated = {
  portfolioStatus: 'COMPLETE', assumptions: { inflationRate: 0.06 },
  results: [{ instrumentType: 'FD', status: 'CALCULATED', taxType: 'Slab Rate', nominalReturnPercent: 7,
    postTaxReturnPercent: 0, realReturnPercent: -5.66, effectiveTaxPercent: 0,
    postTaxGain: 0, taxDragWealth: 123456.7, taxDragCAGR: 0.025, totalInvested: 360000,
    sipReturnMetrics: calculatedSipReturnMetrics }],
  summary: { totalTaxDrag: 123456.7, keptPerThousand: 0, erodedPerThousand: 1000, retentionEfficiencyPercent: 0, maxTaxRate: 0 },
};
async function explicitInputs() {
  await waitFor(() => expect(screen.getByLabelText(/Fiscal year/i).value).toBe('FY2026-27'));
  fireEvent.change(screen.getByLabelText(/Gross annual income before allowed deductions/i), { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText(/Tax regime/i), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText(/Inflation assumption/i), { target: { value: '6' } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: /calculate explicit tax what-if/i }));

describe('PostTaxAnalysis separate tax what-if', () => {
  beforeEach(() => { cleanup(); vi.clearAllMocks(); });

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
    apiModule.computePostTaxReturnBatch.mockResolvedValue(calculated);
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
    const unavailable = { instrumentType: 'FD', status: 'MODEL_TAX_CLASS_UNAVAILABLE', nominalReturnPercent: 7, postTaxReturnPercent: null, realReturnPercent: null, totalInvested: 360000,
      sipReturnMetrics: unavailableSipReturnMetrics() };
    apiModule.computePostTaxReturnBatch.mockResolvedValue({ ...calculated, portfolioStatus: 'PARTIAL', results: [calculated.results[0], unavailable] });
    render(<PostTaxAnalysis profile={demoProfile} recommendations={[...demoRecommendations, { ...demoRecommendations[0], id: 'etf', name: 'ETF' }]} />);
    await explicitInputs(); submit();
    const row = within(await screen.findByTestId('post-tax-row-etf'));
    expect(row.getByTestId('post-tax-return')).toHaveTextContent('—');
    expect(row.getByTestId('post-tax-gain')).toHaveTextContent('—');
    await waitFor(() => expect(screen.getByText(/1 of 2 instruments are included/i)).toBeVisible(), { timeout: 5000 });
    apiModule.computePostTaxReturnBatch.mockResolvedValue({ ...calculated, results: [{ ...calculated.results[0], postTaxGain: null }, unavailable] });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplete instrument analysis/i);
    expect(screen.queryByTestId('post-tax-row-fd')).toBeNull();
  });

  it('rejects a portfolio status that contradicts the row calculation statuses', async () => {
    const unavailable = {
      instrumentType: 'ETF', status: 'MODEL_TAX_CLASS_UNAVAILABLE',
      nominalReturnPercent: 7, postTaxReturnPercent: null, realReturnPercent: null,
      totalInvested: 360000,
      sipReturnMetrics: unavailableSipReturnMetrics(),
    };
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      ...calculated,
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

  it('does not infer gross income and submits every explicit tax input', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      calculation_classification: 'SEPARATE_TAX_WHAT_IF',
      portfolioStatus: 'COMPLETE',
      assumptions: { inflationRate: 0.06 },
      results: [{
        instrumentType: 'FD',
        status: 'CALCULATED',
        postTaxReturn: 0.07,
        taxType: 'Slab Rate (0%)',
        effectiveTaxPercent: 0,
        postTaxGain: 38218,
        taxDragWealth: 0,
        taxDragCAGR: 0,
        totalInvested: 360000,
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

  it('keeps an unavailable portfolio summary unavailable in the UI', async () => {
    apiModule.computePostTaxReturnBatch.mockResolvedValue({
      portfolioStatus: 'UNAVAILABLE',
      assumptions: { inflationRate: 0.06 },
      results: [{
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
      results: [{
        ...calculated.results[0],
        totalInvested: 0,
        sipReturnMetrics: unavailableSipReturnMetrics('NO_MONTHLY_CONTRIBUTIONS'),
      }],
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
