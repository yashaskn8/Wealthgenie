import React from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getRiskShortlist: vi.fn(),
  saveRiskShortlist: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../deepdive/WhereToInvestTab', () => ({ default: () => null }));
vi.mock('../InvestmentUniverseExplorer', () => ({
  default: ({profileAssessments, profileCoverage}) => (
    <div data-testid="profile-screening-catalog"
      data-count={profileAssessments?.length || 0}
      data-coverage={profileCoverage?.totalCategories || 0} />
  ),
}));

const profileId = '0123456789abcdef01234567';
const recommendations = [{id:'legacy_category',name:'Legacy category',allocation_pct:100}];
const shortlist = version => ({
  status:'PROFILE_ELIGIBLE_PARENT_CATEGORIES',
  qualificationScope:'PARENT_CATEGORY_ONLY',
  source:{profileId,profileVersion:version},
  groups:{LOW:[],MODERATE:[],AGGRESSIVE:[]},
  selectedCount:0,
  discoveryArchetypesRecommendationEligible:false,
  catalogCoverage:{totalCategories:250},
  catalogAssessments:Array.from({length:250},(_,index)=>({
    id:'family_'+index,productQualified:false,
  })),
});
let Screen;
beforeAll(async () => {
  vi.stubEnv('VITE_FINANCIAL_ARCHITECTURE_ENABLED','true');
  ({ default: Screen } = await import('../WhereToInvestScreen.jsx'));
});
afterAll(() => vi.unstubAllEnvs());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('does not display 95-category profile screening from a stale profile revision',async()=>{
  let resolveNext;
  api.getRiskShortlist.mockResolvedValueOnce(shortlist(1))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  const view=render(<Screen recommendations={recommendations}
    userProfile={{profileId,version:1}} />);
  await waitFor(() => expect(screen.getByTestId('profile-screening-catalog'))
    .toHaveAttribute('data-count','250'));

  view.rerender(<Screen recommendations={recommendations}
    userProfile={{profileId,version:2}} />);
  expect(screen.getByTestId('profile-screening-catalog')).toHaveAttribute('data-count','0');
  expect(screen.getByTestId('profile-screening-catalog')).toHaveAttribute('data-coverage','0');
  await waitFor(() => expect(api.getRiskShortlist).toHaveBeenCalledTimes(2));

  resolveNext(shortlist(2));
  await waitFor(() => expect(screen.getByTestId('profile-screening-catalog'))
    .toHaveAttribute('data-count','250'));
  expect(screen.getByTestId('profile-screening-catalog')).toHaveAttribute('data-coverage','250');
});
