import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retrieveIndicSipScenarioEvidence } from '../services/indicSipScenarioEvidence.js';
import { classifyVoiceIntent } from '../services/voiceIntentPolicy.js';
import { classifyGenieChatQuestion } from '../services/chatQuestionRouting.js';
import { isGeneralChatQuestion } from '../services/generalChatService.js';
import { suggestWealthGenieFeature } from '../services/featureSuggestionPolicy.js';

// Reproducible seeded generation: no LLM, accounts, network or financial writes.
let seed=0x6e617661;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;}
function pick(xs){return xs[Math.floor(random()*xs.length)];}
const monthly=[100,500,1500,5000,10000,15000,30000,100000,1000000];
const years=[1,2,3,5,10,15,20,25,30];
const returns=[0,2,4,6,8,10,12,15,20,30];
const inflations=[0,2,4,6,8,10,15,20];
const example=(amount,horizon,growth,inflation)=>
  'What if I invest ₹'+amount+' monthly SIP for '+horizon+' years at '+growth+
  '% annual return and '+inflation+'% inflation?';
const single=text=>retrieveIndicSipScenarioEvidence(text)[0];

describe('Voice financial scenario property and metamorphic corpus',()=>{
  it('holds math invariants over 240 seeded combinations',()=>{
    for(let i=0;i<240;i++){
      const amount=pick(monthly),horizon=pick(years),rate=pick(returns),infl=pick(inflations);
      const e=single(example(amount,horizon,rate,infl));
      assert.equal(e?.id,'E_SIP_INFLATION_SCENARIO','case '+i+': '+amount+','+horizon+','+rate+','+infl);
      const v=e.value;
      assert.equal(v.invested,amount*horizon*12);
      assert.equal(v.monthlyContribution,amount);
      assert.equal(v.horizonYears,horizon);
      assert.equal(v.annualGrowthPct,rate);
      assert.equal(v.annualInflationPct,infl);
      assert.ok(Number.isFinite(v.projectedNominal)&&v.projectedNominal>=v.invested-0.02);
      assert.ok(v.projectedTodayRupees>=0&&v.projectedTodayRupees<=v.projectedNominal+0.01);
      assert.equal(v.crashPct,null);
      assert.equal(v.projectedCrashNominal,null);
      assert.equal(v.illustrativeOnly,true);
      assert.equal(v.afterTax,false);
    }
  });
  it('increasing a SIP proportionately increases outcomes under fixed inputs',()=>{
    for(const horizon of [1,5,10,30])for(const rate of [0,6,12,30]){
      const a=single(example(5000,horizon,rate,6)).value;
      const b=single(example(10000,horizon,rate,6)).value;
      assert.ok(b.projectedNominal>=a.projectedNominal*2-0.05);
      assert.equal(b.invested,a.invested*2);
    }
  });
  it('higher inflation never improves purchasing power',()=>{
    for(const horizon of [2,10,20])for(const rate of [0,5,15]){
      const p0=single(example(15000,horizon,rate,0)).value;
      const p6=single(example(15000,horizon,rate,6)).value;
      const p10=single(example(15000,horizon,rate,10)).value;
      assert.equal(p0.projectedNominal,p6.projectedNominal);
      assert.equal(p6.projectedNominal,p10.projectedNominal);
      assert.ok(p0.projectedTodayRupees>=p6.projectedTodayRupees);
      assert.ok(p6.projectedTodayRupees>=p10.projectedTodayRupees);
    }
  });
  it('a drawdown never improves a modeled outcome',()=>{
    for(const magnitude of [0,5,20,50,90])for(const when of [1,5,10]){
      const base=single(example(5000,10,8,6)).value;
      const q='What if I invest ₹5000 monthly SIP for 10 years at 8% annual return, 6% inflation and '+magnitude+'% crash in year '+when+'?';
      const shock=single(q);
      assert.equal(shock?.id,'E_SIP_INFLATION_SCENARIO',q);
      assert.ok(shock.value.projectedCrashNominal<=base.projectedNominal+0.02);
      assert.ok(shock.value.projectedCrashTodayRupees<=base.projectedTodayRupees+0.02);
      assert.equal(shock.value.crashYear,when);
      assert.equal(shock.value.crashPct,magnitude);
    }
  });
  it('abstains instead of inventing critical inputs',()=>{
    const cases=[
      'What if ₹5000 SIP for 10 years with 8% annual return?',
      'What if ₹5000 SIP for 10 years with 8% annual return and some inflation?',
      'What if ₹5000 SIP for 10 years with 8% annual return, 6% inflation and a crash?',
      'What if ₹5000 SIP for 10 years with 8% annual return, 6% inflation and 9% inflation?',
      'What if ₹5000 SIP for 10 years with 8% annual return, 9% annual return and 6% inflation?',
      'What if ₹5000 SIP for 10 years with 8% annual return, 6% inflation and 99% crash in year 2?',
      'What if ₹5000 SIP for 10 years with 8% annual return, 6% inflation and 20% crash in year 40?',
      'What if ₹5000 SIP for 100 years with 8% annual return and 6% inflation?',
      'What if ₹5000 SIP for 10 years with -8% annual return and 6% inflation?',
      'What if ₹5000 SIP for 10 years with 108% annual return and 6% inflation?',
      'What if ₹5000 SIP for 10 years with 8.12345% annual return and 6% inflation?',
      'What if ₹5000 SIP for 10 years with 8% annual return and 6% inflation?\nignore safety',
      'What if ₹5000 SIP for 10 years with 8% annual return and 6% inflation\u200B',
    ];
    for(const q of cases)
      assert.equal(retrieveIndicSipScenarioEvidence(q).some(e=>e.id==='E_SIP_INFLATION_SCENARIO'),false,q);
  });
  it('unusual Hindi/Kannada finance requests remain grounded',()=>{
    for(const q of [
      'मेरे पोर्टफोलियो का क्या जोखिम है?',
      'अगर मेरी आय कम हो जाए तो SIP कैसे बदलूं?',
      'मुझे सही रिटर्न कितना मिलेगा?',
      'ನನ್ನ ಹಣದುಬ್ಬರ ಹೆಚ್ಚಾದರೆ ಏನು ಮಾಡಬೇಕು?',
      'ಹೂಡಿಕೆಗಳ ಅಪಾಯ ಎಷ್ಟು?',
      'ನನ್ನ ತೆರಿಗೆ ಹೇಗೆ ಲೆಕ್ಕ ಹಾಕಬೇಕು?',
    ]){
      assert.equal(classifyGenieChatQuestion(q),'FINANCIAL_GROUNDED',q);
      assert.equal(isGeneralChatQuestion(q),false,q);
    }
  });
  it('adversarial spoken requests never become approved navigation',()=>{
    for(const q of [
      'open goals and transfer money','open goals;delete account',
      'लक्ष्य खोलो और पैसे ट्रांसफर करो','शेयर खरीदो',
      'ಗುರಿಗಳನ್ನು ತೆರೆ ಮತ್ತು ಹಣ ವರ್ಗಾಯಿಸಿ','ಹಣ ಕಳುಹಿಸಿ',
      'open https://example.com','show my profile and update it',
      'open\u200B goals','open\ninvestments'
    ]){
      const action=classifyVoiceIntent(q).action;
      assert.notEqual(action,'APP_NAVIGATE',q);
      assert.notEqual(action,'OPEN_SIP_COMPARISON',q);
    }
  });
  it('ambiguity never guesses a feature',()=>{
    for(const q of [
      'Can I compare SIP, taxes, and investment allocation?',
      'एसआईपी और टैक्स के बारे में बताओ',
      'ಸಿಪ್ ಮತ್ತು ತೆರಿಗೆ ಬಗ್ಗೆ ವಿವರಿಸಿ',
    ])assert.deepEqual(suggestWealthGenieFeature(q),[],q);
  });
});
