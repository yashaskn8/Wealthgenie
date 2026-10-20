import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getGenieProofCapabilities } from '../../services/api';
import GenieProofEntry from '../GenieProofEntry';

vi.mock('../../services/api', () => ({ getGenieProofCapabilities: vi.fn() }));
vi.mock('../GenieProofPanel', () => ({
  default: () => <div data-testid="interactive-genieproof">Interactive research panel</div>,
}));

describe('GenieProof server-backed availability', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows the interactive workflow only after authenticated server approval', async () => {
    getGenieProofCapabilities.mockResolvedValue({
      interactiveEnabled: true, mode: 'LOCAL_RESEARCH',
      reasonCode: 'RESEARCH_ONLY_SOURCE_RIGHTS_NOT_QUALIFIED',
      productionVerified: false,
    });
    render(<GenieProofEntry />);
    expect(await screen.findByTestId('interactive-genieproof')).toBeInTheDocument();
    expect(getGenieProofCapabilities).toHaveBeenCalledTimes(1);
  });

  it('shows the restricted preview without loading interactive controls', async () => {
    getGenieProofCapabilities.mockResolvedValue({
      interactiveEnabled: false, mode: 'UNAVAILABLE',
      reasonCode: 'FEATURE_UNAVAILABLE', productionVerified: false,
    });
    render(<GenieProofEntry />);
    expect(await screen.findByText(/interactive operations are disabled on this server/i)).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
  });

  it('fails closed on malformed responses and retries a transport error by user action', async () => {
    getGenieProofCapabilities.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ interactiveEnabled: true, mode: 'LOCAL_RESEARCH', productionVerified: false });
    render(<GenieProofEntry />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/availability could not be checked/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry availability check' }));
    expect(await screen.findByTestId('interactive-genieproof')).toBeInTheDocument();
    expect(getGenieProofCapabilities).toHaveBeenCalledTimes(2);
  });

  it('does not trust a production label as permission to run research operations', async () => {
    getGenieProofCapabilities.mockResolvedValue({
      interactiveEnabled: true, mode: 'PRODUCTION', productionVerified: true,
    });
    render(<GenieProofEntry />);
    expect(await screen.findByText(/interactive operations are disabled/i)).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
  });
});
