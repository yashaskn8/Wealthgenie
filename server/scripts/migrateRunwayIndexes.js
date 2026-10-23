/**
 * Explicit additive index migration for the Household Runway persistence boundary.
 * Must run against the intended DB before RUNWAY_ENABLED=true.
 */
import mongoose from 'mongoose';
import { RunwayLedgerRevision, RunwaySnapshot } from '../models/Runway.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) throw new Error('MONGODB_MIGRATION_URI is required for Household Runway index migration.');
try {
  await mongoose.connect(uri, { autoIndex: false });
  await RunwayLedgerRevision.collection.createIndex({ userId: 1, revision: 1 }, {
    unique: true, name: 'uniq_runway_ledger_revision',
  });
  await RunwaySnapshot.collection.createIndex({ userId: 1, createdAt: -1 }, {
    name: 'runway_snapshots_by_owner',
  });
  const indexes = await RunwayLedgerRevision.collection.indexes();
  if (!indexes.some(index => index.name === 'uniq_runway_ledger_revision'
      && index.unique === true && index.key.userId === 1 && index.key.revision === 1)) {
    throw new Error('RUNWAY_REVISION_INDEX_MISSING');
  }
  process.stdout.write('Runway owner/revision indexes verified.\n');
} catch (error) {
  process.stderr.write('Runway index migration failed: ' + (error.code || error.name || 'UNKNOWN') + '\n');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
