import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrivateMarketDemoData } from '../../services/api';
import PrivateMarketDataDemo from './PrivateMarketDataDemo';

vi.mock('../../services/api', () => ({ getPrivateMarketDemoData: vi.fn() }));

describe('PrivateMarketDataDemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the actual backend quote contract and keeps unqualified TejHQ EOD unavailable', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      status: 'PARTIAL',
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
      tejHq: {
        provider: 'TEJHQ',
        status: 'UNAVAILABLE',
        dataClass: 'HISTORICAL_EOD',
        observedAt: null,
        checkedAt: '2026-10-19T08:50:00.000Z',
        freshness: { status: 'UNKNOWN' },
        candles: [],
        sourceRights: { status: 'LICENSE_UNVERIFIED', sourceId: 'TEJHQ_RAW_EOD' },
        error: { code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
        reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'],
        cache: { hit: false, backend: 'NONE', status: 'PRIVATE_DEMO_NO_STORE' },
      },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load provider data' }));

    expect(await screen.findByText('Upstox · live quote response')).toBeInTheDocument();
    expect(screen.getByText('25,123.45 pts')).toBeInTheDocument();
    expect(screen.getByText('NIFTY 50')).toBeInTheDocument();
    expect(screen.getByText(/Last trade: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Provider response: 19 Oct 2026/)).toBeInTheDocument();
    expect(within(screen.getByTestId('private-quote-market:index:nifty-50'))
      .getByText(/Fetched: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText('TejHQ · historical EOD only')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Historical EOD unavailable: MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
    expect(screen.getByText(/Rights checked: 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Storage: NOT_PERSISTED/)).toHaveTextContent('PRIVATE_DEMO_NO_STORE');
    expect(screen.queryByText(/1,534.2/)).not.toBeInTheDocument();
    await waitFor(() => expect(getPrivateMarketDemoData).toHaveBeenCalledTimes(1));
  });

  it('labels returned TejHQ candles by their trading date and keeps the history historical', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      persistence: 'NOT_PERSISTED',
      upstox: { status: 'UNAVAILABLE', facts: [] },
      tejHq: {
        status: 'AVAILABLE',
        dataClass: 'HISTORICAL_EOD',
        observedAt: null,
        fetchedAt: '2026-10-19T08:50:00.000Z',
        freshness: { status: 'UNKNOWN' },
        candles: [{ date: '2026-10-16', close: 1534.2 }],
      },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load provider data' }));

    expect(await screen.findByText('TejHQ · historical EOD only')).toBeInTheDocument();
    expect(screen.getByText(/INFY latest returned close:/).textContent).toContain('1,534.2 on 2026-10-16');
    expect(screen.getByText(/Trading date: 2026-10-16/)).toBeInTheDocument();
  });
});
