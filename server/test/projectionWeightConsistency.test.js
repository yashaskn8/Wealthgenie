import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import projectionRoutes from '../routes/projection.js';
import monteCarloRoutes from '../routes/montecarlo.js';
import { evaluatePortfolio } from '../services/portfolioEngine.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import { closeServer, rawRequest } from '../test-utils/httpTestUtils.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { normalizeAllocationWeights } from '../utils/allocationWeights.js';
import { INSTRUMENT_PARAMS } from '../services/instrumentConstants.js';
import { buildAssetClassAllocation, buildPortfolioReturnAssumption } from '../services/coreRecommendation.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

process.env.JWT_SECRET = 'projection-weight-consistency-test-secret';

function query(value) {
  return {
    sort() { return this; },
    select() { return this; },
    lean: async () => value,
  };
}

test('recommendation assumptions use the normalized allocation vector', () => {
  const instruments = [
    { allocationWeight: 0.50005, nominalReturn: 20.0098, assetClass: 'Equity' },
    { allocationWeight: 0.5, nominalReturn: 0, assetClass: 'Fixed Income' },
  ];
  const weights = normalizeAllocationWeights(instruments.map(instrument => instrument.allocationWeight));
  const expectedReturn = instruments.reduce((sum, instrument, index) => (
    sum + Number(instrument.nominalReturn) * weights[index]
  ), 0);
  const assetAllocation = buildAssetClassAllocation(instruments);

  assert.equal(buildPortfolioReturnAssumption(instruments), Number(expectedReturn.toFixed(2)));
  assert.deepEqual(assetAllocation, { Equity: 50, 'Fixed Income': 50 });
  assert.equal(Object.values(assetAllocation).reduce((sum, percentage) => sum + percentage, 0), 100);
});

test('custom portfolio response uses normalized weights for returns, displayed percentages, and forecast cashflows', async t => {
  const userId = '64b000000000000000000001';
  const profileId = '65b000000000000000000001';
  const profile = {
    _id: profileId,
    userId,
    version: 1,
    ...canonicalProfile({ monthlySavings: 20_000, investmentHorizonYears: 10 }),
  };
  const originals = {
    profileFindOne: FinancialProfile.findOne,
    profileExists: FinancialProfile.exists,
    profileStateFindOne: FinancialProfileState.findOne,
    recommendationFindOne: Recommendation.findOne,
    recommendationStateFindOne: RecommendationState.findOne,
  };
  FinancialProfile.findOne = () => query(profile);
  FinancialProfile.exists = async filter => (
    String(filter?._id) === profileId && String(filter?.userId) === userId ? { _id: profileId } : null
  );
  FinancialProfileState.findOne = () => query({
    userId,
    currentProfileId: profileId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });
  Recommendation.findOne = () => query(null);
  RecommendationState.findOne = () => query(null);
  t.after(() => {
    FinancialProfile.findOne = originals.profileFindOne;
    FinancialProfile.exists = originals.profileExists;
    FinancialProfileState.findOne = originals.profileStateFindOne;
    Recommendation.findOne = originals.recommendationFindOne;
    RecommendationState.findOne = originals.recommendationStateFindOne;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/projection', projectionRoutes);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await closeServer(server); });

  await withMockAuthAccountState(async () => {
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const url = `http://127.0.0.1:${server.address().port}/api/projection/custom-portfolio`;
    const allocations = { FD: 0.50005, Debt_MF: 0.5 };
    const response = await rawRequest(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, allocations, years: 10 }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));

    const expectedWeights = normalizeAllocationWeights(Object.values(allocations));
    const expectedNominalReturn = expectedWeights.reduce((sum, weight, index) => (
      sum + weight * INSTRUMENT_PARAMS[Object.keys(allocations)[index]].nominalRate
    ), 0);
    assert.equal(body.portfolio_nominal_return_assumption, Number(expectedNominalReturn.toFixed(2)));
    assert.equal(Number(Object.values(body.allocation_percentages).reduce((sum, pct) => sum + pct, 0).toFixed(4)), 100);
    assert.equal(Number(Object.values(body.monthly_instrument_allocations).reduce((sum, amount) => sum + amount, 0).toFixed(2)), 20_000);
    assert.deepEqual(body.monthly_instrument_allocations, body.instrument_monthly_allocations);

    const justOutsideTolerance = await rawRequest(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, allocations: { FD: 0.50010001, Debt_MF: 0.5 }, years: 10 }),
    });
    assert.equal(justOutsideTolerance.status, 400);
  });
});

test('portfolio Monte Carlo uses the same normalized weights for return and volatility', async t => {
  const userId = '64b000000000000000000002';
  const profileId = '65b000000000000000000002';
  const profile = {
    _id: profileId,
    userId,
    version: 1,
    ...canonicalProfile({ monthlySavings: 20_000, investmentHorizonYears: 10 }),
  };
  const originalFindOne = FinancialProfile.findOne;
  FinancialProfile.findOne = () => query(profile);
  t.after(() => { FinancialProfile.findOne = originalFindOne; });

  const app = express();
  app.use(express.json());
  app.use('/api/montecarlo', monteCarloRoutes);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await closeServer(server); });

  await withMockAuthAccountState(async () => {
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const allocations = { Debt_MF: 0.50005, Liquid_MF: 0.5 };
    const response = await rawRequest(`http://127.0.0.1:${server.address().port}/api/montecarlo/portfolio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, allocations, years: 2 }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));

    const normalizedWeights = normalizeAllocationWeights(Object.values(allocations));
    const normalizedAllocations = Object.fromEntries(Object.keys(allocations).map((key, index) => [key, normalizedWeights[index]]));
    const keys = Object.keys(normalizedAllocations);
    const expectedMetrics = evaluatePortfolio(
      keys,
      keys.map(key => INSTRUMENT_PARAMS[key].nominalRate / 100),
      normalizedAllocations,
    );
    assert.deepEqual(body.allocations, normalizedAllocations);
    assert.equal(body.portfolio_return_assumption, expectedMetrics.expectedReturn);
    assert.equal(body.portfolio_volatility, expectedMetrics.volatility);
    assert.equal(body.confidence_interval_width, null);
    assert.ok(Number.isFinite(body.interquartile_spread_ratio));
    assert.equal(body.goal_probability_ci, null);
    assert.equal(body.goal_probability_ci_status, 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS');
    assert.equal(body.standard_error_status, 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS');
    assert.equal(body.asset_specific_cashflows_calculated, false);
    assert.equal(body.post_tax_simulation_available, false);
    assert.equal(body.accuracy_certification, 'NOT_VERIFIED');
    assert.equal(body.portfolio_aggregation, 'MOMENT_MATCHED_GBM_APPROXIMATION_NOT_ASSET_PATHS');
    const unsupported = await rawRequest(`http://127.0.0.1:${server.address().port}/api/montecarlo/portfolio`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, allocations: { FD: 0.5, Debt_MF: 0.5 }, years: 2 }),
    });
    assert.equal(unsupported.status, 422);
    const denied = await unsupported.json();
    assert.equal(denied.percentile_summary, undefined);
  });
});

test('Conservative FD projections remain profile-grounded, while GBM refuses FD cashflows', async t => {
  const userId = '64b000000000000000000003';
  const profileId = '65b000000000000000000003';
  const profile = {
    _id: profileId,
    userId,
    version: 1,
    ...canonicalProfile({ riskTolerance: 'Conservative', investmentHorizonYears: 5 }),
  };
  const originals = {
    profileFindOne: FinancialProfile.findOne,
    profileExists: FinancialProfile.exists,
    profileStateFindOne: FinancialProfileState.findOne,
    recommendationFindOne: Recommendation.findOne,
    recommendationStateFindOne: RecommendationState.findOne,
  };
  FinancialProfile.findOne = () => query(profile);
  FinancialProfile.exists = async filter => (
    String(filter?._id) === profileId && String(filter?.userId) === userId ? { _id: profileId } : null
  );
  FinancialProfileState.findOne = () => query({
    userId,
    currentProfileId: profileId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });
  Recommendation.findOne = () => query(null);
  RecommendationState.findOne = () => query(null);
  t.after(() => {
    FinancialProfile.findOne = originals.profileFindOne;
    FinancialProfile.exists = originals.profileExists;
    FinancialProfileState.findOne = originals.profileStateFindOne;
    Recommendation.findOne = originals.recommendationFindOne;
    RecommendationState.findOne = originals.recommendationStateFindOne;
  });

  const app = express();
  app.use(express.json());
  app.use('/api/projection', projectionRoutes);
  app.use('/api/montecarlo', monteCarloRoutes);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await closeServer(server); });

  await withMockAuthAccountState(async () => {
    const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const payload = JSON.stringify({ profileId, allocations: { FD: 1 }, years: 5 });
    const urls = [
      `http://127.0.0.1:${server.address().port}/api/projection/custom-portfolio`,
      `http://127.0.0.1:${server.address().port}/api/montecarlo/portfolio`,
    ];

    for (const [index, url] of urls.entries()) {
      const response = await rawRequest(url, { method: 'POST', headers, body: payload });
      const body = await response.json();
      if (index === 0) {
        // Separate legacy projection is not the GBM engine.
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.simulation_classification, 'PROFILE_GROUNDED');
        assert.equal(body.return_data_class, 'MODEL_ASSUMPTION');
        assert.equal(body.final_suitability_risk, 'Conservative');
      } else {
        assert.equal(response.status, 422, JSON.stringify(body));
        assert.equal(body.percentile_summary, undefined);
      }
    }
  });
});
