import mongoose from 'mongoose';
import { GENIEPROOF_SOURCE_CATALOG_CANDIDATES } from '../agents/genieProof/genieProofSourceCatalog.js';
import GenieProofSourceDefinition from '../models/GenieProofSourceDefinition.js';
import { migrateGenieProofPersistenceIndexes } from '../services/persistenceIndexReadiness.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) {
  throw new Error('MONGODB_MIGRATION_URI is required for the explicit GenieProof evidence registry migration.');
}

try {
  await mongoose.connect(uri, { autoIndex: false });
  const indexes = await migrateGenieProofPersistenceIndexes();
  for (const candidate of GENIEPROOF_SOURCE_CATALOG_CANDIDATES) {
    const existing = await GenieProofSourceDefinition.collection.findOne({
      sourceId: candidate.sourceId,
      revision: candidate.revision,
    });
    if (existing) {
      if (existing.definitionHash !== candidate.definitionHash) {
        throw Object.assign(new Error('An existing GenieProof source definition conflicts with the reviewed catalog candidate.'), {
          code: 'GENIEPROOF_SOURCE_CATALOG_CONFLICT',
        });
      }
      continue;
    }
    await GenieProofSourceDefinition.collection.insertOne({ ...candidate, createdAt: new Date() });
  }
  process.stdout.write(`GenieProof evidence registry indexes verified at ${indexes.verifiedAt}; blocked source candidates present: ${GENIEPROOF_SOURCE_CATALOG_CANDIDATES.length}.\n`);
} catch (error) {
  process.stderr.write(`GenieProof evidence registry migration failed: ${error.code || error.name || 'MIGRATION_FAILED'}.\n`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
