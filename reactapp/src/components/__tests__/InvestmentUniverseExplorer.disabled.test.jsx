import React from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCurrentProfile: vi.fn(),
  getFinancialUniverse: vi.fn(),
  getFinancialUniverseSummary: vi.fn(),
  getQualifiedFamilyTopProducts: vi.fn(),
  getThreeProductReadyFamilies: vi.fn(),
}));
vi.mock('../../services/api', () => api);

let InvestmentUniverseExplorer;
beforeAll(async () => {
  vi.stubEnv('VITE_FINANCIAL_POSTGRES_ENABLED', 'false');
  ({ default: InvestmentUniverseExplorer } = await import('../InvestmentUniverseExplorer.jsx'));
});
afterAll(() => vi.unstubAllEnvs());

it('explains why the tailored top three is absent when the qualified catalog is disabled', () => {
  render(<InvestmentUniverseExplorer />);
  expect(screen.getByRole('heading', { name: 'Tailored top-three product comparison unavailable' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('source rights, current facts');
  expect(api.getFinancialUniverseSummary).not.toHaveBeenCalled();
  expect(api.getThreeProductReadyFamilies).not.toHaveBeenCalled();
  expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
});
