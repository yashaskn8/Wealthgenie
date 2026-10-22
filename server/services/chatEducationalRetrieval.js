/**
 * Curated, bounded retrieval for jurisdiction-neutral investor education.
 *
 * This is deliberately NOT a substitute for the independently qualified RAG
 * regulatory corpus or the authoritative investment recommendation engine.
 * Sources are public educational pages; do not use them to infer India-specific
 * product terms, suitability, taxes, returns, or government endorsements.
 *
 * To extend: independently review the source and claim, add a narrow intent
 * matcher, then add retrieval, provenance, and false-positive regression tests.
 */
const EDUCATIONAL_DOCUMENTS = Object.freeze([
  Object.freeze({
    id: 'E_EDU_REBALANCING',
    title: 'Rebalancing',
    url: 'https://www.investor.gov/introduction-investing/getting-started/asset-allocation',
    intent: /\b(?:rebalanc(?:e|ing)|re-?balanc(?:e|ing)|portfolio\s+balanc(?:e|ing)|balanc(?:e|ing)\s+(?:my\s+|a\s+|the\s+)?portfolio|asset\s+allocation\s+drift)\b/i,
    explanation: [
      'Portfolio rebalancing brings investments back toward a chosen asset mix after market movements shift their relative weights.',
      'Why it matters: if one asset class grows faster, it can become a larger part of the portfolio and change the risk level you originally chose.',
      'For example, a portfolio that started with shares and bonds can become more share-heavy after shares rise. Restoring the target mix can involve adding money to other asset classes or selling part of the overweight holding.',
      'How investors review it: some check at regular intervals; others check when the mix moves beyond a preset threshold. Rebalancing manages allocation drift, but it does not guarantee a profit or prevent losses.',
    ].join('\n\n'),
  }),
  Object.freeze({
    id: 'E_EDU_DIVERSIFICATION',
    title: 'Asset Allocation and Diversification',
    url: 'https://www.investor.gov/introduction-investing/getting-started/asset-allocation',
    intent: /\b(?:diversif(?:y|ication|ied)|diversify|spread\s+(?:my\s+)?investments|different\s+asset\s+classes)\b/i,
    explanation: 'Diversification means spreading investments across different assets or holdings so that a loss in one does not determine the outcome of the entire portfolio. It reduces concentration risk but cannot eliminate investment losses.',
  }),
  Object.freeze({
    id: 'E_EDU_ASSET_ALLOCATION',
    title: 'Asset Allocation and Diversification',
    url: 'https://www.investor.gov/introduction-investing/getting-started/asset-allocation',
    intent: /\b(?:asset\s+allocation|investment\s+mix|portfolio\s+mix|stocks?\s+(?:and|versus|vs)\s+bonds?)\b/i,
    explanation: 'Asset allocation means dividing investments among categories such as shares, bonds and cash. A target mix depends on the goal, time horizon and capacity to accept risk; no allocation is automatically suitable for every investor.',
  }),
  Object.freeze({
    id: 'E_EDU_COMPOUND_GROWTH',
    title: 'Introduction to Investing',
    url: 'https://www.investor.gov/introduction-investing',
    intent: /\b(?:compound(?:ing|ed)?\s+(?:growth|interest|returns?)|power\s+of\s+compounding|how\s+does\s+compounding\s+work)\b/i,
    explanation: 'Compound growth happens when invested money earns returns and those returns also begin earning returns when they remain invested. Actual market returns vary, and compounding does not guarantee a positive outcome.',
  }),
  Object.freeze({
    id: 'E_EDU_INVESTING_READINESS',
    title: 'Investing: Let’s Understand',
    url: 'https://investor.sebi.gov.in/why_one_should_invest.html',
    provider: 'SEBI_INVESTOR',
    intent: /\b(?:start\s+(?:my\s+)?first\s+investment|how\s+(?:do|can)\s+i\s+start\s+investing|investing\s+for\s+beginners|what\s+is\s+investing)\b/i,
    explanation: 'Before investing, make sure everyday expenses are covered and keep an emergency fund for unexpected events. Once that foundation is in place, small regular contributions can be a way to start; the amount and product still depend on your circumstances.',
  }),
  Object.freeze({
    id: 'E_EDU_INVESTING_BASICS',
    title: 'Factors to Consider Before Investing',
    url: 'https://investor.sebi.gov.in/investment-thingsbeforeinv.html',
    provider: 'SEBI_INVESTOR',
    intent: /\b(?:start\s+(?:my\s+)?first\s+investment|how\s+(?:do|can)\s+i\s+start\s+investing|investing\s+for\s+beginners|what\s+is\s+investing)\b/i,
    explanation: [
      'A practical first step is to name one financial goal and when you will need the money. That time horizon helps narrow the kinds of investments that may fit.',
      'Next, assess how much fluctuation or loss you can tolerate. Learn the basic options, then compare their safety, liquidity and potential return before choosing anything.',
      'Choose only an option that fits your goal and risk profile, and review it as your circumstances change. No investment return is guaranteed, and past performance does not promise a future result.',
    ].join('\n\n'),
  }),
  Object.freeze({
    id: 'E_EDU_FEES',
    title: 'How Fees and Expenses Affect Your Investment Portfolio',
    url: 'https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins/updated',
    intent: /\b(?:expense\s+ratio|investment\s+fees?|portfolio\s+fees?|fund\s+fees?|transaction\s+costs?|investment\s+costs?)\b/i,
    explanation: 'Investment fees and transaction costs reduce the amount of money that remains invested and can reduce long-term returns. Compare the applicable fee disclosures and distinguish one-time transaction charges from ongoing costs.',
  }),
]);

/**
 * Conservative exact-intent retrieval: no user/profile data, no external
 * network access, no mutable or user-supplied documents, no similarity-based
 * trust elevation. Non-matches return no documents, not a fabricated answer.
 */
export function retrieveChatEducationalEvidence(question, { maxEntries = 2 } = {}) {
  const text = String(question || '').slice(0, 1000);
  if (!text.trim()) return [];
  const limit = Number.isSafeInteger(maxEntries) ? Math.max(0, Math.min(maxEntries, 2)) : 2;
  return EDUCATIONAL_DOCUMENTS
    .filter(doc => doc.intent.test(text))
    .slice(0, limit)
    .map(doc => ({
      id: doc.id,
      kind: 'EDUCATION',
      value: { topic: doc.id, educationalOnly: true, jurisdictionNeutral: true },
      displayValue: doc.explanation,
      dataClass: 'CURATED_PUBLIC_EDUCATION',
      source: {
        provider: doc.provider || 'US_SEC_INVESTOR_GOV',
        title: doc.title,
        url: doc.url,
        publicationDate: null,
        instrumentId: null,
      },
      observedAt: null,
      freshness: null,
      authority: 'PUBLIC_EDUCATIONAL_SOURCE',
    }));
}
