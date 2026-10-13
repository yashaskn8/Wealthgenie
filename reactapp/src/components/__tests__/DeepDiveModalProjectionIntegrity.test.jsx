import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import DeepDiveModal from '../DeepDiveModal';

vi.mock('../../services/api', () => ({
  default: {
    compareInvestmentProjection: vi.fn(),
  },
}));

vi.mock('../deepdive', async importOriginal => {
  const original = await importOriginal();
  return {
    ...original,
    OverviewTab: () => null,
    WhereToInvestTab: () => null,
    TaxTab: () => null,
    HistoryTab: ({ historicalData, projectionLoading }) => (
      <div>
        <span data-testid="history-point-count">{historicalData.length}</span>
        {projectionLoading && <span role="status">Updating the comparison for the current assumptions…</span>}
      </div>
    ),
    WhyInvestTab: () => null,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function buildProjection(monthlyInvestment, annualReturnRate, benchmarkRate, inflationRate, years) {
  const yearlyBreakdown = [];
  const normalizedChart = [];
  for (let year = 1; year <= years; year += 1) {
    const sipValue = rate => {
      const monthlyRate = rate / 12;
      return Math.abs(monthlyRate) < 1e-10
        ? monthlyInvestment * year * 12
        : monthlyInvestment * ((Math.pow(1 + monthlyRate, year * 12) - 1) / monthlyRate) * (1 + monthlyRate);
    };
    const investmentNominal = Math.round(sipValue(annualReturnRate));
    const benchmarkNominal = Math.round(sipValue(benchmarkRate));
    const invested = Math.round(monthlyInvestment * 12 * year);
    yearlyBreakdown.push({
      year,
      invested,
      investmentNominal,
      investmentReal: Math.round(investmentNominal / Math.pow(1 + inflationRate, year)),
      benchmarkNominal,
      benchmarkReal: Math.round(benchmarkNominal / Math.pow(1 + inflationRate, year)),
      gains: Math.round(investmentNominal - invested),
    });
    normalizedChart.push({
      year: 'Year ' + year,
      investment: Math.round(100 * Math.pow(1 + annualReturnRate, year)),
      benchmark: Math.round(100 * Math.pow(1 + benchmarkRate, year)),
      inflation: Math.round(100 * Math.pow(1 + inflationRate, year)),
    });
  }
  const final = yearlyBreakdown.at(-1);
  return {
    calculation_classification: 'NON_RECOMMENDATION_PROJECTION_COMPARISON',
    return_basis: 'PRE_TAX_NOMINAL_WITH_EXPLICIT_INFLATION_VIEW',
    return_data_class: 'USER_INPUT',
    return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    observed_market_fact: false,
    provider_forecast: false,
    assumptions: { monthlyInvestment, annualReturnRate, benchmarkRate, inflationRate, years },
    totalInvested: final.invested,
    investmentMaturity: final.investmentNominal,
    investmentReal: final.investmentReal,
    benchmarkMaturity: final.benchmarkNominal,
    benchmarkReal: final.benchmarkReal,
    estimatedReturns: final.gains,
    opportunityCost: final.investmentReal - final.benchmarkReal,
    purchasingPowerLost: final.invested - final.benchmarkReal,
    benchmarkRealAnnualRate: Number((((1 + benchmarkRate) / (1 + inflationRate) - 1) * 100).toFixed(2)),
    inflationHalfLifeYears: inflationRate > 0 ? Number((Math.log(2) / Math.log(1 + inflationRate)).toFixed(1)) : null,
    yearlyBreakdown,
    normalizedChart,
  };
}

it('discards a late old projection and hides History data until the current inputs resolve', async () => {
  const oldResponse = deferred();
  const newResponse = deferred();
  api.compareInvestmentProjection
    .mockReturnValueOnce(oldResponse.promise)
    .mockReturnValueOnce(newResponse.promise);

  const investment = {
    id: 'ppf',
    type: 'FD',
    name: 'PPF',
    category: 'Sovereign',
    nominalReturn: 7.1,
    expected_return_min: 7.1,
    expected_return_max: 7.1,
    riskLabel: 'Very Low',
  };

  const { container } = render(
    <DeepDiveModal
      isOpen
      investment={investment}
      horizon={1}
      initialTab="Calculator"
      userProfile={{ profileId: 'profile-1', version: 1, age: 35 }}
      recommendationMeta={{ profileId: 'profile-1', profile_version: 1, recommendationId: 'recommendation-1' }}
      allRecommendations={[investment]}
      onClose={vi.fn()}
    />,
  );

  await waitFor(() => expect(api.compareInvestmentProjection).toHaveBeenCalledTimes(1), { timeout: 3000 });
  const sliders = container.querySelectorAll('input[type="range"]');
  expect(sliders.length).toBeGreaterThanOrEqual(4);
  fireEvent.change(sliders[0], { target: { value: '6000' } });

  expect(screen.getByRole('button', { name: /save goal report/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /copy summary/i })).toBeDisabled();
  await waitFor(() => expect(api.compareInvestmentProjection).toHaveBeenCalledTimes(2), { timeout: 3000 });

  oldResponse.resolve(buildProjection(...api.compareInvestmentProjection.mock.calls[0]));
  await waitFor(() => expect(screen.getByRole('button', { name: /copy summary/i })).toBeDisabled());

  fireEvent.click(screen.getByRole('tab', { name: /history/i }));
  expect(screen.getByTestId('history-point-count')).toHaveTextContent('0');
  expect(screen.getByRole('status')).toHaveTextContent(/current assumptions/i);

  newResponse.resolve(buildProjection(...api.compareInvestmentProjection.mock.calls[1]));
  fireEvent.click(screen.getByRole('tab', { name: /calculator/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /copy summary/i })).toBeEnabled(), { timeout: 3000 });
  fireEvent.click(screen.getByRole('tab', { name: /history/i }));
  expect(screen.getByTestId('history-point-count')).toHaveTextContent('1');
  expect(screen.queryByRole('status')).toBeNull();
});
