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
// Do not rely on a small English-number dictionary for Indian ASR. For
// example, "seventy" and "forty" are financially material even without digits.
const QUANTIFIED = /[\p{Nd}%₹$€£]|\b(?:inr|rupees?|rs|percent|percentage|double|twice|triple|half|halve|halved|halving|quarter|third|thirds|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|lakhs?|lacs?|crores?|millions?|billions?)\b|(?:रुपये|प्रतिशत|हजार|लाख|करोड़|साल|रुपया|दस|बीस|तीस|चालीस|पचास|साठ|सत्तर|अस्सी|नब्बे|सौ|ಹತ್ತು|ಇಪ್ಪತ್ತು|ಮೂವತ್ತು|ನಲವತ್ತು|ಐವತ್ತು|ಅರವತ್ತು|ಎಪ್ಪತ್ತು|ಎಂಭತ್ತು|ತೊಂಬತ್ತು|ನೂರು|ಸಾವಿರ|ರೂಪಾಯಿ|ಶೇಕಡಾ|ಲಕ್ಷ|ಕೋಟಿ|ವರ್ಷ)/iu;
// An otherwise unknown finance term must never exempt an explicit ASR number,
// currency or percentage from review in a financial assistant.
const EXPLICIT_VALUE = /[\p{Nd}%₹$€£]/u;
const MONETARY_UNIT = /\b(?:inr|rupees?|rs|lakhs?|lacs?|crores?|millions?|billions?)\b|(?:रुपये|रुपया|लाख|करोड़|ರೂಪಾಯಿ|ಲಕ್ಷ|ಕೋಟಿ)/iu;

// Hindi has irregular spoken number words; Kannada composes numbers from
// tens stems. Recognized quantities without numerals or currency symbols
// must still require review. Unicode boundaries avoid matching substrings
// inside ordinary words (for example, Hindi "दोस्त").
const INDIC_SPOKEN_NUMBER = /(?:^|[^\p{L}\p{M}])(?:शून्य|जीरो|एक|दो|तीन|चार|पाँच|पांच|छह|छः|सात|आठ|नौ|ग्यारह|बारह|तेरह|चौदह|पंद्रह|पन्द्रह|सोलह|सत्रह|अठारह|उन्नीस|इक्कीस|बाईस|तेईस|चौबीस|पच्चीस|छब्बीस|सत्ताईस|अट्ठाईस|उनतीस|छत्तीस|छप्पन|सत्तावन|ಶೂನ್ಯ|ಒಂದು|ಎರಡು|ಮೂರು|ನಾಲ್ಕು|ಐದು|ಆರು|ಏಳು|ಎಂಟು|ಒಂಬತ್ತು|ಹನ್ನೊಂದು|ಹನ್ನೆರಡು|ಹದಿಮೂರು|ಹದಿನಾಲ್ಕು|ಹದಿನೈದು|ಹದಿನಾರು|ಹದಿನೇಳು|ಹದಿನೆಂಟು|ಹತ್ತೊಂಬತ್ತು|(?:ಇಪ್ಪತ್ತ|ಮೂವತ್ತ|ನಲವತ್ತ|ಐವತ್ತ|ಅರವತ್ತ|ಎಪ್ಪತ್ತ|ಎಂಭತ್ತ|ತೊಂಬತ್ತ)[\p{L}\p{M}]*)(?![\p{L}\p{M}])/iu;
// Common Hindi 31–99 numbers are irregular; tens stems alone can miss them.
// Match complete Devanagari words so ordinary substrings never trigger review.
const HINDI_SPOKEN_31_TO_99 = new Set(`
  इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस
  इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास
  इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ
  इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर
  इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी
  इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी
  इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे
`.trim().split(/\s+/u));
const hasHindiSpokenNumber = text =>
  (text.match(/[\p{L}\p{M}]+/gu) || []).some(word => HINDI_SPOKEN_31_TO_99.has(word));
const INVALID = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export function needsFinancialTranscriptReview(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 1000) return false;
  const text = normalizeIndicJoiners(raw);
  if (INVALID.test(text)) return false;
  // In a financial assistant an uncategorized spoken quantity can still be
  // a salary, debt, tenure, insurance premium or projected return. Fail closed
  // for ALL recognized numbers; keyword classification is not a safety gate.
  return EXPLICIT_VALUE.test(text) || MONETARY_UNIT.test(text) ||
    QUANTIFIED.test(text) || INDIC_SPOKEN_NUMBER.test(text) ||
    hasHindiSpokenNumber(text);
}
