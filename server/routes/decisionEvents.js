import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import {
  fetchDecisionEvents, parseEventCursor, sourceStateFingerprint,
  LIVE_POLL_MS, LIVE_STREAM_LIMIT_MS,
} from '../services/genieDecision/liveEvents.js';

// Bound long-lived connections per replica: no unbounded request-per-user fanout.
const liveClients = new Map();
let connectedClients = 0;
const sleep = (milliseconds, signal) => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(done, milliseconds);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

const eventFrame = (name, data, sequence = null) =>
  `${sequence === null ? '' : `id: ${sequence}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function noStore(_req, res, next) {
  res.set({
    'Cache-Control': 'no-store, no-transform',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
}
function invalidCursor(err) {
  return err?.code === 'INVALID_DECISION_EVENT_CURSOR';
}

export function createDecisionEventsRouter({ resolveProfile = resolveCurrentFinancialProfile } = {}) {
  const router = Router();
  router.use(noStore, verifyJWT);

  router.get('/events', asyncHandler(async (req, res) => {
    let after;
    try { after = parseEventCursor(req.query.after); } catch (err) {
      if (invalidCursor(err)) return sendError(req, res, 400, err.message, err.code);
      throw err;
    }
    if (Array.isArray(req.query.after) || Object.keys(req.query).some(key => key !== 'after')) {
      return sendError(req, res, 400, 'Invalid decision event query.', 'INVALID_DECISION_EVENT_QUERY');
    }
    const result = await fetchDecisionEvents({ userId: req.user.userId, after });
    return res.json(result);
  }));

  router.get('/events/stream', asyncHandler(async (req, res) => {
    if (!String(req.headers.accept || '').includes('text/event-stream')
        || req.headers['sec-fetch-site'] === 'cross-site') {
      return sendError(req, res, 406, 'Same-origin SSE request required.', 'DECISION_STREAM_UNSUPPORTED');
    }
    if (Array.isArray(req.query.after) || Object.keys(req.query).some(key => key !== 'after')) {
      return sendError(req, res, 400, 'Invalid event cursor.', 'INVALID_DECISION_EVENT_CURSOR');
    }
    let after;
    try { after = parseEventCursor(req.query.after); } catch (err) {
      if (invalidCursor(err)) return sendError(req, res, 400, err.message, err.code);
      throw err;
    }
    const userId = String(req.user.userId);
    const count = liveClients.get(userId) || 0;
    if (count >= 2 || connectedClients >= 200) {
      return sendError(req, res, 429, 'Live update connection capacity reached.', 'DECISION_STREAM_CAPACITY');
    }
    // All database reads and authentication have completed before emitting
    // headers. A disconnected database is never reported as a successful feed.
    let page = await fetchDecisionEvents({ userId: req.user.userId, after });
    const initial = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
    let stamp = sourceStateFingerprint(initial);
    const aborter = new AbortController();
    liveClients.set(userId, count + 1);
    connectedClients += 1;
    let closed = false;
    function release() {
      if (closed) return;
      closed = true;
      aborter.abort();
      connectedClients -= 1;
      const remaining = (liveClients.get(userId) || 1) - 1;
      if (remaining <= 0) liveClients.delete(userId);
      else liveClients.set(userId, remaining);
    }
    req.once('close', release);
    res.once('close', release);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event, data, sequence = null) => {
      if (closed || !res.write(eventFrame(event, data, sequence))) {
        // A stalled network must not retain unbounded buffered financial events.
        release();
        return false;
      }
      res.flush?.();
      return true;
    };
    let cursor = after ?? page.latestSequence;
    const initialCursor = cursor;
    if (!send('connected', { latestSequence: page.latestSequence,
      profileCurrentness: initial?.state?.resolutionStatus || 'UNAVAILABLE',
      updateMode: 'OWNER_SCOPED_DURABLE_EVENTS', pollMilliseconds: LIVE_POLL_MS })) {
      res.end(); return;
    }

    const deadline = Date.now() + LIVE_STREAM_LIMIT_MS;
    let nextProfileCheck = Date.now() + 10000;
    try {
      while (!closed && Date.now() < deadline) {
        if (page.resetRequired) {
          cursor = page.latestSequence;
          if (!send('reset', { reason: 'CURSOR_EXPIRED_OR_INVALID', latestSequence: cursor })) break;
        } else {
          for (const event of page.events) {
            if (event.sequence <= cursor) continue;
            cursor = event.sequence;
            if (!send('decision', event, event.sequence)) break;
          }
        }
        if (closed) break;
        if (Date.now() >= nextProfileCheck) {
          const current = await resolveProfile({ userId: req.user.userId, requireRecommendation: false });
          const next = sourceStateFingerprint(current);
          if (next !== stamp) {
            stamp = next;
            if (!send('profile-changed', { requiresRefresh: true })) break;
          }
          nextProfileCheck = Date.now() + 10000;
        }
        if (!send('heartbeat', { cursor, epoch: Math.floor(Date.now() / 1000) })) break;
        await sleep(LIVE_POLL_MS, aborter.signal);
        if (closed) break;
        page = await fetchDecisionEvents({ userId: req.user.userId, after: cursor });
      }
    } catch {
      // Do not leak backend exception details in a long-lived stream.
      send('unavailable', { retry: true });
    } finally {
      release();
      res.end();
    }
    void initialCursor;
  }));

  return router;
}
export default createDecisionEventsRouter();
