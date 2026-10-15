import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AllocationPlanner from '../AllocationPlanner';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    allocationWeight: 1,
    monthly_allocation: 30000,
    nominalReturn: 7.1,
    riskLabel: 'Very Low',
  },
];

function serverResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function errorEnvelope(message, code) {
  return { error: message, message, code, request_id: 'request-contract-test' };
}

function installFetchForCurrentRunError(code) {
  const requests = [];
  let notifyRunStatusRequested;
  let resolveRunStatusResponse;
  const runStatusRequested = new Promise(resolve => {
    notifyRunStatusRequested = resolve;
  });
  const runStatusResponse = new Promise(resolve => {
    resolveRunStatusResponse = resolve;
  });
  const fetchStub = vi.fn(async (input, config = {}) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push({ url, config });
    if (url.pathname === '/api/agent/plan-review/current') {
      const message = code === 'PLAN_REVIEW_RUN_NOT_FOUND'
        ? 'No plan review run found.'
        : 'The current profile could not be found.';
      return serverResponse(404, errorEnvelope(message, code));
    }
    if (url.pathname === '/api/agent/plan-review' && config.method === 'POST') {
      return serverResponse(202, {
        runId: '4f4f4f4f-1111-4111-8111-111111111111',
        status: 'QUEUED',
        profileId: profile.profileId,
        recommendationId: 'recommendation-1',
        planReviewSnapshotHash: 'a'.repeat(64),
        currentStateMatch: true,
        recommendedAction: null,
        result: null,
        progress: { completedNodes: [], percent: 0, label: null },
        currentNode: null,
        attempt: 0,
        maxAttempts: 3,
        tokenUsage: 0,
        agentVersion: 'plan-review-agent-1.0.0',
        graphVersion: 'plan-review-graph-1.0.0',
        queuedAt: '2026-10-14T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        failure: null,
        approval: null,
      });
    }
    if (url.pathname === '/api/agent/plan-review/4f4f4f4f-1111-4111-8111-111111111111') {
      notifyRunStatusRequested();
      return runStatusResponse;
    }
    return serverResponse(500, errorEnvelope('Unexpected test request.', 'UNEXPECTED_TEST_REQUEST'));
  });
  vi.stubGlobal('fetch', fetchStub);
  return {
    requests,
    fetchStub,
    waitForRunStatusRequest: () => runStatusRequested,
    respondWithRunningStatus: () => resolveRunStatusResponse(serverResponse(200, {
        runId: '4f4f4f4f-1111-4111-8111-111111111111',
        status: 'RUNNING',
        profileId: profile.profileId,
        recommendationId: 'recommendation-1',
        planReviewSnapshotHash: 'a'.repeat(64),
        currentStateMatch: true,
        recommendedAction: null,
        result: null,
        progress: { completedNodes: [], percent: 15, label: 'Checking your profile' },
        currentNode: 'profile_context',
        attempt: 1,
        maxAttempts: 3,
        tokenUsage: 0,
        agentVersion: 'plan-review-agent-1.0.0',
        graphVersion: 'plan-review-graph-1.0.0',
        queuedAt: '2026-10-14T00:00:00.000Z',
        startedAt: '2026-10-14T00:00:01.000Z',
        completedAt: null,
        failure: null,
        approval: null,
      })),
  };
}

describe('AllocationPlanner API contract', () => {
  it('treats PLAN_REVIEW_RUN_NOT_FOUND as an empty lookup, then starts review through the real API client', async () => {
    const {
      requests,
      waitForRunStatusRequest,
      respondWithRunningStatus,
    } = installFetchForCurrentRunError('PLAN_REVIEW_RUN_NOT_FOUND');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} />);

    const runButton = await screen.findByRole('button', { name: 'Run plan review' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe('/api/agent/plan-review/current');
    expect(requests[0].url.searchParams.get('profileId')).toBe(profile.profileId);

    fireEvent.click(runButton);

    await waitFor(() => {
      expect(requests.some(({ url, config }) => (
        url.pathname === '/api/agent/plan-review' && config.method === 'POST'
      ))).toBe(true);
    });
    const post = requests.find(({ url, config }) => (
      url.pathname === '/api/agent/plan-review' && config.method === 'POST'
    ));
    expect(JSON.parse(post.config.body)).toEqual({ profileId: profile.profileId });
    await waitForRunStatusRequest();
    const queuedStatus = screen.getByRole('status');
    expect(queuedStatus).toHaveTextContent(/queued, waiting for the review to start/i);
    expect(queuedStatus).not.toHaveTextContent(/checking your profile|0%/i);
    expect(queuedStatus.querySelector('.ap-spin')).toBeNull();
    expect(queuedStatus.querySelector('.ap-review-progress-track')).toBeNull();
    respondWithRunningStatus();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/checking your profile/i);
      expect(screen.getByRole('status')).toHaveTextContent('15%');
    });
  });

  it('keeps PROFILE_NOT_FOUND as an error and never starts a review', async () => {
    const { requests } = installFetchForCurrentRunError('PROFILE_NOT_FOUND');

    render(<AllocationPlanner profile={profile} recommendations={recommendations} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The current profile could not be found.');
    expect(screen.getByRole('button', { name: 'Retry status check' })).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe('/api/agent/plan-review/current');
    expect(requests.some(({ config }) => config.method === 'POST')).toBe(false);
  });
});
