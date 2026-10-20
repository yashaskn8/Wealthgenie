import assert from 'node:assert/strict';
import test from 'node:test';
import { getGenieProofCapabilityStatus } from '../routes/genieProofRoutes.js';

test('GenieProof capability report is unavailable without an enabled backend', () => {
  assert.deepEqual(getGenieProofCapabilityStatus(null), {
    interactiveEnabled: false,
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
    mode: 'LOCAL_RESEARCH',
    reasonCode: 'RESEARCH_ONLY_SOURCE_RIGHTS_NOT_QUALIFIED',
    productionVerified: false,
  });
  assert.equal(JSON.stringify(result).includes('SECRET_MUST_NOT_LEAK'), false);
  assert.equal(getGenieProofCapabilityStatus({
    enabled: true, productionActivationAllowed: true,
  }).interactiveEnabled, false);
});
