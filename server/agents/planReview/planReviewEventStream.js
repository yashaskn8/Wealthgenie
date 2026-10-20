// Owner scoping is enforced by the caller's authenticated, bound queries.
// Keep event polling serialized so delayed reads cannot replay or reorder events.
const TERMINAL_STATUSES = new Set([
  'COMPLETED', 'WAITING_FOR_APPROVAL', 'FAILED', 'CANCELLED',
  'SUPERSEDED', 'BUDGET_EXCEEDED', 'FEATURE_UNAVAILABLE',
]);
const SAFE_EVENT_TYPE = /^[A-Z][A-Z0-9_]{0,79}$/;
const UNAVAILABLE_EVENT = 'event: stream_unavailable\ndata: {"code":"PLAN_REVIEW_STREAM_UNAVAILABLE"}\n\n';

/**
 * Deliver bounded Plan Review events until a terminal state, disconnect,
 * transport/database failure, or the maximum stream duration.
 * Never include internal error messages in an SSE response.
 */
export async function streamPlanReviewEvents({
  response, initialSequence = 0, loadEvents, loadRun,
  pollEveryMs = 1000, maxDurationMs = 30000,
}) {
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0
      || typeof loadEvents !== 'function' || typeof loadRun !== 'function'
      || !Number.isSafeInteger(pollEveryMs) || pollEveryMs < 100
      || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) {
    throw new TypeError('Invalid Plan Review stream setup.');
  }
  let sequence = initialSequence;
  let closed = false;
  let inFlight = false;
  let interval;
  let deadline;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (deadline) clearTimeout(deadline);
    response.off('close', cleanup);
  };
  const end = () => {
    if (closed) return;
    cleanup();
    response.end();
  };

  // An HTTP request can finish while its event-stream response remains open.
  // The lifecycle must follow the response, not the request's 'close' event.
  response.once('close', cleanup);

  const send = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const events = await loadEvents(sequence);
      if (closed) return;
      if (!Array.isArray(events) || events.length > 100) throw new Error('Invalid event batch.');
      for (const event of events) {
        if (closed) return;
        if (!Number.isSafeInteger(event?.sequence) || event.sequence <= sequence
            || !SAFE_EVENT_TYPE.test(event?.eventType)) {
          throw new Error('Invalid persisted Plan Review event.');
        }
        const payload = JSON.stringify(event.data ?? {});
        response.write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${payload}\n\n`);
        sequence = event.sequence;
      }
      const currentRun = await loadRun();
      if (closed) return;
      if (!currentRun) throw new Error('Bound Plan Review run is unavailable.');
      if (TERMINAL_STATUSES.has(currentRun.status)) end();
    } catch {
      if (!closed) {
        try { response.write(UNAVAILABLE_EVENT); } catch { /* Connection closed. */ }
        end();
      }
    } finally {
      inFlight = false;
    }
  };

  // Begin stream lifetime before the first (possibly stalled) DB query.
  deadline = setTimeout(end, maxDurationMs);
  deadline.unref?.();
  await send();
  if (closed) return;
  try { response.write(': connected\n\n'); } catch { end(); return; }
  interval = setInterval(() => { void send(); }, pollEveryMs);
  interval.unref?.();
}
