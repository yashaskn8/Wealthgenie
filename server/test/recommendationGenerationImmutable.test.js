import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Recommendation from '../models/Recommendation.js';

const id = new mongoose.Types.ObjectId();

function runQueryPreHooks(query) {
  return new Promise((resolve, reject) => {
    query.model.schema.s.hooks.execPre(query.op, query, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function runBulkWritePreHooks(model, operations) {
  return new Promise((resolve, reject) => {
    model.schema.s.hooks.execPre('bulkWrite', model, [operations, {}], error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('generation allocation and response snapshot cannot be changed by query updates', async () => {
  for (const update of [
    { $set: { instruments: [] } },
    { $set: { 'responseSnapshot.instruments': [] } },
    { $set: { 'marketAdjustment.sourceProvider': 'UPSTOX' } },
    { $unset: { responseSnapshot: 1 } },
    { $rename: { 'responseSnapshot.instruments': 'advisoryText' } },
    [{ $set: { instruments: [] } }],
  ]) {
    await assert.rejects(
      Recommendation.updateOne({ _id: id }, update).exec(),
      error => error.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
    );
  }
});

test('mutable advisory text and metadata remain writable through query and bulk middleware', async () => {
  const filter = { _id: id };
  for (const [field, value] of [
    ['advisoryText', 'A verified explanation.'],
    ['advisoryMetadata', { status: 'READY', evidenceIdsUsed: ['E_TEST'] }],
  ]) {
    await runQueryPreHooks(Recommendation.updateOne(filter, { $set: { [field]: value } }));
    await runQueryPreHooks(Recommendation.updateMany(filter, { $set: { [field]: value } }));
    await runQueryPreHooks(Recommendation.findOneAndUpdate(filter, { $set: { [field]: value } }));
    await runBulkWritePreHooks(Recommendation, [
      { updateOne: { filter, update: { $set: { [field]: value } } } },
    ]);
    await runBulkWritePreHooks(Recommendation, [
      { updateMany: { filter, update: { $set: { [field]: value } } } },
    ]);
  }
});

test('policy and generation identity cannot be changed after recommendation creation', async () => {
  for (const field of [
    'modelVersion',
    'regulatoryRuleVersion',
    'profileInputHash',
    'recommendationPolicyVersion',
    'returnAssumptionHash',
    'recommendationGeneration',
    'currentAllocationSource',
    'generatedAt',
  ]) {
    await assert.rejects(
      Recommendation.findOneAndUpdate({ _id: id }, { $set: { [field]: 'tampered' } }).exec(),
      error => error.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
      `expected ${field} to be immutable`,
    );
  }
});

test('generation immutability rejects replacement omission and all bulk update forms', async () => {
  const filter = { _id: id };
  const replacementWithoutGeneration = { advisoryText: 'replacement must not erase history' };
  const mutations = [
    ['replaceOne omission', () => Recommendation.replaceOne(filter, replacementWithoutGeneration).exec()],
    ['findOneAndReplace omission', () => Recommendation.findOneAndReplace(filter, replacementWithoutGeneration).exec()],
    ['bulkWrite updateOne', () => Recommendation.bulkWrite([
      { updateOne: { filter, update: { $set: { instruments: [] } } } },
    ])],
    ['bulkWrite updateMany', () => Recommendation.bulkWrite([
      { updateMany: { filter, update: { $unset: { responseSnapshot: 1 } } } },
    ])],
    ['bulkWrite replacement omission', () => Recommendation.bulkWrite([
      { replaceOne: { filter, replacement: replacementWithoutGeneration } },
    ])],
    ['bulkWrite update pipeline', () => Recommendation.bulkWrite([
      { updateOne: { filter, update: [{ $set: { instruments: [] } }] } },
    ])],
  ];

  for (const [operation, mutate] of mutations) {
    await assert.rejects(
      mutate(),
      error => error?.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
      operation,
    );
  }
});

test('a persisted recommendation cannot change its generation through document save', async () => {
  const instrument = {
    id: 'fixture-fd',
    name: 'Fixture Fixed Deposit',
    type: 'FD',
    assetClass: 'Fixed Income',
    nominalReturn: 7,
    effectiveYield: 7,
    returnBasis: 'PRE_TAX_NOMINAL',
    returnDataClass: 'MODEL_ASSUMPTION',
    returnAssumptionVersion: 'wealthgenie-projection-assumptions-1.1.5',
    returnSource: 'WEALTHGENIE_MODEL_POLICY',
    observedMarketFact: false,
    providerForecast: false,
    expenseRatio: 0,
    riskLevel: 'Low',
    riskScore: 1,
    lockIn: 0,
    tags: ['Wealth Growth'],
    score: 70,
    scoreFactors: {
      expectedReturn: 70,
      riskFit: 70,
      liquidity: 70,
      goalFit: 70,
      horizonFit: 70,
      cost: 70,
      mlConfidence: 70,
    },
    allocation_pct: 100,
    allocationWeight: 1,
  };
  const recommendation = Recommendation.hydrate({
    _id: id,
    userId: new mongoose.Types.ObjectId(),
    profileId: new mongoose.Types.ObjectId(),
    instruments: [instrument],
    mlFallback: true,
    modelVersion: 'test-model',
    regulatoryRuleVersion: 'test-regulatory',
    profileInputHash: 'a'.repeat(64),
    profileVersion: 1,
    recommendationPolicyVersion: 'test-policy',
    recommendationGeneration: 1,
    responseSnapshot: { generation: 1 },
  });

  recommendation.set('instruments', [{ ...instrument, allocationWeight: 0.5, allocation_pct: 50 }, {
    ...instrument,
    id: 'second-fixture-fd',
    allocationWeight: 0.5,
    allocation_pct: 50,
  }], undefined, { overwriteImmutable: true });

  await assert.rejects(
    recommendation.save(),
    error => error?.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
  );
});
