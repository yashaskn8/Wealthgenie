import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = name => fileURLToPath(new URL('../scripts/' + name, import.meta.url));
const stdout = (name, args = []) => execFileSync(process.execPath, [script(name), ...args], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
test('catalog audit CLI emits pure parseable JSON and CSV without npm output banners', () => {
  const json = stdout('auditCatalog250Verification.js');
  assert.ok(json.startsWith('{'));
  const report = JSON.parse(json);
  assert.equal(report.totalFamilies, 250);
  assert.equal(report.families.length, 250);
  assert.equal(report.reviewSlotsChecked, 750);
  assert.equal(report.productionQualifiedFamilies, 'NOT_MEASURED');
  assert.equal(report.basis, 'REPOSITORY_SOURCE_FILES_ONLY_NOT_LIVE_PROVIDER_OR_PRODUCTION_DB');
  const csv = stdout('auditCatalog250Verification.js', ['--csv']);
  assert.ok(csv.startsWith('familyId,'));
  assert.equal(csv.trimEnd().split('\n').length, 251);
});
test('top-three review queue CLI emits only CSV with 750 unapproved slots', () => {
  const csv = stdout('generateFinancialTopThreeEvidenceQueue.js');
  assert.ok(csv.startsWith('familyId,'));
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, 751);
  assert.ok(lines.slice(1).every(line => line.endsWith('"ACTUAL_PRODUCT_EVIDENCE_REQUIRED"')));
});
test('CI redirects raw node CLI output, not npm banner text, to machine-readable artifacts', () => {
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const invocation of [
    'node server/scripts/auditCatalog250Verification.js > financial-catalog-250-verification.json',
    'node server/scripts/auditCatalog250Verification.js --csv > financial-catalog-250-verification.csv',
    'node server/scripts/auditFinancialTopThreeCoverage.js > financial-top3-coverage.json',
    'node server/scripts/generateFinancialTopThreeEvidenceQueue.js > financial-top3-review-queue.csv',
  ]) assert.ok(ci.includes(invocation), invocation);
  assert.ok(ci.includes('Validate financial audit artifacts are clean machine-readable outputs'));
});
