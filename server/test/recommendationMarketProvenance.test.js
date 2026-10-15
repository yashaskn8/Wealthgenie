import test from 'node:test';
import assert from 'node:assert/strict';
import Recommendation from '../models/Recommendation.js';
import mongoose from 'mongoose';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { computeCoreRecommendation } from '../services/coreRecommendation.js';
import { calculateAuditRecordHash } from '../services/auditChain.js';
import {
  assertRecommendationMarketDistributionAllowed,
  persistRecommendationMarketAdjustment,
  sourceProviderForRecommendation,
} from '../services/recommendationMarketProvenance.js';

test('new recommendation provenance is copied only from its exact market snapshot selection', () => {
  const context = {
    providerSelection: { selectedProvider: 'UPSTOX' },
    marketSnapshot: { providerSelection: { selectedProvider: 'NSE' } },
  };
  const persisted = persistRecommendationMarketAdjustment({ applied: true }, context);

  assert.equal(sourceProviderForRecommendation(context), 'NSE');
  assert.deepEqual(persisted, { applied: true, sourceProvider: 'NSE' });
  const document = Recommendation.hydrate({ marketAdjustment: persisted });
  assert.equal(document.marketAdjustment.sourceProvider, 'NSE');
});

test('missing, null, and unfamiliar generation provider evidence stays unknown', () => {
  assert.equal(sourceProviderForRecommendation(null), null);
  assert.equal(sourceProviderForRecommendation({ providerSelection: { selectedProvider: 'NSE' } }), null);
  assert.equal(sourceProviderForRecommendation({
    marketSnapshot: { providerSelection: { selectedProvider: 'TEJHQ' } },
  }), null);
  assert.deepEqual(persistRecommendationMarketAdjustment({ applied: true }, null), {
    applied: true,
    sourceProvider: null,
  });
});

test('applied legacy recommendations with missing or unknown provider fail closed with stable 503', () => {
  for (const marketAdjustment of [
    { applied: true },
    { status: 'APPLIED', sourceProvider: null },
    { currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED', sourceProvider: 'TEJHQ' },
  ]) {
    assert.throws(
      () => assertRecommendationMarketDistributionAllowed({ marketAdjustment }),
      error => error.status === 503 && error.code === 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING',
    );
  }
});

test('legacy allocation-source markers alone are enough to fail closed', () => {
  for (const legacyRecord of [
    { currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED' },
    { response: { current_allocation_source: 'MARKET_CONTEXT_ADJUSTED' } },
    { responseSnapshot: { recommendation: { current_allocation_source: 'MARKET_CONTEXT_ADJUSTED' }, completion: {} } },
    { responseSnapshot: { current_allocation_source: 'MARKET_CONTEXT_ADJUSTED' } },
    { recommendations: { allocationSource: 'MARKET_CONTEXT_ADJUSTED' } },
  ]) {
    assert.throws(
      () => assertRecommendationMarketDistributionAllowed(legacyRecord),
      error => error.status === 503 && error.code === 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING',
    );
  }
});

test('audit generation output reads provider provenance from its hash-bound recommendation payload', () => {
  const auditRecord = {
    recommendations: {
      allocationSource: 'MARKET_CONTEXT_ADJUSTED',
      marketAdjustment: { applied: true, sourceProvider: 'NSE' },
    },
  };
  assert.doesNotThrow(() => assertRecommendationMarketDistributionAllowed(auditRecord));
  assert.throws(
    () => assertRecommendationMarketDistributionAllowed({
      recommendations: {
        allocationSource: 'MARKET_CONTEXT_ADJUSTED',
        marketAdjustment: { applied: true, sourceProvider: 'UPSTOX' },
      },
    }, { environment: { NODE_ENV: 'production' } }),
    error => error.status === 503 && error.code === 'UPSTOX_PUBLIC_DISTRIBUTION_NOT_CONFIRMED',
  );
});

test('core generation binds the exact snapshot provider into durable audit output', async () => {
  const core = await computeCoreRecommendation({
    canonicalProfile: canonicalProfile({ liquidSavings: null }),
    userId: new mongoose.Types.ObjectId(),
    profileId: new mongoose.Types.ObjectId(),
    marketContext: {
      status: 'MARKET_CONTEXT_UNAVAILABLE',
      context: null,
      reasonCodes: ['FIXTURE_UNAVAILABLE'],
      marketSnapshot: { providerSelection: { selectedProvider: 'NSE' } },
    },
  });

  assert.equal(core.recommendationData.marketAdjustment.sourceProvider, 'NSE');
  assert.equal(core.auditRecordData.recommendations.marketAdjustment.sourceProvider, 'NSE');
  assert.equal(core.auditRecordData.recommendations.marketAdjustment.applied, false);

  const auditRecord = {
    ...core.auditRecordData,
    previous_hash: 'GENESIS',
    chain_sequence: 1,
    hash_algorithm: 'sha256',
    schema_version: '1.0',
  };
  const provenanceBoundHash = calculateAuditRecordHash(auditRecord);
  const withoutProvenance = {
    ...auditRecord,
    recommendations: {
      ...auditRecord.recommendations,
      marketAdjustment: { ...auditRecord.recommendations.marketAdjustment, sourceProvider: null },
    },
  };
  assert.notEqual(calculateAuditRecordHash(withoutProvenance), provenanceBoundHash);
});

test('unadjusted legacy recommendations remain eligible for ordinary resolution', () => {
  assert.doesNotThrow(() => assertRecommendationMarketDistributionAllowed({
    marketAdjustment: { applied: false, status: 'NOT_APPLIED', sourceProvider: null },
    responseSnapshot: { market_adjustment: { applied: false, status: 'NOT_APPLIED' } },
    currentAllocationSource: 'ORIGINAL_RECOMMENDATION',
  }));
});

test('Upstox adjustment fails closed until production distribution is confirmed', () => {
  assert.throws(
    () => assertRecommendationMarketDistributionAllowed({
      marketAdjustment: { applied: true, sourceProvider: 'UPSTOX' },
    }, { environment: { NODE_ENV: 'production' } }),
    error => error.status === 503 && error.code === 'UPSTOX_PUBLIC_DISTRIBUTION_NOT_CONFIRMED',
  );
});

test('confirmed production Upstox adjustment and qualified NSE adjustment pass the distribution policy', () => {
  assert.doesNotThrow(() => assertRecommendationMarketDistributionAllowed({
    marketAdjustment: { applied: true, sourceProvider: 'UPSTOX' },
  }, { environment: { NODE_ENV: 'production', UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true' } }));
  assert.doesNotThrow(() => assertRecommendationMarketDistributionAllowed({
    marketAdjustment: { applied: true, sourceProvider: 'NSE' },
  }, { environment: { NODE_ENV: 'production' } }));
});

test('generation market provider provenance is immutable after persistence', async () => {
  const recommendation = new Recommendation({ marketAdjustment: { applied: true, sourceProvider: 'NSE' } });
  await assert.rejects(
    recommendation.updateOne({ $set: { 'marketAdjustment.sourceProvider': 'UPSTOX' } }).exec(),
    error => error.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
  );
});
