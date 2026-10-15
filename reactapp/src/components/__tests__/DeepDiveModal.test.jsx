import React, { StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DeepDiveModal from '../DeepDiveModal';

vi.mock('../deepdive', () => ({
  OverviewTab: () => <div>Overview</div>, WhereToInvestTab: () => null,
  CalculatorTab: () => null, TaxTab: () => null, HistoryTab: () => null,
  WhyInvestTab: () => null,
}));
vi.mock('../../services/api', () => ({ default: { compareInvestmentProjection: vi.fn(async () => ({ normalizedChart: [] })) } }));
afterEach(cleanup);

it('can close and reopen a real instrument without interpreting an absent selection as missing return facts', () => {
  const instrument = { id: 'ppf', name: 'Server PPF', nominalReturn: 7.1, riskLabel: 'Very Low', lockIn: 15, category: 'Sovereign' };
  const props = { onClose: vi.fn(), horizon: 15, allRecommendations: [instrument] };
  const view = render(<DeepDiveModal {...props} isOpen investment={instrument} />);
  expect(screen.getByRole('dialog', { name: 'Server PPF' })).toBeVisible();
  expect(() => view.rerender(<DeepDiveModal {...props} isOpen={false} investment={null} />)).not.toThrow();
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<DeepDiveModal {...props} isOpen investment={instrument} />);
  expect(screen.getByRole('dialog', { name: 'Server PPF' })).toBeVisible();
});

it('switches instrument, horizon, and recommendation in StrictMode without render-phase state updates', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = { id: 'ppf', name: 'Server PPF', nominalReturn: 7.1, riskLabel: 'Very Low' };
  const second = { id: 'index_mf', name: 'Index category', nominalReturn: 11, riskLabel: 'High' };
  const view = render(
    <StrictMode>
      <DeepDiveModal
        isOpen investment={first} horizon={15} recommendationMeta={{ recommendationId: 'rec-1', allocation_revision: 1 }}
        onClose={vi.fn()} allRecommendations={[first, second]}
      />
    </StrictMode>,
  );

  view.rerender(
    <StrictMode>
      <DeepDiveModal
        isOpen investment={second} horizon={7} recommendationMeta={{ recommendationId: 'rec-2', allocation_revision: 2 }}
        onClose={vi.fn()} allRecommendations={[first, second]}
      />
    </StrictMode>,
  );

  expect(screen.getByRole('dialog', { name: 'Index category' })).toBeVisible();
  expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/cannot update a component while rendering|too many re-renders/i);
  consoleError.mockRestore();
});

it('keeps the retained investment detail tabs without exposing the crash stress test', () => {
  render(<DeepDiveModal
    isOpen
    investment={{ id: 'ppf', name: 'Server PPF', nominalReturn: 7.1, riskLabel: 'Very Low', lockIn: 15 }}
    onClose={vi.fn()}
    allRecommendations={[]}
  />);

  const tabs = screen.getAllByRole('tab');
  expect(tabs.map(tab => tab.textContent.trim())).toEqual([
    'Overview', 'Where to Invest', 'Calculator', 'Tax', 'History', 'Why Invest',
  ]);
  expect(screen.queryByRole('tab', { name: /stress test/i })).toBeNull();
});

it.each([
  ['missing', {}, 'Unavailable'],
  ['negative', { lock_in_years: -1 }, 'Unavailable'],
  ['non-finite', { lockIn: Number.NaN }, 'Unavailable'],
  ['malformed', { lock_in_years: '' }, 'Unavailable'],
  ['verified zero', { lock_in_years: 0 }, 'None'],
  ['verified positive', { lockIn: 5 }, '5 Years'],
])('shows lock-in as %s only when its value is valid', (_case, lockIn, expected) => {
  render(<DeepDiveModal
    isOpen
    investment={{ id: 'ppf', name: 'Server PPF', ...lockIn }}
    onClose={vi.fn()}
    allRecommendations={[]}
  />);

  const lockInLabel = screen.getByText('Lock-in Period');
  expect(lockInLabel.closest('.metric-item').querySelector('.metric-value')).toHaveTextContent(expected);
});
