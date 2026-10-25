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
