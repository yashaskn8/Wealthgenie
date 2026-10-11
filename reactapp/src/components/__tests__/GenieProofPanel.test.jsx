import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockApi = vi.hoisted(() => ({
  extractGenieProofClaims: vi.fn(),
  createGenieProofCase: vi.fn(),
  listGenieProofCases: vi.fn(),
  getGenieProofCase: vi.fn(),
  verifyGenieProofCase: vi.fn(),
  listGenieProofRevisions: vi.fn(),
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

  it('shows UTF-8 byte usage and prevents oversized extraction', async () => {
    render(<GenieProofPanel />);
    const offerInput = screen.getByLabelText('Paste the offer text');
    fireEvent.change(offerInput, { target: { value: '₹'.repeat(6000) } });
    const byteStatus = screen.getByRole('status');
    const byteCount = screen.getByText(/18,000 \/ 16,000 UTF-8 bytes/i);
    const extractButton = screen.getByRole('button', { name: /extract claims/i });
    expect(byteStatus).toHaveTextContent(/exceeds the 16,000-byte extraction limit/i);
    expect(byteStatus).toHaveAttribute('aria-live', 'polite');
    expect(offerInput.getAttribute('aria-describedby')).toContain(byteCount.id);
    expect(offerInput.getAttribute('aria-describedby')).toContain(byteStatus.id);
    expect(extractButton).toBeDisabled();
    expect(extractButton.getAttribute('aria-describedby')).toContain(byteCount.id);
    expect(extractButton.getAttribute('aria-describedby')).toContain(byteStatus.id);
    expect(mockApi.extractGenieProofClaims).not.toHaveBeenCalled();
  });

  it('does not silently truncate oversized ASCII offers at the extraction limit', async () => {
    render(<GenieProofPanel />);
    const offerInput = screen.getByLabelText('Paste the offer text');
    const oversizedOffer = 'a'.repeat(16001);
    fireEvent.change(offerInput, { target: { value: oversizedOffer } });

    expect(offerInput).toHaveValue(oversizedOffer);
    expect(screen.getByText(/16,001 \/ 16,000 UTF-8 bytes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /extract claims/i })).toBeDisabled();
    expect(mockApi.extractGenieProofClaims).not.toHaveBeenCalled();
  });

  it('opens saved findings only after a trusted signature is verified', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifest: { revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Not checked against qualified source evidence/)).toBeInTheDocument();
    expect(mockApi.verifyGenieProofCase).toHaveBeenCalledWith(caseId);
  });

  it('clears previously opened signed findings as soon as a new offer is entered', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('heading', { name: /Signed claim record · revision 1/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Paste the offer text'), { target: { value: 'A different offer.' } });
    expect(screen.queryByRole('heading', { name: /Signed claim record · revision 1/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/The stored report signature is verified/i)).not.toBeInTheDocument();
  });

  it('clears the prior integrity state while a new verification request is pending or has failed', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByText(/trusted report-signing key: true/i)).toBeInTheDocument();
    mockApi.verifyGenieProofCase.mockRejectedValueOnce(new Error('Temporary verification failure.'));
    fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary verification failure.');
    expect(screen.queryByText(/trusted report-signing key: true/i)).not.toBeInTheDocument();
  });

  it('loads and displays immutable assessment history with verification state', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const passport = {
      manifestHash: 'c'.repeat(64),
      signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'signature' },
      manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [] },
    };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.listGenieProofRevisions.mockResolvedValue({
      caseId,
      revisions: [{ revision: 1, manifestHash: 'c'.repeat(64), verification: { integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true }, passport }],
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assessment history' }));
    expect(await screen.findByRole('group', { name: 'Assessment history' })).toHaveTextContent('Open revision 1');
    fireEvent.click(screen.getByRole('button', { name: /Open revision 1/ }));
    expect(await screen.findByRole('heading', { name: /Signed claim record · revision 1/ })).toBeInTheDocument();
    expect(mockApi.listGenieProofRevisions).toHaveBeenCalledWith(caseId);
  });

  it('clears a prior case verification status when another case history loads', async () => {
    const caseA = '00000000-0000-4000-8000-000000000001';
    const caseB = '00000000-0000-4000-8000-000000000002';
    let resolveHistory;
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [
      { caseId: caseA, revision: 1, claimCount: 1, manifestHash: 'a'.repeat(64) },
      { caseId: caseB, revision: 1, claimCount: 1, manifestHash: 'b'.repeat(64) },
    ] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifest: { caseId: caseA, revision: 1, confirmedClaims: [], findings: [] } },
    });
    mockApi.listGenieProofRevisions.mockImplementation(() => new Promise(resolve => { resolveHistory = resolve; }));

    render(<GenieProofPanel />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    expect(await screen.findByText(/The stored report signature is verified/i)).toBeInTheDocument();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Assessment history' }))[1]);
    expect(screen.queryByText(/The stored report signature is verified/i)).not.toBeInTheDocument();

    resolveHistory({ caseId: caseB, revisions: [] });
    expect(await screen.findByRole('group', { name: 'Assessment history' })).toBeInTheDocument();
    expect(screen.queryByText(/The stored report signature is verified/i)).not.toBeInTheDocument();
  });

  it('compares two historical revisions only after both trusted signatures verify', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const makeRevision = (revision, finding) => ({
      revision,
      manifestHash: String(revision).repeat(64),
      verification: { integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true },
      passport: {
        manifestHash: String(revision).repeat(64),
        signature: { algorithm: 'Ed25519', keyId: 'test-key', value: `signature-${revision}` },
        manifest: {
          caseId,
          revision,
          confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }],
          findings: [{ claimId: candidate.claimId, finding, reasonCodes: [], explanation: 'Recorded assessment result.' }],
        },
      },
    });
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 2, claimCount: 1, manifestHash: '2'.repeat(64) }] });
    mockApi.listGenieProofRevisions.mockResolvedValue({
      caseId,
      revisions: [makeRevision(2, 'INSUFFICIENT_INPUTS'), makeRevision(1, 'NOT_VERIFIABLE')],
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assessment history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare revision 1 with revision 2' }));

    expect(await screen.findByRole('heading', { name: 'Signed assessment comparison' })).toBeInTheDocument();
    expect(screen.getByText(/Revision 1: Not checked against qualified source evidence/)).toBeInTheDocument();
    expect(screen.getByText(/Revision 2: More product details are needed/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish financial correctness/i)).toBeInTheDocument();
  });

  it('does not compare findings when either historical signature is untrusted', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const makeRevision = (revision, trustedIssuer) => ({
      revision,
      verification: { integrity: trustedIssuer ? 'VALID' : 'CONTENT_HASH_MATCHES', signature: trustedIssuer ? 'VERIFIED' : 'UNVERIFIED', trustedIssuer },
      passport: {
        manifest: {
          caseId,
          revision,
          confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }],
          findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }],
        },
      },
    });
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 2, claimCount: 1, manifestHash: '2'.repeat(64) }] });
    mockApi.listGenieProofRevisions.mockResolvedValue({
      caseId,
      revisions: [makeRevision(2, true), makeRevision(1, false)],
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assessment history' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare revision 1 with revision 2' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/both report signatures and case bindings must verify/i);
    expect(screen.queryByRole('heading', { name: 'Signed assessment comparison' })).not.toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'Download signed claim record' });
    fireEvent.click(screen.getByRole('button', { name: 'Download signed claim record' }));

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
