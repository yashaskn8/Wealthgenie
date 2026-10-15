import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../../services/api';
import FinancialIndicatorsPanel from '../FinancialIndicatorsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('FinancialIndicatorsPanel request binding', () => {
  it('does not request profile indicators when the profile identity is missing', () => {
    const request = vi.spyOn(api, 'getFinancialHealthScore');
    render(<FinancialIndicatorsPanel profile={{ version: 1 }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Save your Financial Profile');
    expect(request).not.toHaveBeenCalled();
  });

  it('fails closed on malformed responses and retries into the ready state', async () => {
    const request = vi.spyOn(api, 'getFinancialHealthScore')
      .mockResolvedValueOnce({ sub_scores: null })
      .mockResolvedValueOnce({ sub_scores: [{ label: 'Savings Capacity', extra: 'Based on your saved monthly savings.' }] });
    render(<FinancialIndicatorsPanel profile={{ profileId: 'profile-a', version: 2 }} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('incomplete response');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Based on your saved monthly savings.')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('never displays a late response from the prior profile after profile switching', async () => {
    const oldRequest = deferred();
    const request = vi.spyOn(api, 'getFinancialHealthScore')
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ sub_scores: [{ label: 'Goal Coverage', extra: 'Current profile B detail.' }] });
    const { rerender } = render(<FinancialIndicatorsPanel profile={{ profileId: 'profile-a', version: 1 }} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    rerender(<FinancialIndicatorsPanel profile={{ profileId: 'profile-b', version: 1 }} />);
    expect(await screen.findByText('Current profile B detail.')).toBeInTheDocument();
    await act(async () => oldRequest.resolve({
      sub_scores: [{ label: 'Goal Coverage', extra: 'Late profile A detail.' }],
    }));

    expect(screen.getByText('Current profile B detail.')).toBeInTheDocument();
    expect(screen.queryByText('Late profile A detail.')).not.toBeInTheDocument();
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
