/**
 * High-stakes speech transcription gate. Speech recognition can silently confuse
 * 15,000 with 50,000 or 5 with 50. A financial question with a numeric/quantified
 * input is NEVER auto-sent from hands-free mode without visible user review.
 *
 * A reviewed transcript is still just untrusted user input; no policy bypass.
 * This module is intentionally pure; it never grants actions or calls providers.
 */
// Kannada and Hindi orthography can contain joiners between two Indic codepoints.
// Normalize ONLY those, while rejecting hidden controls elsewhere.
const normalizeIndicJoiners = value => value.replace(
  /([\u0900-\u097F\u0C80-\u0CFF])[\u200C\u200D](?=[\u0900-\u097F\u0C80-\u0CFF])/gu,'$1');
const FINANCE_TOPIC = /(?:\b(?:sip|sips|invest(?:ment|ing)?|portfolio|retirement|college|goal|sav(?:e|ing|ings)|inflation|return|projection|project|forecast|finance|financial|tax|emi|loan|fund|deposit|interest|stocks?|bond|crash|risk|withdrawal|mutual)\b|निवेश|सिप|एसआईपी|रिटर्न|महँगाई|महंगाई|मुद्रास्फीति|जोखिम|कर\s+गणना|टैक्स|बचत|लक्ष्य|हूಡಿಕೆ|ಹೂಡಿಕೆ|ಸಿಪ್|ಎಸ್ಐಪಿ|ಹಣದುಬ್ಬರ|ಪೋರ್ಟ್‌?ಫೋಲಿಯೋ|ತೆರಿಗೆ|ಉಳಿತಾಯ|ಬಡ್ಡಿ|ನಿವೃತ್ತಿ)/iu;
const QUANTIFIED = /[\p{Nd}%₹]|\b(?:inr|rupees|rs|percent|percentage|hundred|thousand|lakh|lac|crore|million|billion|five|ten|twenty|thirty|fifty|hundreds|thousands|lakhs|crores)\b|(?:रुपये|प्रतिशत|हजार|लाख|करोड़|साल|रुपया|ರೂಪಾಯಿ|ಶೇಕಡಾ|ಲಕ್ಷ|ಕೋಟಿ|ವರ್ಷ)/iu;
const INVALID = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function needsFinancialTranscriptReview(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 1000) return false;
  const text = normalizeIndicJoiners(raw);
  if (INVALID.test(text)) return false;
  return FINANCE_TOPIC.test(text) && QUANTIFIED.test(text);
}
