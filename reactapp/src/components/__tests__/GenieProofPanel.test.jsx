import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

  it('aborts pending offer extraction on unmount and ignores a response that still resolves', async () => {
    let resolveExtraction;
    mockApi.extractGenieProofClaims.mockImplementation(() => new Promise(resolve => { resolveExtraction = resolve; }));
    const { unmount } = render(<GenieProofPanel />);
    const offerInput = screen.getByLabelText('Paste the offer text');
    fireEvent.change(offerInput, { target: { value: offerText } });
    fireEvent.click(screen.getByRole('button', { name: /extract claims/i }));
    await waitFor(() => expect(mockApi.extractGenieProofClaims).toHaveBeenCalledOnce());
    const signal = mockApi.extractGenieProofClaims.mock.calls[0][1].signal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveExtraction({ inputHash: 'd'.repeat(64), claims: [candidate] });
      await Promise.resolve();
    });
  });

  it('clears a stale case-list error on refresh and keeps the latest refresh error visible', async () => {
    mockApi.listGenieProofCases
      .mockRejectedValueOnce(new Error('Old case-list error'))
      .mockResolvedValueOnce({ cases: [{ caseId: '00000000-0000-4000-8000-000000000002', revision: 2, claimCount: 0, manifestHash: 'b'.repeat(64) }] })
      .mockRejectedValueOnce(new Error('Current case-list error'));

    render(<GenieProofPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Old case-list error');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('b'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Current case-list error');
  });

  it('ignores an older saved-case list response after a newer refresh completes', async () => {
    let resolveFirstList;
    mockApi.listGenieProofCases
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstList = resolve; }))
      .mockResolvedValueOnce({ cases: [{ caseId: '00000000-0000-4000-8000-000000000002', revision: 2, claimCount: 0, manifestHash: 'b'.repeat(64) }] });
    render(<GenieProofPanel />);
    await waitFor(() => expect(mockApi.listGenieProofCases).toHaveBeenCalledTimes(1));
    const firstSignal = mockApi.listGenieProofCases.mock.calls[0][0].signal;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('b'.repeat(64))).toBeInTheDocument();
    expect(firstSignal.aborted).toBe(true);

    resolveFirstList({ cases: [{ caseId: '00000000-0000-4000-8000-000000000001', revision: 1, claimCount: 0, manifestHash: 'a'.repeat(64) }] });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
    expect(screen.queryByText('a'.repeat(64))).not.toBeInTheDocument();
  });

  it('opens saved findings only after a trusted signature is verified', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: { manifestHash: 'c'.repeat(64), manifest: { caseId, revision: 1, verifierVersion: 'genieproof-evidence-bound/0.6.0', confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'NOT_VERIFIABLE', reasonCodes: [], explanation: 'Evidence unavailable.' }] } },
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Not checked against qualified source evidence/)).toBeInTheDocument();
    expect(mockApi.verifyGenieProofCase).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('keeps the newer case open when an older trusted-signature check resolves late', async () => {
    const caseA = '00000000-0000-4000-8000-000000000001';
    const caseB = '00000000-0000-4000-8000-000000000002';
    let resolveVerificationA;
    const makePassport = (caseId, revision, hash, statement) => ({
      passport: {
        manifestHash: hash,
        manifest: { caseId, revision, confirmedClaims: [{ claimId: candidate.claimId, statement }], findings: [] },
      },
    });
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [
      { caseId: caseA, revision: 1, claimCount: 1, manifestHash: 'a'.repeat(64) },
      { caseId: caseB, revision: 2, claimCount: 1, manifestHash: 'b'.repeat(64) },
    ] });
    mockApi.getGenieProofCase.mockImplementation(async caseId => makePassport(
      caseId, caseId === caseA ? 1 : 2, caseId === caseA ? 'a'.repeat(64) : 'b'.repeat(64),
      caseId === caseA ? 'Case A private claim' : 'Case B private claim',
    ));
    mockApi.verifyGenieProofCase.mockImplementation(caseId => caseId === caseA
      ? new Promise(resolve => { resolveVerificationA = resolve; })
      : Promise.resolve({ revision: 2, manifestHash: 'b'.repeat(64), integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true }));

    render(<GenieProofPanel />);
    const [openA, openB] = await screen.findAllByRole('button', { name: 'Open' });
    fireEvent.click(openA);
    await waitFor(() => expect(mockApi.verifyGenieProofCase).toHaveBeenCalledTimes(1));
    expect(openB).toBeEnabled();

    fireEvent.click(openB);
    expect(await screen.findByRole('heading', { name: /Signed claim record · revision 2/ })).toBeInTheDocument();

    resolveVerificationA({ revision: 1, manifestHash: 'a'.repeat(64), integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true });
    await waitFor(() => expect(mockApi.verifyGenieProofCase).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: /Signed claim record · revision 2/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Signed claim record · revision 1/ })).not.toBeInTheDocument();
  });

  it('shows an invalid signature separately from an unknown signing key and still hides its findings', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getGenieProofCase.mockResolvedValue({
      passport: {
        manifestHash: 'c'.repeat(64),
        manifest: { caseId, revision: 1, confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }], findings: [{ claimId: candidate.claimId, finding: 'SUPPORTED', reasonCodes: [], explanation: 'Forged finding.' }] },
      },
    });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      revision: 1, manifestHash: 'c'.repeat(64), integrity: 'CONTENT_HASH_MATCHES', signature: 'UNVERIFIED',
      trustedIssuer: false, code: 'PASSPORT_SIGNATURE_INVALID', financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/trusted signing key, but its document signature is invalid/i);
    expect(screen.queryByText('SUPPORTED', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText(/trusted signing key was found, but the document signature is invalid/i)).toBeInTheDocument();
    expect(screen.queryByText(/signing key is not trusted/i)).not.toBeInTheDocument();

    mockApi.verifyGenieProofCase.mockResolvedValueOnce({
      revision: 1, manifestHash: 'c'.repeat(64), integrity: 'CONTENT_HASH_MATCHES', signature: 'UNVERIFIED',
      trustedIssuer: false, code: 'PASSPORT_SIGNING_KEY_REVOKED', financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByText(/report was signed by a revoked key/i)).toBeInTheDocument();
  });

  it('labels signed supported and contradicted findings as assessment-time records and shows separate current source status', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const contradictedClaimId = 'd'.repeat(32);
    const currentEvidenceStatus = {
      asOf: '2026-10-12T10:00:00.000Z',
      byClaimId: {
        [candidate.claimId]: {
          status: 'SOURCE_REVOKED',
          sourceIds: ['synthetic-test-source'],
          currentSourceRevisions: [{ sourceId: 'synthetic-test-source', currentSourceRevision: 4, recordedSourceRevision: 3, status: 'SOURCE_REVOKED' }],
        },
        [contradictedClaimId]: {
          status: 'CURRENT_SOURCE_REASSESSMENT_REQUIRED',
          sourceIds: ['synthetic-test-source'],
          currentSourceRevisions: [{ sourceId: 'synthetic-test-source', currentSourceRevision: 4, recordedSourceRevision: 4, status: 'CURRENT_SOURCE_REASSESSMENT_REQUIRED' }],
        },
      },
    };
    const passport = {
      manifestHash: 'c'.repeat(64),
      manifest: {
        caseId,
        revision: 1,
        verifierVersion: 'genieproof-evidence-bound/0.5.0',
        confirmedClaims: [
          { claimId: candidate.claimId, statement: offerText },
          { claimId: contradictedClaimId, statement: 'A different signed statement.' },
        ],
        findings: [
          { claimId: candidate.claimId, finding: 'SUPPORTED', reasonCodes: [], explanation: 'Recorded support.' },
          { claimId: contradictedClaimId, finding: 'CONTRADICTED', reasonCodes: [], explanation: 'Recorded conflict.' },
        ],
      },
    };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 2, manifestHash: passport.manifestHash }] });
    mockApi.getGenieProofCase.mockResolvedValue({ passport, currentEvidenceStatus });
    mockApi.verifyGenieProofCase.mockResolvedValue({
      revision: 1,
      manifestHash: passport.manifestHash,
      integrity: 'VALID',
      signature: 'VERIFIED',
      trustedIssuer: true,
      currentEvidenceStatus,
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByText(/signed report marked this claim as supported at the time of assessment/i)).toBeInTheDocument();
    expect(screen.getByText(/signed report marked this claim as contradicted at the time of assessment/i)).toBeInTheDocument();
    expect(screen.getAllByText(/source qualification or reuse approval was revoked/i)).toHaveLength(2);
    expect(screen.getAllByText(/source is currently qualified; a new assessment is needed to check current evidence/i)).toHaveLength(2);
    expect(screen.getAllByText(/checked/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText('Source revision details')[0]);
    expect(screen.getByText(/current source revision 4; assessment used revision 3/i)).toBeInTheDocument();
    expect(passport.manifest.findings[0].finding).toBe('SUPPORTED');
    expect(passport.manifest.findings[1].finding).toBe('CONTRADICTED');
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
    await waitFor(() => expect(mockApi.getGenieProofCase).toHaveBeenLastCalledWith(caseB, expect.objectContaining({ signal: expect.any(AbortSignal) })));
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
    expect(mockApi.listGenieProofRevisions).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves trusted legacy findings without presenting them as current financial verdicts', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const passport = {
      manifestHash: 'c'.repeat(64),
      signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'legacy-signature' },
      manifest: {
        caseId,
        revision: 1,
        verifierVersion: 'genieproof-evidence-bound/0.5.0',
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
    expect(screen.getByText(/Historical finding: The signed report marked this claim as supported at the time of assessment/i)).toBeInTheDocument();
    expect(screen.getByText(/signed report marked this claim as supported at the time of assessment/i)).toBeInTheDocument();
  });

  it('labels a trusted legacy contradicted finding as historical at the finding', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const passport = {
      manifestHash: 'c'.repeat(64),
      signature: { algorithm: 'Ed25519', keyId: 'test-key', value: 'legacy-signature' },
      manifest: {
        caseId,
        revision: 1,
        verifierVersion: 'genieproof-evidence-bound/0.5.0',
        confirmedClaims: [{ claimId: candidate.claimId, statement: offerText }],
        findings: [{ claimId: candidate.claimId, finding: 'CONTRADICTED', reasonCodes: [], explanation: 'Recorded by the historical verifier.' }],
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

    expect(await screen.findByText(/Historical finding: The signed report marked this claim as contradicted at the time of assessment/i)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/historical verifier output.*not reassessed under current claim rules/i);
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

  it('does not let delayed assessment history replace the history for the newly selected case', async () => {
    const caseA = '00000000-0000-4000-8000-000000000001';
    const caseB = '00000000-0000-4000-8000-000000000002';
    let resolveHistoryA;
    const revisionB = {
      revision: 2,
      manifestHash: 'b'.repeat(64),
      verification: { integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true },
      passport: { manifest: { caseId: caseB, revision: 2, confirmedClaims: [], findings: [] } },
    };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [
      { caseId: caseA, revision: 1, claimCount: 0, manifestHash: 'a'.repeat(64) },
      { caseId: caseB, revision: 2, claimCount: 0, manifestHash: 'b'.repeat(64) },
    ] });
    mockApi.listGenieProofRevisions.mockImplementation(caseId => caseId === caseA
      ? new Promise(resolve => { resolveHistoryA = resolve; })
      : Promise.resolve({ caseId, revisions: [revisionB] }));

    render(<GenieProofPanel />);
    const [historyA, historyB] = await screen.findAllByRole('button', { name: 'Assessment history' });
    fireEvent.click(historyA);
    await waitFor(() => expect(mockApi.listGenieProofRevisions).toHaveBeenCalledTimes(1));
    expect(historyB).toBeEnabled();

    fireEvent.click(historyB);
    const history = await screen.findByRole('group', { name: 'Assessment history' });
    expect(within(history).getByRole('button', { name: /Open revision 2/ })).toBeInTheDocument();

    resolveHistoryA({ caseId: caseA, revisions: [{ ...revisionB, revision: 1, passport: { manifest: { caseId: caseA, revision: 1, confirmedClaims: [], findings: [] } } }] });
    await waitFor(() => expect(mockApi.listGenieProofRevisions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('group', { name: 'Assessment history' })).toHaveTextContent('Open revision 2');
    expect(screen.queryByRole('button', { name: /Open revision 1/ })).not.toBeInTheDocument();
  });

  it('compares two historical revisions only after both trusted signatures verify', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const makeRevision = (revision, finding) => ({
      revision,
      manifestHash: String(revision).repeat(64),
      verification: { integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true },
      currentEvidenceStatus: {
        asOf: '2026-10-12T10:00:00.000Z',
        byClaimId: {
          [candidate.claimId]: {
            status: revision === 1 ? 'SOURCE_REVOKED' : 'CURRENT_SOURCE_REASSESSMENT_REQUIRED',
            sourceIds: ['synthetic-test-source'],
            currentSourceRevisions: [{
              sourceId: 'synthetic-test-source',
              currentSourceRevision: 4,
              recordedSourceRevision: revision,
              status: revision === 1 ? 'SOURCE_REVOKED' : 'CURRENT_SOURCE_REASSESSMENT_REQUIRED',
            }],
          },
        },
      },
      passport: {
        manifestHash: String(revision).repeat(64),
        signature: { algorithm: 'Ed25519', keyId: 'test-key', value: `signature-${revision}` },
        manifest: {
          caseId,
          revision,
          verifierVersion: 'genieproof-evidence-bound/0.6.0',
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
    const history = await screen.findByRole('group', { name: 'Assessment history' });
    expect(within(history).getAllByText(/source qualification or reuse approval was revoked/i)).toHaveLength(2);
    expect(within(history).getAllByText(/source is currently qualified; a new assessment is needed to check current evidence/i)).toHaveLength(2);
    fireEvent.click(await screen.findByRole('button', { name: 'Compare revision 1 with revision 2' }));

    expect(await screen.findByRole('heading', { name: 'Signed assessment comparison' })).toBeInTheDocument();
    expect(screen.getByText(/Revision 1: Not checked against qualified source evidence/)).toBeInTheDocument();
    expect(screen.getByText(/Revision 2: More product details are needed/)).toBeInTheDocument();
    expect(screen.getByText(/does not establish financial correctness/i)).toBeInTheDocument();
    const comparison = screen.getByRole('region', { name: 'Signed assessment comparison' });
    expect(within(comparison).getAllByText(/source qualification or reuse approval was revoked/i)).toHaveLength(2);
    expect(within(comparison).getAllByText(/source is currently qualified; a new assessment is needed to check current evidence/i)).toHaveLength(2);
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
    await waitFor(() => expect(mockApi.deleteGenieProofCase).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it('preserves a delete failure when refreshing the saved-case list succeeds', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.deleteGenieProofCase.mockRejectedValue(new Error('Synthetic deletion failure'));
    render(<GenieProofPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete passport revision 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete case and revisions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic deletion failure');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mockApi.listGenieProofCases).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic deletion failure');
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

  it('keeps the latest watch/source refresh when an older watch response arrives late', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    let resolveFirstAvailability;
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstAvailability = resolve; }))
      .mockResolvedValueOnce({
        caseId, workerStatus: 'UNAVAILABLE', canEnable: false, sourceStatus: 'TECHNICALLY_BLOCKED',
        monitoringScope: 'Latest synthetic status', claims: [],
      });

    render(<GenieProofPanel />);
    const refresh = await screen.findByRole('button', { name: /ProofBreak status & timeline/i });
    fireEvent.click(refresh);
    await waitFor(() => expect(mockApi.getProofWatchAvailability).toHaveBeenCalledTimes(1));
    fireEvent.click(refresh);
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent('Latest synthetic status');

    resolveFirstAvailability({
      caseId, workerStatus: 'AVAILABLE', canEnable: true, sourceStatus: 'AVAILABLE',
      monitoringScope: 'Stale synthetic status', claims: [],
    });
    await waitFor(() => expect(mockApi.getProofWatchAvailability).toHaveBeenCalledTimes(2));
    expect(region).toHaveTextContent('Latest synthetic status');
    expect(region).not.toHaveTextContent('Stale synthetic status');
  });

  it('explains when source reuse approval was revoked', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({
      caseId, workerStatus: 'AVAILABLE', canEnable: false, sourceStatus: 'RIGHTS_BLOCKED',
      sourceReasonCode: 'GENIEPROOF_SOURCE_REVOKED',
      monitoringScope: 'Only exact current nominal PPF annual-rate claims are currently supported.',
      claims: [{ claimId: candidate.claimId, claimType: 'CURRENT_NOMINAL_RATE', productId: candidate.productId, status: 'SOURCE_RIGHTS_BLOCKED' }],
    });
    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    expect(await screen.findByText(/official source reuse approval was revoked/i)).toBeInTheDocument();
    expect(screen.getAllByText(/source reuse approval was revoked/i)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /enable ProofBreak checks/i })).not.toBeInTheDocument();
  });

  it.each(['CANCELLED', 'DISABLED', 'EXPIRED'])('offers a fresh consented watch after a %s watch while preserving prior event history', async watchStatus => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const cancelledWatch = { watchId: '00000000-0000-4000-8000-000000000002', status: watchStatus };
    const activeWatch = { watchId: '00000000-0000-4000-8000-000000000004', status: 'ACTIVE' };
    const priorEvent = { eventId: '00000000-0000-4000-8000-000000000003', eventType: 'EVIDENCE_CHANGED', detectedAt: '2026-10-11T12:00:00.000Z', notificationStatus: 'DELIVERED', acknowledgedAt: null };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({
      caseId, workerStatus: 'AVAILABLE', canEnable: true, sourceStatus: 'AVAILABLE',
      monitoringScope: 'PPF only', claims: [{ claimId: candidate.claimId, status: 'AVAILABLE' }],
    });
    mockApi.listProofWatches
      .mockResolvedValueOnce({ watches: [cancelledWatch] })
      .mockResolvedValue({ watches: [cancelledWatch, activeWatch] });
    mockApi.listProofBreakEvents.mockResolvedValue({ events: [priorEvent], nextCursor: null });
    mockApi.createProofWatch.mockResolvedValue({ created: true, watch: activeWatch });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent(new RegExp(`watch status: ${watchStatus.toLowerCase()}`, 'i'));
    expect(region).toHaveTextContent(/a qualified financial fact changed/i);
    expect(within(region).queryByRole('button', { name: 'Resume checks' })).not.toBeInTheDocument();
    expect(within(region).getByRole('button', { name: /Withdraw private processing consent/i })).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Enable ProofBreak checks' })).toBeDisabled();

    fireEvent.click(within(region).getByLabelText(/I consent to periodic checks/i));
    fireEvent.click(within(region).getByRole('button', { name: 'Enable ProofBreak checks' }));
    await waitFor(() => expect(mockApi.createProofWatch).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await within(region).findByText(/watch status: active/i)).toBeInTheDocument();
    expect(region).toHaveTextContent(/a qualified financial fact changed/i);
    expect(mockApi.updateProofWatch).not.toHaveBeenCalled();
    expect(mockApi.deleteProofWatch).not.toHaveBeenCalled();
  });

  it('keeps source qualification fail-closed for unexpected status values', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({
      caseId, workerStatus: 'AVAILABLE', canEnable: true, sourceStatus: 'QUALIFIED_MAYBE',
      monitoringScope: 'PPF only', claims: [{ claimId: candidate.claimId, status: 'AVAILABLE' }],
    });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent(/Source qualification is unknown, so monitoring cannot be enabled/i);
    expect(region).toHaveTextContent(/Monitoring availability is unknown/i);
    expect(region).not.toHaveTextContent(/Supported by an approved monitoring source/i);
    expect(region).not.toHaveTextContent('A source is qualified for the supported claims.');
    expect(within(region).queryByRole('button', { name: /Enable ProofBreak checks/i })).not.toBeInTheDocument();
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
    await waitFor(() => expect(mockApi.getProofWatchAvailability).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(screen.getByRole('region', { name: /ProofBreak status and timeline/i })).toHaveTextContent(/A source is qualified/);
    const enable = await screen.findByRole('button', { name: /Enable ProofBreak checks/i });
    expect(enable).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I consent to periodic checks of these supported claims/i));
    fireEvent.click(enable);
    await waitFor(() => expect(mockApi.createProofWatch).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
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
    expect(region).toHaveTextContent(/Private processing consent is withdrawn. Future monitoring checks are off./i);
  });

  it('shows withdrawn consent immediately and preserves it when watch and event reads fail', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const activeWatch = { watchId: '00000000-0000-4000-8000-000000000002', status: 'ACTIVE', nextCheckAt: '2026-10-16T12:00:00.000Z' };
    const priorEvent = { eventId: '00000000-0000-4000-8000-000000000003', eventType: 'EVIDENCE_CHANGED', detectedAt: '2026-10-11T12:00:00.000Z', notificationStatus: 'DELIVERED', acknowledgedAt: null };
    let rejectWatchRead;
    let rejectTimelineRead;
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockResolvedValue({ caseId, workerStatus: 'AVAILABLE', canEnable: false, sourceStatus: 'AVAILABLE', claims: [] });
    mockApi.listProofWatches
      .mockResolvedValueOnce({ watches: [activeWatch] })
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectWatchRead = reject; }));
    mockApi.listProofBreakEvents
      .mockResolvedValueOnce({ events: [priorEvent], nextCursor: null })
      .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectTimelineRead = reject; }));
    mockApi.withdrawGenieProofConsent.mockResolvedValue({});

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    fireEvent.click(within(region).getByRole('button', { name: /Withdraw private processing consent/i }));
    fireEvent.click(within(region).getByRole('button', { name: /Confirm withdrawal/i }));

    expect(await within(region).findByText(/Processing consent is withdrawn. Future checks are off./i)).toBeInTheDocument();
    expect(region).toHaveTextContent(/watch status: cancelled/i);
    expect(region).not.toHaveTextContent('Next eligible check:');
    expect(region).toHaveTextContent(/a qualified financial fact changed/i);
    expect(rejectWatchRead).toEqual(expect.any(Function));
    expect(rejectTimelineRead).toEqual(expect.any(Function));

    await act(async () => {
      rejectWatchRead(new Error('Synthetic watch read failure'));
      rejectTimelineRead(new Error('Synthetic event read failure'));
    });
    await waitFor(() => expect(region).toHaveTextContent(/latest watch status could not be refreshed.*saved event history could not be refreshed/i));
    expect(region).toHaveTextContent(/a qualified financial fact changed/i);
    expect(await screen.findByText(/Private processing consent was withdrawn. Future reassessments and monitoring checks were cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('allows consent withdrawal when current availability cannot be loaded', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    const activeWatch = { watchId: '00000000-0000-4000-8000-000000000002', status: 'ACTIVE' };
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockRejectedValue(new Error('Availability unavailable'));
    mockApi.listProofWatches.mockResolvedValue({ watches: [activeWatch] });
    mockApi.withdrawGenieProofConsent.mockResolvedValue({});

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent(/Current monitoring availability cannot be shown/i);
    fireEvent.click(within(region).getByRole('button', { name: /Withdraw private processing consent/i }));
    fireEvent.click(within(region).getByRole('button', { name: /Confirm withdrawal/i }));

    await waitFor(() => expect(mockApi.withdrawGenieProofConsent).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await within(region).findByText(/Processing consent is withdrawn. Future checks are off./i)).toBeInTheDocument();
  });

  it('allows case consent withdrawal when availability is unknown and no watch exists', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockRejectedValue(new Error('Synthetic availability failure'));
    mockApi.listProofWatches.mockResolvedValue({ watches: [] });
    mockApi.withdrawGenieProofConsent.mockResolvedValue({});

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent(/Current monitoring availability cannot be shown; saved watch history remains available/i);
    expect(within(region).queryByText(/Watch status:/i)).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: /Withdraw private processing consent/i }));
    fireEvent.click(within(region).getByRole('button', { name: /Confirm withdrawal/i }));

    await waitFor(() => expect(mockApi.withdrawGenieProofConsent).toHaveBeenCalledWith(caseId, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await within(region).findByText(/Processing consent is withdrawn. Future checks are off./i)).toBeInTheDocument();
  });

  it('recognizes explicit withdrawn-consent availability errors after reload without treating unknown failures as withdrawal', async () => {
    const caseId = '00000000-0000-4000-8000-000000000001';
    mockApi.listGenieProofCases.mockResolvedValue({ cases: [{ caseId, revision: 1, claimCount: 1, manifestHash: 'c'.repeat(64) }] });
    mockApi.getProofWatchAvailability.mockRejectedValue(Object.assign(new Error('Consent was withdrawn.'), { code: 'GENIEPROOF_CONSENT_WITHDRAWN' }));
    mockApi.listProofWatches.mockResolvedValue({ watches: [{ watchId: '00000000-0000-4000-8000-000000000002', status: 'CANCELLED' }] });

    render(<GenieProofPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /ProofBreak status & timeline/i }));
    const region = await screen.findByRole('region', { name: /ProofBreak status and timeline/i });
    expect(region).toHaveTextContent(/Private processing consent is withdrawn. Future monitoring checks are off./i);
    expect(region).not.toHaveTextContent(/Current monitoring availability cannot be shown/i);
    expect(within(region).queryByRole('button', { name: /Withdraw private processing consent/i })).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Resume checks' })).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Enable ProofBreak checks' })).not.toBeInTheDocument();
    expect(mockApi.withdrawGenieProofConsent).not.toHaveBeenCalled();
  });
});
