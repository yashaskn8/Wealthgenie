/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import * as api from '../services/api';
import { resetMarketContextStoreForTest, useMarketContext } from './useMarketContext';

vi.mock('../services/api', () => ({
  getCurrentMarketContext: vi.fn(),
}));

const snapshot = {
  status: 'MARKET_CONTEXT_AVAILABLE',
  context: 'NORMAL',
  marketSnapshot: {
    status: 'CURRENT',
    marketSession: { status: 'MARKET_OPEN' },
    observedAt: '2026-09-10T10:00:00.000Z',
  },
};

function Probe() {
  const {
    marketContext,
    marketContextRefreshing,
    marketContextTransport,
    refreshMarketContext,
    acceptMarketContext,
  } = useMarketContext();
  return (
    <div>
      <span data-testid="context">{marketContext?.context || 'loading'}</span>
      <span data-testid="refreshing">{marketContextRefreshing ? 'refreshing' : 'idle'}</span>
      <span data-testid="transport-status">{marketContextTransport.revalidationStatus}</span>
      <button type="button" onClick={() => refreshMarketContext()}>refresh</button>
      <button type="button" onClick={() => acceptMarketContext({ ...snapshot, context: 'CAUTIOUS' })}>accept server preview</button>
    </div>
  );
}

describe('shared market context store', () => {
  beforeEach(() => {
    resetMarketContextStoreForTest();
    vi.useRealTimers();
    vi.clearAllMocks();
    api.getCurrentMarketContext.mockResolvedValue(snapshot);
  });

  afterEach(() => {
    cleanup();
    resetMarketContextStoreForTest();
  });

  it('coalesces concurrent consumers into one backend read', async () => {
    render(<><Probe /><Probe /></>);
    await waitFor(() => expect(screen.getAllByTestId('context')[0].textContent).toBe('NORMAL'));
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous snapshot visible while a manual refresh is in flight', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('context').textContent).toBe('NORMAL'));
    let resolveRefresh;
    api.getCurrentMarketContext.mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(screen.getByTestId('context').textContent).toBe('NORMAL');
    expect(screen.getByTestId('refreshing').textContent).toBe('refreshing');
    resolveRefresh({ ...snapshot, context: 'CAUTIOUS' });
    await waitFor(() => expect(screen.getByTestId('context').textContent).toBe('CAUTIOUS'));
    expect(screen.getByTestId('transport-status').textContent).toBe('SUCCESS');
  });

  it('does not force a second backend read when another consumer mounts inside the cadence', async () => {
    const view = render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('context').textContent).toBe('NORMAL'));
    vi.clearAllMocks();
    view.rerender(<><Probe /><Probe /></>);
    await waitFor(() => expect(screen.getAllByTestId('context')[1].textContent).toBe('NORMAL'));
    expect(api.getCurrentMarketContext).not.toHaveBeenCalled();
  });

  it('preserves the verified snapshot and discloses a failed manual refresh', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('context').textContent).toBe('NORMAL'));
    api.getCurrentMarketContext.mockRejectedValueOnce(new Error('NSE temporarily unavailable'));

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));

    await waitFor(() => expect(screen.getByTestId('transport-status').textContent).toBe('FAILED'));
    expect(screen.getByTestId('context').textContent).toBe('NORMAL');
  });

  it('does not let an older in-flight GET overwrite the exact server snapshot used by a preview', async () => {
    let resolveRead;
    api.getCurrentMarketContext.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'accept server preview' }));
    expect(screen.getByTestId('context').textContent).toBe('CAUTIOUS');

    await act(async () => resolveRead(snapshot));
    await waitFor(() => expect(screen.getByTestId('context').textContent).toBe('CAUTIOUS'));
  });

  it.each([
    ['CURRENT', 'MARKET_OPEN', 90_000],
    ['MARKET_CLOSED', 'MARKET_CLOSED', 600_000],
  ])('uses one shared %s cadence and stops polling when unmounted', async (status, session, cadence) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T05:00:00Z'));
    api.getCurrentMarketContext.mockResolvedValue({ ...snapshot, marketSnapshot: { ...snapshot.marketSnapshot, status, marketSession: { status: session } } });
    const view = render(<><Probe /><Probe /></>);
    await act(async () => {});
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(cadence - 1); });
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(cadence); fireEvent.focus(window); });
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('coalesces focus and visibility revalidation only after the current threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T05:00:00Z'));
    render(<Probe />);
    await act(async () => {});
    fireEvent.focus(window);
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await act(async () => {
      fireEvent.focus(window);
      fireEvent(document, new Event('visibilitychange'));
    });
    expect(api.getCurrentMarketContext).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
