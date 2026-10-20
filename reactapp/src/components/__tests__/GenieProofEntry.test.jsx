import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getGenieProofCapabilities, previewGenieProofClaims } from '../../services/api';
import GenieProofEntry from '../GenieProofEntry';

vi.mock('../../services/api', () => ({
  getGenieProofCapabilities: vi.fn(),
  previewGenieProofClaims: vi.fn(),
}));
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
    expect(await screen.findByText(/Signed GenieProof passports and evidence-based verdicts are unavailable on this server/i)).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
  });


  it.each([
    ['GENIEPROOF_LOCAL_RESEARCH_ONLY', /restricted to a development or test backend/i],
    ['GENIEPROOF_FLAG_DISABLED', /Set GENIEPROOF_ENABLED=true/i],
    ['GENIEPROOF_SIGNING_KEYS_MISSING', /GENIEPROOF_SIGNING_PRIVATE_KEY/i],
    ['GENIEPROOF_SIGNING_CONFIGURATION_INVALID', /Ed25519 private\/public keys match/i],
  ])('explains %s without enabling unauthorized controls', async (reasonCode, expected) => {
    getGenieProofCapabilities.mockResolvedValue({
      interactiveEnabled: false,
      extractionPreviewEnabled: true,
      mode: 'UNAVAILABLE',
      reasonCode,
      productionVerified: false,
    });
    render(<GenieProofEntry />);
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
    expect(await screen.findByText(/You can still review unsaved candidate statements/i)).toBeInTheDocument();
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
    expect(await screen.findByText(/Signed GenieProof passports and evidence-based verdicts are unavailable/i)).toBeInTheDocument();
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
  });
});

describe('GenieProof unsaved production claim preview', () => {
  beforeEach(() => vi.resetAllMocks());

  const readonlyCapability = {
    interactiveEnabled: false,
    extractionPreviewEnabled: true,
    mode: 'UNAVAILABLE',
    reasonCode: 'FEATURE_UNAVAILABLE',
    productionVerified: false,
  };

  it('requires explicit submission and marks all candidates unverified', async () => {
    getGenieProofCapabilities.mockResolvedValue(readonlyCapability);
    previewGenieProofClaims.mockResolvedValue({
      previewOnly: true,
      status: 'CANDIDATES_ONLY',
      sourceEvidenceChecked: false,
      signedPassportCreated: false,
      claims: [{ claimId: 'claim-1', originalSpan: 'The current official PPF interest rate is 7.1% p.a.', claimType: 'CURRENT_NOMINAL_RATE' }],
    });
    render(<GenieProofEntry />);
    expect(await screen.findByRole('button', { name: 'Review claims' })).toBeDisabled();
    expect(previewGenieProofClaims).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Financial offer or statement'), {
      target: { value: 'The current official PPF interest rate is 7.1% p.a.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review claims' }));
    expect(await screen.findByText('Candidate statements — not verified')).toBeInTheDocument();
    expect(screen.getByText(/Recognized as a current PPF-rate claim candidate, not verified/i)).toBeInTheDocument();
    expect(previewGenieProofClaims).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('interactive-genieproof')).not.toBeInTheDocument();
  });

  it('counts UTF-8 bytes and blocks oversize multi-byte submissions before API calls', async () => {
    getGenieProofCapabilities.mockResolvedValue(readonlyCapability);
    render(<GenieProofEntry />);
    const offer = await screen.findByLabelText('Financial offer or statement');
    const button = screen.getByRole('button', { name: 'Review claims' });
    fireEvent.change(offer, { target: { value: '₹'.repeat(6000) } });
    expect(screen.getByText('18,000 / 16,000 UTF-8 bytes')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('exceeds the 16,000-byte extraction limit');
    expect(button).toBeDisabled();
    expect(previewGenieProofClaims).not.toHaveBeenCalled();
    fireEvent.change(offer, { target: { value: 'a'.repeat(16001) } });
    expect(screen.getByText('16,001 / 16,000 UTF-8 bytes')).toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.change(offer, { target: { value: 'a'.repeat(16000) } });
    expect(screen.getByText('16,000 / 16,000 UTF-8 bytes')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('clears the previous preview when input changes and fails closed on a malformed response', async () => {
    getGenieProofCapabilities.mockResolvedValue(readonlyCapability);
    previewGenieProofClaims.mockResolvedValueOnce({
      previewOnly: true, status: 'CANDIDATES_ONLY', sourceEvidenceChecked: false,
      signedPassportCreated: false,
      claims: [{ claimId: 'claim-2', originalSpan: 'PPF guarantees returns.', claimType: 'UNSUPPORTED' }],
    }).mockResolvedValueOnce({
      previewOnly: false, status: 'VERIFIED', sourceEvidenceChecked: true,
      signedPassportCreated: true, claims: [],
    });
    render(<GenieProofEntry />);
    const input = await screen.findByLabelText('Financial offer or statement');
    fireEvent.change(input, { target: { value: 'PPF guarantees returns.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review claims' }));
    expect(await screen.findByText('Candidate statements — not verified')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Another PPF claim.' } });
    expect(screen.queryByText('Candidate statements — not verified')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review claims' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No claim has been checked or saved/);
    expect(screen.queryByText('Candidate statements — not verified')).not.toBeInTheDocument();
  });
});
