import http from 'http';
import autocannon from 'autocannon';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { compareTaxRegimes } from '../services/taxEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, '..', 'reports', 'loadtest');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function createBenchmarkApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', pid: process.pid });
  });

  app.post('/api/tax/compare', (req, res) => {
    const requestedIncome = Number(req.body.income);
    const income = Number.isFinite(requestedIncome) && requestedIncome >= 0 ? requestedIncome : 1500000;
    const comparison = compareTaxRegimes(
      income,
      { section80C: 150000, section80D: 50000, age: 35 },
      'salary',
      'FY2026-27',
    );
    res.json({
      income,
      comparison,
      pid: process.pid,
    });
  });

  return app;
}

async function runAutocannon(url, connections = 50, duration = 10, body) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        connections,
        duration,
        pipelining: 1,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
  });
}

async function runBenchmarkSuite() {
  console.log('================================================================');
  console.log('Distributed Systems: 1-Replica vs 2-Replica Load Benchmark');
  console.log('================================================================\n');

  // --- 1 REPLICA TEST ---
  console.log('>>> [1/2] Starting 1-Replica Benchmark (Port 5051)...');
  const app1 = createBenchmarkApp();
  const server1 = http.createServer(app1);
  await new Promise(r => server1.listen(5051, r));

  console.log('  Running 10s load test (50 connections) on 1 replica...');
  const res1_health = await runAutocannon('http://127.0.0.1:5051/health', 50, 10);
  const taxRequest = { income: 1500000 };
  const res1_compute = await runAutocannon('http://127.0.0.1:5051/api/tax/compare', 50, 10, taxRequest);
  await new Promise(r => server1.close(r));

  console.log(`  1-Replica Health:  ${res1_health.requests.average.toFixed(1)} req/s, p50=${res1_health.latency.p50}ms, p99=${res1_health.latency.p99}ms`);
  console.log(`  1-Replica Compute: ${res1_compute.requests.average.toFixed(1)} req/s, p50=${res1_compute.latency.p50}ms, p99=${res1_compute.latency.p99}ms`);

  // --- 2 REPLICAS TEST (Cluster / Multi-Worker) ---
  console.log('\n>>> [2/2] Starting 2-Replica Cluster Benchmark (Port 5052)...');

  const { fork } = await import('child_process');
  const workerScript = path.join(__dirname, 'worker_server.js');

  const workerCode = `
import http from 'http';
import express from 'express';
import { compareTaxRegimes } from '../services/taxEngine.js';

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', pid: process.pid }));
app.post('/api/tax/compare', (req, res) => {
  const requestedIncome = Number(req.body.income);
  const income = Number.isFinite(requestedIncome) && requestedIncome >= 0 ? requestedIncome : 1500000;
  const comparison = compareTaxRegimes(
    income,
    { section80C: 150000, section80D: 50000, age: 35 },
    'salary',
    'FY2026-27',
  );
  res.json({ income, comparison, pid: process.pid });
});

const port = process.env.PORT || 5052;
http.createServer(app).listen(port, () => console.log('Worker listening on ' + port));
`;
  fs.writeFileSync(workerScript, workerCode);

  const w1 = fork(workerScript, [], { env: { ...process.env, PORT: '5052' } });
  const w2 = fork(workerScript, [], { env: { ...process.env, PORT: '5053' } });

  let rr = 0;
  const proxyServer = http.createServer((req, clientRes) => {
    const targetPort = (rr++ % 2 === 0) ? 5052 : 5053;
    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    }, (targetRes) => {
      clientRes.writeHead(targetRes.statusCode, targetRes.headers);
      targetRes.pipe(clientRes, { end: true });
    });
    proxyReq.on('error', (err) => {
      clientRes.writeHead(502);
      clientRes.end(err.message);
    });
    req.pipe(proxyReq, { end: true });
  });

  await new Promise(r => setTimeout(r, 1500));
  await new Promise(r => proxyServer.listen(5054, r));

  console.log('  Running 10s load test (50 connections) across 2 load-balanced replicas...');
  const res2_health = await runAutocannon('http://127.0.0.1:5054/health', 50, 10);
  const res2_compute = await runAutocannon('http://127.0.0.1:5054/api/tax/compare', 50, 10, taxRequest);

  // Clean up
  await new Promise(r => proxyServer.close(r));
  w1.kill();
  w2.kill();
  if (fs.existsSync(workerScript)) fs.unlinkSync(workerScript);

  console.log(`  2-Replica Health:  ${res2_health.requests.average.toFixed(1)} req/s, p50=${res2_health.latency.p50}ms, p99=${res2_health.latency.p99}ms`);
  console.log(`  2-Replica Compute: ${res2_compute.requests.average.toFixed(1)} req/s, p50=${res2_compute.latency.p50}ms, p99=${res2_compute.latency.p99}ms`);

  const report = {
    timestamp: new Date().toISOString(),
    concurrency: 50,
    durationSeconds: 10,
    singleReplica: {
      health: {
        throughputReqSec: res1_health.requests.average,
        p50LatencyMs: res1_health.latency.p50,
        p95LatencyMs: res1_health.latency.p95,
        p99LatencyMs: res1_health.latency.p99,
        non2xx: res1_health.non2xx,
        errors: res1_health.errors,
      },
      taxCompute: {
        throughputReqSec: res1_compute.requests.average,
        p50LatencyMs: res1_compute.latency.p50,
        p95LatencyMs: res1_compute.latency.p95,
        p99LatencyMs: res1_compute.latency.p99,
        non2xx: res1_compute.non2xx,
        errors: res1_compute.errors,
      },
    },
    twoReplicas: {
      health: {
        throughputReqSec: res2_health.requests.average,
        p50LatencyMs: res2_health.latency.p50,
        p95LatencyMs: res2_health.latency.p95,
        p99LatencyMs: res2_health.latency.p99,
        non2xx: res2_health.non2xx,
        errors: res2_health.errors,
      },
      taxCompute: {
        throughputReqSec: res2_compute.requests.average,
        p50LatencyMs: res2_compute.latency.p50,
        p95LatencyMs: res2_compute.latency.p95,
        p99LatencyMs: res2_compute.latency.p99,
        non2xx: res2_compute.non2xx,
        errors: res2_compute.errors,
      },
    },
    findings: {
      computeScalingFactor: (res2_compute.requests.average / res1_compute.requests.average).toFixed(2) + 'x',
      healthScalingFactor: (res2_health.requests.average / res1_health.requests.average).toFixed(2) + 'x',
      errorRate1Replica: (res1_compute.non2xx / (res1_compute.requests.total || 1) * 100).toFixed(2) + '%',
      errorRate2Replicas: (res2_compute.non2xx / (res2_compute.requests.total || 1) * 100).toFixed(2) + '%',
    },
  };

  const reportPath = path.join(OUTPUT_DIR, 'replica_scaling_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n>>> Benchmark complete! Saved raw JSON report to ${reportPath}`);
  console.log(`Compute Scaling Factor: ${report.findings.computeScalingFactor}`);
  console.log(`Health Scaling Factor: ${report.findings.healthScalingFactor}`);
}

runBenchmarkSuite().catch(console.error);
