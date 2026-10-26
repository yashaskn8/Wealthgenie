import { PAGE_ALLOWLIST } from './navigationMap';

/**
 * Voice output is a separate trust boundary from displaying chat text.
 * These helpers deliberately have no access to models, browser APIs, or tools.
 */
export const VOICE_INTENT_VERSION = 'sovereign-voice-intent-v1';
export const VOICE_CAPTURE_TIMEOUT_MS = 20_000;
export const VOICE_INTENT_TIMEOUT_MS = 10_000;
export const VOICE_REPLY_TIMEOUT_MS = 45_000;
export const VOICE_SPEECH_TIMEOUT_MS = 180_000;
export const MAX_VOICE_TRANSCRIPT_LENGTH = 1000;
export const MAX_VOICE_ANSWER_LENGTH = 2400;

const DISALLOWED_TRANSCRIPT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const normalizeIndicJoiners=text=>text.replace(/([\u0900-\u097F\u0C80-\u0CFF])[\u200C\u200D](?=[\u0900-\u097F\u0C80-\u0CFF])/gu,'$1');
const STOP_PHRASES = /^(?:stop listening|goodbye genie|end conversation|cancel voice mode|stop genie)[.!?]*$/i;
const EVIDENCE_IDENTIFIER = /^E_[A-Z0-9_:-]+$/;

export function validateVoiceTranscript(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_VOICE_TRANSCRIPT_LENGTH) return null;
  const normalized=normalizeIndicJoiners(raw);
  if (DISALLOWED_TRANSCRIPT_CHARACTERS.test(normalized)) return null;
  const text = normalized.trim();
  return text.length > 0 ? text : null;
}

export function isVoiceStopPhrase(transcript) {
  return STOP_PHRASES.test(transcript);
}

export function isAuthorizedVoiceNavigation(result) {
  return result?.version === VOICE_INTENT_VERSION &&
    result.action === 'APP_NAVIGATE' &&
    result.tab === null &&
    PAGE_ALLOWLIST.includes(result.page) &&
    result.page !== 'genieproof';
}

export function isVerifiedVoiceAnswer(answer) {
  if (!answer || answer.grounded !== true || answer.validation_status !== 'PASS') return false;
  const ids = answer.evidence_ids_used;
  const content = answer.content ?? answer.response;
  return typeof content === 'string' && content.trim().length > 0 &&
    Array.isArray(ids) && ids.length > 0 &&
    ids.every(id => typeof id === 'string' && EVIDENCE_IDENTIFIER.test(id) &&
      id !== 'E_CHAT_ANSWER_UNAVAILABLE');
}

export function voiceAnswerText(answer) {
  if (!isVerifiedVoiceAnswer(answer)) return null;
  const content = answer.content ?? answer.response;
  // Strip evidence markers and presentational Markdown without inventing or
  // summarizing any financial claim. Oversize answers are not truncated.
  const text = content.replace(/\[E_[A-Z0-9_:-]+\]/g, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|^#{1,6}\s+/gm, '')
    .trim();
  return text && text.length <= MAX_VOICE_ANSWER_LENGTH ? text : null;
}

export function selectBrowserVoice(voices) {
  if (!Array.isArray(voices)) return null;
  return voices.find(voice => voice?.lang?.toLowerCase() === 'en-in') ||
    voices.find(voice => voice?.lang?.toLowerCase().startsWith('en-')) ||
    null;
}
