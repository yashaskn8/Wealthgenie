import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GenieProofEntry from '../GenieProofEntry';
import { checkGenieProofClaims } from '../../services/api';

vi.mock('../../services/api', () => ({
  checkGenieProofClaims: vi.fn(),
}));

const status = (claims = []) => ({
  ok: true,
  mode: 'READ_ONLY_FINANCIAL_CLAIM_CHECK',
  saved: false,
  allExtractedCandidatesProcessed: true,
  verificationScope: 'DETECTED_CLAIMS_ONLY',
  checkedAt: '2026-10-23T01:00:00.000Z',
  noClaimsFound: claims.length === 0,
  claims,
});

const unverified = {
  claimId: 'a'.repeat(32),
  statement: 'Guaranteed 25% profit.',
  verdict: 'NOT_VERIFIED',
  reasonCode: 'CLAIM_NOT_SUPPORTED',
  explanation: 'An official evidence check is not available.',
  source: null,
  warningSignals: ['Guarantee or risk-free wording needs independently checked product terms.'],
};

describe('GenieProof beginner-facing claim checking', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it('checks an existing statement without passport, consent, signing or saving steps', async () => {
    checkGenieProofClaims.mockResolvedValue(status([unverified]));
    render(<GenieProofEntry />);
    expect(screen.queryByText(/passport/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/signing key/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Financial statement to check'), {
      target: { value: unverified.statement },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByText('Not verified')).toBeInTheDocument();
    expect(screen.getByText(unverified.explanation)).toBeInTheDocument();
    expect(screen.getByText(/not proof of a scam/i)).toBeInTheDocument();
    expect(checkGenieProofClaims).toHaveBeenCalledWith(unverified.statement,
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText(/private passport/i)).not.toBeInTheDocument();
  });

  it('accepts source-backed responses and shows evidence only for verified findings', async () => {
    checkGenieProofClaims.mockResolvedValue(status([{
      claimId: 'b'.repeat(32), statement: 'The current official PPF interest rate is 7.1% p.a.',
      verdict: 'SUPPORTED', reasonCode: 'EXACT_RATE_MATCH', explanation: 'Exact official rate matched.',
      warningSignals: [],
      source: {
        name: 'India Post — Savings',
        url: 'https://www.indiapost.gov.in/banking-services/savings',
        observedRatePercentPerAnnum: 7.1,
        retrievedAt: '2026-10-23T01:00:00.000Z',
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        effectiveTo: '2026-12-31T00:00:00.000Z',
      },
    }]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), { target: { value: 'The current official PPF interest rate is 7.1% p.a.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByText('Supported by evidence')).toBeInTheDocument();
    const source = screen.getByRole('link', { name: /India Post/ });
    expect(source).toHaveAttribute('href', 'https://www.indiapost.gov.in/banking-services/savings');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('rejects unsupported fake-positive responses without approved source and does not show their finding', async () => {
    checkGenieProofClaims.mockResolvedValue(status([{
      ...unverified, verdict: 'SUPPORTED', source: null,
    }]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), { target: { value: 'claim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/i);
    expect(screen.queryByText('Supported by evidence')).not.toBeInTheDocument();
  });

  it('returns no implied safety verdict for text without checkable financial claims', async () => {
    checkGenieProofClaims.mockResolvedValue(status([]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), { target: { value: 'Hello!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByText(/does not establish that an offer is authentic or safe/i)).toBeInTheDocument();
  });

  it('enforces the byte limit including multi-byte currency symbols', () => {
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), {
      target: { value: '₹'.repeat(6000) },
    });
    expect(screen.getByRole('button', { name: 'Check claim' })).toBeDisabled();
    expect(screen.getByText(/18,000 \/ 16,000 bytes/)).toBeInTheDocument();
    expect(checkGenieProofClaims).not.toHaveBeenCalled();
  });

  it('discards pending results when the statement changes', async () => {
    let resolveRequest;
    checkGenieProofClaims.mockImplementation(() => new Promise(resolve => { resolveRequest = resolve; }));
    render(<GenieProofEntry />);
    const field = screen.getByLabelText('Financial statement to check');
    fireEvent.change(field, { target: { value: 'First claim' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Different claim' } });
    resolveRequest(status([unverified]));
    await waitFor(() => expect(screen.queryByText('Not verified')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Check claim' })).toBeEnabled();
  });

  it('shows transport errors without making a financial conclusion', async () => {
    checkGenieProofClaims.mockRejectedValue(new Error('network unavailable'));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), { target: { value: 'PPF rate?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No financial conclusion was reached/i);
  });
});
