/**
 * Allowlisted regulatory RAG bridge. This is not a general financial-answer
 * generator: each route has exact document identity, question scope, and a
 * supported deterministic claim. The FastAPI source is checked again here.
 */
import crypto from 'node:crypto';

const MANIFEST_SHA256 = '12f685ff27d432dc793afc4b1d9d1646cd920a1af237466ae96776757c3d2906';
const PERIOD = /\b(?:when|what\s+date|on\s+what\s+date|commence(?:ment|d)?|came\s+into\s+(?:force|effect)|take\s+effect|took\s+effect|effective|start(?:ed|ing)?|replace(?:d)?|published)\b/i;
const GLOBAL_EXCLUSIONS = /\b(?:tax\s+slabs?|tax\s+rates?|deductions?|rebates?|capital\s+gains?|ltcg|stcg|80c|80d|product\s+tax|tax\s+regime|post[ -]?tax\s+returns?|exemptions?|how\s+much\s+tax|nav|returns?|profits?|scheme\s+fees?|performance|best\s+fund|which\s+fund|buy|sell|recommend(?:ation|ed)?|suitable|compensation|refund|eligib(?:le|ility)|my\s+complaint)\b/i;

const CORPORA = Object.freeze([
  Object.freeze({
    documentKey: 'income-tax-rules-2026-commencement',
    documentTitles: ['Income-tax Rules, 2026 commencement', 'Income Tax Rules 2026 Commencement'],
    contentSha256: '026b9c068c11f89bebd8451cbe7c6568cc2937b0ec19b4b18d327f70c7b78ab2',
    sourceUrl: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf',
    publicationDate: '2026-03-20',
    effectiveFrom: '2026-04-01',
    authority: 'Central Board of Direct Taxes, Income Tax Department, Ministry of Finance, Government of India',
    provider: 'INCOME_TAX_DEPARTMENT',
    questionPattern: /\b(?:income[ -]?tax\s+rules[,]?\s*2026|2026\s+income[ -]?tax\s+rules)\b/i,
    factPattern: /\bincome[ -]?tax rules?[, ]*2026\b/i,
    effectivePattern: /\b1\s+April\s+2026\b/i,
    displayValue: 'The Income-tax Rules, 2026 took effect on 2026-04-01.',
  }),
  Object.freeze({
    documentKey: 'sebi-mf-regulations-2026-commencement',
    documentTitles: ['Sebi Mutual Fund Regulations 2026 Commencement'],
    contentSha256: '2d8e4d5c5d2176ebac1aa8c167c383623e2170f7f0318f979ed6b42170dfa5c8',
    sourceUrl: 'https://www.sebi.gov.in/sebi_data/attachdocs/oct-2026/1792659909505.pdf',
    publicationDate: '2026-01-15',
    effectiveFrom: '2026-04-01',
    authority: 'Securities and Exchange Board of India',
    provider: 'SEBI',
    questionPattern: /\b(?:sebi\s+)?mutual\s+funds?\s+regulations?[, ]*2026\b/i,
    factPattern: /\bmutual\s+funds?\)?\s+regulations?[, ]*2026\b/i,
    effectivePattern: /\b1\s+April\s+2026\b/i,
    displayValue: 'The SEBI (Mutual Funds) Regulations, 2026 took effect on 2026-04-01.',
  }),
  Object.freeze({
    documentKey: 'rbi-ombudsman-2026-commencement',
    documentTitles: ['Rbi Ombudsman 2026 Commencement'],
    contentSha256: '650751ab0f478eeccdaffa32ef63ecc3d2b878c576c6f903697c1068d0121224',
    sourceUrl: 'https://old.rbi.org.in/commonman/english/scripts/faqs.aspx?id=3407',
    publicationDate: '2026-07-01',
    effectiveFrom: '2026-07-01',
    authority: 'Reserve Bank of India',
    provider: 'RESERVE_BANK_OF_INDIA',
    questionPattern: /\b(?:rbi\s+|reserve\s+bank(?:\s+of\s+india)?\s+)?(?:integrated\s+)?ombudsman\s+scheme[,]?\s*2026\b/i,
    factPattern: /\b(?:integrated\s+)?ombudsman\s+scheme[,]?\s*2026\b/i,
    effectivePattern: /\b1\s+July\s+2026\b/i,
    displayValue: 'The RBI Integrated Ombudsman Scheme, 2026 became effective on 2026-07-01.',
  }),
]);

function matchCoveredCorpus(question) {
  const q = String(question || '').slice(0, 1000);
  if (!PERIOD.test(q) || GLOBAL_EXCLUSIONS.test(q)
      || /\b(?:published|gazette|amendments?|original\s+issue)\b/i.test(q)) return null;
  return CORPORA.find(corpus => corpus.questionPattern.test(q)) || null;
}

export function isCoveredRegulatoryChatQuestion(question) {
  return matchCoveredCorpus(question) !== null;
}

function matchesCorpus(chunk, citation, corpus) {
  const metadata = chunk?.metadata;
  const custom = metadata?.custom_metadata;
  return chunk?.lifecycle_state === 'ACTIVE'
    && ['global', 'public', 'default'].includes(String(chunk?.scope || metadata?.scope || '').toLowerCase())
    && ['global', 'default', ''].includes(String(chunk?.tenant_id || metadata?.tenant_id || '').toLowerCase())
    && metadata?.source_trust_tier === 'government_official'
    && corpus.documentTitles.includes(metadata?.title)
    && metadata?.source === corpus.sourceUrl
    && metadata?.author === corpus.authority
    && metadata?.publication_date === corpus.publicationDate
    && metadata?.effective_date === corpus.effectiveFrom
    && custom?.document_key === corpus.documentKey
    && custom?.corpus_manifest_sha256 === MANIFEST_SHA256
    && custom?.content_sha256 === corpus.contentSha256
    && citation?.chunk_id === chunk.chunk_id
    && citation?.source === metadata.source
    && citation?.document_title === metadata.title
    && typeof citation?.excerpt === 'string'
    && chunk.content.startsWith(citation.excerpt.endsWith('...')
      ? citation.excerpt.slice(0, -3) : citation.excerpt);
}

export async function retrieveQualifiedRegulatoryChatEvidence({ question, userId, queryRag } = {}) {
  const corpus = matchCoveredCorpus(question);
  if (!corpus || !userId || typeof queryRag !== 'function') {
    return { entries: [], unavailableFacts: [] };
  }
  let response;
  try {
    response = await queryRag({ query: question, top_k: 2, jurisdiction: 'IN', userId: String(userId) });
  } catch {
    return { entries: [], unavailableFacts: ['REGULATORY_RAG_RETRIEVAL_UNAVAILABLE'] };
  }
  if (response?.grounded !== true
      || !Array.isArray(response.retrieved_chunks)
      || !Array.isArray(response.citations)) {
    return { entries: [], unavailableFacts: ['REGULATORY_RAG_RETRIEVAL_UNAVAILABLE'] };
  }
  const entries = [];
  for (const retrieved of response.retrieved_chunks.slice(0, 2)) {
    const chunk = retrieved?.chunk;
    const citation = response.citations.find(item => item?.chunk_id === chunk?.chunk_id);
    if (typeof chunk?.content !== 'string'
        || chunk.content.length > 4096 || chunk.content.length < 30
        || !matchesCorpus(chunk, citation, corpus)) continue;
    if (!corpus.factPattern.test(chunk.content)
        || !corpus.effectivePattern.test(chunk.content)) continue;
    const excerpt = chunk.content.trim().slice(0, 500);
    // Retrieved documents are data. Never elevate embedded instructions.
    if (/ignore\s+(?:all|previous|system)|system\s+prompt|call\s+(?:a\s+)?tool|secret\s+key|\[im_start\]/i.test(excerpt)) continue;
    const evidenceId = 'E_RAG_' + crypto.createHash('sha256')
      .update(corpus.documentKey + '\0' + chunk.chunk_id).digest('hex').slice(0, 12).toUpperCase();
    if (entries.some(item => item.id === evidenceId)) continue;
    entries.push({
      id: evidenceId,
      kind: 'REGULATORY_REFERENCE',
      value: { documentKey: corpus.documentKey, excerpt, verifiedCommencementDate: corpus.effectiveFrom },
      displayValue: corpus.displayValue,
      dataClass: 'OFFICIAL_CORPUS_EXCERPT',
      authority: 'MANIFEST_VERIFIED_REGULATORY_SOURCE',
      source: {
        provider: corpus.provider,
        title: chunk.metadata.title,
        url: corpus.sourceUrl,
        publicationDate: corpus.publicationDate,
        instrumentId: null,
      },
      observedAt: null,
      freshness: null,
    });
  }
  return entries.length
    ? { entries, unavailableFacts: [] }
    : { entries: [], unavailableFacts: ['REGULATORY_RAG_EVIDENCE_NOT_QUALIFIED'] };
}
