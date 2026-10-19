/**
 * Read-only Plan Review startup preflight for the verified isolated local demo.
 * Never creates collections, indexes, admission rows, or repair data.
 */
import mongoose from 'mongoose';
import { verifyPlanReviewPersistenceIndexes } from '../services/planReviewPersistence.js';
import { verifyAgentRuntimePersistence } from '../services/planHealthPersistence.js';

async function main() {
  const rawUri = process.env.MONGODB_URI;
  const url = rawUri ? new URL(rawUri) : null;
  if (!url || url.protocol !== 'mongodb:'
      || url.hostname !== '127.0.0.1'
      || url.port !== '27030'
      || url.pathname !== '/wealthgenie-demo'
      || url.searchParams.get('replicaSet') !== 'rs0'
      || process.env.DEMO_EXPECTED_MONGODB_DATABASE !== 'wealthgenie-demo'
      || process.env.DEMO_EXPECTED_MONGODB_PORT !== '27030') {
    const error = new Error('Selected database identity is outside the verified local demo.');
    error.code = 'PLAN_REVIEW_DEMO_DATABASE_IDENTITY_UNVERIFIED';
    throw error;
  }
  await mongoose.connect(rawUri, {
    autoIndex: false, autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await verifyPlanReviewPersistenceIndexes({ force: true });
    await verifyAgentRuntimePersistence({ force: true });
    process.stdout.write('PLAN_REVIEW_PHASE4_AND_PHASE5_READINESS_VERIFIED\n');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  // No URI, passwords, document contents or raw MongoDB driver errors in logs.
  const code = /^[A-Z0-9_]{3,100}$/.test(String(error?.code || ''))
    ? error.code : 'PLAN_REVIEW_PERSISTENCE_PREFLIGHT_FAILED';
  process.stderr.write('PLAN_REVIEW_READINESS_BLOCKED:' + code + '\n');
  process.exitCode = 1;
});
