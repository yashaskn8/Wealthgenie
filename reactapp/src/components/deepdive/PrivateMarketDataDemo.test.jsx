import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrivateMarketDemoData } from '../../services/api';
import PrivateMarketDataDemo from './PrivateMarketDataDemo';

vi.mock('../../services/api', () => ({ getPrivateMarketDemoData: vi.fn() }));

describe('PrivateMarketDataDemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the authenticated local preview on mount when the market card requests it', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'AVAILABLE',
      upstox: { status: 'AVAILABLE', facts: [] },
    });

    render(<PrivateMarketDataDemo autoLoad />);

    expect(await screen.findByText('Upstox · market quote response')).toBeInTheDocument();
    expect(getPrivateMarketDemoData).toHaveBeenCalledTimes(1);
    expect(getPrivateMarketDemoData.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('does not make private Upstox requests before explicit user action', () => {
    render(<PrivateMarketDataDemo />);
    expect(screen.getByRole('button', { name: 'Load Upstox quotes' })).toBeInTheDocument();
    expect(getPrivateMarketDemoData).not.toHaveBeenCalled();
  });

  it('renders the actual backend quote contract with timestamps and provenance', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'AVAILABLE',
      mode: 'AUTHENTICATED_LOOPBACK_PRIVATE_DEMO',
      persistence: 'NOT_PERSISTED',
      fetchedAt: '2026-10-19T08:50:00.000Z',
      upstox: {
        status: 'AVAILABLE',
        provider: 'UPSTOX',
        facts: [{
          canonicalProductId: 'market:index:nifty-50',
          value: 25123.45,
          unit: 'INDEX_POINTS',
          availabilityStatus: 'AVAILABLE',
          source: { provider: 'UPSTOX', instrumentId: 'NSE_INDEX|Nifty 50' },
          observedAt: '2026-10-19T08:45:00.000Z',
          quoteLastTradeAt: '2026-10-19T08:45:00.000Z',
          quoteResponseGeneratedAt: '2026-10-19T08:49:00.000Z',
          providerResponseReceivedAt: '2026-10-19T08:50:00.000Z',
          fetchedAt: '2026-10-19T08:50:00.000Z',
          freshness: { status: 'FRESH' },
        }],
        cache: { hit: false, backend: 'NONE', status: 'PRIVATE_DEMO_NO_STORE' },
      },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));

    expect(await screen.findByText('Upstox · market quote response')).toBeInTheDocument();
    expect(screen.getByText('25,123.45 pts')).toBeInTheDocument();
    expect(screen.getByText('NIFTY 50')).toBeInTheDocument();
    expect(screen.getByText(/Last trade: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Provider response: 19 Oct 2026/)).toBeInTheDocument();
    expect(within(screen.getByTestId('private-quote-market:index:nifty-50'))
      .getByText(/Fetched: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Storage: NOT_PERSISTED/)).toBeInTheDocument();
    await waitFor(() => expect(getPrivateMarketDemoData).toHaveBeenCalledTimes(1));
  });

  it('shows the exact ETF exchange quote separately from index observations', async () => {
    const onSnapshot = vi.fn();
    const response = {
      persistence: 'NOT_PERSISTED',
      upstox: { status: 'AVAILABLE', facts: [{
        canonicalProductId: 'etf:isin:INF204KB14I2',
        displayName: 'Nippon India ETF Nifty 50 BeES',
        availabilityStatus: 'AVAILABLE', value: 294.4, unit: 'PRICE', currency: 'INR',
        freshness: { status: 'STALE' },
      }] },
    };
    getPrivateMarketDemoData.mockResolvedValue(response);
    render(<PrivateMarketDataDemo onSnapshot={onSnapshot} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));
    const quote = await screen.findByTestId('private-quote-etf:isin:INF204KB14I2');
    expect(within(quote).getByText('Nippon India ETF Nifty 50 BeES')).toBeInTheDocument();
    expect(within(quote).getByText('294.4 INR')).toBeInTheDocument();
    expect(within(quote).getByText('STALE')).toBeInTheDocument();
    expect(onSnapshot).toHaveBeenLastCalledWith(response);
  });

  it('never displays a quote from an unavailable provider even when malformed facts contain prices', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      upstox: {
        status: 'UNAVAILABLE',
        facts: [{ canonicalProductId: 'market:index:nifty-50', availabilityStatus: 'AVAILABLE',
          value: 25123.45, unit: 'INDEX_POINTS' }],
      },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));

    expect(await screen.findByText('Upstox · market quote response')).toBeInTheDocument();
    expect(within(screen.getByTestId('private-quote-market:index:nifty-50'))
      .getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/25,123\.45/)).not.toBeInTheDocument();
  });

  it('does not attach a price unit to a malformed available quote', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      persistence: 'NOT_PERSISTED',
      upstox: { status: 'PARTIAL', facts: [{
        canonicalProductId: 'market:index:india-vix',
        availabilityStatus: 'AVAILABLE', value: null, unit: 'INDEX_POINTS',
      }] },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));

    const quote = await screen.findByTestId('private-quote-market:index:india-vix');
    expect(within(quote).getByText('Unavailable')).toBeInTheDocument();
    expect(within(quote).queryByText(/Unavailable pts/)).not.toBeInTheDocument();
  });
});

describe('PrivateMarketDataDemo expo failure diagnostics', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['PROVIDER_NOT_CONFIGURED', /token is missing/i],
    ['UPSTOX_AUTHENTICATION_FAILED', /rejected the server token/i],
    ['UPSTOX_PERMISSION_DENIED', /denied this read-only/i],
    ['UPSTOX_RATE_LIMITED', /rate-limited/i],
    ['UPSTOX_NETWORK_ERROR', /could not reach Upstox/i],
    ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED', /Source permissions do not allow/i],
  ])('displays safe actionable backend reason %s without echoing arbitrary messages', async (code, expected) => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'UNAVAILABLE',
      upstox: { status: 'SOURCE_ERROR', facts: [], error: { code, message: 'SENSITIVE-UPSTREAM-TOKEN' } },
    });
    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText(/SENSITIVE-UPSTREAM-TOKEN/)).not.toBeInTheDocument();
  });

  it('does not crash or show malformed data as a price', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'PARTIAL',
      upstox: { status: 'PARTIAL', facts: [null,
        { canonicalProductId: 'market:index:nifty-50', value: '25123.4',
          availabilityStatus: 'AVAILABLE', source: { instrumentId: 17 } }] },
    });
    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));
    const card = await screen.findByTestId('private-quote-market:index:nifty-50');
    expect(within(card).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('25,123.4 pts')).not.toBeInTheDocument();
    expect(await screen.findByText(/Only some Upstox instruments/i)).toBeInTheDocument();
  });

  it('labels historical trades as not-current instead of presenting stale prices as live', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'AVAILABLE',
      upstox: { status: 'AVAILABLE', facts: [{ canonicalProductId: 'market:index:nifty-50',
        availabilityStatus: 'AVAILABLE', value: 25000, unit: 'INDEX_POINTS',
        freshness: { status: 'STALE', ageSeconds: 9000 } }] },
    });
    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));
    expect(await screen.findByText(/not a current live quote/i)).toBeInTheDocument();
    expect(screen.getByText('25,000 pts')).toBeInTheDocument();
  });

  it('fails gracefully when the private demo response has no valid Upstox envelope', async () => {
    getPrivateMarketDemoData.mockResolvedValue({ status: 'AVAILABLE', upstox: null });
    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load Upstox quotes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Provider data could not be loaded/i);
  });
});
