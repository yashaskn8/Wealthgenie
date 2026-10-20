import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredBenchmarkMarketFacts, getStoredEquityHistory } from '../../services/api';
import QualifiedMarketEvidencePanel from './QualifiedMarketEvidencePanel';

vi.mock('../../services/api', () => ({
  getStoredBenchmarkMarketFacts: vi.fn(),
  getStoredEquityHistory: vi.fn(),
}));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('QualifiedMarketEvidencePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStoredBenchmarkMarketFacts.mockResolvedValue({ status: 'UNAVAILABLE', facts: [] });
  });

  it('removes prior quote values while refreshing and after a failed read', async () => {
    const first = { status: 'AVAILABLE', facts: [{
      canonicalProductId: 'market:index:nifty-50', availabilityStatus: 'AVAILABLE',
      value: 25123.45, source: { provider: 'UPSTOX' },
      observedAt: '2026-10-19T08:45:00.000Z',
      fetchedAt: '2026-10-19T08:50:00.000Z', freshness: { status: 'STALE' },
    }] };
    const second = deferred();
    getStoredBenchmarkMarketFacts.mockResolvedValueOnce(first).mockReturnValueOnce(second.promise);

    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    expect(await screen.findByText('25,123.45')).toBeInTheDocument();
    expect(screen.getByText('Freshness: STALE')).toBeInTheDocument();
    expect(screen.getByText('NIFTY 50 and India VIX — stored observations')).toBeInTheDocument();
    expect(screen.getByText(/Provider observed: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Fetched: 19 Oct 2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide stored prices/ }));
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));

    expect(screen.getByText('Loading stored market observations…')).toBeInTheDocument();
    expect(screen.queryByText('25,123.45')).not.toBeInTheDocument();
    await act(async () => second.resolve(Promise.reject(new Error('provider unavailable'))));
    expect(await screen.findByText('Stored market observations could not be read.')).toBeInTheDocument();
    expect(screen.queryByText('25,123.45')).not.toBeInTheDocument();
  });

  it('keeps the latest stored-history query when an older response arrives later', async () => {
    const older = deferred();
    const newer = deferred();
    getStoredEquityHistory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));

    const form = screen.getByRole('button', { name: 'Read stored history' }).closest('form');
    fireEvent.submit(form);
    fireEvent.change(screen.getByRole('textbox', { name: 'Trading symbol' }), {
      target: { value: 'INFY' },
    });
    fireEvent.submit(form);
    expect(getStoredEquityHistory).toHaveBeenCalledTimes(2);
    expect(getStoredEquityHistory.mock.calls[1][0].symbol).toBe('INFY');
    expect(getStoredEquityHistory.mock.calls[0][1].signal.aborted).toBe(true);

    await act(async () => newer.resolve({ status: 'AVAILABLE', barCount: 1, bars: [{
      tradingDate: '2026-10-16', provider: 'TEJHQ', priceBasis: 'RAW_UNADJUSTED',
      open: 1500, high: 1540, low: 1490, close: 1534.2, adjustedClose: null,
      volume: 100000, providerObservedAt: '2026-10-16T10:00:00.000Z',
      fetchedAt: '2026-10-19T08:50:00.000Z',
    }] }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('1,534.2')).toBeInTheDocument();
    expect(within(table).getByText('RAW_UNADJUSTED')).toBeInTheDocument();
    expect(within(table).getByText('1,00,000')).toBeInTheDocument();

    await act(async () => older.resolve({ status: 'AVAILABLE', barCount: 1, bars: [{
      tradingDate: '2026-10-15', provider: 'UPSTOX', priceBasis: 'UPSTOX_PROVIDER_NATIVE',
      open: 9999, high: 9999, low: 9999, close: 9999,
    }] }));
    await waitFor(() => expect(within(table).getByText('1,534.2')).toBeInTheDocument());
    expect(within(table).queryByText('9,999')).not.toBeInTheDocument();
  });

  it('clears stored history when the query changes or the panel closes', async () => {
    getStoredEquityHistory.mockResolvedValue({ status: 'AVAILABLE', barCount: 1, bars: [{
      tradingDate: '2026-10-16', provider: 'TEJHQ', priceBasis: 'RAW_UNADJUSTED',
      close: 1534.2, fetchedAt: '2026-10-19T08:50:00.000Z',
    }] });
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByText('1,534.2')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Trading symbol' }), {
      target: { value: 'INFY' },
    });
    expect(screen.queryByText('1,534.2')).not.toBeInTheDocument();

    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByText('1,534.2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide stored prices/ }));
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    expect(screen.queryByText('1,534.2')).not.toBeInTheDocument();
  });

  it('plots only retained EOD closes for the selected price basis', async () => {
    getStoredEquityHistory.mockImplementation(({ basis }) => Promise.resolve({
      status: 'AVAILABLE', barCount: 2, bars: [
        { tradingDate: '2026-10-15', provider: 'TEJHQ', exchange: 'NSE',
          isin: 'INE002A01018', priceBasis: basis === 'ADJUSTED' ? 'BACK_ADJUSTED' : 'RAW_UNADJUSTED',
          close: 200, adjustedClose: 100 },
        { tradingDate: '2026-10-16', provider: 'TEJHQ', exchange: 'NSE',
          isin: 'INE002A01018', priceBasis: basis === 'ADJUSTED' ? 'BACK_ADJUSTED' : 'RAW_UNADJUSTED',
          close: 100, adjustedClose: 200 },
      ],
    }));
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    submit();
    const raw = await screen.findByRole('img', { name: 'Raw EOD close from stored qualified observations' });
    expect(within(raw).getByTestId('stored-close-series')).toHaveAttribute('points',
      '16.00,16.00 584.00,134.00');

    fireEvent.change(screen.getByRole('combobox', { name: 'Price basis' }), {
      target: { value: 'ADJUSTED' },
    });
    expect(screen.queryByRole('img', { name: 'Raw EOD close from stored qualified observations' })).not.toBeInTheDocument();
    submit();
    const adjusted = await screen.findByRole('img', { name: 'Adjusted EOD close from stored qualified observations' });
    expect(within(adjusted).getByTestId('stored-close-series')).toHaveAttribute('points',
      '16.00,134.00 584.00,16.00');
  });

  it('does not connect an adjusted series across a missing price', async () => {
    getStoredEquityHistory.mockResolvedValue({ status: 'AVAILABLE', barCount: 2, bars: [
      { tradingDate: '2026-10-15', provider: 'TEJHQ', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'BACK_ADJUSTED', adjustedClose: 100, close: 200 },
      { tradingDate: '2026-10-16', provider: 'TEJHQ', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'BACK_ADJUSTED', adjustedClose: null, close: 210 },
    ] });
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Price basis' }), {
      target: { value: 'ADJUSTED' },
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByText('2 qualified observations')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Adjusted EOD close/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });

  it('does not display facts from an unavailable response or draw across providers', async () => {
    getStoredBenchmarkMarketFacts.mockResolvedValue({ status: 'UNAVAILABLE', facts: [{
      canonicalProductId: 'market:index:nifty-50', availabilityStatus: 'AVAILABLE',
      value: 25123.4567, source: { provider: 'UPSTOX' },
    }] });
    getStoredEquityHistory.mockResolvedValue({ status: 'AVAILABLE', barCount: 2, bars: [
      { tradingDate: '2026-10-15', provider: 'UPSTOX', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'UPSTOX_PROVIDER_NATIVE', close: 123.4567 },
      { tradingDate: '2026-10-16', provider: 'TEJHQ', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'RAW_UNADJUSTED', close: 130 },
    ] });
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    expect(await screen.findByText('No authorized stored benchmark observations are available.')).toBeInTheDocument();
    expect(screen.queryByText('25,123.4567')).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByText('123.4567')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Raw EOD close/ })).not.toBeInTheDocument();
  });

  it('ignores bar payloads when the history status is unavailable', async () => {
    getStoredEquityHistory.mockResolvedValue({ status: 'UNAVAILABLE', code: 'SOURCE_RIGHTS_DENIED',
      barCount: 1, bars: [{ tradingDate: '2026-10-16', provider: 'TEJHQ', close: 9999 }] });
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByText('No qualified retained history: SOURCE_RIGHTS_DENIED')).toBeInTheDocument();
    expect(screen.queryByText('9,999')).not.toBeInTheDocument();
  });

  it('labels Upstox history by its provider-native basis instead of raw', async () => {
    getStoredEquityHistory.mockResolvedValue({ status: 'AVAILABLE', barCount: 2, bars: [
      { tradingDate: '2026-10-15', provider: 'UPSTOX', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'UPSTOX_PROVIDER_NATIVE', close: 100 },
      { tradingDate: '2026-10-16', provider: 'UPSTOX', exchange: 'NSE',
        isin: 'INE002A01018', priceBasis: 'UPSTOX_PROVIDER_NATIVE', close: 101 },
    ] });
    render(<QualifiedMarketEvidencePanel />);
    fireEvent.click(screen.getByRole('button', { name: /View stored prices/ }));
    fireEvent.submit(screen.getByRole('button', { name: 'Read stored history' }).closest('form'));
    expect(await screen.findByRole('img', {
      name: 'Provider-native EOD close from stored qualified observations',
    })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Raw EOD close from stored qualified observations' })).not.toBeInTheDocument();
  });
});
