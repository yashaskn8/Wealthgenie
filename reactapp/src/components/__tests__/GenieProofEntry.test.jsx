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


  it('makes supported syntax discoverable without submitting or claiming a verified rate', () => {
    render(<GenieProofEntry />);
    expect(screen.getByText('Current capability')).toBeInTheDocument();
    expect(screen.getByText('Detect the claim')).toBeInTheDocument();
    expect(screen.getByText('Check the evidence')).toBeInTheDocument();
    expect(screen.getByText('Explain the result')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try supported wording' }));
    expect(screen.getByLabelText('Financial statement to check')).toHaveValue(
      'The current official PPF interest rate is 7.1% p.a.');
    expect(checkGenieProofClaims).not.toHaveBeenCalled();
    expect(screen.queryByText('Supported by evidence')).not.toBeInTheDocument();
  });

  it('shows dated-claim limitations instead of a generic evidence failure', async () => {
    const statement="As of 1 November 2026, India's Public Provident Fund (PPF) annual interest rate is 7.1%.";
    checkGenieProofClaims.mockResolvedValue(status([{
      claimId:'f'.repeat(32), statement, verdict:'NOT_VERIFIED',
      reasonCode:'CLAIM_DATE_OUTSIDE_CURRENT_SCOPE',
      explanation:'This is a dated claim, not checked.',
      source:null, warningSignals:[],
    }]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'),{
      target:{value:statement},
    });
    fireEvent.click(screen.getByRole('button',{name:'Check claim'}));
    expect(await screen.findByText('Date-specific statement not supported')).toBeInTheDocument();
    expect(screen.getByText(/current-rate verifier does not certify historical/i)).toBeInTheDocument();
    expect(screen.getByText(/1 without a verified conclusion/)).toBeInTheDocument();
    expect(screen.queryByText('Supported by evidence')).not.toBeInTheDocument();
  });

  it('honestly explains disabled official evidence even for exact current PPF wording', async () => {
    const statement='The current official PPF interest rate is 7.1% p.a.';
    checkGenieProofClaims.mockResolvedValue(status([{
      claimId:'c'.repeat(32), statement, verdict:'NOT_VERIFIED',
      reasonCode:'NO_TRUSTED_EVIDENCE_VERIFIER',
      explanation:'We cannot confirm this claim with an approved official source right now.',
      source:null, warningSignals:[],
    }]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'),{
      target:{value:statement},
    });
    fireEvent.click(screen.getByRole('button',{name:'Check claim'}));
    expect(await screen.findByText('Evidence verifier unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Even a correct number cannot be marked verified/)).toBeInTheDocument();
  });

  it('blocks PAN, labelled Aadhaar and bank account identifiers before the API request', () => {
    render(<GenieProofEntry />);
    const field = screen.getByLabelText('Financial statement to check');
    for (const claim of [
      "My PAN ABCDE 1234 F promises 12% interest.",
      "My Aadhaar: १२३४-५६७८-९०१२ for 8% guaranteed returns.",
      "The document has ID 1234 5678 9012 and advertises 10% returns.",
      "My account 12 3456 7890 1234 gets 9% interest.",
      "Transfer funds to payment@okaxis at 10%.",
      "For a guaranteed return please email joe@example.com.",
      "My mobile number: 9876543210 is tied to that offer.",
      "Call +91 9876543210 to get 20% guaranteed returns.",
      "The statement contains hidden ABCDE​1234F PAN and 12% interest.",
      'My PAN ABCDE1234F earned 20%.',
      'Aadhaar 1234-5678-9012 receives guaranteed profits.',
      'Bank account number: 123456789012 offers 10% income.',
    ]) {
      fireEvent.change(field, { target: { value: claim } });
      expect(screen.getByRole('button', { name: 'Check claim' })).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(/personal identifier/i);
    }
    expect(checkGenieProofClaims).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'The PPF rate is claimed to be 8%.' } });
    expect(screen.getByRole('button', { name: 'Check claim' })).toBeEnabled();
    expect(screen.getByText(/only a precisely worded current PPF/i)).toBeInTheDocument();
  });

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
    expect(screen.getByRole('status')).toHaveTextContent(/No verdict is available yet/i);
    expect(screen.getByRole('form', { name: 'Financial claim check' })).toHaveAttribute('aria-busy', 'true');
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

  it('rejects a verdict that belongs to another user statement', async () => {
    checkGenieProofClaims.mockResolvedValue(status([unverified]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), {
      target: { value: 'An FD promises 18%.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/i);
    expect(screen.queryByText('Not verified', { exact: true })).not.toBeInTheDocument();
  });

  it('rejects duplicated claim identifiers and inconsistent empty-result metadata', async () => {
    checkGenieProofClaims.mockResolvedValueOnce(status([unverified, { ...unverified }]))
      .mockResolvedValueOnce({ ...status([]), noClaimsFound: false });
    render(<GenieProofEntry />);
    const field = screen.getByLabelText('Financial statement to check');
    fireEvent.change(field, { target: { value: unverified.statement + '\n' + unverified.statement } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/i);
    fireEvent.change(field, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/i);
  });

  it('rejects fake, stale or non-applicable source metadata even with a positive status', async () => {
    const official = 'The current official PPF interest rate is 7.1% p.a.';
    const source = {
      name: 'India Post — Savings',
      url: 'https://www.indiapost.gov.in/banking-services/savings',
      observedRatePercentPerAnnum: 7.1,
      retrievedAt: '2026-10-01T01:00:00.000Z',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: '2026-12-31T00:00:00.000Z',
    };
    checkGenieProofClaims.mockResolvedValue(status([{
      claimId: 'e'.repeat(32), statement: official, verdict: 'SUPPORTED',
      reasonCode: 'EXACT_RATE_MATCH', explanation: 'A source was reported.',
      warningSignals: [], source,
    }]));
    render(<GenieProofEntry />);
    fireEvent.change(screen.getByLabelText('Financial statement to check'), { target: { value: official } });
    fireEvent.click(screen.getByRole('button', { name: 'Check claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be checked/i);
    expect(screen.queryByText('Supported by evidence')).not.toBeInTheDocument();
  });

});
