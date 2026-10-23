import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createDecisionsRouter } from '../routes/decisionScenarios.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';
import { signDecisionReceipt } from '../services/genieDecision/integrity.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'geniedecision-test-secret-only-2026';
process.env.DISABLE_RATE_LIMIT = 'true';
const userOne = new mongoose.Types.ObjectId();
const userTwo = new mongoose.Types.ObjectId();
let profile;
function token(userId) {
  return jwt.sign({ userId: String(userId), role: 'user' }, process.env.JWT_SECRET,
    { expiresIn: '30m' });
}
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/decisions', createDecisionsRouter());
  instance.use(errorHandler);
  return instance;
}
function call(base, userId, path, method = 'GET', body, key) {
  return jsonRequest(`${base}/api/decisions${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token(userId)}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  });
}
const scenarioInput = () => ({
  profileId: String(profile._id), expectedProfileStateRevision: 1,
  title: 'My income interruption assessment', scenarioType: 'INCOME_INTERRUPTION',
  horizonMonths: 6,
  baseline: {
    monthlyLivingExpenses: '50000.00', monthlyDebtPayments: '20000.00',
    monthlyInvestments: '20000.00',
  },
  goalReservations: [{ goalId: 'retirement', monthlyAllocation: '10000.00' }],
  details: { startMonth: 2, durationMonths: 3, incomeLossPerMonth: '100000.00' },
});
test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  for (const model of [DecisionScenario, DecisionScenarioRevision, DecisionRun]) {
    await model.createIndexes();
  }
  await User.create([
    { _id: userOne, name: 'Decision Test One', email: `decision-${userOne}@example.test`, passwordHash: 'test-password-hash' },
    { _id: userTwo, name: 'Decision Test Two', email: `decision-${userTwo}@example.test`, passwordHash: 'test-password-hash' },
  ]);
  profile = await FinancialProfile.create({
    userId: userOne, ...canonicalProfile({
      monthlyTakeHome: 100000, monthlySavings: 30000, liquidSavings: 100000,
    }), recommendationProfileVersion: 'financial-profile-1.0.0',
  });
  await FinancialProfileState.create({
    userId: userOne, currentProfileId: profile._id,
    resolutionStatus: 'CURRENT', revision: 1, promotionFence: 0,
  });
});
test.after(async () => { await teardownTestDatabase(); });

test('scenario persists atomically, replays idempotently, revisions are append-only, and cross-user reads are denied', async () => {
  await withServer(app(), async base => {
    const payload = scenarioInput();
    const creation = await call(base, userOne, '/scenarios', 'POST', payload, 'decision-create-0001');
    assert.equal(creation.response.status, 201, JSON.stringify(creation.body));
    assert.equal(creation.response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(creation.response.headers.get('pragma'), 'no-cache');
    const id = creation.body.scenario.id;
    assert.equal(creation.body.scenario.revision, 1);

    const replay = await call(base, userOne, '/scenarios', 'POST', payload, 'decision-create-0001');
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.scenario.id, id);

    const collision = await call(base, userOne, '/scenarios', 'POST',
      { ...payload, title: 'Different decision input' }, 'decision-create-0001');
    assert.equal(collision.response.status, 409);
    assert.equal(collision.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');

    const forbidden = await call(base, userTwo, `/scenarios/${id}`);
    assert.equal(forbidden.response.status, 404);
    assert.equal(forbidden.response.headers.get('cache-control'), 'private, no-store, max-age=0');

    // A database-side mutation which forgets to advance the financial state
    // revision must still make the pinned scenario unusable for new writes.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 31000 } });
    try {
      const blocked = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
        expectedRevision: 1, title: 'Must not recompute on changed profile facts',
        horizonMonths: payload.horizonMonths, baseline: payload.baseline,
        goalReservations: payload.goalReservations, details: payload.details,
      });
      assert.equal(blocked.response.status, 409);
      assert.equal(blocked.body.code, 'DECISION_STALE_PROFILE');
    } finally {
      await FinancialProfile.collection.updateOne({ _id: profile._id },
        { $set: { monthlySavings: 30000 } });
    }

    const modified = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 1, title: 'Revised income scenario', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(modified.response.status, 200, JSON.stringify(modified.body));
    assert.equal(modified.body.scenario.revision, 2);

    const oldRevision = await DecisionScenarioRevision.findOne({
      userId: userOne, scenarioId: id, revision: 1,
    }).lean();
    assert.equal(oldRevision.payload.title, payload.title);
    assert.equal(oldRevision.revision, 1);
    const staleEdit = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 1, title: 'Conflicting edit', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(staleEdit.response.status, 409);
    assert.equal(staleEdit.body.code, 'DECISION_REVISION_CONFLICT');

    const evaluated = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(evaluated.response.status, 201, JSON.stringify(evaluated.body));
    const reportId = evaluated.body.run.id;
    assert.equal(evaluated.body.run.status, 'PARTIAL');
    assert.equal(evaluated.body.run.result.alternatives.length, 2);
    assert.match(evaluated.body.run.result.financialInputFingerprint, /^[0-9a-f]{64}$/);

    const evalReplay = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(evalReplay.response.status, 200);
    assert.equal(evalReplay.body.run.id, reportId);
    assert.equal(evalReplay.body.replayed, true);

    const slot = await DecisionScenario.findById(id).lean();
    assert.ok(Number.isInteger(slot.quotaSlot) && slot.quotaSlot >= 0 && slot.quotaSlot < 50);
    // The same evaluation key is a durable receipt for revision 2 even after
    // the scenario advances to revision 3. It must not be recomputed.
    const third = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 2, title: 'Edited after published report', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(third.response.status, 200);
    assert.equal(third.body.scenario.revision, 3);
    const postEditReplay = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(postEditReplay.response.status, 200, JSON.stringify(postEditReplay.body));
    assert.equal(postEditReplay.body.run.id, reportId);
    assert.equal(postEditReplay.body.replayed, true);
    assert.equal(postEditReplay.body.run.status, 'HISTORICAL');
    assert.deepEqual(postEditReplay.body.run.reasonCodes, ['DECISION_SCENARIO_REVISION_SUPERSEDED']);

    const runList = await call(base, userOne, `/scenarios/${id}/runs`);
    assert.equal(runList.response.status, 200, JSON.stringify(runList.body));
    assert.equal(runList.body.runs.length, 1);
    assert.equal(runList.body.runs[0].id, reportId);
    assert.equal(runList.body.runs[0].status, 'HISTORICAL');
    assert.equal(Object.hasOwn(runList.body.runs[0], 'result'), false);
    const otherUserRunList = await call(base, userTwo, `/scenarios/${id}/runs`);
    assert.equal(otherUserRunList.response.status, 404);
    const changedKey = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 3 }, 'decision-evaluate-0001');
    assert.equal(changedKey.response.status, 409);
    assert.equal(changedKey.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');

    const secret = await call(base, userTwo, `/runs/${reportId}`);
    assert.equal(secret.response.status, 404);

    await FinancialProfileState.updateOne({ userId: userOne }, { $inc: { revision: 1 } });
    const history = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(history.response.status, 200);
    assert.equal(history.body.run.status, 'HISTORICAL');
    assert.equal(history.body.run.originalStatus, 'PARTIAL');

    // A profile mutation that bypasses the normal version increment cannot
    // silently preserve a report's CURRENT classification.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 31000 } });
    const drifted = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(drifted.response.status, 200);
    assert.ok(drifted.body.run.reasonCodes.includes('DECISION_CANONICAL_FACTS_CHANGED'));
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 30000 } });

    // A recalculation-policy upgrade does not rewrite history or present an
    // outdated numerical report as if it came from today's code.
    const originalRun = await DecisionRun.findById(reportId).lean();
    assert.equal((await call(base, userOne, `/runs/${reportId}`)).body.run.asOf, originalRun.issuedAt);
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { issuedAt: '2099-01-01T00:00:00.000Z' } });
    const falsifiedFreshness = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(falsifiedFreshness.response.status, 503);
    assert.equal(falsifiedFreshness.body.code, 'DECISION_REPORT_INTEGRITY_FAILURE');
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { issuedAt: originalRun.issuedAt } });

    const previousModelResult = { ...originalRun.result, modelVersion: 'geniedecision-ledger-0.0.1' };
    const oldResultHash = crypto.createHash('sha256').update(JSON.stringify(previousModelResult)).digest('hex');
    // A *legitimately signed* historical report must remain readable but
    // historical. A database attacker without the active signing key cannot
    // construct this signature.
    const oldReceipt = signDecisionReceipt('decision_run', {
      userId: String(originalRun.userId), scenarioId: String(originalRun.scenarioId),
      revision: originalRun.revision, profileId: String(originalRun.profileId),
      profileFactsHash: originalRun.profileFactsHash, inputHash: originalRun.inputHash,
      runKeyHash: originalRun.runKeyHash, issuedAt: originalRun.issuedAt,
    }, { resultHash: oldResultHash });
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { result: previousModelResult, resultHash: oldResultHash, ...oldReceipt } });
    const previousPolicy = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(previousPolicy.response.status, 200);
    assert.ok(previousPolicy.body.run.reasonCodes.includes('DECISION_CALCULATION_POLICY_SUPERSEDED'));
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: {
        result: originalRun.result, resultHash: originalRun.resultHash,
        integrityKeyId: originalRun.integrityKeyId, integrityTag: originalRun.integrityTag,
      } });

    // Even if a database attacker recomputes the plain SHA-256 hash after
    // changing money, they cannot forge the HMAC receipt with a key not in DB.
    const forgedResult = structuredClone(originalRun.result);
    forgedResult.alternatives[0].endingProjectedLiquidCash = '999999999.00';
    const forgedHash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedResult)).digest('hex');
    await DecisionRun.collection.updateOne({ _id: new mongoose.Types.ObjectId(reportId) },
      { $set: { result: forgedResult, resultHash: forgedHash } });
    const tampered = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(tampered.response.status, 503);
    assert.equal(tampered.body.code, 'DECISION_REPORT_INTEGRITY_FAILURE');

    // A database-only attacker cannot forge displayed scenario titles by
    // modifying the mutable head while keeping the signed revision untouched.
    await DecisionScenario.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) },
      { $set: { title: 'Attacker-controlled headline' } });
    const forgedListing = await call(base, userOne, '/scenarios');
    assert.equal(forgedListing.response.status, 503);
    assert.equal(forgedListing.body.code, 'DECISION_REVISION_INTEGRITY_FAILURE');
    await DecisionScenario.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) },
      { $set: { title: 'Edited after published report' } });
    const restoredListing = await call(base, userOne, '/scenarios');
    assert.equal(restoredListing.response.status, 200);

    const revisionRecord = await DecisionScenarioRevision.findOne({
      userId: userOne, scenarioId: id, revision: 3,
    }).lean();
    const forgedRevision = structuredClone(revisionRecord.payload);
    forgedRevision.title = 'Forger changed decision inputs';
    const forgedRevisionHash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedRevision)).digest('hex');
    await DecisionScenarioRevision.collection.updateOne({ _id: revisionRecord._id }, {
      $set: { payload: forgedRevision, inputHash: forgedRevisionHash },
    });
    const tamperedRevision = await call(base, userOne, `/scenarios/${id}`);
    assert.equal(tamperedRevision.response.status, 503);
    assert.equal(tamperedRevision.body.code, 'DECISION_REVISION_INTEGRITY_FAILURE');

    const deleting = await call(base, userOne, `/scenarios/${id}`, 'DELETE',
      { expectedRevision: 3 });
    assert.equal(deleting.response.status, 200);
    assert.equal(deleting.body.deleted, true);

    assert.equal(await DecisionScenario.exists({ _id: id }), null);
    assert.equal(await DecisionScenarioRevision.countDocuments({ scenarioId: id }), 0);
    assert.equal(await DecisionRun.countDocuments({ scenarioId: id }), 0);
    const deletedReport = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(deletedReport.response.status, 404);
  });
});

test('malformed and unauthenticated requests fail before persistence', async () => {
  await withServer(app(), async base => {
    const unauth = await jsonRequest(`${base}/api/decisions/scenarios`, {
      method: 'POST', body: JSON.stringify(scenarioInput()),
    });
    assert.equal(unauth.response.status, 401);
    const invalid = await call(base, userOne, '/scenarios', 'POST', {
      ...scenarioInput(), extraProviderOverride: 'fabricated',
    }, 'decision-malformed-0001');
    assert.equal(invalid.response.status, 400);
    const missingKey = await call(base, userOne, '/scenarios', 'POST', scenarioInput());
    assert.equal(missingKey.response.status, 400);
  });
});
