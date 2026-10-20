/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App.jsx';
import { AuthProvider } from '../context/AuthContext.jsx';
import * as api from '../services/api.js';

vi.mock('../components/Sidebar', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ onNavigate, onLogout }) => ReactModule.createElement('nav', { 'aria-label': 'Synthetic journey navigation' },
      ...[
        ['Home', 'home'], ['My Plan', 'plan'], ['Taxes', 'taxes'],
        ['Progress', 'progress'], ['Where to Invest', 'investments'], ['Account', 'account'],
      ].map(([label, page]) => ReactModule.createElement('button', {
        key: page,
        type: 'button',
        onClick: () => onNavigate(page),
      }, label)),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => void onLogout?.(),
      }, 'Sign out synthetic user'),
    ),
  };
});

vi.mock('../RecommendationDashboard', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ userProfile, recommendationMeta, onRecalculate }) => ReactModule.createElement('section', { 'data-testid': 'journey-home' },
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-id' }, userProfile?.profileId || ''),
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-version' }, String(userProfile?.version ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'journey-monthly-savings' }, String(userProfile?.monthly_savings ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'journey-recommendation-id' }, recommendationMeta?.recommendationId || ''),
      ReactModule.createElement('output', { 'data-testid': 'journey-allocation-revision' }, String(recommendationMeta?.allocation_revision ?? 'missing')),
      ReactModule.createElement('button', { type: 'button', onClick: () => void onRecalculate() }, 'Recalculate synthetic plan'),
    ),
  };
});

vi.mock('../components/AllocationPlanner', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ profile, recommendationMeta }) => ReactModule.createElement('section', { 'data-testid': 'journey-plan' },
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-id' }, profile?.profileId || ''),
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-version' }, String(profile?.version ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'journey-recommendation-id' }, recommendationMeta?.recommendationId || ''),
    ),
  };
});

vi.mock('../components/TaxesHub', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ profile, recommendationMeta }) => ReactModule.createElement('section', { 'data-testid': 'journey-taxes' },
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-id' }, profile?.profileId || ''),
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-version' }, String(profile?.version ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'journey-recommendation-id' }, recommendationMeta?.recommendationId || ''),
    ),
  };
});

vi.mock('../components/ProgressHub', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ profile, financialState }) => ReactModule.createElement('section', { 'data-testid': 'journey-progress' },
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-id' }, profile?.profileId || ''),
      ReactModule.createElement('output', { 'data-testid': 'journey-profile-version' }, String(profile?.version ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'journey-recommendation-id' }, financialState?.recommendationId || ''),
    ),
  };
});

vi.mock('../components/DeepDiveModal', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ isOpen, investment, userProfile, recommendationMeta }) => isOpen
      ? ReactModule.createElement('section', { 'data-testid': 'journey-deep-dive' },
        ReactModule.createElement('output', { 'data-testid': 'deep-dive-investment' }, investment?.name || ''),
        ReactModule.createElement('output', { 'data-testid': 'deep-dive-profile-id' }, userProfile?.profileId || ''),
        ReactModule.createElement('output', { 'data-testid': 'deep-dive-recommendation-id' }, recommendationMeta?.recommendationId || ''),
      )
      : null,
  };
});

vi.mock('../ProfileEditor', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ userProfile, onProfileUpdate, onProfileChangeStart }) => ReactModule.createElement('section', { 'data-testid': 'journey-account' },
      ReactModule.createElement('output', { 'data-testid': 'account-profile-version' }, String(userProfile?.version ?? 'missing')),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => {
          onProfileChangeStart?.();
          onProfileUpdate({
            ...userProfile,
            version: Number(userProfile.version) + 1,
            monthly_savings: Number(userProfile.monthly_savings) + 1000,
          });
        },
      }, 'Save synthetic profile version 2'),
    ),
  };
});

vi.mock('../components/GenieChat', () => ({ default: () => null }));
vi.mock('../components/ErrorBoundary', () => ({ default: ({ children }) => children }));
vi.mock('../state/useMarketContext', () => ({
  useMarketContext: () => ({
    marketContext: null,
    marketContextError: null,
    marketContextLoading: false,
    marketContextRefreshing: false,
    marketContextTransport: null,
    marketContextRevision: 0,
    refreshMarketContext: vi.fn(),
    acceptMarketContext: vi.fn(),
  }),
}));

const SYNTHETIC_USER = Object.freeze({
  id: 'synthetic-owner-001',
  name: 'Synthetic Test User',
  email: 'synthetic@example.invalid',
});
const SECOND_SYNTHETIC_USER = Object.freeze({
  id: 'synthetic-owner-002',
  name: 'Second Synthetic User',
  email: 'second-synthetic@example.invalid',
});
const PROFILE_ID = '000000000000000000000101';

function makeProfile(version = 1, profileId = PROFILE_ID) {
  return {
    profileId,
    version,
    age: 34,
    monthly_take_home: 90000,
    monthly_savings: version === 1 ? 25000 : 26000,
    risk_tolerance: 'Moderate',
    sold_property_proceeds: null,
    has_lump_sum: false,
    lump_sum_amount: 0,
    liquid_savings: 100000,
    emi_burden_pct: 5,
    financial_dependents: 1,
    emergency_fund_months: 6,
    investment_goals: ['Wealth Growth'],
    investment_horizon_years: 12,
  };
}

function objectId(number) {
  return String(number).padStart(24, '0');
}

function makeRecommendation(profile) {
  const version = Number(profile.version);
  const recommendationId = objectId(200 + version);
  const stateId = objectId(300 + version);
  const allocationRevisionId = objectId(400 + version);
  const profileInputHash = (version === 1 ? 'a' : '9').repeat(64);
  const portfolioFingerprint = (version === 1 ? 'b' : '8').repeat(64);
  const recommendationFingerprint = (version === 1 ? 'c' : '7').repeat(64);
  const recommendationPolicyVersion = 'synthetic-recommendation-policy-v1';
  const regulatoryRuleVersion = 'synthetic-regulatory-rules-v1';
  const returnAssumptionVersion = 'synthetic-assumption-v1';
  const returnAssumptionHash = 'd'.repeat(64);
  const returnAssumptionSource = 'WEALTHGENIE_MODEL_POLICY';
  const allocationSource = 'ORIGINAL_RECOMMENDATION';
  const instruments = [{
    id: 'ppf',
    name: 'Public Provident Fund (PPF)',
    type: 'PPF',
    assetClass: 'Sovereign',
    riskLevel: 'Low',
    allocationWeight: 1,
    allocation_pct: 100,
    nominalReturn: 0.07,
    effectiveYield: 0.07,
    riskScore: 1,
    lockIn: 15,
    expenseRatio: 0,
    score: 80,
    returnBasis: 'PRE_TAX_NOMINAL',
    postTaxReturn: null,
    tags: ['Wealth Growth'],
    scoreFactors: { goalFit: 90, liquidity: 30 },
  }];
  const stateProvenance = {
    status: 'PERSISTED_REVISION',
    stateId,
    recommendationId,
    allocationSource,
    allocationRevision: 1,
    allocationRevisionId,
    profileVersion: version,
    profileInputHash,
    portfolioFingerprint,
    recommendationFingerprint,
    recommendationPolicyVersion,
    regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    returnAssumptionSource,
    previousAllocationRevision: null,
    previousAllocationRevisionId: null,
  };
  return {
    profileId: profile.profileId,
    profile_version: version,
    profile_input_hash: profileInputHash,
    recommendationId,
    recommendation_id: recommendationId,
    allocation_revision: 1,
    allocation_revision_id: allocationRevisionId,
    previous_allocation_revision: null,
    previous_allocation_revision_id: null,
    portfolio_fingerprint: portfolioFingerprint,
    recommendation_fingerprint: recommendationFingerprint,
    recommendation_policy_version: recommendationPolicyVersion,
    regulatory_rule_version: regulatoryRuleVersion,
    return_assumption_version: returnAssumptionVersion,
    return_assumption_source: returnAssumptionSource,
    return_assumption_hash: returnAssumptionHash,
    current_allocation_source: allocationSource,
    response_state: 'CURRENT',
    calculation_freshness: {
      fresh: true,
      reasonCodes: [],
      expectedProfileHash: profileInputHash,
      observedProfileHash: profileInputHash,
      expectedProfileVersion: version,
      observedProfileVersion: version,
      allocationRevision: 1,
      currentAllocationSource: allocationSource,
      observedRegulatoryVersion: regulatoryRuleVersion,
      currentRegulatoryVersion: regulatoryRuleVersion,
      policyVersion: recommendationPolicyVersion,
      observedRecommendationPolicyVersion: recommendationPolicyVersion,
      assumptionVersion: returnAssumptionVersion,
      assumptionHash: returnAssumptionHash,
      assumptionSource: returnAssumptionSource,
    },
    state_provenance: stateProvenance,
    instruments,
    dashboard_projection: { instrument_monthly_allocations: { ppf: 26000 } },
    advisory_text: 'Synthetic fixture explanation; not an advisory result.',
    advisory_explanation: { status: 'READY' },
  };
}

function renderJourney(path = '/profile?page=home') {
  window.history.replaceState({}, '', path);
  return render(<AuthProvider restoreOnMount={false}><App /></AuthProvider>);
}

async function createSyntheticProfile() {
  fireEvent.change(screen.getByTestId('profile-input-monthly_take_home'), { target: { value: '90000' } });
  fireEvent.change(screen.getByTestId('profile-input-monthly_savings'), { target: { value: '25000' } });
  fireEvent.change(screen.getByTestId('profile-input-age'), { target: { value: '34' } });
  fireEvent.click(screen.getByRole('button', { name: 'Moderate', exact: true }));
  fireEvent.click(screen.getByLabelText('Wealth Growth', { exact: true }));
  fireEvent.change(screen.getByTestId('profile-input-investment_horizon_years'), { target: { value: '12' } });
  fireEvent.click(screen.getByTestId('profile-save'));
  await screen.findByTestId('journey-home');
}

async function registerSyntheticUser() {
  await screen.findByText('New to Wealth Genie?');
  fireEvent.ended(document.getElementById('bg-video'));
  fireEvent.click(screen.getByText('Register'));
  fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: SYNTHETIC_USER.name } });
  fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: SYNTHETIC_USER.email } });
  fireEvent.change(document.getElementById('reg-mobile'), { target: { value: '9876543210' } });
  fireEvent.change(document.getElementById('reg-password'), { target: { value: 'Synthetic1!' } });
  fireEvent.change(document.getElementById('reg-confirm-password'), { target: { value: 'Synthetic1!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Complete Registration' }));
  await screen.findByText('Registration Successful!');
  fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  await screen.findByTestId('profile-save');
}

describe('synthetic financial journey integration', () => {
  beforeEach(() => {
    api.clearUserSession();
    api.setUserInfo(SYNTHETIC_USER, { broadcast: false });
    window.history.replaceState({}, '', '/profile?page=home');
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.spyOn(api, 'getCurrentProfile').mockRejectedValue({ status: 404, message: 'No synthetic profile exists.' });
    vi.spyOn(api, 'getCurrentRecommendation').mockRejectedValue({ status: 404, message: 'No synthetic recommendation exists.' });
    vi.spyOn(api, 'precomputeProfile').mockResolvedValue({ candidateId: 'synthetic-candidate-001' });
    vi.spyOn(api, 'completeFinancialProfile').mockImplementation(async () => {
      const profile = makeProfile(1);
      return { profile, recommendation: makeRecommendation(profile) };
    });
    vi.spyOn(api, 'getRecommendations').mockRejectedValue(new Error('No synthetic recompute configured.'));
    vi.spyOn(api, 'rankInvestmentCandidates').mockRejectedValue(new Error('Synthetic product provider outage.'));
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({
      currentFiscalYear: 'FY2026-27',
      currentFiscalYearVerified: true,
      verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
    });
    vi.spyOn(api, 'previewMarketContextAdjustment').mockRejectedValue(new Error('Synthetic preview not requested.'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: vi.fn().mockResolvedValue({ token: 'synthetic-session-token', user: SYNTHETIC_USER }),
      headers: { get: vi.fn(() => null) },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    api.clearUserSession();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('creates a synthetic profile and preserves its binding through Plan, Taxes, Progress, product failure, and Deep Dive', async () => {
    api.clearUserSession();
    renderJourney('/login');
    await registerSyntheticUser();
    await createSyntheticProfile();
    const initialRecommendation = makeRecommendation(makeProfile(1));
    expect(api.completeFinancialProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(PROFILE_ID);
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(initialRecommendation.recommendationId));

    fireEvent.click(screen.getByRole('button', { name: 'My Plan' }));
    expect(await screen.findByTestId('journey-plan')).toBeVisible();
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(PROFILE_ID);
    expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(initialRecommendation.recommendationId);

    fireEvent.click(screen.getByRole('button', { name: 'Taxes' }));
    expect(await screen.findByTestId('journey-taxes')).toBeVisible();
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('1');
    expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(initialRecommendation.recommendationId);

    fireEvent.click(screen.getByRole('button', { name: 'Progress' }));
    expect(await screen.findByTestId('journey-progress')).toBeVisible();
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(PROFILE_ID);
    expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(initialRecommendation.recommendationId);

    fireEvent.click(screen.getByRole('button', { name: 'Where to Invest' }));
    expect(await screen.findByText(/Authoritative product ranking is temporarily unavailable/i)).toBeVisible();
    expect(api.rankInvestmentCandidates).toHaveBeenCalledWith(
      PROFILE_ID,
      'ppf',
      expect.any(Object),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.objectContaining({
        profileId: PROFILE_ID,
        profileVersion: 1,
        recommendationId: initialRecommendation.recommendationId,
      }),
    );
    expect(screen.queryByText('Synthetic product provider outage.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Full Deep Dive/i }));
    expect(await screen.findByTestId('journey-deep-dive')).toBeVisible();
    expect(screen.getByTestId('deep-dive-profile-id')).toHaveTextContent(PROFILE_ID);
    expect(screen.getByTestId('deep-dive-recommendation-id')).toHaveTextContent(initialRecommendation.recommendationId);
    expect(screen.getByTestId('deep-dive-investment')).toHaveTextContent('Public Provident Fund (PPF)');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('restores a saved profile and recommendation consistently across reload-equivalent mounts', async () => {
    const profile = makeProfile(1);
    const recommendation = makeRecommendation(profile);
    api.getCurrentProfile.mockResolvedValue(profile);
    api.getCurrentRecommendation.mockResolvedValue(recommendation);

    const firstMount = renderJourney();
    await screen.findByTestId('journey-home');
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(PROFILE_ID);
    await waitFor(() => expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(recommendation.recommendationId));
    expect(api.completeFinancialProfile).not.toHaveBeenCalled();
    firstMount.unmount();

    renderJourney();
    await screen.findByTestId('journey-home');
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(PROFILE_ID);
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(recommendation.recommendationId));
    expect(api.getCurrentProfile).toHaveBeenCalledTimes(2);
    expect(api.getCurrentRecommendation).toHaveBeenCalledTimes(2);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('ignores concurrent version-1 recomputes after the synthetic profile changes to version 2', async () => {
    const profileV1 = makeProfile(1);
    const profileV2 = makeProfile(2);
    api.getCurrentProfile.mockResolvedValue(profileV1);
    api.getCurrentRecommendation.mockResolvedValue(makeRecommendation(profileV1));
    const pendingRecomputes = [];
    api.getRecommendations.mockImplementation(() => new Promise(resolve => pendingRecomputes.push(resolve)));

    renderJourney();
    await screen.findByTestId('journey-home');
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate synthetic plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate synthetic plan' }));
    await waitFor(() => expect(api.getRecommendations).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save synthetic profile version 2' }));
    await waitFor(() => expect(api.getRecommendations).toHaveBeenCalledTimes(3));

    await act(async () => pendingRecomputes[2](makeRecommendation(profileV2)));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => {
      expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('2');
      expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(makeRecommendation(profileV2).recommendationId);
    });

    await act(async () => {
      pendingRecomputes[1](makeRecommendation(profileV1));
      pendingRecomputes[0](makeRecommendation(profileV1));
    });
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('2');
    expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(makeRecommendation(profileV2).recommendationId);
  });

  it('does not let a late saved-session restore replace a newer synthetic login or persist profile data in browser storage', async () => {
    api.clearUserSession();
    let resolveRestore;
    const fetchMock = vi.fn((input) => {
      if (String(input).includes('/auth/session')) {
        return new Promise(resolve => { resolveRestore = resolve; });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ token: 'second-synthetic-session-token', user: SECOND_SYNTHETIC_USER }),
        headers: { get: vi.fn(() => null) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const staleRestore = api.restoreSession();
    await waitFor(() => expect(resolveRestore).toBeTypeOf('function'));
    await api.login(SECOND_SYNTHETIC_USER.email, 'Synthetic1!');
    await act(async () => resolveRestore({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ user: SYNTHETIC_USER }),
      headers: { get: vi.fn(() => null) },
    }));
    await staleRestore;

    expect(api.getUserInfo()).toEqual(SECOND_SYNTHETIC_USER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps User B financial state visible when User A recommendation work resolves after an account switch', async () => {
    const secondProfileId = '000000000000000000000102';
    const profileA = makeProfile(1);
    const recommendationA = makeRecommendation(profileA);
    const profileB = makeProfile(2, secondProfileId);
    const recommendationB = makeRecommendation(profileB);
    const pendingUserARecommendations = [];

    api.getCurrentProfile.mockImplementation(async () => (
      api.getUserInfo()?.id === SECOND_SYNTHETIC_USER.id ? profileB : profileA
    ));
    api.getCurrentRecommendation.mockImplementation(async profileId => (
      profileId === secondProfileId ? recommendationB : recommendationA
    ));
    api.getRecommendations.mockImplementation((profileId, options = {}) => new Promise(resolve => {
      pendingUserARecommendations.push({ profileId, signal: options.signal, resolve });
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ token: 'second-synthetic-session-token', user: SECOND_SYNTHETIC_USER }),
      headers: { get: vi.fn(() => null) },
    }));

    renderJourney();
    await screen.findByTestId('journey-home');
    await waitFor(() => expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(recommendationA.recommendationId));
    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(profileA.profileId);

    fireEvent.click(screen.getByRole('button', { name: 'Recalculate synthetic plan' }));
    await waitFor(() => expect(pendingUserARecommendations).toHaveLength(1));
    expect(pendingUserARecommendations[0].profileId).toBe(profileA.profileId);

    act(() => api.clearUserSession());
    await screen.findByText('New to Wealth Genie?');
    fireEvent.ended(document.getElementById('bg-video'));
    expect(pendingUserARecommendations[0].signal.aborted).toBe(true);
    fireEvent.change(document.getElementById('login-email'), { target: { value: SECOND_SYNTHETIC_USER.email } });
    fireEvent.change(document.getElementById('login-password'), { target: { value: 'Synthetic1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(profileB.profileId));
    await waitFor(() => expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(recommendationB.recommendationId));
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('2');
    expect(screen.getByTestId('journey-monthly-savings')).toHaveTextContent('26000');

    await act(async () => pendingUserARecommendations[0].resolve(recommendationA));

    expect(screen.getByTestId('journey-profile-id')).toHaveTextContent(profileB.profileId);
    expect(screen.getByTestId('journey-profile-version')).toHaveTextContent('2');
    expect(screen.getByTestId('journey-monthly-savings')).toHaveTextContent('26000');
    expect(screen.getByTestId('journey-recommendation-id')).toHaveTextContent(recommendationB.recommendationId);
    expect(screen.queryByText(profileA.profileId)).toBeNull();
    expect(screen.queryByText(recommendationA.recommendationId)).toBeNull();
    expect(screen.queryByText('25000')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
