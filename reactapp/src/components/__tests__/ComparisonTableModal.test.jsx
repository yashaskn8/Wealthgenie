import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ComparisonTableModal from '../../ComparisonTableModal';

afterEach(cleanup);

it('keeps backend suitability values and sort order without synthetic risk lines or a winner verdict', async () => {
  const allInvestments = [
    { id: 'ppf', name: 'Public Provident Fund', abbr: 'PPF', category: 'Government', riskLabel: 'Very Low', lockIn: 15, minMonthlyInvestment: 500 },
    { id: 'index_mf', name: 'Index Fund', abbr: 'Index', category: 'Equity', riskLabel: 'High', lockIn: 0, minMonthlyInvestment: 500 },
  ];
  const recommendations = [
    { id: 'ppf', score: 42, nominalReturn: 7.1, riskLabel: 'Very Low' },
    { id: 'index_mf', score: 91, nominalReturn: 11, riskLabel: 'High' },
  ];

  render(<ComparisonTableModal isOpen allInvestments={allInvestments} recommendations={recommendations} />);

  const rows = screen.getAllByRole('row');
  expect(within(rows[1]).getByText('Index')).toBeInTheDocument();
  expect(within(rows[2]).getByText('PPF')).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /illustrative risk pattern/i })).toBeNull();

  fireEvent.click(within(rows[1]).getByRole('checkbox'));
  fireEvent.click(within(rows[2]).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: /deep compare/i }));

  await waitFor(() => expect(screen.getByText('Match Score')).toBeVisible());
  expect(screen.getAllByText('91%').length).toBeGreaterThan(0);
  expect(screen.getAllByText('42%').length).toBeGreaterThan(0);
  expect(screen.queryByText('AI Match Verdict')).toBeNull();
  expect(screen.queryByText('Highest Suitability Score')).toBeNull();
});
