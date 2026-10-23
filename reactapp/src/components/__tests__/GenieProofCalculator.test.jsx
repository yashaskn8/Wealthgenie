import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import GenieProofCalculator from '../GenieProofCalculator';
import { calculateGenieProofScenario } from '../../services/api';

vi.mock('../../services/api', () => ({ calculateGenieProofScenario: vi.fn() }));

const mockResult = {
  ok: true, mode: 'USER_INPUT_MATH_CHECK', type: 'SIP', metric: 'FUTURE_VALUE', months: 12,
  assumptionRatePercent: '0', assumptionSource: 'USER_SUPPLIED_NOT_VERIFIED',
  amountRupees: '100', stepUpPercent: '0', resultRupees: '1200.00',
  totalPaidOrContributedRupees: '1200.00', totalInterestRupees: '0.00',
  lastInstallmentRupees: null, claimedResultRupees: null, absoluteDifferenceRupees: null,
  arithmeticFinding: 'CALCULATED_ONLY',
  convention: 'End-of-month SIP and monthly paise rounding.',
  exclusions: ['TAXES', 'FEES', 'INFLATION', 'RATE_CHANGES'],
  caveat: 'The rate and realized return are NOT verified.',
  saved: false,
};

function enterSip() {
  fireEvent.change(screen.getByLabelText('Monthly SIP (₹)'), { target: { value: '100' } });
  fireEvent.change(screen.getByLabelText('Assumed annual nominal rate (%)'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Duration in months'), { target: { value: '12' } });
}

describe('GenieProof math-only illustration', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it('only submits typed assumptions and labels calculations as unverified', async () => {
    calculateGenieProofScenario.mockResolvedValue(mockResult);
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByText('₹1,200.00')).toBeInTheDocument();
    expect(screen.getByText(/The rate and realized return are NOT verified/i)).toBeInTheDocument();
    expect(screen.getByText(/checks the mathematics only/i)).toBeInTheDocument();
    expect(calculateGenieProofScenario).toHaveBeenCalledWith(
      { type: 'SIP', amountRupees: '100', annualRatePercent: '0', months: 12, stepUpPercent: '0' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('allows the optional SIP step-up to be cleared and sends zero', async () => {
    calculateGenieProofScenario.mockResolvedValue(mockResult);
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.change(screen.getByLabelText('Annual SIP step-up (%) (optional)'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Calculate and compare' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByText('₹1,200.00')).toBeInTheDocument();
    expect(calculateGenieProofScenario).toHaveBeenCalledWith(
      { type: 'SIP', amountRupees: '100', annualRatePercent: '0', months: 12, stepUpPercent: '0' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it('rejects fabricated positive responses that change the source or result scenario', async () => {
    calculateGenieProofScenario.mockResolvedValue({ ...mockResult, assumptionRatePercent: '25' });
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No result was accepted/i);
    expect(screen.queryByText('₹1,200.00')).not.toBeInTheDocument();
  });

  it('does not submit invalid or over-precise financial figures', () => {
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.change(screen.getByLabelText('Monthly SIP (₹)'), { target: { value: '100.001' } });
    expect(screen.getByRole('button', { name: 'Calculate and compare' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Monthly SIP (₹)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Assumed annual nominal rate (%)'), { target: { value: '100.0001' } });
    expect(screen.getByRole('button', { name: 'Calculate and compare' })).toBeDisabled();
    expect(calculateGenieProofScenario).not.toHaveBeenCalled();
  });

  it('removes stale computations as inputs change', async () => {
    calculateGenieProofScenario.mockResolvedValue(mockResult);
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByText('₹1,200.00')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Duration in months'), { target: { value: '13' } });
    expect(screen.queryByText('₹1,200.00')).not.toBeInTheDocument();
  });
  it('rejects a forged arithmetic match when the claimed figure differs', async () => {
    calculateGenieProofScenario.mockResolvedValue({
      ...mockResult,
      claimedResultRupees: '9999.00',
      absoluteDifferenceRupees: '0.00',
      arithmeticFinding: 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE',
    });
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.change(screen.getByLabelText(/Claimed future value/), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No result was accepted/);
    expect(screen.queryByText(/Claimed arithmetic matches/)).not.toBeInTheDocument();
  });

  it('rejects a mathematically inconsistent contribution or interest total', async () => {
    calculateGenieProofScenario.mockResolvedValue({
      ...mockResult,
      totalPaidOrContributedRupees: '1199.99',
    });
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No result was accepted/);
    expect(screen.queryByText('₹1,200.00')).not.toBeInTheDocument();
  });

  it('accepts a genuinely consistent claimed-result comparison', async () => {
    calculateGenieProofScenario.mockResolvedValue({
      ...mockResult,
      claimedResultRupees: '1200.00',
      absoluteDifferenceRupees: '0.00',
      arithmeticFinding: 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE',
    });
    render(<GenieProofCalculator />);
    enterSip();
    fireEvent.change(screen.getByLabelText(/Claimed future value/), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate and compare' }));
    expect(await screen.findByText(/Claimed arithmetic matches/)).toBeInTheDocument();
    expect(screen.getByText('₹1,200.00')).toBeInTheDocument();
  });

});
