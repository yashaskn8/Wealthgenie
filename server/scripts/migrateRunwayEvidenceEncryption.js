/**
 * Run only after a verified encrypted backup and a paused Runway write window.
 * Check mode is read-only; apply mode requires a typed acknowledgement.
 */
import mongoose from 'mongoose';
import { RunwayStatement } from '../models/RunwayEvidence.js';
import { assertRunwaySigningKey, verifyRunwayStatementSeal } from '../services/runwaySeal.js';
import { assertRunwayEvidenceEncryptionReady } from '../services/runwayEvidenceCrypto.js';
import { prepareRunwayEvidenceMigration } from '../services/runwayEvidenceMigration.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
const mode = process.env.RUNWAY_EVIDENCE_MIGRATION_MODE || 'check';
if (!uri) throw new Error('MONGODB_MIGRATION_URI is required.');
if (!['check', 'apply'].includes(mode)) throw new Error('Migration mode must be check or apply.');
if (mode === 'apply'
  && process.env.RUNWAY_EVIDENCE_MIGRATION_ACK !== 'ENCRYPT_USER_IMPORTED_FINANCIAL_EVIDENCE') {
  throw new Error('Apply requires RUNWAY_EVIDENCE_MIGRATION_ACK=ENCRYPT_USER_IMPORTED_FINANCIAL_EVIDENCE.');
}
assertRunwaySigningKey();
assertRunwayEvidenceEncryptionReady();
let scanned = 0, updated = 0;
try {
  await mongoose.connect(uri, { autoIndex: false });
  for await (const record of RunwayStatement.find({}).sort({ _id: 1 }).lean().cursor()) {
    scanned++;
    if (!verifyRunwayStatementSeal(record)) throw new Error('Original HMAC invalid; migration halted.');
    const change = prepareRunwayEvidenceMigration(record);
    if (!change) continue;
    if (mode === 'apply') {
      const result = await RunwayStatement.collection.updateOne({
        _id: record._id, userId: record.userId, sealHmac: record.sealHmac,
        'statement.encryptionVersion': { $exists: false },
      }, { $set: change });
      if (result.matchedCount !== 1) {
        throw new Error('Concurrent edit or record mismatch; migration halted.');
      }
      const reread = await RunwayStatement.findById(record._id).lean();
      if (prepareRunwayEvidenceMigration(reread) !== null) {
        throw new Error('Post-migration verification failed.');
      }
      updated++;
    } else updated++;
  }
  const remaining = await RunwayStatement.countDocuments({
    'statement.encryptionVersion': { $ne: 'RUNWAY_AES256GCM_V1' },
  });
  process.stdout.write(JSON.stringify({ mode, scanned, eligible: updated, remaining }) + '\n');
  if (remaining > 0) process.exitCode = mode === 'apply' ? 1 : 2;
} catch (error) {
  process.stderr.write('Evidence migration halted: ' + (error.code || error.name || 'UNKNOWN') + '\n');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
