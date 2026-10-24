/** Standalone opt-in Runway worker, independent from the AI agent worker. */
import 'dotenv/config';
import mongoose from 'mongoose';
import { processOneRunwayProjection } from '../services/runwayProjectionOutbox.js';
import { runRunwayWorkerLoop } from '../services/runwayWorkerLoop.js';
import connectDB from '../config/db.js';
import { verifyRunwayOperationalReadiness } from '../services/runwayOperationalReadiness.js';
const env = process.env;
if (env.RUNWAY_PROJECTION_WORKER_ENABLED !== 'true' || env.RUNWAY_ENABLED !== 'true') {
  throw new Error('Runway worker must be explicitly enabled together with Runway.');
}
if (!env.MONGODB_URI) throw new Error('MONGODB_URI required.');
await connectDB({
  uri: env.MONGODB_URI, env, retries: 1,
  options: { autoIndex: false, serverSelectionTimeoutMS: 10_000 },
  requireTransactions: true,
});
let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  await verifyRunwayOperationalReadiness();
  await runRunwayWorkerLoop({
    processOne: () => processOneRunwayProjection(),
    shouldStop: () => stopping,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    reportBlocked: code => { process.stderr.write('Runway projection blocked: ' + code + '\\n'); },
  });
} finally {
  await mongoose.disconnect();
}
