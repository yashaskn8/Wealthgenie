/**
 * Explicit additive index migration for the Household Runway persistence boundary.
 * Must run against the intended DB before RUNWAY_ENABLED=true.
 */
import mongoose from 'mongoose';
import { RunwayLedgerRevision, RunwaySnapshot, RunwaySnapshotDeletion, RunwayErasureFence } from '../models/Runway.js';
import { RunwayStatement, RunwaySignal, RunwaySettlement } from '../models/RunwayEvidence.js';
import { RunwayProjectionJob, RunwayProjectionResult, RunwayAlert } from '../models/RunwayProjection.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) throw new Error('MONGODB_MIGRATION_URI is required for Household Runway index migration.');
try {
  await mongoose.connect(uri, { autoIndex: false });
  // Pre-create the deletion fence collection before a transactional first write.
  // Its mandatory unique owner identity is MongoDB's built-in _id index.
  await RunwayErasureFence.createCollection();
  await RunwayLedgerRevision.collection.createIndex({ userId: 1, revision: 1 }, {
    unique: true, name: 'uniq_runway_ledger_revision',
  });
  await RunwaySnapshot.collection.createIndex({ userId: 1, createdAt: -1 }, {
    name: 'runway_snapshots_by_owner',
  });
  await RunwaySnapshotDeletion.collection.createIndex({ expiresAt: 1 }, {
    name: 'runway_deleted_snapshot_ttl', expireAfterSeconds: 0,
  });
  await RunwayStatement.collection.createIndex({ userId: 1, importedAt: -1 }, {
    name: 'runway_statement_owner_newest',
  });
  await RunwaySignal.collection.createIndex({ userId: 1, _id: 1 }, {
    name: 'runway_signal_owner_cursor',
  });
  await RunwaySignal.collection.createIndex({ expiresAt: 1 }, {
    name: 'runway_signal_ttl', expireAfterSeconds: 0,
  });
  await RunwaySettlement.collection.createIndex({ userId: 1, decidedAt: -1 }, {
    name: 'runway_settlement_owner_audit',
  });
  await RunwaySettlement.collection.createIndex({ userId: 1, statementId: 1, rowIndex: 1 }, {
    name: 'uniq_runway_settled_source_row', unique: true,
  });
  await RunwaySettlement.collection.createIndex({ userId: 1, transactionIdentity: 1 }, {
    name: 'uniq_runway_settled_transaction_identity', unique: true,
  });
  await RunwayProjectionJob.collection.createIndex({ status: 1, availableAt: 1, _id: 1 },
    { name: 'runway_projection_queue_claim' });
  await RunwayProjectionJob.collection.createIndex({ userId: 1, revision: 1 },
    { unique: true, name: 'uniq_runway_projection_job_revision' });
  await RunwayProjectionResult.collection.createIndex({ userId: 1, revision: -1 },
    { name: 'runway_projection_owner_revision' });
  await RunwayAlert.collection.createIndex({ userId: 1, revision: -1 },
    { name: 'runway_alert_owner_revision' });
  const [indexes, snapshots, deletions, statements, signals, settlements, jobs, projections, alerts, fences] = await Promise.all([
    RunwayLedgerRevision.collection.indexes(),
    RunwaySnapshot.collection.indexes(),
    RunwaySnapshotDeletion.collection.indexes(),
    RunwayStatement.collection.indexes(),
    RunwaySignal.collection.indexes(),
    RunwaySettlement.collection.indexes(),
    RunwayProjectionJob.collection.indexes(),
    RunwayProjectionResult.collection.indexes(),
    RunwayAlert.collection.indexes(),
    RunwayErasureFence.collection.indexes(),
  ]);
  if (!indexes.some(index => index.name === 'uniq_runway_ledger_revision'
      && index.unique === true && index.key.userId === 1 && index.key.revision === 1)
      || !snapshots.some(index => index.name === 'runway_snapshots_by_owner'
        && index.key.userId === 1 && index.key.createdAt === -1)
      || !deletions.some(index => index.name === 'runway_deleted_snapshot_ttl'
        && index.key.expiresAt === 1 && index.expireAfterSeconds === 0)
      || !statements.some(index => index.name === 'runway_statement_owner_newest'
        && index.key.userId === 1 && index.key.importedAt === -1)
      || !signals.some(index => index.name === 'runway_signal_owner_cursor'
        && index.key.userId === 1 && index.key._id === 1)
      || !signals.some(index => index.name === 'runway_signal_ttl'
        && index.key.expiresAt === 1 && index.expireAfterSeconds === 0)
      || !settlements.some(index => index.name === 'runway_settlement_owner_audit'
        && index.key.userId === 1 && index.key.decidedAt === -1)
      || !settlements.some(index => index.name === 'uniq_runway_settled_source_row'
        && index.unique === true && index.key.userId === 1
        && index.key.statementId === 1 && index.key.rowIndex === 1)
      || !settlements.some(index => index.name === 'uniq_runway_settled_transaction_identity'
        && index.unique === true && index.key.userId === 1
        && index.key.transactionIdentity === 1)
      || !jobs.some(index => index.name === 'runway_projection_queue_claim'
        && index.key.status === 1 && index.key.availableAt === 1 && index.key._id === 1)
      || !jobs.some(index => index.name === 'uniq_runway_projection_job_revision'
        && index.unique === true && index.key.userId === 1 && index.key.revision === 1)
      || !projections.some(index => index.name === 'runway_projection_owner_revision'
        && index.key.userId === 1 && index.key.revision === -1)
      || !alerts.some(index => index.name === 'runway_alert_owner_revision'
        && index.key.userId === 1 && index.key.revision === -1)
      || !fences.some(index => index.name === '_id_' && index.unique === true
        && index.key._id === 1)) {
    throw new Error('RUNWAY_INDEX_MISSING');
  }
  process.stdout.write('Runway revisions, evidence and notification indexes verified.\n');
} catch (error) {
  process.stderr.write('Runway index migration failed: ' + (error.code || error.name || 'UNKNOWN') + '\n');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
