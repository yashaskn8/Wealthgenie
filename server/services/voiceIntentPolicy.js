/**
 * Sovereign X voice-command policy.
 * Read-only app navigation only. No autonomous financial or browser actions.
 */
export const VOICE_INTENT_VERSION='sovereign-voice-intent-v1';
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
const NAV_RE=/^(?:please\s+)?(?:open|show|visit|go to|navigate to|take me to)\s+(?:(?:the|my)\s+)?(.+?)(?:\s+(?:page|screen|tab))?[.!?]*$/i;
const UNSAFE_RE=/\b(?:buy|sell|trade|transfer|withdraw|pay|purchase|delete|erase|remove|submit|send|save|change|modify|update|rebalance|approve|authorize|confirm|execute|install|download|upload|log\s*in|sign\s*in)\b|(?:https?:\/\/|www\.)/i;
const EXTERNAL_RE=/\b(?:browser|chrome|firefox|tab|website|google|youtube|gmail|email|external|internet|webpage)\b/i;
const ROUTES=new Map(Object.entries(TARGETS).flatMap(([page,aliases])=>aliases.map(alias=>[alias,page])));
export function classifyVoiceIntent(raw) {
  if(typeof raw!=='string'||raw.length===0||raw.length>1000)return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  // Validate raw ASR bytes BEFORE whitespace normalization: otherwise LF,
  // CR and TAB can disappear and smuggle a multiline transcript into an
  // authorized single navigation instruction.
  if(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw))return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  const input=raw.trim().replace(/\s+/g,' ');
  if(!input)return {action:'REJECTED',reason:'INVALID_TRANSCRIPT'};
  if(UNSAFE_RE.test(input))return {action:'REJECTED',reason:'ACTION_NOT_ALLOWED'};
  if(OPEN_COMPARISON_RE.test(input))return {action:'OPEN_SIP_COMPARISON',version:VOICE_INTENT_VERSION};
  const matched=NAV_RE.exec(input);
  if(!matched)return {action:'CHAT',reason:'NO_APPROVED_COMMAND'};
  const noun=matched[1].toLowerCase().trim().replace(/[.!?]+$/,'').trim();
  const page=ROUTES.get(noun);
  if(page)return {action:'APP_NAVIGATE',page,tab:null,version:VOICE_INTENT_VERSION};
  if(EXTERNAL_RE.test(noun))return {action:'REJECTED',reason:'EXTERNAL_BROWSER_DISABLED'};
  return {action:'CHAT',reason:'NO_APPROVED_COMMAND'};
}
