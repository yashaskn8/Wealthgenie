/**
 * GenieVoice evidence-completeness gate. This NEVER certifies a deployment:
 * human reviewers must validate the provenance of the aggregated field data.
 * No raw audio, transcripts, financial profiles or account identifiers belong
 * in this release manifest. Keep all voice task feature flags OFF until signoff.
 */
export const VOICE_RELEASE_EVIDENCE_SCHEMA = 'genievoice-release-evidence-v1';
const LOCALES = ['en-IN', 'hi-IN', 'kn-IN'];
const DEVICES = ['android-chrome', 'ios-safari', 'desktop-chrome'];
const SECURITY_COUNTERS = [
  'unauthorizedActions', 'wrongAccountNarrations', 'unverifiedFinancialNarrations',
  'unreviewedNumericSubmissions', 'financialMutations', 'recordingsWithoutConsent'
];
const REVIEWS = [
  'explicitConsentVerified', 'providerRetentionReviewed', 'deletionVerified',
  'privacyReviewApproved', 'realDeviceKeyboardPassed', 'screenReaderPassed',
  'mobileFallbackPassed', 'reducedMotionPassed', 'killSwitchDrillPassed',
  'rollbackDrillPassed', 'stagingSmokePassed', 'independentSecurityReviewApproved'
];
const ARTIFACTS = [
  'consentAuditUrl', 'privacyReviewUrl', 'accessibilityReviewUrl',
  'latencyBenchmarkUrl', 'stagingSmokeUrl'
];
const isRecord = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const hasOnlyKeys = (value, permitted) => isRecord(value) &&
  Object.keys(value).every(key => permitted.includes(key));
const trustedEvidenceLink = value => typeof value === 'string' &&
  /^https:\/\/[^\s/?#]+\.[^\s/?#]+\/[^\s]+$/i.test(value) && value.length <= 2048;

/**
 * Evaluate aggregate evidence with explicit, conservative early-release
 * thresholds. A passing synthetic fixture is not field evidence. Source
 * authenticity, consent and sign-offs must be independently reviewed.
 */
export function assessGenieVoiceReleaseEvidence(report, expectedCommitSha) {
  const blockers = [];
  const reject = (condition, code) => { if (!condition) blockers.push(code); };
  if (!hasOnlyKeys(report, [
    'schemaVersion', 'commitSha', 'deploymentSha', 'locales', 'devices',
    'security', 'latencyP95Ms', 'reviews', 'artifacts'
  ])) return { eligible: false, blockers: ['INVALID_REPORT_SHAPE'] };

  reject(report.schemaVersion === VOICE_RELEASE_EVIDENCE_SCHEMA, 'INVALID_SCHEMA_VERSION');
  reject(sha(report.commitSha) && (!expectedCommitSha ||
    report.commitSha === expectedCommitSha), 'WRONG_COMMIT');
  reject(sha(report.deploymentSha) && report.deploymentSha === report.commitSha,
    'DEPLOYMENT_NOT_BOUND_TO_COMMIT');

  reject(Array.isArray(report.locales) && report.locales.length === LOCALES.length &&
    report.locales.every(x => hasOnlyKeys(x, [
      'locale', 'samples', 'speakers', 'numericTurns', 'financialSlotErrors',
      'financialSlotsAudited'
    ])), 'LOCALE_DATA_INVALID');
  for (const locale of LOCALES) {
    const matches = Array.isArray(report.locales)
      ? report.locales.filter(x => x?.locale === locale) : [];
    reject(matches.length === 1, 'MISSING_OR_DUPLICATE_LOCALE_' + locale);
    const item = matches[0];
    if (!item) continue;
    reject(whole(item.samples) && item.samples >= 200 &&
      whole(item.speakers) && item.speakers >= 10, 'INSUFFICIENT_SPEECH_SAMPLE_' + locale);
    reject(whole(item.numericTurns) && item.numericTurns >= 50 &&
      item.numericTurns <= item.samples, 'INSUFFICIENT_NUMERIC_SAMPLE_' + locale);
    reject(whole(item.financialSlotsAudited) && item.financialSlotsAudited >= 50 &&
      whole(item.financialSlotErrors) &&
      item.financialSlotErrors <= item.financialSlotsAudited &&
      item.financialSlotErrors / item.financialSlotsAudited <= 0.05,
    'FINANCIAL_SLOT_QUALITY_' + locale);
  }
  reject(Array.isArray(report.devices) && report.devices.length === DEVICES.length &&
    report.devices.every(x => hasOnlyKeys(x, ['device', 'sessions'])),
  'DEVICE_DATA_INVALID');
  for (const device of DEVICES) {
    const matches = Array.isArray(report.devices)
      ? report.devices.filter(x => x?.device === device) : [];
    reject(matches.length === 1 && whole(matches[0]?.sessions) &&
      matches[0].sessions >= 10, 'DEVICE_COVERAGE_' + device);
  }

  reject(hasOnlyKeys(report.security, SECURITY_COUNTERS) &&
    SECURITY_COUNTERS.every(key => report.security[key] === 0),
  'VOICE_SECURITY_REGRESSION');

  // These are launch-candidate targets, not claims about measured performance.
  reject(hasOnlyKeys(report.latencyP95Ms, [
    'speechToCaption', 'turnToVerifiedAnswer', 'verifiedAnswerToAudio'
  ]) && positive(report.latencyP95Ms.speechToCaption) &&
    report.latencyP95Ms.speechToCaption <= 3000 &&
    positive(report.latencyP95Ms.turnToVerifiedAnswer) &&
    report.latencyP95Ms.turnToVerifiedAnswer <= 8000 &&
    positive(report.latencyP95Ms.verifiedAnswerToAudio) &&
    report.latencyP95Ms.verifiedAnswerToAudio <= 2500, 'LATENCY_BUDGET_EXCEEDED');

  reject(hasOnlyKeys(report.reviews, REVIEWS) &&
    REVIEWS.every(key => report.reviews[key] === true),
  'REQUIRED_INDEPENDENT_REVIEWS_MISSING');
  reject(hasOnlyKeys(report.artifacts, ARTIFACTS) &&
    ARTIFACTS.every(key => trustedEvidenceLink(report.artifacts[key])),
  'SOURCE_ARTIFACTS_MISSING');
  return { eligible: blockers.length === 0, blockers };
}
