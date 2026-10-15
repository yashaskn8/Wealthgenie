import autocannon from 'autocannon';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_URL = process.env.SERVER_URL || 'http://127.0.0.1:5000';
const DURATION = parseInt(process.env.TEST_DURATION || '30', 10); // 30s per scenario run
const OUTPUT_DIR = path.join(__dirname, '..', 'reports', 'loadtest');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET environment variable is required for load testing.');
  process.exit(1);
}
const TEST_TOKEN = jwt.sign(
  { userId: '60d5ecb8b3b3a72d9c8e4a11', email: 'loadtest@wealthgenie.ai' },
  JWT_SECRET,
  { expiresIn: '2h' }
);

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log('================================================================');
console.log('WealthGenie Real Load-Test Suite (Phase 6)');
console.log(`Server URL: ${SERVER_URL}`);
console.log(`Duration per run: ${DURATION}s`);
console.log(`Output Directory: ${OUTPUT_DIR}`);
console.log('================================================================\n');

/**
 * Helper to run a single autocannon test and save raw JSON output.
 */
async function runBenchmark(name, filename, options) {
  console.log(`\n>>> Running Scenario: ${name} [Connections: ${options.connections}, Duration: ${options.duration || DURATION}s]`);

  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${SERVER_URL}${options.path}`,
        method: options.method || 'GET',
        connections: options.connections,
        duration: options.duration || DURATION,
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${TEST_TOKEN}`,
          ...(options.headers || {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        pipelining: 1,
      },
      (err, result) => {
        if (err) {
          console.error(`Error running ${name}:`, err);
          return reject(err);
        }

        const rawFilePath = path.join(OUTPUT_DIR, `${filename}.json`);
        fs.writeFileSync(rawFilePath, JSON.stringify(result, null, 2));

        console.log(`✓ Completed: ${name}`);
        console.log(`  Requests/sec: ${result.requests.average.toFixed(2)}`);
        console.log(`  p50 Latency:  ${result.latency.p50} ms`);
        console.log(`  p95 Latency:  ${result.latency.p95} ms`);
        console.log(`  p99 Latency:  ${result.latency.p99} ms`);
        console.log(`  Non-2xx / Errors: ${result.non2xx} non-2xx, ${result.errors} errors, ${result.timeouts} timeouts`);
        console.log(`  Raw output saved: ${rawFilePath}`);

        resolve(result);
      }
    );

    autocannon.track(instance, { renderProgressBar: true, renderResultsTable: false });
  });
}

/**
 * Main load test execution flow.
 */
async function main() {
  const concurrencyLevels = [10, 50, 100];
  const summaryResults = [];

  // Scenario 1: Read-Heavy (GET /api/instruments)
  for (const c of concurrencyLevels) {
    const filename = `scenario1_read_heavy_c${c}`;
    const res = await runBenchmark(`Scenario 1 (Read-Heavy) - ${c} Connections`, filename, {
      path: '/api/instruments',
      method: 'GET',
      connections: c,
    });
    summaryResults.push({
      scenario: 'Scenario 1 (Read-Heavy)',
      endpoint: 'GET /api/instruments',
      concurrency: c,
      p50: res.latency.p50,
      p95: res.latency.p95,
      p99: res.latency.p99,
      rps: res.requests.average,
      non2xx: res.non2xx,
      errors: res.errors,
      timeouts: res.timeouts,
      rawFile: `${filename}.json`,
    });
  }

  // Scenario 2: Compute-Heavy (POST /api/tax/compare — sensitive inputs in JSON body)
  for (const c of concurrencyLevels) {
    const filename = `scenario2_compute_heavy_c${c}`;
    const res = await runBenchmark(`Scenario 2 (Compute-Heavy Tax Compare) - ${c} Connections`, filename, {
      path: '/api/tax/compare',
      method: 'POST',
      connections: c,
      body: {
        income: 1500000,
        incomeSource: 'salary',
        fiscalYear: 'FY2026-27',
        section80C: 150000,
        nps80CCD1B: 50000,
        section80D: 25000,
        age: 35,
        hra: 120000,
      },
    });
    summaryResults.push({
      scenario: 'Scenario 2 (Compute-Heavy Tax)',
      endpoint: 'POST /api/tax/compare',
      concurrency: c,
      p50: res.latency.p50,
      p95: res.latency.p95,
      p99: res.latency.p99,
      rps: res.requests.average,
      non2xx: res.non2xx,
      errors: res.errors,
      timeouts: res.timeouts,
      rawFile: `${filename}.json`,
    });
  }

  // Scenario 3: Agentic / LLM Path (POST /api/chat/message)
  for (const c of concurrencyLevels) {
    const filename = `scenario3_agentic_llm_c${c}`;
    const res = await runBenchmark(`Scenario 3 (Agentic LLM Chat) - ${c} Connections`, filename, {
      path: '/api/chat/message',
      method: 'POST',
      connections: c,
      body: {
        message: 'Explain how compound growth differs from simple interest without making a personalized recommendation.',
      },
    });
    summaryResults.push({
      scenario: 'Scenario 3 (Agentic LLM Chat)',
      endpoint: 'POST /api/chat/message',
      concurrency: c,
      p50: res.latency.p50,
      p95: res.latency.p95,
      p99: res.latency.p99,
      rps: res.requests.average,
      non2xx: res.non2xx,
      errors: res.errors,
      timeouts: res.timeouts,
      rawFile: `${filename}.json`,
    });
  }

  // Scenario 4: Stress / Ceilings Check (High Concurrency 200)
  const filenameStress = `scenario4_stress_c200`;
  const resStress = await runBenchmark(`Scenario 4 (Stress Ceiling Check) - 200 Connections`, filenameStress, {
    path: '/api/tax/compare',
    method: 'POST',
    connections: 200,
    body: {
      income: 2000000,
      incomeSource: 'salary',
      fiscalYear: 'FY2026-27',
      section80C: 150000,
      section80D: 50000,
      age: 35,
    },
  });
  summaryResults.push({
    scenario: 'Scenario 4 (Stress Ceiling)',
    endpoint: 'POST /api/tax/compare',
    concurrency: 200,
    p50: resStress.latency.p50,
    p95: resStress.latency.p95,
    p99: resStress.latency.p99,
    rps: resStress.requests.average,
    non2xx: resStress.non2xx,
    errors: resStress.errors,
    timeouts: resStress.timeouts,
    rawFile: `${filenameStress}.json`,
  });

  // Save summary manifest
  const summaryManifestPath = path.join(OUTPUT_DIR, 'loadtest_summary_manifest.json');
  fs.writeFileSync(summaryManifestPath, JSON.stringify(summaryResults, null, 2));

  console.log('\n================================================================');
  console.log('LOAD TEST COMPLETE — SUMMARY TABLE');
  console.log('================================================================');
  console.table(summaryResults.map(r => ({
    Scenario: r.scenario,
    Conc: r.concurrency,
    'p50 (ms)': r.p50,
    'p95 (ms)': r.p95,
    'p99 (ms)': r.p99,
    'RPS': r.rps.toFixed(1),
    'Non-2xx': r.non2xx,
    'Errors': r.errors,
    'Timeouts': r.timeouts,
  })));

  console.log(`\nSummary manifest saved to: ${summaryManifestPath}`);
}

main().catch(err => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
