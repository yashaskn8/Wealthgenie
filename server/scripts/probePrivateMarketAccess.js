/**
 * Run from a trusted machine with server/.env and Node 22:
 *   NODE_ENV=development PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED=true node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms
 *
 * Windows PowerShell:
 *   $env:NODE_ENV="development"; $env:PRIVATE_MARKET_READ_ONLY_PROBE_ENABLED="true"
 *   node server/scripts/probePrivateMarketAccess.js --i-accept-provider-terms
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { runPrivateMarketAccessProbe } from '../services/marketData/privateMarketAccessProbe.js';

// Load local backend credentials without overriding explicitly supplied env vars.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: false });

try {
  const expected = '--i-accept-provider-terms';
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== expected) {
    throw Object.assign(new Error('Pass provider-terms acknowledgement.'), {
      code: 'PRIVATE_MARKET_PROBE_ACKNOWLEDGEMENT_REQUIRED',
    });
  }
  const report = await runPrivateMarketAccessProbe({ acknowledgeProviderTerms: true });
  // Print only provider/operation/verdict/status. No token, payload, or account data.
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.results.some(item => item.verdict !== 'HTTP_200_SCHEMA_OK')) process.exitCode = 1;
} catch (error) {
  process.stderr.write((error?.code || 'PRIVATE_MARKET_PROBE_UNAVAILABLE') + '\n');
  process.exitCode = 1;
}
