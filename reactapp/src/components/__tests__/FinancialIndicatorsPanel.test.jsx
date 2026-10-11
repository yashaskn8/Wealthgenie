import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mockApi = vi.hoisted(() => ({ getFinancialHealthScore: vi.fn() }));
vi.mock('../../services/api', () => mockApi);

import FinancialIndicatorsPanel from '../FinancialIndicatorsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('shows useful profile indicators without rendering the composite score or grade', async () => {
  mockApi.getFinancialHealthScore.mockResolvedValue({
    score: 91,
    grade: 'Excellent',
    sub_scores: [
      { label: 'Savings Capacity', value: 88, weight: 30, extra: '24.0% of declared take-home is available for recurring investment.' },
      { label: 'Emergency Safety Net', value: 100, weight: 25, extra: '6 months of emergency-fund coverage were explicitly declared.' },
      { label: 'Investment Variety', value: 67, weight: 20, extra: '2 distinct asset classes in the authoritative allocation.' },
      { label: 'Goal Coverage', value: 50, weight: 15, extra: '1 of 2 declared goals are represented by authoritative recommendation tags.' },
      { label: 'Tax Efficiency', value: null, weight: 0, extra: 'Not scored: use Post-Tax Analysis.' },
      { label: 'Risk-Timeline Match', value: 82, weight: 10, extra: 'Final suitability: Moderate. TECHNICAL_REASON_CODE' },
    ],
  });

  render(<FinancialIndicatorsPanel profile={{ profileId: 'profile-1' }} />);

  expect(await screen.findByText(/24.0% of declared take-home/)).toBeInTheDocument();
  expect(screen.getByText(/6 months of emergency-fund coverage/)).toBeInTheDocument();
  expect(screen.getByText(/2 distinct asset classes/)).toBeInTheDocument();
  expect(screen.getByText(/1 of 2 declared goals/)).toBeInTheDocument();
  expect(screen.queryByText('91')).not.toBeInTheDocument();
  expect(screen.queryByText('Excellent')).not.toBeInTheDocument();
  expect(screen.queryByText(/TECHNICAL_REASON_CODE|Risk-Timeline Match|Tax Efficiency/)).not.toBeInTheDocument();
  await waitFor(() => expect(mockApi.getFinancialHealthScore).toHaveBeenCalledWith(
    'profile-1', expect.objectContaining({ signal: expect.any(AbortSignal) }),
  ));
});
