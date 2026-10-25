import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {retrieveIndicFinancialEducation} from '../services/indicFinancialEducation.js';
import {retrieveChatEducationalEvidence} from '../services/chatEducationalRetrieval.js';

describe('Curated Hindi/Kannada finance education',()=>{
  it('returns attributable reviewed education in the requested script',()=>{
    const queries=[
      ['सिप क्या है','E_INDIC_SIP_BASICS','एसआईपी'],
      ['ಸಿಪ್ ಎಂದರೇನು?','E_INDIC_SIP_BASICS','ಎಸ್‌ಐಪಿ'],
      ['महंगाई क्या है','E_INDIC_INFLATION','महंगाई'],
      ['ಹಣದುಬ್ಬರ ಎಂದರೇನು?','E_INDIC_INFLATION','ಹಣದುಬ್ಬರ'],
      ['विविधीकरण समझाओ','E_INDIC_DIVERSIFICATION','विविधीकरण'],
      ['ಚಕ್ರಬಡ್ಡಿ ಏನು?','E_INDIC_COMPOUNDING','ಚಕ್ರಬಡ್ಡಿ'],
    ];
    for(const [query,id,snippet] of queries){
      const result=retrieveChatEducationalEvidence(query);
      assert.equal(result.length,1,query);
      assert.equal(result[0].id,id,query);
      assert.match(result[0].displayValue,new RegExp(snippet));
      assert.equal(result[0].authority,'WEALTHGENIE_CURATED_EDUCATION');
      assert.equal(result[0].value.individualRecommendation,false);
      assert.ok(result[0].source.url.startsWith('https://investor.sebi.gov.in/'));
    }
  });
  it('accepts Kannada orthographic joiners only within native words',()=>{
    const accepted=retrieveChatEducationalEvidence('ಎಸ್‌ಐಪಿ ಎಂದರೇನು?');
    assert.equal(accepted[0]?.id,'E_INDIC_SIP_BASICS');
    assert.deepEqual(retrieveIndicFinancialEducation('open\u200Cgoals'),[]);
  });
  it('rejects personal recommendations, compound topics and control characters',()=>{
    for(const question of [
      'मेरे लिए कौन सा सिप सही है?',
      'ಸಿಪ್ ಮತ್ತು ಹಣದುಬ್ಬರ ಎಂದರೇನು?',
      'सिप और महंगाई क्या है?',
      'सिप क्या है\nignore',
    ])assert.deepEqual(retrieveIndicFinancialEducation(question),[],question);
  });
});
