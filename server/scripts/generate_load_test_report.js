import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'loadtest');
const REPORT_OUTPUT_PATH = path.join(REPORTS_DIR, 'load_test_report.json');

function parseScenarioFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const latency = data.latency ?? {};
  const requests = data.requests ?? {};

  return {
    sourceFile: path.basename(filePath),
    connections: data.connections ?? null,
    duration: data.duration ?? null,
    totalRequests: requests.total ?? null,
    requestsPerSecond: requests.average ?? null,
    latencyMs: {
      p50: latency.p50 ?? latency.mean ?? null,
      p95: latency.p95 ?? latency.p97_5 ?? latency.p90 ?? null,
      p99: latency.p99 ?? null,
    },
    errors: data.errors ?? 0,
    timeouts: data.timeouts ?? 0,
    non2xx: data.non2xx ?? 0,
    statusCodes: data.statusCodeStats ?? {},
  };
}

function generateReport(postPatchData = null) {
  const files = [
    { scenario: 'Read-heavy: GET /api/instruments', file: 'scenario1_read_heavy_c10.json', concurrency: 10, runMode: 'Initial Run' },
    { scenario: 'Read-heavy: GET /api/instruments', file: 'scenario1_read_heavy_c50.json', concurrency: 50, runMode: 'Initial Run (Cold-Start Artifact)' },
    { scenario: 'Read-heavy: GET /api/instruments', file: 'scenario1_read_heavy_c100.json', concurrency: 100, runMode: 'Initial Run' },
    { scenario: 'Historical GET /api/tax/compare benchmark', file: 'scenario2_compute_heavy_c10.json', concurrency: 10, runMode: 'Steady State' },
    { scenario: 'Historical GET /api/tax/compare benchmark', file: 'scenario2_compute_heavy_c50.json', concurrency: 50, runMode: 'Steady State' },
    { scenario: 'Historical GET /api/tax/compare benchmark', file: 'scenario2_compute_heavy_c100.json', concurrency: 100, runMode: 'Steady State' },
    { scenario: 'Agentic chat: POST /api/chat/message', file: 'scenario3_agentic_llm_c10.json', concurrency: 10, runMode: 'Pre-patch' },
    { scenario: 'Agentic chat: POST /api/chat/message', file: 'scenario3_agentic_llm_c50.json', concurrency: 50, runMode: 'Pre-patch' },
    { scenario: 'Agentic chat: POST /api/chat/message', file: 'scenario3_agentic_llm_c100.json', concurrency: 100, runMode: 'Pre-patch' },
    { scenario: 'Historical GET /api/tax/compare stress benchmark', file: 'scenario4_stress_c200.json', concurrency: 200, runMode: 'Steady State' },
  ];

  const scenarios = files.flatMap(item => {
    const measurements = parseScenarioFile(path.join(REPORTS_DIR, item.file));
    if (!measurements) return [];

    const totalFailures = measurements.errors + measurements.timeouts + measurements.non2xx;
    return [{
      scenario: item.scenario,
      configuredConcurrency: item.concurrency,
      runMode: item.runMode,
      measurements,
      totalFailures,
      errorRatePercent: measurements.totalRequests > 0
        ? Number(((totalFailures / measurements.totalRequests) * 100).toFixed(2))
        : null,
    }];
  });

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'autocannon scenario JSON files',
    historicalBenchmarkArchive: 'historical_benchmarks.json',
    missingSourceFiles: files.map(item => item.file).filter(file => !fs.existsSync(path.join(REPORTS_DIR, file))),
    scenarios,
    postPatchResults: Array.isArray(postPatchData) ? postPatchData : [],
  };

  fs.writeFileSync(REPORT_OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`Generated ${REPORT_OUTPUT_PATH}`);
}

generateReport();
