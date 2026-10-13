import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPostTaxCoverageMatrix } from '../services/postTaxCoverageMatrix.js';

const outputPath = fileURLToPath(new URL('../data/postTaxCoverageMatrix.json', import.meta.url));
const expected = `${JSON.stringify(buildPostTaxCoverageMatrix(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let actual;
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch {
    process.stderr.write('Post-tax coverage matrix is missing; run node scripts/exportPostTaxCoverageMatrix.js.\n');
    process.exitCode = 1;
  }
  if (actual !== undefined && actual !== expected) {
    process.stderr.write('Post-tax coverage matrix is stale; regenerate it from the current catalog and provider registry.\n');
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) process.stdout.write('Post-tax coverage matrix matches the current catalog and provider registry.\n');
} else {
  writeFileSync(outputPath, expected, 'utf8');
  process.stdout.write(`Wrote ${buildPostTaxCoverageMatrix().catalog.instrumentCount} catalog rows to ${outputPath}\n`);
}
