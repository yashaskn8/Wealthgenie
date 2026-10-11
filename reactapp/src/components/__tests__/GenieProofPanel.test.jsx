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
  reassessGenieProofCase: vi.fn(),
  withdrawGenieProofConsent: vi.fn(),
  getProofWatchAvailability: vi.fn(),
  createProofWatch: vi.fn(),
  listProofWatches: vi.fn(),
  updateProofWatch: vi.fn(),
  deleteProofWatch: vi.fn(),
  listProofBreakEvents: vi.fn(),
  acknowledgeProofBreakEvent: vi.fn(),
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
    mockApi.getProofWatchAvailability.mockResolvedValue({ caseId: '00000000-0000-4000-8000-000000000001', workerStatus: 'UNAVAILABLE', canEnable: false, sourceStatus: 'RIGHTS_BLOCKED', monitoringScope: 'Only exact current nominal PPF annual-rate claims are currently supported.', claims: [] });
    mockApi.listProofWatches.mockResolvedValue({ watches: [] });
    mockApi.listProofBreakEvents.mockResolvedValue({ events: [], nextCursor: null });
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
      revision: 1,
      manifestHash: 'c'.repeat(64),
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
    expect(screen.getByText(/ProofBreak availability is checked for each saved case/i)).toBeInTheDocument();
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
      passport: { manifestHash: 'c'.repeat(64), manifest: { caseId, revision: 1, verifierVersion: 'genieproof-evidence-bound/0.5.0', confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Not checked against qualified source evidence/)).toBeInTheDocument();
    expect(mockApi.verifyGenieProofCase).toHaveBeenCalledWith(caseId);
  });

  it('retries when case details and verification report different signed heads', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const revisionOne = { passport: { manifestHash: '1'.repeat(64), manifest: { caseId, revision: 1, confirmedClaims: [], findings: [] } } };
    const revisionTwo = { passport: { manifestHash: '2'.repeat(64), manifest: { caseId, revision: 2, confirmedClaims: [], findings: [] } } };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 2, claimCount: 0, manifestHash: '2'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValueOnce(revisionOne).mockResolvedValueOnce(revisionTwo);
    mockApi.verifyGenieProofCase
      .mockResolvedValueOnce({ revision: 2, manifestHash: '2'.repeat(64), integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true })
      .mockResolvedValueOnce({ revision: 2, manifestHash: '2'.repeat(64), integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByRole('heading', { name: /Signed claim record · revision 2/ })).toBeInTheDocument();
    expect(mockApi.getGenieProofCase).toHaveBeenCalledTimes(2);
    expect(mockApi.verifyGenieProofCase).toHaveBeenCalledTimes(2);
  });

  it('requires fresh reassessment consent after switching to another saved passport', async () => {
    const caseA = '00000000-0000-4000-8000-000000000001';
    const caseB = '00000000-0000-4000-8000-000000000002';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [
      { caseId: caseA, revision: 1, claimCount: 1, manifestHash: 'a'.repeat(64) },
      { caseId: caseB, revision: 1, claimCount: 1, manifestHash: 'b'.repeat(64) },
    ] });
    mockApi.getGenieProofCase.mockImplementation(async caseId => ({
      passport: { manifestHash: `${caseId === caseA ? 'a' : 'b'}`.repeat(64), manifest: { caseId, revision: 1, confirmedClaims: [], findings: [] } },
    }));
    mockApi.verifyGenieProofCase.mockImplementation(async caseId => ({
      revision: 1,
      manifestHash: `${caseId === caseA ? 'a' : 'b'}`.repeat(64),
      integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true,
    }));

    render(<GenieProofPanel />);
    const [openA, openB] = await screen.findAllByRole('button', { name: 'Open' });
    fireEvent.click(openA);
    await screen.findByRole('heading', { name: /Signed claim record · revision 1/ });
    const consent = screen.getByLabelText(/I consent to a new private assessment/i);
    fireEvent.click(consent);
    expect(screen.getByRole('button', { name: 'Create new assessment' })).toBeEnabled();

    fireEvent.click(openB);
    await waitFor(() => expect(mockApi.getGenieProofCase).toHaveBeenLastCalledWith(caseB));
    await screen.findByRole('heading', { name: /Signed claim record · revision 1/ });
    expect(screen.getByLabelText(/I consent to a new private assessment/i)).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Create new assessment' })).toBeDisabled();
    expect(mockApi.reassessGenieProofCase).not.toHaveBeenCalled();
  });

  it('clears previously opened signed findings as soon as a new offer is entered', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifestHash: 'c'.repeat(64), manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
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

  it('preserves trusted legacy findings without presenting them as current financial verdicts', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const passport = {
      manifestHash: 'c'.repeat(64),
      signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'legacy-signature' },
      manifest: {
        caseId,
        revision: 1,
        verifierVersion: 'genieproof-evidence-bound/0.4.0',
        confirmedClaims: [{ claimId: candidate.claimId, statement: 'The PPF interest rate is no longer 7.1% p.a.' }],
        findings: [{ claimId: candidate.claimId, finding: 'SUPPORTED', reasonCodes: [], explanation: 'Recorded by the historical verifier.' }],
      },
    };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.listGenieProofRevisions.mockResolvedValue({
      caseId,
      revisions: [{ revision: 1, manifestHash: 'c'.repeat(64), verification: { integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true }, passport }],
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Assessment history' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open revision 1/ }));

    expect(await screen.findByRole('note')).toHaveTextContent(/historical verifier output.*not reassessed under current claim rules/i);
    expect(screen.getByText(/Historical verifier output; not reassessed under current claim rules/)).toBeInTheDocument();
    expect(screen.queryByText(/available qualified evidence supports this claim/i)).not.toBeInTheDocument();
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
      passport: { manifestHash: 'a'.repeat(64), manifest: { caseId: caseA, revision: 1, confirmedClaims: [], findings: [] } },
    });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      revision: 1, manifestHash: 'a'.repeat(64), integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true,
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
          verifierVersion: 'genieproof-evidence-bound/0.5.0',
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
      passport: { manifestHash: 'c'.repeat(64), manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'SUPPORTED', reasonCodes: [], explanation: 'Forged.' }] } },
    });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      revision: 1, manifestHash: 'c'.repeat(64),
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

  it('shows source-rights and worker blockers before asking for monitoring consent', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({
      caseId, workerStatus: 'UNAVAILABLE', canEnable: false, sourceStatus: 'RIGHTS_BLOCKED',
      monitoringScope: 'Only exact current nominal PPF annual-rate claims are currently supported.',
      claims: [{ claimId: candidate.claimId, claimType: 'CURRENT_NOMINAL_RATE', productId: candidate.productId, status: 'SOURCE_RIGHTS_BLOCKED' }],
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    expect(await screen.findByText(/official source reuse approval is not recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/monitoring worker: unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enable ProofBreak checks/i })).not.toBeInTheDocument();
    expect(mockApi.createProofWatch).not.toHaveBeenCalled();
  });

  it('requires separate consent before enabling an available watch and displays its persisted timeline', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({
      caseId, workerStatus: 'AVAILABLE', canEnable: true, sourceStatus: 'AVAILABLE',
      monitoringScope: 'Only exact current nominal PPF annual-rate claims are currently supported.',
      claims: [{ claimId: candidate.claimId, claimType: 'CURRENT_NOMINAL_RATE', productId: candidate.productId, status: 'AVAILABLE' }],
    });
    mockApi.createProofWatch.mockResolvedValue({ created: true, watch: { watchId: '00000000-0000-4000-8000-000000000002', status: 'ACTIVE' } });
    mockApi.listProofWatches.mockResolvedValueOnce({ watches: [] }).mockResolvedValue({ watches: [{ watchId: '00000000-0000-4000-8000-000000000002', status: 'ACTIVE', lastSuccessfulCheckAt: null, nextCheckAt: '2026-10-11T18:00:00.000Z' }] });
    mockApi.listProofBreakEvents.mockResolvedValue({ events: [
      { eventId: '00000000-0000-4000-8000-000000000003', eventType: 'EVIDENCE_CHANGED', detectedAt: '2026-10-11T12:00:00.000Z', notificationStatus: 'DELIVERED', acknowledgedAt: null },
      { eventId: '00000000-0000-4000-8000-000000000004', eventType: 'PROCESSING_FAILED', detectedAt: '2026-10-11T12:01:00.000Z', notificationStatus: 'FAILED', acknowledgedAt: null },
    ], nextCursor: null });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    await waitFor(() => expect(mockApi.getProofWatchAvailability).toHaveBeenCalledWith(caseId));
    expect(screen.getByRole('region', { name: /ProofBreak status and timeline/i })).toHaveTextContent(/A source is qualified/);
    const enable = await screen.findByRole('button', { name: /Enable ProofBreak checks/i });
    expect(enable).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I consent to periodic checks of these supported claims/i));
    fireEvent.click(enable);
    await waitFor(() => expect(mockApi.createProofWatch).toHaveBeenCalledWith(caseId));
    expect(await screen.findByText(/a qualified financial fact changed/i)).toBeInTheDocument();
    expect(screen.getByText(/Timeline update: published in this account/i)).toBeInTheDocument();
    expect(screen.getByText(/A background check could not be completed/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Mark reviewed/i })).toHaveLength(2);
  });

  it('retains the watch timeline on refresh when consent withdrawal makes availability unavailable', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const cancelledWatch = { watchId: '00000000-0000-4000-8000-000000000002', status: 'CANCELLED' };
    const event = { eventId: '00000000-0000-4000-8000-000000000003', eventType: 'EVIDENCE_CHANGED', detectedAt: '2026-10-11T12:00:00.000Z', notificationStatus: 'PENDING', acknowledgedAt: null };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability
      .mockResolvedValueOnce({ caseId, workerStatus: 'UNAVAILABLE', canEnable: false, sourceStatus: 'RIGHTS_BLOCKED', monitoringScope: 'PPF only', claims: [] })
      .mockRejectedValue(new Error('Consent is no longer active.'));
    mockApi.listProofWatches
      .mockResolvedValueOnce({ watches: [{ ...cancelledWatch, status: 'ACTIVE' }] })
      .mockResolvedValue({ watches: [cancelledWatch] });
    mockApi.listProofBreakEvents.mockResolvedValue({ events: [event], nextCursor: null });
    mockApi.withdrawGenieProofConsent.mockResolvedValue({});

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    await screen.findByRole('button', { name: /Withdraw private processing consent/i });
    fireEvent.click(screen.getByRole('button', { name: /Withdraw private processing consent/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm withdrawal/i }));
    await screen.findByText(/Private processing consent was withdrawn/i);

    fireEvent.click(screen.getByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    await waitFor(() => expect(region).toHaveTextContent(/watch status: cancelled/i));
    expect(region).toHaveTextContent(/a qualified financial fact changed/i);
    expect(region).toHaveTextContent(/Current monitoring availability cannot be shown; saved watch history remains available/i);
  });
});
