/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { advisoryMatchesCurrentFinancialState } from '../App.jsx';

const appMocks = vi.hoisted(() => ({
  initialRecommendation: null,
  profile: null,
  profileChangeListener: null,
  fetchAdvisory: vi.fn(),
  getCurrentProfile: vi.fn(),
  getCurrentRecommendation: vi.fn(),
  getRecommendations: vi.fn(),
  subscribeProfileChanges: vi.fn(),
  updateRecommendationWeights: vi.fn(),
  logout: vi.fn(),
  cancelChatSend: vi.fn(),
  getChatHistory: vi.fn(),
  getTaxPolicyMetadata: vi.fn(),
  sendChatMessage: vi.fn(),
  mountActualChat: false,
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchAdvisory: appMocks.fetchAdvisory,
    getCurrentProfile: appMocks.getCurrentProfile,
    getCurrentRecommendation: appMocks.getCurrentRecommendation,
    getRecommendations: appMocks.getRecommendations,
    getChatHistory: appMocks.getChatHistory,
    getTaxPolicyMetadata: appMocks.getTaxPolicyMetadata,
    sendChatMessage: appMocks.sendChatMessage,
    subscribeProfileChanges: listener => {
      appMocks.profileChangeListener = listener;
      return () => { appMocks.profileChangeListener = null; };
    },
    updateRecommendationWeights: appMocks.updateRecommendationWeights,
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isInitializing: false, logout: appMocks.logout }),
}));

vi.mock('../components/ProfilePage', async () => {
  const ReactModule = await import('react');
  function MockProfilePage({ children }) {
    const [profile, setProfile] = ReactModule.useState(appMocks.profile);
    const [recommendation, setRecommendation] = ReactModule.useState(appMocks.initialRecommendation);
    ReactModule.useEffect(() => setProfile(appMocks.profile), [appMocks.profile]);
    return ReactModule.cloneElement(children, {
      userProfile: profile,
      onProfileUpdate: updated => {
        setProfile(updated);
        setRecommendation(null);
      },
      initialRecommendation: recommendation,
    });
  }
  return {
    default: MockProfilePage,
  };
});

vi.mock('../components/ProgressHub', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ financialState, financialStateIdentity, isAdvisoryLoading, onSaveRebalance, onNavigate }) => ReactModule.createElement(
      'section',
      null,
      ReactModule.createElement('output', { 'data-testid': 'allocation-revision' }, String(financialState?.allocation_revision ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'portfolio-fingerprint' }, financialState?.portfolio_fingerprint ?? 'missing'),
      ReactModule.createElement('output', { 'data-testid': 'advisory-status' }, financialState?.advisory_explanation?.status ?? 'missing'),
      ReactModule.createElement('output', { 'data-testid': 'advisory-text' }, financialState?.advisory_text ?? ''),
      ReactModule.createElement('output', { 'data-testid': 'advisory-loading' }, String(Boolean(isAdvisoryLoading))),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => void onSaveRebalance([{ id: 'fixture-instrument', allocationWeight: 1 }], financialStateIdentity),
      }, 'Apply revision 5'),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => void onSaveRebalance([{ id: 'fixture-instrument', allocationWeight: 1 }], `${financialStateIdentity}:stale`),
      }, 'Apply stale rebalance'),
      ReactModule.createElement('button', { type: 'button', onClick: () => onNavigate('home') }, 'View dashboard'),
    ),
  };
});

vi.mock('../components/Sidebar', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ onNavigate, onLogout }) => ReactModule.createElement('nav', null,
      ReactModule.createElement('button', { type: 'button', onClick: () => onNavigate('home') }, 'Test home'),
      ReactModule.createElement('button', { type: 'button', onClick: () => onNavigate('account') }, 'Test account'),
      ReactModule.createElement('button', { type: 'button', onClick: () => { void onLogout().catch(() => {}); } }, 'Test logout')),
  };
});
vi.mock('../components/GenieChat', async (importOriginal) => {
  const ReactModule = await import('react');
  const actual = await importOriginal();
  return {
    default: (props) => {
      if (appMocks.mountActualChat) return ReactModule.createElement(actual.default, props);
      const { recommendationContextReady, cancelPendingSendRef } = props;
      if (cancelPendingSendRef) cancelPendingSendRef.current = appMocks.cancelChatSend;
      return ReactModule.createElement('output', { 'data-testid': 'chat-context-ready' }, String(Boolean(recommendationContextReady)));
    },
  };
});
vi.mock('../components/ErrorBoundary', () => ({ default: ({ children }) => children }));
vi.mock('../RecommendationDashboard', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ recommendationMeta, onNavigate, onLearnMore, fallbackNotice, onRecalculate, userProfile, isAdvisoryLoading }) => ReactModule.createElement(
      'section',
      null,
      ReactModule.createElement('output', { 'data-testid': 'allocation-revision' }, String(recommendationMeta?.allocation_revision ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'portfolio-fingerprint' }, recommendationMeta?.portfolio_fingerprint ?? 'missing'),
      ReactModule.createElement('output', { 'data-testid': 'dashboard-profile-version' }, String(userProfile?.version ?? 'missing')),
      ReactModule.createElement('output', { 'data-testid': 'recommendation-fallback' }, fallbackNotice?.message ?? ''),
      ReactModule.createElement('output', { 'data-testid': 'advisory-status' }, recommendationMeta?.advisory_explanation?.status ?? 'missing'),
      ReactModule.createElement('output', { 'data-testid': 'advisory-text' }, recommendationMeta?.advisory_text ?? ''),
      ReactModule.createElement('output', { 'data-testid': 'advisory-loading' }, String(Boolean(isAdvisoryLoading))),
      ReactModule.createElement('button', { type: 'button', onClick: () => void onRecalculate() }, 'Retry recompute'),
      ReactModule.createElement('button', { type: 'button', onClick: () => onLearnMore({ id: 'ppf', name: 'PPF' }) }, 'Open deep dive'),
      ReactModule.createElement('button', { type: 'button', onClick: () => onNavigate('progress') }, 'Open progress'),
      ReactModule.createElement('button', { type: 'button', onClick: () => onNavigate('plan') }, 'Open plan'),
    ),
  };
});
vi.mock('../ProfileEditor', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ userProfile, onProfileUpdate, onProfileChangeStart }) => ReactModule.createElement(
      'section',
      null,
      ReactModule.createElement('output', { 'data-testid': 'editor-profile-version' }, String(userProfile?.version ?? 'missing')),
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
      }, 'Save next profile version'),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => {
          onProfileChangeStart?.();
          const updatedProfile = {
            ...userProfile,
            version: Number(userProfile.version) + 1,
            monthly_savings: Number(userProfile.monthly_savings) + 1000,
          };
          onProfileUpdate(updatedProfile, {
            recommendation: {
              ...currentState(1, {
                stateId: '64b000000000000000000051',
                allocationRevisionId: '64b000000000000000000052',
                recommendationId: '64b000000000000000000053',
                profileVersion: updatedProfile.version,
                profileInputHash: nextProfileInputHash,
              }),
              instruments: [],
              advisory_text: 'Atomic update advisory',
              advisory_explanation: { status: 'READY' },
            },
          });
        },
      }, 'Save atomically committed profile version'),
      ReactModule.createElement('button', {
        type: 'button',
        onClick: () => {
          onProfileChangeStart?.();
          onProfileUpdate({ ...userProfile });
        },
      }, 'Commit unchanged profile snapshot'),
    ),
  };
});
vi.mock('../components/AllocationPlanner', async () => {
  const ReactModule = await import('react');
  const { useNavigate } = await import('react-router-dom');
  function MockAllocationPlanner({ onRecomputePlan }) {
    const navigate = useNavigate();
    return ReactModule.createElement(
      'section',
      null,
      ReactModule.createElement('button', { type: 'button', onClick: () => void onRecomputePlan() }, 'Refresh recommendation'),
      ReactModule.createElement('button', { type: 'button', onClick: () => navigate('/profile?page=progress') }, 'Open progress'),
    );
  }
  return {
    default: MockAllocationPlanner,
  };
});
vi.mock('../components/DeepDiveModal', async () => {
  const ReactModule = await import('react');
  return {
    default: ({ isOpen, investment }) => isOpen
      ? ReactModule.createElement('div', { 'data-testid': 'deep-dive-open' }, investment?.name ?? 'Unavailable')
      : null,
  };
});

const recommendationId = '64b000000000000000000001';
const profileId = '64b000000000000000000002';
const profileInputHash = 'a'.repeat(64);
const nextProfileInputHash = '9'.repeat(64);
const returnAssumptionHash = 'd'.repeat(64);
const recommendationPolicyVersion = 'recommendation-policy-test-v1';
const regulatoryRuleVersion = 'regulatory-policy-test-v1';
const returnAssumptionVersion = 'assumption-test-v1';
const returnAssumptionSource = 'WEALTHGENIE_MODEL_POLICY';

function currentState(revision, {
  fingerprint = 'b'.repeat(64),
  stateId = '64b000000000000000000005',
  allocationRevisionId = `64b00000000000000000000${revision}`,
  recommendationId: boundRecommendationId = recommendationId,
  profileVersion = 1,
  profileInputHash: boundProfileInputHash = profileInputHash,
} = {}) {
  const recommendationFingerprint = (revision === 4 ? 'c' : 'e').repeat(64);
  const provenance = {
    status: 'PERSISTED_REVISION',
    stateId,
    recommendationId: boundRecommendationId,
    allocationSource: revision === 1 ? 'ORIGINAL_RECOMMENDATION' : 'USER_REBALANCED',
    allocationRevision: revision,
    allocationRevisionId,
    profileVersion,
    profileInputHash: boundProfileInputHash,
    portfolioFingerprint: fingerprint,
    recommendationFingerprint,
    recommendationPolicyVersion,
    regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    returnAssumptionSource,
    previousAllocationRevision: revision > 1 ? revision - 1 : null,
    previousAllocationRevisionId: revision > 1 ? `64b00000000000000000000${revision - 1}` : null,
  };
  return {
    profileId,
    profile_version: profileVersion,
    profile_input_hash: boundProfileInputHash,
    recommendationId: boundRecommendationId,
    recommendation_id: boundRecommendationId,
    allocation_revision: revision,
    allocation_revision_id: allocationRevisionId,
    previous_allocation_revision: provenance.previousAllocationRevision,
    previous_allocation_revision_id: provenance.previousAllocationRevisionId,
    portfolio_fingerprint: fingerprint,
    recommendation_fingerprint: recommendationFingerprint,
    recommendation_policy_version: recommendationPolicyVersion,
    regulatory_rule_version: regulatoryRuleVersion,
    return_assumption_version: returnAssumptionVersion,
    return_assumption_source: returnAssumptionSource,
    return_assumption_hash: returnAssumptionHash,
    current_allocation_source: revision === 1 ? 'ORIGINAL_RECOMMENDATION' : 'USER_REBALANCED',
    response_state: 'CURRENT',
    calculation_freshness: {
      fresh: true,
      reasonCodes: [],
      expectedProfileHash: boundProfileInputHash,
      observedProfileHash: boundProfileInputHash,
      expectedProfileVersion: profileVersion,
      observedProfileVersion: profileVersion,
      allocationRevision: revision,
      currentAllocationSource: revision === 1 ? 'ORIGINAL_RECOMMENDATION' : 'USER_REBALANCED',
      observedRegulatoryVersion: regulatoryRuleVersion,
      currentRegulatoryVersion: regulatoryRuleVersion,
      policyVersion: recommendationPolicyVersion,
      observedRecommendationPolicyVersion: recommendationPolicyVersion,
      assumptionVersion: returnAssumptionVersion,
      assumptionHash: returnAssumptionHash,
      assumptionSource: returnAssumptionSource,
    },
    state_provenance: provenance,
  };
}

const revision4 = {
  ...currentState(4, { fingerprint: 'b'.repeat(64) }),
  recommendationId,
};

function advisoryBinding(overrides = {}) {
  return {
    ...revision4,
    profile_version: revision4.profile_version,
    profile_input_hash: revision4.profile_input_hash,
    recommendation_fingerprint: revision4.recommendation_fingerprint,
    recommendation_policy_version: revision4.recommendation_policy_version,
    regulatory_rule_version: revision4.regulatory_rule_version,
    return_assumption_hash: revision4.return_assumption_hash,
    advisory_text: 'Advice generated for allocation revision 4',
    advisory_explanation: { status: 'READY' },
    ...overrides,
  };
}

describe('deferred advisory allocation binding', () => {
  let resolveAdvisory;

  beforeEach(() => {
    appMocks.profile = {
      profileId,
      version: 1,
      age: 34,
      monthly_take_home: 100000,
      monthly_savings: 25000,
      investment_goals: ['Wealth Growth'],
      investment_horizon_years: 10,
      risk_tolerance: 'Moderate',
    };
    appMocks.initialRecommendation = {
      ...revision4,
      instruments: [],
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    };
    appMocks.fetchAdvisory.mockReset();
    appMocks.getCurrentRecommendation.mockReset();
    appMocks.getCurrentRecommendation.mockResolvedValue(revision4);
    appMocks.fetchAdvisory.mockImplementation(() => new Promise(resolve => {
      resolveAdvisory = resolve;
    }));
    appMocks.getRecommendations.mockReset();
    appMocks.updateRecommendationWeights.mockReset();
    appMocks.updateRecommendationWeights.mockResolvedValue({
      ...currentState(5, { fingerprint: 'f'.repeat(64), stateId: '64b000000000000000000006' }),
      recommendation_id: recommendationId,
      instruments: [],
      advisory_text: null,
      advisory_explanation: { status: 'STALE' },
      explanation: null,
      generation_explanation: null,
      portfolio_return_assumption: null,
      return_data_class: null,
      return_assumption_version: returnAssumptionVersion,
      return_assumption_source: returnAssumptionSource,
      return_assumption_hash: returnAssumptionHash,
      observed_market_fact: false,
      provider_forecast: false,
      asset_class_allocation: {},
      dashboard_projection: {},
      current_allocation_source: 'USER_REBALANCED',
      generation_market_adjustment: null,
      market_adjustment: null,
    });
    window.history.replaceState({}, '', '/profile?page=home');
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not merge revision 4 advisory after the App advances to revision 5', async () => {
    render(<App />);

    await waitFor(() => expect(appMocks.fetchAdvisory).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('4');

    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    await screen.findByRole('button', { name: 'Apply revision 5' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply revision 5' }));
    await waitFor(() => {
      expect(appMocks.updateRecommendationWeights).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));
    await waitFor(() => {
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    });

    await act(async () => {
      resolveAdvisory(advisoryBinding());
    });

    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByTestId('advisory-text')).toBeEmptyDOMElement();
    expect(screen.getByTestId('advisory-text')).not.toHaveTextContent('revision 4');
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('STALE');
  });

  it('rejects a rebalance save submitted against an obsolete canonical financial-state identity', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('allocation-revision')).toHaveTextContent('4'));
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply stale rebalance' }));

    expect(globalThis.alert).toHaveBeenCalledWith('Your portfolio changed since this page was loaded. Refresh before saving this rebalance.');
    expect(appMocks.updateRecommendationWeights).not.toHaveBeenCalled();
  });

  it('reloads the canonical portfolio after a rebalance allocation revision conflict', async () => {
    const canonical = {
      ...currentState(5, {
        fingerprint: 'f'.repeat(64),
        stateId: '64b000000000000000000006',
      }),
      instruments: [],
      advisory_text: null,
      advisory_explanation: { status: 'STALE' },
    };
    appMocks.updateRecommendationWeights.mockRejectedValueOnce(Object.assign(
      new Error('The allocation revision changed before save.'),
      { status: 409, code: 'ALLOCATION_REVISION_CONFLICT' },
    ));
    appMocks.getCurrentRecommendation.mockResolvedValue(canonical);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('allocation-revision')).toHaveTextContent('4'));
    const initialReloadCount = appMocks.getCurrentRecommendation.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply revision 5' }));

    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation.mock.calls.length).toBeGreaterThan(initialReloadCount);
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    });
    expect(appMocks.updateRecommendationWeights).toHaveBeenCalledTimes(1);
    expect(globalThis.alert).toHaveBeenCalledWith('Your portfolio changed since this page was loaded. Refresh before saving this rebalance.');
  });

  it('does not merge READY(S1) from a 409 retry after the real App advances to S2 and clears obsolete loading', async () => {
    let signalRetryStarted;
    const retryStarted = new Promise(resolve => { signalRetryStarted = resolve; });
    let resolveRetry;
    let calls = 0;
    appMocks.fetchAdvisory.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(Object.assign(
          new Error('Another request is generating this advisory.'),
          { status: 409, code: 'ADVISORY_GENERATION_IN_PROGRESS' },
        ));
      }
      if (calls === 2) {
        return new Promise(resolve => {
          resolveRetry = resolve;
          signalRetryStarted();
        });
      }
      throw new Error('Unexpected extra advisory attempt');
    });

    render(<App />);
    await retryStarted;
    expect(calls).toBe(2);
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('GENERATING');
    expect(screen.getByTestId('advisory-loading')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply revision 5' }));
    await waitFor(() => expect(appMocks.updateRecommendationWeights).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));
    await waitFor(() => {
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
      expect(screen.getByTestId('advisory-loading')).toHaveTextContent('false');
    });

    await act(async () => {
      resolveRetry(advisoryBinding());
    });

    expect(calls).toBe(2);
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByTestId('advisory-text')).toBeEmptyDOMElement();
    expect(screen.getByTestId('advisory-text')).not.toHaveTextContent('revision 4');
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('STALE');
    expect(screen.getByTestId('advisory-loading')).toHaveTextContent('false');
    expect(screen.getByTestId('recommendation-fallback')).toBeEmptyDOMElement();
  });

  it('reloads the canonical recommendation when advisory generation reports supersession', async () => {
    const supersededRecommendationId = '64b000000000000000000061';
    const canonical = {
      ...currentState(1, {
        fingerprint: '7'.repeat(64),
        stateId: '64b000000000000000000062',
        allocationRevisionId: '64b000000000000000000063',
        recommendationId: supersededRecommendationId,
      }),
      instruments: [],
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    };
    appMocks.getCurrentRecommendation.mockResolvedValueOnce(canonical);
    appMocks.fetchAdvisory.mockRejectedValueOnce(Object.assign(
      new Error('A newer recommendation superseded this generation.'),
      { status: 409, code: 'RECOMMENDATION_SUPERSEDED' },
    ));

    render(<App />);

    await waitFor(() => {
      expect(appMocks.fetchAdvisory).toHaveBeenCalledTimes(1);
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('1');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('7'.repeat(64));
    });

    expect(appMocks.getCurrentRecommendation).toHaveBeenCalledWith(
      profileId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByTestId('advisory-text')).toBeEmptyDOMElement();
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('PENDING');
    expect(screen.getByTestId('recommendation-fallback')).toBeEmptyDOMElement();
  });

  it('also discards a late advisory from handleAuthoritativeRecompute after state advances', async () => {
    appMocks.initialRecommendation = {
      ...appMocks.initialRecommendation,
      advisory_text: 'Previously validated revision 4 advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.getRecommendations.mockResolvedValueOnce({
      ...appMocks.initialRecommendation,
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    });

    render(<App />);
    await screen.findByTestId('allocation-revision');
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    await screen.findByRole('button', { name: 'Refresh recommendation' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recommendation' }));

    await waitFor(() => {
      expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1);
      expect(appMocks.fetchAdvisory).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply revision 5' }));
    await waitFor(() => expect(appMocks.updateRecommendationWeights).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'View dashboard' }));
    await waitFor(() => {
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    });

    await act(async () => {
      resolveAdvisory(advisoryBinding());
    });

    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByTestId('advisory-text')).toBeEmptyDOMElement();
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('STALE');
  });

  it('accepts only a complete exact source-state binding', () => {
    const current = { ...revision4 };
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding())).toBe(true);
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding({ allocation_revision: 5 }))).toBe(false);
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding({ portfolio_fingerprint: 'another-fingerprint' }))).toBe(false);
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding({ allocation_revision: undefined }))).toBe(false);
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding({ portfolio_fingerprint: undefined }))).toBe(false);
    expect(advisoryMatchesCurrentFinancialState(current, advisoryBinding({ allocation_revision_id: undefined }))).toBe(false);
  });

  it('does not display or generate from a response bound to another profile', async () => {
    appMocks.initialRecommendation = null;
    appMocks.getCurrentRecommendation.mockResolvedValue({
      ...revision4,
      profileId: '64b000000000000000000099',
    });

    render(<App />);

    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('missing');
    });
    expect(appMocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('does not let an earlier recompute overwrite a later recompute on the same profile', async () => {
    appMocks.initialRecommendation = {
      ...revision4,
      advisory_text: 'Existing advisory',
      advisory_explanation: { status: 'READY' },
    };
    const pending = [];
    appMocks.getRecommendations.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const view = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh recommendation' });
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recommendation' }));
    await waitFor(() => expect(pending).toHaveLength(2));

    const laterRecommendationId = '64b000000000000000000011';
    const later = {
      ...currentState(1, {
        fingerprint: 'f'.repeat(64),
        stateId: '64b000000000000000000012',
        allocationRevisionId: '64b000000000000000000013',
        recommendationId: laterRecommendationId,
      }),
      advisory_text: 'Later advisory',
      advisory_explanation: { status: 'READY' },
    };
    await act(async () => pending[1](later));
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View dashboard' }));
    await waitFor(() => expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64)));

    await act(async () => pending[0](currentState(1, {
      fingerprint: 'a'.repeat(64),
      stateId: '64b000000000000000000014',
      allocationRevisionId: '64b000000000000000000015',
    })));
    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    view.unmount();
  });

  it('rejects a late recompute from the old profile version after a newer profile state is restored', async () => {
    appMocks.initialRecommendation = {
      ...revision4,
      advisory_text: 'Existing advisory',
      advisory_explanation: { status: 'READY' },
    };
    const pending = [];
    appMocks.getRecommendations.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const view = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh recommendation' }));
    await waitFor(() => expect(pending).toHaveLength(1));

    appMocks.profile = { ...appMocks.profile, version: 2, monthly_savings: 30000 };
    const restoredProfileState = {
      ...currentState(1, {
        fingerprint: 'd'.repeat(64),
        stateId: '64b000000000000000000016',
        allocationRevisionId: '64b000000000000000000017',
        recommendationId: '64b000000000000000000018',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      advisory_text: 'Profile version 2 advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.getCurrentRecommendation.mockResolvedValueOnce(restoredProfileState);
    view.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View dashboard' }));
    await waitFor(() => expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('d'.repeat(64)));

    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recommendation' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    const newerProfileState = {
      ...currentState(1, {
        fingerprint: 'f'.repeat(64),
        stateId: '64b000000000000000000019',
        allocationRevisionId: '64b000000000000000000020',
        recommendationId: '64b000000000000000000021',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      advisory_text: 'Recomputed version 2 advisory',
      advisory_explanation: { status: 'READY' },
    };
    await act(async () => pending[1](newerProfileState));
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View dashboard' }));
    await waitFor(() => expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64)));
    await act(async () => pending[0](currentState(1, {
      fingerprint: 'a'.repeat(64),
      stateId: '64b000000000000000000022',
      allocationRevisionId: '64b000000000000000000023',
    })));

    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('1');
    view.unmount();
  });

  it('ignores an old advisory failure after the active profile version changes', async () => {
    appMocks.initialRecommendation = {
      ...revision4,
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    };
    let rejectOldAdvisory;
    appMocks.fetchAdvisory.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectOldAdvisory = reject;
    }));
    const view = render(<App />);
    await waitFor(() => expect(rejectOldAdvisory).toBeTypeOf('function'));

    const nextProfileState = {
      ...currentState(1, {
        fingerprint: 'f'.repeat(64),
        stateId: '64b000000000000000000024',
        allocationRevisionId: '64b000000000000000000025',
        recommendationId: '64b000000000000000000026',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      advisory_text: 'Version 2 advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.profile = { ...appMocks.profile, version: 2, monthly_savings: 30000 };
    appMocks.getCurrentRecommendation.mockResolvedValueOnce(nextProfileState);
    view.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View dashboard' }));
    await waitFor(() => expect(screen.getByTestId('advisory-text')).toHaveTextContent('Version 2 advisory'));

    await act(async () => rejectOldAdvisory({ status: 500, message: 'Old profile advisory failed' }));
    expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('f'.repeat(64));
    expect(screen.getByTestId('advisory-text')).toHaveTextContent('Version 2 advisory');
    expect(screen.getByTestId('advisory-status')).toHaveTextContent('READY');
    view.unmount();
  });
});

describe('profile edits trigger one authoritative recommendation recompute', () => {
  beforeEach(() => {
    appMocks.profile = {
      profileId,
      version: 1,
      age: 34,
      monthly_take_home: 100000,
      monthly_savings: 25000,
      investment_goals: ['Wealth Growth'],
      investment_horizon_years: 10,
      risk_tolerance: 'Moderate',
    };
    appMocks.initialRecommendation = {
      ...revision4,
      instruments: [],
      advisory_text: 'Version 1 advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.fetchAdvisory.mockReset();
    appMocks.fetchAdvisory.mockResolvedValue({});
    appMocks.getCurrentProfile.mockReset();
    appMocks.getCurrentProfile.mockResolvedValue(appMocks.profile);
    appMocks.getCurrentRecommendation.mockReset();
    appMocks.getCurrentRecommendation.mockResolvedValue(revision4);
    appMocks.getRecommendations.mockReset();
    appMocks.updateRecommendationWeights.mockReset();
    appMocks.logout.mockReset();
    appMocks.cancelChatSend.mockReset();
    appMocks.getChatHistory.mockReset();
    appMocks.getChatHistory.mockResolvedValue({ conversations: [] });
    appMocks.getTaxPolicyMetadata.mockReset();
    appMocks.getTaxPolicyMetadata.mockResolvedValue({ verifiedFiscalYears: [] });
    appMocks.sendChatMessage.mockReset();
    appMocks.mountActualChat = false;
    sessionStorage.clear();
    window.history.replaceState({}, '', '/profile?page=account');
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('closes a deep-dive selection as soon as the financial profile identity changes', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open deep dive' }));
    expect(await screen.findByTestId('deep-dive-open')).toHaveTextContent('PPF');

    fireEvent.click(screen.getByRole('button', { name: 'Test account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save next profile version' }));

    await waitFor(() => expect(screen.queryByTestId('deep-dive-open')).toBeNull());
  });

  it('closes a deep-dive selection when the canonical allocation revision changes for the same profile', async () => {
    appMocks.updateRecommendationWeights.mockResolvedValue({
      ...currentState(5, {
        fingerprint: 'f'.repeat(64),
        stateId: '64b000000000000000000006',
      }),
      instruments: [],
      advisory_text: null,
      advisory_explanation: { status: 'STALE' },
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open deep dive' }));
    expect(await screen.findByTestId('deep-dive-open')).toHaveTextContent('PPF');

    fireEvent.click(screen.getByRole('button', { name: 'Open progress' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply revision 5' }));

    await waitFor(() => {
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('5');
      expect(screen.queryByTestId('deep-dive-open')).toBeNull();
    });
  });

  it('clears v1 immediately, recomputes v2 once, and ignores a late v2 after v3 is saved', async () => {
    const pending = [];
    appMocks.getRecommendations.mockImplementation((id, options) => new Promise(resolve => {
      pending.push({ id, signal: options.signal, resolve });
    }));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save next profile version' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].id).toBe(profileId);
    expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('2');
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('missing');

    fireEvent.click(screen.getByRole('button', { name: 'Test account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save next profile version' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal.aborted).toBe(true);
    expect(appMocks.getRecommendations).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    await act(async () => pending[0].resolve({
      ...currentState(1, {
        stateId: '64b000000000000000000031',
        allocationRevisionId: '64b000000000000000000032',
        recommendationId: '64b000000000000000000033',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      instruments: [],
      advisory_text: 'Late v2 advisory',
      advisory_explanation: { status: 'READY' },
    }));
    expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('3');
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('missing');

    await act(async () => pending[1].resolve({
      ...currentState(1, {
        stateId: '64b000000000000000000034',
        allocationRevisionId: '64b000000000000000000035',
        recommendationId: '64b000000000000000000036',
        profileVersion: 3,
        profileInputHash: '8'.repeat(64),
      }),
      instruments: [],
      advisory_text: 'Current v3 advisory',
      advisory_explanation: { status: 'READY' },
    }));
    await waitFor(() => {
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('1');
      expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('3');
      expect(screen.getByTestId('advisory-text')).toHaveTextContent('Current v3 advisory');
    });
    expect(appMocks.getCurrentRecommendation).not.toHaveBeenCalled();
    expect(appMocks.getRecommendations).toHaveBeenCalledTimes(2);
  });

  it('uses the recommendation committed with an atomic profile update without generating a duplicate', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save atomically committed profile version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('2');
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('1');
      expect(screen.getByTestId('advisory-text')).toHaveTextContent('Atomic update advisory');
    });
    expect(appMocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('does not let the initial restore effect abort a cross-tab profile recompute', async () => {
    const canonicalProfile = {
      ...appMocks.profile,
      version: 2,
      monthly_savings: 26000,
    };
    const recomputed = {
      ...currentState(1, {
        stateId: '64b000000000000000000061',
        allocationRevisionId: '64b000000000000000000062',
        recommendationId: '64b000000000000000000063',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      instruments: [],
      advisory_text: 'Current profile advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.getCurrentProfile.mockResolvedValue(canonicalProfile);
    appMocks.getRecommendations.mockResolvedValue(recomputed);
    render(<App />);

    await waitFor(() => expect(appMocks.profileChangeListener).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('1');
    await act(async () => appMocks.profileChangeListener());
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('2');
      expect(screen.getByTestId('portfolio-fingerprint')).toHaveTextContent('b'.repeat(64));
      expect(screen.getByTestId('advisory-text')).toHaveTextContent('Current profile advisory');
    });

    expect(appMocks.getCurrentProfile).toHaveBeenCalledTimes(1);
    expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1);
    expect(appMocks.getCurrentRecommendation).not.toHaveBeenCalled();
  });

  it('keeps chat context unready when the canonical recommendation fetch fails', async () => {
    appMocks.initialRecommendation = null;
    appMocks.getCurrentRecommendation.mockRejectedValue(new Error('temporary recommendation outage'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));

    await waitFor(() => {
      expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('false');
      expect(screen.getByTestId('recommendation-fallback')).toHaveTextContent('Authoritative recommendations are temporarily unavailable');
    });
    expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('aborts pending recommendation and chat work before logout', async () => {
    appMocks.initialRecommendation = null;
    appMocks.logout.mockImplementation(() => new Promise(resolve => { appMocks.finishLogout = resolve; }));
    let resolveRecommendation;
    let recommendationSignal;
    const pendingRecommendation = new Promise(resolve => { resolveRecommendation = resolve; });
    appMocks.getCurrentRecommendation.mockImplementation((_id, { signal }) => {
      recommendationSignal = signal;
      return pendingRecommendation;
    });
    render(<App />);
    await waitFor(() => expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Test logout' }));
    expect(recommendationSignal.aborted).toBe(true);
    expect(appMocks.cancelChatSend).toHaveBeenCalledTimes(1);
    expect(appMocks.logout).toHaveBeenCalledTimes(1);
    expect(appMocks.cancelChatSend.mock.invocationCallOrder[0]).toBeLessThan(appMocks.logout.mock.invocationCallOrder[0]);

    await act(async () => resolveRecommendation(revision4));
    expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('false');
    await act(async () => appMocks.finishLogout());
  });

  it('restores canonical recommendation context when logout fails after aborting its pending fetch', async () => {
    appMocks.initialRecommendation = null;
    appMocks.logout.mockRejectedValue(new Error('temporary sign-out outage'));
    let resolveAbortedRecommendation;
    const abortedRecommendation = new Promise(resolve => { resolveAbortedRecommendation = resolve; });
    appMocks.getCurrentRecommendation
      .mockImplementationOnce(() => abortedRecommendation)
      .mockResolvedValueOnce(revision4);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    await waitFor(() => expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'Test logout' }));
    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('recommendation-fallback')).toBeEmptyDOMElement();

    await act(async () => resolveAbortedRecommendation({
      ...revision4,
      advisory_text: 'stale response from the aborted restore',
    }));
    expect(screen.getByTestId('advisory-text')).not.toHaveTextContent('stale response from the aborted restore');
  });

  it('does not let a same-profile restore skip suppress logout-failure recovery', async () => {
    appMocks.initialRecommendation = null;
    appMocks.logout.mockRejectedValue(new Error('temporary sign-out outage'));
    let resolveAbortedRecompute;
    let recomputeSignal;
    const abortedRecompute = new Promise(resolve => { resolveAbortedRecompute = resolve; });
    appMocks.getRecommendations.mockImplementationOnce((_id, { signal }) => {
      recomputeSignal = signal;
      return abortedRecompute;
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit unchanged profile snapshot' }));
    await waitFor(() => expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('false');

    fireEvent.click(screen.getByRole('button', { name: 'Test logout' }));
    expect(recomputeSignal.aborted).toBe(true);
    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('chat-context-ready')).toHaveTextContent('true');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));

    await act(async () => resolveAbortedRecompute({
      ...revision4,
      advisory_text: 'stale same-profile recompute',
    }));
    expect(screen.getByTestId('advisory-text')).not.toHaveTextContent('stale same-profile recompute');
  });

  it('keeps mounted GenieChat honest and usable after same-profile logout recovery', async () => {
    appMocks.initialRecommendation = null;
    appMocks.mountActualChat = true;
    appMocks.logout.mockRejectedValue(new Error('temporary sign-out outage'));
    appMocks.getCurrentRecommendation.mockResolvedValue(revision4);
    let resolvePendingSend;
    let sendSignal;
    const pendingSend = new Promise(resolve => { resolvePendingSend = resolve; });
    appMocks.sendChatMessage.mockImplementation((_message, _sessionId, { signal }) => {
      sendSignal = signal;
      return pendingSend;
    });
    let resolveAbortedRecompute;
    const abortedRecompute = new Promise(resolve => { resolveAbortedRecompute = resolve; });
    appMocks.getRecommendations.mockImplementationOnce(() => abortedRecompute);
    render(<App />);
    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Genie AI' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(await screen.findByText(/your personal money guide/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /ask genie/i }), {
      target: { value: 'A message interrupted by an unsuccessful sign-out' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(appMocks.sendChatMessage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Commit unchanged profile snapshot' }));
    await waitFor(() => expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('A message interrupted by an unsuccessful sign-out')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Test logout' }));
    expect(sendSignal.aborted).toBe(true);
    await waitFor(() => {
      expect(appMocks.getCurrentRecommendation).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/couldn't confirm whether your message was sent before sign-out interrupted it/i)).toBeInTheDocument();
    });
    expect(screen.getByText('A message interrupted by an unsuccessful sign-out')).toBeInTheDocument();

    await act(async () => {
      resolvePendingSend({ response: 'A late Genie response after sign-out', rate_limit_remaining: 29 });
      resolveAbortedRecompute(revision4);
    });
    expect(screen.queryByText('A late Genie response after sign-out')).not.toBeInTheDocument();
    expect(screen.queryByText('A message interrupted by an unsuccessful sign-out')).toBeInTheDocument();
  });

  it('keeps recommendations unavailable after recompute failure and supports an explicit retry', async () => {
    const v2 = {
      ...currentState(1, {
        stateId: '64b000000000000000000041',
        allocationRevisionId: '64b000000000000000000042',
        recommendationId: '64b000000000000000000043',
        profileVersion: 2,
        profileInputHash: nextProfileInputHash,
      }),
      instruments: [],
      advisory_text: 'Version 2 advisory',
      advisory_explanation: { status: 'READY' },
    };
    appMocks.getRecommendations
      .mockRejectedValueOnce(new Error('temporary recommendation outage'))
      .mockResolvedValueOnce(v2);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save next profile version' }));
    await waitFor(() => expect(appMocks.getRecommendations).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Test home' }));
    await waitFor(() => expect(screen.getByTestId('recommendation-fallback')).toHaveTextContent('Authoritative recommendations are temporarily unavailable'));
    expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('2');
    expect(screen.getByTestId('allocation-revision')).toHaveTextContent('missing');

    fireEvent.click(screen.getByRole('button', { name: 'Retry recompute' }));
    await waitFor(() => {
      expect(appMocks.getRecommendations).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('allocation-revision')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('dashboard-profile-version')).toHaveTextContent('2');
  });
});
