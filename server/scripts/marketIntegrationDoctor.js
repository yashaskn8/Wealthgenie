import 'dotenv/config';
import { getMarketIntegrationReadiness } from '../services/marketIntegrationReadiness.js';

// Configuration-only diagnostic. Never contacts a provider or echoes credentials.
// Run from server/: npm run market:doctor
const result = getMarketIntegrationReadiness(process.env);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === 'BLOCKED') process.exitCode = 2;
