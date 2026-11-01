#!/usr/bin/env node
/**
 * Local release candidate gate. Reads an independently reviewed aggregate
 * JSON report from a private path. Does not collect speech, access the network
 * or write a recording/transcript. Passing schema checks are NOT a substitute
 * for confirming the referenced real-device results and human signoffs.
 */
import { readFile } from 'node:fs/promises';
import { assessGenieVoiceReleaseEvidence } from '../services/genieVoiceReleaseEvidence.js';

const file = process.argv[2];
const expectedSha = process.argv[3] || process.env.GITHUB_SHA;
if (!file || !expectedSha) {
  console.error('Usage: node scripts/qualifyGenieVoiceRelease.js <private-aggregate-report.json> <deployment-commit-sha>');
  process.exitCode = 2;
} else {
  try {
    const bytes = await readFile(file, 'utf8');
    if (bytes.length > 65536) throw new Error('Oversized report');
    const report = JSON.parse(bytes);
    const result = assessGenieVoiceReleaseEvidence(report, expectedSha);
    // Only static blocker codes, never transcript, audio or financial details.
    console.log(JSON.stringify(result));
    if (!result.eligible) process.exitCode = 1;
  } catch {
    console.error('GenieVoice release evidence could not be parsed or read.');
    process.exitCode = 2;
  }
}
