/**
 * Runway readiness is a release gate, not an index auto-migration.
 * A feature-enabled replica must refuse traffic when its signing key or
 * required MongoDB unique/TTL indexes are missing or incorrect.
 */
import { RunwayLedgerRevision, RunwaySnapshot, RunwaySnapshotDeletion } from '../models/Runway.js';
import { assertRunwaySigningKey } from './runwaySeal.js';
import { assertRunwayEvidenceEncryptionReady } from './runwayEvidenceCrypto.js';
import { RunwayStatement, RunwaySignal, RunwaySettlement } from '../models/RunwayEvidence.js';

async function readIndexes() {
  return Promise.all([
    RunwayLedgerRevision.collection.indexes(),
    RunwaySnapshot.collection.indexes(),
    RunwaySnapshotDeletion.collection.indexes(),
    RunwayStatement.collection.indexes(),
    RunwaySignal.collection.indexes(),
    RunwaySettlement.collection.indexes(),
  ]);
}
export async function verifyRunwayIndexes({ loadIndexes = readIndexes } = {}) {
  let indexes;
  try { indexes = await loadIndexes(); } catch {
    const error = new Error('Required Runway indexes are not accessible.');
    error.code = 'RUNWAY_INDEXES_UNAVAILABLE';
    throw error;
  }
  const [ledger, snapshot, deletion, statement, signal, settlement] = Array.isArray(indexes) ? indexes : [];
  const ready = Array.isArray(ledger) && Array.isArray(snapshot) && Array.isArray(deletion)
    && Array.isArray(statement) && Array.isArray(signal) && Array.isArray(settlement)
    && ledger.some(i => i.name === 'uniq_runway_ledger_revision'
      && i.unique === true && i.key?.userId === 1 && i.key?.revision === 1)
    && snapshot.some(i => i.name === 'runway_snapshots_by_owner'
      && i.key?.userId === 1 && i.key?.createdAt === -1)
    && deletion.some(i => i.name === 'runway_deleted_snapshot_ttl'
      && i.key?.expiresAt === 1 && i.expireAfterSeconds === 0)
    && statement.some(i => i.name === 'runway_statement_owner_newest'
      && i.key?.userId === 1 && i.key?.importedAt === -1)
    && signal.some(i => i.name === 'runway_signal_owner_cursor'
      && i.key?.userId === 1 && i.key?._id === 1)
    && signal.some(i => i.name === 'runway_signal_ttl'
      && i.key?.expiresAt === 1 && i.expireAfterSeconds === 0)
    && settlement.some(i => i.name === 'runway_settlement_owner_audit'
      && i.key?.userId === 1 && i.key?.decidedAt === -1)
    && settlement.some(i => i.name === 'uniq_runway_settled_source_row'
      && i.unique === true && i.key?.userId === 1
      && i.key?.statementId === 1 && i.key?.rowIndex === 1)
    && settlement.some(i => i.name === 'uniq_runway_settled_transaction_identity'
      && i.unique === true && i.key?.userId === 1 && i.key?.transactionIdentity === 1);
  if (!ready) {
    const error = new Error('Required Runway unique and TTL indexes are missing or incorrect.');
    error.code = 'RUNWAY_INDEXES_UNAVAILABLE';
    throw error;
  }
  return true;
}
export async function verifyRunwayOperationalReadiness({
  env = process.env, loadIndexes = readIndexes,
  legacyCount = () => RunwayStatement.countDocuments({
    'statement.encryptionVersion': { $ne: 'RUNWAY_AES256GCM_V1' },
  }),
  legacySettlements = () => RunwaySettlement.countDocuments({
    transactionIdentity: { $exists: false },
  }),
} = {}) {
  if (env.RUNWAY_ENABLED !== 'true') return { enabled: false, ready: true };
  assertRunwaySigningKey(env);
  assertRunwayEvidenceEncryptionReady(env);
  await verifyRunwayIndexes({ loadIndexes });
  // Never report ready while older unencrypted statements remain in MongoDB.
  // They must be verified and re-sealed by the explicit one-time migration.
  if (await legacySettlements() !== 0) {
    const error = new Error('Old settlement receipts need identity migration before release.');
    error.code = 'RUNWAY_SETTLEMENT_MIGRATION_REQUIRED';
    throw error;
  }
  if (await legacyCount() !== 0) {
    const error = new Error('Legacy unencrypted Runway imports require migration.');
    error.code = 'RUNWAY_EVIDENCE_MIGRATION_REQUIRED';
    throw error;
  }
  return { enabled: true, ready: true };
}
