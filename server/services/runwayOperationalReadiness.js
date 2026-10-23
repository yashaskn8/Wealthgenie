/**
 * Runway readiness is a release gate, not an index auto-migration.
 * A feature-enabled replica must refuse traffic when its signing key or
 * required MongoDB unique/TTL indexes are missing or incorrect.
 */
import { RunwayLedgerRevision, RunwaySnapshot, RunwaySnapshotDeletion } from '../models/Runway.js';
import { assertRunwaySigningKey } from './runwaySeal.js';

async function readIndexes() {
  return Promise.all([
    RunwayLedgerRevision.collection.indexes(),
    RunwaySnapshot.collection.indexes(),
    RunwaySnapshotDeletion.collection.indexes(),
  ]);
}
export async function verifyRunwayIndexes({ loadIndexes = readIndexes } = {}) {
  let indexes;
  try { indexes = await loadIndexes(); } catch {
    const error = new Error('Required Runway indexes are not accessible.');
    error.code = 'RUNWAY_INDEXES_UNAVAILABLE';
    throw error;
  }
  const [ledger, snapshot, deletion] = Array.isArray(indexes) ? indexes : [];
  const ready = Array.isArray(ledger) && Array.isArray(snapshot) && Array.isArray(deletion)
    && ledger.some(i => i.name === 'uniq_runway_ledger_revision'
      && i.unique === true && i.key?.userId === 1 && i.key?.revision === 1)
    && snapshot.some(i => i.name === 'runway_snapshots_by_owner'
      && i.key?.userId === 1 && i.key?.createdAt === -1)
    && deletion.some(i => i.name === 'runway_deleted_snapshot_ttl'
      && i.key?.expiresAt === 1 && i.expireAfterSeconds === 0);
  if (!ready) {
    const error = new Error('Required Runway unique and TTL indexes are missing or incorrect.');
    error.code = 'RUNWAY_INDEXES_UNAVAILABLE';
    throw error;
  }
  return true;
}
export async function verifyRunwayOperationalReadiness({
  env = process.env, loadIndexes = readIndexes,
} = {}) {
  if (env.RUNWAY_ENABLED !== 'true') return { enabled: false, ready: true };
  assertRunwaySigningKey(env);
  await verifyRunwayIndexes({ loadIndexes });
  return { enabled: true, ready: true };
}
