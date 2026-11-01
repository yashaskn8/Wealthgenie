import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessGenieVoiceReleaseEvidence, VOICE_RELEASE_EVIDENCE_SCHEMA
} from '../services/genieVoiceReleaseEvidence.js';

// Deliberately synthetic aggregates. These are unit-test fixtures and must
// never be represented as user recordings, a certification or a sign-off.
const COMMIT = 'a'.repeat(40);
function example() {
  return {
    schemaVersion: VOICE_RELEASE_EVIDENCE_SCHEMA,
    commitSha: COMMIT, deploymentSha: COMMIT,
    locales: ['en-IN', 'hi-IN', 'kn-IN'].map(locale => ({
      locale, samples: 200, speakers: 10, numericTurns: 60,
      financialSlotsAudited: 60, financialSlotErrors: 0
    })),
    devices: ['android-chrome', 'ios-safari', 'desktop-chrome'].map(device => ({
      device, sessions: 10
    })),
    security: {
      unauthorizedActions: 0, wrongAccountNarrations: 0,
      unverifiedFinancialNarrations: 0, unreviewedNumericSubmissions: 0,
      financialMutations: 0, recordingsWithoutConsent: 0
    },
    latencyP95Ms: {
      speechToCaption: 2000, turnToVerifiedAnswer: 4000,
      verifiedAnswerToAudio: 1000
    },
    reviews: {
      explicitConsentVerified: true, providerRetentionReviewed: true,
      deletionVerified: true, privacyReviewApproved: true,
      realDeviceKeyboardPassed: true, screenReaderPassed: true,
      mobileFallbackPassed: true, reducedMotionPassed: true,
      killSwitchDrillPassed: true, rollbackDrillPassed: true,
      stagingSmokePassed: true, independentSecurityReviewApproved: true
    },
    artifacts: {
      consentAuditUrl: 'https://audit.example/consent',
      privacyReviewUrl: 'https://audit.example/privacy',
      accessibilityReviewUrl: 'https://audit.example/accessibility',
      latencyBenchmarkUrl: 'https://audit.example/latency',
      stagingSmokeUrl: 'https://audit.example/staging'
    }
  };
}
const check = (report, sha = COMMIT) => assessGenieVoiceReleaseEvidence(report, sha);

describe('GenieVoice release evidence rejects unverifiable certification', () => {
  it('accepts a structurally complete synthetic fixture without treating it as real data', () => {
    assert.deepEqual(check(example()), { eligible: true, blockers: [] });
  });
  it('fails closed on missing, extra or mismatched source/commit data', () => {
    assert.equal(check(null).eligible, false);
    assert.ok(check({ ...example(), rawTranscript: 'private' }).blockers
      .includes('INVALID_REPORT_SHAPE'));
    assert.ok(check(example(), 'b'.repeat(40)).blockers.includes('WRONG_COMMIT'));
    assert.ok(check({ ...example(), deploymentSha: 'b'.repeat(40) }).blockers
      .includes('DEPLOYMENT_NOT_BOUND_TO_COMMIT'));
  });
  it('requires real multilingual sample coverage and unique locale reports', () => {
    const missing = example();
    missing.locales.pop();
    assert.equal(check(missing).eligible, false);
    const duplicate = example();
    duplicate.locales[1].locale = 'en-IN';
    assert.equal(check(duplicate).eligible, false);
    const weak = example();
    weak.locales[2].numericTurns = 0;
    weak.locales[0].financialSlotErrors = 5;
    assert.ok(check(weak).blockers.includes('INSUFFICIENT_NUMERIC_SAMPLE_kn-IN'));
    assert.ok(check(weak).blockers.includes('FINANCIAL_SLOT_QUALITY_en-IN'));
  });
  it('blocks unintended financial actions, privacy failures and release drills', () => {
    const bad = example();
    bad.security.unreviewedNumericSubmissions = 1;
    bad.security.wrongAccountNarrations = 1;
    bad.reviews.providerRetentionReviewed = false;
    bad.reviews.rollbackDrillPassed = false;
    const result = check(bad);
    assert.ok(result.blockers.includes('VOICE_SECURITY_REGRESSION'));
    assert.ok(result.blockers.includes('REQUIRED_INDEPENDENT_REVIEWS_MISSING'));
    assert.equal(result.eligible, false);
  });
  it('requires positive bounded p95 measurements and approved evidence links', () => {
    const slow = example();
    slow.latencyP95Ms.turnToVerifiedAnswer = 10000;
    slow.artifacts.privacyReviewUrl = 'file:///private/report';
    assert.ok(check(slow).blockers.includes('LATENCY_BUDGET_EXCEEDED'));
    assert.ok(check(slow).blockers.includes('SOURCE_ARTIFACTS_MISSING'));
  });
  it('does not accept unknown raw account or audio fields at any declared level', () => {
    const extra = example();
    extra.locales[0].rawAudio = 'private';
    extra.security.accountId = 'private';
    assert.ok(check(extra).blockers.includes('LOCALE_DATA_INVALID'));
    assert.ok(check(extra).blockers.includes('VOICE_SECURITY_REGRESSION'));
  });
});
