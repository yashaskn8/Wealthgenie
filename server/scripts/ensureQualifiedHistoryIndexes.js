/**
 * Explicit additive index migration. Never drops or rewrites old market data.
 * Run before enabling MARKET_EQUITY_HISTORY_STORE_ENABLED in any deployment.
 * Example from server directory: node scripts/ensureQualifiedHistoryIndexes.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import MarketEquityDailyBar from '../models/MarketEquityDailyBar.js';

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI_NOT_CONFIGURED');
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
  });
  try {
    await MarketEquityDailyBar.createCollection();
    await MarketEquityDailyBar.createIndexes();
    const indexes = await MarketEquityDailyBar.collection.indexes();
    for (const name of ['unique_qualified_equity_daily_bar', 'expire_qualified_equity_daily_bar',
      'qualified_equity_history_batch_read']) {
      if (!indexes.some(index => index.name === name)) throw new Error('INDEX_MISSING:' + name);
    }
    process.stdout.write('Qualified EOD indexes verified; existing collections untouched.\n');
  } finally {
    await mongoose.disconnect();
  }
}
main().catch(() => {
  // Avoid printing raw MongoDB connection strings contained in driver errors.
  process.stderr.write('MARKET_HISTORY_INDEX_MIGRATION_FAILED\n');
  process.exitCode = 1;
});
