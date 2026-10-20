import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCoveredRegulatoryChatQuestion,
  retrieveQualifiedRegulatoryChatEvidence,
} from '../services/chatRegulatoryRetrieval.js';
import { buildChatEvidencePacket, generateGroundedExplanation } from '../services/groundedExplanationService.js';

const OFFICIAL_URL = 'https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf';
const AUTHORITY = 'Central Board of Direct Taxes, Income Tax Department, Ministry of Finance, Government of India';
const question = 'When did the Income-tax Rules 2026 come into effect?';
const excerpt = 'The Income-tax Rules 2026 came into effect on 1 April 2026 under the applicable statute.';

function approvedResponse() {
  return {
    grounded: true,
    metrics: { response_mode: 'extractive_retrieval' },
    citations: [{
      citation_id: 1, chunk_id: 'doc-a#1', document_title: 'Income-tax Rules, 2026 commencement',
      source: OFFICIAL_URL, excerpt, relevance_score: 0.9,
    }],
    retrieved_chunks: [{
      score: 0.9, rank: 1,
      chunk: {
        chunk_id: 'doc-a#1', content: excerpt, lifecycle_state: 'ACTIVE',
        tenant_id: 'default', scope: 'global',
        metadata: {
          title: 'Income-tax Rules, 2026 commencement',
          source: OFFICIAL_URL,
          author: AUTHORITY,
          publication_date: '2026-03-20',
          effective_date: '2026-04-01',
          source_trust_tier: 'government_official',
          custom_metadata: {
            document_key: 'income-tax-rules-2026-commencement',
            corpus_manifest_sha256: '248ad8a8418f3e763b625625cc6746c93dc74783299f710bfcf58f08917bb1bf',
            content_sha256: '026b9c068c11f89bebd8451cbe7c6568cc2937b0ec19b4b18d327f70c7b78ab2',
          },
        },
      },
    }],
  };
}

test('only manifested regulatory scope may activate RAG retrieval', () => {
  assert.equal(isCoveredRegulatoryChatQuestion(question), true);
  for (const q of [
    'What is the best tax regime for my investments in 2026?',
    'What is my tax deduction under Section 80C?',
    'What is the latest capital gains tax rate?',
    'Which act governs tax year 2026-27?',
    'How do the Income-tax Rules 2026 affect tax deductions?',
    'Which stock should I buy?',
    'Explain portfolio balancing in simple terms',
  ]) assert.equal(isCoveredRegulatoryChatQuestion(q), false, q);
});

test('verified identity is forwarded and only source-identity-pinned chunks enter the chat', async () => {
  let calls = 0;
  const got = await retrieveQualifiedRegulatoryChatEvidence({
    question, userId: 'user-verified-123',
    queryRag: async args => {
      calls += 1;
      assert.deepEqual(args, { query: question, top_k: 2, jurisdiction: 'IN', userId: 'user-verified-123' });
      return approvedResponse();
    },
  });
  assert.equal(calls, 1);
  assert.equal(got.entries.length, 1);
  assert.equal(got.unavailableFacts.length, 0);
  assert.equal(got.entries[0].dataClass, 'OFFICIAL_CORPUS_EXCERPT');
  assert.equal(got.entries[0].source.url, OFFICIAL_URL);
  assert.match(got.entries[0].id, /^E_RAG_[A-F0-9]{12}$/);
});

test('unverified, tenant-scoped, mutated or mismatched chunks cannot become authoritative evidence', async () => {
  const variants = [
    r => { r.retrieved_chunks[0].chunk.scope = 'user:attacker'; },
    r => { r.retrieved_chunks[0].chunk.metadata.source_trust_tier = 'unverified_user_input'; },
    r => { r.retrieved_chunks[0].chunk.metadata.custom_metadata.content_sha256 = 'changed'; },
    r => { r.retrieved_chunks[0].chunk.metadata.source = 'https://attacker.example/phishing'; },
    r => { r.retrieved_chunks[0].chunk.lifecycle_state = 'SOFT_DELETED'; },
    r => { r.citations[0].chunk_id = 'different-chunk'; },
  ];
  for (const mutate of variants) {
    const bad = approvedResponse();
    mutate(bad);
    const result = await retrieveQualifiedRegulatoryChatEvidence({ question, userId: 'user-123', queryRag: async () => bad });
    assert.equal(result.entries.length, 0);
    assert.deepEqual(result.unavailableFacts, ['REGULATORY_RAG_EVIDENCE_NOT_QUALIFIED']);
  }
});

test('untrusted or uncovered queries never invoke the RAG microservice', async () => {
  let calls = 0;
  const queryRag = async () => { calls += 1; return approvedResponse(); };
  const noIdentity = await retrieveQualifiedRegulatoryChatEvidence({ question, queryRag });
  const noCoverage = await retrieveQualifiedRegulatoryChatEvidence({
    question: 'What should I invest in?', userId: 'user-123', queryRag,
  });
  assert.equal(calls, 0);
  assert.deepEqual(noIdentity.entries, []);
  assert.deepEqual(noCoverage.entries, []);
});

test('retrieval outage abstains without claiming current legal correctness', async () => {
  const out = await retrieveQualifiedRegulatoryChatEvidence({
    question, userId: 'user-123', queryRag: async () => { throw new Error('Timed out'); },
  });
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.unavailableFacts, ['REGULATORY_RAG_RETRIEVAL_UNAVAILABLE']);
});

test('chat evidence packet carries source-validated RAG facts but never private saved holdings for public statutory questions', async () => {
  const packet = await buildChatEvidencePacket({
    question, userId: 'user-verified-123',
    profile: { riskTolerance: 'Moderate', monthlySavings: 20000 },
    recommendation: { modelVersion: 'test', instruments: [{ id: 'PRIVATE_HOLDING', allocation_pct: 100 }] },
  }, { queryRegulatoryRag: async () => approvedResponse() });
  assert.ok(packet.entries.some(item => item.kind === 'REGULATORY_REFERENCE' && item.source.url === OFFICIAL_URL));
  assert.ok(packet.entries.some(item => item.id === 'E_REGULATORY_NOTICE'));
  assert.equal(packet.entries.some(item => item.kind === 'RECOMMENDATION' || item.kind === 'PROFILE'), false);
  assert.doesNotMatch(JSON.stringify(packet), /PRIVATE_HOLDING/);
});

test('qualified statutory commencement remains useful without any model provider', async () => {
  const packet = await buildChatEvidencePacket({ question, userId: 'user-123', profile: {}, recommendation: null },
    { queryRegulatoryRag: async () => approvedResponse() });
  const result = await generateGroundedExplanation({ question, evidencePacket: packet }, {
    providers: [], getCache: async () => null, setCache: async () => {},
  });
  assert.equal(result.fallback, true);
  assert.equal(result.validation.status, 'PASS');
  assert.match(result.text, /Income-tax Rules, 2026 took effect on 1 April 2026/);
  assert.ok(result.citations.some(c => c.evidence_class === 'OFFICIAL_CORPUS_EXCERPT'));
});

test('an official-looking chunk lacking the answer cannot be cited for commencement', async () => {
  const bad = approvedResponse();
  bad.retrieved_chunks[0].chunk.content = 'Income-tax Rules 2026 information concerning regulatory updates.';
  const result = await retrieveQualifiedRegulatoryChatEvidence({ question, userId: 'user-123',
    queryRag: async () => bad });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.unavailableFacts, ['REGULATORY_RAG_EVIDENCE_NOT_QUALIFIED']);
});
