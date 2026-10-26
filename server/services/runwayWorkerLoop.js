/**
 * Shared Runway projection worker scheduler.
 * Blocked jobs have already been marked terminal by the processor. Report
 * their failure without taking other households' queued work offline.
 * Never treat a blocked financial result as a successful calculation.
 */
export async function runRunwayWorkerLoop({
  processOne, shouldStop, sleep, reportBlocked,
}) {
  if (typeof processOne !== 'function' || typeof shouldStop !== 'function'
    || typeof sleep !== 'function' || typeof reportBlocked !== 'function') {
    throw new TypeError('Runway worker loop requires explicit lifecycle dependencies.');
  }
  while (!shouldStop()) {
    const outcome = await processOne();
    if (!outcome || !['IDLE', 'RETRY', 'DONE', 'BLOCKED'].includes(outcome.status)) {
      throw new Error('RUNWAY_WORKER_UNEXPECTED_OUTCOME');
    }
    if (outcome.status === 'BLOCKED') {
      // Do not print tenant identifiers, financial records, or arbitrary
      // database-provided strings into operational logs.
      const code = typeof outcome.code === 'string'
        && /^RUNWAY_[A-Z_]+$/.test(outcome.code)
        ? outcome.code : 'RUNWAY_PROJECTION_PROCESSING_FAILED';
      reportBlocked(code);
      await sleep(2000);
    } else if (outcome.status === 'IDLE') {
      await sleep(2000);
    }
  }
}
