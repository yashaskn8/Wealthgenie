import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrivateMarketDemoData } from '../../services/api';
import PrivateMarketDataDemo from './PrivateMarketDataDemo';

vi.mock('../../services/api', () => ({ getPrivateMarketDemoData: vi.fn() }));

describe('PrivateMarketDataDemo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows genuine-provider provenance, timestamps, freshness, and TejHQ EOD labeling', async () => {
    getPrivateMarketDemoData.mockResolvedValue({
      upstox: {
        status: 'AVAILABLE',
        facts: [{
          canonicalProductId: 'market:index:nifty-50',
          displayName: 'NIFTY 50',
          value: 25123.45,
          unit: 'INDEX_POINTS',
          availabilityStatus: 'AVAILABLE',
          quoteLastTradeAt: '2026-10-19T08:45:00.000Z',
          freshness: { status: 'FRESH' },
        }],
      },
      tejHq: {
        status: 'AVAILABLE',
        dataClass: 'HISTORICAL_EOD',
        observedAt: null,
        observedDate: '2026-10-16',
        fetchedAt: '2026-10-19T08:50:00.000Z',
        freshness: { status: 'UNKNOWN' },
        candles: [{ date: '2026-10-16', close: 1534.2 }],
      },
    });

    render(<PrivateMarketDataDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Load provider data' }));

    expect(await screen.findByText('Upstox · live quote response')).toBeInTheDocument();
    expect(screen.getByText('25,123.45 pts')).toBeInTheDocument();
    expect(screen.getByText('TejHQ · historical EOD only')).toBeInTheDocument();
    expect(screen.getByText(/INFY latest returned close:/).textContent).toContain('1,534.2 on 2026-10-16');
    await waitFor(() => expect(getPrivateMarketDemoData).toHaveBeenCalledTimes(1));
  });
});
