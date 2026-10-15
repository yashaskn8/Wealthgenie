import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import StepUpPlanner from '../StepUpPlanner';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

it('hides a prior projection when inputs change and ignores late results from older inputs', async () => {
  const initial = deferred();
  const recalculation = deferred();
  const latest = deferred();
  const calculate = vi.spyOn(api, 'calculateStepUpProjection')
    .mockImplementationOnce(() => initial.promise)
    .mockImplementationOnce(() => recalculation.promise)
    .mockImplementationOnce(() => latest.promise);

  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(1));
  await act(async () => initial.resolve({ flatFinal: 123000000 }));
  expect(await screen.findByText('₹12.3 Cr')).toBeInTheDocument();

  const numericInputs = screen.getAllByRole('spinbutton');
  fireEvent.change(numericInputs[0], { target: { value: '2000' } });
  expect(screen.queryByText('₹12.3 Cr')).not.toBeInTheDocument();
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(2));

  fireEvent.change(numericInputs[1], { target: { value: '15' } });
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(3));
  await act(async () => latest.resolve({ flatFinal: 67000000 }));
  expect(await screen.findByText('₹6.7 Cr')).toBeInTheDocument();

  await act(async () => recalculation.resolve({ flatFinal: 89000000 }));
  expect(screen.getByText('₹6.7 Cr')).toBeInTheDocument();
  expect(screen.queryByText('₹8.9 Cr')).not.toBeInTheDocument();
});
