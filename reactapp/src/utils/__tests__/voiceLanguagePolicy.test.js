import { describe, expect, it } from 'vitest';
import { VOICE_LANGUAGES, validVoiceLanguage, isLocalVoiceStop,
  speechLocaleForText, voiceInLocale } from '../voiceLanguagePolicy';

describe('Hindi/Kannada voice locale trust boundaries',()=>{
  it('offers only three reviewed speech locales',()=>{
    expect(VOICE_LANGUAGES.map(x=>x.code)).toEqual(['en-IN','hi-IN','kn-IN']);
    expect(validVoiceLanguage('hi-IN')).toBe(true);
    expect(validVoiceLanguage('kn-IN')).toBe(true);
    expect(validVoiceLanguage('ar-SA')).toBe(false);
  });
  it('recognizes local stop commands without a backend request',()=>{
    expect(isLocalVoiceStop('सुनना बंद करो')).toBe(true);
    expect(isLocalVoiceStop('बातचीत बंद करो')).toBe(true);
    expect(isLocalVoiceStop('ಸಂಭಾಷಣೆ ನಿಲ್ಲಿಸು')).toBe(true);
    expect(isLocalVoiceStop('ಕೇಳುವುದನ್ನು ನಿಲ್ಲಿಸು')).toBe(true);
    expect(isLocalVoiceStop('What is a SIP?')).toBe(false);
  });
  it('determines speech language from verified response script',()=>{
    expect(speechLocaleForText('निवेश के परिणाम उदाहरण मात्र हैं।')).toBe('hi-IN');
    expect(speechLocaleForText('ಇದು ಕಲ್ಪಿತ ಹೂಡಿಕೆಯ ಉದಾಹರಣೆ ಮಾತ್ರ.')).toBe('kn-IN');
    expect(speechLocaleForText('Returns are hypothetical.')).toBe('en-IN');
  });
  it('never assigns the wrong-language installed voice',()=>{
    const voices=[{lang:'en-US'}, {lang:'hi-IN'}];
    expect(voiceInLocale(voices,'hi-IN')).toBe(voices[1]);
    expect(voiceInLocale(voices,'kn-IN')).toBeNull();
    expect(voiceInLocale(voices,'en-IN')).toBe(voices[0]);
  });
});
