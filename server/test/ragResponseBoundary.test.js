import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRagResponse } from '../services/mlServiceContract.js';

function response() {
  return {
    answer: 'Verified excerpt', grounded: true, metrics: {},
    retrieved_chunks: [{
      chunk: {
        chunk_id: 'doc#1', lifecycle_state: 'ACTIVE', content: 'Verified legal passage.',
        metadata: { title: 'Official document', source: 'https://example.gov.in/document' },
      },
    }],
    citations: [{
      chunk_id: 'doc#1', document_title: 'Official document',
      source: 'https://example.gov.in/document', excerpt: 'Verified legal passage.',
    }],
  };
}

test('grounded RAG response requires matching active chunks and citations', () => {
  assert.ok(normalizeRagResponse(response()));
  for (const mutate of [
    x => { x.retrieved_chunks = []; },
    x => { x.citations = []; },
    x => { x.citations[0].chunk_id = 'unrelated'; },
    x => { x.citations[0].source = 'https://example.com/forged'; },
    x => { x.citations[0].document_title = 'Forger'; },
    x => { x.citations[0].excerpt = 'Unrelated evidence'; },
    x => { x.retrieved_chunks[0].chunk.lifecycle_state = 'SOFT_DELETED'; },
    x => { x.retrieved_chunks.push(x.retrieved_chunks[0]); },
  ]) {
    const invalid = response();
    mutate(invalid);
    assert.equal(normalizeRagResponse(invalid), null);
  }
});

test('ungrounded results cannot smuggle citations or passages downstream', () => {
  const ungrounded = response();
  ungrounded.grounded = false;
  const result = normalizeRagResponse(ungrounded);
  assert.equal(result.grounded, false);
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.retrieved_chunks, []);
});

test('citation cannot be an ellipsis or a metadata identity swap', () => {
  for (const mutate of [
    data => { data.citations[0].excerpt = '...'; },
    data => { data.citations[0].excerpt = '  ... '; },
    data => { data.citations[0].excerpt = 'Ver...'; },
    data => { data.retrieved_chunks[0].chunk.document_id = 'doc-real'; data.retrieved_chunks[0].chunk.metadata.document_id = 'doc-forged'; },
    data => { data.retrieved_chunks[0].chunk.metadata.chunk_id = 'different#1'; },
  ]) {
    const forged = response();
    mutate(forged);
    assert.equal(normalizeRagResponse(forged), null);
  }
});

test('literal citation ellipsis must retain substantive text', () => {
  const valid = response();
  valid.citations[0].excerpt = 'Verified legal passage...';
  assert.ok(normalizeRagResponse(valid));
});

test('RAG transport enforces resource budgets against oversized upstream evidence', () => {
  const hugeAnswer = response();
  hugeAnswer.answer = 'x'.repeat(10001);
  assert.equal(normalizeRagResponse(hugeAnswer), null);
  const hugeChunk = response();
  hugeChunk.retrieved_chunks[0].chunk.content = 'x'.repeat(16001);
  assert.equal(normalizeRagResponse(hugeChunk), null);
  const hugeExcerpt = response();
  hugeExcerpt.citations[0].excerpt = 'a'.repeat(4097);
  assert.equal(normalizeRagResponse(hugeExcerpt), null);
  const manyChunks = response();
  manyChunks.retrieved_chunks = Array.from({ length: 21 }, (_, index) => ({
    chunk: {
      ...manyChunks.retrieved_chunks[0].chunk,
      chunk_id: 'doc#' + index,
    },
  }));
  assert.equal(normalizeRagResponse(manyChunks), null);
});
