const normalizeIndicJoiners=text=>text.replace(/([\u0900-\u097F\u0C80-\u0CFF])[\u200C\u200D](?=[\u0900-\u097F\u0C80-\u0CFF])/gu,'$1');

/**
 * Curated, language-reviewed basic financial education. These are
 * WealthGenie-authored explanations referencing public investor education,
 * NOT direct regulator quotations or claims about up-to-date tax/products.
 * Never use these templates for suitability, forecasts or allocations.
 */
const BASE_SOURCE={
  provider:'SEBI_INVESTOR',
  title:'Factors to Consider Before Investing (general background reference)',
  url:'https://investor.sebi.gov.in/investment-thingsbeforeinv.html',
  publicationDate:null,
  instrumentId:null,
};
const TOPICS=Object.freeze([
  {
    id:'E_INDIC_SIP_BASICS',
    topic:/(?:एसआईपी|सिप|ಮಾಸಿಕ ಹೂಡಿಕೆ|ಎಸ್.?ಐ.?ಪಿ|ಸಿಪ್)/iu,
    hi:'एसआईपी यानी सिस्टमैटिक इन्वेस्टमेंट प्लान, म्यूचुअल फंड में नियमित अंतराल पर निवेश करने की विधि है। इससे निवेश का अनुशासन बन सकता है, लेकिन बाजार में नुकसान संभव है और कोई रिटर्न निश्चित नहीं है।',
    kn:'ಎಸ್‌ಐಪಿ ಎಂದರೆ ಮ್ಯೂಚುವಲ್ ಫಂಡ್‌ನಲ್ಲಿ ನಿಯಮಿತವಾಗಿ ಹಣ ಹೂಡುವ ಒಂದು ವಿಧಾನ. ಇದು ಹೂಡಿಕೆಯ ಶಿಸ್ತಿಗೆ ಸಹಾಯ ಮಾಡಬಹುದು. ಮಾರುಕಟ್ಟೆಯಲ್ಲಿ ನಷ್ಟ ಸಂಭವಿಸಬಹುದು; ಯಾವುದೇ ಆದಾಯ ಖಚಿತವಲ್ಲ.',
  },
  {
    id:'E_INDIC_COMPOUNDING',
    topic:/(?:चक्रवृद्धि|कंपाउंडिंग|चक्रवृद्धि ब्याज|ಚಕ್ರಬಡ್ಡಿ|ಚಕ್ರವಡ್ಡಿ|ಕಾಂಪೌಂಡಿಂಗ್)/iu,
    hi:'चक्रवृद्धि का मतलब है कि पहले की कमाई पर भी आगे कमाई हो सकती है, यदि वह राशि निवेशित रहती है। निवेश पर रिटर्न घट-बढ़ सकता है; यह गारंटीकृत वृद्धि नहीं है।',
    kn:'ಚಕ್ರಬಡ್ಡಿ ಎಂದರೆ ಹಿಂದೆ ಬಂದ ಲಾಭವೂ ಹೂಡಿಕೆಯಲ್ಲಿಯೇ ಉಳಿದರೆ ಅದರ ಮೇಲೂ ಮುಂದಿನ ಲಾಭ ಬರಬಹುದಾಗಿದೆ. ಹೂಡಿಕೆಯ ಆದಾಯ ಬದಲಾಗಬಹುದು; ಇದು ಖಚಿತ ಬೆಳವಣಿಗೆಯಲ್ಲ.',
  },
  {
    id:'E_INDIC_DIVERSIFICATION',
    topic:/(?:विविधीकरण|डाइवर्सिफिकेशन|निवेश फैलाना|ವೈವಿಧ್ಯೀಕರಣ|ಹೂಡಿಕೆ ವೈವಿಧ್ಯ|ವಿವಿಧ ಹೂಡಿಕೆ)/iu,
    hi:'विविधीकरण में पैसा अलग-अलग निवेशों या संपत्ति वर्गों में बाँटा जाता है, ताकि केवल एक निवेश का परिणाम पूरे पोर्टफोलियो को निर्धारित न करे। इससे कुछ जोखिम घट सकता है, लेकिन नुकसान की संभावना समाप्त नहीं होती।',
    kn:'ವೈವಿಧ್ಯೀಕರಣ ಎಂದರೆ ಹಣವನ್ನು ವಿವಿಧ ಹೂಡಿಕೆಗಳು ಅಥವಾ ಆಸ್ತಿ ವರ್ಗಗಳಲ್ಲಿ ಹಂಚುವುದು. ಇದರಿಂದ ಒಂದೇ ಹೂಡಿಕೆಯ ಮೇಲೆ ಅವಲಂಬನೆ ಕಡಿಮೆಯಾಗಬಹುದು, ಆದರೆ ನಷ್ಟದ ಅಪಾಯ ಸಂಪೂರ್ಣವಾಗಿ ಹೋಗುವುದಿಲ್ಲ.',
  },
  {
    id:'E_INDIC_INFLATION',
    topic:/(?:महंगाई|महँगाई|मुद्रास्फीति|ಹಣದುಬ್ಬರ)/iu,
    hi:'महंगाई बढ़ने से समान राशि की खरीदने की क्षमता समय के साथ कम हो सकती है। इसलिए भविष्य के लक्ष्य की योजना बनाते समय राशि और अवधि के साथ महंगाई का अलग अनुमान जाँचना उपयोगी है। यह किसी खास निवेश के रिटर्न का अनुमान नहीं है।',
    kn:'ಹಣದುಬ್ಬರ ಹೆಚ್ಚಿದಂತೆ ಒಂದೇ ಮೊತ್ತದಿಂದ ಖರೀದಿಸಬಹುದಾದ ವಸ್ತುಗಳ ಪ್ರಮಾಣ ಕಡಿಮೆಯಾಗಬಹುದು. ಆದ್ದರಿಂದ ಭವಿಷ್ಯದ ಗುರಿಗೆ ಹಣದುಬ್ಬರದ ಊಹೆಯನ್ನು ಪ್ರತ್ಯೇಕವಾಗಿ ಪರಿಶೀಲಿಸುವುದು ಉಪಯುಕ್ತ. ಇದು ಹೂಡಿಕೆಯ ಆದಾಯದ ಮುನ್ಸೂಚನೆ ಅಲ್ಲ.',
  },
]);
const ASK = /(?:क्या\s+(?:है|होता)|समझाओ|समझाइए|बताओ|बताइए|कैसे|अर्थ|ಏನು|ಎಂದರೇನು|ವಿವರಿಸಿ|ತಿಳಿಸಿ|ಹೇಗೆ|ಅರ್ಥ)/iu;
const PERSONAL = /(?:मेरे\s+लिए|मेरे\s+निवेश|मुझे\s+कौन|मेरी\s+अलोकेशन|ನನಗೆ\s+ಯಾವ|ನನ್ನ\s+ಹೂಡಿಕೆಗೆ|ನನ್ನ\s+ಹಣದ)/iu;
export function retrieveIndicFinancialEducation(rawQuestion) {
  if(typeof rawQuestion!=='string' || rawQuestion.length>1000)return [];
  const question=normalizeIndicJoiners(rawQuestion);
  if(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(question) ||
    PERSONAL.test(question) || !ASK.test(question))return [];
  const kn=(question.match(/[ಕ-ಹ]/gu)||[]).length;
  const hi=(question.match(/[क-ह]/gu)||[]).length;
  const lang=kn>hi?'kn':hi>0?'hi':null;
  if(!lang)return [];
  const matches=TOPICS.filter(topic=>topic.topic.test(question));
  if(matches.length!==1)return []; // mixed topic needs a direct follow-up
  const topic=matches[0];
  return [{
    id:topic.id,
    kind:'EDUCATION',
    value:{topic:topic.id,jurisdictionNeutral:true,individualRecommendation:false,
      translationAuthorship:'WEALTHGENIE_CURATED'},
    displayValue:topic[lang],
    dataClass:'CURATED_PUBLIC_EDUCATION',
    authority:'WEALTHGENIE_CURATED_EDUCATION',
    source:{...BASE_SOURCE},
    observedAt:null,freshness:null,
  }];
}
