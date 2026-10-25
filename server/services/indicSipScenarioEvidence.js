/**
 * Strict read-only SIP / inflation / one-off drawdown illustrations.
 * This is NOT a product return forecast or a personal investment decision.
 * No profile amount, rate or horizon may be invented from model output.
 * Input is the user's current explicit question (EN, Hindi or Kannada).
 */
const NATIVE_DIGITS = '०१२३४५६७८९೦೧೨೩೪೫೬೭೮೯';
const ZEROES = '01234567890123456789';
export function normalizeIndicNumerals(value) {
  return String(value).replace(/[०-९೦-೯]/g, digit => ZEROES[NATIVE_DIGITS.indexOf(digit)]);
}
const SIP = /(?:\bsip\b|monthly (?:investment|contribution)|monthly sip|एसआईपी|सिप|मासिक निवेश|ಪ್ರತಿ ತಿಂಗಳ ಹೂಡಿಕೆ|ತಿಂಗಳ ಹೂಡಿಕೆ|ಎಸ್.?ಐ.?ಪಿ|ಸಿಪ್)/i;
const SCENARIO = /(?:\b(?:if|scenario|simulate|hypothetical|what happens|what will|what is|compare)\b|अगर|यदि|क्या होगा|परिदृश्य|यदि|ಏನಾಗುತ್ತದೆ|ಒಂದು ವೇಳೆ|ಹಾಗಾದರೆ|ಉದಾಹರಣೆ)/i;
const RATE = '(?:\\d{1,2}(?:\\.\\d{1,4})?)';
const MAX_AMOUNT = 10_000_000;
const formatter = value => 'INR ' + value.toLocaleString('en-IN', {maximumFractionDigits: 2});
function numberMatches(text,pattern) {
  const values=[...text.matchAll(pattern)].map(m=>Number(m[1].replace(/,/g,'')));
  if(values.length!==1 || !Number.isFinite(values[0]))return null;
  return values[0];
}
function moneyAmount(text) {
  const matches=[...text.matchAll(/(?:₹|INR\b|Rs\.?\b|रुपये|ರೂ\.?)\s*([\d,]+(?:\.\d{1,2})?)/gi)];
  if(matches.length!==1)return null;
  const number=Number(matches[0][1].replace(/,/g,''));
  return Number.isSafeInteger(number) && number>=100 && number<=MAX_AMOUNT ? number : null;
}
function valueNear(text,label,after) {
  const a=numberMatches(text,new RegExp(label+'\\s*(?:of|at|is|by|दर|दर से|ನಲ್ಲಿ|ಅಂದಾಜು)?\\s*('+RATE+')\\s*%', 'gi'));
  const b=numberMatches(text,new RegExp('('+RATE+')\\s*%\\s*'+after,'gi'));
  if(a!==null && b!==null && a!==b)return null;
  return a!==null?a:b;
}
const GROWTH = '(?:annual\\s+(?:investment\\s+)?return|yearly\\s+return|annual\\s+cagr|cagr|investment\\s+return|वार्षिक\\s+रिटर्न|सालाना\\s+रिटर्न|ವಾರ್ಷಿಕ\\s+ರಿಟರ್ನ್|ವರ್ಷದ\\s+ರಿಟರ್ನ್)';
const INFLATION = '(?:inflation|महंगाई|मुद्रास्फीति|महँगाई|ಹಣದುಬ್ಬರ)';
const SHOCK = '(?:market\\s+)?(?:crash|fall|drop|drawdown|decline)|गिरावट|बाजार\\s+गिरावट|ಕುಸಿತ|ಇಳಿಕೆ';
function scan(text) {
  const amount=moneyAmount(text);
  const duration=numberMatches(text,/(\d{1,2})\s*(?:years?|yrs?|साल|वर्ष|ವರ್ಷ(?:ಗಳು|ಗಳ)?)/gi);
  const returnPct=valueNear(text,GROWTH,GROWTH);
  const inflation=valueNear(text,INFLATION,INFLATION);
  const shockPct=valueNear(text,SHOCK,SHOCK);
  const shockMentions=new RegExp(SHOCK,'i').test(text);
  const atYear=numberMatches(text,/(?:in|at|after|during)\s+(?:year\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*(?:year)?\b/gi)
    ?? numberMatches(text,/(\d{1,2})(?:st|nd|rd|th)?\s+(?:year|साल|वर्ष|ವರ್ಷ)(?:\s+(?:में|की|ನಲ್ಲಿ|ನಂತರ))?/gi);
  return {amount,duration,returnPct,inflation,shockPct,shockMentions,shockYear:atYear};
}

/**
 * Returns null for non-scenario queries, or a qualified boundary/evidence
 * record. No guessing a rate, year, amount or market move.
 */
export function retrieveIndicSipScenarioEvidence(question) {
  if(typeof question!=='string' || question.length>1000 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(question))return [];
  const text=normalizeIndicNumerals(question);
  if(!SIP.test(text) || !SCENARIO.test(text))return [];
  const d=scan(text);
  const missing=[];
  if(d.amount===null)missing.push('monthly amount with INR/₹');
  if(!Number.isSafeInteger(d.duration)||d.duration<1||d.duration>30)missing.push('horizon of 1–30 years');
  if(d.returnPct===null || d.returnPct<0 || d.returnPct>30)missing.push('user-supplied 0–30% effective annual return');
  if(d.inflation===null || d.inflation<0 || d.inflation>20)missing.push('user-supplied 0–20% annual inflation');
  if(d.shockMentions && (!Number.isFinite(d.shockPct) || d.shockPct<0 ||
      d.shockPct>90 || !Number.isSafeInteger(d.shockYear) ||
      d.shockYear<1 || (d.duration && d.shockYear>d.duration)))
    missing.push('one-off 0–90% market fall and a year within the horizon');
  const meta={dataClass:'DETERMINISTIC_USER_ASSUMPTION_SCENARIO',
    source:null,observedAt:null,freshness:null,authority:'WEALTHGENIE_BACKEND'};
  if(missing.length)return [{
    id:'E_SIP_SCENARIO_INPUTS_REQUIRED',kind:'ANSWER_BOUNDARY',
    value:{missing,calculationPerformed:false},...meta,
    displayValue:'No investment projection was calculated. For a clearly specified hypothetical SIP, please state: '+missing.join('; ')+'. The model never guesses market returns, inflation or crash severity.',
  }];
  const months=d.duration*12;
  const growth=Math.pow(1+d.returnPct/100,1/12)-1;
  const inflationFactor=Math.pow(1+d.inflation/100,d.duration);
  if(!Number.isFinite(growth)||!Number.isFinite(inflationFactor))return [];
  const future=(shock)=>{
    let balance=0;
    for(let m=1;m<=months;m++){
      balance=balance*(1+growth)+d.amount;
      if(shock && m===d.shockYear*12)balance*=1-d.shockPct/100;
    }
    return balance;
  };
  const projected=future(false);
  const shocked=d.shockMentions?future(true):null;
  const invested=d.amount*months;
  if(![projected,shocked??0,invested].every(n=>Number.isFinite(n)&&n>=0&&n<1e13))return [];
  const baseNominal=Math.round(projected*100)/100;
  const real=Math.round(projected/inflationFactor*100)/100;
  const shockNominal=shocked===null?null:Math.round(shocked*100)/100;
  const shockReal=shocked===null?null:Math.round(shocked/inflationFactor*100)/100;
  const parts=[
    'Illustrative end-of-month SIP scenario, not a prediction:',
    formatter(d.amount)+' monthly for '+d.duration+' years.',
    'User assumptions: '+d.returnPct+'% effective annual growth and '+d.inflation+'% annual inflation.',
    'Total contributions: '+formatter(invested)+'.',
    'Modeled future nominal value: '+formatter(baseNominal)+'.',
    'Modeled purchasing power in today’s rupees: '+formatter(real)+'.',
  ];
  if(shocked!==null)parts.push('With a one-time '+d.shockPct+'% drawdown at end of year '+
    d.shockYear+': illustrative nominal '+formatter(shockNominal)+
    '; purchasing power '+formatter(shockReal)+'. Recovery thereafter follows the same assumed growth, not a market forecast.');
  parts.push('Before tax, charges and actual volatility. This does not predict future returns, timing or affordability.');
  return [{
    id:'E_SIP_INFLATION_SCENARIO',kind:'GOAL_CALCULATION',
    value:{monthlyContribution:d.amount,horizonYears:d.duration,
      annualGrowthPct:d.returnPct,annualInflationPct:d.inflation,
      invested,projectedNominal:baseNominal,projectedTodayRupees:real,
      crashPct:shocked===null?null:d.shockPct,crashYear:shocked===null?null:d.shockYear,
      projectedCrashNominal:shockNominal,projectedCrashTodayRupees:shockReal,
      rateConvention:'EFFECTIVE_ANNUAL_GROWTH',
      contributionTiming:'END_OF_MONTH',illustrativeOnly:true,afterTax:false,
      profileSuitabilityAssessed:false,scenarioOnly:true},
    ...meta,displayValue:parts.join(' '),
  }];
}
