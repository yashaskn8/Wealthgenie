import mongoose from 'mongoose';
import CoverageLedger from '../models/CoverageLedger.js';
import CoverageRiskAlert from '../models/CoverageRiskAlert.js';
import { cashReconfirmationEvent } from '../services/coverageRiskPolicy.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import logger from '../utils/logger.js';

const BATCH_LIMIT = 100;
let timer = null;
let inFlight = false;
let cursor = null;
function indiaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return [fields.year, fields.month, fields.day].join('-');
}

/**
 * Resumable bounded sweep. Workers do NOT calculate today's financial risk
 * from a yesterday opening cash balance; they only ask for reconfirmation.
 * To fence concurrent deletion/save, the same transaction must write the
 * ledger row before creating an alert. Never put raw cash data in the event.
 */
export async function sweepStaleCashDeclarations({
  now = new Date(), afterId = null, limit = BATCH_LIMIT,
  Ledger = CoverageLedger, Alert = CoverageRiskAlert,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BATCH_LIMIT) {
    throw new Error('Cash alert sweep limit must be between 1 and 100');
  }
  await verifyPersistenceIndexes({ models: [Ledger, Alert], scope: 'persistence' });
  const today = indiaToday(now);
  const query = {
    deletedAt: null, 'input.asOfDate': { $lt: today },
    ...(afterId ? { _id: { $gt: afterId } } : {}),
  };
  const candidates = await Ledger.find(query).sort({ _id: 1 }).limit(limit).lean();
  let inserted = 0;
  for (const row of candidates) {
    if (!row.input || row.deletedAt) continue;
    const event = cashReconfirmationEvent({
      userId: row.userId, revision: row.revision,
      sourceAsOfDate: row.input.asOfDate, today,
    });
    if (!event) continue;
    if (await Alert.exists({ userId: row.userId, eventKey: event.eventKey })) continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Touch the same ledger record as a competing save/delete. A worker
        // cannot commit a stale alert if a concurrent delete changes it.
        const fence = await Ledger.updateOne({
          _id: row._id, userId: row.userId, revision: row.revision,
          deletedAt: null, 'input.asOfDate': event.sourceAsOfDate,
        }, { $currentDate: { updatedAt: true } }, { session });
        if (fence.matchedCount !== 1) return;
        const old = await Alert.findOne({ userId: row.userId, eventKey: event.eventKey }).session(session).lean();
        if (!old) {
          await Alert.create([event], { session });
          inserted += 1;
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (error) {
      if (error?.code !== 11000 && error?.code !== 112
          && error?.codeName !== 'WriteConflict') throw error;
      // A concurrent worker/save won; next sweep safely reconciles.
    } finally {
      await session.endSession();
    }
  }
  return {
    scanned: candidates.length, created: inserted,
    nextAfterId: candidates.length === limit ? candidates.at(-1)._id : null,
  };
}
export function startCoverageRiskWorker({ env = process.env, intervalMs = 60_000 } = {}) {
  if (env.COVERAGE_ENABLED !== 'true' || env.COVERAGE_ALERT_WORKER_ENABLED !== 'true') {
    return { enabled: false };
  }
  if (timer) return { enabled: true, alreadyRunning: true };
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000) {
    throw new Error('Coverage worker interval must be at least 5 seconds');
  }
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const page = await sweepStaleCashDeclarations({ afterId: cursor });
      cursor = page.nextAfterId;
      // Do not log user identifiers or financial details.
    } catch (error) {
      logger.warn('Cash risk sweep failed', { code: error.code || 'CASH_RISK_SWEEP_FAILED' });
    } finally { inFlight = false; }
  };
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return { enabled: true };
}
export function stopCoverageRiskWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  cursor = null;
  // A running tick owns its DB session and must drain with shutdown.
}
