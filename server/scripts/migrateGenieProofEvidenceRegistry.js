import mongoose from 'mongoose';
import { GENIEPROOF_SOURCE_CATALOG_CANDIDATES } from '../agents/genieProof/genieProofSourceCatalog.js';
import { appendGenieProofSourceDefinitionRevision } from '../agents/genieProof/genieProofEvidenceRegistryService.js';
import { migrateGenieProofPersistenceIndexes } from '../services/persistenceIndexReadiness.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) {
  throw new Error('MONGODB_MIGRATION_URI is required for the explicit GenieProof evidence registry migration.');
}

try {
  await mongoose.connect(uri, { autoIndex: false });
  const indexes = await migrateGenieProofPersistenceIndexes();
  for (const candidate of GENIEPROOF_SOURCE_CATALOG_CANDIDATES) {
    await appendGenieProofSourceDefinitionRevision({ source: candidate });
  }
  process.stdout.write(`GenieProof evidence registry indexes verified at ${indexes.verifiedAt}; blocked source candidates present: ${GENIEPROOF_SOURCE_CATALOG_CANDIDATES.length}.\n`);
} catch (error) {
  process.stderr.write(`GenieProof evidence registry migration failed: ${error.code || error.name || 'MIGRATION_FAILED'}.\n`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
