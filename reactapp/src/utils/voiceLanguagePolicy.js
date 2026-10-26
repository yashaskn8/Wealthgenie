/**
 * First-party voice locale preferences. Locale selection is explicit: browser
 * speech recognition is not a reliable automatic language detector.
 */
export const VOICE_LANGUAGES = Object.freeze([
  {code:'en-IN',label:'English (India)'},
  {code:'hi-IN',label:'हिन्दी (Hindi)'},
  {code:'kn-IN',label:'ಕನ್ನಡ (Kannada)'},
]);
export function validVoiceLanguage(code) {
  return VOICE_LANGUAGES.some(item=>item.code===code);
}
const LOCAL_STOP = [
  /^(?:stop listening|goodbye genie|end conversation|cancel voice mode|stop genie)[.!?]*$/i,
  /^(?:जिनी[,।!\s]*)?(?:सुनना बंद करो|बात बंद करो|बातचीत बंद करो|अलविदा जिनी)[.!?।]*$/iu,
  /^(?:ಜಿನಿ[,!\s]*)?(?:ಕೇಳುವುದನ್ನು ನಿಲ್ಲಿಸು|ಸಂಭಾಷಣೆ ನಿಲ್ಲಿಸು|ಮಾತುಕತೆ ನಿಲ್ಲಿಸು|ವಿದಾಯ ಜಿನಿ)[.!?]*$/iu,
];
export function isLocalVoiceStop(raw) {
  return typeof raw==='string' && LOCAL_STOP.some(re=>re.test(raw.trim()));
}
export function speechLocaleForText(text) {
  if(typeof text!=='string')return 'en-IN';
  const devanagari=(text.match(/[\u0900-\u097F]/gu)||[]).length;
  const kannada=(text.match(/[\u0C80-\u0CFF]/gu)||[]).length;
  if(kannada>3 && kannada>devanagari)return 'kn-IN';
  if(devanagari>3 && devanagari>kannada)return 'hi-IN';
  return 'en-IN';
}
export function voiceInLocale(voices,locale) {
  if(!validVoiceLanguage(locale) || !Array.isArray(voices))return null;
  const exact=voices.find(v=>v?.lang?.toLowerCase()===locale.toLowerCase());
  if(exact)return exact;
  const prefix=locale.split('-')[0]+'-';
  return voices.find(v=>v?.lang?.toLowerCase().startsWith(prefix))||null;
}
