import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenieProofClaimPreview, getGenieProofCapabilityStatus } from '../routes/genieProofRoutes.js';

test('GenieProof capability report is unavailable without an enabled backend', () => {
  assert.deepEqual(getGenieProofCapabilityStatus(null), {
    interactiveEnabled: false,
    extractionPreviewEnabled: true,
    mode: 'UNAVAILABLE',
    reasonCode: 'FEATURE_UNAVAILABLE',
    productionVerified: false,
  });
  assert.equal(getGenieProofCapabilityStatus({ enabled: false }).interactiveEnabled, false);
});

test('GenieProof report permits only an explicit local research runtime and no production verification claim', () => {
  const result = getGenieProofCapabilityStatus({
    enabled: true,
    productionActivationAllowed: false,
    signer: { privateKey: 'SECRET_MUST_NOT_LEAK' },
  });
  assert.deepEqual(result, {
    interactiveEnabled: true,
    extractionPreviewEnabled: true,
    mode: 'LOCAL_RESEARCH',
    reasonCode: 'RESEARCH_ONLY_SOURCE_RIGHTS_NOT_QUALIFIED',
    productionVerified: false,
  });
  assert.equal(JSON.stringify(result).includes('SECRET_MUST_NOT_LEAK'), false);
  assert.equal(getGenieProofCapabilityStatus({
    enabled: true, productionActivationAllowed: true,
  }).interactiveEnabled, false);
});

test('production-safe claim extraction contains only unsaved candidate classification, not evidence verdicts', () => {
  const review = buildGenieProofClaimPreview('The current official PPF interest rate is 7.1% p.a.');
  assert.equal(review.previewOnly, true);
  assert.equal(review.status, 'CANDIDATES_ONLY');
  assert.equal(review.sourceEvidenceChecked, false);
  assert.equal(review.signedPassportCreated, false);
  assert.equal(review.rawOfferRetained, false);
  assert.equal(review.claims[0].claimType, 'CURRENT_NOMINAL_RATE');
  assert.equal(Object.hasOwn(review, 'verdict'), false);
  assert.equal(Object.hasOwn(review, 'passport'), false);
  assert.equal(Object.hasOwn(review, 'evidence'), false);
});

test('preview rejects oversized text and never promotes unsupported statements to verified claims', () => {
  assert.equal(buildGenieProofClaimPreview('x'.repeat(16_001)).code, 'OFFER_TEXT_TOO_LARGE');
  const review = buildGenieProofClaimPreview('PPF guarantees a 7.1% p.a. return.');
  assert.equal(review.claims[0].claimType, 'UNSUPPORTED');
  assert.equal(review.sourceEvidenceChecked, false);
  assert.equal(review.signedPassportCreated, false);
});
