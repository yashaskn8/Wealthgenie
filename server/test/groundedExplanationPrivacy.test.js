import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeExternalQuestion } from '../services/groundedExplanationService.js';

test('external explanation prompts redact Indian personal and financial identifiers', () => {
  const cases = [
    ['PAN ABCDE1234F', 'ABCDE1234F'],
    ['Aadhaar 1234 5678 9012', '1234 5678 9012'],
    ['Call me at +91 98765 43210', '98765 43210'],
    ['Bank account number: 123456789012', '123456789012'],
    ['UPI handle: prana@okaxis', 'prana@okaxis'],
    ['UPI PIN is 123456', '123456'],
  ];
  for (const [question, secret] of cases) {
    const sanitized = sanitizeExternalQuestion(question);
    assert.equal(sanitized.includes(secret), false, question);
    assert.match(sanitized, /\[[^\]]+ omitted\]/, question);
  }
});
