import { describe, expect, it } from 'vitest';
import {
  validateVoiceTranscript, isVoiceStopPhrase, isAuthorizedVoiceNavigation,
  isVerifiedVoiceAnswer, sameVerifiedVoiceReply, voiceAnswerText, selectBrowserVoice,
} from '../voiceRuntimePolicy';

const verified = {
  response: 'Invest for the long term. [E_PROFILE_RISK]',
  grounded: true,
  validation_status: 'PASS',
  evidence_ids_used: ['E_PROFILE_RISK'],
};

describe('GenieVoice trust-boundary policy', () => {
  it('rejects untrusted raw speech before whitespace normalization', () => {
    for (const input of ['', '\topen goals', 'open goals\n', 'open\u200bgoals',
      'open\u2028goals', 'x'.repeat(1001), {}, null]) {
      expect(validateVoiceTranscript(input)).toBeNull();
    }
    expect(validateVoiceTranscript('  open goals  ')).toBe('open goals');
    expect(validateVoiceTranscript('ಎಸ್‌ಐಪಿ ಪ್ಲಾನರ್ ತೆರೆ')).toBe('ಎಸ್ಐಪಿ ಪ್ಲಾನರ್ ತೆರೆ');
    expect(validateVoiceTranscript('open\u200Cgoals')).toBeNull();
    expect(validateVoiceTranscript('open\u200Dgoals')).toBeNull();
  });
  it('stops on local commands without sending audio to a provider', () => {
    expect(isVoiceStopPhrase('goodbye genie')).toBe(true);
    expect(isVoiceStopPhrase('stop listening.')).toBe(true);
    expect(isVoiceStopPhrase('show the goals page')).toBe(false);
  });
  it('authorizes only exact known internal navigation', () => {
    expect(isAuthorizedVoiceNavigation({
      version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null,
    })).toBe(true);
    for (const mutated of [
      {page:'admin'}, {tab:'investments'}, {action:'CHAT'}, {version:'forged-v9'},
    ]) {
      expect(isAuthorizedVoiceNavigation({
        version:'sovereign-voice-intent-v1',
        action:'APP_NAVIGATE', page:'goals', tab:null, ...mutated,
      })).toBe(false);
    }
  });
  it('requires evidence and PASS on the exact server reply', () => {
    expect(isVerifiedVoiceAnswer(verified)).toBe(true);
    expect(voiceAnswerText(verified)).toBe('Invest for the long term.');
    for (const value of [
      {...verified,grounded:false},
      {...verified,validation_status:'UNVERIFIED_GENERAL_CHAT'},
      {...verified,evidence_ids_used:[]},
      {...verified,evidence_ids_used:['E_CHAT_ANSWER_UNAVAILABLE']},
      {...verified,evidence_ids_used:['E_PROFILE_RISK','non-evidence']},
      {...verified,response:'x'.repeat(2401)},
    ]) {
      expect(voiceAnswerText(value)).toBeNull();
    }
  });
  it('matches the authenticated speech reply against displayed financial evidence', () => {
    const a={...verified,content:'Verified explanation.',response:'Verified explanation.'};
    expect(sameVerifiedVoiceReply(a,{...a})).toBe(true);
    expect(sameVerifiedVoiceReply(a,{...a,evidence_ids_used:['E_OTHER']})).toBe(false);
    expect(sameVerifiedVoiceReply(a,{...a,grounded:false})).toBe(false);
    expect(sameVerifiedVoiceReply(a,{...a,content:'Different explanation.'})).toBe(false);
  });

  it('rejects equal-looking authenticated replies from different chat turns', () => {
    const a={...verified,_turnKey:'voice-turn-a'};
    expect(sameVerifiedVoiceReply(a,{...a,_turnKey:'voice-turn-b'})).toBe(false);
    expect(sameVerifiedVoiceReply(a,{...a,_turnKey:'voice-turn-a'})).toBe(true);
    expect(sameVerifiedVoiceReply(a,{...a,_turnKey:undefined})).toBe(false);
    expect(sameVerifiedVoiceReply({...verified},{...verified,_turnKey:'voice-turn-a'})).toBe(false);
  });

  it('does not truncate or invent words from long financial answers', () => {
    expect(voiceAnswerText({...verified,response:'x'.repeat(2401)})).toBeNull();
    expect(voiceAnswerText({...verified,response:'**Returns** are hypothetical.'}))
      .toBe('Returns are hypothetical.');
  });
  it('prefers an Indian English voice without requiring one', () => {
    const voices=[{lang:'en-US'}, {lang:'en-IN'}, {lang:'hi-IN'}];
    expect(selectBrowserVoice(voices)).toBe(voices[1]);
    expect(selectBrowserVoice([{lang:'hi-IN'}])).toBeNull();
  });
});
