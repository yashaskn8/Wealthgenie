import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenieProofClaimPreview, getGenieProofCapabilityStatus, isGenieProofLocalResearchRequest } from '../routes/genieProofRoutes.js';

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
  assert.equal(getGenieProofCapabilityStatus({
    enabled: true, productionActivationAllowed: false,
  }, { localResearchRequest: false }).reasonCode, 'GENIEPROOF_LOCAL_REQUEST_REQUIRED');
});

test('signed research requests require a direct loopback peer and loopback Host', () => {
  const request = (remoteAddress, host = '127.0.0.1:5000', extraHeaders = {}) => ({
    socket: { remoteAddress }, headers: { host, ...extraHeaders },
  });
  assert.equal(isGenieProofLocalResearchRequest(request('127.0.0.1')), true);
  assert.equal(isGenieProofLocalResearchRequest(request('::1', '[::1]:5000')), true);
  assert.equal(isGenieProofLocalResearchRequest(request('::ffff:127.0.0.1', 'localhost:5000')), true);
  assert.equal(isGenieProofLocalResearchRequest(request('192.168.1.10')), false);
  assert.equal(isGenieProofLocalResearchRequest(request('127.0.0.1', 'wealthgenie.example')), false);
  assert.equal(isGenieProofLocalResearchRequest(request('127.0.0.1', 'localhost:5000', { 'x-forwarded-for': '192.168.1.10' })), false);
  assert.equal(isGenieProofLocalResearchRequest(request('127.0.0.1', 'localhost:5000', { forwarded: 'for=192.168.1.10' })), false);
  assert.equal(isGenieProofLocalResearchRequest(request('127.0.0.1', 'localhost:5000', { 'x-real-ip': '192.168.1.10' })), false);
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

test('GenieProof reason codes distinguish setup failures without leaking signing keys', () => {
  const accepted = [
    'GENIEPROOF_LOCAL_RESEARCH_ONLY',
    'GENIEPROOF_FLAG_DISABLED',
    'GENIEPROOF_SIGNING_KEYS_MISSING',
    'GENIEPROOF_SIGNING_CONFIGURATION_INVALID',
  ];
  for (const code of accepted) {
    const result = getGenieProofCapabilityStatus({
      enabled: false, productionActivationAllowed: false, reasonCode: code,
      signer: { privateKey: 'SECRET_PRIVATE_KEY_EXAMPLE' },
    });
    assert.deepEqual(result, {
      interactiveEnabled: false,
      extractionPreviewEnabled: true,
      mode: 'UNAVAILABLE',
      reasonCode: code,
      productionVerified: false,
    });
    assert.ok(!JSON.stringify(result).includes('SECRET_PRIVATE_KEY_EXAMPLE'));
  }
  assert.equal(getGenieProofCapabilityStatus({
    enabled: false, reasonCode: 'PRIVATE_PEM_CONTENT_SHOULD_NOT_LEAK',
  }).reasonCode, 'FEATURE_UNAVAILABLE');
});
