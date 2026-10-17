import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import NseHistoricalDataProvider, { NSE_HISTORICAL_INDEX_RIGHTS_URL } from '../services/marketData/NseHistoricalDataProvider.js';
import { NSE_TRADING_HOLIDAY_URL } from '../services/marketData/nseTradingCalendar.js';
import { assertMarketDataQualificationRights } from '../services/marketData/marketDataRights.js';
import { MARKET_BENCHMARKS } from '../services/marketData/marketBenchmarks.js';
import { buildMarketRegimeDataset } from '../services/marketData/marketRegimeDataset.js';
import { isTwoProviderMarketDataMode } from '../services/marketDataService.js';

function argumentsByName(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new TypeError('Arguments must be supplied as --name value pairs.');
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

const args = argumentsByName(process.argv.slice(2));
const fromDate = args.get('from');
const toDate = args.get('to');
const output = args.get('output');
if (!fromDate || !toDate || !output) {
  throw new TypeError('Required arguments: --from YYYY-MM-DD --to YYYY-MM-DD --output FILE');
}

try {
  if (isTwoProviderMarketDataMode()) {
    const error = new Error('NSE market-data export is disabled in UPSTOX_TEJHQ mode.');
    error.code = 'NSE_MARKET_DATA_DISABLED_IN_TWO_PROVIDER_MODE';
    throw error;
  }
  assertMarketDataQualificationRights([
    { provider: 'NSE', url: NSE_HISTORICAL_INDEX_RIGHTS_URL },
    { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
  ]);
} catch (error) {
  console.error((error.code || 'MARKET_DATA_QUALIFICATION_BLOCKED') + ': ' + error.message);
  process.exit(1);
}

const provider = new NseHistoricalDataProvider({ httpClient: axios });
const options = { fromDate, toDate, forceRefresh: args.get('force-refresh') === 'true' };
// Sequential series retrieval deliberately caps NSE request concurrency. Each
// provider call also batches its date windows and uses the existing cache.
const niftySnapshot = await provider.getDailyCandles(
  MARKET_BENCHMARKS.NIFTY_50.canonicalProductId,
  options,
);
const vixSnapshot = await provider.getDailyCandles(
  MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId,
  options,
);
const dataset = buildMarketRegimeDataset({
  niftySnapshot,
  vixSnapshot,
  retrievedAt: new Date().toISOString(),
});
const outputPath = path.resolve(output);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(dataset)}\n`, { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({
  status: 'MARKET_REGIME_DATASET_EXPORTED',
  datasetVersion: dataset.datasetVersion,
  rowCount: dataset.rowCount,
  period: dataset.period,
  contentHash: dataset.contentHash,
}));
