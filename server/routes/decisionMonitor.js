import mongoose from 'mongoose';
import { Router } from 'express';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import { verifyDecisionRevision } from './decisionScenarios.js';
import { assessmentDto } from '../services/genieDecision/monitor.js';
import { appendDecisionEvent } from '../services/genieDecision/liveEvents.js';
import DecisionMonitor from '../models/DecisionMonitor.js';
import DecisionAssessment from '../models/DecisionAssessment.js';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionEvent from '../models/DecisionEvent.js';
import DecisionEventState from '../models/DecisionEventState.js';

const fail = (status, code, message) => { throw createError(status, message, message, { code }); };
const handle = fn => asyncHandler(async (req, res) => {
  try { await fn(req, res); } catch (error) {
    if (error?.code === 'DECISION_ASSESSMENT_INTEGRITY_FAILURE') {
      return sendError(req, res, 503, 'Saved reassessment integrity could not be verified.', error.code);
    }
    if (error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) {
      return sendError(req, res, 409, 'Concurrent monitoring change. Refresh and retry.', 'DECISION_MONITOR_CONFLICT');
    }
    throw error;
  }
});

async function ownedScenario(req, session = null) {
  if (!isValidObjectId(req.params.id)) fail(400, 'INVALID_DECISION_ID', 'Invalid scenario identifier.');
  const q = DecisionScenario.findOne({ _id: req.params.id, userId: req.user.userId });
  if (session) q.session(session);
  const row = await q.lean();
  if (!row) fail(404, 'DECISION_NOT_FOUND', 'Decision scenario not found.');
  const revision = DecisionScenarioRevision.findOne({
    userId: req.user.userId, scenarioId: row._id, revision: row.revision,
  });
  if (session) revision.session(session);
  verifyDecisionRevision(await revision.lean(), row);
  return row;
}

const projection = monitor => monitor
  ? { enabled: monitor.enabled, generation: monitor.generation, lastCheckedAt: monitor.lastCheckedAt }
  : { enabled: false, generation: 0, lastCheckedAt: null };

export function createDecisionMonitorRoutes({ resolveProfile = resolveCurrentFinancialProfile } = {}) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    next();
  }, verifyJWT);

  router.get('/scenarios/:id/monitor', handle(async (req, res) => {
    const scenario = await ownedScenario(req);
    const monitor = await DecisionMonitor.findOne({
      userId: req.user.userId, scenarioId: scenario._id,
    }).lean();
    const assessments = await DecisionAssessment.find({
      userId: req.user.userId, scenarioId: scenario._id,
    }).sort({ createdAt: -1, _id: -1 }).limit(15).lean();
    const current = await resolveProfile({
      userId: req.user.userId, requireRecommendation: false,
    });
    res.json({
      monitor: { ...projection(monitor), workerConfigured: process.env.GENIEDECISION_MONITOR_ENABLED === 'true' },
      assessments: assessments.map(item => assessmentDto(item, current, scenario, monitor)),
    });
  }));

  router.put('/scenarios/:id/monitor', handle(async (req, res) => {
    if (!req.body || Array.isArray(req.body)
      || Object.keys(req.body).sort().join(',') !== 'enabled,expectedRevision'
      || typeof req.body.enabled !== 'boolean'
      || !Number.isSafeInteger(req.body.expectedRevision) || req.body.expectedRevision < 1) {
      fail(400, 'INVALID_MONITOR_INPUT', 'Expected an explicit enabled boolean and scenario revision.');
    }
    if (req.body.enabled && process.env.GENIEDECISION_MONITOR_ENABLED !== 'true') {
      fail(503, 'DECISION_MONITOR_DISABLED', 'Automatic decision monitoring is not enabled on this deployment.');
    }
    await verifyPersistenceIndexes({
      models: [DecisionMonitor, DecisionAssessment, DecisionEvent, DecisionEventState],
      scope: 'persistence',
    });
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const scenario = await ownedScenario(req, session);
        if (scenario.revision !== req.body.expectedRevision) {
          fail(409, 'DECISION_REVISION_CONFLICT', 'Reload the scenario before changing monitoring.');
        }
        const existing = await DecisionMonitor.findOne({
          userId: req.user.userId, scenarioId: scenario._id,
        }).session(session).lean();
        if ((existing?.enabled ?? false) === req.body.enabled) {
          result = existing || projection(null);
          return;
        }
        result = await DecisionMonitor.findOneAndUpdate({
          userId: req.user.userId, scenarioId: scenario._id,
        }, {
          $set: { enabled: req.body.enabled, lastCheckedAt: null },
          $inc: { generation: 1 },
          $setOnInsert: { userId: req.user.userId, scenarioId: scenario._id },
        }, { session, new: true, upsert: true, setDefaultsOnInsert: false }).lean();
        await appendDecisionEvent(session, {
          userId: req.user.userId, scenarioId: scenario._id,
          revision: scenario.revision, type: 'MONITOR_UPDATED',
        });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    res.json({ monitor: { ...projection(result), workerConfigured: process.env.GENIEDECISION_MONITOR_ENABLED === 'true' } });
  }));

  return router;
}

export default createDecisionMonitorRoutes();
