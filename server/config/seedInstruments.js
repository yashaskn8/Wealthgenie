/**
 * WealthGenie — Instrument Seed Script
 * ─────────────────────────────────────
 * Seeds MongoDB with ALL instruments from the backend's authoritative
 * investment catalog (server/data/investmentDatabase.js).
 *
 * Usage:  npm run seed
 *   or:   node --experimental-specifier-resolution=node server/config/seedInstruments.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Instrument from '../models/Instrument.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { buildInstrumentSeedOperations } from './instrumentSeedPlan.js';

async function seed() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('MONGODB_URI not set. Please configure your .env file.');
      process.exit(1);
    }

    // Validate the complete authoritative catalog before connecting or mutating
    // the database. A bad/duplicated source must never empty production data.
    const { operations, typeCounts } = buildInstrumentSeedOperations(investmentDatabase);
    await mongoose.connect(uri);
    console.log('✓ Connected to MongoDB');

    // Idempotent upserts retain out-of-catalog records for administrator review,
    // and preserve dynamic NAV/pricing fields on existing instrument documents.
    // A retried run repairs a partial update without any bulk deletion.
    const result = await Instrument.bulkWrite(operations, { ordered: true });
    console.log(`✓ Catalog synchronized: ${operations.length} instruments; ${result.upsertedCount || 0} added, ${result.modifiedCount || 0} updated`);
    console.log('  Distribution:', JSON.stringify(typeCounts, null, 2));
    console.log('  Existing off-catalog and market observations were not deleted.');

    await mongoose.disconnect();
    console.log('✓ Disconnected from MongoDB');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    if (err.writeErrors) {
      console.error(`  ${err.writeErrors.length} write errors. First:`, err.writeErrors[0]?.errmsg);
    }
    process.exit(1);
  }
}

seed();
