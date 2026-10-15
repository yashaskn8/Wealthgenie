import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import test from 'node:test';
import AgentQueueAdmission from '../models/AgentQueueAdmission.js';
import AgentRun from '../models/AgentRun.js';
import { enqueuePlanReviewRun } from '../agents/planReview/planReviewService.js';
import { buildPlanReviewSnapshotBinding, hashPlanReviewSnapshot } from '../agents/planReview/planReviewRuntime.js';
import { migratePlanHealthPersistence } from '../services/planHealthPersistence.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

test('transactional admission fence keeps 50-way queue pressure at limit one for 100 deterministic rounds', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const userId = new mongoose.Types.ObjectId();
  const runIds = [];
  try {
    await migratePlanHealthPersistence();
    for (let round = 0; round < 100; round += 1) {
      const calls = Array.from({ length: 50 }, async (_, index) => {
        const profileId = new mongoose.Types.ObjectId();
        const sourceBinding = buildPlanReviewSnapshotBinding({
          userId,
          profileId,
          currentState: { profileVersion: (round * 50) + index + 1 },
          freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] },
        });
        const planReviewSnapshotHash = hashPlanReviewSnapshot(sourceBinding);
        const result = await enqueuePlanReviewRun({
          userId,
          profileId,
          model: AgentRun,
          admissionModel: AgentQueueAdmission,
          mongo: mongoose,
          snapshotResolver: async () => ({ sourceBinding, planReviewSnapshotHash }),
          runtimeConfig: { agentPlanReview: { maxQueuedRunsPerUser: 50, maxActiveRunsPerUser: 1, maxGlobalQueuedRuns: 100 } },
        });
        if (result.created) runIds.push(result.run.runId);
        return result;
      });
      const results = await Promise.allSettled(calls);
      const accepted = results.filter(result => result.status === 'fulfilled');
      assert.ok(accepted.length <= 1, `round ${round}: active admission must never exceed one`);
      assert.equal(results.length - accepted.length, 50 - accepted.length);
      for (const rejection of results.filter(result => result.status === 'rejected')) {
        assert.equal(rejection.reason.code, 'AGENT_QUEUE_SATURATED', `round ${round}: only capacity can reject this fixture`);
      }
      if (accepted[0]?.status === 'fulfilled' && accepted[0].value.created) {
        await AgentRun.updateOne(
          { runId: accepted[0].value.run.runId, userId },
          { $set: { status: 'COMPLETED' }, $unset: { activeDedupeKey: 1 } },
        );
      }
    }
    assert.equal(await AgentRun.countDocuments({ userId, status: { $in: ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL'] } }), 0);
    assert.equal((await AgentQueueAdmission.findOne({ _id: 'plan-review' }).lean()).epoch, 100);
  } finally {
    await AgentRun.deleteMany({ runId: { $in: runIds } });
    await teardownTestDatabase();
  }
});
