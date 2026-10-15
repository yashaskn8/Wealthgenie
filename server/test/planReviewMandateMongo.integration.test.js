import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import test from 'node:test';
import AgentRun from '../models/AgentRun.js';
import { completePlanReviewMandateAction } from '../agents/planReview/planReviewApproval.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

test('Mongo CAS permits only one terminal mandate outcome for a waiting PlanReview run', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const userId = new mongoose.Types.ObjectId();
  const runId = `plan-review-mandate-race-${new mongoose.Types.ObjectId()}`;
  const mandateId = `mandate-${new mongoose.Types.ObjectId()}`;
  try {
    await AgentRun.create({
      runId,
      agentType: 'PLAN_REVIEW',
      userId,
      status: 'WAITING_FOR_APPROVAL',
      planReviewSnapshotHash: 'a'.repeat(64),
      sourceBinding: { schemaVersion: 'mongo-race-test' },
      activeDedupeKey: `active-${runId}`,
      approval: { status: 'MANDATE_CREATED', mandateId },
    });

    const outcomes = await Promise.all([
      completePlanReviewMandateAction({ model: AgentRun, userId, runId, mandateId, outcome: 'EXPIRED' }),
      completePlanReviewMandateAction({ model: AgentRun, userId, runId, mandateId, outcome: 'REJECTED' }),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1, 'the WAITING_FOR_APPROVAL CAS has exactly one winner');

    const persisted = await AgentRun.findOne({ runId, userId }).lean();
    assert.ok(['FAILED', 'CANCELLED'].includes(persisted.status));
    assert.equal(persisted.approval.mandateId, mandateId);
    assert.ok(['MANDATE_EXPIRED', 'MANDATE_REJECTED'].includes(persisted.approval.status));
    assert.equal('activeDedupeKey' in persisted, false, 'the winning terminal transition releases the active unique key');
  } finally {
    await AgentRun.deleteOne({ runId, userId });
    await teardownTestDatabase();
  }
});
