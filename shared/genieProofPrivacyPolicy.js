/**
 * Shared privacy denial gate for public GenieProof inputs.
 *
 * This is intentionally conservative: a financial rate may be verified
 * without transmitting identifiers. Never echo a matched identifier.
 * Obfuscation normalization is used ONLY for detection, not to rewrite user
 * financial claims or turn raw content into a verified source.
 *
 * This is a high-signal filter, not a universal PII classifier. Users must
 * still mask names, addresses, medical data and other private information.
 */
function forDetection(value) {
  return value.normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0966-\u096F\u0CE6-\u0CEF]/g, digit => {
      const code = digit.charCodeAt(0);
      return String(code >= 0x0CE6 ? code - 0x0CE6 : code - 0x0966);
    });
}

const PATTERNS = Object.freeze([
  // PAN, including commonly pasted groups such as ABCDE 1234 F.
  /\b[A-Z]{5}[ .-]?\d{4}[ .-]?[A-Z]\b/i,
  // Aadhaar: formatted 4-4-4, labelled unformatted, or unlabelled 12 digits.
  /\b\d{4}[ -]\d{4}[ -]\d{4}\b/,
  /\b\d{12}\b/,
  // Longer unlabelled account/card-like identifiers.
  /\b\d{13,19}\b/,
  // Labelled account references with common punctuation and grouping.
  /\b(?:bank\s*)?(?:account|acct|a\/c)\s*(?:(?:number|no\.?|id|#)\s*)?[:#-]?\s*(?:\d[ .-]?){9,18}\b/i,
  // Personal contact details, including a labelled Indian phone number.
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b[A-Z0-9._-]{2,}@(upi|okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|axl)\b/i,
  /\b(?:mobile|phone|contact|whatsapp|cell)(?:\s+(?:number|no\.?))?\s*[:#-]?\s*(?:\+?91[ -]?)?[6-9]\d{9}\b/i,
  /(?:^|\s)\+91[ -]?[6-9]\d{9}\b/,
]);

export function containsGenieProofSensitiveIdentifiers(text) {
  if (typeof text !== 'string' || !text) return false;
  const candidate = forDetection(text);
  return PATTERNS.some(pattern => pattern.test(candidate));
}
