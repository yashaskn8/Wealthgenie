import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePage from '../ProfilePage.jsx';
import * as api from '../../services/api.js';

const VALID_PROFILE = {
  profileId: '64b000000000000000000001',
  version: 1,
  age: 34,
  monthly_take_home: 90000,
  monthly_savings: 25000,
  risk_tolerance: 'Moderate',
  investment_goals: ['Wealth Growth'],
  investment_horizon_years: 12,
};

function ProfileProbe({ userProfile, onProfileUpdate, initialRecommendation }) {
  return (
    <div>
      <span data-testid="profile-version">{userProfile.version}</span>
      <span data-testid="restored-recommendation-id">{initialRecommendation?.recommendationId || ''}</span>
      <button
        type="button"
        onClick={() => onProfileUpdate({ ...userProfile, version: userProfile.version + 1 })}
      >
        Apply update
      </button>
    </div>
  );
}

async function fillValidForm() {
  fireEvent.change(screen.getByTestId('profile-input-monthly_take_home'), { target: { value: '90000' } });
  fireEvent.change(screen.getByTestId('profile-input-monthly_savings'), { target: { value: '25000' } });
  fireEvent.change(screen.getByTestId('profile-input-age'), { target: { value: '34' } });
  fireEvent.click(screen.getByRole('button', { name: 'Moderate', exact: true }));
  fireEvent.click(screen.getByLabelText('Wealth Growth', { exact: true }));
  fireEvent.change(screen.getByTestId('profile-input-investment_horizon_years'), { target: { value: '12' } });
  await act(async () => {});
}

describe('ProfilePage backend version contract', () => {
  it('keeps a missing lump-sum amount distinct from an explicit zero', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    vi.spyOn(api, 'getCurrentRecommendation').mockRejectedValue({ status: 404 });
    render(<ProfilePage><div /></ProfilePage>);

    await screen.findByTestId('profile-save');
    fireEvent.click(screen.getByRole('button', { name: 'Yes', exact: true }));
    const amountSummary = screen.getByText('Amount not entered');
    expect(amountSummary).toBeInTheDocument();
    expect(screen.queryByText('₹0')).not.toBeInTheDocument();
    const lumpSumField = screen.getByText('Lump Sum Investment Amount (₹)').closest('.pf-field');
    fireEvent.change(lumpSumField.querySelector('input'), { target: { value: '0' } });
    expect(screen.getByText('₹0')).toBeInTheDocument();
  });

  it('preserves explicitly entered optional zeros instead of turning them into unknown facts', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    const precompute = vi.spyOn(api, 'precomputeProfile').mockResolvedValue({ candidateId: 'candidate' });
    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await screen.findByTestId('profile-save');
    await fillValidForm();
    for (const text of ['Sold Property Proceeds (₹)', 'Liquid Savings (₹)', 'Monthly EMI Burden (%)', 'Financial Dependents', 'Emergency Fund (Months)']) {
      const input = screen.getByText(text, { selector: 'label' }).closest('.pf-field').querySelector('input');
      fireEvent.change(input, { target: { value: '0' } });
      expect(input.value).toBe('0');
    }
    await waitFor(() => expect(precompute).toHaveBeenCalledWith(expect.objectContaining({
      sold_property_proceeds: 0, liquid_savings: 0, emi_burden_pct: 0, financial_dependents: 0, emergency_fund_months: 0,
    }), expect.any(Object)));
  });
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    api.setUserInfo({ id: 'user-1' });
    vi.spyOn(api, 'getCurrentRecommendation').mockRejectedValue({ status: 404 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the complete create form inside an accessible scrolling region', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });

    render(
      <ProfilePage>
        <ProfileProbe />
      </ProfilePage>
    );

    const scrollRegion = await screen.findByRole('region', { name: 'Financial profile form' });
    const formCard = screen.getByTestId('profile-scroll-region');
    const saveButton = screen.getByTestId('profile-save');

    expect(scrollRegion.tabIndex).toBe(0);
    expect(scrollRegion.className).toContain('profile-content');
    expect(formCard.className).toContain('profile-form-card');
    expect(formCard.style.overflowY).toBe('auto');
    expect(formCard.contains(saveButton)).toBe(true);
  });

  it('restores the latest backend version in memory without browser persistence', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockResolvedValue({
      profileId: '64b000000000000000000001',
      version: 2,
      age: 32,
      monthly_take_home: 65000,
      monthly_savings: 12000,
      risk_tolerance: 'Moderate',
      sold_property_proceeds: 0,
      has_lump_sum: false,
      lump_sum_amount: 0,
      liquid_savings: 100000,
      emi_burden_pct: 5,
      financial_dependents: 0,
      emergency_fund_months: 6,
      investment_goals: ['Wealth Growth'],
      investment_horizon_years: 10,
    });

    render(
      <ProfilePage>
        <ProfileProbe />
      </ProfilePage>
    );

    expect((await screen.findByTestId('profile-version')).textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Apply update' }));
    expect(screen.getByTestId('profile-version').textContent).toBe('3');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('does not start a duplicate when Save finds a matching in-flight precompute', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    let resolvePrecompute;
    const precomputePromise = new Promise(resolve => { resolvePrecompute = resolve; });
    const precompute = vi.spyOn(api, 'precomputeProfile').mockReturnValue(precomputePromise);
    const complete = vi.spyOn(api, 'completeFinancialProfile').mockResolvedValue({
      profile: VALID_PROFILE,
      recommendation: { profileId: VALID_PROFILE.profileId, recommendationId: '64b000000000000000000002', instruments: [] },
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    screen.getByTestId('profile-save');
    await fillValidForm();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(precompute).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('profile-save'));
    await act(async () => {
      resolvePrecompute({ candidateId: '4f4f4f4f-1111-4111-8111-111111111111' });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_savings: 25000 }),
      '4f4f4f4f-1111-4111-8111-111111111111',
      expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }),
    );
  });

  it('starts precompute immediately when Save is clicked before the debounce fires', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    let resolvePrecompute;
    const precompute = vi.spyOn(api, 'precomputeProfile').mockReturnValue(new Promise(resolve => {
      resolvePrecompute = resolve;
    }));
    const complete = vi.spyOn(api, 'completeFinancialProfile').mockResolvedValue({
      profile: VALID_PROFILE,
      recommendation: { profileId: VALID_PROFILE.profileId, recommendationId: '64b000000000000000000004', instruments: [] },
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await fillValidForm();

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-save'));
      await Promise.resolve();
    });
    expect(precompute).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrecompute({ candidateId: '4f4f4f4f-1111-4111-8111-111111111111' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_savings: 25000 }),
      '4f4f4f4f-1111-4111-8111-111111111111',
      expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }),
    );
  });

  it('does not use a candidate returned for a stale profile fingerprint', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    let resolveOldPrecompute;
    let resolveCurrentPrecompute;
    const precompute = vi.spyOn(api, 'precomputeProfile')
      .mockReturnValueOnce(new Promise(resolve => { resolveOldPrecompute = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveCurrentPrecompute = resolve; }));
    const complete = vi.spyOn(api, 'completeFinancialProfile').mockResolvedValue({
      profile: { ...VALID_PROFILE, monthly_savings: 26000 },
      recommendation: { profileId: VALID_PROFILE.profileId, recommendationId: '64b000000000000000000007', instruments: [] },
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await fillValidForm();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(precompute).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId('profile-input-monthly_savings'), { target: { value: '26000' } });
    await act(async () => {
      resolveOldPrecompute({ candidateId: '4f4f4f4f-1111-4111-8111-111111111111' });
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('profile-save'));
      await Promise.resolve();
    });
    expect(precompute).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveCurrentPrecompute({ candidateId: '4f4f4f4f-2222-4222-8222-222222222222' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_savings: 26000 }),
      '4f4f4f4f-2222-4222-8222-222222222222',
      expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }),
    );
    expect(complete).not.toHaveBeenCalledWith(
      expect.anything(),
      '4f4f4f4f-1111-4111-8111-111111111111',
      expect.anything(),
    );
  });

  it('bounds the precompute wait and completes without a stale candidate', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    const precompute = vi.spyOn(api, 'precomputeProfile').mockReturnValue(new Promise(() => {}));
    const complete = vi.spyOn(api, 'completeFinancialProfile').mockResolvedValue({
      profile: VALID_PROFILE,
      recommendation: { profileId: VALID_PROFILE.profileId, recommendationId: '64b000000000000000000003', instruments: [] },
    });
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    screen.getByTestId('profile-save');
    await fillValidForm();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(precompute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('profile-save'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    expect(complete).toHaveBeenCalledWith(
      expect.any(Object),
      null,
      expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }),
    );
  });

  it('reuses the completion key for retries and rotates it after a payload change', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404 });
    const complete = vi.spyOn(api, 'completeFinancialProfile')
      .mockRejectedValueOnce(new Error('network failure'))
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce({ profile: { ...VALID_PROFILE, monthly_savings: 26000 }, recommendation: { profileId: VALID_PROFILE.profileId, recommendationId: '64b000000000000000000005', instruments: [] } });
    vi.spyOn(api, 'precomputeProfile').mockRejectedValue(new Error('precompute unavailable'));
    vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<ProfilePage><ProfileProbe /></ProfilePage>);
    await screen.findByTestId('profile-save');
    await fillValidForm();
    fireEvent.click(screen.getByTestId('profile-save'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('profile-save'));
    await act(async () => {});

    const firstKey = complete.mock.calls[0][2].headers['Idempotency-Key'];
    const retryKey = complete.mock.calls[1][2].headers['Idempotency-Key'];
    expect(retryKey).toBe(firstKey);

    fireEvent.change(screen.getByTestId('profile-input-monthly_savings'), { target: { value: '26000' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await act(async () => {});
    expect(complete.mock.calls[2][2].headers['Idempotency-Key']).not.toBe(retryKey);
  });

  it('restores an existing authoritative recommendation before entering the dashboard', async () => {
    vi.spyOn(api, 'getCurrentProfile').mockResolvedValue(VALID_PROFILE);
    vi.spyOn(api, 'getCurrentRecommendation').mockResolvedValue({
      profileId: VALID_PROFILE.profileId,
      recommendationId: '64b000000000000000000006',
      instruments: [],
    });
    vi.spyOn(api, 'completeFinancialProfile');

    render(<ProfilePage><ProfileProbe /></ProfilePage>);

    await waitFor(() => expect(screen.getByTestId('restored-recommendation-id')).toHaveTextContent('64b000000000000000000006'));
    expect(api.getCurrentRecommendation).toHaveBeenCalledWith(VALID_PROFILE.profileId, expect.any(Object));
    expect(api.completeFinancialProfile).not.toHaveBeenCalled();
  });
});
