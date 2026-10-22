/**
 * Narrow, fail-closed bridge from GenieChat to the separately verified
 * FastAPI regulatory RAG corpus. Only topics covered by the committed
 * manifest are eligible. Never promote user-uploaded or tenant evidence
 * into authoritative financial facts.
 */
import crypto from 'node:crypto';

const CORPUS = Object.freeze({
  documentKey: 'income-tax-rules-2026-commencement',
  documentTitle: 'Income-tax Rules, 2026 commencement',
  manifestSha256: '248ad8a8418f3e763b625625cc6746c93dc74783299f710bfcf58f08917bb1bf',
  contentSha256: '026b9c068c11f89bebd8451cbe7c6568cc2937b0ec19b4b18d327f70c7b78ab2',
  sourceUrl: 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf',
  publicationDate: '2026-03-20',
  effectiveFrom: '2026-04-01',
  authority: 'Central Board of Direct Taxes, Income Tax Department, Ministry of Finance, Government of India',
});

/** Exact source-coverage routing, not general tax-product question matching. */
export function isCoveredRegulatoryChatQuestion(question) {
  const query = String(question || '').slice(0, 1000);
  // The single approved document supports multiple topics, but this bridge
  // synthesizes only the commencement answer verified in the same excerpt.
  const topic = /\b(?:income[ -]?tax\s+rules[,]?\s*2026|2026\s+income[ -]?tax\s+rules)\b/i.test(query);
  const period = /\b(?:when|what\s+date|commence(?:ment|d)?|came\s+into\s+(?:force|effect)|take\s+effect|took\s+effect|effective|start(?:ed|ing)?)\b/i.test(query);
  const excluded = /\b(?:tax\s+slabs?|tax\s+rates?|deductions?|rebates?|capital\s+gains?|ltcg|stcg|80c|80d|product\s+tax|tax\s+regime|post[ -]?tax\s+returns?|exemptions?|how\s+much\s+tax)\b/i.test(query);
  return topic && period && !excluded;
}

function matchesCorpus(chunk, citation) {
  const metadata = chunk?.metadata;
  const custom = metadata?.custom_metadata;
  return chunk?.lifecycle_state === 'ACTIVE'
    && ['global', 'public', 'default'].includes(String(chunk?.scope || metadata?.scope || '').toLowerCase())
    && ['global', 'default', ''].includes(String(chunk?.tenant_id || metadata?.tenant_id || '').toLowerCase())
    && metadata?.source_trust_tier === 'government_official'
    && metadata?.title === CORPUS.documentTitle
    && metadata?.source === CORPUS.sourceUrl
    && metadata?.author === CORPUS.authority
    && metadata?.publication_date === CORPUS.publicationDate
    && metadata?.effective_date === CORPUS.effectiveFrom
    && custom?.document_key === CORPUS.documentKey
    && custom?.corpus_manifest_sha256 === CORPUS.manifestSha256
    && custom?.content_sha256 === CORPUS.contentSha256
    && citation?.chunk_id === chunk.chunk_id
    && citation?.source === metadata.source
    && citation?.document_title === metadata.title;
}

/**
 * The FastAPI retriever already validates its authoritative manifest, corpus
 * generation, relevance, scope and document lifecycle. This second boundary
 * checks each returned claim against the exact approved corpus identity before
 * it can enter the chat model's evidence packet.
 */
export async function retrieveQualifiedRegulatoryChatEvidence({
  question,
  userId,
  queryRag,
} = {}) {
  if (!isCoveredRegulatoryChatQuestion(question) || !userId || typeof queryRag !== 'function') {
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
    if (!matchesCorpus(chunk, citation)) continue;
    if (typeof chunk.content !== 'string' || chunk.content.length > 6000 || chunk.content.length < 30) continue;
    // A relevant retrieved chunk is not necessarily an answering chunk.
    // This release's approved corpus supports only the Rules' commencement.
    // Do not create a factual answer unless the same chunk explicitly contains
    // both the statute and its effective date.
    if (!/income[ -]?tax rules?[, ]*2026/i.test(chunk.content)
        || !/\b1\s+April\s+2026\b/i.test(chunk.content)) continue;
    const excerpt = chunk.content.trim().slice(0, 500);
    // Retrieved documents are data, never instructions or executable tools.
    if (/ignore\s+(?:all|previous|system)|system\s+prompt|call\s+(?:a\s+)?tool|secret\s+key/i.test(excerpt)) continue;
    const evidenceId = 'E_RAG_' + crypto.createHash('sha256').update(chunk.chunk_id).digest('hex').slice(0, 12).toUpperCase();
    if (entries.some(item => item.id === evidenceId)) continue;
    entries.push({
      id: evidenceId,
      kind: 'REGULATORY_REFERENCE',
      value: { documentKey: CORPUS.documentKey, excerpt, verifiedCommencementDate: CORPUS.effectiveFrom },
      displayValue: 'The Income-tax Rules, 2026 took effect on 2026-04-01.',
      dataClass: 'OFFICIAL_CORPUS_EXCERPT',
      authority: 'MANIFEST_VERIFIED_REGULATORY_SOURCE',
      source: {
        provider: 'INCOME_TAX_DEPARTMENT',
        title: CORPUS.documentTitle,
        url: CORPUS.sourceUrl,
        publicationDate: CORPUS.publicationDate,
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
