import assert from 'node:assert/strict';
import test from 'node:test';
import {
  genieProofCreateCaseSchema,
  genieProofExtractSchema,
} from '../agents/genieProof/genieProofSchemas.js';

const confirmedClaims = [{
  claimId: 'a'.repeat(32),
  statement: 'The current official PPF interest rate is 7.1% p.a.',
  claimType: 'CURRENT_NOMINAL_RATE',
  productId: 'government:india-post:ppf',
  value: 7.1,
  unit: 'PERCENT_PER_ANNUM',
}];

function validate(schema, offerText) {
  const value = schema === genieProofExtractSchema
    ? { offerText }
    : { offerText, submissionHash: 'b'.repeat(64), savingConsent: true, confirmedClaims };
  return schema.validate(value, { abortEarly: false });
}

test('GenieProof request schemas enforce the same UTF-8 byte limit as claim extraction', () => {
  for (const schema of [genieProofExtractSchema, genieProofCreateCaseSchema]) {
    assert.equal(validate(schema, 'é'.repeat(8_000)).error, undefined, 'exactly 16,000 UTF-8 bytes are accepted');
    assert.equal(validate(schema, 'x'.repeat(16_000)).error, undefined, 'the existing ASCII boundary remains accepted');
    assert.equal(validate(schema, 'é'.repeat(8_001)).error?.details[0].type, 'string.maxUtf8Bytes');
  }
});
