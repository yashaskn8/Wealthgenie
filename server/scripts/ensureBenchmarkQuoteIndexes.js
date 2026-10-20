/** Explicit additive migration for retained benchmark quotes. */
import 'dotenv/config';
import mongoose from 'mongoose';
import MarketObservation from '../models/MarketObservation.js';
import { benchmarkQuoteIndexesReady } from '../services/marketData/StoredBenchmarkQuoteStore.js';

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI_NOT_CONFIGURED');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await MarketObservation.createCollection();
    await MarketObservation.createIndexes();
    if (!(await benchmarkQuoteIndexesReady())) throw new Error('BENCHMARK_QUOTE_INDEXES_MISSING');
    process.stdout.write('Retained benchmark quote indexes verified.\n');
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  process.stderr.write('BENCHMARK_QUOTE_INDEX_MIGRATION_FAILED\n');
  process.exitCode = 1;
});
