/**
 * Rights retention janitor for PRIVATE derived user valuations.
 * Uses native collection deletion intentionally: retention revocation is a
 * policy-driven erasure, not an investor-initiated mutation of append-only history.
 * The cron operator must run this before relying on a fresh rights revocation.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import HoldingValuationSnapshot from '../models/HoldingValuationSnapshot.js';

const mongoUrl=process.env.MONGODB_MIGRATION_URI;
const pgUrl=process.env.FINANCIAL_POSTGRES_URL;
if (!mongoUrl || !pgUrl) {
  throw new Error('PRIVATE_FINANCIAL_RETENTION_MONGO_AND_POSTGRES_REQUIRED');
}
const pool=new Pool({connectionString:pgUrl,max:1,connectionTimeoutMillis:5000});
try {
  const { rows }=await pool.query(`
    SELECT source_id FROM finance.provider_rights
      WHERE revoked_at IS NOT NULL
        OR (expires_at IS NOT NULL AND expires_at<=now())
        OR reviewed_at IS NULL OR NOT access_allowed
        OR NOT extraction_allowed OR NOT storage_allowed
        OR NOT derivation_allowed OR NOT commercial_use_allowed`);
  await mongoose.connect(mongoUrl,{autoIndex:false});
  let removed=0;
  for (let i=0;i<rows.length;i+=100) {
    const sourceIds=rows.slice(i,i+100).map(r=>r.source_id);
    // Deliberately bypass the append-only model middleware to perform mandated erasure.
    const deleted=await HoldingValuationSnapshot.collection.deleteMany({
      sourceId:{$in:sourceIds},
    });
    removed+=deleted.deletedCount||0;
  }
  const expired=await HoldingValuationSnapshot.collection.deleteMany({
    retainedUntil:{$lte:new Date()},
  });
  removed+=expired.deletedCount||0;
  process.stdout.write(JSON.stringify({
    status:'PRIVATE_VALUATION_RETENTION_PRUNED',
    disallowedSourceCount:rows.length,removedPrivateValuations:removed,
    sourceDataRetainedInOutput:false,
  })+'\n');
} finally {
  await mongoose.disconnect().catch(()=>{});
  await pool.end();
}
