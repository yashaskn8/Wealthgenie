import mongoose from 'mongoose';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';
import DecisionEvent from '../models/DecisionEvent.js';
import DecisionEventState from '../models/DecisionEventState.js';
import DecisionMonitor from '../models/DecisionMonitor.js';
import DecisionAssessment from '../models/DecisionAssessment.js';

// Index work belongs in an explicit migration, never request-time execution.
const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) throw new Error('MONGODB_MIGRATION_URI is required for GenieDecision migrations.');

const expected = [
  [DecisionScenario, { userId: 1, createKeyHash: 1 }, 'uniq_decision_create_key', true],
  [DecisionScenario, { userId: 1, quotaSlot: 1 }, 'uniq_decision_owner_quota_slot', true],
  [DecisionScenario, { userId: 1, createdAt: -1 }, 'decision_owner_history', false],
  [DecisionScenarioRevision, { userId: 1, scenarioId: 1, revision: 1 },
    'uniq_decision_revision_owner_sequence', true],
  [DecisionRun, { userId: 1, runKeyHash: 1 }, 'uniq_decision_run_key', true],
  [DecisionRun, { userId: 1, scenarioId: 1, createdAt: -1 },
    'decision_run_owner_history', false],
  [DecisionEventState, { userId: 1 }, 'uniq_decision_event_owner_sequence', true],
  [DecisionEvent, { userId: 1, sequence: 1 }, 'uniq_decision_event_owner_order', true],
  [DecisionEvent, { expiresAt: 1 }, 'decision_event_expiration', false],
  [DecisionMonitor, { userId: 1, scenarioId: 1 }, 'uniq_decision_monitor_owner_scenario', true],
  [DecisionMonitor, { enabled: 1, lastCheckedAt: 1 }, 'decision_monitor_scan', false],
  [DecisionAssessment, {
    userId: 1, scenarioId: 1, scenarioRevision: 1, monitorGeneration: 1,
    profileFactsHash: 1, profileStateRevision: 1, profileVersion: 1,
    profileFinancialFence: 1, modelVersion: 1,
  }, 'uniq_decision_assessment_source_policy', true],
  [DecisionAssessment, { userId: 1, scenarioId: 1, createdAt: -1 },
    'decision_assessment_owner_history', false],
];

function sameKeys(left, right) {
  return JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
}

try {
  await mongoose.connect(uri, { autoIndex: false });
  for (const [model, keys, name, unique] of expected) {
    await model.collection.createIndex(keys, {
      name, unique, ...(name === 'decision_event_expiration' ? { expireAfterSeconds: 0 } : {}),
    });
    const indexes = await model.collection.indexes();
    if (!indexes.some(index => index.name === name && Boolean(index.unique) === unique
      && sameKeys(index.key, keys)
      && (name !== 'decision_event_expiration' || index.expireAfterSeconds === 0))) {
      throw new Error(`Required GenieDecision index ${name} did not verify.`);
    }
  }
  process.stdout.write('GenieDecision owner, revision and idempotency indexes verified.\n');
} catch (error) {
  process.stderr.write(`GenieDecision index migration failed: ${error.code || error.name || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
