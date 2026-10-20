import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { streamPlanReviewEvents } from '../agents/planReview/planReviewEventStream.js';

class FakeResponse extends EventEmitter {
  chunks = [];
  ended = false;
  write(value) { this.chunks.push(value); return true; }
  end() { this.ended = true; this.emit('close'); }
}

test('streams only ordered owned events and closes on a terminal run', async () => {
  const response = new FakeResponse();
  await streamPlanReviewEvents({
    response, initialSequence: 3,
    loadEvents: async since => {
      assert.equal(since, 3);
      return [{ sequence: 4, eventType: 'STEP_COMPLETED', data: { status: 'COMPLETED' } }];
    },
    loadRun: async () => ({ status: 'COMPLETED' }),
  });
  assert.equal(response.ended, true);
  assert.deepEqual(response.chunks, ['id: 4\nevent: STEP_COMPLETED\ndata: {"status":"COMPLETED"}\n\n']);
});

test('database errors close a stream with a safe code, never database details', async () => {
  const response = new FakeResponse();
  await streamPlanReviewEvents({
    response,
    loadEvents: async () => { throw new Error('SECRET_INTERNAL_DATABASE_URI'); },
    loadRun: async () => ({ status: 'RUNNING' }),
  });
  assert.equal(response.ended, true);
  assert.match(response.chunks.join(''), /PLAN_REVIEW_STREAM_UNAVAILABLE/);
  assert.doesNotMatch(response.chunks.join(''), /SECRET_INTERNAL_DATABASE_URI/);
});

test('missing owned run and invalid event types cannot leave a stream open', async () => {
  for (const [events, run] of [
    [[], null],
    [[{ sequence: 1, eventType: 'SUCCESS\\nevent: unexpected', data: {} }], { status: 'RUNNING' }],
  ]) {
    const response = new FakeResponse();
    await streamPlanReviewEvents({
      response, loadEvents: async () => events, loadRun: async () => run,
    });
    assert.equal(response.ended, true);
    assert.equal(response.chunks.join(''), 'event: stream_unavailable\ndata: {"code":"PLAN_REVIEW_STREAM_UNAVAILABLE"}\n\n');
  }
});

test('client disconnect during an async read prevents late SSE writes', async () => {
  const response = new FakeResponse();
  let resolveRead;
  const load = new Promise(resolve => { resolveRead = resolve; });
  const started = streamPlanReviewEvents({
    response, loadEvents: async () => load, loadRun: async () => ({ status: 'RUNNING' }),
  });
  response.emit('close');
  resolveRead([{ sequence: 1, eventType: 'STEP_COMPLETED', data: {} }]);
  await started;
  assert.deepEqual(response.chunks, []);
  assert.equal(response.ended, false);
});

test('nonterminal runs remain connected until the stream deadline', async () => {
  const response = new FakeResponse();
  let reads = 0;
  await streamPlanReviewEvents({
    response, loadEvents: async () => { reads += 1; return []; },
    loadRun: async () => ({ status: 'RUNNING' }),
    pollEveryMs: 1000, maxDurationMs: 15,
  });
  assert.equal(response.ended, false);
  assert.equal(response.chunks.join(''), ': connected\n\n');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(response.ended, true);
  assert.equal(reads, 1);
});

test('a stalled first query cannot leave an SSE response open past the deadline', async () => {
  const response = new FakeResponse();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = streamPlanReviewEvents({
    response, loadEvents: () => waiting, loadRun: async () => ({ status: 'RUNNING' }),
    pollEveryMs: 1000, maxDurationMs: 10,
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(response.ended, true);
  assert.deepEqual(response.chunks, []);
  release([{ sequence: 1, eventType: 'STEP_COMPLETED', data: {} }]);
  await pending;
  assert.deepEqual(response.chunks, [], 'Late database responses never write after closing.');
});

test('invalid event polling intervals reject before opening streams', async () => {
  for (const opts of [
    { pollEveryMs: 0 }, { pollEveryMs: -1 }, { pollEveryMs: 1.1 },
    { maxDurationMs: 0 }, { maxDurationMs: Number.NaN },
  ]) {
    const response = new FakeResponse();
    await assert.rejects(() => streamPlanReviewEvents({
      response, loadEvents: async () => [], loadRun: async () => ({ status: 'RUNNING' }), ...opts,
    }), TypeError);
    assert.equal(response.listenerCount('close'), 0);
  }
});
