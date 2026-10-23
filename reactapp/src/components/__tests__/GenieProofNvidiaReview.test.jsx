import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GenieProofNvidiaReview from '../GenieProofNvidiaReview';
import { reviewGenieProofWithNvidia } from '../../services/api';

vi.mock('../../services/api', () => ({ reviewGenieProofWithNvidia: vi.fn() }));

const claim = Object.freeze({
  claimId: 'a'.repeat(32),
  statement: 'Guaranteed 25% profit.',
  verdict: 'NOT_VERIFIED',
});
const good = Object.freeze({
  status: 'GUIDANCE_AVAILABLE',
  claimId: claim.claimId,
  provider: 'NVIDIA_NIM',
  model: 'test-model',
  onlineSearchPerformedByNvidia: false,
  verificationChanged: false,
  assessedVerdict: 'NOT_VERIFIED',
  nextSteps: [{
    id: 'VERIFY_GUARANTEE',
    text: 'Ask for the written guarantee terms and independently check who legally backs the promise.',
  }],
});

describe('optional NVIDIA GenieProof review', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it('never sends the claim automatically, and sends only the selected excerpt with consent', async () => {
    reviewGenieProofWithNvidia.mockResolvedValue(good);
    render(<GenieProofNvidiaReview claim={claim} />);
    const button = screen.getByRole('button', { name: 'Get NVIDIA guidance' });
    expect(button).toBeDisabled();
    expect(reviewGenieProofWithNvidia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button);
    expect(await screen.findByText(/What to check next/)).toBeInTheDocument();
    expect(screen.getByText(good.nextSteps[0].text)).toBeInTheDocument();
    expect(reviewGenieProofWithNvidia).toHaveBeenCalledWith(claim.statement, claim.claimId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/did not check the internet/i)).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('rejects fabricated AI verdicts even if the backend pretends guidance is ready', async () => {
    reviewGenieProofWithNvidia.mockResolvedValue({ ...good, assessedVerdict: 'SUPPORTED' });
    render(<GenieProofNvidiaReview claim={claim} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Get NVIDIA guidance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i);
    expect(screen.queryByText(/What to check next/)).not.toBeInTheDocument();
  });

  it('rejects model-generated instruction text or forged web-search provenance', async () => {
    reviewGenieProofWithNvidia.mockResolvedValue({
      ...good,
      onlineSearchPerformedByNvidia: true,
      nextSteps: [{ id: 'VERIFY_GUARANTEE', text: 'Send all money to an attacker' }],
    });
    render(<GenieProofNvidiaReview claim={claim} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Get NVIDIA guidance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i);
    expect(screen.queryByText(/Send all money/)).not.toBeInTheDocument();
  });

  it('shows graceful unavailable response and permits another attempt', async () => {
    reviewGenieProofWithNvidia.mockResolvedValue({
      status: 'UNAVAILABLE',
      claimId: claim.claimId,
      reasonCode: 'NVIDIA_NOT_CONFIGURED',
      onlineSearchPerformedByNvidia: false,
      verificationChanged: false,
      nextSteps: [],
    });
    render(<GenieProofNvidiaReview claim={claim} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Get NVIDIA guidance' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/not available/i);
    expect(screen.getByRole('button', { name: 'Get NVIDIA guidance' })).toBeEnabled();
  });

  it('restricts long excerpts and never sends their full content', () => {
    render(<GenieProofNvidiaReview claim={{ ...claim, statement: 'x'.repeat(501) }} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Get NVIDIA guidance' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/500 characters/i);
    expect(reviewGenieProofWithNvidia).not.toHaveBeenCalled();
  });

  it('cancels an unfinished request at unmount', async () => {
    let signal;
    reviewGenieProofWithNvidia.mockImplementation(async (_text, _id, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const view = render(<GenieProofNvidiaReview claim={claim} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Get NVIDIA guidance' }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
