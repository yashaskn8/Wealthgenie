/**
 * Conservative question-to-feature routing.
 *
 * This module recommends one existing first-party screen. It never supplies
 * investment advice, invokes a calculator, executes navigation, or trusts LLM
 * output for URLs. Ambiguous questions produce no card. A visible user click
 * is mandatory before any navigation.
 */
export const FEATURE_CARD_VERSION = 'genie-feature-card-v1';
const DEFINITIONS = Object.freeze([
  Object.freeze({
    key: 'goal',
    page: 'goals',
    label: 'Explore Goal Planner',
    description: 'Set a target and review goal-funding scenarios.',
    patterns: [
      /\b(?:retirement|college|university|wedding|marriage|education\s+fund|down\s*payment|financial\s+goal|goal\s+corpus|goal\s+planner)\b/i,
      /\b(?:save|saving|fund|afford|plan)\b.{0,35}\b(?:home|house|child|education|retirement|wedding|college)\b/i,
      /(?:लक्ष्य|बच्चे की पढ़ाई|शिक्षा का लक्ष्य|सेवानिवृत्ति|गृह लक्ष्य|ಗುರಿ|ಮಕ್ಕಳ ಶಿಕ್ಷಣ|ನಿವೃತ್ತಿ|ಮನೆ ಖರೀದಿ)/iu,
    ],
  }),
  Object.freeze({
    key: 'sip',
    page: 'grow-my-sip',
    label: 'Explore SIP Growth Planner',
    description: 'Review monthly-contribution and hypothetical growth scenarios.',
    patterns: [
      /\b(?:sips?|systematic\s+investment\s+plan|step[- ]?up\s+(?:sip|contribution)|monthly\s+investment|monthly\s+contribution)\b/i,
      /\b(?:increase|decrease|change)\b.{0,30}\b(?:monthly\s+savings|monthly\s+contribution)\b/i,
      /(?:एसआईपी|मासिक निवेश|सिप|ಎಸ್.?ಐ.?ಪಿ|ಸಿಪ್|ತಿಂಗಳ ಹೂಡಿಕೆ)/iu,
    ],
  }),
  Object.freeze({
    key: 'tax',
    page: 'taxes',
    label: 'Explore Tax Analysis',
    description: 'Review tax-related calculations and their assumptions.',
    patterns: [
      /\b(?:income[- ]?tax|tax(?:es|ation|able)?|capital\s+gains?|ltcg|stcg|tax\s+regime|post[- ]?tax|after[- ]?tax|tax[- ]?saving)\b/i,
      /(?:आयकर|टैक्स|कर गणना|कर विश्लेषण|ತೆರಿಗೆ|ಆದಾಯ ತೆರಿಗೆ)/iu,
    ],
  }),
  Object.freeze({
    key: 'allocation',
    page: 'keep-on-track',
    label: 'Explore Investment Mix Planner',
    description: 'Review allocation drift and risk exposure; no trades are placed.',
    patterns: [
      /\b(?:rebalanc(?:e|ing)|allocation\s+drift|portfolio\s+drift|portfolio\s+risk|asset\s+allocation|investment\s+mix|market\s+(?:crash|correction)|stock\s+market\s+falls?|portfolio\s+(?:falls?|crash(?:es)?)|drawdown)\b/i,
      /(?:पोर्टफोलियो|जोखिम|बाजार गिरावट|पुनर्संतुलन|ಪೋರ್ಟ್.?ಫೋಲಿಯೋ|ಅಪಾಯ|ಮಾರುಕಟ್ಟೆ ಕುಸಿತ|ಮರುಸಮತೋಲನ)/iu,
    ],
  }),
  Object.freeze({
    key: 'investment',
    page: 'investments',
    label: 'Explore Investment Options',
    description: 'Learn about available investment categories and product evidence.',
    patterns: [
      /\b(?:where\s+to\s+invest|investment\s+options?|compare\s+(?:funds?|etfs?|bonds?|investments?)|mutual\s+funds?|index\s+funds?|exchange[- ]?traded\s+funds?|etfs?|fixed\s+deposits?|government\s+bonds?)\b/i,
      /(?:निवेश विकल्प|म्यूचुअल फंड|इंडेक्स फंड|हूಡಿಕೆ ಆಯ್ಕೆಗಳು|ಹೂಡಿಕೆ ಆಯ್ಕೆಗಳು|ಮ್ಯೂಚುವಲ್ ಫಂಡ್)/iu,
    ],
  }),
  Object.freeze({
    key: 'plan',
    page: 'plan',
    label: 'Explore Your Investment Plan',
    description: 'Review the existing investment plan and its assumptions.',
    patterns: [
      /\b(?:my\s+investment\s+plan|my\s+recommendations?|my\s+financial\s+plan|my\s+proposed\s+allocation)\b/i,
    ],
  }),
  Object.freeze({
    key: 'progress',
    page: 'progress',
    label: 'Explore Progress',
    description: 'Review goal-progress tools and related planning sections.',
    patterns: [
      /\b(?:my\s+goal\s+progress|track\s+my\s+goals?|goal\s+status|progress\s+toward\s+my\s+goal)\b/i,
    ],
  }),
]);

const INVALID = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|https?:\/\/|www\.|[{}<>;]/iu;
const UNSAFE_INSTRUCTION = /\b(?:ignore\s+(?:all|previous|system)|developer\s+instructions?|system\s+prompt|override\s+policy)\b/i;

/**
 * Result shape is intentionally identical across user intents. Consumers
 * independently check the page and render only local, canonical labels.
 */
export function suggestWealthGenieFeature(rawQuestion) {
  if (typeof rawQuestion !== 'string' || !rawQuestion || rawQuestion.length > 1000 ||
      INVALID.test(rawQuestion) || UNSAFE_INSTRUCTION.test(rawQuestion)) return [];
  const question = rawQuestion.trim();
  if (!question) return [];
  const matches = DEFINITIONS
    .filter(feature => feature.patterns.some(pattern => pattern.test(question)));
  // Rather than guessing on multi-feature questions, abstain. Never decide
  // based on a speculative product recommendation or financial return.
  if (matches.length !== 1) return [];
  const feature = matches[0];
  return [Object.freeze({
    version: FEATURE_CARD_VERSION,
    kind: 'FEATURE_NAVIGATION_SUGGESTION',
    page: feature.page,
    tab: null,
    label: feature.label,
    description: feature.description,
    requiresUserClick: true,
  })];
}
