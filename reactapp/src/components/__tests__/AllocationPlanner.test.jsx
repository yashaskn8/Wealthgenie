import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllocationPlanner from '../AllocationPlanner';
import * as api from '../../services/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const profile = {
  profileId: '64b000000000000000000001',
  monthly_savings: 30000,
  investment_horizon_years: 10,
  investment_goals: ['Wealth Growth'],
  risk_tolerance: 'Moderate',
};

const recommendations = [
  {
    id: 'ppf',
    name: 'Public Provident Fund',
    type: 'PPF',
    category: 'Government',
    allocationWeight: 0.6,
    monthly_allocation: 18000,
    nominalReturn: 7.1,
    riskLabel: 'Very Low',
  },
  {
    id: 'index-fund',
    name: 'Nifty 50 Index Fund',
    type: 'Index_MF',
    category: 'Equity',
    allocationWeight: 0.4,
    monthly_allocation: 12000,
    nominalReturn: 12,
    riskLabel: 'Moderate',
  },
];

const recommendationMeta = {
  portfolio_return_assumption: 9.2,
  advisory_text: 'This plan balances stability and long-term growth. [E_PROFILE_RISK]',
  current_allocation_source: 'Backend recommendation',
  return_basis: 'Versioned model assumption',
  return_assumption_version: 'test-policy-1.0.0',
  policy_lineage: 'market-context-policy-1.0.0',
};

const validPlanReviewResult = (overrides = {}) => ({
  version: 'plan-review-1.1.0',
  runId: '4f4f4f4f-1111-4111-8111-111111111111',
  status: 'COMPLETED',
  recommendedAction: 'NONE',
  summary: 'The available evidence is aligned with your saved plan.',
  findings: [],
  freshness: { fresh: true, reasonCodes: [] },
  goals: { status: 'NONE', items: [] },
  evidence: {
    status: 'AVAILABLE',
    entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', dataClass: 'DERIVED_VALUE', displayValue: 'The current recommendation matches the profile.', authority: 'WealthGenie backend' }],
    unavailableFacts: [],
  },
  financialClaims: [],
  provider: { name: 'DETERMINISTIC_FALLBACK', model: null, fallback: true },
  ...overrides,
});
const noPlanReviewRun = { status: 404, code: 'PLAN_REVIEW_RUN_NOT_FOUND', message: 'No plan review run found.' };

describe('AllocationPlanner', () => {
  it('preserves recommendation order and authoritative values in the redesigned sections', () => {
    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(screen.getByRole('heading', { name: /Where to invest your money/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Investment allocation breakdown donut chart' })).toBeInTheDocument();
    expect(screen.getAllByText('₹30,000').length).toBeGreaterThan(0);
    expect(screen.getByText('10 years')).toBeInTheDocument();
    expect(screen.getByText('Wealth Growth')).toBeInTheDocument();

    const cardHeadings = Array.from(document.querySelectorAll('.ap-plan-card h3'));
    expect(cardHeadings.map(heading => heading.textContent)).toEqual([
      'Public Provident Fund',
      'Nifty 50 Index Fund',
    ]);
    expect(screen.getByText('₹18,000')).toBeInTheDocument();
    expect(screen.getByText('₹12,000')).toBeInTheDocument();
    expect(screen.getByText('7.1%/yr')).toBeInTheDocument();
    expect(screen.getByText('12%/yr')).toBeInTheDocument();
    expect(screen.getByText('Very Low')).toBeInTheDocument();
    expect(screen.getAllByText('Moderate').length).toBeGreaterThan(0);
    expect(screen.getByText('This plan balances stability and long-term growth.')).toBeInTheDocument();
    expect(screen.queryByText('[E_PROFILE_RISK]')).not.toBeInTheDocument();
  });

  it('keeps an authoritative zero-weight investment visible with a zero monthly allocation', () => {
    render(<AllocationPlanner profile={profile} recommendations={[
      { ...recommendations[0], allocationWeight: 1, monthly_allocation: 30000 },
      { ...recommendations[1], id: 'zero-weight-fund', name: 'Zero Weight Fund', allocationWeight: 0, monthly_allocation: 0 },
    ]} recommendationMeta={recommendationMeta} />);

    const zeroWeightCard = screen.getByRole('heading', { name: 'Zero Weight Fund' }).closest('article');
    expect(zeroWeightCard).toHaveTextContent('0.0%');
    expect(zeroWeightCard).toHaveTextContent('₹0');
    expect(screen.getByText('100.0% allocated')).toBeInTheDocument();
    expect(screen.getByText(/Allocated across/)).toHaveTextContent('Allocated across 1 investment in 1 asset class');
  });

  it('exposes keyboard-accessible term help and the methodology dialog', async () => {
    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    fireEvent.focus(screen.getAllByRole('button', { name: 'More information about Risk' })[0]);
    await waitFor(() => expect(screen.getByText(/risk classification supplied/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /View methodology/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How this plan is built' })).toBeInTheDocument();
    expect(screen.getByText('market-context-policy-1.0.0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('renders truthful loading, error, and empty states without fabricated values', () => {
    const { rerender } = render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={{ status: 'LOADING' }} />);
    expect(screen.getByRole('heading', { name: 'Preparing your plan' })).toBeInTheDocument();
    expect(screen.queryByText('₹30,000')).not.toBeInTheDocument();

    rerender(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={{ status: 'ERROR' }} />);
    expect(screen.getByRole('heading', { name: "We couldn't load your plan" })).toBeInTheDocument();

    rerender(<AllocationPlanner profile={profile} recommendations={[]} />);
    expect(screen.getByRole('heading', { name: 'No allocation available' })).toBeInTheDocument();
  });

  it('runs a read-only review and exposes only returned evidence in the dialog', async () => {
    vi.spyOn(api, 'runPlanReview').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'COMPLETED',
      recommendedAction: 'NONE',
      result: validPlanReviewResult({
        summary: 'The available evidence is aligned with your saved plan. No plan changes were made.',
        findings: [{ code: 'PLAN_CURRENT', severity: 'INFO', title: 'Plan evidence is current', detail: 'The saved evidence is aligned.', evidenceIds: ['E_RECOMMENDATION_FRESHNESS'] }],
        evidence: {
          status: 'AVAILABLE',
          unavailableFacts: [],
          entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', dataClass: 'DERIVED_VALUE', displayValue: 'Current recommendation matches the profile.', authority: 'WealthGenie backend' }],
        },
      }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);
    fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
    await waitFor(() => expect(screen.getByText('Review complete')).toBeInTheDocument());
    expect(api.runPlanReview).toHaveBeenCalledWith(profile.profileId);
    fireEvent.click(screen.getByRole('button', { name: /View evidence/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('E_RECOMMENDATION_FRESHNESS')).toBeInTheDocument();
    expect(screen.getByText('Current recommendation matches the profile.')).toBeInTheDocument();
  });

  it('keeps recompute as an explicit authoritative parent action', async () => {
    vi.spyOn(api, 'runPlanReview').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'WAITING_FOR_APPROVAL',
      recommendedAction: 'RECOMPUTE_PLAN',
      result: validPlanReviewResult({
        recommendedAction: 'RECOMPUTE_PLAN',
        summary: 'The saved recommendation needs a fresh authoritative recommendation.',
        findings: [{ code: 'PROFILE_CHANGED', severity: 'ATTENTION', title: 'Profile changed', detail: 'Recompute the saved plan.', evidenceIds: [] }],
        freshness: { fresh: false, reasonCodes: ['PROFILE_CHANGED'] },
        evidence: { status: 'UNAVAILABLE', unavailableFacts: ['PROFILE_CHANGED'], entries: [] },
      }),
    });
    vi.spyOn(api.default, 'actOnPlanReview').mockResolvedValue({ authorization: { enabled: false } });
    const recompute = vi.fn();
    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} onRecomputePlan={recompute} />);
    fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Request step-up approval/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Request step-up approval/i }));
    await waitFor(() => expect(api.default.actOnPlanReview).toHaveBeenCalledWith('4f4f4f4f-1111-4111-8111-111111111111', 'APPROVE_RECOMPUTE'));
    await waitFor(() => expect(recompute).toHaveBeenCalledWith(profile, null));
  });

  it('does not display a completed review that is bound to a superseded financial state', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockResolvedValue({
      version: 'plan-review-1.1.0',
      runId: '5f5f5f5f-1111-4111-8111-111111111111',
      currentStateMatch: false,
      status: 'COMPLETED',
      summary: 'Historical review that must not appear as current.',
      result: validPlanReviewResult({ summary: 'Historical review that must not appear as current.' }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    await waitFor(() => expect(screen.getByText('This plan review no longer matches your current saved plan. Run it again.')).toBeInTheDocument());
    expect(screen.queryByText('Historical review that must not appear as current.')).not.toBeInTheDocument();
  });

  it('continues to render a persisted 1.0 review with AVAILABLE but empty evidence', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'COMPLETED',
      recommendedAction: 'NONE',
      result: validPlanReviewResult({
        version: 'plan-review-1.0.0',
        recommendedAction: 'NONE',
        summary: 'A legacy review is still available.',
        evidence: { status: 'AVAILABLE', entries: [], unavailableFacts: [] },
      }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByText('A legacy review is still available.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /View evidence/i }));
    expect(screen.getByText('No verified evidence is available for this run.')).toBeInTheDocument();
  });

  it('reloads the review when the canonical allocation revision changes without a profile version change', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun')
      .mockResolvedValueOnce({
        version: 'plan-review-1.1.0',
        runId: '6f6f6f6f-1111-4111-8111-111111111111',
        currentStateMatch: true,
        status: 'COMPLETED',
        recommendedAction: 'NONE',
        result: validPlanReviewResult({ runId: '6f6f6f6f-1111-4111-8111-111111111111', summary: 'Review for allocation revision one.' }),
      })
      .mockResolvedValueOnce({
        version: 'plan-review-1.1.0',
        runId: '7f7f7f7f-1111-4111-8111-111111111111',
        currentStateMatch: true,
        status: 'COMPLETED',
        recommendedAction: 'NONE',
        result: validPlanReviewResult({ runId: '7f7f7f7f-1111-4111-8111-111111111111', summary: 'Review for allocation revision two.' }),
      });

    const firstMeta = {
      ...recommendationMeta,
      recommendationId: '8f8f8f8f-1111-4111-8111-111111111111',
      allocation_revision: 1,
      allocation_revision_id: '9f9f9f9f-1111-4111-8111-111111111111',
      recommendation_fingerprint: 'a'.repeat(64),
      portfolio_fingerprint: 'b'.repeat(64),
    };
    const { rerender } = render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={firstMeta} />);
    await waitFor(() => expect(screen.getByText('Review for allocation revision one.')).toBeInTheDocument());

    rerender(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={{
      ...firstMeta,
      allocation_revision: 2,
      allocation_revision_id: 'afafafaf-1111-4111-8111-111111111111',
      recommendation_fingerprint: 'c'.repeat(64),
      portfolio_fingerprint: 'd'.repeat(64),
    }} />);

    await waitFor(() => expect(screen.getByText('Review for allocation revision two.')).toBeInTheDocument());
    expect(screen.queryByText('Review for allocation revision one.')).not.toBeInTheDocument();
    expect(api.getCurrentPlanReviewRun).toHaveBeenCalledTimes(2);
  });

  it('does not attach a late review result to a different profile binding', async () => {
    let finishReview;
    const pendingReview = new Promise(resolve => { finishReview = resolve; });
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockRejectedValue(noPlanReviewRun);
    vi.spyOn(api, 'runPlanReview').mockReturnValue(pendingReview);
    const nextProfile = { ...profile, profileId: '64b000000000000000000099' };
    const { rerender } = render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
    rerender(<AllocationPlanner profile={nextProfile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);
    await act(async () => {
      finishReview({
        runId: '4f4f4f4f-1111-4111-8111-111111111111',
        currentStateMatch: true,
        status: 'COMPLETED',
        recommendedAction: 'NONE',
        result: validPlanReviewResult({ summary: 'Late result for the previous profile.' }),
      });
      await pendingReview;
    });

    expect(screen.queryByText('Late result for the previous profile.')).not.toBeInTheDocument();
  });

  it('does not request recompute approval unless the server run is waiting for approval', async () => {
    vi.spyOn(api, 'runPlanReview').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'COMPLETED',
      recommendedAction: 'RECOMPUTE_PLAN',
      result: validPlanReviewResult({
        recommendedAction: 'RECOMPUTE_PLAN',
        summary: 'The review needs an updated plan.',
      }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} onRecomputePlan={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not awaiting authorization/i));
    expect(screen.queryByRole('button', { name: /Request step-up approval/i })).not.toBeInTheDocument();
  });

  it('surfaces an unavailable current-run lookup and retries the lookup without starting a review', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun')
      .mockRejectedValueOnce({ status: 503, message: 'Status service unavailable.' })
      .mockRejectedValueOnce(noPlanReviewRun);
    const startReview = vi.spyOn(api, 'runPlanReview').mockResolvedValue({ status: 'QUEUED' });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Status service unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry status check' }));
    await screen.findByRole('button', { name: /Run plan review/i });

    expect(api.getCurrentPlanReviewRun).toHaveBeenCalledTimes(2);
    expect(startReview).not.toHaveBeenCalled();
  });

  it.each([
    ['empty object', {}],
    ['null payload', null],
    ['missing binding state', { runId: '4f4f4f4f-1111-4111-8111-111111111111', status: 'COMPLETED' }],
  ])('rechecks a malformed current-run envelope (%s) instead of starting a duplicate', async (_case, malformed) => {
    vi.spyOn(api, 'getCurrentPlanReviewRun')
      .mockResolvedValueOnce(malformed)
      .mockRejectedValueOnce(noPlanReviewRun);
    const startReview = vi.spyOn(api, 'runPlanReview');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not verify the existing plan review status/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry status check' }));
    await screen.findByRole('button', { name: /Run plan review/i });

    expect(api.getCurrentPlanReviewRun).toHaveBeenCalledTimes(2);
    expect(startReview).not.toHaveBeenCalled();
  });

  it('ignores a late initial status error after a new review has started', async () => {
    let rejectLookup;
    const pendingLookup = new Promise((resolve, reject) => { rejectLookup = reject; });
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockReturnValue(pendingLookup);
    vi.spyOn(api, 'runPlanReview').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'COMPLETED',
      recommendedAction: 'NONE',
      result: validPlanReviewResult({ summary: 'The review completed successfully.' }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);
    fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
    await screen.findByText('Review complete');

    await act(async () => {
      rejectLookup({ status: 503, message: 'A late status lookup failed.' });
      await pendingLookup.catch(() => {});
    });

    expect(screen.getByText('Review complete')).toBeInTheDocument();
    expect(screen.queryByText('A late status lookup failed.')).not.toBeInTheDocument();
  });

  it('does not invite retries when the Plan Review feature is disabled', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockRejectedValue({
      status: 404,
      code: 'FEATURE_UNAVAILABLE',
      message: 'Plan Review is not available.',
    });
    const startReview = vi.spyOn(api, 'runPlanReview');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/disabled in this environment/i);
    expect(screen.queryByRole('button', { name: /try again|retry status check|check status/i })).not.toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();
  });

  it('does not treat a missing profile 404 as an empty current-run result', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockRejectedValue({
      status: 404,
      code: 'PROFILE_NOT_FOUND',
      message: 'The current profile could not be found.',
    });
    const startReview = vi.spyOn(api, 'runPlanReview');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The current profile could not be found.');
    expect(screen.getByRole('button', { name: 'Retry status check' })).toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();
  });

  it('handles a durable FEATURE_UNAVAILABLE run as terminal without polling or retrying', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'FEATURE_UNAVAILABLE',
    });
    const startReview = vi.spyOn(api, 'runPlanReview');
    const getRun = vi.spyOn(api, 'getPlanReviewRun');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/review is unavailable in this environment/i);
    expect(screen.queryByRole('button', { name: /try again|retry status check|check status/i })).not.toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();
    expect(getRun).not.toHaveBeenCalled();
  });

  it('rejects a waiting-for-approval envelope whose outer action conflicts with its review', async () => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'WAITING_FOR_APPROVAL',
      recommendedAction: 'NONE',
      result: validPlanReviewResult({ recommendedAction: 'RECOMPUTE_PLAN' }),
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} onRecomputePlan={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/result and evidence are unavailable/i);
    expect(screen.queryByRole('button', { name: /Request step-up approval/i })).not.toBeInTheDocument();
  });

  it.each([
    ['empty', {}],
    ['result run ID does not match its durable run', validPlanReviewResult({ runId: '5f5f5f5f-1111-4111-8111-111111111111' })],
    ['malformed evidence', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: null, unavailableFacts: [] } })],
    ['object display value', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', displayValue: { current: true } }], unavailableFacts: [] } })],
    ['object source provider', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', source: { provider: { name: 'Backend' } } }], unavailableFacts: [] } })],
    ['non-web evidence URL', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', source: { provider: 'Backend', url: 'javascript:alert(1)' } }], unavailableFacts: [] } })],
    ['object research claim ID', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RESEARCH_CLAIM_1', value: { claimId: { id: 'claim' }, supportStatus: 'SUPPORTED' }, displayValue: 'Claim' }], unavailableFacts: [] } })],
    ['oversized display value', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS', displayValue: 'x'.repeat(4097) }], unavailableFacts: [] } })],
    ['available evidence has no entries', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [], unavailableFacts: [] } })],
    ['blank evidence ID', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: ' ' }], unavailableFacts: [] } })],
    ['duplicate evidence IDs', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS' }, { id: 'E_RECOMMENDATION_FRESHNESS' }], unavailableFacts: [] } })],
    ['finding cites an unknown evidence ID', validPlanReviewResult({
      findings: [{ code: 'PLAN_CURRENT', severity: 'INFO', title: 'Plan evidence is current', detail: 'The saved evidence is aligned.', evidenceIds: ['E_UNKNOWN'] }],
    })],
    ['financial claim cites an unknown evidence ID', validPlanReviewResult({ financialClaims: [{ evidenceId: 'E_UNKNOWN' }] })],
    ['unavailable evidence has no typed fact', validPlanReviewResult({ evidence: { status: 'UNAVAILABLE', entries: [], unavailableFacts: [] } })],
    ['unavailable evidence has an untyped fact', validPlanReviewResult({ evidence: { status: 'UNAVAILABLE', entries: [], unavailableFacts: ['Evidence could not be loaded'] } })],
    ['available evidence has an untyped unavailable fact', validPlanReviewResult({ evidence: { status: 'AVAILABLE', entries: [{ id: 'E_RECOMMENDATION_FRESHNESS' }], unavailableFacts: [{ message: 'not a code' }] } })],
  ])('does not claim a review is ready when the completed result is %s', async (_case, result) => {
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'COMPLETED',
      recommendedAction: result?.recommendedAction,
      result,
    });

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/result and evidence are unavailable/i);
    expect(screen.queryByText('Review complete')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument();
  });

  it('serializes status polling and stops after repeated errors without cancelling the durable run', async () => {
    vi.useFakeTimers();
    let resolveFirstPoll;
    const firstPoll = new Promise(resolve => { resolveFirstPoll = resolve; });
    vi.spyOn(api, 'getCurrentPlanReviewRun').mockRejectedValue(noPlanReviewRun);
    vi.spyOn(api, 'runPlanReview').mockResolvedValue({
      runId: '4f4f4f4f-1111-4111-8111-111111111111',
      currentStateMatch: true,
      status: 'QUEUED',
    });
    const getRun = vi.spyOn(api, 'getPlanReviewRun')
      .mockReturnValueOnce(firstPoll)
      .mockResolvedValueOnce({
        runId: '4f4f4f4f-1111-4111-8111-111111111111',
        currentStateMatch: true,
        status: 'QUEUED',
        progress: { completedNodes: [], percent: 0, label: null },
      })
      .mockRejectedValue(Object.assign(new Error('Status service unavailable.'), { status: 503 }));

    render(<AllocationPlanner profile={profile} recommendations={recommendations} recommendationMeta={recommendationMeta} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Run plan review/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getRun).toHaveBeenCalledTimes(1);
    const queuedStatus = screen.getByRole('status');
    expect(queuedStatus).toHaveTextContent(/queued, waiting for the review to start/i);
    expect(queuedStatus).not.toHaveTextContent(/checking your profile|0%/i);
    expect(queuedStatus.querySelector('.ap-spin')).toBeNull();
    expect(queuedStatus.querySelector('.ap-review-progress-track')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(getRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstPoll({
        runId: '4f4f4f4f-1111-4111-8111-111111111111',
        currentStateMatch: true,
        status: 'QUEUED',
      });
      await firstPoll;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent(/queued, waiting for the review to start/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });

    expect(getRun.mock.calls.length).toBeLessThanOrEqual(6);
    expect(screen.getByRole('alert')).toHaveTextContent(/may still be queued or running/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/not cancelled/i);
    expect(screen.getByRole('button', { name: 'Check status' })).toBeInTheDocument();
  });
});
