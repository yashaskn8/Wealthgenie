import { PAGE_ALLOWLIST } from './navigationMap';

/**
 * Voice output is a separate trust boundary from displaying chat text.
 * These helpers deliberately have no access to models, browser APIs, or tools.
 */
export const VOICE_INTENT_VERSION = 'sovereign-voice-intent-v1';
export const VOICE_CAPTURE_TIMEOUT_MS = 20_000;
// Require a new explicit consent gesture after a bounded hands-free session.
export const VOICE_CONVERSATION_MAX_MS = 5 * 60_000;
export const VOICE_INTENT_TIMEOUT_MS = 10_000;
export const VOICE_REPLY_TIMEOUT_MS = 45_000;
export const VOICE_SPEECH_TIMEOUT_MS = 180_000;
export const MAX_VOICE_TRANSCRIPT_LENGTH = 1000;
export const MAX_VOICE_ASR_SEGMENTS = 24;
export const MAX_VOICE_ANSWER_LENGTH = 2400;

const DISALLOWED_TRANSCRIPT_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const normalizeIndicJoiners=text=>text.replace(/([\u0900-\u097F\u0C80-\u0CFF])[\u200C\u200D](?=[\u0900-\u097F\u0C80-\u0CFF])/gu,'$1');
const STOP_PHRASES = /^(?:stop listening|goodbye genie|end conversation|cancel voice mode|stop genie)[.!?]*$/i;
const EVIDENCE_IDENTIFIER = /^E_[A-Z0-9_:-]+$/;

/**
 * Treat browser speech-recognition result arrays as untrusted input.
 * Never loop an unbounded provider-supplied collection or silently discard
 * a later financial amount, negation, or percentage after the first chunk.
 */
export function collectVoiceRecognitionResults(results) {
  if (!results || !Number.isSafeInteger(results.length) ||
      results.length < 1 || results.length > MAX_VOICE_ASR_SEGMENTS)
    return { status: 'invalid' };
  const finals = [], partials = [];
  let length = 0;
  for (let i = 0; i < results.length; i += 1) {
    const text = results[i]?.[0]?.transcript;
    if (typeof text !== 'string' || DISALLOWED_TRANSCRIPT_CHARACTERS.test(text))
      return { status: 'invalid' };
    length += text.length + 1;
    if (length > MAX_VOICE_TRANSCRIPT_LENGTH + 1) return { status: 'invalid' };
    if (results[i].isFinal === false) partials.push(text);
    else finals.push(text);
  }
  // Preserve raw edges for validateVoiceTranscript: trimming first could
  // erase forbidden trailing controls and authorize an injected command.
  const transcript = finals.join(' ');
  if (partials.length) {
    const caption = (transcript + ' ' + partials.join(' ')).trim();
    return caption ? { status: 'partial', caption } : { status: 'invalid' };
  }
  return transcript.trim() ? { status: 'final', transcript } : { status: 'invalid' };
}

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
  if (!answer || answer.grounded !== true || answer.validation_status !== 'PASS' ||
      answer.fallback === true ||
      (Array.isArray(answer.unavailable_facts) && answer.unavailable_facts.length > 0))
    return false;
  const ids = answer.evidence_ids_used;
  const content = answer.content ?? answer.response;
  return typeof content === 'string' && content.trim().length > 0 &&
    Array.isArray(ids) && ids.length > 0 &&
    ids.every(id => typeof id === 'string' && EVIDENCE_IDENTIFIER.test(id) &&
      id !== 'E_CHAT_ANSWER_UNAVAILABLE');
}

/**
 * Narration is bound to BOTH the authenticated reply and its displayed evidence.
 * Equal-looking text from another turn is not proof that the same financial
 * source or validation passed. This must remain a read-only, pure comparison.
 */
export function sameVerifiedVoiceReply(returned, displayed) {
  if (!isVerifiedVoiceAnswer(returned) || !isVerifiedVoiceAnswer(displayed))
    return false;
  if ((returned.content ?? returned.response) !== (displayed.content ?? displayed.response))
    return false;
  // Real chat turns carry the originating idempotency key in both the
  // authenticated reply and the visible message. If either side is keyed,
  // never narrate an older equal-text answer or an unbound reply.
  if (returned._turnKey !== undefined || displayed._turnKey !== undefined) {
    if (typeof returned._turnKey !== 'string' || !returned._turnKey ||
        returned._turnKey !== displayed._turnKey) return false;
  }
  return returned.evidence_ids_used.length === displayed.evidence_ids_used.length &&
    returned.evidence_ids_used.every((id, i) => id === displayed.evidence_ids_used[i]);
}

export function voiceAnswerText(answer) {
  if (!isVerifiedVoiceAnswer(answer)) return null;
  const content = answer.content ?? answer.response;
  // HTML, tables, code blocks and strikethrough cannot be read aloud without
  // losing financial qualifiers, structure, or whether a value was retracted.
  if (/<\/?[a-z][^>]*>/i.test(content) || /```|~~~|!\[[^\]]*\]\(/.test(content) ||
      /~~/.test(content) || /(?:^|\n)\s*\|[^\n]*\|/m.test(content) ||
      /\n\s*[-:| ]*---[-:| ]*\|[-:| ]*---/m.test(content)) return null;
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
