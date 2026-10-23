import mongoose from 'mongoose';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';

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
];

function sameKeys(left, right) {
  return JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
}

try {
  await mongoose.connect(uri, { autoIndex: false });
  for (const [model, keys, name, unique] of expected) {
    await model.collection.createIndex(keys, { name, unique });
    const indexes = await model.collection.indexes();
    if (!indexes.some(index => index.name === name && Boolean(index.unique) === unique
      && sameKeys(index.key, keys))) {
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
