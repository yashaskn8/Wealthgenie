/**
 * Fail-closed detection of attempts to turn user text into privileged commands.
 * This is defense in depth, not an authorization boundary or an LLM safety
 * certification. Never give these strings access to tools or financial state.
 * Keep normalization bounded to avoid expensive adversarial inputs.
 */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const TAGS = /(?:<\s*\/?\s*(?:system|developer|assistant|tool|instructions?)\s*>|<<\s*SYS\s*>>|\[im_(?:start|end)\]|<\|(?:im_start|im_end|system|developer)\|>)/i;
const ROLE_LINE = /(?:^|[\r\n])\s*(?:#{1,6}\s*)?(?:system|developer|assistant|tool)\s*:\s*\S/i;
const ROLE_JSON = /["']role["']\s*:\s*["'](?:system|developer|assistant|tool)["']/i;
const PRIVILEGE = [
  /\b(?:ignore|disregard|override|forget|bypass|discard)\s+(?:(?:all|any|your|the)\s+)?(?:previous|prior|above|system|developer|safety|security|guardrail|policy)\s+(?:instructions?|prompts?|rules?|directions?|checks?)\b/i,
  /\b(?:you\s+are\s+now|act\s+as|switch\s+to)\s+(?:an?\s+)?(?:unrestricted|jailbroken|admin|administrator|developer|system|root)\b/i,
  /\b(?:reveal|dump|print|leak|expose|disclose|send|export)\b.{0,75}\b(?:system\s+prompt|developer\s+(?:prompt|instructions?)|api[_ -]?key|secret|credentials?|private\s+(?:data|profile)|other\s+users?\s+data)\b/i,
  /\b(?:send|post|upload|forward|exfiltrate)\b.{0,100}\b(?:secrets?|tokens?|credentials?|private\s+data|portfolio|account\s+records?)\b.{0,100}\b(?:https?:\/\/|email|endpoint|webhook|server)\b/i,
  /\b(?:call|invoke|run|execute)\s+(?:an?\s+)?(?:hidden|internal|privileged|admin)(?:\s+(?:admin|privileged))?\s+(?:tool|api|command|function)\b/i,
  /\b(?:skip|disable|turn\s+off)\s+(?:the\s+)?(?:safety|verification|citation|permission|audit|logging|validation|guardrail)\b/i,
];
const BASE64_TOKEN = /(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{20,1024}={0,2})(?=$|[^A-Za-z0-9+/])/g;

function normalize(value) {
  let normalized = String(value || '').normalize('NFKC').replace(INVISIBLE, '');
  normalized = normalized.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/gi, (_, hex, dec) => {
    const code = parseInt(hex || dec, hex ? 16 : 10);
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : ' ';
  });
  normalized = normalized.replace(/&(lt|gt|quot|apos|colon|sol|amp);/gi, (_, entity) =>
    ({ lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', amp: '&' })[entity.toLowerCase()]);
  if (/%[0-9a-f]{2}/i.test(normalized)) {
    try { normalized = decodeURIComponent(normalized); } catch { /* inspect undecoded input */ }
  }
  return normalized.slice(0, 8192);
}

function directAttack(text) {
  return TAGS.test(text) || ROLE_LINE.test(text) || ROLE_JSON.test(text)
    || PRIVILEGE.some(pattern => pattern.test(text));
}

export function inspectChatInjection(value) {
  if (typeof value !== 'string') return { detected: false, reason: null };
  const normalized = normalize(value);
  if (directAttack(normalized)) return { detected: true, reason: 'DIRECT_ROLE_OR_INSTRUCTION' };
  // Decode only a few bounded valid tokens; no arbitrary recursive decoding.
  let count = 0;
  for (const match of normalized.matchAll(BASE64_TOKEN)) {
    if (++count > 8) break;
    const token = match[1];
    try {
      const decoded = Buffer.from(token, 'base64');
      if (!decoded.length || decoded.length > 1024) continue;
      const roundtrip = decoded.toString('base64').replace(/=+$/, '');
      if (roundtrip !== token.replace(/=+$/, '')) continue;
      if (directAttack(normalize(decoded.toString('utf8')))) {
        return { detected: true, reason: 'ENCODED_ROLE_OR_INSTRUCTION' };
      }
    } catch { /* invalid token */ }
  }
  return { detected: false, reason: null };
}

export function isChatInjection(value) {
  return inspectChatInjection(value).detected;
}

export const SECURITY_BOUNDARY_MESSAGE =
  'I can help with investment planning and general financial questions, but I cannot follow requests to change my instructions, reveal private information, or bypass evidence checks. Please ask the financial question without those instructions.';
