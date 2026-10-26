/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { subscribeDecisionEvents, setUserInfo } from '../api';

const response = data => ({
  ok: true, status: 200,
  headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
  body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  }),
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('GenieDecision authenticated browser live update stream', () => {
  it('uses cookie-based credentials and replays owner events from cursor zero', async () => {
    const capture = [];
    const controller = new AbortController();
    const mockFetch = vi.fn().mockResolvedValue(response(
      'event: connected\ndata: {"latestSequence":1}\n\n'
      + 'id: 1\nevent: decision\ndata: {"sequence":1,"type":"SCENARIO_CREATED","scenarioId":"safe-id"}\n\n',
    ));
    vi.stubGlobal('fetch', mockFetch);
    await subscribeDecisionEvents({
      signal: controller.signal,
      onEvent: event => { capture.push(event); controller.abort(); },
    });
    expect(capture).toEqual([{
      type: 'SCENARIO_CREATED', sequence: 1, scenarioId: 'safe-id',
    }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, request] = mockFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/decisions\/events\/stream\?after=0$/);
    expect(request.credentials).toBe('include');
    expect(request.cache).toBe('no-store');
    expect(request.headers.Accept).toBe('text/event-stream');
  });

  it('ignores duplicate sequences and resets an expired cursor', async () => {
    const controller = new AbortController();
    const events = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(
      'event: connected\ndata: {"latestSequence":3}\n\n'
      + 'id: 1\nevent: decision\ndata: {"sequence":1,"type":"SCENARIO_UPDATED"}\n\n'
      + 'id: 1\nevent: decision\ndata: {"sequence":1,"type":"SCENARIO_UPDATED"}\n\n'
      + 'event: reset\ndata: {"reason":"CURSOR_EXPIRED_OR_INVALID","latestSequence":3}\n\n',
    )));
    await subscribeDecisionEvents({
      signal: controller.signal,
      onEvent: event => {
        events.push(event);
        if (event.type === 'reset') controller.abort();
      },
    });
    expect(events.map(event => event.type)).toEqual(['SCENARIO_UPDATED', 'reset']);
    expect(events[1].latestSequence).toBe(3);
  });

  it('aborts the old user stream immediately when the browser account changes', async () => {
    const controller = new AbortController();
    let serverSignal = null;
    const mockFetch = vi.fn().mockImplementation((_url, request) => new Promise((_resolve, reject) => {
      serverSignal = request.signal;
      request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true });
    }));
    vi.stubGlobal('fetch', mockFetch);
    const task = subscribeDecisionEvents({ signal: controller.signal, onEvent: () => {} });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(serverSignal.aborted).toBe(false);
    setUserInfo({ id: 'different-account' }, { broadcast: false });
    await task;
    expect(serverSignal.aborted).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    setUserInfo(null, { broadcast: false });
  });

  it('fails closed on unauthorized sessions and does not retry with cached credentials', async () => {
    const controller = new AbortController();
    const status = [];
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', mockFetch);
    await subscribeDecisionEvents({
      signal: controller.signal, onEvent: () => {},
      onStatus: state => status.push(state),
    });
    expect(status).toEqual(['unauthorized']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats explicit server-side account revocation as terminal without retrying the SSE stream', async () => {
    const controller = new AbortController();
    const status = [];
    const mockFetch = vi.fn().mockResolvedValue(response(
      'event: connected\ndata: {"latestSequence":0}\n\n'
      + 'event: unavailable\ndata: {"retry":false,"reason":"SESSION_NO_LONGER_VALID"}\n\n',
    ));
    vi.stubGlobal('fetch', mockFetch);
    await subscribeDecisionEvents({
      signal: controller.signal, onEvent: () => {},
      onStatus: state => status.push(state),
    });
    expect(status).toEqual(['connected', 'unauthorized']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

});
