/**
 * Sovereign X voice-command policy.
 * Read-only app navigation only. No autonomous financial or browser actions.
 */
export const VOICE_INTENT_VERSION='sovereign-voice-intent-v1';
// Preserve native orthography safety: remove only Indic joiners between two
// Indic code points, then reject every other invisible/control character.
const normalizeIndicJoiners=text=>text.replace(/([\u0900-\u097F\u0C80-\u0CFF])[\u200C\u200D](?=[\u0900-\u097F\u0C80-\u0CFF])/gu,'$1');
const TARGETS=Object.freeze({
  home:['home','dashboard'],
  plan:['plan','investment plan'],
  investments:['investments','investment options','where to invest'],
  taxes:['taxes','tax','tax analysis'],
  progress:['progress'],
  goals:['goals','goal planner'],
  'grow-my-sip':['grow my sip','sip planner'],
  'keep-on-track':['keep on track','rebalancer'],
  account:['account','profile'],
  help:['help','help center']
});
const OPEN_COMPARISON_RE=/^(?:please\s+)?(?:open|show|start|prepare)\s+(?:(?:the|my)\s+)?(?:sip comparison|sip scenario comparison|sip what if|sip what-if)(?:\s+(?:tool|screen|panel))?[.!?]*$/i;
const NAV_RE=/^(?:(?:please|(?:could|can) you(?: please)?)\s+)?(?:open|show|visit|go to|navigate to|take me to|bring up|pull up)\s+(?:(?:the|my)\s+)?(.+?)(?:\s+(?:page|screen|tab))?[.!?]*$/i;
const UNSAFE_RE=/\b(?:buy|sell|trade|transfer|withdraw|pay|purchase|delete|erase|remove|submit|send|save|change|modify|update|rebalance|approve|authorize|confirm|execute|install|download|upload|log\s*in|sign\s*in)\b|(?:https?:\/\/|www\.)/i;
const EXTERNAL_RE=/\b(?:browser|chrome|firefox|tab|website|google|youtube|gmail|email|external|internet|webpage)\b/i;
// The interpretation endpoint is NOT a tool executor. Users must be able to ask
// educational questions about buying/selling without granting transaction
// authority. Explicit requests that the assistant act on their behalf remain
// denied, even when phrased as questions.
const EDUCATIONAL_RE=/^(?:what\s+(?:is|are|does|happens|if|would)|how\s+(?:do|does|can|could|would|is|are)|why\s+(?:do|does|is|are)|explain\b|tell\s+me\s+about\b|could\s+you\s+explain\b|should\s+i\b)/i;
const DIRECT_ACTION_QUESTION_RE=/^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)(?:buy|sell|trade|transfer|withdraw|pay|purchase|delete|erase|remove|submit|send|save|change|modify|update|rebalance|approve|authorize|confirm|execute|install|download|upload|log\s*in|sign\s*in)\b/i;
const URL_RE=/(?:https?:\/\/|www\.)/i;
// Exact, reviewed navigation phrases only; these are commands, not a natural
// language model, so the user cannot trick a translation layer into executing.
const INDIC_NAV = new Map([
  ['लक्ष्य खोलो','goals'], ['गोल प्लानर खोलो','goals'],
  ['सिप प्लानर खोलो','grow-my-sip'], ['एसआईपी प्लानर खोलो','grow-my-sip'],
  ['टैक्स खोलो','taxes'], ['कर विश्लेषण खोलो','taxes'],
  ['निवेश विकल्प खोलो','investments'], ['निवेश योजना खोलो','plan'],
  ['पोर्टफोलियो समीक्षा खोलो','keep-on-track'], ['होम खोलो','home'],
  ['ಗುರಿಗಳನ್ನು ತೆರೆ','goals'], ['ಗುರಿ ಯೋಜನೆ ತೆರೆ','goals'],
  ['ಸಿಪ್ ಪ್ಲಾನರ್ ತೆರೆ','grow-my-sip'], ['ಎಸ್‌ಐಪಿ ಪ್ಲಾನರ್ ತೆರೆ','grow-my-sip'],
  ['ತೆರಿಗೆ ವಿಶ್ಲೇಷಣೆ ತೆರೆ','taxes'], ['ಹೂಡಿಕೆ ಆಯ್ಕೆಗಳು ತೆರೆ','investments'],
  ['ಹೂಡಿಕೆ ಯೋಜನೆ ತೆರೆ','plan'], ['ಪೋರ್ಟ್‌ಫೋಲಿಯೋ ಪರಿಶೀಲನೆ ತೆರೆ','keep-on-track'],
  ['ಮುಖಪುಟ ತೆರೆ','home'],
].map(([phrase,page])=>[normalizeIndicJoiners(phrase),page]));
const INDIC_UNSAFE = /(?:पैसे\s*भेजो|पैसे\s*ट्रांसफर|पैसे\s*निकालो|शेयर\s*खरीदो|शेयर\s*बेचो|ट्रेड\s*करो|भुगतान\s*करो|ಖರೀದಿಸಿ|ಮಾರಾಟ\s*ಮಾಡಿ|ಹಣ\s*ವರ್ಗಾಯಿಸಿ|ಹಣ\s*ಕಳುಹಿಸಿ|ಹಣ\s*ಹಿಂಪಡೆಯಿರಿ|ವ್ಯಾಪಾರ\s*ಮಾಡಿ)/iu;
const INDIC_COMMAND = /(?:खोलो|दिखाओ|नेविगेट\s*करो|तेರೆ|ತೆರೆ|ತೋರಿಸು|ತೋರಿಸಿ)/iu;
const INDIC_COMPARE = new Set(['सिप तुलना खोलो','एसआईपी तुलना खोलो','ಸಿಪ್ ಹೋಲಿಕೆ ತೆರೆ'].map(normalizeIndicJoiners));
const ROUTES=new Map(Object.entries(TARGETS).flatMap(([page,aliases])=>aliases.map(alias=>[alias,page])));
export function classifyVoiceIntent(raw) {
  if(typeof raw!=='string'||raw.length===0||raw.length>1000)return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  // Validate raw ASR bytes BEFORE whitespace normalization: otherwise LF,
  // CR and TAB can disappear and smuggle a multiline transcript into an
  // authorized single navigation instruction.
  const normalizedRaw=normalizeIndicJoiners(raw);
  if(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalizedRaw))return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  // Conversational invocation is a speech convenience, never an authorization bypass.
  const input=normalizedRaw.trim().replace(/\s+/g,' ')
    .replace(/^(?:(?:hey|okay|ok)\s+)?genie[,!:\s-]+/i,'')
    .replace(/^(?:जिनी|जीनि|ಜಿನಿ)[,:!?\s]+/u,'');
  if(!input)return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  const indicCommand=input.replace(/[.!?।]+$/u,'').trim();
  if(INDIC_UNSAFE.test(input))return {action:'REJECTED',reason:'ACTION_NOT_ALLOWED'};
  if(INDIC_COMPARE.has(indicCommand))return {action:'OPEN_SIP_COMPARISON',version:VOICE_INTENT_VERSION};
  if(INDIC_NAV.has(indicCommand))
    return {action:'APP_NAVIGATE',page:INDIC_NAV.get(indicCommand),tab:null,version:VOICE_INTENT_VERSION};
  if(INDIC_COMMAND.test(input))return {action:'REJECTED',reason:'UNSUPPORTED_NAVIGATION'};
  if(UNSAFE_RE.test(input)) {
    if(EDUCATIONAL_RE.test(input) && !DIRECT_ACTION_QUESTION_RE.test(input) &&
      !URL_RE.test(input) && !/[;{}<>]/.test(input))
      return {action:'CHAT',reason:'EDUCATIONAL_QUESTION'};
    return {action:'REJECTED',reason:'ACTION_NOT_ALLOWED'};
  }
  if(OPEN_COMPARISON_RE.test(input))return {action:'OPEN_SIP_COMPARISON',version:VOICE_INTENT_VERSION};
  const matched=NAV_RE.exec(input);
  if(!matched)return {action:'CHAT',reason:'NO_APPROVED_COMMAND'};
  const noun=matched[1].toLowerCase().trim().replace(/[.!?]+$/,'').trim();
  const page=ROUTES.get(noun);
  if(page)return {action:'APP_NAVIGATE',page,tab:null,version:VOICE_INTENT_VERSION};
  if(EXTERNAL_RE.test(noun))return {action:'REJECTED',reason:'EXTERNAL_BROWSER_DISABLED'};
  return {action:'REJECTED',reason:'UNSUPPORTED_NAVIGATION'};
}
