import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockApi = vi.hoisted(() => ({
  extractGenieProofClaims: vi.fn(),
  createGenieProofCase: vi.fn(),
  listGenieProofCases: vi.fn(),
  getGenieProofCase: vi.fn(),
  verifyGenieProofCase: vi.fn(),
  deleteGenieProofCase: vi.fn(),
}));

vi.mock('../../services/api', () => mockApi);
import GenieProofPanel from '../GenieProofPanel';

const offerText = 'The current official PPF interest rate is 7.1% p.a.';
const candidate = {
  claimId: 'a'.repeat(32),
  originalSpan: offerText,
  claimType: 'CURRENT_NOMINAL_RATE',
  productId: 'government:india-post:ppf',
  value: 7.1,
  unit: 'PERCENT_PER_ANNUM',
  candidateReasonCodes: [],
};

describe('GenieProofPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [] });
    mockApi.extractGenieProofClaims.mockResolvedValue({
      inputHash: 'b'.repeat(64),
      claims: [candidate],
      requiresCustomerConfirmation: true,
      rawOfferRetained: false,
    });
    mockApi.createGenieProofCase.mockResolvedValue({
      created: true,
      case: { caseId: '00000000-0000-4000-8000-000000000001', revision: 1 },
      passport: {
        manifestHash: 'c'.repeat(64),
        manifest: {
          caseId: '00000000-0000-4000-8000-000000000001',
          revision: 1,
          confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }],
          findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: ['SOURCE_REUSE_PERMISSION_UNVERIFIED'], explanation: 'Required evidence was not qualified.' }],
        },
      },
    });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      integrity: 'VALID',
      signature: 'VERIFIED',
      trustedIssuer: true,
      financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requires a customer review and creates an abstaining passport without claiming financial correctness', async () => {
    render(<GenieProofPanel />);
    await waitFor(() => expect(mockApi.listGenieProofCases).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Paste the offer text'), { target: { value: offerText } });
    fireEvent.click(screen.getByRole('button', { name: /extract claims/i }));
    expect(await screen.findByLabelText('Claim wording')).toHaveValue(offerText);
    expect(screen.getByLabelText('Claim wording')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: /save private passport/i })).toBeDisabled();

    fireEvent.click(screen.getByLabelText('I reviewed the exact wording and interpretation above.'));
    expect(screen.getByRole('button', { name: /save private passport/i })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I consent to save the confirmed claim wording/i));
    fireEvent.click(screen.getByRole('button', { name: /save private passport/i }));
    await waitFor(() => expect(mockApi.createGenieProofCase).toHaveBeenCalledOnce());
    expect(mockApi.createGenieProofCase).toHaveBeenCalledWith({
      offerText,
      submissionHash: 'b'.repeat(64),
      savingConsent: true,
      confirmedClaims: [{
        claimId: candidate.claimId,
        statement: offerText,
        claimType: 'CURRENT_NOMINAL_RATE',
        productId: 'government:india-post:ppf',
        value: 7.1,
        unit: 'PERCENT_PER_ANNUM',
      }],
    });
    expect(screen.queryByText('NOT_VERIFIABLE', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/verify its trusted signature before viewing findings/i)).toBeInTheDocument();
    expect(screen.getByText(/ProofBreak monitoring is disabled/i)).toBeInTheDocument();
  });

  it('blocks saving when extraction omitted claims beyond its review limit', async () => {
    mockApi.extractGenieProofClaims.mockResolvedValueOnce({
      inputHash: 'b'.repeat(64),
      claims: [candidate],
      claimsTruncated: true,
      omittedClaimCount: 2,
      requiresCustomerConfirmation: true,
      rawOfferRetained: false,
    });
    render(<GenieProofPanel />);
    fireEvent.change(screen.getByLabelText('Paste the offer text'), { target: { value: offerText } });
    fireEvent.click(screen.getByRole('button', { name: /extract claims/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/2 additional claim statement\(s\)/i);
    fireEvent.click(screen.getByLabelText('I reviewed the exact wording and interpretation above.'));
    fireEvent.click(screen.getByLabelText(/I consent to save the confirmed claim wording/i));
    expect(screen.getByRole('button', { name: /save private passport/i })).toBeDisabled();
    expect(mockApi.createGenieProofCase).not.toHaveBeenCalled();
  });

  it('opens saved findings only after a trusted signature is verified', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifest: { revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText('NOT_VERIFIABLE', { exact: true })).toBeInTheDocument();
    expect(mockApi.verifyGenieProofCase).toHaveBeenCalledWith(caseId);
  });

  it('withholds saved findings when the signature is not trusted', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifest: { revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'SUPPORTED', reasonCodes: [], explanation: 'Forged.' }] } },
    });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      integrity: 'CONTENT_HASH_MATCHES', signature: 'UNVERIFIED', trustedIssuer: false,
      financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/trusted key.*findings.*hidden/i);
    expect(screen.queryByText('SUPPORTED', { exact: true })).not.toBeInTheDocument();
  });

  it('downloads only the opened signed passport as an explicit JSON export', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: {
        manifestHash: 'c'.repeat(64),
        signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'signature' },
        manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [] },
      },
    });
    const createObjectURL = vi.fn(() => 'blob:genieproof-passport');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByRole('button', { name: 'Download signed passport' });
    fireEvent.click(screen.getByRole('button', { name: 'Download signed passport' }));

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.contexts[0].download).toBe(`wealthgenie-genieproof-${caseId}-r1.json`);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:genieproof-passport');
  });

  it('requires a second confirmation before permanently deleting a passport', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.deleteGenieProofCase.mockResolvedValue({});
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete passport revision 1' }));
    expect(mockApi.deleteGenieProofCase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockApi.deleteGenieProofCase).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete passport revision 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete case and revisions' }));
    await waitFor(() => expect(mockApi.deleteGenieProofCase).toHaveBeenCalledWith(caseId));
  });

  it('makes the opt-in monitor unavailable until its source and worker gates are qualified', async () => {
    render(<GenieProofPanel />);
    expect(await screen.findByText(/ProofBreak monitoring is disabled until a reviewed source contract/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enable monitoring/i })).not.toBeInTheDocument();
  });
});
